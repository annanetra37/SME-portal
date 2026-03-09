import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import pool from './db/pool.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

dotenv.config();

// ─── DB connection diagnostic ──────────────────────────────────────────────────
console.log('🔌 DB mode:', process.env.DATABASE_URL ? `Railway (${process.env.DATABASE_URL.split('@')[1]})` : 'Local (localhost)');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── Serve frontend static files ──────────────────────────────────────────────
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Auto-migrate DB on startup ───────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS countries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL, code TEXT, flag TEXT DEFAULT '🌍',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS smes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
      name TEXT NOT NULL, industry TEXT, product_type TEXT, description TEXT,
      location TEXT, founded_year INT, employee_count TEXT, monthly_revenue TEXT,
      social_media JSONB DEFAULT '{}', contact_email TEXT, owner_name TEXT,
      followers JSONB DEFAULT '{}', products JSONB DEFAULT '[]', price_range TEXT,
      tags JSONB DEFAULT '[]', no_website_reason TEXT, opportunity_score INT DEFAULT 75,
      languages JSONB DEFAULT '[]', status TEXT DEFAULT 'discovered', deployed_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS websites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sme_id UUID NOT NULL REFERENCES smes(id) ON DELETE CASCADE,
      html TEXT NOT NULL, deployed_url TEXT, slug TEXT,
      built_at TIMESTAMPTZ DEFAULT NOW(), deployed_at TIMESTAMPTZ,
      CONSTRAINT websites_sme_id_key UNIQUE (sme_id)
    );
    CREATE TABLE IF NOT EXISTS emails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sme_id UUID NOT NULL REFERENCES smes(id) ON DELETE CASCADE,
      subject TEXT NOT NULL, body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT emails_sme_id_key UNIQUE (sme_id)
    );
    CREATE TABLE IF NOT EXISTS sme_images (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      sme_id TEXT NOT NULL,
      data TEXT NOT NULL,
      platform TEXT, source_url TEXT, caption TEXT,
      scraped_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_smes_country  ON smes(country_id);
    CREATE INDEX IF NOT EXISTS idx_websites_sme  ON websites(sme_id);
    CREATE INDEX IF NOT EXISTS idx_emails_sme    ON emails(sme_id);
    CREATE INDEX IF NOT EXISTS idx_sme_images_sme ON sme_images(sme_id);
    CREATE TABLE IF NOT EXISTS ai_costs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sme_id        TEXT,
      sme_name      TEXT,
      country_id    TEXT,
      country_name  TEXT,
      activity      TEXT NOT NULL,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      haiku_input   INTEGER DEFAULT 0,
      haiku_output  INTEGER DEFAULT 0,
      web_searches  INTEGER DEFAULT 0,
      total_cost    DECIMAL(12,8) DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_costs_sme      ON ai_costs(sme_id);
    CREATE INDEX IF NOT EXISTS idx_ai_costs_activity ON ai_costs(activity);
    CREATE INDEX IF NOT EXISTS idx_ai_costs_created  ON ai_costs(created_at);
  `);
  // Safe column additions / constraint drops
  for (const sql of [
    `ALTER TABLE smes ADD COLUMN IF NOT EXISTS is_illustrative BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE websites ADD COLUMN IF NOT EXISTS social_content JSONB DEFAULT '{}'`,
    `ALTER TABLE smes ALTER COLUMN contact_email DROP NOT NULL`,
    // Drop FK on sme_images.sme_id — UUID vs TEXT mismatch breaks fresh deployments
    `ALTER TABLE sme_images DROP CONSTRAINT IF EXISTS sme_images_sme_id_fkey`,
  ]) {
    try { await pool.query(sql); } catch (_) {}
  }
  console.log('✅ DB schema ready');
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Map();
function sse(cid, event, data) {
  const res = sseClients.get(String(cid));
  if (!res) return;
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}
function log(cid, msg, type = 'info') {
  const icons = { phase: '\n🔷', ok: '  ✅', skip: '  ❌', warn: '  ⚠️', sme: '  🏪' };
  console.log(`${icons[type] || '  '} ${msg}`);
  sse(cid, 'log', { msg, type, ts: Date.now() });
}

// ─── SME-level SSE (for website build + image scrape streaming) ───────────────
const smeSseClients = new Map();

// ─── Active scrape jobs (for stop/cancel support) ─────────────────────────────
// smeId -> { killed: bool, killProc: fn | null }
const activeScrapes = new Map();
function smeSse(smeId, event, data) {
  const res = smeSseClients.get(String(smeId));
  if (!res) return;
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}
function smeLog(smeId, msg, type = 'info') {
  console.log(`  [build:${String(smeId).slice(0, 8)}] ${msg}`);
  smeSse(smeId, 'log', { msg, type, ts: Date.now() });
}

app.get('/api/countries/:id/search-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { clearInterval(hb); } }, 20000);
  sseClients.set(String(req.params.id), res);
  req.on('close', () => { clearInterval(hb); sseClients.delete(String(req.params.id)); });
});

// SSE stream for SME-level operations (website build, image scrape)
app.get('/api/smes/:id/build-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { clearInterval(hb); } }, 20000);
  smeSseClients.set(String(req.params.id), res);
  req.on('close', () => { clearInterval(hb); smeSseClients.delete(String(req.params.id)); });
});

// ─── Cost tracking ────────────────────────────────────────────────────────────
const PRICING = {
  inputPerMTok:        3.00,   // Sonnet 4.6 input  — $3.00 / MTok
  outputPerMTok:       15.00,  // Sonnet 4.6 output — $15.00 / MTok
  haikuInputPerMTok:   0.80,   // Haiku 4.5 input   — $0.80 / MTok  (3.75× cheaper)
  haikuOutputPerMTok:  4.00,   // Haiku 4.5 output  — $4.00 / MTok  (3.75× cheaper)
  searchPer1k:         10.00,  // Web search        — $10.00 / 1 000 searches
};

function newCost() {
  return { inputTokens: 0, outputTokens: 0, haikuInput: 0, haikuOutput: 0, searches: 0 };
}

function costSummary(ct) {
  const inCost   = (ct.inputTokens          / 1e6) * PRICING.inputPerMTok;
  const outCost  = (ct.outputTokens         / 1e6) * PRICING.outputPerMTok;
  const hIn      = ((ct.haikuInput  || 0)   / 1e6) * PRICING.haikuInputPerMTok;
  const hOut     = ((ct.haikuOutput || 0)   / 1e6) * PRICING.haikuOutputPerMTok;
  const srchCost = (ct.searches              / 1e3) * PRICING.searchPer1k;
  const total    = inCost + outCost + hIn + hOut + srchCost;
  return {
    inputTokens:     ct.inputTokens,
    outputTokens:    ct.outputTokens,
    haikuInput:      ct.haikuInput  || 0,
    haikuOutput:     ct.haikuOutput || 0,
    searches:        ct.searches,
    inputCost:       +inCost.toFixed(6),
    outputCost:      +outCost.toFixed(6),
    haikuInputCost:  +hIn.toFixed(6),
    haikuOutputCost: +hOut.toFixed(6),
    searchCost:      +srchCost.toFixed(6),
    total:           +total.toFixed(6),
    display:         total < 0.0001 ? `< $0.0001` : `$${total.toFixed(4)}`,
  };
}

// ─── AI helpers ──────────────────────────────────────────────────────────────
/** Sonnet 4.6 — creative generation (HTML, email, social content) */
async function claude(system, user, maxTokens = 3000, ct = null) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: maxTokens,
    system, messages: [{ role: 'user', content: user }],
  });
  if (ct && r.usage) {
    ct.inputTokens  += r.usage.input_tokens  || 0;
    ct.outputTokens += r.usage.output_tokens || 0;
  }
  return r.content[0].text;
}

/** Haiku 4.5 — structured extraction / parsing (3.75× cheaper than Sonnet) */
async function claudeHaiku(system, user, maxTokens = 2000, ct = null) {
  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens,
    system, messages: [{ role: 'user', content: user }],
  });
  if (ct && r.usage) {
    ct.haikuInput  = (ct.haikuInput  || 0) + (r.usage.input_tokens  || 0);
    ct.haikuOutput = (ct.haikuOutput || 0) + (r.usage.output_tokens || 0);
  }
  return r.content[0].text;
}

/** Web search via Sonnet — produces detailed results with specific business names and URLs */
async function webSearch(query, ct = null) {
  if (ct) ct.searches += 1;
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: query }],
  });
  if (ct && r.usage) {
    ct.inputTokens  = (ct.inputTokens  || 0) + (r.usage.input_tokens  || 0);
    ct.outputTokens = (ct.outputTokens || 0) + (r.usage.output_tokens || 0);
  }
  if (r.stop_reason === 'tool_use') {
    const toolResults = r.content.filter(b => b.type === 'tool_use')
      .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'results retrieved' }));
    const r2 = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 6000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        { role: 'user', content: query },
        { role: 'assistant', content: r.content },
        { role: 'user', content: toolResults },
      ],
    });
    if (ct && r2.usage) {
      ct.inputTokens  = (ct.inputTokens  || 0) + (r2.usage.input_tokens  || 0);
      ct.outputTokens = (ct.outputTokens || 0) + (r2.usage.output_tokens || 0);
    }
    return r2.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/** Persist a cost summary to the ai_costs table. Returns the costSummary object. */
async function saveCost(ct, activity, opts = {}) {
  const { smeId = null, smeName = null, countryId = null, countryName = null } = opts;
  const s = costSummary(ct);
  try {
    await pool.query(
      `INSERT INTO ai_costs
         (sme_id, sme_name, country_id, country_name, activity,
          input_tokens, output_tokens, haiku_input, haiku_output, web_searches, total_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [smeId, smeName, countryId, countryName, activity,
       s.inputTokens, s.outputTokens, s.haikuInput, s.haikuOutput, s.searches, s.total]
    );
  } catch (e) { console.error('saveCost failed:', e.message); }
  return s;
}

