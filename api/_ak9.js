// AK9 AWARDS — shared backend helpers (NOT an endpoint; the leading underscore
// keeps Vercel from turning this file into a Serverless Function). Imported by
// the ak9-*.js route handlers. No SDK — plain fetch, keeps the project build-free.
//
// Env (Vercel → Settings → Environment Variables):
//   TWITCH_CLIENT_SECRET       Twitch app secret — SERVER ONLY
//   SUPABASE_URL               project URL (same one the other tools use)
//   SUPABASE_SERVICE_ROLE_KEY  service role key — SERVER ONLY
//   AK9_ADMINS                 comma-separated Twitch LOGINS allowed in the admin page
//                              (e.g. "aleksk9_,sogtez"). Case-insensitive. Extend anytime.

// Public Twitch client id — reuses the existing Confidential app (safe to hardcode).
export const CLIENT_ID = 'i5n7ykd3ns3n0fxgbith466dnj51fc';

// The channel voters must follow, and the broadcaster who connects for follower checks.
export const CHANNEL_LOGIN = 'aleksk9_';

// Only allow code exchanges for our own registered redirect URI(s).
export const ALLOWED_REDIRECTS = [
  'https://www.tezcreations.com/ak9awards/',
  'https://tezcreations.com/ak9awards/',
  'http://localhost:3000/ak9awards/',
];

export const env = () => ({
  secret: process.env.TWITCH_CLIENT_SECRET,
  sbUrl: process.env.SUPABASE_URL,
  sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  admins: String(process.env.AK9_ADMINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
});
export const configured = () => { const e = env(); return !!(e.secret && e.sbUrl && e.sbKey); };

export function isAdminLogin(login) {
  return env().admins.includes(String(login || '').toLowerCase());
}

// ---- tiny Supabase REST wrapper (service role) ----
export async function sb(method, path, { body, prefer } = {}) {
  const e = env();
  const headers = { apikey: e.sbKey, Authorization: 'Bearer ' + e.sbKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(e.sbUrl + '/rest/v1/' + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
  return { ok: r.ok, status: r.status, json, text };
}

// ---- Twitch app token (client credentials) for public lookups, cached warm ----
let appTok = null;   // { token, exp(ms) }
async function appToken() {
  const now = Date.now();
  if (appTok && appTok.exp - 60000 > now) return appTok.token;
  const e = env();
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: e.secret, grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('ak9 app token ' + r.status);
  appTok = { token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return appTok.token;
}

// Resolve Twitch logins → profile pictures. Returns Map(login → { login,
// display_name, profile_image_url }). Invalid/unknown logins simply aren't in
// the map. Best-effort — throws are the caller's to swallow.
export async function twitchProfiles(logins) {
  const clean = [...new Set(logins.map(l => String(l || '').trim().toLowerCase().replace(/^@/, ''))
    .filter(l => /^[a-z0-9_]{3,25}$/.test(l)))].slice(0, 100);
  if (!clean.length) return new Map();
  const tok = await appToken();
  const qs = clean.map(l => 'login=' + encodeURIComponent(l)).join('&');
  const r = await fetch('https://api.twitch.tv/helix/users?' + qs,
    { headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + tok } });
  if (!r.ok) return new Map();
  const j = await r.json().catch(() => null);
  const map = new Map();
  (j && j.data || []).forEach(u => map.set((u.login || '').toLowerCase(),
    { login: u.login, display_name: u.display_name, profile_image_url: u.profile_image_url }));
  return map;
}

// ---- Twitch token validation (identity), cached briefly on warm instances ----
const valCache = {};   // accessToken -> { user_id, login, exp(ms) }
export async function validateToken(accessToken) {
  if (!accessToken) return null;
  const now = Date.now();
  const hit = valCache[accessToken];
  if (hit && hit.exp > now) return { user_id: hit.user_id, login: hit.login };
  const r = await fetch('https://id.twitch.tv/oauth2/validate',
    { headers: { Authorization: 'OAuth ' + accessToken } });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.user_id) return null;
  if (Object.keys(valCache).length > 800) for (const k in valCache) delete valCache[k];
  // cache for the shorter of the token's life or 5 min
  valCache[accessToken] = { user_id: j.user_id, login: j.login,
    exp: now + Math.min((j.expires_in || 300), 300) * 1000 };
  return { user_id: j.user_id, login: j.login };
}

// Pull the bearer token off a request.
export function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

// ---- broadcaster access token (for follower checks): refresh from stored token ----
let bcCache = null;   // { access_token, broadcaster_id, login, exp(ms) }
export async function getBroadcaster() {
  const now = Date.now();
  if (bcCache && bcCache.exp - 60000 > now) return bcCache;
  const e = env();
  const row = (await sb('GET', 'ak9_broadcaster?id=eq.1&select=broadcaster_id,login,refresh_token&limit=1')).json;
  const rec = (row || [])[0];
  if (!rec || !rec.refresh_token) return null;        // not connected yet
  const tok = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: e.secret,
      grant_type: 'refresh_token', refresh_token: rec.refresh_token,
    }),
  });
  const tj = await tok.json();
  if (!tok.ok || !tj.access_token) return null;       // refresh dead → broadcaster must reconnect
  if (tj.refresh_token && tj.refresh_token !== rec.refresh_token) {
    sb('PATCH', 'ak9_broadcaster?id=eq.1', {
      body: { refresh_token: tj.refresh_token, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    }).catch(() => {});
  }
  bcCache = { access_token: tj.access_token, broadcaster_id: rec.broadcaster_id,
    login: rec.login, exp: now + (tj.expires_in || 3600) * 1000 };
  return bcCache;
}

