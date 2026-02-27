# WebLaunch — SME Growth Portal
## Full Documentation

---

## 📖 Overview

WebLaunch is an AI-powered portal that helps you identify social-media-only SMEs, build tailored websites for them, deploy those sites, and generate personalized outreach emails — all from a single interface.

---

## 🏗️ Architecture

```
sme-portal/
├── backend/
│   ├── server.js          # Express API + all AI agent endpoints
│   ├── package.json
│   └── .env.example       # Environment variables template
└── frontend/
    └── index.html         # Complete single-file portal UI
```

**Stack:**
- **Backend:** Node.js + Express (ESM), Anthropic SDK
- **Frontend:** Vanilla HTML/CSS/JS (zero build step, open index.html directly)
- **AI:** Claude claude-sonnet-4-6 (all four agents)
- **Data:** In-memory store (swap for PostgreSQL/MongoDB in production)

---

## ⚙️ Setup & Installation

### 1. Clone / Download the Project

```bash
# Navigate to the project root
cd sme-portal
```

### 2. Configure Environment

```bash
cd backend
cp .env.example .env
# Edit .env and add your Anthropic API key
```

**.env contents:**
```
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
PORT=3001
```

### 3. Install Dependencies

```bash
cd backend
npm install
```

### 4. Start the Backend

```bash
npm start
# Server runs at http://localhost:3001
```

### 5. Open the Frontend

Simply open `frontend/index.html` in your browser:
```bash
open frontend/index.html
# Or drag the file into any browser
```

> **No build step required.** The frontend is a single self-contained HTML file.

---

## 🔌 API Reference

Base URL: `http://localhost:3001/api`

### Countries

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/countries` | List all countries |
| `POST` | `/countries` | Add a country `{ name, code, flag }` |
| `DELETE` | `/countries/:id` | Remove a country |

### SME Discovery Agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/countries/:id/search-smes` | Run SME search agent for a country |
| `GET` | `/countries/:id/smes` | Get all SMEs for a country |

**SME Object Schema:**
```json
{
  "id": "uuid",
  "name": "Business Name",
  "industry": "Food & Beverage",
  "productType": "Homemade Jams",
  "description": "...",
  "location": "Yerevan, Armenia",
  "foundedYear": 2019,
  "employeeCount": "1-5",
  "monthlyRevenue": "$500-$2000",
  "socialMedia": {
    "facebook": "https://facebook.com/...",
    "instagram": "https://instagram.com/...",
    "whatsapp": "+374XXXXXXXXX"
  },
  "contactEmail": "owner@gmail.com",
  "ownerName": "Full Name",
  "followers": { "facebook": 1200, "instagram": 850 },
  "products": ["Product 1", "Product 2"],
  "priceRange": "$5-$50",
  "tags": ["handmade", "local"],
  "noWebsiteReason": "...",
  "opportunityScore": 85,
  "status": "discovered | website_built | deployed | email_ready"
}
```

### Website Builder Agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/smes/:id/build-website` | Generate a tailored website for an SME |
| `GET` | `/smes/:id/website` | Retrieve the built website `{ html, deployedUrl }` |

### Deployer Agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/smes/:id/deploy` | Deploy the website and get a shareable URL |

**Response:**
```json
{
  "ok": true,
  "url": "https://business-name.netlify.app",
  "slug": "business-name"
}
```

### Marketing Agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/smes/:id/generate-email` | Generate a personalized outreach email |
| `GET` | `/smes/:id/email` | Retrieve the generated email |

**Response:**
```json
{
  "subject": "We built something for [Business Name] 👀",
  "body": "Hi [Owner], ..."
}
```

---

## 🤖 AI Agents

### 1. SME Search Agent
- **Trigger:** `POST /countries/:id/search-smes`
- **What it does:** Generates 8–12 realistic SME profiles for the selected country, based on knowledge of local business ecosystems and social media usage patterns
- **Output:** Structured SME data with social profiles, contact info, products, follower counts, opportunity scores

