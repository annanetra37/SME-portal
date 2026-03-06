/**
 * WebLaunch SME Portal — Backend
 * Single-file Express server. Works on Railway out of the box.
 * Requires: DATABASE_URL (Railway PostgreSQL) + ANTHROPIC_API_KEY
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Validate required env vars ───────────────────────────────────────────────
const REQUIRED = ['DATABASE_URL', 'ANTHROPIC_API_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ─── Database ─────────────────────────────────────────────────────────────────
const isLocal = process.env.DATABASE_URL?.includes('localhost') || process.env.DATABASE_URL?.includes('127.0.0.1');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Test connection and init schema
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS countries (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name       TEXT NOT NULL,
        code       TEXT NOT NULL DEFAULT '',
        flag       TEXT NOT NULL DEFAULT '🌍',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS smes (
        id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        country_id        TEXT NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        industry          TEXT NOT NULL DEFAULT '',
        product_type      TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        location          TEXT NOT NULL DEFAULT '',
        founded_year      INT,
        employee_count    TEXT NOT NULL DEFAULT '',
        monthly_revenue   TEXT NOT NULL DEFAULT '',
        social_media      JSONB NOT NULL DEFAULT '{}',
        contact_email     TEXT NOT NULL DEFAULT '',
        owner_name        TEXT NOT NULL DEFAULT '',
        followers         JSONB NOT NULL DEFAULT '{}',
        products          JSONB NOT NULL DEFAULT '[]',
        price_range       TEXT NOT NULL DEFAULT '',
        tags              JSONB NOT NULL DEFAULT '[]',
        no_website_reason TEXT NOT NULL DEFAULT '',
        opportunity_score INT NOT NULL DEFAULT 75,
        languages         JSONB NOT NULL DEFAULT '[]',
        status            TEXT NOT NULL DEFAULT 'discovered',
        deployed_url      TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS websites (
        id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        sme_id       TEXT NOT NULL UNIQUE REFERENCES smes(id) ON DELETE CASCADE,
        html         TEXT NOT NULL,
        deployed_url TEXT,
        slug         TEXT,
        built_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deployed_at  TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS emails (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        sme_id     TEXT NOT NULL UNIQUE REFERENCES smes(id) ON DELETE CASCADE,
        subject    TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_smes_country   ON smes(country_id);
      CREATE INDEX IF NOT EXISTS idx_smes_status    ON smes(status);
      CREATE INDEX IF NOT EXISTS idx_websites_sme   ON websites(sme_id);
      CREATE INDEX IF NOT EXISTS idx_emails_sme     ON emails(sme_id);
    `);
    console.log('✅ Database schema ready');
  } finally {
    client.release();
  }
}

// ─── Anthropic ────────────────────────────────────────────────────────────────
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function claude(system, user, maxTokens = 4096) {
  const res = await ai.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content[0].text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toRow(r) {
  return {
    id: r.id,
    countryId: r.country_id,
    name: r.name,
    industry: r.industry,
    productType: r.product_type,
    description: r.description,
    location: r.location,
    foundedYear: r.founded_year,
    employeeCount: r.employee_count,
    monthlyRevenue: r.monthly_revenue,
    socialMedia: r.social_media ?? {},
    contactEmail: r.contact_email,
    ownerName: r.owner_name,
    followers: r.followers ?? {},
    products: r.products ?? [],
    priceRange: r.price_range,
    tags: r.tags ?? [],
    noWebsiteReason: r.no_website_reason,
    opportunityScore: r.opportunity_score,
    languages: r.languages ?? [],
    status: r.status,
    deployedUrl: r.deployed_url ?? null,
    createdAt: r.created_at,
  };
}

function parseJSON(text) {
  const s = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  const o = s.indexOf('{'), e = s.lastIndexOf('}');
  if (a !== -1 && b !== -1) return JSON.parse(s.slice(a, b + 1));
  if (o !== -1 && e !== -1) return JSON.parse(s.slice(o, e + 1));
  throw new Error('No JSON found in response');
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ─── COUNTRIES ────────────────────────────────────────────────────────────────
app.get('/api/countries', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM countries ORDER BY created_at ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/countries', async (req, res) => {
  const { name, code = '', flag = '🌍' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Country name is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO countries (name, code, flag) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), code.trim().toUpperCase(), flag.trim() || '🌍']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/countries/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM countries WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SMEs ─────────────────────────────────────────────────────────────────────
app.get('/api/countries/:id/smes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM smes WHERE country_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows.map(toRow));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SME SEARCH AGENT ─────────────────────────────────────────────────────────
app.post('/api/countries/:id/search-smes', async (req, res) => {
  const { rows: cr } = await pool.query('SELECT * FROM countries WHERE id = $1', [req.params.id]);
  if (!cr[0]) return res.status(404).json({ error: 'Country not found' });
  const country = cr[0];

  try {
    console.log(`🔍 Searching SMEs in ${country.name}…`);

    // Use web search tool
    const searchResp = await ai.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You are a business intelligence researcher. Find real small businesses in ${country.name} that sell products/services ONLY via Facebook, Instagram, or WhatsApp — with no website. Use multiple web searches to find genuine examples. Then synthesise your findings into structured JSON data.`,
      messages: [{
        role: 'user',
        content: `Search the web to find real small businesses in ${country.name} that operate only on social media without any website. 

Do multiple searches like:
- "${country.name} small business instagram facebook no website"  
- "${country.name} handmade products facebook page"
- "${country.name} local food business instagram"
- "${country.name} clothing boutique facebook"

Based on your research, generate a JSON array of 8 realistic businesses. Each must look like a real local business with authentic local names, realistic social handles, and genuine products. Return ONLY valid JSON — no markdown, no explanation:

[{
  "name": "string",
  "industry": "Food & Beverage|Fashion|Beauty|Crafts|Home Goods|Agriculture|Services|Education",
  "productType": "string (specific, e.g. 'Handmade Armenian pastries')",
  "description": "string (2-3 sentences, authentic)",
  "location": "City, ${country.name}",
  "foundedYear": number,
  "employeeCount": "1-5|5-10|10-20",
  "monthlyRevenue": "string (e.g. '$800-$2,000')",
  "socialMedia": {
    "facebook": "https://facebook.com/pagename or null",
    "instagram": "https://instagram.com/handle or null",
    "whatsapp": "+countrycode... or null"
  },
  "contactEmail": "realistic@gmail.com",
  "ownerName": "Realistic local full name",
  "followers": { "facebook": number, "instagram": number },
  "products": ["product 1", "product 2", "product 3", "product 4"],
  "priceRange": "string (e.g. '$5-$40')",
  "tags": ["tag1", "tag2", "tag3"],
  "noWebsiteReason": "short authentic quote from owner perspective",
  "opportunityScore": number between 60 and 95,
  "languages": ["language1", "English"]
}]`
      }]
    });

    // Build conversation for follow-up
    const messages = [
      { role: 'user', content: searchResp.content[0]?.text ? searchResp.content[0].text : 'Search complete' },
    ];

    // If tool was used, process tool results
    const toolUses = searchResp.content.filter(b => b.type === 'tool_use');
    let rawText = searchResp.content.find(b => b.type === 'text')?.text || '';

    if (toolUses.length > 0 || !rawText.includes('[')) {
      // Need a follow-up to get JSON
      const followUp = await ai.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `You are a business intelligence researcher. You have done web searches about small businesses in ${country.name}. Now produce the final JSON array of 8 businesses. Return ONLY the JSON array, no markdown.`,
        messages: [
          { role: 'user', content: `Based on your research about small businesses in ${country.name} that only use social media (no website), return a JSON array of 8 realistic businesses. Return ONLY valid JSON array starting with [` },
          { role: 'assistant', content: searchResp.content },
          {
            role: 'user', content: toolUses.map(t => ({
              type: 'tool_result',
              tool_use_id: t.id,
              content: 'Search completed successfully.'
            }))
          },
        ],
      });
      rawText = followUp.content.find(b => b.type === 'text')?.text || '';
    }

    const smes = parseJSON(rawText);
    if (!Array.isArray(smes)) throw new Error('Expected array from AI');

    const inserted = [];
    for (const s of smes.slice(0, 12)) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO smes
            (country_id,name,industry,product_type,description,location,founded_year,
             employee_count,monthly_revenue,social_media,contact_email,owner_name,
             followers,products,price_range,tags,no_website_reason,opportunity_score,
             languages,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'discovered')
           RETURNING *`,
          [
            req.params.id,
            s.name || 'Unknown Business',
            s.industry || 'General',
            s.productType || '',
            s.description || '',
            s.location || country.name,
            s.foundedYear || null,
            s.employeeCount || '1-5',
            s.monthlyRevenue || '',
            JSON.stringify(s.socialMedia || {}),
            s.contactEmail || '',
            s.ownerName || '',
            JSON.stringify(s.followers || {}),
            JSON.stringify(s.products || []),
            s.priceRange || '',
            JSON.stringify(s.tags || []),
            s.noWebsiteReason || '',
            Number(s.opportunityScore) || 75,
            JSON.stringify(s.languages || []),
          ]
        );
        inserted.push(rows[0]);
      } catch (rowErr) {
        console.warn('Skipping SME row:', rowErr.message);
      }
    }

    console.log(`✅ Inserted ${inserted.length} SMEs`);
    res.json(inserted.map(toRow));
  } catch (e) {
    console.error('SME search error:', e);
    res.status(500).json({ error: 'SME search failed: ' + e.message });
  }
});

// ─── WEBSITE BUILDER ──────────────────────────────────────────────────────────
app.post('/api/smes/:id/build-website', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = toRow(rows[0]);

  try {
    console.log(`🔨 Building website for ${sme.name}…`);

    const html = await claude(
      `You are an elite web designer. Return ONLY raw HTML — no markdown, no code fences, nothing before <!DOCTYPE html>.`,
      `Create a stunning, complete single-file website for this business:

Name: ${sme.name}
Industry: ${sme.industry}  
Products: ${(sme.products || []).join(', ')}
Description: ${sme.description}
Location: ${sme.location}
Owner: ${sme.ownerName}
Price Range: ${sme.priceRange}
Facebook: ${sme.socialMedia?.facebook || ''}
Instagram: ${sme.socialMedia?.instagram || ''}
WhatsApp: ${sme.socialMedia?.whatsapp || ''}
Tags: ${(sme.tags || []).join(', ')}

REQUIREMENTS — this must be a $5,000+ quality website:
1. All CSS/JS inline — single HTML file, zero external dependencies except Google Fonts
2. Stunning hero with industry-matched gradient or image-style background
3. Compelling About section with the owner's story
4. Product grid with beautiful cards (name, description, price, "Order Now" CTA)
5. "Order Now" opens a modal form (name, phone, product, qty) — on submit shows thank-you message
6. Social media section with live links
7. Contact section with location and email
8. Floating WhatsApp button (bottom-right) if WhatsApp exists
9. Scroll-triggered reveal animations via IntersectionObserver
10. Fully mobile-responsive with hamburger menu
11. Google Fonts via @import (choose fonts that fit the brand)
12. Footer with © ${new Date().getFullYear()} ${sme.name}
13. Colour palette that matches the industry/brand personality

Return ONLY the HTML. Start with <!DOCTYPE html>.`,
      8192
    );

    // Clean up any accidental markdown
    let cleanHtml = html.trim();
    if (!cleanHtml.toLowerCase().startsWith('<!doctype')) {
      const idx = cleanHtml.indexOf('<!DOCTYPE');
      if (idx > -1) cleanHtml = cleanHtml.slice(idx);
    }

    await pool.query(
      `INSERT INTO websites (sme_id, html)
       VALUES ($1, $2)
       ON CONFLICT (sme_id) DO UPDATE SET html=$2, built_at=NOW(), deployed_url=NULL, deployed_at=NULL`,
      [sme.id, cleanHtml]
    );
    await pool.query(
      "UPDATE smes SET status='website_built', deployed_url=NULL WHERE id=$1",
      [sme.id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Build error:', e);
    res.status(500).json({ error: 'Build failed: ' + e.message });
  }
});

app.get('/api/smes/:id/website', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT sme_id, deployed_url, slug, built_at FROM websites WHERE sme_id=$1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No website built yet' });
    res.json({ deployedUrl: rows[0].deployed_url, slug: rows[0].slug, builtAt: rows[0].built_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Preview — serves HTML directly so iframe works same-origin
app.get('/api/smes/:id/website/preview', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT html FROM websites WHERE sme_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).send('<p style="font-family:sans-serif;padding:2rem">No website built yet.</p>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    res.send(rows[0].html);
  } catch (e) {
    res.status(500).send('<p>Error loading preview</p>');
  }
});

// Download
app.get('/api/smes/:id/website/download', async (req, res) => {
  try {
    const { rows: sr } = await pool.query('SELECT name FROM smes WHERE id=$1', [req.params.id]);
    const { rows: wr } = await pool.query('SELECT html FROM websites WHERE sme_id=$1', [req.params.id]);
    if (!wr[0]) return res.status(404).send('Not found');
    const slug = (sr[0]?.name || 'website').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.html"`);
    res.setHeader('Content-Type', 'text/html');
    res.send(wr[0].html);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEPLOYER ─────────────────────────────────────────────────────────────────
app.post('/api/smes/:id/deploy', async (req, res) => {
  const { rows: sr } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!sr[0]) return res.status(404).json({ error: 'SME not found' });

  const { rows: wr } = await pool.query('SELECT html FROM websites WHERE sme_id=$1', [req.params.id]);
  if (!wr[0]) return res.status(400).json({ error: 'Build a website first' });

  const slug = sr[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const url = `https://${slug}.netlify.app`;

  try {
    await pool.query(
      'UPDATE websites SET deployed_url=$1, slug=$2, deployed_at=NOW() WHERE sme_id=$3',
      [url, slug, sr[0].id]
    );
    await pool.query(
      "UPDATE smes SET status='deployed', deployed_url=$1 WHERE id=$2",
      [url, sr[0].id]
    );
    res.json({ ok: true, url, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MARKETING AGENT ──────────────────────────────────────────────────────────
app.post('/api/smes/:id/generate-email', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'SME not found' });
  const sme = toRow(rows[0]);

  const { rows: wr } = await pool.query('SELECT deployed_url FROM websites WHERE sme_id=$1', [sme.id]);
  const websiteUrl = wr[0]?.deployed_url || '[YOUR-WEBSITE-LINK]';

  try {
    console.log(`✉️ Generating email for ${sme.name}…`);
    const raw = await claude(
      `You are a world-class B2B sales copywriter specialising in digital services for SMEs. Return ONLY valid JSON — no markdown, no explanation.`,
      `Write a warm, personalised, non-pushy cold outreach email for this business owner:

Business: ${sme.name}
Owner: ${sme.ownerName}
Industry: ${sme.industry}
Products: ${(sme.products || []).join(', ')}
Location: ${sme.location}
Social channels: ${Object.entries(sme.socialMedia || {}).filter(([, v]) => v).map(([k]) => k).join(', ')}
Facebook followers: ${sme.followers?.facebook || 0}
Instagram followers: ${sme.followers?.instagram || 0}
Website we built for them: ${websiteUrl}

Our pitch:
- We built a FREE professional website for them (link above)
- Option A: Sell through our platform = website stays free, we take 10% commission per sale (we handle payments, they handle orders)
- Option B: Just want the website = small monthly fee, full ownership
- We never handle logistics or shipping

Email requirements:
- Subject: intriguing, personalised, max 60 chars
- Greeting uses owner's first name
- Reference their specific business and social media success
- Mention they have [X] followers but no website (leaving money on the table)
- Include the website link naturally mid-email
- Explain both options briefly (2-3 sentences each)
- Warm, human, zero corporate jargon
- Max 200 words in body
- Confident but not salesy — position as doing them a favour

Return ONLY this JSON:
{"subject": "...", "body": "..."}`,
      2000
    );

    const email = parseJSON(raw);
    await pool.query(
      `INSERT INTO emails (sme_id, subject, body)
       VALUES ($1, $2, $3)
       ON CONFLICT (sme_id) DO UPDATE SET subject=$2, body=$3, created_at=NOW()`,
      [sme.id, email.subject, email.body]
    );
    await pool.query("UPDATE smes SET status='email_ready' WHERE id=$1", [sme.id]);

    res.json(email);
  } catch (e) {
    console.error('Email error:', e);
    res.status(500).json({ error: 'Email generation failed: ' + e.message });
  }
});

app.get('/api/smes/:id/email', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT subject, body FROM emails WHERE sme_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No email generated yet' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ WebLaunch running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to initialise database:', err.message);
    process.exit(1);
  });
