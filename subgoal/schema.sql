-- ===== TEZ Creations — Sub Goal: never-expiring token store =====
-- Run this in Supabase → SQL Editor → New query → Run.
--
-- Holds Twitch refresh tokens, keyed by the opaque id that goes in the overlay URL.
-- SENSITIVE: this table is locked so the public/anon key CANNOT read it. Only the
-- server (the Vercel functions using the SERVICE ROLE key, which bypasses RLS)
-- ever touches it. Do NOT add anon policies here like the Gauntlet table has.

create table if not exists subgoal_tokens (
  id             text primary key,            -- opaque id used in the overlay URL
  broadcaster_id text not null,               -- twitch user id
  login          text,                        -- twitch login (for display)
  refresh_token  text not null,               -- Twitch refresh token (SENSITIVE)
  scope          text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- RLS ON with NO policies → the anon/public key gets zero access to this table.
-- The service_role key used by the API functions bypasses RLS, so the server
-- still reads/writes normally.
alter table subgoal_tokens enable row level security;
