# WebLaunch — SME Growth Portal v2

AI-powered portal to discover social-media-only SMEs, build them professional websites, and send personalised outreach emails.

---

## Deploy to Railway (5 min)

### 1 — Push to GitHub
```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/YOU/weblaunch.git
git push -u origin main
```

### 2 — Create Railway project
- Go to https://railway.app → **New Project** → **Deploy from GitHub**
- Select your repo

### 3 — Add PostgreSQL
- In your project: **+ New** → **Database** → **PostgreSQL**
- Railway automatically sets `DATABASE_URL` in your app — nothing to configure

### 4 — Set one environment variable
In your app service → **Variables**:
```
ANTHROPIC_API_KEY = sk-ant-...your-key...
```
`PORT` and `DATABASE_URL` are injected by Railway automatically. Do not set them.

### 5 — Done
Railway deploys on every `git push`. Your app will be at:
```
https://your-app.up.railway.app
```

---

## Local development

```bash
# 1. Need a PostgreSQL database — easiest: Railway provides one, copy the URL
# 2. Create backend/.env
echo 'ANTHROPIC_API_KEY=sk-ant-...' > backend/.env
echo 'DATABASE_URL=postgresql://...' >> backend/.env

# 3. Install & run
cd backend && npm install && npm start
```
Open http://localhost:3000

---

## Architecture

```
weblaunch/
├── railway.json              # Railway config
├── nixpacks.toml             # Node 20 + install path
├── frontend/
│   └── public/
│       └── index.html        # Complete SPA (no build step)
└── backend/
    ├── server.js             # Express + all AI agents + static serve
    ├── package.json
    └── .env.example
```

**Key design decisions for Railway:**
- Single `DATABASE_URL` — no host/port/user/password split
- SSL enabled on pg pool (`rejectUnauthorized: false`)  
- Schema auto-migrates on startup via `initDB()`
- `PORT` read from env, bound to `0.0.0.0`
- Frontend served as static files from Express — one URL, no CORS issues
- API URL in frontend is `window.location.origin + '/api'` — works everywhere

---

## Environment variables

| Variable | Where it comes from | Required |
|----------|-------------------|----------|
| `ANTHROPIC_API_KEY` | You set this in Railway | ✅ |
| `DATABASE_URL` | Railway injects automatically | ✅ (auto) |
| `PORT` | Railway injects automatically | ✅ (auto) |




<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<NEW VERSION>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>




# WebLaunch — SME Growth Portal
## Full Documentation — v2.1

---

## 📖 Overview

WebLaunch is an AI-powered portal that helps you identify social-media-only SMEs, build tailored websites for them, deploy those sites, and generate personalized outreach emails — all from a single interface.

---

## 🆕 What Changed in v2.1 — Intelligent SME Search

The SME Search Agent has been completely rebuilt. The old version generated plausible-sounding but fabricated business names and fake social media URLs. The new version runs a **4-phase verification pipeline** that only delivers real, confirmed businesses.

### The 4-Phase Search Pipeline

```
Phase 1 — DISCOVER
  └─ 6 parallel web searches: site:facebook.com, site:instagram.com,
     country-specific queries in local languages
  └─ Claude extracts candidate business names from real search results
  └─ No fabrication: if nothing found, nothing is returned

Phase 2 — VERIFY (per candidate)
  └─ Dedicated web search for each candidate business
  └─ Strict checks: Does it have a Facebook/Instagram page? Does it have a website?
  └─ Businesses WITH websites are rejected ❌
  └─ Businesses with no confirmed social URL are rejected ❌
  └─ Only "high" or "medium" confidence results proceed ✓

Phase 3 — ENRICH (per verified business)
  └─ Fetches real product/follower/description data from social pages
  └─ Social URLs are LOCKED to verified values — cannot be overwritten by AI
  └─ Builds complete SME profile with all fields

Phase 4 — SUPPLEMENT (if < 12 results)
  └─ Runs additional industry-specific searches (food, crafts, fashion, beauty)
  └─ Verifies new candidates through same Phase 2 pipeline
  └─ Fallback: if truly nothing found, returns clearly-labelled "illustrative" profiles
```

### Quality Guarantees
- ✅ All social media URLs come from real web search results — never constructed
- ✅ Every business is checked for having NO independent website
- ✅ Illustrative profiles (fallback) are clearly labelled in the UI
- ✅ Verified businesses show a green "✓ verified" badge
- ✅ Social links open to real pages

---

## 🏗️ Architecture

```
sme-portal/
├── backend/
│   ├── server.js          # Express API + all AI agent endpoints (v2.1)
│   ├── package.json
│   ├── .env.example
│   └── db/
│       ├── pool.js        # PostgreSQL connection pool
│       └── init.js        # Schema init + migrations (v2.1 adds is_illustrative)
└── frontend/
    └── index.html         # Single-file portal UI (apply FRONTEND_PATCH.js)
```

