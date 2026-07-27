-- TEZ Creations — Drop #009 Subathon Timer
-- Run once in the Supabase SQL editor (same project as subgoal/gauntlet/ak9).
--
-- One row per streamer (one timer per TEZ account). The overlay URL only carries
-- the row id; ALL state lives here, so settings changes push to open overlays via
-- realtime — the link never changes.
--
-- Security model: the row is PUBLIC-READ (the overlay reads it with the anon key,
-- like gauntlet/kick_subs) — it holds nothing sensitive, just timer state + style.
-- All WRITES go through our serverless API with the service-role key.

create table if not exists public.subathon_timers (
  id          text primary key,              -- opaque overlay id ("sb-…"), public
  owner_code  text not null unique,          -- TEZ-XXXXX account code (one timer each)
  twitch_broadcaster_id text,
  twitch_login          text,
  kick_broadcaster_id   text,
  kick_login            text,
  settings    jsonb not null default '{}'::jsonb,  -- sec_per_sub, multipliers, style…
  ends_at     timestamptz,                   -- countdown target; null = not started
  paused_at   timestamptz,                   -- non-null = paused (remaining frozen)
  stats       jsonb not null default '{}'::jsonb,  -- { subs, resubs, added_sec }
  last_event  jsonb,                         -- { kind, name, count, secs, at } → overlay toast
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists subathon_twitch_idx on public.subathon_timers (twitch_broadcaster_id);
create index if not exists subathon_kick_idx   on public.subathon_timers (kick_broadcaster_id);

alter table public.subathon_timers enable row level security;

-- public read (overlay + realtime); no anon insert/update/delete policies on purpose
drop policy if exists "subathon public read" on public.subathon_timers;
create policy "subathon public read" on public.subathon_timers for select using (true);

-- realtime: the overlay subscribes to changes on its row
alter publication supabase_realtime add table public.subathon_timers;
