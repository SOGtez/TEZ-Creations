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

// Post a payload to a Discord webhook (defaults to the real announcements one).
// Returns true on 2xx. Best-effort.
async function postWebhook(payload, url = webhookUrl()) {
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
  const e = { title, url, description, color, footer: { text: 'AK9 Forensics Unit · The AK9 Awards' } };
  if (deadlineMs) {
    e.fields = [{
      name: closesLabel || 'Closes',
      value: '<t:' + unix(deadlineMs) + ':R>  ·  <t:' + unix(deadlineMs) + ':F>',
    }];
  }
  return e;
}
// A bold, visible call-to-action line ending in the raw URL on its own line, so
// people clearly see there's a link to click (not just the headline).
const cta = (label, url) => '\n\n**' + label + '**\n' + url;

// ---- the message set ----
function nominationsOpen(s) {
  const month = s.month_label ? ' for **' + s.month_label + '**' : '';
  return payload(embed({
    title: '🕵️ The tip line is OPEN — name your suspects',
    url: SITE, color: RED,
    description:
      'A fresh stack of cases just hit the board' + month + ', and the AK9 Forensics Unit needs the ' +
      'community to name a **prime suspect** for every award — Worst Gamer, Chat MVP, Best Duo, Most ' +
      'Loved, and the rest of the lineup.\n\n' +
      'Log in with Twitch (you’ll need to follow the channel), then fill out one tip sheet naming who ' +
      'you think deserves each award. The most-named suspects become the official **finalists** the ' +
      'whole community votes on next round — so your picks decide who even makes the ballot.\n\n' +
      '**One tip sheet per detective. Make ’em count.**' +
      cta('📋 File your tips here:', SITE),
    deadlineMs: s.nominate_deadline ? Date.parse(s.nominate_deadline) : null,
    closesLabel: '🔒 Tip line closes',
  }));
}
function votingLive(s) {
  return payload(embed({
    title: '🗳️ Voting is LIVE — cast your verdict',
    url: SITE, color: YELLOW,
    description:
      'The investigation’s wrapped and the suspects are lined up. For each case, the community ' +
      'narrowed the field down to the top finalists — now it’s on you to deliver a verdict.\n\n' +
      'Log in with Twitch, review the evidence, and **indict your pick** for every award. Your ballot ' +
      'seals the moment you submit, and the standings stay hidden until the final reveal — so no one ' +
      'can watch the numbers or game the result.\n\n' +
      '**One verdict per detective. Choose wisely.**' +
      cta('⚖️ Cast your verdict here:', SITE),
    deadlineMs: s.deadline ? Date.parse(s.deadline) : null,
    closesLabel: '🔒 Voting closes',
  }));
}
function winners(s) {
  const month = (s && s.month_label) ? ' of **' + s.month_label + '**' : '';
  return payload(embed({
    title: '👑 The verdicts are in — case closed',
    url: RESULTS, color: RED,
    description:
      'Every case is sealed and the jury has spoken. The evidence bags are ready to be cut open, one ' +
      'by one, to reveal who the community found **GUILTY** of being the best (and worst)' + month + '.\n\n' +
      'Head to the case files to watch the full reveal ceremony — every winner, the vote breakdowns, ' +
      'and the final standings, laid out like a crime board.\n\n' +
      '**Come see who took home the hardware.**' +
      cta('🔍 Open the case files here:', RESULTS),
  }));
}
function closingSoon(kind, dlMs, last) {
  const vote = kind === 'vote';
  const rel = '<t:' + unix(dlMs) + ':R>';
  let title, description;
  if (!vote && !last) {
    title = '⏳ Tip line closing soon — get your suspects in';
    description =
      'Heads up, detectives — the tip line for the AK9 Awards closes ' + rel + '. If you haven’t named ' +
      'your prime suspects yet, now’s the time. Once it locks, the top names become the finalists and ' +
      'there’s no adding more.\n\nDon’t let your picks land on the record too late.' +
      cta('📋 File your tips here:', SITE);
  } else if (!vote && last) {
    title = '🚨 LAST CALL — nominations lock soon';
    description =
      'Final warning. The tip line closes ' + rel + ' and the case board seals for good. This is your ' +
      'last chance to name a suspect for each award before the finalists are locked in.\n\n' +
      '**Get in there before it’s sealed.**' + cta('📋 File your tips now:', SITE);
  } else if (vote && !last) {
    title = '⏳ Voting closing soon — cast your verdict';
    description =
      'The clock’s running down — voting for the AK9 Awards closes ' + rel + '. If you haven’t delivered ' +
      'your verdict on each case yet, get it in before the ballots seal. Every vote counts toward who ' +
      'takes home the hardware.' + cta('⚖️ Cast your verdict here:', SITE);
  } else {
    title = '🚨 LAST CALL to vote — ballots seal soon';
    description =
      'Final warning. Voting closes ' + rel + '. This is your last chance to weigh in on who’s guilty of ' +
      'being the best in the community. After this, the verdicts are final.\n\n' +
      '**Make it count.**' + cta('⚖️ Vote now:', SITE);
  }
  return payload(embed({
    title, url: SITE, color: YELLOW, description,
    deadlineMs: dlMs, closesLabel: vote ? '🔒 Voting closes' : '🔒 Tip line closes',
  }));
}

