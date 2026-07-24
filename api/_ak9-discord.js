// AK9 AWARDS — Discord announcements (webhook, one-way). Posts crime-themed embeds
// to a channel webhook when the awards phase changes and as closing-soon reminders.
// NOT its own Vercel function: the cron handler is dispatched from api/ak9.js
// (?route=cron) and `announce()` is called by _ak9-admin.js after a phase flip.
//
// Owner setup (all one-time):
//   1. Discord → Server Settings → Integrations → Webhooks → New Webhook → pick the
//      announcements channel → Copy URL.
//   2. Vercel env: DISCORD_WEBHOOK_URL = that URL; CRON_SECRET = any long random string.
//   3. Supabase: `alter table ak9_settings add column if not exists notified jsonb default '{}'::jsonb;`
//   4. Schedule cron-job.org (free) to GET  …/api/ak9?route=cron&key=<CRON_SECRET>  ~1–2×/day.
//      Test the webhook once:  …/api/ak9?route=cron&key=<CRON_SECRET>&test=1
//
// The bot is inert until DISCORD_WEBHOOK_URL is set — nothing posts before then.

import { sb, cors } from './_ak9.js';

const SITE = 'https://www.tezcreations.com/ak9awards';
const RESULTS = SITE + '/results';
const RED = 0xd5342a;     // evidence
const YELLOW = 0xf2c115;  // tape
const DAY = 86400000, HOUR = 3600000;

const webhookUrl = () => process.env.DISCORD_WEBHOOK_URL || '';
const unix = (ms) => Math.floor(ms / 1000);

// Post a payload to the Discord webhook. Returns true on 2xx. Best-effort.
async function postWebhook(payload) {
  const url = webhookUrl();
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok;   // Discord returns 204 on success
  } catch (_) { return false; }
}

// Wrap an embed in a webhook payload with the forensic identity + @everyone ping.
function payload(embed) {
  return {
    username: 'AK9 Forensics Unit',
    content: '@everyone',
    allowed_mentions: { parse: ['everyone'] },
    embeds: [embed],
  };
}
function embed({ title, url, description, color, deadlineMs, closesLabel }) {
  const e = { title, url, description, color, footer: { text: 'AK9 Forensics Unit' } };
  if (deadlineMs) {
    e.fields = [{
      name: closesLabel || 'Closes',
      value: '<t:' + unix(deadlineMs) + ':R> · <t:' + unix(deadlineMs) + ':f>',
    }];
  }
  return e;
}

// ---- the message set ----
function nominationsOpen(s) {
  return payload(embed({
    title: '🕵️ The tip line is OPEN — name your suspects',
    url: SITE, color: RED,
    description: 'A new case board just dropped' + (s.month_label ? ' for **' + s.month_label + '**' : '') +
      '. Log in with Twitch and name your **prime suspect** for every award — the top tips become the ' +
      'finalists. One tip sheet per detective.',
    deadlineMs: s.nominate_deadline ? Date.parse(s.nominate_deadline) : null,
    closesLabel: 'Tip line closes',
  }));
}
function votingLive(s) {
  return payload(embed({
    title: '🗳️ Voting is LIVE — cast your verdict',
    url: SITE, color: YELLOW,
    description: 'The suspects are in the line-up. Review the evidence and **indict** your pick for each ' +
      'case. One verdict per detective — sealed until the reveal.',
    deadlineMs: s.deadline ? Date.parse(s.deadline) : null,
    closesLabel: 'Voting closes',
  }));
}
function winners() {
  return payload(embed({
    title: '👑 The verdicts are in — case closed',
    url: RESULTS, color: RED,
    description: "Every case is sealed and the verdicts are final. Cut open the evidence bags and see " +
      "who's **GUILTY**.",
  }));
}
function closingSoon(kind, dlMs, last) {
  const vote = kind === 'vote';
  const title = last
    ? (vote ? '⏳ Last call to vote' : '⏳ Last call — the tip line closes soon')
    : (vote ? '⏳ Voting closing soon' : '⏳ Tip line closing soon');
  const description = vote
    ? 'Voting closes <t:' + unix(dlMs) + ':R>. Cast your verdict before the case seals for good.'
    : 'Nominations close <t:' + unix(dlMs) + ':R>. Get your prime suspects in before the board locks.';
  return payload(embed({ title, url: SITE, color: YELLOW, description }));
}

