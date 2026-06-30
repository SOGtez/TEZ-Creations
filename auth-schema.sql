-- TEZ Creations — accounts table for sign up / log in (api/auth.js).
-- Run once in the Supabase project (SQL editor). Uses the same project as the
-- other tools. RLS is ON with NO policies → the public/anon key can't touch it;
-- only the service-role key (used server-side by api/auth.js) bypasses RLS.

create extension if not exists pgcrypto;

create table if not exists tez_users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,          -- stored lowercased
  name       text not null,
  pass_hash  text not null,                 -- scrypt: "s2$<salt-hex>$<hash-hex>"
  pro        boolean not null default false, -- premium flag (Handle Hunter etc.)
  created_at timestamptz not null default now()
);

-- Fast case-exact email lookups (the unique index already covers this, but be explicit).
create unique index if not exists tez_users_email_key on tez_users (email);

alter table tez_users enable row level security;
-- intentionally no policies: service role bypasses RLS, everyone else is denied.
