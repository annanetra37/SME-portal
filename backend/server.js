import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import pool from './db/pool.js';
import { fileURLToPath } from 'url';
import path from 'path';

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
    CREATE INDEX IF NOT EXISTS idx_smes_country ON smes(country_id);
    CREATE INDEX IF NOT EXISTS idx_websites_sme ON websites(sme_id);
    CREATE INDEX IF NOT EXISTS idx_emails_sme   ON emails(sme_id);
  `);
  // Safe column additions
  for (const sql of [
    `ALTER TABLE smes ADD COLUMN IF NOT EXISTS is_illustrative BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE websites ADD COLUMN IF NOT EXISTS social_content JSONB DEFAULT '{}'`,
    `ALTER TABLE smes ALTER COLUMN contact_email DROP NOT NULL`,
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

// ─── AI helpers ──────────────────────────────────────────────────────────────
async function claude(system, user, maxTokens = 3000) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: maxTokens,
    system, messages: [{ role: 'user', content: user }],
  });
  return r.content[0].text;
}

async function webSearch(query) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: query }],
  });
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
    return r2.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
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

async function runSearchPipeline(countryId, countryName) {
  const TARGET = 15;
  const PARALLEL = 5;
  const TIMEOUT = 4 * 60 * 1000;
  const start = Date.now();
  const inserted = [];

  // ── FIX #2: Load existing names from DB to avoid duplicates ──────────────
  const { rows: existing } = await pool.query(
    'SELECT LOWER(name) as name FROM smes WHERE country_id = $1', [countryId]
  );
  const existingNames = new Set(existing.map(r => r.name));
  log(countryId, `Found ${existingNames.size} existing businesses in DB — will skip duplicates`, 'info');

  // ── Phase 1: Parallel discovery ──────────────────────────────────────────
  log(countryId, `PHASE 1 — Parallel discovery for "${countryName}"`, 'phase');
  const queries = [
    `site:facebook.com "${countryName}" small business shop page handmade`,
    `site:instagram.com "${countryName}" small business shop seller local`,
    `"${countryName}" handmade food shop "facebook.com" OR "instagram.com" no website`,
    `"${countryName}" small business "no website" OR "order via DM" instagram facebook 2024`,
    `"${countryName}" homemade artisan crafts clothing beauty jewelry local seller social media`,
    `"${countryName}" local food producer baker fashion boutique facebook instagram profile`,
  ];
  log(countryId, `Running ${queries.length} search queries in parallel...`);

  const results = await Promise.allSettled(queries.map(q => webSearch(q)));
  const combinedText = results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .join('\n\n===\n\n')
    .slice(0, 22000);

  log(countryId, 'Extracting candidate businesses from search results...');
  const extractRaw = await claude(
    'Return ONLY valid JSON arrays, no markdown.',
    `From these web search results about ${countryName}, extract every distinct small business that appears to operate on Facebook or Instagram WITHOUT its own website.

RESULTS:
${combinedText}

Rules:
- Only include names actually in the text
- Look for facebook.com/PageName or instagram.com/handle patterns
- Skip large chains, government orgs, NGOs
- Do NOT invent names

Return JSON (max 30):
[{"name":"name as found","fbUrl":"full fb url or null","igUrl":"full ig url or null","industryHint":"food/crafts/fashion/beauty/etc","confidence":"high/medium/low"}]
If nothing, return [].`,
    4000
  );

  let candidates = [];
  try { candidates = JSON.parse(extractRaw.replace(/```json\n?|\n?```/g, '').trim()); } catch {}
  if (!Array.isArray(candidates)) candidates = [];

  log(countryId, `Found ${candidates.length} candidates`, candidates.length > 0 ? 'ok' : 'warn');

  // Fallback broader search
  if (candidates.length < 5) {
    log(countryId, 'Too few candidates — running broader fallback search...', 'warn');
    const fbResults = await Promise.allSettled([
      webSearch(`${countryName} small business facebook instagram seller 2024`),
      webSearch(`${countryName} entrepreneur social media shop no website`),
      webSearch(`${countryName} local artisan food clothing beauty online social media`),
    ]);
    const fbText = fbResults.map(r => r.status === 'fulfilled' ? r.value : '').join('\n===\n').slice(0, 12000);
    const fbRaw = await claude('Return ONLY valid JSON arrays.',
      `Extract small business names from ${countryName} in these results:
