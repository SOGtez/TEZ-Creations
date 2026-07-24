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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Post a payload to a Discord webhook (defaults to the real announcements one).
// Returns true on 2xx. Honors Discord's 429 rate limit (waits retry_after, up to 2 retries).
async function postWebhook(payload, url = webhookUrl()) {
  if (!url) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 429) {                                  // rate limited → wait + retry
        let wait = 1000;
        try { const j = await r.json(); if (j && j.retry_after) wait = Math.ceil(j.retry_after * 1000) + 100; } catch (_) {}
        await sleep(Math.min(wait, 4000));
        continue;
      }
      return r.ok;   // Discord returns 204 on success
    } catch (_) { return false; }
  }
  return false;
}
// Post a list sequentially with a small gap, so a batch (e.g. preview=all) stays
// under Discord's per-webhook rate limit. Returns how many succeeded.
async function postAll(payloads, url) {
  let n = 0;
  for (let i = 0; i < payloads.length; i++) {
    if (i) await sleep(350);
    if (await postWebhook(payloads[i], url)) n++;
  }
  return n;
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

// ---- twice-a-day reminders (rotating copy while a phase is open) ----
// Fired on every cron run while nominations/voting are open, so with a 2x/day cron
// the community gets a fresh nudge twice daily. Escalates to closing-soon / last-call
// automatically as the deadline nears. `n` rotates the copy so it isn't identical.
const NOMINATE_REMINDERS = [
  '🕵️ Still time to make your case! The AK9 Awards tip line is OPEN — swing by and name your ' +
    'prime suspect for each award. Your nominations decide who even makes the finalists! 🔥',
  '📋 Detectives, we still need your tips! Every award needs suspects — Worst Gamer, Chat MVP, ' +
    'Best Duo and the rest. Log in with Twitch and drop your picks before the board locks. 👀',
  '🚨 Don’t sit on the sidelines! Nominations for the AK9 Awards are live right now. Name who ' +
    'deserves each award — the most-tipped names become the official finalists. 💪',
  '🔎 Who’s guilty of being the GOAT? The tip line’s open — put your community picks on the ' +
    'record for every award. One tip sheet per detective, so make ’em count! 🏆',
];
const VOTE_REMINDERS = [
  '🗳️ Voting’s still LIVE! Haven’t cast your verdict yet? Jump in and back your pick for every ' +
    'award — every single vote counts toward who takes home the hardware. 🔥',
  '⚖️ The jury needs YOU! Voting for the AK9 Awards is open — review the lineup and lock in your ' +
    'verdicts before the ballots seal. 👀',
  '🚨 Make your voice heard! Voting is live right now — pick your champions for each award. Your ' +
    'ballot stays sealed till the big reveal, so no one can game it. 💪',
  '👑 Crown your champions! The suspects are lined up and it’s on you to deliver the verdict. ' +
    'Hop in and vote for every award before time runs out! 🏆',
];
function reminder(kind, dlMs, n) {
  const vote = kind === 'vote';
  const left = dlMs ? dlMs - Date.now() : Infinity;
  if (dlMs && left <= 3 * HOUR) return closingSoon(kind, dlMs, true);    // last call
  if (dlMs && left <= DAY) return closingSoon(kind, dlMs, false);        // closing soon
  const bank = vote ? VOTE_REMINDERS : NOMINATE_REMINDERS;
  return msg({
    text: bank[n % bank.length],
    title: vote ? '⚖️ Cast your verdict' : '🕵️ File your tips',
    url: SITE, color: YELLOW,
    linkLabel: vote ? '🗳️ Vote here:' : '📋 Name your suspects here:', linkUrl: SITE,
    deadlineMs: dlMs, closesLabel: vote ? '🔒 Voting closes' : '🔒 Tip line closes',
  });
}

// ---- preview mode (perfect the wording in a PRIVATE channel first) ----
const previewWebhookUrl = () => process.env.DISCORD_PREVIEW_WEBHOOK_URL || '';
// `preview=all` fires one of each (a single reminder sample); use the plural
// `preview=nom-reminders` / `vote-reminders` to see every rotation variant.
const PREVIEW_TYPES = ['nominate', 'nom-reminder', 'nom-soon', 'nom-last', 'vote', 'vote-reminder', 'vote-soon', 'vote-last', 'closed'];
// Build any one announcement on demand (uses real deadlines if set, else a fake +24h
// so the countdown still renders). Returns the normal @everyone payload.
function previewPayloads(which, s) {
  const nomDl = s.nominate_deadline ? Date.parse(s.nominate_deadline) : Date.now() + DAY;
  const voteDl = s.deadline ? Date.parse(s.deadline) : Date.now() + DAY;
  const far = Date.now() + 5 * DAY;   // so reminder() shows the rotating copy, not escalated
  const one = (p) => (p ? [p] : []);
  switch (which) {
    case 'nominate':       return one(nominationsOpen(s));
    case 'vote':           return one(votingLive(s));
    case 'closed':         return one(winners(s));
    case 'nom-soon':       return one(closingSoon('nominate', nomDl, false));
    case 'nom-last':       return one(closingSoon('nominate', nomDl, true));
    case 'vote-soon':      return one(closingSoon('vote', voteDl, false));
    case 'vote-last':      return one(closingSoon('vote', voteDl, true));
    case 'nom-reminder':   return one(reminder('nominate', far, 0));
    case 'vote-reminder':  return one(reminder('vote', far, 0));
    case 'nom-reminders':  return NOMINATE_REMINDERS.map((_, i) => reminder('nominate', far, i));
    case 'vote-reminders': return VOTE_REMINDERS.map((_, i) => reminder('vote', far, i));
    default: return [];
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

// Core: decide what to post this run, persist state, then post. Called by the cron
// route (every ~12h) AND by admin save_settings after a phase flip.
// Model: the FIRST time a phase is live, post the big announcement (flag-gated, once);
// every run after that posts ONE rotating reminder (so a 2x/day cron = 2 nudges/day),
// which auto-escalates to closing-soon / last-call near the deadline. Phase flips reset
// `notified` (see _ak9-admin) so the next phase announces + reminds fresh.
// RESERVE-THEN-POST: persist `notified` BEFORE posting, so a missing `notified` column
// (setup SQL not run) fails safe with ZERO posts rather than spamming @everyone.
export async function announce() {
  if (!webhookUrl()) return { ok: false, reason: 'no-webhook', posted: 0 };
  const s = await loadSettings();
  if (!s) return { ok: false, reason: 'no-settings', posted: 0 };

  const phase = s.phase || 'vote';
  const notified = (s.notified && typeof s.notified === 'object') ? { ...s.notified } : {};
  const now = Date.now();
  const outbox = [];   // payloads to post this run

  if (phase === 'nominate') {
    const openMs = s.nominate_open ? Date.parse(s.nominate_open) : null;
    const isOpen = !openMs || now >= openMs;               // respects the scheduled-open gate
    const dl = s.nominate_deadline ? Date.parse(s.nominate_deadline) : null;
    if (isOpen) {
      if (!notified.nom_open) {
        outbox.push(nominationsOpen(s)); notified.nom_open = true;   // first run → big announce
      } else if (!dl || dl > now) {
        outbox.push(reminder('nominate', dl, notified.rem || 0));    // ongoing 2x/day nudge
        notified.rem = (notified.rem || 0) + 1;
      }
    }
  } else if (phase === 'vote') {
    const dl = s.deadline ? Date.parse(s.deadline) : null;
    if (!notified.vote_open) {
      outbox.push(votingLive(s)); notified.vote_open = true;
    } else if (!dl || dl > now) {
      outbox.push(reminder('vote', dl, notified.rem || 0));
      notified.rem = (notified.rem || 0) + 1;
    }
  } else if (phase === 'closed') {
    if (!notified.closed) { outbox.push(winners(s)); notified.closed = true; }
  }

  if (!outbox.length) return { ok: true, posted: 0 };

  // reserve state first (spam-safe on a missing column)
  const saved = await sb('PATCH', 'ak9_settings?id=eq.1', { body: { notified }, prefer: 'return=minimal' });
  if (!saved.ok) return { ok: false, reason: 'notified-save-failed (run the setup SQL?)', posted: 0 };

  const posted = await postAll(outbox, webhookUrl());
  return { ok: true, posted, of: outbox.length };
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
    //   &preview=<type>  type ∈ nominate|nom-reminders|nom-soon|nom-last|vote|vote-reminders|
    //                          vote-soon|vote-last|closed|all
    const pv = String(req.query.preview || '');
    if (pv) {
      const purl = previewWebhookUrl();
      if (!purl) { res.status(503).json({ error: 'Preview channel not configured (set DISCORD_PREVIEW_WEBHOOK_URL).' }); return; }
      const s = (await loadSettings()) || {};
      const list = pv === 'all' ? PREVIEW_TYPES : [pv];
      const payloads = []; const unknown = [];
      for (const w of list) {
        const items = previewPayloads(w, s);
        if (!items.length) { unknown.push(w); continue; }
        for (const p of items) payloads.push(asPreview(p));
      }
      const posted = await postAll(payloads, purl);
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
