/* ===== TEZ Creations — Gauntlet config =====
   Fill these in with your Supabase project's values.
   Find them in Supabase → Project Settings → API.

   The anon key is safe to expose in a browser source (it's the public key),
   but anyone who has it + a board id could write to your board. For a stream
   overlay that's low-stakes; just use a hard-to-guess board id. You can tighten
   the RLS policies later (see schema.sql) if you want.
*/
const SUPABASE_URL = "https://taodbtlgpvaabvcnsekg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_imq8qxgP3woB_umzNjMDSw_4CpBrgvp"; // Supabase "publishable" (public) key — safe in the browser

/* If false, winning the ACTIVE game just clears the badge (you fire !active
   for the next one). If true, the badge auto-jumps to the next un-crossed game. */
const AUTO_ADVANCE_ACTIVE = false;
