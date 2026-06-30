-- TEZ Creations — community "unclaimable" layer for Handle Hunter.
-- Run once in the Supabase project (SQL editor), same project as auth-schema.sql.
--
-- Why this exists: Twitch's true "is this registerable?" check is bot-walled, so
-- a name with no active account can still be un-registerable (banned/held/reserved).
-- We can't detect that from a server — but our USERS can, the moment they try to
-- register one and Twitch refuses. This table is that crowd-sourced ground truth:
-- a handle reported here stops cycling back as "open" in future hunts.
--
-- RLS is ON with NO policies → only the service-role key (api/usercheck.js) touches it.

create extension if not exists pgcrypto;

create table if not exists tez_unclaimable (
  handle      text primary key,                 -- lowercased Twitch login
  reports     integer not null default 1,       -- how many users flagged it
  confirmed   boolean not null default false,   -- Emmanuel can promote to "verified"
  first_by    uuid references tez_users(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Atomic insert-or-increment so concurrent reports can't clobber the count.
-- Service role calls this via POST /rest/v1/rpc/report_unclaimable.
create or replace function report_unclaimable(p_handle text, p_user uuid)
returns void
language sql
as $$
  insert into tez_unclaimable (handle, first_by, reports)
  values (lower(p_handle), p_user, 1)
  on conflict (handle) do update
    set reports    = tez_unclaimable.reports + 1,
        updated_at = now();
$$;

alter table tez_unclaimable enable row level security;
-- intentionally no policies: service role bypasses RLS, everyone else is denied.
