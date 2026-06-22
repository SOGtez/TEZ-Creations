-- ===== TEZ Creations — Sub Goal (Kick): tables =====
-- Run this in Supabase → SQL Editor → New query → Run.
--
-- Kick has no API to read a current sub total, so the overlay counts subscription
-- webhook events as they arrive. Two tables:
--   kick_tokens — the refresh token (SENSITIVE, locked like subgoal_tokens)
--   kick_subs   — the running sub count the overlay reads live (realtime)

-- Refresh tokens — locked: anon/public key gets ZERO access. Only the server
-- (Vercel functions using the SERVICE ROLE key, which bypasses RLS) reads this.
create table if not exists kick_tokens (
  id                  text primary key,        -- opaque id (also the kick_subs id)
  broadcaster_user_id text not null,
  login               text,
  refresh_token       text not null,           -- Kick refresh token (SENSITIVE)
  scope               text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
alter table kick_tokens enable row level security;   -- no policies → anon denied

-- The live sub count the overlay subscribes to. Readable by the public anon key
-- (read-only); only the webhook function (service role) ever writes it.
create table if not exists kick_subs (
  id                  text primary key,            -- opaque id, in the overlay URL
  broadcaster_user_id text unique not null,        -- the webhook looks up the row by this
  login               text,
  count               integer not null default 0,  -- subs counted since connect
  last_event          jsonb,                        -- latest event (for the overlay's celebrate)
  updated_at          timestamptz default now()
);

-- Let the overlay receive live count changes.
alter publication supabase_realtime add table kick_subs;

-- RLS: anon can READ kick_subs (needed for realtime); writes are server-only
-- (service role bypasses RLS, so no anon write policy is created).
alter table kick_subs enable row level security;
drop policy if exists kick_subs_read on kick_subs;
create policy kick_subs_read on kick_subs for select using (true);