function normalizeSme(row) {
  const p = v => { if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };
  return {
    id: row.id, countryId: row.country_id, name: row.name, industry: row.industry,
    productType: row.product_type, description: row.description, location: row.location,
    foundedYear: row.founded_year, employeeCount: row.employee_count,
    monthlyRevenue: row.monthly_revenue, socialMedia: p(row.social_media) || {},
    contactEmail: row.contact_email, ownerName: row.owner_name,
    followers: p(row.followers) || {}, products: p(row.products) || [],
    priceRange: row.price_range, tags: p(row.tags) || [],
    noWebsiteReason: row.no_website_reason, opportunityScore: row.opportunity_score,
    languages: p(row.languages) || [], status: row.status,
    isIllustrative: row.is_illustrative || false, createdAt: row.created_at,
  };
}

async function insertSme(countryId, s) {
  const { rows } = await pool.query(
    `INSERT INTO smes (country_id,name,industry,product_type,description,location,
      founded_year,employee_count,monthly_revenue,social_media,contact_email,owner_name,
      followers,products,price_range,tags,no_website_reason,opportunity_score,
      languages,is_illustrative,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'discovered')
     RETURNING *`,
    [countryId, s.name, s.industry || 'General', s.productType || '', s.description || '',
     s.location || '', s.foundedYear || null, s.employeeCount || '1-5', s.monthlyRevenue || 'Unknown',
     JSON.stringify(s.socialMedia || {}), s.contactEmail || null, s.ownerName || '',
     JSON.stringify(s.followers || {}), JSON.stringify(s.products || []), s.priceRange || '',
     JSON.stringify(s.tags || []), s.noWebsiteReason || '', s.opportunityScore || 75,
     JSON.stringify(s.languages || []), s.isIllustrative || false]
  );
  return normalizeSme(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

async function runSearchPipeline(countryId, countryName, filters = {}) {
  const TARGET = 15;
  const PARALLEL = 5;
  const TIMEOUT = 4 * 60 * 1000;
  const start = Date.now();
  const inserted = [];
  const ct = newCost();

  const { industries = [], minFollowers = null, maxFollowers = null } = filters;
  const hasIndustryFilter = industries.length > 0;
  const hasFollowerFilter = minFollowers != null || maxFollowers != null;

  // ── FIX #2: Load existing names from DB to avoid duplicates ──────────────
  const { rows: existing } = await pool.query(
    'SELECT LOWER(name) as name FROM smes WHERE country_id = $1', [countryId]
  );
  const existingNames = new Set(existing.map(r => r.name));
  log(countryId, `Found ${existingNames.size} existing businesses in DB — will skip duplicates`, 'info');

  if (hasIndustryFilter) log(countryId, `Industry filter: ${industries.join(', ')}`, 'info');
  if (hasFollowerFilter) log(countryId, `Follower range: ${minFollowers ?? '0'}–${maxFollowers ?? '∞'}`, 'info');

  // ── Phase 1: Parallel discovery ──────────────────────────────────────────
  log(countryId, `PHASE 1 — Parallel discovery for "${countryName}"`, 'phase');

  // When an industry filter is active, add those terms as query bias (not hard requirements).
  // The broad query structure is kept so results still come back for smaller markets.
  const industryTermsMap = {
    'Food & Beverage':    'food bakery restaurant homemade meals snacks',
    'Fashion & Clothing': 'fashion clothing boutique apparel tailor',
    'Beauty & Cosmetics': 'beauty cosmetics skincare makeup hair salon',
    'Crafts & Handmade':  'handmade crafts artisan pottery knitting',
    'Jewelry':            'jewelry jewellery accessories rings necklace',
    'Home Goods':         'home goods furniture decor interior household',
    'Agriculture':        'agriculture farm organic produce vegetables',
    'Education':          'tutoring training courses education skills',
    'Services':           'services repair cleaning delivery laundry',
    'Other':              '',
  };
  const industryClause = hasIndustryFilter
    ? ' ' + industries.map(ind => industryTermsMap[ind] || ind.toLowerCase()).join(' ')
    : '';

  // Original proven queries — the "no website" / "order via DM" framing is what surfaces
  // social-media-only SMEs. Industry clause adds bias terms when filter is active.
  const queries = [
    `site:facebook.com "${countryName}"${industryClause} small business shop page handmade`,
    `site:instagram.com "${countryName}"${industryClause} small business shop seller local`,
    `"${countryName}"${industryClause} handmade food shop "facebook.com" OR "instagram.com" no website`,
    `"${countryName}"${industryClause} small business "no website" OR "order via DM" instagram facebook`,
    `"${countryName}"${industryClause} homemade artisan crafts clothing beauty jewelry local seller social media`,
    `"${countryName}"${industryClause} local food producer baker fashion boutique facebook instagram profile`,
  ];
  log(countryId, `Running ${queries.length} search queries in parallel...`);

  const results = await Promise.allSettled(queries.map(q => webSearch(q, ct)));
  const combinedText = results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .join('\n\n===\n\n')
    .slice(0, 28000);

  log(countryId, 'Extracting candidate businesses from search results...');
  // Use Sonnet here — Haiku fails to extract from sparse results for smaller markets
  const extractRaw = await claude(
    'Return ONLY valid JSON arrays, no markdown.',
    `From these web search results about ${countryName}, extract every distinct micro or small business name you can find.

RESULTS:
${combinedText}

Rules:
- Extract ANY small business name mentioned — a name alone is enough, social URLs are a bonus
- If you see facebook.com/PageName or instagram.com/handle patterns, capture the FULL URL
- Skip large chains (50+ staff), government orgs, NGOs, news outlets
- Do NOT invent names or URLs; only use what is literally in the text

Return JSON (max 40):
[{"name":"name as found","fbUrl":"full fb url or null","igUrl":"full ig url or null","industryHint":"food/crafts/fashion/beauty/etc","confidence":"high/medium/low"}]
If nothing, return [].`,
    4000, ct
  );

  let candidates = [];
  try { candidates = JSON.parse(extractRaw.replace(/```json\n?|\n?```/g, '').trim()); } catch {}
  if (!Array.isArray(candidates)) candidates = [];

  log(countryId, `Found ${candidates.length} candidates`, candidates.length > 0 ? 'ok' : 'warn');

  // ── Industry post-filter: reliable keyword match on industryHint ──────────
  if (hasIndustryFilter && candidates.length > 0) {
    const industryKeywords = {
      'Food & Beverage':    ['food', 'beverage', 'bakery', 'restaurant', 'cater', 'snack', 'meal', 'drink', 'coffee', 'cook'],
      'Fashion & Clothing': ['fashion', 'cloth', 'apparel', 'boutique', 'tailor', 'dress', 'wear', 'textile'],
      'Beauty & Cosmetics': ['beauty', 'cosmetic', 'skincare', 'makeup', 'hair', 'salon', 'spa', 'nail', 'skin'],
      'Crafts & Handmade':  ['craft', 'handmade', 'artisan', 'diy', 'custom', 'pottery', 'knit', 'sew'],
      'Jewelry':            ['jewelry', 'jewellery', 'accessori', 'ring', 'necklace', 'gem', 'bead', 'bracelet'],
      'Home Goods':         ['home', 'furniture', 'decor', 'interior', 'household', 'kitchenware', 'candle'],
      'Agriculture':        ['agricultur', 'farm', 'organic', 'produce', 'vegetable', 'fruit', 'crop'],
      'Education':          ['educat', 'tutor', 'training', 'course', 'school', 'learn', 'teach'],
      'Services':           ['service', 'repair', 'clean', 'delivery', 'laundry', 'fix', 'plumb'],
      'Other':              [],
    };
    const activeKeywords = industries.flatMap(ind => industryKeywords[ind] || [ind.toLowerCase()]);
    const before = candidates.length;
    candidates = candidates.filter(c => {
      if (!c.industryHint) return true; // keep unclassified — let verifyAndEnrich classify
      const hint = c.industryHint.toLowerCase();
      return activeKeywords.some(kw => hint.includes(kw));
    });
    if (before > candidates.length)
      log(countryId, `Industry filter: removed ${before - candidates.length} off-industry candidates (kept ${candidates.length})`, 'info');
  }

  // Fallback broader search
  if (candidates.length < 5) {
    log(countryId, 'Too few candidates — running broader fallback search...', 'warn');
    const fbResults = await Promise.allSettled([
      webSearch(`${countryName} small business instagram facebook shop`, ct),
      webSearch(`${countryName} local entrepreneur artisan seller online`, ct),
      webSearch(`${countryName} homemade products local market small business`, ct),
      webSearch(`site:facebook.com "${countryName}" shop`, ct),
      webSearch(`site:instagram.com "${countryName}" handmade seller`, ct),
    ]);
    const fbText = fbResults.map(r => r.status === 'fulfilled' ? r.value : '').join('\n===\n').slice(0, 18000);
    const fbRaw = await claude('Return ONLY valid JSON arrays.',
      `Extract ANY small or micro business names from ${countryName} found in these search results. A name alone is enough — include it even if no social URL is visible; Phase 2 will find those.
${fbText}
Return: [{"name":"name","fbUrl":null,"igUrl":null,"industryHint":"guess","confidence":"low"}]
If nothing, return [].`, 2000, ct);
    try {
      const extra = JSON.parse(fbRaw.replace(/```json\n?|\n?```/g, '').trim());
      if (Array.isArray(extra)) candidates = [...candidates, ...extra];
    } catch {}
    log(countryId, `After fallback: ${candidates.length} total candidates`);
  }

  // Deduplicate candidates against each other AND existing DB entries
  const seenInBatch = new Set();
  const uniqueCandidates = candidates.filter(c => {
    if (!c?.name || c.name.length < 2) return false;
    const key = c.name.toLowerCase().trim();
    if (existingNames.has(key) || seenInBatch.has(key)) return false;
    seenInBatch.add(key);
    return true;
  });

  log(countryId, `${uniqueCandidates.length} unique new candidates to verify (${candidates.length - uniqueCandidates.length} duplicates skipped)`);

  // ── Phase 2: Parallel verify+enrich in batches ────────────────────────────
  log(countryId, `PHASE 2 — Verifying ${uniqueCandidates.length} candidates (${PARALLEL} at a time)`, 'phase');

  for (let i = 0; i < uniqueCandidates.length; i += PARALLEL) {
    if (Date.now() - start > TIMEOUT) {
      log(countryId, 'Reached 4-minute time limit — wrapping up with results so far', 'warn');
      break;
    }
    if (inserted.length >= TARGET) {
      log(countryId, `Reached target of ${TARGET} — stopping`, 'ok');
      break;
    }

    const batch = uniqueCandidates.slice(i, i + PARALLEL);
    log(countryId, `  Batch ${Math.floor(i / PARALLEL) + 1}: verifying ${batch.map(c => '"' + c.name + '"').join(', ')}...`);

    const batchResults = await Promise.allSettled(
      batch.map(c => verifyAndEnrich(c, countryName, ct))
    );

    for (const result of batchResults) {
      if (result.status === 'rejected') {
        log(countryId, `  Error: ${result.reason?.message || 'unknown'}`, 'warn');
        continue;
      }
      const { profile, skipped, reason } = result.value;
      if (skipped) {
        log(countryId, `  SKIP: ${reason}`, 'skip');
        continue;
      }

      // Follower filter — 0 means count not found in search text (unknown), not confirmed zero.
      // Only reject if we have an actual confirmed non-zero count outside the range.
      if (hasFollowerFilter) {
        const totalFollowers = (profile.followers?.facebook || 0) + (profile.followers?.instagram || 0);
        if (totalFollowers === 0) {
          log(countryId, `  "${profile.name}" — follower count unknown, keeping`, 'info');
        } else {
          if (minFollowers != null && totalFollowers < minFollowers) {
            log(countryId, `  SKIP "${profile.name}" — ${totalFollowers.toLocaleString()} followers < min ${minFollowers.toLocaleString()}`, 'skip');
            continue;
          }
          if (maxFollowers != null && totalFollowers > maxFollowers) {
            log(countryId, `  SKIP "${profile.name}" — ${totalFollowers.toLocaleString()} followers > max ${maxFollowers.toLocaleString()}`, 'skip');
            continue;
          }
        }
      }

      // Double-check deduplication at insert time
      const nameKey = profile.name.toLowerCase().trim();
      if (existingNames.has(nameKey)) {
        log(countryId, `  SKIP "${profile.name}" — already in DB`, 'skip');
        continue;
      }
      existingNames.add(nameKey);

      log(countryId, `  ✓ VERIFIED "${profile.name}" (${profile.industry})`, 'ok');
      try {
        const saved = await insertSme(countryId, profile);
        inserted.push(saved);
        sse(countryId, 'sme', saved);
        log(countryId, `  "${profile.name}" is live in your dashboard!`, 'sme');
      } catch (e) {
        log(countryId, `  DB error for "${profile.name}": ${e.message}`, 'warn');
      }
    }
  }

  if (inserted.length === 0) {
    if (hasIndustryFilter || hasFollowerFilter) {
      log(countryId, 'No businesses found matching your filters — try broader criteria or remove filters', 'warn');
    } else {
      log(countryId, 'No verified businesses found — search returned no confirmed social media SMEs', 'warn');
    }
  }

  const verified = inserted.length;
  const elapsed = Math.round((Date.now() - start) / 1000);

  const cost = await saveCost(ct, 'sme_discovery', { countryId, countryName });
  log(countryId, `━━━ COMPLETE in ${elapsed}s ━━━`, 'phase');
  if (verified > 0) log(countryId, `${verified} verified real businesses added`, 'ok');
  log(countryId, `💰 AI cost: ${cost.display}  (Sonnet: ${cost.inputTokens.toLocaleString()}/${cost.outputTokens.toLocaleString()} tok · ${cost.searches} searches)`, 'cost');

  sse(countryId, 'done', { total: inserted.length, verified, illustrative: 0, elapsedSeconds: elapsed, cost });
  return inserted;
}

async function verifyAndEnrich(candidate, countryName, ct = null) {
  const { name, fbUrl, igUrl, industryHint, confidence } = candidate;
  let searchText = '';

  if (!fbUrl && !igUrl || confidence !== 'high') {
    searchText = await webSearch(
      `"${name}" ${countryName} facebook instagram -site:yellowpages -site:yelp -site:tripadvisor`,
      ct
    ).catch(() => '');
  }

  const raw = await claude(
    'Business verifier. Return ONLY valid JSON. Never fabricate URLs.',
    `Verify and profile this potential social-media-only SME.

Name: "${name}" in ${countryName}
Industry hint: ${industryHint || 'unknown'}
Discovered URLs: facebook="${fbUrl || 'none'}" instagram="${igUrl || 'none'}"
Search results: ${searchText.slice(0, 4000) || '(using discovery URLs)'}

Rules:
1. If it has its own website (not fb/ig) → rejected=true, rejectionReason="has website"
2. If no confirmed FB or IG URL → rejected=true, rejectionReason="no confirmed social URL"
3. Only use URLs actually seen — in discovery URLs above OR in search results. NEVER construct URLs.

Return ONLY this JSON:
{
  "rejected": false,
  "rejectionReason": null,
  "name": "${name}",
  "industry": "Food & Beverage|Fashion & Clothing|Beauty & Cosmetics|Crafts & Handmade|Jewelry|Home Goods|Agriculture|Education|Services|Other",
  "productType": "3-6 word description",
  "description": "2-3 sentences about this business",
  "location": "City, ${countryName}",
  "foundedYear": null,
  "employeeCount": "1-5",
  "monthlyRevenue": "$500-$2000",
  "socialMedia": {
    "facebook": "EXACT url from discovery or search or null — NO invention",
    "instagram": "EXACT url from discovery or search or null — NO invention",
    "whatsapp": "real phone if found or null"
  },
  "contactEmail": null,
  "ownerName": "real name if found or realistic local name",
  "followers": {"facebook": 1000, "instagram": 600},
  "products": ["product1", "product2", "product3"],
  "priceRange": "$X-$Y",
  "tags": ["tag1", "tag2", "tag3"],
  "noWebsiteReason": "Runs everything through Instagram DMs",
  "opportunityScore": 75,
  "languages": ["local language", "English"],
  "isIllustrative": false
}`,
    2000, ct
  );

  const profile = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());

  if (profile.rejected) return { skipped: true, reason: `"${name}" — ${profile.rejectionReason}` };

  // Hard-lock verified discovery URLs
  if (fbUrl?.startsWith('http')) profile.socialMedia.facebook = fbUrl;
  if (igUrl?.startsWith('http')) profile.socialMedia.instagram = igUrl;

  if (!profile.socialMedia?.facebook && !profile.socialMedia?.instagram)
    return { skipped: true, reason: `"${name}" — no verified social URL` };

  return { skipped: false, profile };
}

async function generateIllustrative(countryName, ct = null) {
  const raw = await claudeHaiku('Return ONLY valid JSON arrays.',
    `Generate 8 realistic illustrative SME profiles for ${countryName}.
ILLUSTRATIVE only — not verified real businesses. Set isIllustrative=true, all socialMedia URLs to null.
Return JSON array: [{"name":str,"industry":str,"productType":str,"description":str,"location":"City, ${countryName}","foundedYear":null,"employeeCount":"1-5","monthlyRevenue":"$500-$2000","socialMedia":{"facebook":null,"instagram":null,"whatsapp":null},"contactEmail":null,"ownerName":str,"followers":{"facebook":800,"instagram":500},"products":[str,str,str],"priceRange":"$5-$50","tags":[str,str,str],"noWebsiteReason":"Uses Instagram DMs for all orders","opportunityScore":72,"languages":["local","English"],"isIllustrative":true}]`,
    5000, ct);
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SOCIAL MEDIA IMAGE SCRAPER — Python subprocess integration
// ═══════════════════════════════════════════════════════════════════════════════

/** Return stored images (base64 data URIs) for an SME from the DB. */
async function getStoredImages(smeId) {
  const { rows } = await pool.query(
    'SELECT data FROM sme_images WHERE sme_id=$1 ORDER BY scraped_at ASC',
    [smeId]
  );
  return rows.map(r => r.data);
}

/**
 * Run the Python scraper for a single social media URL.
 * Returns an array of { path, platform, source_url, caption } objects.
 */
function runPyScraper(url, maxImages, logCb = null) {
  const outDir = mkdtempSync(path.join(tmpdir(), 'sme-scraper-'));
  const scraperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scraper.py');

  const proc = spawn('python3', [scraperPath, url, '--output', outDir, '--max', String(maxImages)], {
    env: process.env,
  });

  let stderr = '';
  proc.stderr.on('data', d => {
    const chunk = d.toString();
    stderr += chunk;
    if (logCb) {
      chunk.split('\n').filter(l => l.trim()).forEach(l => logCb(l.trim()));
    }
  });

  const promise = new Promise((resolve) => {
    proc.on('close', (code) => {
      const resultsFile = path.join(outDir, 'results.json');
      let records = [];
      if (existsSync(resultsFile)) {
        try {
          const parsed = JSON.parse(readFileSync(resultsFile, 'utf8'));
          records = parsed.images || [];
        } catch (_) {}
      }
      if (code !== 0 && code !== null) {
        console.error(`  ⚠️  Scraper exited ${code} for ${url}\n${stderr.slice(-800)}`);
        if (logCb) logCb(`Scraper exited with code ${code} — check IG/FB credentials in .env`);
      }
      // NOTE: do NOT delete outDir here — caller must read image files first, then clean up
      resolve({ records, outDir });
    });
  });

  const kill = () => {
    try { proc.kill('SIGTERM'); } catch (_) {}
    try { rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  };

  return { promise, kill };
}

/**
 * Scrape images for an SME from its social media pages and store in DB.
 * Skips if the SME already has ≥5 stored images.
 * Returns the base64 data URIs of all stored images.
 */
async function scrapeAndStoreImages(sme, maxImages = 15, logCb = null, abortCtx = null) {
  const _log = (msg) => { console.log(`  📷 ${msg}`); if (logCb) logCb(msg); };

  // Return cached images if we already have enough
  const existing = await getStoredImages(sme.id);
  if (existing.length >= 5) {
    _log(`Using ${existing.length} cached images for "${sme.name}"`);
    return existing;
  }

  const urls = [sme.socialMedia?.instagram, sme.socialMedia?.facebook].filter(Boolean);
  if (!urls.length) {
    _log(`No social media URLs for "${sme.name}" — skipping Python scrape`);
    return [];
  }

  const allDataUris = [];

  for (const url of urls) {
    if (abortCtx?.killed) break;
    const remaining = maxImages - allDataUris.length;
    if (remaining <= 0) break;

    _log(`Scraping images from ${url} (max ${remaining})…`);
    const { promise, kill } = runPyScraper(url, remaining, logCb);

    // Register kill function so external stop can terminate the subprocess
    if (abortCtx) abortCtx.killProc = kill;
    const { records, outDir } = await promise;
    if (abortCtx) abortCtx.killProc = null;

    if (abortCtx?.killed) {
      try { rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
      _log(`Scrape aborted by user`);
      break;
    }

    for (const rec of records) {
      try {
        const buf = readFileSync(rec.path);
        const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
        await pool.query(
          `INSERT INTO sme_images (sme_id, data, platform, source_url, caption)
           VALUES ($1,$2,$3,$4,$5)`,
          [sme.id, dataUri, rec.platform || null, rec.source_url || null, rec.caption || null]
        );
        allDataUris.push(dataUri);
        _log(`Stored image [${allDataUris.length}/${maxImages}] from ${rec.platform || 'social'}`);
      } catch (e) {
        _log(`Failed to store image: ${e.message}`);
      }
    }

    // Clean up temp dir now that all files have been read
    try { rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    _log(`${records.length} images scraped and stored from ${url}`);
  }

  return allDataUris;
}

// WEBSITE BUILDER — scrapes social media content first, then builds rich site
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapeSocialContent(sme, ct = null) {
  const searches = [];

  if (sme.socialMedia?.facebook) {
    searches.push(webSearch(`site:facebook.com "${sme.name}" products posts about bio ${sme.location}`, ct));
    searches.push(webSearch(`"${sme.name}" facebook "${sme.location}" photos posts products prices`, ct));
  }
  if (sme.socialMedia?.instagram) {
    searches.push(webSearch(`site:instagram.com "${sme.name}" products posts bio ${sme.location}`, ct));
  }
  // General brand search
  searches.push(webSearch(`"${sme.name}" ${sme.location} ${sme.industry} products prices reviews`, ct));

  const results = await Promise.allSettled(searches);
  const rawText = results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .join('\n\n===\n\n')
    .slice(0, 16000);

  // Extract structured content from scraped data
  const extracted = await claude(
    'You extract social media business content. Return ONLY valid JSON.',
    `Extract real content for this business from the search results below.

Business: "${sme.name}"
Industry: ${sme.industry}
Location: ${sme.location}
Facebook: ${sme.socialMedia?.facebook || 'N/A'}
Instagram: ${sme.socialMedia?.instagram || 'N/A'}

SEARCH RESULTS:
${rawText}

Extract everything you can find. For missing fields, use realistic values based on industry/location context.

CRITICAL: For "realImages" — scan the search results above for any literal image URLs (https://...) ending in .jpg .jpeg .png .webp, or CDN URLs from fbcdn.net, cdninstagram.com, pinimg.com, or any image host. Copy them verbatim (up to 8 URLs).

Return ONLY this JSON:
{
  "tagline": "catchy 6-10 word tagline for this business",
  "aboutText": "2-3 paragraph about section based on real bio/posts found",
  "heroHeadline": "attention-grabbing hero headline",
  "products": [
    {
      "name": "product name",
      "description": "1-2 sentence description",
      "price": "price or range",
      "emoji": "relevant emoji"
    }
  ],
  "testimonialQuote": "realistic customer review based on comments found or generate plausible one",
  "testimonialAuthor": "customer name",
  "brandColors": {
    "primary": "#hexcolor based on industry (e.g. warm amber for food, deep green for crafts)",
    "secondary": "#hexcolor",
    "accent": "#hexcolor"
  },
  "coverImageDescription": "describe the ideal hero image for this business (for CSS gradient fallback)",
  "socialPostHighlights": ["highlight 1 from posts", "highlight 2", "highlight 3"],
  "contactPhone": "phone if found or null",
  "openingHours": "hours if found or typical hours for this type of business",
  "uniqueSellingPoints": ["USP 1", "USP 2", "USP 3"],
  "realImages": ["https://actual-image-url-copied-verbatim-from-search-results.jpg"]
}`,
    3000, ct
  );

  try {
    return JSON.parse(extracted.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return null;
  }
}

// Dedicated image URL scraper — browses actual social media pages for og:image + CDN URLs
async function scrapeImages(sme, ct = null) {
  // Browse the actual social media pages directly so Claude can read og:image meta tags
  const fetches = [
    sme.socialMedia?.facebook && webSearch(
      `Visit ${sme.socialMedia.facebook} and extract every image URL from: og:image meta tag, cover photo, profile picture, and any product photos visible on the page. Return only the raw https:// URLs.`,
      ct
    ),
    sme.socialMedia?.facebook && webSearch(
      `Visit ${sme.socialMedia.facebook}/photos and list all photo image URLs you can see`,
      ct
    ),
    sme.socialMedia?.instagram && webSearch(
      `Visit ${sme.socialMedia.instagram} and extract the og:image URL, profile picture URL, and any post thumbnail URLs from the page HTML`,
      ct
    ),
    // Broad filetype search — sometimes returns directly accessible image URLs
    webSearch(`"${sme.name}" ${sme.location} product photo filetype:jpg OR filetype:png`, ct),
  ].filter(Boolean);

  const results = await Promise.allSettled(fetches);
  const rawText = results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .join('\n\n')
    .slice(0, 16000);

  const extracted = await claudeHaiku(
    'Extract image URLs. Return ONLY a valid JSON array of URL strings, no markdown.',
    `From this page content about "${sme.name}" in ${sme.location}, extract every image URL you can find.

Look specifically for:
- og:image meta tag values
- Facebook CDN URLs (scontent.fbcdn.net, scontent.*.fna.fbcdn.net, fbsbx.com)
- Instagram CDN URLs (cdninstagram.com, instagram.*)
- Any https:// URL ending in .jpg .jpeg .png .webp .gif

PAGE CONTENT:
${rawText}

Return ONLY valid JSON: ["https://url1", "https://url2", ...] — up to 12 raw image URLs.
If zero found, return [].`,
    800, ct
  );

  try {
    const urls = JSON.parse(extracted.replace(/```json\n?|\n?```/g, '').trim());
    return Array.isArray(urls)
      ? urls.filter(u => typeof u === 'string' && u.startsWith('https://'))
      : [];
  } catch { return []; }
}

// Download image URLs and convert to base64 data URIs so they are embedded permanently
async function downloadImages(urls, max = 8) {
  const images = [];
  for (const url of urls.slice(0, max * 3)) {
    if (images.length >= max) break;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      // Use full browser headers — required for Facebook/Instagram CDN access
      const isFb = url.includes('fbcdn') || url.includes('facebook');
      const isIg = url.includes('cdninstagram') || url.includes('instagram');
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(isFb ? { 'Referer': 'https://www.facebook.com/' } : {}),
          ...(isIg ? { 'Referer': 'https://www.instagram.com/' } : {}),
        },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!ct.startsWith('image/')) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 4000 || buf.byteLength > 6_000_000) continue; // skip tiny/huge
      images.push(`data:${ct};base64,${Buffer.from(buf).toString('base64')}`);
    } catch (_) { /* skip failed URLs */ }
  }
  return images;
}

// Topic-matched stock photos via loremflickr.com (free, no API key)
// Used as fallback when real social media photos can't be downloaded
function getStockImageUrls(sme, count = 6) {
  const industryKw = {
    'Food & Beverage':    'food,cooking,homemade,delicious',
    'Fashion & Clothing': 'fashion,clothing,boutique,style',
    'Beauty & Cosmetics': 'beauty,cosmetics,skincare,makeup',
    'Crafts & Handmade':  'handmade,artisan,craft,workshop',
    'Jewelry':            'jewelry,accessories,handcrafted,gems',
    'Home Goods':         'home,decor,interior,furniture',
    'Agriculture':        'farm,organic,harvest,agriculture',
    'Education':          'education,learning,books,school',
    'Services':           'business,service,professional,office',
  };
  const kw = encodeURIComponent(industryKw[sme.industry] || sme.industry.toLowerCase().replace(/\s+/g, ','));
  return Array.from({ length: count }, (_, i) =>
    `https://loremflickr.com/800/600/${kw}?lock=${i + 1}`
  );
}

async function buildWebsiteHtml(sme, content, images = [], ct = null, logFn = null) {
  const c = content || {};
  const fbUrl  = sme.socialMedia?.facebook || '';
  const igUrl  = sme.socialMedia?.instagram || '';
  const waNum  = sme.socialMedia?.whatsapp?.replace(/\D/g, '') || '';

  const products = (c.products?.length ? c.products : (sme.products || []).map(p => ({
    name: p, description: `Premium ${p} from ${sme.location}`, price: sme.priceRange, emoji: '✨'
  }))).slice(0, 6);

  // ── Industry-specific design directions ────────────────────────────────────
  const designDirections = {
    'Food & Beverage': `
PERSONALITY: Warm, inviting, rustic-artisan. Think beloved neighbourhood kitchen.
PALETTE: Earthy tones — deep amber, terracotta, warm cream, forest green accents.
TYPOGRAPHY: Bold display serif for headlines (e.g. Lora, Playfair). Warm readable sans for body.
LAYOUT IDEAS: Full-bleed appetising hero, floating badge "Made fresh daily", ingredient-spotlight strips,
  menu-card product grid (not boring e-commerce cards), handwritten-feel testimonials, map/hours block.
SECTIONS to include: Hero → "Our Kitchen Story" → "What We Make" (menu-style) → "Made With Love" (USPs)
  → Customer Love (testimonials) → Hours & Contact → Footer.
VIBE: Feels like the homepage of a Michelin-recommended street food spot.`,

    'Fashion & Clothing': `
PERSONALITY: Editorial, aspirational, independent-boutique cool. Think curated capsule collection.
PALETTE: Contrast-led — either bone/cream with near-black, OR deep burgundy/navy with champagne.
TYPOGRAPHY: Ultra-thin elegant serif for hero, clean geometric sans for body. Lots of letter-spacing.
LAYOUT IDEAS: Cinematic full-screen hero (text barely overlapping image), horizontal scroll hint,
  lookbook-style product grid (large images, minimal text), "The Edit" or "The Drop" section names,
  pull-quote testimonial in huge italic type, email signup CTA.
SECTIONS: Hero → "The Collection" (lookbook grid) → "About the Brand" (brand story) → "Style Notes"
  (USPs framed as editorial tips) → "What Our Clients Say" → Contact/Order → Footer.
VIBE: Feels like the site of an independent fashion label featured in Vogue.`,

    'Beauty & Cosmetics': `
PERSONALITY: Luxurious, clean, wellness-forward. Think high-end spa meets clean beauty brand.
PALETTE: Soft feminine — blush rose, champagne gold, warm ivory, dusty mauve. OR clean white + sage.
TYPOGRAPHY: Elegant script/italic serif for accent text, light-weight sans for body. Generous spacing.
LAYOUT IDEAS: Soft-gradient hero, floating product "ritual" cards, ingredient close-up strips,
  "The Science & Soul" section, before/after style testimonials, "Book a Treatment" CTA.
SECTIONS: Hero → "Our Philosophy" → "Treatments & Products" → "Natural Ingredients" → 
  "Client Transformations" (testimonials) → Book/Contact → Footer.
VIBE: Feels like Aesop or a luxury day-spa website.`,

    'Crafts & Handmade': `
PERSONALITY: Artisan, soulful, handcrafted warmth. Think top Etsy seller meets local gallery.
PALETTE: Earthy organic — clay orange, sage green, linen cream, dark charcoal, wood brown.
TYPOGRAPHY: Slightly textured/handcrafted-feel serif for headlines, warm readable sans for body.
LAYOUT IDEAS: Hero with "Made by hand. Made for you." energy, "The Making Process" step strip,
  product cards with material callouts, "Every Piece Is Different" uniqueness section,
  "Custom Orders Welcome" feature block, maker portrait or story block.
SECTIONS: Hero → "Meet the Maker" → "The Collection" → "How It's Made" → "Custom Orders"
  → "What Our Customers Say" → Contact → Footer.
VIBE: Feels like a beloved independent craft studio with personality.`,

    'Jewelry': `
PERSONALITY: Precious, minimal, quietly luxurious. Think independent atelier meets fine jewellery house.
PALETTE: Either: jet black + gold/champagne. Or: pure white + silver/platinum. Bold contrast, no grey areas.
TYPOGRAPHY: Ultra-elegant thin serif (Cormorant Garamond style), very generous white space, minimal text.
LAYOUT IDEAS: Dramatic dark or bright hero with a single product close-up, "Each Piece" collection
  with zoomed-in detail photography feel, "Materials & Craft" story block, "Custom Commissions" feature,
  dramatic pull-quote testimonial, minimal contact form.
SECTIONS: Hero → "The Collection" → "Craftsmanship" (materials story) → "Bespoke Commissions"
  → "Client Stories" → Contact → Footer.
VIBE: Feels like Mejuri or a Parisian fine-jewellery maison.`,

    'Home Goods': `
PERSONALITY: Lifestyle, warm, editorial home-magazine. Think curated interior boutique.
PALETTE: Warm neutrals — warm white, sand, warm taupe, terracotta pop, deep olive.
TYPOGRAPHY: Modern editorial serif for headlines, clean sans for body. Relaxed airy feel.
LAYOUT IDEAS: Lifestyle/room-setting hero (not product-on-white), "For Your Home" product grid
  with room context descriptions, "Design Philosophy" section, "Room Inspirations" mood board strip,
  "Thoughtfully Made" USP block.
SECTIONS: Hero → "Curated for Your Home" (products) → "Our Design Story" → "Room Inspirations"
  → "Why Our Customers Love Us" → Order/Contact → Footer.
VIBE: Feels like a Kinfolk editorial meets independent home goods shop.`,

    'Agriculture': `
PERSONALITY: Honest, fresh, farm-to-table. Think modern organic farm brand.
PALETTE: Deep field greens, warm harvest amber, soil brown, sky blue accent, clean white.
TYPOGRAPHY: Strong bold sans for impact headlines, trustworthy readable serif for body.
LAYOUT IDEAS: Field/nature-inspired hero, "From Our Farm" origin story, "This Season" product grid,
  "Why Buy Local" values section, certification/quality badges strip, simple order/delivery info.
SECTIONS: Hero → "Our Farm Story" → "Fresh This Season" (products) → "Why Choose Local"
  → "What Our Community Says" → Order/Delivery → Footer.
VIBE: Feels like a premium farm-box brand or organic co-op.`,
  };

  const designGuide = designDirections[sme.industry] ||
    `PERSONALITY: Professional, warm, community-first. Create a design that authentically reflects
the ${sme.industry} industry character and the culture/aesthetic of ${sme.location?.split(',').pop()?.trim() || 'the region'}.
Choose palette, typography and layout that feel genuinely specific to this type of business.`;

  // Image placeholders — actual base64 data URIs are injected AFTER generation
  const imgInfo = images.length > 0
    ? `You have ${images.length} real business photo(s). MANDATORY: use ALL of them distributed across MULTIPLE sections — never put every image only in the hero.
  Placeholder tokens (use exactly as written):
    {{IMG_0}} — hero/main visual (background or prominent img)
    ${images.slice(1).map((_, i) => `{{IMG_${i+1}}}`).join(', ')} — distribute across product gallery, about section, testimonial background, etc.
  Usage: <img src="{{IMG_N}}" ...> OR style="background-image:url('{{IMG_N}}')".
  RULE: every placeholder MUST appear at least once somewhere in the HTML.`
    : `No real photos available. Use rich CSS gradients, patterns, and tasteful emoji/icons instead of <img> tags.`;

  const systemPrompt = `You are a world-class web designer and front-end developer who creates \
stunning, highly customised websites. Every site you build feels unique and tailor-made — \
never templated.

ABSOLUTE RULES:
- Output ONLY the complete raw HTML. No markdown fences, no explanation, no comments outside the HTML.
- The HTML file MUST be fully complete — it MUST end with </html>. NEVER stop generating mid-way.
- Single self-contained file: all CSS and JS must be inline (inside <style> and <script> tags).
- Fully mobile-responsive (use media queries or CSS grid/flex).
- No Lorem Ipsum — every word of copy must be real, specific to this business.
- The visual identity (palette, typography, layout, section names, tone of copy) must be \
unmistakably industry-specific — not a generic business template with colours swapped.
- MUST include a working order/contact form that, on submit, opens WhatsApp with pre-filled message \
(if WhatsApp number provided) or shows a confirmation message.
- Social media links (Facebook, Instagram) must be included if provided.
- MUST include ALL sections listed in the design direction — no section may be omitted or left skeletal.
- If you use a CSS class like .reveal for scroll animations, you MUST include the JavaScript \
IntersectionObserver code that activates it. Never add CSS animation classes without the script.
- MANDATORY <script> block before </body>: Include IntersectionObserver scroll-reveal for '.reveal' \
elements, navbar scroll-shadow toggle on window scroll, and mobile hamburger menu toggle. \
This script is REQUIRED even if the rest of the page has no JS.`;

  const userPrompt = `Build a complete, unique, production-ready website for this business.

━━━ BUSINESS DATA ━━━
Name:         ${sme.name}
Industry:     ${sme.industry}
Location:     ${sme.location}
Description:  ${sme.description || c.aboutText || '(none provided)'}
Founded:      ${sme.foundedYear || 'unknown'}
Employees:    ${sme.employeeCount || '1-5'}
Price range:  ${sme.priceRange || 'varies'}
Tags:         ${(sme.tags || []).join(', ')}

━━━ SOCIAL PRESENCE ━━━
Facebook:     ${fbUrl || 'none'}   (Followers: ${sme.followers?.facebook || 0})
Instagram:    ${igUrl || 'none'}   (Followers: ${sme.followers?.instagram || 0})
WhatsApp:     ${waNum ? `+${waNum}` : 'none'}

━━━ CONTENT FROM SOCIAL MEDIA ━━━
Hero headline:  "${c.heroHeadline || sme.name}"
Tagline:        "${c.tagline || sme.productType || ''}"
About text:     ${c.aboutText || sme.description || '(write based on industry/location)'}
Unique selling points: ${(c.uniqueSellingPoints || []).join(' | ') || '(infer from industry)'}
Testimonial:    "${c.testimonialQuote || ''}" — ${c.testimonialAuthor || ''}
Social highlights: ${(c.socialPostHighlights || []).join(' | ')}
Opening hours:  ${c.openingHours || ''}
Contact phone:  ${c.contactPhone || ''}
Suggested brand colours: primary=${c.brandColors?.primary || 'choose'}, \
secondary=${c.brandColors?.secondary || 'choose'}, accent=${c.brandColors?.accent || 'choose'}

━━━ PRODUCTS / SERVICES ━━━
${products.map(p => `• ${p.name} — ${p.description} — ${p.price || sme.priceRange}`).join('\n')}

━━━ IMAGES ━━━
${imgInfo}

━━━ DESIGN DIRECTION FOR ${sme.industry.toUpperCase()} ━━━
${designGuide}

━━━ TECHNICAL REQUIREMENTS ━━━
1. WhatsApp order button/form: ${waNum
    ? `On form submit, open https://wa.me/${waNum}?text=... with pre-filled message including customer name, product, quantity`
    : 'No WhatsApp — show a confirmation message and prompt them to reach via social media'}
2. Facebook link: ${fbUrl || 'none'}
3. Instagram link: ${igUrl || 'none'}
4. Use Google Fonts that match the industry personality (specify in <link> tag)
5. Respect the suggested brand colours if provided, otherwise choose perfect industry-appropriate ones
6. Every product must show its name, description, price, and an "Order" / "Enquire" CTA
7. MANDATORY — include this exact <script> block immediately before </body>:
<script>
  // Scroll reveal
  document.querySelectorAll('.reveal').forEach(el => {
    new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); } });
    }, { threshold: 0.12 }).observe(el);
  });
  // Navbar scroll shadow
  window.addEventListener('scroll', () => {
    const nav = document.querySelector('nav, #navbar, .navbar, header nav');
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 60);
  });
  // Mobile menu
  const ham = document.getElementById('hamburger') || document.querySelector('.hamburger, .menu-toggle');
  const mob = document.getElementById('mobileMenu') || document.querySelector('.mobile-menu, .mobile-nav');
  if (ham && mob) {
    ham.addEventListener('click', () => mob.classList.toggle('open'));
    mob.querySelectorAll('a').forEach(a => a.addEventListener('click', () => mob.classList.remove('open')));
  }
