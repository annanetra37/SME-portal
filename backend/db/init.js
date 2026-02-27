import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;

const DB_NAME = process.env.DB_NAME || 'sme_portal';

const schema = `
CREATE TABLE IF NOT EXISTS countries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  code        TEXT,
  flag        TEXT DEFAULT '🌍',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS smes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id        UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  industry          TEXT,
  product_type      TEXT,
  description       TEXT,
  location          TEXT,
  founded_year      INT,
  employee_count    TEXT,
  monthly_revenue   TEXT,
  social_media      JSONB DEFAULT '{}',
  contact_email     TEXT,
  owner_name        TEXT,
  followers         JSONB DEFAULT '{}',
  products          JSONB DEFAULT '[]',
  price_range       TEXT,
  tags              JSONB DEFAULT '[]',
  no_website_reason TEXT,
  opportunity_score INT DEFAULT 75,
  languages         JSONB DEFAULT '[]',
  status            TEXT DEFAULT 'discovered',
  deployed_url      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS websites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sme_id       UUID NOT NULL REFERENCES smes(id) ON DELETE CASCADE,
  html         TEXT NOT NULL,
  deployed_url TEXT,
  slug         TEXT,
  built_at     TIMESTAMPTZ DEFAULT NOW(),
  deployed_at  TIMESTAMPTZ,
  CONSTRAINT websites_sme_id_key UNIQUE (sme_id)
);

CREATE TABLE IF NOT EXISTS emails (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sme_id     UUID NOT NULL REFERENCES smes(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT emails_sme_id_key UNIQUE (sme_id)
);

CREATE INDEX IF NOT EXISTS idx_smes_country ON smes(country_id);
CREATE INDEX IF NOT EXISTS idx_websites_sme ON websites(sme_id);
CREATE INDEX IF NOT EXISTS idx_emails_sme   ON emails(sme_id);
`;

async function init() {
  // Step 1: Connect to default 'postgres' DB to create our DB if needed
  const adminClient = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres',                          // always exists
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  await adminClient.connect();

  const { rows } = await adminClient.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]
  );

  if (rows.length === 0) {
    console.log(`📦 Database "${DB_NAME}" not found — creating it...`);
    await adminClient.query(`CREATE DATABASE "${DB_NAME}"`);
    console.log(`✅ Database "${DB_NAME}" created`);
  } else {
    console.log(`✅ Database "${DB_NAME}" already exists`);
  }

  await adminClient.end();

  // Step 2: Connect to our DB and run schema
  const appClient = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: DB_NAME,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  await appClient.connect();
  await appClient.query(schema);
  await appClient.end();

  console.log('✅ Schema initialized — all tables ready');
  console.log('🚀 You can now run: npm start');
}

init().catch(err => {
  console.error('❌ Init failed:', err.message);
  console.error('\nMake sure PostgreSQL is running and your .env credentials are correct.');
  process.exit(1);
});
