-- TEZ Creations — time-limited tier grants (comp a friend Pro for a month, etc.).
-- Run once in the Supabase SQL editor (adds one nullable column).
--
-- How it works: set `pro_until` to a future timestamp alongside a tier. The backend
-- (api/auth.js) checks it on every login / session-refresh: once the date passes, the
-- account auto-reverts to 'free' (and the DB self-heals). Leave pro_until NULL for a
-- permanent grant (e.g. Exclusive for a partner).

alter table tez_users add column if not exists pro_until timestamptz;

-- ── Granting timed access ───────────────────────────────────────────────
--   1 month of Pro:   update tez_users set tier='pro', pro_until = now() + interval '1 month' where code='TEZ-XXXXX';
--   1 week of Pro:     update tez_users set tier='pro', pro_until = now() + interval '7 days'  where code='TEZ-XXXXX';
--   Make it permanent: update tez_users set pro_until = null where code='TEZ-XXXXX';
--   End it now:        update tez_users set tier='free', pro_until = null where code='TEZ-XXXXX';