</script>
8. The file MUST end with </body></html> — generate the entire page without stopping early.`;

  const MAX_TOKENS = 32000;

  let html;

  if (logFn) {
    // Streaming mode — send live progress updates during generation
    logFn(`Sending request to Claude (up to ${MAX_TOKENS} tokens)…`, 'info');
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    html = '';
    let lastLogAt = Date.now();

    stream.on('text', (text) => {
      html += text;
      const now = Date.now();
      if (now - lastLogAt > 2500) {
        logFn(`Generating HTML… ${Math.round(html.length / 1024)}kb / ~${html.split('\n').length} lines`, 'info');
        lastLogAt = now;
      }
    });

    await stream.finalMessage().then(msg => {
      if (ct && msg.usage) {
        ct.inputTokens  += msg.usage.input_tokens  || 0;
        ct.outputTokens += msg.usage.output_tokens || 0;
      }
    });

    logFn(`Claude finished — ${Math.round(html.length / 1024)}kb generated`, 'ok');
  } else {
    html = await claude(systemPrompt, userPrompt, MAX_TOKENS, ct);
  }

  // Strip any accidental markdown fences
  html = html.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim();

  // Inject actual base64 image data URIs in place of placeholders
  images.forEach((dataUri, i) => {
    html = html.replaceAll(`{{IMG_${i}}}`, dataUri);
  });

  return html;
}


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (_, res) => res.json({ ok: true, version: '2.3' }));

// Countries
app.get('/api/countries', async (_, res) => {
  try { res.json((await pool.query('SELECT * FROM countries ORDER BY created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/countries', async (req, res) => {
  const { name, code, flag } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO countries (name,code,flag) VALUES ($1,$2,$3) RETURNING *',
      [name, code || '', flag || '🌍']
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/countries/:id', async (req, res) => {
  try { await pool.query('DELETE FROM countries WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FIX #1: Load SMEs from DB when opening country ───────────────────────────
app.get('/api/countries/:id/smes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM smes WHERE country_id=$1 ORDER BY opportunity_score DESC, created_at DESC',
      [req.params.id]
    );
    res.json(rows.map(normalizeSme));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SME search — async pipeline, streams via SSE
app.post('/api/countries/:id/search-smes', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM countries WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Country not found' });
  res.json({ ok: true });
  const filters = {
    industries:   Array.isArray(req.body?.industries)   ? req.body.industries   : [],
    minFollowers: req.body?.minFollowers != null         ? Number(req.body.minFollowers) : null,
    maxFollowers: req.body?.maxFollowers != null         ? Number(req.body.maxFollowers) : null,
  };
  runSearchPipeline(req.params.id, rows[0].name, filters).catch(err => {
    console.error('Pipeline error:', err);
    sse(req.params.id, 'error', { message: err.message });
  });
});

// ── WEBSITE BUILDER — scrapes social, then builds rich site ──────────────────
app.post('/api/smes/:id/build-website', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = normalizeSme(rows[0]);

  // Respond immediately so the frontend can start listening to SSE
  res.json({ ok: true, status: 'building' });

  const L = (msg, type = 'info') => smeLog(sme.id, msg, type);

  // Run the build pipeline asynchronously
  (async () => {
    try {
      const ct = newCost();
      L(`━━━ Building website for "${sme.name}" ━━━`, 'phase');

      // ── Phase 1: Scrape social content ────────────────────────────────────
      L(`PHASE 1 — Scraping social media content…`, 'phase');
      const content = await scrapeSocialContent(sme, ct);
      L(`Social content extracted (tagline, products, brand colors)`, 'ok');

      // ── Phase 2: Gather images ─────────────────────────────────────────────
      L(`PHASE 2 — Gathering images for "${sme.name}"…`, 'phase');

      // 2a: Check DB for already-stored images
      let images = await getStoredImages(sme.id);

      if (images.length > 0) {
        // Images already in DB — skip all scraping and use cached images
        L(`Found ${images.length} cached images in DB — skipping scraping`, 'ok');
      } else {
        // No images in DB — run full scraping pipeline first
        L(`No cached images found — running scraping pipeline…`, 'info');

        // 2b: Python scraper (requires IG_SESSION or IG_USERNAME+IG_PASSWORD in .env)
        const socialUrls = [sme.socialMedia?.instagram, sme.socialMedia?.facebook].filter(Boolean);
        if (socialUrls.length) {
          L(`Attempting Python scraper for ${socialUrls.length} social URL(s)…`, 'info');
          const scraped = await scrapeAndStoreImages(sme, 12, (msg) => L(`  [scraper] ${msg}`, 'info'));
          if (scraped.length > 0) {
            images = scraped;
            L(`${scraped.length} real photos scraped and stored in DB`, 'ok');
          } else {
            L(`Python scraper returned 0 images (credentials may be missing — set IG_SESSION in .env)`, 'warn');
          }
        } else {
          L(`No Instagram/Facebook URLs on this SME — skipping Python scraper`, 'warn');
        }

        // 2c: AI web-search image URL discovery (scrapeImages function)
        if (images.length < 3) {
          L(`Running AI web-search to discover image URLs…`, 'info');
          const imageUrls = await scrapeImages(sme, ct);
          L(`Web search found ${imageUrls.length} candidate image URL(s)`, imageUrls.length > 0 ? 'ok' : 'warn');
          if (imageUrls.length > 0) {
            L(`Downloading up to 8 images from discovered URLs…`, 'info');
            const downloaded = await downloadImages(imageUrls, 8);
            if (downloaded.length > 0) {
              for (const dataUri of downloaded) {
                try {
                  await pool.query(
                    `INSERT INTO sme_images (sme_id, data, platform, source_url, caption) VALUES ($1,$2,'web-search',null,null)`,
                    [sme.id, dataUri]
                  );
                } catch (_) {}
              }
              images = [...images, ...downloaded];
              L(`${downloaded.length} images downloaded and stored in DB`, 'ok');
            } else {
              L(`Could not download images from discovered URLs (CDN restrictions)`, 'warn');
            }
          }
        }

        // 2d: realImages extracted from scrapeSocialContent
        if (images.length < 3 && content?.realImages?.length) {
          L(`Trying ${content.realImages.length} image URL(s) from social content scrape…`, 'info');
          const webImages = await downloadImages(content.realImages, 6);
          if (webImages.length > 0) {
            for (const dataUri of webImages) {
              try {
                await pool.query(
                  `INSERT INTO sme_images (sme_id, data, platform, source_url, caption) VALUES ($1,$2,'social-content',null,null)`,
                  [sme.id, dataUri]
                );
              } catch (_) {}
            }
            images = [...images, ...webImages];
            L(`${webImages.length} images stored from social content results`, 'ok');
          }
        }
      }

      // 2e: Stock photo fallback (always runs if still too few images)
      if (images.length < 3) {
        const needed = 6 - images.length;
        L(`Using stock photos as visual fallback (${images.length} real images found)`, 'warn');
        const stockImages = await downloadImages(getStockImageUrls(sme, needed + 2));
        images = [...images, ...stockImages].slice(0, 8);
        L(`Supplemented with ${stockImages.length} stock photos — total: ${images.length} images`, 'ok');
      }

      L(`Total images for website: ${images.length}`, 'ok');

      // ── Phase 3: Build HTML with Claude ────────────────────────────────────
      L(`PHASE 3 — Building website HTML with Claude AI (${images.length} images)…`, 'phase');
      let html = await buildWebsiteHtml(sme, content, images, ct, (msg) => L(msg, 'info'));
      L(`HTML generated — ${Math.round(html.length / 1024)}kb`, 'ok');

      // Validate HTML completeness
      if (!html || html.length < 500) {
        throw new Error('Website generation produced empty or too-short HTML');
      }

      // Truncation detection — HTML must end with </html>
      const trimmedHtml = html.trimEnd();
      const isComplete = trimmedHtml.endsWith('</html>') || trimmedHtml.endsWith('</html>\n');
      if (!isComplete) {
        L(`HTML appears truncated (${Math.round(html.length / 1024)}kb, no closing </html>) — requesting continuation…`, 'warn');
        const tailContext = html.slice(-3000);
        const completion = await claude(
          'You are completing a truncated HTML website. Output ONLY the continuation — start from where it was cut off and end with </body></html>. No preamble, no markdown fences.',
          `This HTML file was cut off mid-generation. Continue from exactly where it stopped:\n\n${tailContext}\n\nFinish all remaining sections and close with </body></html>.`,
          16000, ct
        );
        const cleanCompletion = completion.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim();
        html = html + '\n' + cleanCompletion;
        L(`Continuation added — total: ${Math.round(html.length / 1024)}kb`, 'ok');
      }

      // Safety net: auto-inject scroll reveal script if missing
      if (!html.includes('IntersectionObserver') && html.includes('.reveal')) {
        L(`Scroll reveal script missing — auto-injecting…`, 'warn');
        const revealScript = `<script>
  document.querySelectorAll('.reveal').forEach(el => {
    new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); } });
    }, { threshold: 0.12 }).observe(el);
  });
  window.addEventListener('scroll', () => {
    const nav = document.querySelector('nav, #navbar, .navbar, header nav');
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 60);
  });
  const ham = document.getElementById('hamburger') || document.querySelector('.hamburger, .menu-toggle');
  const mob = document.getElementById('mobileMenu') || document.querySelector('.mobile-menu, .mobile-nav');
  if (ham && mob) {
    ham.addEventListener('click', () => mob.classList.toggle('open'));
    mob.querySelectorAll('a').forEach(a => a.addEventListener('click', () => mob.classList.remove('open')));
  }