**Stack:**
- **Backend:** Node.js + Express (ESM), Anthropic SDK
- **Frontend:** Vanilla HTML/CSS/JS (zero build step)
- **AI:** Claude claude-sonnet-4-6 with `web_search_20250305` tool
- **Data:** PostgreSQL

---

## ⚙️ Setup & Installation

### 1. Apply the v2.1 Changes

Replace these files in your project:
- `backend/server.js` → use the new `server.js` from this update
- `backend/db/init.js` → use the new `init.js` (adds `is_illustrative` column)
- Apply `FRONTEND_PATCH.js` changes to `frontend/index.html`

### 2. Run DB Migration

The new `init.js` safely adds the `is_illustrative` column if it doesn't exist:
```bash
cd backend
npm run db:init
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env
```

**.env contents:**
```
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_NAME=sme_portal
DB_USER=postgres
DB_PASSWORD=postgres
NETLIFY_TOKEN=        # optional — for real deployments
```

### 4. Start

```bash
npm start
# Server: http://localhost:3001
# Open: frontend/index.html in browser
```

---

## 🔌 API Reference

Base URL: `http://localhost:3001/api`

### SME Search Agent — NEW BEHAVIOR

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/countries/:id/search-smes` | Run 4-phase verified SME search |

**SME Object Schema (v2.1):**
```json
{
  "id": "uuid",
  "name": "Business Name",
  "industry": "Food & Beverage",
  "productType": "Homemade Jams",
  "description": "...",
  "location": "Yerevan, Armenia",
  "socialMedia": {
    "facebook": "https://facebook.com/verified-page",
    "instagram": "https://instagram.com/verified-handle",
    "whatsapp": "+374XXXXXXXXX"
  },
  "followers": { "facebook": 1200, "instagram": 850 },
  "products": ["Apricot Jam", "Walnut Honey", "Rose Preserves"],
  "opportunityScore": 85,
  "isIllustrative": false,
  "status": "discovered"
}
```

> `isIllustrative: true` means the business was generated as a realistic example because web search returned no verifiable results for that country. These profiles have `null` social URLs.

---

## 🤖 AI Agents

### 1. SME Search Agent (v2.1 — 4-Phase Pipeline)
- Phase 1: 6 parallel web searches with country + platform-specific queries
- Phase 2: Per-candidate verification — confirms social page exists, confirms no website
- Phase 3: Deep enrichment — real products, followers, descriptions
- Phase 4: Supplemental search if < 12 verified results
- Fallback: Illustrative profiles (clearly labelled) if country has no searchable data

### 2. Website Builder Agent
- Builds a complete single-file HTML/CSS/JS website tailored to the SME
- Uses real social URLs from the verified profile

### 3. Deployer Agent
- Generates SEO-friendly slug from business name
- Real deployment with `NETLIFY_TOKEN`, simulated URL otherwise

### 4. Marketing Agent
- Personalized cold outreach email referencing real products and social presence
- Includes live website link

---

## 🧠 Why the Old Agent Produced Fake Links

The old `searchSMEsWithWebSearch()` function:
1. Made a single web search call
2. Passed raw search snippets to Claude
3. Asked Claude to "find 8-10 real or highly realistic businesses"
4. Claude hallucinated plausible Facebook/Instagram URLs based on business names it invented

The new pipeline fixes this by:
1. **Separating discovery from fabrication** — Phase 1 only extracts names actually present in search results
2. **Hard verification** — Phase 2 does a dedicated search per business to confirm the page exists
3. **URL locking** — Phase 3 enrichment can never overwrite verified social URLs with hallucinated ones
4. **Explicit fallback** — If truly nothing can be verified, illustrative profiles are clearly marked

---

## 🚀 Enabling Real Deployments (Netlify)

1. Create free account at [netlify.com](https://netlify.com)
2. Generate Personal Access Token: **User Settings → Applications → New Access Token**
3. Add to `.env`: `NETLIFY_TOKEN=your_token_here`

Real deployment is already implemented in `server.js` — no code changes needed.

---

## 🔐 Production Checklist

- [ ] Replace `ANTHROPIC_API_KEY` with env var
- [ ] Add authentication (JWT or session)
- [ ] Enable real Netlify deployments
- [ ] Add rate limiting to AI agent endpoints
- [ ] Set up HTTPS with nginx / Caddy
- [ ] Add email sending (Resend, SendGrid)

---

## 📊 Pipeline Stages

| Stage | Meaning |
|-------|---------|
| `discovered` | SME found and verified by search agent |
| `website_built` | Website generated by builder agent |
| `deployed` | Website live with shareable URL |
| `email_ready` | Outreach email composed and ready to send |

---

*WebLaunch Portal v2.1 — Real businesses. Verified links. Zero fabrication.*