// Load the singleton settings row (select=* so a missing `notified` column never breaks it).
async function loadSettings() {
  const rows = (await sb('GET', 'ak9_settings?id=eq.1&select=*&limit=1')).json;
  return (rows || [])[0] || null;
}

// Core: figure out which announcements are DUE and unsent, mark them, then post.
// Idempotent via the `notified` flags (reset to {} on a phase change — see _ak9-admin).
// Called by the cron route AND by admin save_settings after a phase flip.
// RESERVE-THEN-POST: we persist the flags BEFORE posting, so a missing `notified`
// column (setup SQL not run) fails safe with ZERO posts rather than spamming @everyone.
export async function announce() {
  if (!webhookUrl()) return { ok: false, reason: 'no-webhook', posted: 0 };
  const s = await loadSettings();
  if (!s) return { ok: false, reason: 'no-settings', posted: 0 };

  const phase = s.phase || 'vote';
  const notified = (s.notified && typeof s.notified === 'object') ? { ...s.notified } : {};
  const now = Date.now();
  const due = [];   // { flag, payload }

  if (phase === 'nominate') {
    const openMs = s.nominate_open ? Date.parse(s.nominate_open) : null;
    const isOpen = !openMs || now >= openMs;   // respects the scheduled-open gate
    if (isOpen && !notified.nom_open) due.push({ flag: 'nom_open', payload: nominationsOpen(s) });
    const dl = s.nominate_deadline ? Date.parse(s.nominate_deadline) : null;
    if (isOpen && dl && dl > now) {
      const left = dl - now;
      if (left <= DAY && left > 3 * HOUR && !notified.nom_24) due.push({ flag: 'nom_24', payload: closingSoon('nominate', dl, false) });
      if (left <= 3 * HOUR && !notified.nom_3) due.push({ flag: 'nom_3', payload: closingSoon('nominate', dl, true) });
    }
  } else if (phase === 'vote') {
    if (!notified.vote_open) due.push({ flag: 'vote_open', payload: votingLive(s) });
    const dl = s.deadline ? Date.parse(s.deadline) : null;
    if (dl && dl > now) {
      const left = dl - now;
      if (left <= DAY && left > 3 * HOUR && !notified.vote_24) due.push({ flag: 'vote_24', payload: closingSoon('vote', dl, false) });
      if (left <= 3 * HOUR && !notified.vote_3) due.push({ flag: 'vote_3', payload: closingSoon('vote', dl, true) });
    }
  } else if (phase === 'closed') {
    if (!notified.closed) due.push({ flag: 'closed', payload: winners() });
  }

  if (!due.length) return { ok: true, posted: 0 };

  // reserve first
  due.forEach(d => { notified[d.flag] = true; });
  const saved = await sb('PATCH', 'ak9_settings?id=eq.1', { body: { notified }, prefer: 'return=minimal' });
  if (!saved.ok) return { ok: false, reason: 'notified-save-failed (run the setup SQL?)', posted: 0 };

  let posted = 0;
  for (const d of due) { if (await postWebhook(d.payload)) posted++; }
  return { ok: true, posted, of: due.length };
}

// Fire a one-off test post to confirm the webhook is wired (ignores flags).
async function testPost() {
  return postWebhook(payload(embed({
    title: '✅ AK9 Forensics Unit — webhook wired',
    url: SITE, color: YELLOW,
    description: "Test transmission received. Announcements will post here when the case phase changes.",
  })));
}

// Default export = the ?route=cron handler (dispatched from api/ak9.js).
//   GET /api/ak9?route=cron&key=<CRON_SECRET>          → run due announcements
//   GET /api/ak9?route=cron&key=<CRON_SECRET>&test=1   → fire a test post
export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const secret = process.env.CRON_SECRET;
  if (!secret) { res.status(503).json({ error: 'Cron not configured (set CRON_SECRET).' }); return; }
  if (String(req.query.key || '') !== secret) { res.status(401).json({ error: 'Unauthorized.' }); return; }
  if (!webhookUrl()) { res.status(503).json({ error: 'Discord webhook not configured (set DISCORD_WEBHOOK_URL).' }); return; }

  try {
    if (String(req.query.test || '') === '1') {
      const ok = await testPost();
      res.status(ok ? 200 : 502).json({ ok, test: true }); return;
    }
    const r = await announce();
    res.status(r.ok ? 200 : 502).json(r);
  } catch (err) {
    console.error('ak9-cron', err);
    res.status(502).json({ error: 'Cron run failed.' });
  }
}