### 2. Website Builder Agent
- **Trigger:** `POST /smes/:id/build-website`
- **What it does:** Creates a complete, single-file HTML/CSS/JS website tailored to the SME's industry, products, branding, and content
- **Features included:** Hero section, product cards, order modal, social links, WhatsApp button, animations, mobile-responsive layout
- **Output:** Full HTML string stored in-memory

### 3. Deployer Agent
- **Trigger:** `POST /smes/:id/deploy`
- **What it does:** Generates a business-name-based URL slug and deploys the site
- **Current mode:** Simulated URL generation (`https://[slug].netlify.app`)
- **Production mode:** See "Enabling Real Deployments" below

### 4. Marketing Agent
- **Trigger:** `POST /smes/:id/generate-email`
- **What it does:** Writes a personalized cold outreach email referencing the specific business, their social presence, and the website link
- **Output:** `{ subject, body }` — ready to copy/send

---

## 🚀 Enabling Real Deployments (Netlify)

To deploy websites for real (free tier):

1. Create a free account at [netlify.com](https://netlify.com)
2. Generate a Personal Access Token in Netlify's UI: **User Settings → Applications → New Access Token**
3. Add to your `.env`:
   ```
   NETLIFY_TOKEN=your_netlify_token_here
   ```
4. Update `server.js` deploy endpoint to use:
   ```javascript
   // Replace simulated block with:
   const FormData = require('form-data');
   const JSZip = require('jszip');
   
   const zip = new JSZip();
   zip.file('index.html', site.html);
   const buffer = await zip.generateAsync({ type: 'nodebuffer' });
   
   const netlifyRes = await fetch('https://api.netlify.com/api/v1/sites', {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${process.env.NETLIFY_TOKEN}`,
       'Content-Type': 'application/zip',
     },
     body: buffer,
   });
   const data = await netlifyRes.json();
   const url = `https://${data.subdomain}.netlify.app`;
   ```

**Result:** Each SME gets their own real, live URL like `https://anush-jams.netlify.app`

---

## 💾 Moving to a Real Database

Currently uses in-memory store (resets on server restart). To persist:

**Option A: SQLite (simplest)**
```bash
npm install better-sqlite3
```

**Option B: PostgreSQL**
```bash
npm install pg
```

**Option C: MongoDB**
```bash
npm install mongoose
```

Replace the `store` object and CRUD operations in `server.js` with your chosen DB adapter.

---

## 🔐 Production Checklist

- [ ] Replace `ANTHROPIC_API_KEY` with env var (never commit to git)
- [ ] Add authentication (JWT or session) to protect the portal
- [ ] Move from in-memory store to a database
- [ ] Enable real Netlify deployments (see above)
- [ ] Add rate limiting to AI agent endpoints (prevent abuse)
- [ ] Set up HTTPS with a reverse proxy (nginx / Caddy)
- [ ] Add email sending integration (Resend, SendGrid) to actually send outreach emails

---

## 💡 Business Logic Reminder

| Path | What They Get | What They Pay |
|------|---------------|---------------|
| **Commerce through WebLaunch** | Free website, hosted, maintained | 10% per transaction |
| **Website only** | Website + updates | Monthly fee + update charges |

The portal supports both paths — use the "status" pipeline to track which SMEs have been pitched, which accepted, and which path they chose.

---

## 📊 Pipeline Stages

| Stage | Meaning |
|-------|---------|
| `discovered` | SME found by search agent |
| `website_built` | Website generated by builder agent |
| `deployed` | Website live with shareable URL |
| `email_ready` | Outreach email composed and ready to send |

---

## 🛠️ Troubleshooting

**Backend won't start:**
- Check Node.js version: requires Node 18+
- Verify `.env` file exists with valid API key

**AI agents return errors:**
- Check your Anthropic API key is valid and has credits
- Check the server console for detailed error messages

**Frontend can't reach backend:**
- Confirm backend is running on port 3001
- Check browser console for CORS errors
- Make sure you opened `index.html` directly (not via a server on a different port)

**Website preview doesn't load:**
- This is normal if the browser blocks blob URLs — try in Chrome or Firefox
- Download the HTML and open it directly to preview

---

*WebLaunch Portal — Built for SME digital growth*
