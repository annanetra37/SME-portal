import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import pool from './db/pool.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt, maxTokens = 4096) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return response.content[0].text;
}

// SME search using Claude with web_search tool to find REAL businesses
async function searchSMEsWithWebSearch(countryName) {
  // Step 1: Use web_search tool to gather real data
  const searchResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: `You are a business researcher finding real small businesses in ${countryName} that operate only on Facebook/Instagram (no website). Use web search to find actual businesses, then extract structured data. Return ONLY a valid JSON array at the end.`,
    messages: [{
      role: 'user',
      content: `Search for real small businesses in ${countryName} that operate only on social media (Facebook, Instagram) without a website. 

Search for:
1. "${countryName} small business facebook page handmade"
2. "${countryName} local shop instagram seller"
3. "${countryName} homemade food clothing crafts facebook"
4. "site:facebook.com ${countryName} small business"

Find 8-10 real or highly realistic businesses based on what you discover. Then return ONLY this JSON array (no markdown, no explanation):

[
  {
    "name": "Business name",
    "industry": "Food & Beverage | Fashion | Beauty | Crafts | Education | Home Goods | Agriculture | Services",
    "productType": "specific product description",
    "description": "2-3 realistic sentences about this business",
    "location": "City, ${countryName}",
    "foundedYear": 2019,
    "employeeCount": "1-5",
    "monthlyRevenue": "$500-$2000",
    "socialMedia": {
      "facebook": "https://facebook.com/pagename",
      "instagram": "https://instagram.com/handle",
      "whatsapp": "+1234567890"
    },
    "contactEmail": "owner@gmail.com",
    "ownerName": "Realistic local name",
    "followers": { "facebook": 1500, "instagram": 900 },
    "products": ["product 1", "product 2", "product 3"],
    "priceRange": "$5-$40",
    "tags": ["handmade", "local"],
    "noWebsiteReason": "Short realistic reason",
    "opportunityScore": 82,
    "languages": ["local language", "English"]
  }
]`
    }]
  });

  // Build conversation history for follow-up
  const messages = [
    {
      role: 'user',
      content: `Search for real small businesses in ${countryName} that operate only on social media (Facebook, Instagram) without a website. Search for: "${countryName} small business facebook page handmade", "${countryName} local shop instagram seller", "${countryName} homemade food clothing crafts facebook". Find 8-10 businesses then return ONLY a JSON array.`
    },
    { role: 'assistant', content: searchResponse.content }
  ];

  // Check if we got tool use — if so, provide results and get final answer
  const hasToolUse = searchResponse.content.some(b => b.type === 'tool_use');
  const textBlock = searchResponse.content.find(b => b.type === 'text');

  if (hasToolUse || !textBlock) {
    // Add tool results
    const toolResults = searchResponse.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Search results retrieved.' }));

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    const finalResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: `You are a business researcher. Based on the web search results, return ONLY a valid JSON array of 8-10 small businesses in ${countryName} that operate only on social media. No markdown, no explanation — just the JSON array starting with [.`,
      messages
    });

    const finalText = finalResponse.content.find(b => b.type === 'text')?.text || '';
    return parseJsonArray(finalText);
  }

  return parseJsonArray(textBlock?.text || '');
}