<\/script>`;
        html = html.replace(/<\/body>/i, revealScript + '\n</body>');
      }

      // ── Save to DB ─────────────────────────────────────────────────────────
      await pool.query(
        `INSERT INTO websites (sme_id, html, social_content) VALUES ($1,$2,$3)
         ON CONFLICT (sme_id) DO UPDATE SET html=$2, social_content=$3, built_at=NOW()`,
        [sme.id, html, JSON.stringify(content || {})]
      );
      await pool.query(`UPDATE smes SET status='website_built' WHERE id=$1`, [sme.id]);

      const cost = await saveCost(ct, 'website_build', { smeId: sme.id, smeName: sme.name });
      L(`💰 Cost: ${cost.display}  (Sonnet: ${cost.inputTokens.toLocaleString()}/${cost.outputTokens.toLocaleString()} tok · Haiku: ${cost.haikuInput.toLocaleString()}/${cost.haikuOutput.toLocaleString()} tok · ${cost.searches} searches)`, 'ok');
      L(`━━━ Website ready! ━━━`, 'phase');

      smeSse(sme.id, 'done', { imagesUsed: images.length, contentScraped: !!content, cost });

    } catch (e) {
      console.error('Website builder error:', e);
      L(`Error: ${e.message}`, 'warn');
      smeSse(sme.id, 'error', { message: e.message });
    }
  })();
});

// ── Stop an active scrape job ─────────────────────────────────────────────────
app.post('/api/smes/:id/scrape-images/stop', (req, res) => {
  const smeId = String(req.params.id);
  const ctx = activeScrapes.get(smeId);
  if (ctx) {
    ctx.killed = true;
    if (ctx.killProc) ctx.killProc();
    activeScrapes.delete(smeId);
    smeLog(smeId, 'Scrape stopped by user', 'warn');
    smeSse(smeId, 'scrape-stopped', { count: 0 });
  }
  res.json({ ok: true });
});

// ── Scrape & store social media images for an SME ────────────────────────────
app.post('/api/smes/:id/scrape-images', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = normalizeSme(rows[0]);

  // Allow force re-scrape via ?force=true
  if (req.query.force === 'true') {
    await pool.query('DELETE FROM sme_images WHERE sme_id=$1', [sme.id]);
    smeLog(sme.id, `Cleared existing images for "${sme.name}"`, 'info');
  }

  // Respond immediately so SSE can stream progress
  res.json({ ok: true, status: 'scraping' });

  const L = (msg, type = 'info') => smeLog(sme.id, msg, type);
  const abortCtx = { killed: false, killProc: null };
  const scrapeCt = newCost();
  activeScrapes.set(String(sme.id), abortCtx);

  (async () => {
    try {
      L(`━━━ Scraping photos for "${sme.name}" ━━━`, 'phase');

      const socialUrls = [sme.socialMedia?.instagram, sme.socialMedia?.facebook].filter(Boolean);
      if (!socialUrls.length) {
        L(`No Instagram/Facebook URLs — cannot scrape photos`, 'warn');
        smeSse(sme.id, 'scrape-done', { count: 0, error: 'No social media URLs found' });
        return;
      }

      L(`PHASE 1 — Python scraper (requires IG_SESSION or IG_USERNAME/IG_PASSWORD in .env)`, 'phase');
      const images = await scrapeAndStoreImages(sme, req.body?.max || 15, (msg) => L(msg, 'info'), abortCtx);

      if (abortCtx.killed) {
        L(`Scrape stopped by user`, 'warn');
        smeSse(sme.id, 'scrape-stopped', { count: 0 });
        return;
      }

      if (images.length > 0) {
        L(`${images.length} photos scraped and stored in DB`, 'ok');
        await saveCost(scrapeCt, 'image_scrape', { smeId: sme.id, smeName: sme.name });
      } else {
        L(`Python scraper returned 0 images — trying AI web-search fallback…`, 'warn');

        // Fallback: AI web-search image discovery
        L(`PHASE 2 — AI web-search image discovery…`, 'phase');
        const imageUrls = await scrapeImages(sme, scrapeCt);
        L(`Web search found ${imageUrls.length} candidate image URL(s)`, imageUrls.length > 0 ? 'ok' : 'warn');

        let stored = 0;
        if (imageUrls.length > 0) {
          const downloaded = await downloadImages(imageUrls, 12);
          for (const dataUri of downloaded) {
            try {
              await pool.query(
                `INSERT INTO sme_images (sme_id, data, platform, source_url, caption) VALUES ($1,$2,'web-search',null,null)`,
                [sme.id, dataUri]
              );
              stored++;
            } catch (_) {}
          }
          if (stored > 0) L(`${stored} images downloaded and stored via web search`, 'ok');
        }

        if (stored === 0) {
          L(`No images could be retrieved. To enable Python scraper, set IG_SESSION in .env`, 'warn');
        }

        await saveCost(scrapeCt, 'image_scrape', { smeId: sme.id, smeName: sme.name });
        const finalImages = await getStoredImages(sme.id);
        smeSse(sme.id, 'scrape-done', { count: finalImages.length });
        return;
      }

      smeSse(sme.id, 'scrape-done', { count: images.length });
    } catch (e) {
      console.error('Image scrape error:', e);
      L(`Error: ${e.message}`, 'warn');
      smeSse(sme.id, 'scrape-done', { count: 0, error: e.message });
    } finally {
      activeScrapes.delete(String(sme.id));
    }
  })();
});

app.get('/api/smes/:id/website', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT html, deployed_url FROM websites WHERE sme_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No website built yet' });
    res.json({ html: rows[0].html, deployedUrl: rows[0].deployed_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Preview endpoint — serves HTML directly into iframe
app.get('/api/smes/:id/website/preview', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT html FROM websites WHERE sme_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;color:#666;text-align:center"><h2>No website built yet</h2><p>Click "Build Website" to generate one.</p></body></html>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(rows[0].html);
  } catch (e) { res.status(500).send('<html><body>Error loading preview</body></html>'); }
});

// Download HTML
app.get('/api/smes/:id/website/download', async (req, res) => {
  try {
    const { rows: sr } = await pool.query('SELECT name FROM smes WHERE id=$1', [req.params.id]);
    const { rows } = await pool.query('SELECT html FROM websites WHERE sme_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).send('Not found');
    const slug = (sr[0]?.name || 'website').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.html"`);
    res.setHeader('Content-Type', 'text/html');
    res.send(rows[0].html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deployer
app.post('/api/smes/:id/deploy', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = normalizeSme(rows[0]);
  const { rows: sr } = await pool.query('SELECT html FROM websites WHERE sme_id=$1', [sme.id]);
  if (!sr[0]) return res.status(400).json({ error: 'Build website first' });
  const slug = sme.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
  try {
    if (process.env.NETLIFY_TOKEN) {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip(); zip.file('index.html', sr[0].html);
      const buf = await zip.generateAsync({ type: 'nodebuffer' });
      const nr = await fetch('https://api.netlify.com/api/v1/sites', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.NETLIFY_TOKEN}`, 'Content-Type': 'application/zip' },
        body: buf,
      });
      const nd = await nr.json();
      const url = nd.ssl_url || nd.url || `https://${slug}.netlify.app`;
      await pool.query('UPDATE websites SET deployed_url=$1 WHERE sme_id=$2', [url, sme.id]);
      await pool.query(`UPDATE smes SET status='deployed', deployed_url=$1 WHERE id=$2`, [url, sme.id]);
      return res.json({ ok: true, url, slug });
    }
    const url = `https://${slug}.netlify.app`;
    await pool.query('UPDATE websites SET deployed_url=$1 WHERE sme_id=$2', [url, sme.id]);
    await pool.query(`UPDATE smes SET status='deployed', deployed_url=$1 WHERE id=$2`, [url, sme.id]);
    res.json({ ok: true, url, slug, simulated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marketing agent
app.post('/api/smes/:id/generate-email', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = normalizeSme(rows[0]);
  const { rows: sr } = await pool.query('SELECT deployed_url FROM websites WHERE sme_id=$1', [sme.id]);
  const url = sr[0]?.deployed_url || '[WEBSITE_LINK]';
  try {
    const ct = newCost();
    const raw = await claude(
      'World-class B2B copywriter. Return ONLY valid JSON {"subject":"...","body":"..."}.',
      `Write a personalized warm outreach email (max 220 words):
Business: ${sme.name} | Owner: ${sme.ownerName} | Industry: ${sme.industry}
Products: ${(sme.products || []).join(', ')} | Location: ${sme.location}
Active on: ${Object.entries(sme.socialMedia || {}).filter(([, v]) => v).map(([k]) => k).join(', ')}
Website we built: ${url} | Followers: FB ${sme.followers?.facebook || 0} / IG ${sme.followers?.instagram || 0}
Offer: Free website (${url}). Option A: 10% per sale, website free. Option B: monthly fee.
Requirements: curiosity subject, reference specific products, mention the no-website gap, include live link, warm tone.`,
      2000, ct
    );
    const email = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    const cost = await saveCost(ct, 'email_gen', { smeId: sme.id, smeName: sme.name });
    await pool.query(
      `INSERT INTO emails (sme_id,subject,body) VALUES ($1,$2,$3) ON CONFLICT (sme_id) DO UPDATE SET subject=$2,body=$3,created_at=NOW()`,
      [sme.id, email.subject, email.body]
    );
    await pool.query(`UPDATE smes SET status='email_ready' WHERE id=$1`, [sme.id]);
    res.json({ ...email, cost });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/smes/:id/email', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT subject,body FROM emails WHERE sme_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No email yet' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SPA fallback (must be after all API routes) ──────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(frontendPath, 'index.html')));

// ── Cost tracking endpoints ──────────────────────────────────────────────────

app.get('/api/costs', async (req, res) => {
  try {
    const conditions = [];
    const params = [];

    if (req.query.sme_id) {
      params.push(req.query.sme_id);
      conditions.push(`sme_id = $${params.length}`);
    }
    if (req.query.activity) {
      params.push(req.query.activity);
      conditions.push(`activity = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conditions.push(`created_at <= $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT id, sme_id, sme_name, country_id, country_name, activity,
              input_tokens, output_tokens, haiku_input, haiku_output,
              web_searches, total_cost, created_at
       FROM ai_costs ${where}
       ORDER BY created_at DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/costs/summary', async (req, res) => {
  try {
    const [totals, byActivity, bySme] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                       AS operations,
          COALESCE(SUM(total_cost), 0)        AS total_cost,
          COALESCE(SUM(input_tokens), 0)      AS input_tokens,
          COALESCE(SUM(output_tokens), 0)     AS output_tokens,
          COALESCE(SUM(haiku_input), 0)       AS haiku_input,
          COALESCE(SUM(haiku_output), 0)      AS haiku_output,
          COALESCE(SUM(web_searches), 0)      AS web_searches
        FROM ai_costs
      `),
      pool.query(`
        SELECT activity,
               COUNT(*)::int                  AS operations,
               COALESCE(SUM(total_cost), 0)   AS total_cost
        FROM ai_costs
        GROUP BY activity
        ORDER BY total_cost DESC
      `),
      pool.query(`
        SELECT sme_name,
               COUNT(*)::int                  AS operations,
               COALESCE(SUM(total_cost), 0)   AS total_cost
        FROM ai_costs
        WHERE sme_name IS NOT NULL
        GROUP BY sme_name
        ORDER BY total_cost DESC
        LIMIT 20
      `),
    ]);
    res.json({
      totals: totals.rows[0],
      byActivity: byActivity.rows,
      bySme: bySme.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Boot
const PORT = process.env.PORT || 3001;
ensureSchema()
  .then(() => app.listen(PORT, () => {
    console.log(`✅ WebLaunch v2.3 → http://localhost:${PORT}`);
    console.log(`⚡ Auto-migration, dedup, social scraping, SSE streaming active`);
  }))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });