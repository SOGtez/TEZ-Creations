#!/usr/bin/env node
// Bag Radar (Drop #008) — schema validator for drops/008/data.json.
// Plain Node, no dependencies. This is the merge gate that makes curation-agent
// PRs safe: if it exits non-zero, the data must not land.
//
// Usage: node scripts/validate-bagradar.js [path/to/data.json]

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'drops', '008', 'data.json');
const MAX_ENTRIES = 500;

// ---- enums (the label maps in drops/008/index.html are the source of truth) ----
const TYPES = ['grant', 'fund', 'brand', 'contest', 'accelerator'];
const REGIONS = ['US', 'CA', 'UK', 'EU'];
const PLATFORMS = ['twitch', 'youtube', 'tiktok', 'instagram', 'kick', 'x', 'spotify', 'web'];
const MEDIUMS = ['live', 'video', 'shortform', 'podcast', 'music', 'visualart', 'writing', 'photo'];
const NICHES = ['gaming', 'beauty', 'music', 'education', 'tech', 'food', 'fitness', 'art', 'comedy', 'lifestyle'];
const STAGES = ['new', 'growing', 'established', 'fulltime'];
const PURPOSES = ['gear', 'project', 'education', 'fulltime', 'business'];
const IDENTITY = ['black', 'woman', 'lgbtq', 'disabled', 'aapi', 'latino', 'veteran', 'student'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

const errors = [];
const fail = (msg) => errors.push(msg);

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function checkEnumArray(where, name, value, allowed) {
  if (!Array.isArray(value)) { fail(`${where}: "${name}" must be an array`); return; }
  for (const v of value) {
    if (!allowed.includes(v)) fail(`${where}: "${name}" contains "${v}" — allowed: ${allowed.join(', ')}`);
  }
}

// ---- load ----
let raw;
try {
  raw = fs.readFileSync(FILE, 'utf8');
} catch (e) {
  console.error(`FAIL: cannot read ${FILE}: ${e.message}`);
  process.exit(1);
}
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`FAIL: ${FILE} is not valid JSON: ${e.message}`);
  process.exit(1);
}

// ---- meta ----
const meta = data.meta;
if (!meta || typeof meta !== 'object') fail('meta: missing or not an object');
else {
  if (typeof meta.sample !== 'boolean') fail('meta.sample: must be a boolean');
  if (!isIsoDate(meta.updated_at)) fail(`meta.updated_at: "${meta.updated_at}" is not a valid ISO date`);
  if (typeof meta.schema_version !== 'number') fail('meta.schema_version: must be a number');
}
const sample = !!(meta && meta.sample);

// ---- opportunities ----
const opps = data.opportunities;
if (!Array.isArray(opps)) {
  fail('opportunities: missing or not an array');
} else {
  if (opps.length > MAX_ENTRIES) fail(`opportunities: ${opps.length} entries — cap is ${MAX_ENTRIES}`);

  const seen = new Set();
  opps.forEach((o, idx) => {
    const where = `entry ${idx} (${o && o.id ? o.id : 'no id'})`;
    if (!o || typeof o !== 'object') { fail(`${where}: not an object`); return; }

    // id
    if (typeof o.id !== 'string' || !o.id.trim()) fail(`${where}: "id" must be a non-empty string`);
    else if (seen.has(o.id)) fail(`${where}: duplicate id "${o.id}"`);
    else seen.add(o.id);

    // type
    if (!TYPES.includes(o.type)) fail(`${where}: "type" is "${o.type}" — allowed: ${TYPES.join(', ')}`);

    // strings
    for (const k of ['title', 'org', 'amount_text']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) fail(`${where}: "${k}" must be a non-empty string`);
    }
    if (typeof o.blurb !== 'string') fail(`${where}: "blurb" must be a string`);

    // numbers
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount < 0)
      fail(`${where}: "amount" must be a non-negative number`);
    if (typeof o.follower_min !== 'number' || !Number.isFinite(o.follower_min) || o.follower_min < 0)
      fail(`${where}: "follower_min" must be a non-negative number`);

    // dates
    if (o.deadline !== null && !isIsoDate(o.deadline))
      fail(`${where}: "deadline" must be null (rolling) or a valid ISO date, got "${o.deadline}"`);
    for (const k of ['added', 'verified']) {
      if (!isIsoDate(o[k])) fail(`${where}: "${k}" must be a valid ISO date, got "${o[k]}"`);
    }

    // enum arrays
    checkEnumArray(where, 'regions', o.regions, REGIONS);
    checkEnumArray(where, 'states', o.states, US_STATES);
    checkEnumArray(where, 'platforms', o.platforms, PLATFORMS);
    checkEnumArray(where, 'mediums', o.mediums, MEDIUMS);
    checkEnumArray(where, 'niches', o.niches, NICHES);
    checkEnumArray(where, 'stages', o.stages, STAGES);
    checkEnumArray(where, 'purposes', o.purposes, PURPOSES);
    checkEnumArray(where, 'identity', o.identity, IDENTITY);

    // source_url — required (non-empty https) once the dataset is real
    if (typeof o.source_url !== 'string') {
      fail(`${where}: "source_url" must be a string`);
    } else if (!sample) {
      if (!o.source_url.trim()) fail(`${where}: "source_url" is required when meta.sample is false`);
      else if (!/^https:\/\//.test(o.source_url)) fail(`${where}: "source_url" must start with https:// — got "${o.source_url}"`);
    } else if (o.source_url && !/^https:\/\//.test(o.source_url)) {
      fail(`${where}: "source_url" must be empty or start with https://`);
    }
  });
}

// ---- report ----
if (errors.length) {
  console.error(`FAIL: ${FILE} has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n`);
  errors.forEach((e) => console.error('  ✗ ' + e));
  process.exit(1);
}
const n = Array.isArray(opps) ? opps.length : 0;
console.log(`OK: ${n} entries valid (sample=${sample}, updated ${meta && meta.updated_at})`);