${fbText}
Return: [{"name":"name","fbUrl":null,"igUrl":null,"industryHint":"guess","confidence":"low"}]
If nothing, return [].`, 2000);
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
      batch.map(c => verifyAndEnrich(c, countryName))
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

  // Fallback illustrative profiles
  if (inserted.length === 0) {
    log(countryId, 'No businesses verified — generating illustrative profiles as fallback', 'warn');
    const profiles = await generateIllustrative(countryName);
    for (const p of profiles) {
      const key = p.name.toLowerCase().trim();
      if (existingNames.has(key)) continue;
      existingNames.add(key);
      try {
        const saved = await insertSme(countryId, p);
        inserted.push(saved);
        sse(countryId, 'sme', saved);
        log(countryId, `  Illustrative: "${p.name}"`, 'sme');
      } catch {}
    }
  }

  const verified = inserted.filter(s => !s.isIllustrative).length;
  const illus = inserted.filter(s => s.isIllustrative).length;
  const elapsed = Math.round((Date.now() - start) / 1000);

  log(countryId, `━━━ COMPLETE in ${elapsed}s ━━━`, 'phase');
  if (verified > 0) log(countryId, `${verified} verified real businesses added`, 'ok');
  if (illus > 0)    log(countryId, `${illus} illustrative profiles added`, 'warn');

  sse(countryId, 'done', { total: inserted.length, verified, illustrative: illus, elapsedSeconds: elapsed });
  return inserted;
}

async function verifyAndEnrich(candidate, countryName) {
  const { name, fbUrl, igUrl, industryHint, confidence } = candidate;
  let searchText = '';

  if (!fbUrl && !igUrl || confidence !== 'high') {
    searchText = await webSearch(
      `"${name}" ${countryName} facebook instagram -site:yellowpages -site:yelp -site:tripadvisor`
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
    2000
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

async function generateIllustrative(countryName) {
  const raw = await claude('Return ONLY valid JSON arrays.',
    `Generate 8 realistic illustrative SME profiles for ${countryName}.
