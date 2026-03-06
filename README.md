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