function parseJsonArray(text) {
  const cleaned = text.replace(/```json\n?|\n?```/g, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('Could not find JSON array in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Normalize DB row (snake_case) → camelCase for frontend
function normalizeSme(row) {
  return {
    id: row.id,
    countryId: row.country_id,
    name: row.name,
    industry: row.industry,
    productType: row.product_type,
    description: row.description,
    location: row.location,
    foundedYear: row.founded_year,
    employeeCount: row.employee_count,
    monthlyRevenue: row.monthly_revenue,
    socialMedia: row.social_media || {},
    contactEmail: row.contact_email,
    ownerName: row.owner_name,
    followers: row.followers || {},
    products: row.products || [],
    priceRange: row.price_range,
    tags: row.tags || [],
    noWebsiteReason: row.no_website_reason,
    opportunityScore: row.opportunity_score,
    languages: row.languages || [],
    status: row.status,
    deployedUrl: row.deployed_url,
    createdAt: row.created_at,
  };
}

// ─── COUNTRIES ───────────────────────────────────────────────────────────────

app.get('/api/countries', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM countries ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

app.post('/api/countries', async (req, res) => {
  const { name, code, flag } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO countries (name, code, flag) VALUES ($1, $2, $3) RETURNING *',
      [name, code || '', flag || '🌍']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

app.delete('/api/countries/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM countries WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// ─── SME SEARCH AGENT ────────────────────────────────────────────────────────

app.post('/api/countries/:id/search-smes', async (req, res) => {
  const { rows: countryRows } = await pool.query('SELECT * FROM countries WHERE id = $1', [req.params.id]);
  const country = countryRows[0];
  if (!country) return res.status(404).json({ error: 'Country not found' });

  try {
    console.log(`🔍 Web-searching for real SMEs in ${country.name}...`);
    const smes = await searchSMEsWithWebSearch(country.name);
    console.log(`✅ Found ${smes.length} SMEs`);

    const inserted = [];
    for (const s of smes) {
      const { rows } = await pool.query(
        `INSERT INTO smes
          (country_id, name, industry, product_type, description, location, founded_year,
           employee_count, monthly_revenue, social_media, contact_email, owner_name,
           followers, products, price_range, tags, no_website_reason, opportunity_score,
           languages, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'discovered')
         RETURNING *`,
        [
          req.params.id,
          s.name,
          s.industry || 'General',
          s.productType || '',
          s.description || '',
          s.location || country.name,
          s.foundedYear || null,
          s.employeeCount || '1-5',
          s.monthlyRevenue || 'Unknown',
          JSON.stringify(s.socialMedia || {}),
          s.contactEmail || '',
          s.ownerName || '',
          JSON.stringify(s.followers || {}),
          JSON.stringify(s.products || []),
          s.priceRange || '',
          JSON.stringify(s.tags || []),
          s.noWebsiteReason || '',
          s.opportunityScore || 75,
          JSON.stringify(s.languages || []),
        ]
      );
      inserted.push(rows[0]);
    }

    res.json(inserted.map(normalizeSme));
  } catch (err) {
    console.error('Search agent error:', err);
    res.status(500).json({ error: 'Search agent failed', detail: err.message });
  }
});

app.get('/api/countries/:id/smes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM smes WHERE country_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows.map(normalizeSme));
  } catch (err) {
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// ─── WEBSITE BUILDER AGENT ───────────────────────────────────────────────────

app.post('/api/smes/:smeId/build-website', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id = $1', [req.params.smeId]);
  const sme = rows[0] ? normalizeSme(rows[0]) : null;
  if (!sme) return res.status(404).json({ error: 'SME not found' });

  const system = `You are an elite web designer creating stunning single-file HTML websites. Return ONLY raw HTML starting with <!DOCTYPE html>. No markdown, no code fences, no explanation whatsoever.`;

  const prompt = `Build a complete, stunning, single-file HTML website for this business:

Business: ${sme.name}
Industry: ${sme.industry}
Products: ${(sme.products || []).join(', ')}
Description: ${sme.description}
Location: ${sme.location}
Price Range: ${sme.priceRange}
Owner: ${sme.ownerName}
Facebook: ${sme.socialMedia?.facebook || 'N/A'}
Instagram: ${sme.socialMedia?.instagram || 'N/A'}
WhatsApp: ${sme.socialMedia?.whatsapp || 'N/A'}
Tags: ${(sme.tags || []).join(', ')}

Requirements:
1. Single HTML file — ALL CSS and JS embedded (no external CSS files)
2. Stunning hero section with gradient background matching the industry
3. About section telling their story  
4. Product grid — cards with name, description, price from range, Buy button
5. Buy button opens a modal order form (name, phone, product, qty) → on submit: "Thank you! We'll contact you soon."
6. Social media links section
7. Contact section with location
8. Floating WhatsApp button bottom-right if whatsapp exists
9. Fully mobile responsive
10. Scroll-reveal animations with Intersection Observer
11. Google Fonts for typography (load via @import in style tag)
12. Professional footer with copyright ${new Date().getFullYear()}

Make it look like a $5000 professional website. Bold, memorable, unique design.`;

  try {
    let html = await callClaude(system, prompt, 8000);
    // Strip any accidental markdown fences
    html = html.replace(/^```html?\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
    if (!html.toLowerCase().startsWith('<!doctype') && !html.toLowerCase().startsWith('<html')) {
      const start = html.indexOf('<!DOCTYPE');
      if (start > -1) html = html.slice(start);
    }

    await pool.query(
      `INSERT INTO websites (sme_id, html)
       VALUES ($1, $2)
       ON CONFLICT (sme_id) DO UPDATE SET html = $2, built_at = NOW(), deployed_url = NULL, deployed_at = NULL`,
      [sme.id, html]
    );
    await pool.query("UPDATE smes SET status = 'website_built', deployed_url = NULL WHERE id = $1", [sme.id]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Website builder error:', err);
    res.status(500).json({ error: 'Website builder failed', detail: err.message });
  }
});

// Ensure unique constraint exists
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'websites_sme_id_key') THEN
      ALTER TABLE websites ADD CONSTRAINT websites_sme_id_key UNIQUE (sme_id);
    END IF;
  END $$;
`).catch(() => {});

// Get website metadata
app.get('/api/smes/:smeId/website', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT sme_id, deployed_url, slug, built_at, deployed_at FROM websites WHERE sme_id = $1',
      [req.params.smeId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No website built yet' });
    res.json({ deployedUrl: rows[0].deployed_url, slug: rows[0].slug, builtAt: rows[0].built_at });
  } catch (err) {
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// *** KEY FIX: Serve website HTML directly for iframe preview ***
app.get('/api/smes/:smeId/website/preview', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT html FROM websites WHERE sme_id = $1', [req.params.smeId]);
    if (!rows[0]) return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;color:#666"><h2>No website built yet</h2></body></html>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:*");
    res.send(rows[0].html);
  } catch (err) {
    res.status(500).send('<html><body>Error loading preview</body></html>');
  }
});

// Download HTML
app.get('/api/smes/:smeId/website/download', async (req, res) => {
  try {
    const { rows: smeRows } = await pool.query('SELECT name FROM smes WHERE id = $1', [req.params.smeId]);
    const { rows } = await pool.query('SELECT html FROM websites WHERE sme_id = $1', [req.params.smeId]);
    if (!rows[0]) return res.status(404).send('Not found');
    const slug = (smeRows[0]?.name || 'website').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.html"`);
    res.setHeader('Content-Type', 'text/html');
    res.send(rows[0].html);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ─── DEPLOYER AGENT ──────────────────────────────────────────────────────────

app.post('/api/smes/:smeId/deploy', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id = $1', [req.params.smeId]);
  const sme = rows[0];
  if (!sme) return res.status(404).json({ error: 'SME not found' });

  const { rows: siteRows } = await pool.query('SELECT html FROM websites WHERE sme_id = $1', [req.params.smeId]);
  if (!siteRows[0]) return res.status(400).json({ error: 'Build website first' });

  const slug = sme.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const url = `https://${slug}.netlify.app`;

  try {
    await pool.query(
      'UPDATE websites SET deployed_url = $1, slug = $2, deployed_at = NOW() WHERE sme_id = $3',
      [url, slug, sme.id]
    );
    await pool.query("UPDATE smes SET status = 'deployed', deployed_url = $1 WHERE id = $2", [url, sme.id]);
    res.json({ ok: true, url, slug, note: 'Simulated URL. Add NETLIFY_TOKEN to .env for live deploys.' });
  } catch (err) {
    res.status(500).json({ error: 'Deploy failed', detail: err.message });
  }
});

// ─── MARKETING AGENT ─────────────────────────────────────────────────────────

app.post('/api/smes/:smeId/generate-email', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smes WHERE id = $1', [req.params.smeId]);
  const sme = rows[0] ? normalizeSme(rows[0]) : null;
  if (!sme) return res.status(404).json({ error: 'SME not found' });

  const { rows: siteRows } = await pool.query('SELECT deployed_url FROM websites WHERE sme_id = $1', [sme.id]);
  const deployedUrl = siteRows[0]?.deployed_url || '[WEBSITE_LINK]';

  const system = `You are a world-class B2B sales copywriter. Write warm, personalized, non-salesy outreach emails. Return ONLY valid JSON: {"subject":"...","body":"..."}. No markdown.`;

  const prompt = `Write a personalized outreach email:

Business: ${sme.name}
Owner: ${sme.ownerName}
Industry: ${sme.industry}
Products: ${(sme.products || []).join(', ')}
Location: ${sme.location}
Active on: ${Object.entries(sme.socialMedia || {}).filter(([,v]) => v).map(([k]) => k).join(', ')}
Website we built: ${deployedUrl}
Followers: FB ${sme.followers?.facebook || 0} | IG ${sme.followers?.instagram || 0}

Our offer:
- Free professional website (link: ${deployedUrl})
- Option A: Sell through our platform → website FREE, we take 10% per sale
- Option B: Just the website → small monthly fee
- We don't do logistics

Requirements: subject with curiosity, reference their specific business, mention social success + no website, include link, explain options briefly, max 220 words, warm human tone.

Return JSON: {"subject": "...", "body": "..."}`;

  try {
    const raw = await callClaude(system, prompt, 2000);
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const email = JSON.parse(cleaned);

    await pool.query(
      `INSERT INTO emails (sme_id, subject, body) VALUES ($1, $2, $3)
       ON CONFLICT (sme_id) DO UPDATE SET subject = $2, body = $3, created_at = NOW()`,
      [sme.id, email.subject, email.body]
    );
    await pool.query("UPDATE smes SET status = 'email_ready' WHERE id = $1", [sme.id]);

    res.json(email);
  } catch (err) {
    console.error('Marketing agent error:', err);
    res.status(500).json({ error: 'Marketing agent failed', detail: err.message });
  }
});

pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emails_sme_id_key') THEN
      ALTER TABLE emails ADD CONSTRAINT emails_sme_id_key UNIQUE (sme_id);
    END IF;
  END $$;
`).catch(() => {});

app.get('/api/smes/:smeId/email', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT subject, body FROM emails WHERE sme_id = $1', [req.params.smeId]);
    if (!rows[0]) return res.status(404).json({ error: 'No email generated yet' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SME Portal API → http://localhost:${PORT}`);
  console.log(`📦 PostgreSQL: ${process.env.DB_NAME || 'sme_portal'}@${process.env.DB_HOST || 'localhost'}`);
});