ILLUSTRATIVE only — not verified real businesses. Set isIllustrative=true, all socialMedia URLs to null.
Return JSON array: [{"name":str,"industry":str,"productType":str,"description":str,"location":"City, ${countryName}","foundedYear":null,"employeeCount":"1-5","monthlyRevenue":"$500-$2000","socialMedia":{"facebook":null,"instagram":null,"whatsapp":null},"contactEmail":null,"ownerName":str,"followers":{"facebook":800,"instagram":500},"products":[str,str,str],"priceRange":"$5-$50","tags":[str,str,str],"noWebsiteReason":"Uses Instagram DMs for all orders","opportunityScore":72,"languages":["local","English"],"isIllustrative":true}]`,
    5000);
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSITE BUILDER — scrapes social media content first, then builds rich site
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapeSocialContent(sme) {
  const searches = [];

  if (sme.socialMedia?.facebook) {
    searches.push(webSearch(`site:facebook.com "${sme.name}" products posts about bio ${sme.location}`));
    searches.push(webSearch(`"${sme.name}" facebook "${sme.location}" photos posts products prices`));
  }
  if (sme.socialMedia?.instagram) {
    searches.push(webSearch(`site:instagram.com "${sme.name}" products posts bio ${sme.location}`));
  }
  // General brand search
  searches.push(webSearch(`"${sme.name}" ${sme.location} ${sme.industry} products prices reviews`));

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
    3000
  );

  try {
    return JSON.parse(extracted.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return null;
  }
}

// Dedicated image URL scraper — browses actual social media pages for og:image + CDN URLs
async function scrapeImages(sme) {
  // Browse the actual social media pages directly so Claude can read og:image meta tags
  const fetches = [
    sme.socialMedia?.facebook && webSearch(
      `Visit ${sme.socialMedia.facebook} and extract every image URL from: og:image meta tag, cover photo, profile picture, and any product photos visible on the page. Return only the raw https:// URLs.`
    ),
    sme.socialMedia?.facebook && webSearch(
      `Visit ${sme.socialMedia.facebook}/photos and list all photo image URLs you can see`
    ),
    sme.socialMedia?.instagram && webSearch(
      `Visit ${sme.socialMedia.instagram} and extract the og:image URL, profile picture URL, and any post thumbnail URLs from the page HTML`
    ),
    // Broad filetype search — sometimes returns directly accessible image URLs
    webSearch(`"${sme.name}" ${sme.location} product photo filetype:jpg OR filetype:png`),
  ].filter(Boolean);

  const results = await Promise.allSettled(fetches);
  const rawText = results
    .map(r => r.status === 'fulfilled' ? r.value : '')
    .join('\n\n')
    .slice(0, 16000);

  const extracted = await claude(
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
    800
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

async function buildWebsiteHtml(sme, content, images = []) {
  const c = content || {};
  const fbUrl = sme.socialMedia?.facebook || '';
  const igUrl = sme.socialMedia?.instagram || '';
  const waNum = sme.socialMedia?.whatsapp?.replace(/\D/g, '') || '';
  const primary = c.brandColors?.primary || '#2d6a4f';
  const secondary = c.brandColors?.secondary || '#1b4332';
  const accent = c.brandColors?.accent || '#52b788';

  const heroImg = images[0] || null;
  const productImages = images.slice(1);

  const products = (c.products?.length ? c.products : (sme.products || []).map(p => ({
    name: p, description: `Premium ${p} from ${sme.location}`, price: sme.priceRange, emoji: '✨'
  }))).slice(0, 6);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${sme.name} — ${c.tagline || sme.productType}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --primary: ${primary};
    --secondary: ${secondary};
    --accent: ${accent};
    --text: #1a1a2e;
    --light: #f8f9fa;
    --muted: #6c757d;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { font-family: 'Inter', sans-serif; color: var(--text); background: #fff; }

  /* NAV */
  nav {
    position: fixed; top: 0; width: 100%; z-index: 100;
    background: rgba(255,255,255,0.95); backdrop-filter: blur(10px);
    padding: 16px 40px; display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid rgba(0,0,0,0.08); box-shadow: 0 2px 20px rgba(0,0,0,0.06);
  }
  .nav-brand { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; color: var(--primary); }
  .nav-links { display: flex; gap: 32px; }
  .nav-links a { text-decoration: none; color: var(--muted); font-size: 14px; font-weight: 500; transition: color 0.2s; }
  .nav-links a:hover { color: var(--primary); }
  .nav-cta {
    background: var(--primary); color: #fff; padding: 10px 24px; border-radius: 50px;
    text-decoration: none; font-size: 14px; font-weight: 600; transition: all 0.2s;
  }
  .nav-cta:hover { background: var(--secondary); transform: translateY(-1px); }

  /* HERO */
  .hero {
    min-height: 100vh;
    background: ${heroImg
      ? `url('${heroImg}') center/cover no-repeat`
      : `linear-gradient(135deg, ${secondary} 0%, ${primary} 50%, ${accent} 100%)`};
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 100px 40px 60px; position: relative; overflow: hidden;
  }
  .hero::before {
    content: ''; position: absolute; inset: 0;
    background: ${heroImg
      ? `linear-gradient(135deg, ${secondary}dd 0%, ${primary}bb 60%, ${accent}99 100%)`
      : `radial-gradient(circle at 30% 70%, rgba(255,255,255,0.08) 0%, transparent 60%),
                radial-gradient(circle at 70% 30%, rgba(255,255,255,0.05) 0%, transparent 60%)`};
  }
  .hero-content { position: relative; z-index: 1; max-width: 800px; }
  .hero-badge {
    display: inline-block; background: rgba(255,255,255,0.2); color: #fff;
    padding: 6px 18px; border-radius: 50px; font-size: 13px; font-weight: 500;
    letter-spacing: 1px; text-transform: uppercase; margin-bottom: 24px;
    border: 1px solid rgba(255,255,255,0.3);
  }
  .hero h1 {
    font-family: 'Playfair Display', serif; font-size: clamp(42px, 7vw, 72px);
    font-weight: 700; color: #fff; line-height: 1.15; margin-bottom: 20px;
    text-shadow: 0 2px 20px rgba(0,0,0,0.2);
  }
  .hero-sub { font-size: clamp(16px, 2.5vw, 20px); color: rgba(255,255,255,0.85); max-width: 560px; margin: 0 auto 40px; line-height: 1.7; }
  .hero-ctas { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
  .btn-hero {
    padding: 16px 36px; border-radius: 50px; font-size: 16px; font-weight: 600;
    text-decoration: none; cursor: pointer; border: none; transition: all 0.3s; display: inline-flex; align-items: center; gap: 8px;
  }
  .btn-primary-hero { background: #fff; color: var(--primary); }
  .btn-primary-hero:hover { transform: translateY(-3px); box-shadow: 0 12px 30px rgba(0,0,0,0.2); }
  .btn-outline-hero { background: transparent; color: #fff; border: 2px solid rgba(255,255,255,0.6); }
  .btn-outline-hero:hover { background: rgba(255,255,255,0.15); transform: translateY(-3px); }
  .hero-scroll { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.6); font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .scroll-dot { width: 6px; height: 6px; background: rgba(255,255,255,0.6); border-radius: 50%; animation: bounce 2s infinite; }
  @keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(8px)} }

  /* HIGHLIGHTS */
  .highlights { background: var(--primary); padding: 24px 40px; }
  .hl-grid { display: flex; justify-content: center; gap: 60px; flex-wrap: wrap; }
  .hl-item { text-align: center; color: #fff; }
  .hl-num { font-family: 'Playfair Display', serif; font-size: 32px; font-weight: 700; }
  .hl-label { font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 1px; }

  /* SECTIONS */
  section { padding: 90px 40px; }
  .container { max-width: 1100px; margin: 0 auto; }
  .section-label { font-size: 12px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--primary); margin-bottom: 12px; }
  .section-title { font-family: 'Playfair Display', serif; font-size: clamp(30px, 4vw, 46px); font-weight: 700; line-height: 1.25; margin-bottom: 20px; }
  .section-sub { font-size: 17px; color: var(--muted); max-width: 600px; line-height: 1.75; }
  .section-header { margin-bottom: 56px; }
  .section-header.center { text-align: center; }
  .section-header.center .section-sub { margin: 0 auto; }
  .divider { width: 50px; height: 3px; background: var(--accent); margin: 20px 0; border-radius: 2px; }
  .divider.center { margin: 20px auto; }

  /* ABOUT */
  .about-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 80px; align-items: center; }
  .about-visual {
    background: linear-gradient(135deg, ${primary}22, ${accent}33);
    border-radius: 24px; padding: 60px 40px; text-align: center;
    border: 1px solid ${primary}22;
  }
  .about-emoji { font-size: 80px; display: block; margin-bottom: 20px; }
  .about-visual-title { font-family: 'Playfair Display', serif; font-size: 22px; color: var(--primary); font-weight: 700; }
  .about-text p { font-size: 16px; color: #444; line-height: 1.85; margin-bottom: 18px; }
  .about-usps { display: flex; flex-direction: column; gap: 14px; margin-top: 28px; }
  .usp-item { display: flex; gap: 12px; align-items: flex-start; }
  .usp-icon { width: 28px; height: 28px; background: ${primary}18; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; margin-top: 2px; }
  .usp-text { font-size: 15px; color: #444; line-height: 1.6; }

  /* PRODUCTS */
  .products-bg { background: ${primary}06; }
  .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 28px; }
  .product-card {
    background: #fff; border-radius: 20px; overflow: hidden;
    border: 1px solid rgba(0,0,0,0.07); transition: all 0.3s;
    box-shadow: 0 2px 12px rgba(0,0,0,0.05);
  }
  .product-card:hover { transform: translateY(-6px); box-shadow: 0 16px 40px rgba(0,0,0,0.12); }
  .product-img {
    height: 180px;
    background: linear-gradient(135deg, ${primary}30, ${accent}40);
    display: flex; align-items: center; justify-content: center; font-size: 56px;
  }
  .product-body { padding: 24px; }
  .product-name { font-family: 'Playfair Display', serif; font-size: 19px; font-weight: 600; margin-bottom: 8px; }
  .product-desc { font-size: 14px; color: var(--muted); line-height: 1.65; margin-bottom: 20px; }
  .product-footer { display: flex; justify-content: space-between; align-items: center; }
  .product-price { font-size: 18px; font-weight: 700; color: var(--primary); }
  .btn-order {
    background: var(--primary); color: #fff; border: none; padding: 10px 22px;
    border-radius: 50px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
  }
  .btn-order:hover { background: var(--secondary); transform: translateY(-1px); }

  /* TESTIMONIAL */
  .testimonial-section { background: linear-gradient(135deg, ${secondary}, ${primary}); }
  .testimonial-card { max-width: 720px; margin: 0 auto; text-align: center; }
  .quote-icon { font-size: 60px; opacity: 0.3; color: #fff; line-height: 1; margin-bottom: 16px; }
  .quote-text { font-family: 'Playfair Display', serif; font-size: clamp(20px, 3vw, 28px); color: #fff; line-height: 1.6; font-style: italic; margin-bottom: 28px; }
  .quote-author { color: rgba(255,255,255,0.75); font-size: 15px; font-weight: 500; }

  /* SOCIAL HIGHLIGHTS */
  .highlights-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  .highlight-card {
    background: #fff; border-radius: 16px; padding: 28px 24px;
    border: 1px solid rgba(0,0,0,0.07); box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    transition: all 0.3s;
  }
  .highlight-card:hover { border-color: ${primary}40; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
  .highlight-icon { font-size: 28px; margin-bottom: 14px; }
  .highlight-text { font-size: 15px; color: #444; line-height: 1.65; }

  /* CONTACT */
  .contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; align-items: start; }
  .contact-info { display: flex; flex-direction: column; gap: 24px; }
  .contact-item { display: flex; gap: 16px; align-items: flex-start; }
  .contact-icon { width: 44px; height: 44px; background: ${primary}15; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
  .contact-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 4px; }
  .contact-value { font-size: 15px; font-weight: 500; }
  .contact-value a { color: var(--primary); text-decoration: none; }
  .social-links { display: flex; gap: 14px; margin-top: 8px; }
  .social-btn {
    display: flex; align-items: center; gap: 8px; padding: 12px 20px;
    border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 600; transition: all 0.2s;
  }
  .fb-btn { background: #1877f215; color: #1877f2; border: 1px solid #1877f230; }
  .fb-btn:hover { background: #1877f2; color: #fff; }
  .ig-btn { background: #e1306c15; color: #e1306c; border: 1px solid #e1306c30; }
  .ig-btn:hover { background: #e1306c; color: #fff; }
  .wa-btn { background: #25d36615; color: #25d366; border: 1px solid #25d36630; }
  .wa-btn:hover { background: #25d366; color: #fff; }

  /* ORDER FORM */
  .order-form { background: var(--light); border-radius: 20px; padding: 36px; }
  .order-form h3 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; margin-bottom: 24px; }
  .form-group { margin-bottom: 18px; }
  .form-label { display: block; font-size: 13px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 7px; }
  .form-input, .form-select, .form-textarea {
    width: 100%; padding: 12px 16px; border: 1.5px solid #e0e0e0; border-radius: 10px;
    font-size: 15px; font-family: 'Inter', sans-serif; transition: border-color 0.2s; background: #fff;
  }
  .form-input:focus, .form-select:focus, .form-textarea:focus { outline: none; border-color: var(--primary); }
  .form-textarea { resize: vertical; min-height: 90px; }
  .btn-submit {
    width: 100%; background: var(--primary); color: #fff; padding: 15px; border: none;
    border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s;
    font-family: 'Inter', sans-serif;
  }
  .btn-submit:hover { background: var(--secondary); }
  .success-msg { display: none; text-align: center; padding: 30px; }
  .success-msg.show { display: block; }
  .success-icon { font-size: 48px; margin-bottom: 12px; }
  .success-msg h4 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  .success-msg p { color: var(--muted); }

  /* FOOTER */
  footer { background: ${secondary}; color: rgba(255,255,255,0.8); padding: 48px 40px; text-align: center; }
  .footer-brand { font-family: 'Playfair Display', serif; font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 12px; }
  .footer-sub { font-size: 14px; margin-bottom: 24px; }
  .footer-links { display: flex; justify-content: center; gap: 24px; margin-bottom: 28px; }
  .footer-links a { color: rgba(255,255,255,0.7); text-decoration: none; font-size: 13px; transition: color 0.2s; }
  .footer-links a:hover { color: #fff; }
  .footer-copy { font-size: 12px; opacity: 0.5; }

  /* WHATSAPP FLOAT */
  .wa-float {
    position: fixed; bottom: 28px; right: 28px; z-index: 999;
    background: #25d366; color: #fff; width: 58px; height: 58px;
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 28px; text-decoration: none; box-shadow: 0 4px 20px rgba(37,211,102,0.4);
    transition: all 0.3s;
  }
  .wa-float:hover { transform: scale(1.12); box-shadow: 0 8px 30px rgba(37,211,102,0.5); }

  /* RESPONSIVE */
  @media (max-width: 768px) {
    nav { padding: 14px 20px; }
    .nav-links { display: none; }
    section { padding: 60px 20px; }
    .about-grid, .contact-grid { grid-template-columns: 1fr; gap: 40px; }
    .highlights-grid { grid-template-columns: 1fr; }
    .hl-grid { gap: 30px; }
  }
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="nav-brand">${sme.name}</div>
  <div class="nav-links">
    <a href="#about">About</a>
    <a href="#products">Products</a>
    <a href="#contact">Contact</a>
  </div>
  <a href="#contact" class="nav-cta">Order Now</a>
</nav>

<!-- HERO -->
<section class="hero">
  <div class="hero-content">
    <div class="hero-badge">📍 ${sme.location}</div>
    <h1>${c.heroHeadline || sme.name}</h1>
    <p class="hero-sub">${c.tagline || sme.productType}</p>
    <div class="hero-ctas">
      <a href="#products" class="btn-hero btn-primary-hero">🛒 Shop Now</a>
      <a href="#contact" class="btn-hero btn-outline-hero">💬 Get in Touch</a>
    </div>
  </div>
  <div class="hero-scroll">
    <span>Scroll to explore</span>
    <div class="scroll-dot"></div>
  </div>
</section>

<!-- HIGHLIGHTS BAR -->
<div class="highlights">
  <div class="hl-grid">
    <div class="hl-item">
      <div class="hl-num">${sme.followers?.facebook ? Math.round((sme.followers.facebook || 0) / 100) * 100 + '+' : '500+'}</div>
      <div class="hl-label">Facebook Followers</div>
    </div>
    <div class="hl-item">
      <div class="hl-num">${sme.followers?.instagram ? Math.round((sme.followers.instagram || 0) / 100) * 100 + '+' : '300+'}</div>
      <div class="hl-label">Instagram Followers</div>
    </div>
    <div class="hl-item">
      <div class="hl-num">${products.length}+</div>
      <div class="hl-label">Products Available</div>
    </div>
    <div class="hl-item">
      <div class="hl-num">${sme.foundedYear ? new Date().getFullYear() - sme.foundedYear + '+' : '3+'}</div>
      <div class="hl-label">Years in Business</div>
    </div>
  </div>
</div>

<!-- ABOUT -->
<section id="about">
  <div class="container">
    <div class="about-grid">
      <div class="about-visual" ${heroImg ? 'style="padding:0;background:none;border:none;overflow:hidden"' : ''}>
        ${heroImg
          ? `<img src="${heroImg}" alt="${sme.name}" style="width:100%;min-height:320px;object-fit:cover;border-radius:24px;display:block;">`
          : `<span class="about-emoji">${sme.industry?.includes('Food') ? '🍽️' : sme.industry?.includes('Fashion') ? '👗' : sme.industry?.includes('Beauty') ? '💄' : sme.industry?.includes('Craft') ? '🎨' : sme.industry?.includes('Jewelry') ? '💍' : '🏪'}</span>
        <div class="about-visual-title">${sme.name}</div>
        <p style="color:#666;margin-top:8px;font-size:14px">${sme.location}</p>`}
      </div>
      <div class="about-text">
        <div class="section-label">Our Story</div>
        <h2 class="section-title">Crafted with Passion,<br>Delivered with Care</h2>
        <div class="divider"></div>
        ${(c.aboutText || sme.description || '').split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('')}
        <div class="about-usps">
          ${(c.uniqueSellingPoints || ['Quality you can trust', 'Locally made with love', 'Fast delivery available']).map(usp => `
            <div class="usp-item">
              <div class="usp-icon">✓</div>
              <div class="usp-text">${usp}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  </div>
</section>

<!-- PRODUCTS -->
<section id="products" class="products-bg">
  <div class="container">
    <div class="section-header center">
      <div class="section-label">Our Collection</div>
      <h2 class="section-title">Our Products</h2>
      <div class="divider center"></div>
      <p class="section-sub">Handpicked quality — each item made with care. Order directly via the form below or reach out on social media.</p>
    </div>
    <div class="products-grid">
      ${products.map((p, i) => `
        <div class="product-card">
          ${productImages[i]
            ? `<img src="${productImages[i]}" alt="${p.name}" style="width:100%;height:180px;object-fit:cover;">`
            : `<div class="product-img">${p.emoji || '✨'}</div>`
          }
          <div class="product-body">
            <div class="product-name">${p.name}</div>
            <div class="product-desc">${p.description}</div>
            <div class="product-footer">
              <div class="product-price">${p.price || sme.priceRange}</div>
              <button class="btn-order" onclick="openOrder('${p.name}')">Order</button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>
</section>

<!-- TESTIMONIAL -->
<section class="testimonial-section">
  <div class="container">
    <div class="testimonial-card">
      <div class="quote-icon">"</div>
      <p class="quote-text">${c.testimonialQuote || `The quality is absolutely incredible. I've been ordering from ${sme.name} for years and they never disappoint.`}</p>
      <p class="quote-author">— ${c.testimonialAuthor || 'Happy Customer'}</p>
    </div>
  </div>
</section>

<!-- HIGHLIGHTS FROM SOCIAL -->
${c.socialPostHighlights?.length ? `
<section>
  <div class="container">
    <div class="section-header center">
      <div class="section-label">From Our Community</div>
      <h2 class="section-title">What We're Known For</h2>
      <div class="divider center"></div>
    </div>
    <div class="highlights-grid">
      ${c.socialPostHighlights.slice(0, 3).map((h, i) => `
        <div class="highlight-card">
          <div class="highlight-icon">${['⭐', '🌿', '💝'][i] || '✨'}</div>
          <div class="highlight-text">${h}</div>
        </div>
      `).join('')}
    </div>
  </div>
</section>
` : ''}

<!-- PHOTO GALLERY -->
${images.length >= 2 ? `
<section style="padding:70px 40px;background:#fff">
  <div class="container">
    <div class="section-header center">
      <div class="section-label">Photo Gallery</div>
      <h2 class="section-title">Our Products & Story</h2>
      <div class="divider center"></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:12px">
      ${images.map((img, i) => `
        <div style="border-radius:16px;overflow:hidden;aspect-ratio:1;box-shadow:0 4px 16px rgba(0,0,0,0.1);background:#f0f0f0">
          <img src="${img}" alt="${sme.name} photo ${i + 1}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">
        </div>
      `).join('')}
    </div>
  </div>
</section>
` : ''}

<!-- CONTACT + ORDER -->
<section id="contact" style="background:#f8f9fa">
  <div class="container">
    <div class="contact-grid">
      <div>
        <div class="section-label">Get In Touch</div>
        <h2 class="section-title">Place Your Order</h2>
        <div class="divider"></div>
        <p style="color:var(--muted);font-size:16px;line-height:1.75;margin-bottom:32px">
          Ready to order? Fill out the form or reach us directly on social media. We respond within 24 hours.
        </p>
        <div class="contact-info">
          ${sme.location ? `
            <div class="contact-item">
              <div class="contact-icon">📍</div>
              <div><div class="contact-label">Location</div><div class="contact-value">${sme.location}</div></div>
            </div>
          ` : ''}
          ${c.openingHours ? `
            <div class="contact-item">
              <div class="contact-icon">🕐</div>
              <div><div class="contact-label">Hours</div><div class="contact-value">${c.openingHours}</div></div>
            </div>
          ` : ''}
          ${c.contactPhone || sme.socialMedia?.whatsapp ? `
            <div class="contact-item">
              <div class="contact-icon">📞</div>
              <div><div class="contact-label">Phone / WhatsApp</div><div class="contact-value">${c.contactPhone || sme.socialMedia.whatsapp}</div></div>
            </div>
          ` : ''}
        </div>
        <div class="social-links" style="margin-top:28px">
          ${fbUrl ? `<a href="${fbUrl}" target="_blank" class="social-btn fb-btn">📘 Facebook</a>` : ''}
          ${igUrl ? `<a href="${igUrl}" target="_blank" class="social-btn ig-btn">📸 Instagram</a>` : ''}
          ${waNum ? `<a href="https://wa.me/${waNum}" target="_blank" class="social-btn wa-btn">💬 WhatsApp</a>` : ''}
        </div>
      </div>
      <div class="order-form" id="orderFormSection">
        <h3>Place an Order</h3>
        <div id="orderFormWrap">
          <div class="form-group">
            <label class="form-label">Your Name *</label>
            <input type="text" class="form-input" id="f-name" placeholder="Full name" required>
          </div>
          <div class="form-group">
            <label class="form-label">Phone / WhatsApp *</label>
            <input type="tel" class="form-input" id="f-phone" placeholder="+xxx xxx xxx xxx" required>
          </div>
          <div class="form-group">
            <label class="form-label">Product</label>
            <select class="form-select" id="f-product">
              <option value="">Select a product...</option>
              ${products.map(p => `<option value="${p.name}">${p.name} — ${p.price || sme.priceRange}</option>`).join('')}
              <option value="other">Other / Multiple items</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Quantity</label>
            <input type="number" class="form-input" id="f-qty" value="1" min="1">
          </div>
          <div class="form-group">
            <label class="form-label">Message / Notes</label>
            <textarea class="form-textarea" id="f-msg" placeholder="Any special requests or questions..."></textarea>
          </div>
          <button class="btn-submit" onclick="submitOrder()">✉️ Send Order Request</button>
        </div>
        <div class="success-msg" id="successMsg">
          <div class="success-icon">🎉</div>
          <h4>Order Received!</h4>
          <p>Thank you! We'll contact you within 24 hours to confirm your order and arrange delivery.</p>
          ${waNum ? `<a href="https://wa.me/${waNum}" target="_blank" style="display:inline-block;margin-top:16px;background:#25d366;color:#fff;padding:12px 24px;border-radius:50px;text-decoration:none;font-weight:600">💬 Chat on WhatsApp</a>` : ''}
        </div>
      </div>
    </div>
  </div>
</section>

<!-- FOOTER -->
<footer>
  <div class="footer-brand">${sme.name}</div>
  <p class="footer-sub">${c.tagline || sme.productType} · ${sme.location}</p>
  <div class="footer-links">
    <a href="#about">About</a>
    <a href="#products">Products</a>
    <a href="#contact">Order</a>
    ${fbUrl ? `<a href="${fbUrl}" target="_blank">Facebook</a>` : ''}
    ${igUrl ? `<a href="${igUrl}" target="_blank">Instagram</a>` : ''}
  </div>
  <p class="footer-copy">© ${new Date().getFullYear()} ${sme.name} · All rights reserved</p>
</footer>

${waNum ? `<a href="https://wa.me/${waNum}" class="wa-float" target="_blank" title="Chat on WhatsApp">💬</a>` : ''}

<script>
  function openOrder(productName) {
    document.getElementById('f-product').value = productName;
    document.getElementById('orderFormSection').scrollIntoView({ behavior: 'smooth' });
  }
  function submitOrder() {
    const name = document.getElementById('f-name').value.trim();
    const phone = document.getElementById('f-phone').value.trim();
    if (!name || !phone) { alert('Please enter your name and phone number.'); return; }
    document.getElementById('orderFormWrap').style.display = 'none';
    document.getElementById('successMsg').classList.add('show');
    ${waNum ? `
    const product = document.getElementById('f-product').value;
    const qty = document.getElementById('f-qty').value;
    const msg = document.getElementById('f-msg').value;
    const waMsg = encodeURIComponent('Hi! I want to order from ${sme.name}.\\nName: ' + name + '\\nPhone: ' + phone + '\\nProduct: ' + (product || 'See message') + '\\nQty: ' + qty + (msg ? '\\nNote: ' + msg : ''));
    window.open('https://wa.me/${waNum}?text=' + waMsg, '_blank');
    ` : ''}
  }
  // Smooth nav highlight on scroll
  const sections = document.querySelectorAll('section[id]');
  window.addEventListener('scroll', () => {
    const pos = window.scrollY + 80;
    sections.forEach(s => {
      const link = document.querySelector('.nav-links a[href="#' + s.id + '"]');
      if (!link) return;
      link.style.color = (pos >= s.offsetTop && pos < s.offsetTop + s.offsetHeight) ? 'var(--primary)' : '';
    });
  });
</script>
</body>
</html>`;

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
  runSearchPipeline(req.params.id, rows[0].name).catch(err => {
    console.error('Pipeline error:', err);
    sse(req.params.id, 'error', { message: err.message });
  });
});

// ── WEBSITE BUILDER — scrapes social, then builds rich site ──────────────────
app.post('/api/smes/:id/build-website', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = normalizeSme(rows[0]);

  try {
    console.log(`🌐 Building website for "${sme.name}" — scraping social content first...`);

    // Step 1: Scrape social media content + extract image URLs
    const content = await scrapeSocialContent(sme);
    console.log(`  ✅ Social content scraped for "${sme.name}"`);

    // Step 2: Collect image URLs (from content extraction + dedicated image search) then download
    const rawImageUrls = [...new Set([
      ...(content?.realImages || []).filter(u => typeof u === 'string' && u.startsWith('https://')),
      ...await scrapeImages(sme),
    ])];
    const realImages = await downloadImages(rawImageUrls);
    console.log(`  📷 ${realImages.length}/${rawImageUrls.length} real images downloaded for "${sme.name}"`);

    // Step 2b: Supplement with topic-matched stock photos when real images are scarce
    const needed = Math.max(0, 6 - realImages.length);
    const stockImages = needed > 0 ? await downloadImages(getStockImageUrls(sme, needed + 2)) : [];
    const images = [...realImages, ...stockImages].slice(0, 8);
    console.log(`  🖼️  ${images.length} total images (${realImages.length} real + ${stockImages.length} stock) for "${sme.name}"`);

    // Step 3: Build full HTML with scraped content + real images
    const html = await buildWebsiteHtml(sme, content, images);
    console.log(`  ✅ HTML built (${Math.round(html.length / 1024)}kb)`);

    await pool.query(
      `INSERT INTO websites (sme_id, html, social_content) VALUES ($1,$2,$3)
       ON CONFLICT (sme_id) DO UPDATE SET html=$2, social_content=$3, built_at=NOW()`,
      [sme.id, html, JSON.stringify(content || {})]
    );
    await pool.query(`UPDATE smes SET status='website_built' WHERE id=$1`, [sme.id]);
    res.json({ ok: true, contentScraped: !!content });
  } catch (e) {
    console.error('Website builder error:', e);
    res.status(500).json({ error: e.message });
  }
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
    const raw = await claude(
      'World-class B2B copywriter. Return ONLY valid JSON {"subject":"...","body":"..."}.',
      `Write a personalized warm outreach email (max 220 words):
Business: ${sme.name} | Owner: ${sme.ownerName} | Industry: ${sme.industry}
Products: ${(sme.products || []).join(', ')} | Location: ${sme.location}
Active on: ${Object.entries(sme.socialMedia || {}).filter(([, v]) => v).map(([k]) => k).join(', ')}
Website we built: ${url} | Followers: FB ${sme.followers?.facebook || 0} / IG ${sme.followers?.instagram || 0}
Offer: Free website (${url}). Option A: 10% per sale, website free. Option B: monthly fee.
Requirements: curiosity subject, reference specific products, mention the no-website gap, include live link, warm tone.`,
      2000
    );
    const email = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    await pool.query(
      `INSERT INTO emails (sme_id,subject,body) VALUES ($1,$2,$3) ON CONFLICT (sme_id) DO UPDATE SET subject=$2,body=$3,created_at=NOW()`,
      [sme.id, email.subject, email.body]
    );
    await pool.query(`UPDATE smes SET status='email_ready' WHERE id=$1`, [sme.id]);
    res.json(email);
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

// Boot
const PORT = process.env.PORT || 3001;
ensureSchema()
  .then(() => app.listen(PORT, () => {
    console.log(`✅ WebLaunch v2.3 → http://localhost:${PORT}`);
    console.log(`⚡ Auto-migration, dedup, social scraping, SSE streaming active`);
  }))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });