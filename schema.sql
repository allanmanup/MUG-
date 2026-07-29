-- Requires: pgcrypto extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Anonymous responses: NO identity fields here
CREATE TABLE IF NOT EXISTS assessment_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_key text NOT NULL,
  composite_score int,
  band_key text,
  domain_scores jsonb,
  struggle_flag boolean DEFAULT false,
  ace_score int,
  ace_skipped boolean DEFAULT false,
  father_experience text,
  life_stage text,
  created_at timestamptz DEFAULT now()
);

-- Identifiable leads: coarse result only
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_key text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  church text,
  city text,
  band_key text,
  coaching_priority boolean DEFAULT false,
  email_sent boolean DEFAULT false,
  email_error text,
  cc_synced boolean DEFAULT false,
  cc_sync_error text,
  created_at timestamptz DEFAULT now()
);

-- Outbox pattern: jobs for async integration work
CREATE TABLE IF NOT EXISTS outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  type text NOT NULL,                -- 'email' | 'constant_contact' | 'alert'
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- 'pending','in_progress','done','failed'
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  run_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_runat ON outbox_jobs (status, run_at);
