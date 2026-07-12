-- TEZ Creations — Drop #007 Consistency Tracker
-- Run this in the Supabase SQL editor (same project as subgoal/gauntlet/auth).
--
-- Security model (stricter than the overlay-permissive drops):
--   • claim_token is a real secret → tracker_creators has RLS ON with NO policies,
--     so the anon key gets zero access. Public reads go through the
--     tracker_creators_public VIEW (no claim_token / live_state columns).
--   • tracker_activity is public data (the tracker page shows it to anyone) →
--     anon SELECT is allowed, which is also what lets the overlay + public page
--     receive Realtime postgres_changes with the anon key.
--   • ALL writes go through the service role in api/tracker.js + api/eventsub.js.

create table if not exists tracker_creators (
  id            uuid primary key default gen_random_uuid(),
  handle        text not null unique,            -- lowercase twitch login
  twitch_id     text not null unique,
  display_name  text,
  tz            text not null default 'UTC',     -- IANA tz from browser at claim
  claim_token   text not null,                   -- secret; NEVER exposed via anon reads
  schedule      jsonb not null default '[false,false,false,false,false,false,false]'::jsonb,  -- [Sun..Sat]
  live_state    jsonb,                           -- { started_at, last_offline_at, date, day_base } for merge logic
  created_at    timestamptz default now()
);

create table if not exists tracker_activity (
  creator_id  uuid references tracker_creators(id) on delete cascade,
  date        date not null,                     -- local day per creators.tz
  platform    text not null default 'twitch',    -- 'twitch' | 'kick' | 'youtube' (future)
  minutes     int  not null default 0,
  source      text not null default 'manual',    -- 'webhook' | 'vod' | 'manual'
  started_at  timestamptz,
  ended_at    timestamptz,
  updated_at  timestamptz default now(),
  primary key (creator_id, date, platform)
);

-- RLS: creators fully locked (anon denied — protects claim_token);
-- activity readable by anyone (needed for Realtime), writable by nobody but service role.
alter table tracker_creators enable row level security;
alter table tracker_activity enable row level security;

drop policy if exists "anon read activity" on tracker_activity;
create policy "anon read activity" on tracker_activity
  for select to anon, authenticated using (true);

-- Public face of tracker_creators — everything EXCEPT claim_token + live_state.
-- (View runs with owner rights, so it reads through the locked table by design.)
create or replace view tracker_creators_public as
  select id, handle, display_name, tz, schedule, created_at
  from tracker_creators;
grant select on tracker_creators_public to anon, authenticated;

-- Realtime: the overlay + public page subscribe to activity changes (anon key).
do $$ begin
  alter publication supabase_realtime add table tracker_activity;
exception when duplicate_object then null; end $$;
