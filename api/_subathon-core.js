// TEZ Creations — Drop #009 Subathon Timer: shared core.
// Imported by eventsub.js (Twitch), kick-webhook.js (Kick) and _subathon.js
// (dashboard API). Underscore helper = bundled, not its own function.
//
// The timer is stored as an END TIMESTAMP (ends_at), never a running countdown —
// overlays/pages just render (ends_at - now), so reloads can't lose time.
// While paused, remaining = (ends_at - paused_at); resume shifts ends_at forward
// by the pause duration. A sub always does ends_at += seconds (works identically
// whether running or paused).

const env = () => ({
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
export const coreConfigured = () => { const e = env(); return !!(e.sbUrl && e.sbKey); };

export async function sbCore(method, path, { body, prefer } = {}) {
  const e = env();
  const headers = { apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(e.sbUrl + '/rest/v1/' + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
  return { ok: r.ok, status: r.status, json };
}

// ---- settings (defaults + clamps) ----------------------------------------
export const DEFAULT_SETTINGS = {
  sec_per_sub: 60,        // seconds added per sub / per gifted sub
  cap_hours: 0,           // 0 = no cap; otherwise the timer can never exceed this
  count_resubs: false,    // [pro] resub messages also add time
  tier_mult_on: false,    // [pro] Tier 2/3 subs add more
  tier_mult: { t2: 2, t3: 5 },
  style: {                // [pro beyond defaults]
    theme: 'tez',         // tez | minimal | neon
    accent: '#3fe08b',
    label: 'SUBATHON',
    show_label: true,
    show_toasts: true,
    size: 100,            // scale %
  },
};

export function withDefaults(s) {
  const x = s && typeof s === 'object' ? s : {};
  return {
    ...DEFAULT_SETTINGS, ...x,
    tier_mult: { ...DEFAULT_SETTINGS.tier_mult, ...(x.tier_mult || {}) },
    style: { ...DEFAULT_SETTINGS.style, ...(x.style || {}) },
  };
}

// ---- event → time --------------------------------------------------------
// kind: 'sub' | 'gift' | 'resub'.  tier: Twitch '1000'|'2000'|'3000' (Kick: none).
function secondsFor(settings, kind, tier, count) {
  const s = withDefaults(settings);
  if (kind === 'resub' && !s.count_resubs) return 0;
  let per = Math.max(0, +s.sec_per_sub || 0);
  if (s.tier_mult_on) {
    if (tier === '2000') per *= Math.max(1, +s.tier_mult.t2 || 1);
    else if (tier === '3000') per *= Math.max(1, +s.tier_mult.t3 || 1);
  }
  return Math.round(per * Math.max(1, count | 0));
}

// Add time to the timer connected to this broadcaster (if any, and if running).
// Fire-and-forget from the webhook handlers: never throws.
export async function subathonEvent({ platform, broadcasterId, kind, name, count = 1, tier = '1000' }) {
  try {
    if (!coreConfigured() || !broadcasterId) return;
    const col = platform === 'kick' ? 'kick_broadcaster_id' : 'twitch_broadcaster_id';
    const q = await sbCore('GET', 'subathon_timers?' + col + '=eq.' + encodeURIComponent(broadcasterId) +
      '&select=id,settings,ends_at,paused_at,stats&limit=1');
    const t = q.json && q.json[0];
    if (!t || !t.ends_at) return;                       // no timer / not started

    const now = Date.now();
    const base = t.paused_at ? Date.parse(t.paused_at) : now;
    const remaining = Date.parse(t.ends_at) - base;
    if (remaining <= 0) return;                          // subathon already ended

    const secs = secondsFor(t.settings, kind, tier, count);
    if (secs <= 0) return;                               // e.g. resubs disabled

    const s = withDefaults(t.settings);
    const capMs = s.cap_hours > 0 ? s.cap_hours * 3600000 : Infinity;
    const newRemaining = Math.min(remaining + secs * 1000, capMs);
    const endsAt = new Date(base + newRemaining).toISOString();

    const stats = t.stats && typeof t.stats === 'object' ? t.stats : {};
    const key = kind === 'resub' ? 'resubs' : 'subs';
    stats[key] = (stats[key] | 0) + Math.max(1, count | 0);
    stats.added_sec = (stats.added_sec | 0) + Math.round((newRemaining - remaining) / 1000);

    await sbCore('PATCH', 'subathon_timers?id=eq.' + encodeURIComponent(t.id), {
      body: {
        ends_at: endsAt, stats,
        last_event: { kind, name: String(name || '').slice(0, 60), count: Math.max(1, count | 0), secs, at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      },
      prefer: 'return=minimal',
    });
  } catch (err) {
    console.error('subathon event', err);   // never break the calling webhook
  }
}
