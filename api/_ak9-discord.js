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

// Build a full announcement: the SITUATION goes in the plain-text message (with the
// @everyone ping), and a compact embed carries just the call-to-action link + deadline.
function msg({ text, title, url, linkLabel, linkUrl, color, deadlineMs, closesLabel }) {
  const card = { title, url, color, footer: { text: 'The AK9 Awards · AK9 Forensics Unit' } };
  if (linkLabel && linkUrl) card.description = '**' + linkLabel + '**\n' + linkUrl;
  if (deadlineMs) {
    card.fields = [{
      name: closesLabel || 'Closes',
      value: '<t:' + unix(deadlineMs) + ':R>  ·  <t:' + unix(deadlineMs) + ':F>',
    }];
  }
  return {
    username: 'AK9 Forensics Unit',
    content: '@everyone\n\n' + text,
    allowed_mentions: { parse: ['everyone'] },
    embeds: [card],
  };
}

// ---- the message set (plain text = hype/explanation; embed = link + deadline) ----
function nominationsOpen(s) {
  const month = s.month_label ? ' for **' + s.month_label + '**' : '';
  return msg({
    text:
      '🚨 The AK9 Awards are BACK and the tip line is officially **OPEN**! 🕵️\n\n' +
      'It’s time to put the community on record' + month + '. For every award — Worst Gamer, Chat MVP, ' +
      'Best Duo, Most Loved and the whole lineup — we need **YOU** to name your prime suspect. Whoever ' +
      'racks up the most tips becomes an official **finalist**, so your picks literally decide who even ' +
      'makes the ballot! 👀\n\n' +
      'Grab your badge, log in with Twitch, and file one tip sheet — let’s build these cases! 🔥',
    title: '🕵️ File your tips', url: SITE, color: RED,
    linkLabel: '📋 Name your suspects here:', linkUrl: SITE,
    deadlineMs: s.nominate_deadline ? Date.parse(s.nominate_deadline) : null,
    closesLabel: '🔒 Tip line closes',
  });
}
function votingLive(s) {
  return msg({
    text:
      '🚨 The suspects are locked in and **VOTING IS LIVE**! 🗳️\n\n' +
      'The community narrowed every case down to the finalists — now it’s on **YOU** to deliver the ' +
      'verdict. Review the lineup, back your pick for each award, and lock it in. Ballots seal the second ' +
      'you submit and the results stay hidden until the big reveal, so no peeking and no gaming it. 😤\n\n' +
      'This is where champions get crowned — go make your voice count! 🔥',
    title: '⚖️ Cast your verdict', url: SITE, color: YELLOW,
    linkLabel: '🗳️ Vote here:', linkUrl: SITE,
    deadlineMs: s.deadline ? Date.parse(s.deadline) : null,
    closesLabel: '🔒 Voting closes',
  });
}
function winners(s) {
  const month = (s && s.month_label) ? ' of **' + s.month_label + '**' : '';
  return msg({
    text:
      '👑 The jury has spoken — **CASE CLOSED**! 🎉\n\n' +
      'Every verdict is in and the evidence bags are ready to be cut open, one by one. Come find out who ' +
      'the community crowned the best — and busted as the worst' + month + '! Full reveal ceremony, vote ' +
      'breakdowns, and final standings, all laid out on the board. 🔍\n\n' +
      'You do **NOT** want to miss this one — let’s crown ’em! 🏆',
    title: '🔍 Open the case files', url: RESULTS, color: RED,
    linkLabel: '🏆 See the winners here:', linkUrl: RESULTS,
  });
}
function closingSoon(kind, dlMs, last) {
  const vote = kind === 'vote';
  const rel = '<t:' + unix(dlMs) + ':R>';
  let text, title, linkLabel;
  if (!vote && !last) {
    text =
      '⏳ Heads up, detectives — the tip line is closing **SOON**!\n\n' +
      'You’ve still got a little time to name your prime suspects, but the clock’s ticking (closes ' + rel + '). ' +
      'Once it locks, the finalists are set in stone — no more names after that. Don’t let your picks miss the cut! 🔥';
    title = '📋 File your tips'; linkLabel = '📋 Name your suspects here:';
  } else if (!vote && last) {
    text =
      '🚨 **LAST CALL** — nominations are about to LOCK! 🚨\n\n' +
      'This is it — the final stretch to get your suspects on the record (tip line closes ' + rel + '). After this ' +
      'the case board seals for good. If you’ve been sitting on your picks, **now** is the time — go go go! 🏃💨';
    title = '📋 File your tips NOW'; linkLabel = '📋 Last chance — nominate here:';
  } else if (vote && !last) {
    text =
      '⏳ The clock is ticking — voting is closing **SOON**!\n\n' +
      'Haven’t cast your verdict yet? Don’t sleep on it — voting closes ' + rel + '. Every single vote counts ' +
      'toward who takes home the hardware. Get in there and make it count! 🔥';
    title = '⚖️ Cast your verdict'; linkLabel = '🗳️ Vote here:';
  } else {
    text =
      '🚨 **LAST CALL** to vote — ballots seal any minute! 🚨\n\n' +
      'Final warning, detectives! This is your last shot to weigh in on who’s guilty of being the best in ' +
      'the community (voting closes ' + rel + '). After this, the verdicts are **FINAL**. Don’t miss it — vote now! 🗳️🔥';
    title = '⚖️ Vote NOW'; linkLabel = '🗳️ Last chance — vote here:';
  }
  return msg({
    text, title, url: SITE, color: YELLOW,
    linkLabel, linkUrl: SITE,
    deadlineMs: dlMs, closesLabel: vote ? '🔒 Voting closes' : '🔒 Tip line closes',
  });
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
// A preview clone of a payload: full message text + embed, but the @everyone ping
// stripped and mentions disabled, clearly labelled as practice.
function asPreview(p) {
  const body = String(p.content || '').replace(/^@everyone\s*/, '');
  return {
    username: p.username,
    content: '🔧 **PREVIEW** — practice post (not announced, no ping)\n\n' + body,
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
  return postWebhook(msg({
    text: 'Test transmission received. ✅ Announcements will post here when the case phase changes.',
    title: '✅ AK9 Forensics Unit — webhook wired',
    url: SITE, color: YELLOW,
  }));
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
