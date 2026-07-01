-- TEZ Creations — universal account tiers (site-wide, not just Handle Hunter).
-- Run once in the Supabase SQL editor (same project as auth-schema.sql).
--
-- Tiers, low → high:  free  <  pro  <  exclusive
--   free      — default, basic access
--   pro       — paid (Stripe, later). Premium features across every drop.
--   exclusive — invite-only, granted by hand. Gets everything Pro has, plus extras.
--
-- The old `pro` boolean stays for backward-compat but `tier` is now the source of
-- truth (api/auth.js derives pro/exclusive from it).

alter table tez_users add column if not exists tier text not null default 'free';

-- Backfill: anyone already flagged pro=true becomes the 'pro' tier.
update tez_users set tier = 'pro' where pro = true and tier = 'free';

-- Only allow known tier values.
alter table tez_users drop constraint if exists tez_users_tier_chk;
alter table tez_users add constraint tez_users_tier_chk
  check (tier in ('free', 'pro', 'exclusive'));

create index if not exists tez_users_tier_idx on tez_users (tier);

-- ── Granting access by hand ─────────────────────────────────────────────
--   Exclusive (invite):  update tez_users set tier = 'exclusive' where code = 'TEZ-XXXXX';
--   Pro (comp a friend):  update tez_users set tier = 'pro'       where code = 'TEZ-XXXXX';
--   Revoke:               update tez_users set tier = 'free'      where code = 'TEZ-XXXXX';
