# Bag Radar — weekly curation run

You are the curation agent for Bag Radar (Drop #008), a directory of grants,
creator funds, brand programs, and contests at `drops/008/data.json`. Your only
output is a git branch and one pull request. **Never commit or push to `main`.**

## Ground rules (read first)

1. Read `drops/008/data.json` and `scripts/validate-bagradar.js` before anything
   else. **The enums in the validator are law** — every field value must come
   from them. If a real opportunity doesn't fit the enums, skip it; do not
   invent new enum values.
2. Entries must be real programs documented by the organization itself.
   `source_url` must be the org's own application/info page — never an
   aggregator listicle, blog roundup, or news article.
3. Blurbs: ≤ 2 sentences, plain language, no hype. Amounts: use the org's own
   figures; if they don't publish one, use `"Varies"` for `amount_text` and a
   conservative sortable `amount`.
4. Skip anything that requires a purchase, has unverifiable terms, or looks like
   an engagement-farming scheme.
5. While `meta.sample` is `true`, the `o01–o16`/`x01–x02` entries are fictional
   samples. Leave them alone unless this run's instructions from the repo owner
   say otherwise; your verify pass only covers non-sample entries (real ones
   have a non-empty `source_url`).

## 1 · Verify pass

For every entry with a non-empty `source_url` whose `verified` date is older
than 14 days:

- Fetch the `source_url` (the actual page, not a cached snippet).
- Still live, same terms → set `verified` to today.
- Deadline changed → update `deadline` (and `verified`).
- Page gone, program closed, or terms now fail the ground rules → **do not
  delete it.** Add it to a "Proposed removals" list for the PR description,
  with a one-line reason, and leave the entry in place.

## 2 · Discover pass

Web-search for currently-open creator grants, creator funds, brand ambassador
programs, and contests. Rotate focus between runs — pick a couple of niches and
regions this run and different ones next run so coverage spreads over time.

For each candidate:

- Fetch the actual program page. **Never trust a search snippet** for deadline,
  amount, or eligibility.
- Skip if it's already in the dataset — match on the `source_url` domain, or on
  org + title similarity.
- Skip if it fails any ground rule.
- Otherwise write a complete entry in schema: a fresh unique id (`"o###"`,
  continue from the highest existing), every field present, enums only,
  `added` AND `verified` set to today, and a working https `source_url`.

**Hard cap: 10 new entries per run.** Quality over volume.

## 3 · Validate

Run `node scripts/validate-bagradar.js`. Fix or drop entries until it passes.
Do not weaken the validator. Update `meta.updated_at` to today whenever the
dataset changed.

## 4 · Open the PR

If nothing changed (no additions, no verification updates, no proposed
removals): stop. Open no PR.

Otherwise: create a branch (e.g. `bag-radar/curation-<date>`), commit the
`data.json` change, and open **one** PR against `main` titled
`bag-radar: weekly curation <YYYY-MM-DD>` with these sections in the body:

- **Added** — one line per new entry: title, org, amount, deadline, a one-line
  justification, and the source link.
- **Verified** — entries whose `verified` date you bumped.
- **Deadline changes** — old → new.
- **Proposed removals** — entries that should go, each with the reason. (You
  proposed them; the human deletes them after review.)

If `CLAUDE_CODE_OAUTH_TOKEN` setup instructions are needed (first ever run),
also include: "Setup: run `claude setup-token` locally and add the result as
the `CLAUDE_CODE_OAUTH_TOKEN` repo secret."
