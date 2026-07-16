-- ===== AK9 AWARDS — Supabase schema =====
-- Run this in Supabase → SQL Editor → New query → Run.
--
-- All four tables are LOCKED (RLS on, no policies) so the public/anon key can
-- touch NONE of them. Every read/write goes through the Vercel functions using
-- the SERVICE ROLE key (which bypasses RLS). Nothing about votes is ever exposed
-- to the browser except what an authenticated function chooses to return.

-- 1) Singleton settings row (deadline / month / open-closed). Always id = 1.
create table if not exists ak9_settings (
  id                int primary key default 1,
  month_label       text default '',
  deadline          timestamptz,            -- voting closes at this time (nullable = no deadline yet)
  voting_open       boolean default true,
  phase             text default 'vote',    -- 'nominate' | 'vote' | 'closed'
  nominate_deadline timestamptz,            -- phase-1 (nomination) closes at this time
  updated_at        timestamptz default now(),
  constraint ak9_settings_singleton check (id = 1)
);
insert into ak9_settings (id) values (1) on conflict (id) do nothing;
-- Migrations for existing databases (safe to re-run):
alter table ak9_settings add column if not exists phase text default 'vote';
alter table ak9_settings add column if not exists nominate_deadline timestamptz;

-- 2) Awards + their nominees. nominees is a JSON array of
--    { id, name, image, twitch_login }  (image / twitch_login optional).
create table if not exists ak9_awards (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text default '',
  sort        int  default 0,
  nominees    jsonb default '[]'::jsonb,
  created_at  timestamptz default now()
);

-- 3) One row per voter. UNIQUE(twitch_user_id) = one vote per person, enforced
--    by the database (un-spoofable). choices = { award_id: nominee_id }.
create table if not exists ak9_votes (
  id             uuid primary key default gen_random_uuid(),
  twitch_user_id text not null unique,
  twitch_login   text,
  display_name   text,
  choices        jsonb not null,
  ip             text,
  created_at     timestamptz default now()
);

-- 3b) Phase-1 nominations. One row per person (PK = twitch_user_id), so a second
--     submit is a 409. choices = { award_id: "free-text nominee name" }. After the
--     nominate deadline, the admin tallies these and promotes the top names to each
--     award's nominees for the voting phase.
create table if not exists ak9_nominations (
  twitch_user_id text primary key,
  twitch_login   text,
  display_name   text,
  choices        jsonb not null,
  ip             text,
  created_at     timestamptz default now()
);

-- 4) The broadcaster's stored Twitch refresh token, used SERVER-SIDE to verify
--    each voter follows the channel (Twitch removed self-follow checks). Singleton.
--    SENSITIVE — locked like subgoal_tokens.
create table if not exists ak9_broadcaster (
  id             int primary key default 1,
  broadcaster_id text,
  login          text,
  refresh_token  text,
  scope          text,
  updated_at     timestamptz default now(),
  constraint ak9_broadcaster_singleton check (id = 1)
);

-- Lock everything: RLS on, NO policies → anon key gets zero access. The service
-- role key the API functions use bypasses RLS, so the server still works.
alter table ak9_settings     enable row level security;
alter table ak9_awards       enable row level security;
alter table ak9_votes        enable row level security;
alter table ak9_nominations  enable row level security;
alter table ak9_broadcaster  enable row level security;
