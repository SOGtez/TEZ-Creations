-- ===== TEZ Creations — Gauntlet: Supabase setup =====
-- Run this in Supabase → SQL Editor → New query → Run.

create table if not exists gauntlet_boards (
  id          text primary key,                    -- board id used in the overlay URL
  channel     text not null,                        -- twitch channel login to listen to (lowercase)
  title       text default 'Gauntlet',
  games       jsonb not null default '[]'::jsonb,    -- [{ "name": "Elden Ring", "done": false }, ...]
  active      text,                                  -- name of the ACTIVE game, or null
  updated_at  timestamptz default now()
);

-- Let the overlay receive live changes.
alter publication supabase_realtime add table gauntlet_boards;

-- Row Level Security. These prototype policies allow the public anon key to
-- read and write this one table. Fine for a stream overlay; tighten later if needed.
alter table gauntlet_boards enable row level security;

drop policy if exists gauntlet_read   on gauntlet_boards;
drop policy if exists gauntlet_insert on gauntlet_boards;
drop policy if exists gauntlet_update on gauntlet_boards;

create policy gauntlet_read   on gauntlet_boards for select using (true);
create policy gauntlet_insert on gauntlet_boards for insert with check (true);
create policy gauntlet_update on gauntlet_boards for update using (true) with check (true);
