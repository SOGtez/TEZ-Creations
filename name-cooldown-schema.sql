-- TEZ Creations — display-name change cooldown (once every 14 days).
-- Run once in the Supabase SQL editor (adds one nullable column).
--
-- api/auth.js stamps this whenever the name actually changes, and rejects a new
-- change until 14 days have passed. NULL = never changed (first change is free).

alter table tez_users add column if not exists name_changed_at timestamptz;