// Raw broadcaster-connection state for the admin diagnostic — does NOT refresh
// the token (so it distinguishes "nothing saved" / "table missing" from a saved
// row whose token is failing). Never returns the refresh_token itself.
export async function getBroadcasterRaw() {
  const r = await sb('GET', 'ak9_broadcaster?id=eq.1&select=login,scope,broadcaster_id,updated_at,refresh_token&limit=1');
  if (!r.ok) {
    const missing = r.status === 404 || (r.json && r.json.code === '42P01') || /does not exist|find the table/i.test(r.text || '');
    return { tableMissing: !!missing, readError: true, hasRow: false };
  }
  const rec = (r.json || [])[0];
  if (!rec) return { hasRow: false };
  return {
    hasRow: !!rec.refresh_token,           // boolean only — the token never leaves the server
    login: rec.login || '', scope: rec.scope || '',
    broadcaster_id: rec.broadcaster_id || '', updated_at: rec.updated_at || '',
  };
}

// Does userId follow the AK9 channel? null = can't determine (not configured).
export async function checkFollows(userId) {
  const bc = await getBroadcaster();
  if (!bc || !bc.broadcaster_id) return null;
  const r = await fetch('https://api.twitch.tv/helix/channels/followers?broadcaster_id=' +
    encodeURIComponent(bc.broadcaster_id) + '&user_id=' + encodeURIComponent(userId),
    { headers: { Authorization: 'Bearer ' + bc.access_token, 'Client-Id': CLIENT_ID } });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j.data) && j.data.length > 0;
}

// Live self-test: can the stored token actually read the channel's followers?
// Twitch requires the token's user to BE the broadcaster or a MODERATOR of the
// channel — a 401/403 here means the connected account isn't a mod.
export async function probeFollowerApi() {
  const bc = await getBroadcaster();
  if (!bc || !bc.broadcaster_id) return { ok: false, reason: 'not-connected' };
  const r = await fetch('https://api.twitch.tv/helix/channels/followers?first=1&broadcaster_id=' +
    encodeURIComponent(bc.broadcaster_id),
    { headers: { Authorization: 'Bearer ' + bc.access_token, 'Client-Id': CLIENT_ID } });
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    return { ok: true, total: typeof j.total === 'number' ? j.total : null };
  }
  return { ok: false, status: r.status,
    reason: (r.status === 401 || r.status === 403) ? 'not-a-moderator' : 'api-error' };
}

// Twitch profile (display name + avatar) for a verified user.
export async function getProfile(accessToken, userId) {
  try {
    const r = await fetch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId),
      { headers: { Authorization: 'Bearer ' + accessToken, 'Client-Id': CLIENT_ID } });
    const j = await r.json();
    const me = (j.data || [])[0] || {};
    return { display_name: me.display_name || '', profile_image_url: me.profile_image_url || '' };
  } catch (_) { return { display_name: '', profile_image_url: '' }; }
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

export function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  return body || {};
}