// ---- preview mode (perfect the wording in a PRIVATE channel first) ----
const previewWebhookUrl = () => process.env.DISCORD_PREVIEW_WEBHOOK_URL || '';
const PREVIEW_TYPES = ['nominate', 'nom-soon', 'nom-last', 'vote', 'vote-soon', 'vote-last', 'closed'];
// Build any one announcement on demand (uses real deadlines if set, else a fake +24h
// so the countdown still renders). Returns the normal @everyone payload.
function previewPayload(which, s) {
  const nomDl = s.nominate_deadline ? Date.parse(s.nominate_deadline) : Date.now() + DAY;
  const voteDl = s.deadline ? Date.parse(s.deadline) : Date.now() + DAY;
  switch (which) {
    case 'nominate':  return nominationsOpen(s);
    case 'vote':      return votingLive(s);
    case 'closed':    return winners(s);
    case 'nom-soon':  return closingSoon('nominate', nomDl, false);
    case 'nom-last':  return closingSoon('nominate', nomDl, true);
    case 'vote-soon': return closingSoon('vote', voteDl, false);
    case 'vote-last': return closingSoon('vote', voteDl, true);
    default: return null;
  }
}
// A preview clone of a payload: same embed, NO @everyone, clearly labelled.
function asPreview(p) {
  return {
    username: p.username,
    content: '🔧 **PREVIEW** — practice post (not announced, no ping)',
    allowed_mentions: { parse: [] },
    embeds: p.embeds,
  };
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
    if (!notified.closed) due.push({ flag: 'closed', payload: winners(s) });
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
//   GET /api/ak9?route=cron&key=<CRON_SECRET>                → run due announcements (real channel)
//   GET /api/ak9?route=cron&key=<CRON_SECRET>&test=1         → fire a test post (real channel)
//   GET /api/ak9?route=cron&key=<CRON_SECRET>&preview=<type> → practice post to the PRIVATE channel
//        (no @everyone, no state change; type ∈ nominate|nom-soon|nom-last|vote|vote-soon|
//         vote-last|closed|all). Needs DISCORD_PREVIEW_WEBHOOK_URL.
export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const secret = process.env.CRON_SECRET;
  if (!secret) { res.status(503).json({ error: 'Cron not configured (set CRON_SECRET).' }); return; }
  if (String(req.query.key || '') !== secret) { res.status(401).json({ error: 'Unauthorized.' }); return; }

  try {
    // PREVIEW: fire practice posts to a PRIVATE channel — no @everyone, no state change.
    //   &preview=<type>  where type ∈ nominate|nom-soon|nom-last|vote|vote-soon|vote-last|closed|all
    const pv = String(req.query.preview || '');
    if (pv) {
      const purl = previewWebhookUrl();
      if (!purl) { res.status(503).json({ error: 'Preview channel not configured (set DISCORD_PREVIEW_WEBHOOK_URL).' }); return; }
      const s = (await loadSettings()) || {};
      const list = pv === 'all' ? PREVIEW_TYPES : [pv];
      let posted = 0; const unknown = [];
      for (const w of list) {
        const p = previewPayload(w, s);
        if (!p) { unknown.push(w); continue; }
        if (await postWebhook(asPreview(p), purl)) posted++;
      }
      res.status(200).json({ ok: true, preview: true, posted, unknown, types: PREVIEW_TYPES }); return;
    }

    // Everything below posts to the REAL announcements channel.
    if (!webhookUrl()) { res.status(503).json({ error: 'Discord webhook not configured (set DISCORD_WEBHOOK_URL).' }); return; }
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
