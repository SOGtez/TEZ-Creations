# TEZ Creations — Design System

> The single source of truth for how anything built for **tezcreations.com** should
> look and feel. AI models and contributors: read this before designing or building
> any page, overlay, or component, and match it exactly. Values here are pulled from
> the live `styles.css` and the page scripts — keep them in sync if the site changes.

The vibe in one line: **dark, near-black green-cast surface; mint text; one bright
green accent; subtle motion (drifting grid, breathing glow, film grain); glassy
pills and chunky 3D-shaded green buttons.** Moltorino-inspired, but green not orange.

---

## 1. Color

All colors are defined as CSS custom properties in `:root` (in `styles.css`). Use the
variables, never hardcode hex unless you're in a standalone tool page that can't import
`styles.css` — in that case copy these exact values.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#050806` | Page background (near-black, faint green cast) |
| `--bg-2` | `#0a0f0b` | Secondary bg / top radial glow stop |
| `--text` | `#eaf2ec` | Primary text (soft mint-white, **never pure `#fff`**) |
| `--muted` | `#8fa394` | Secondary/body text, labels, captions |
| `--accent` | `#2bd46a` | Core brand green |
| `--accent-bright` | `#4ade80` | Highlights, links-on-hover, emphasis, italic accents |
| `--accent-deep` | `#16a34a` | Button gradient bottom, borders |
| `--accent-glow` | `rgba(43,212,106,0.16)` | Glows, focus rings, hover shadows |

**Supporting / incidental values** (used directly in CSS):
- Error / danger text: `#f78a8a`
- Button label color (text **on** green buttons): `#04160b` (very dark green, not black)
- Hairline borders: `rgba(255,255,255,0.07)` (cards), `rgba(255,255,255,0.1)` (inputs)
- Glass fills: `rgba(255,255,255,0.025)`–`rgba(255,255,255,0.03)`
- Grid lines: `rgba(120,200,150,0.06)`
- Muted-dim (timestamps): `rgba(143,163,148,0.7)`; footer `rgba(143,163,148,0.55)`

**Rules**
- Green is the *only* accent. Don't introduce a second hue. Status colors (live red,
  win green) are fine inside overlays where they carry meaning.
- Text is mint-tinted, backgrounds are green-cast — avoid pure white and pure black.
- When a brand requires its own color (e.g. the Twitch "Connect" button stays Twitch
  purple, the Kick logo), keep that brand color — it's a deliberate exception.

---

## 2. Typography

Loaded from Google Fonts. Standard `<head>` link used across pages:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Plus+Jakarta+Sans:wght@400;500;600&family=Space+Mono:wght@700&display=swap" rel="stylesheet" />
```

| Role | Font | Var | Weights | Used for |
|---|---|---|---|---|
| Display | **Space Grotesk** | `--font-display` | 500, 700 | Headlines, wordmark, card titles, `h1`–`h3` |
| Body | **Plus Jakarta Sans** | `--font-sans` | 400, 500, 600 | Paragraphs, buttons, inputs, labels, UI |
| Mono | **Space Mono** | (literal) | 700 | Drop numbers (`#001`), code-ish accents, auto-cover glyphs |

Each falls back to `-apple-system, BlinkMacSystemFont, sans-serif`.

**Type characteristics**
- Big headlines: weight 700, `letter-spacing: -0.02em`, `line-height: ~1.02–1.05`,
  fluid `clamp()` sizing. Optional green text-shadow: `0 0 70px rgba(43,212,106,0.12)`.
- Body: weight 400, `line-height: 1.55–1.65`, color `--muted`.
- Eyebrow / tag / label text: small (11–14px), `text-transform: uppercase`,
  wide tracking (`letter-spacing: 0.18em–0.26em`), color `--muted`.
- Drop numbers: Space Mono 700, 13px, `--accent-bright`, e.g. `#004`.
- Italic word inside a headline → `.accent` (`font-style: italic; color: --accent-bright`).

**Drop tool pages** (overlays/sims like Sub Goal) may keep **Bricolage Grotesque** for
the product UI itself — that's an intentional per-tool choice. The *setup/landing* page
for every drop uses the site fonts above.

---

## 3. Signature background system

Every site-style page layers these four elements (behind content, `z-index` ordered).
Copy the markup + CSS from `styles.css`; don't reinvent.

1. **Drifting grid** (`.grid-wrap` > `.grid-pan` > `.grid`)
   - 64×64px grid, lines `rgba(120,200,150,0.06)`, `perspective(1200px) scale(1.08)`.
   - Animates: `grid-drift 28s linear infinite`.
   - Masked with a radial `mask-image` so edges fade out.
   - **Warps toward the cursor** (and tilts to the phone gyroscope on mobile) — see §6.
   - On the multi-screen gate it also **parallax-pans** (`.grid-pan`, 40% of camera travel).

2. **Breathing glow** (`.glow`) — soft green radial blob behind the hero,
   `breathe 8s ease-in-out infinite` (opacity 0.7→1, scale 1→1.08), `filter: blur(40px)`.

3. **Film grain** (`.grain`) — fixed SVG `feTurbulence` noise overlay, `opacity: 0.045`,
   `z-index: 2`, `pointer-events: none`. Adds premium texture.

4. **Edge vignette** (`body::after`) — radial darkening at the edges,
   `radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(0,0,0,0.55))`.

> ⚠️ **Class-name gotcha:** the form-layout helper class on some tool pages is also
> `.grid`. When porting this backdrop into a self-contained tool page, rename the
> backdrop to **`.bg-grid`** so it doesn't collide with a layout `.grid`. (Live Map's
> setup page uses `.grid2` for layout, so it's safe there.)

---

## 4. Components

### Buttons
- **Primary** (`.btn.btn-primary`): vertical gradient `--accent-bright → --accent-deep`,
  dark-green label `#04160b`, weight 700, `border-radius: 14px`, padding `15px 32px`.
  Multi-layer shadow gives a **3D shaded** look (outer green glow + drop shadow + inner
  light/dark insets). Hover: lifts `translateY(-2px)`, brighter glow, the trailing
  `<span>`/arrow nudges right. Active: presses back down with an inset shadow.
- **Ghost / secondary**: transparent fill, hairline border `rgba(255,255,255,0.1)`,
  `--muted` text → `--text` on hover. Same radius/padding rhythm.
- Buttons commonly carry a trailing arrow `<span>→</span>` that slides on hover.

### Cards (`.card`)
- Glass fill `rgba(255,255,255,0.025)`, hairline border `rgba(255,255,255,0.07)`,
  `border-radius: 16px`, overflow hidden.
- Slight resting tilt via `--tilt` (alternating ±0.4deg in the feed).
- Hover: border turns green `rgba(43,212,106,0.35)` + glow shadow; on the feed they also
  do a subtle 3D mouse-follow tilt (perspective rotateX/Y, see §6).
- Structure: `.cover` (16/8 ratio image or `.cover-gen` auto-cover) + `.card-body`
  (`.num` drop number → `h3` title → `p` description → `time`). Featured card spans full
  width (`grid-column: 1 / -1`) with a shorter 16/6 cover.
- **Auto-cover** (`.cover-gen`): when a drop has no image, render a green-tinted gradient
  panel with the big Space Mono drop number at `rgba(234,242,236,0.14)`.

### Pills / tags
- Glassy pill (`.tag`): `rgba(255,255,255,0.025)` fill, hairline border, `border-radius: 999px`,
  uppercase 12px text, wide tracking, `backdrop-filter: blur(8px)`, inset top highlight.
- Type tag (`.type-tag`) / "fresh" badge (`.fresh`): small uppercase labels; `.fresh`
  is a solid `--accent-bright` chip with dark text + green glow for "new".

### Inputs (`.input`)
- Fill `rgba(255,255,255,0.03)`, border `rgba(255,255,255,0.1)`, `border-radius: 12px`,
  padding `14px 18px`, centered text, letter-spacing `0.15em`.
- Focus: border `rgba(43,212,106,0.5)` + `box-shadow: 0 0 24px var(--accent-glow)`.
- Error state: red `#f78a8a` message (`.err.show`) + a `.shake` animation on the field.

### Chrome (header / footer)
- `.site-head`: flex row, wordmark left, back-link/tagline right, generous fluid padding.
- **Wordmark** (`.wordmark`): Space Grotesk 700, "TEZ" + a `.star` (✦) in `--accent-bright`.
  Pattern: `TEZ<span class="star">✦</span>`.
- `.back-link` / `.back`: `--muted` → `--text` on hover.
- `.site-foot`: centered, dim muted text.

---

## 5. Layout & spacing

- **Content widths:** feed `max-width: 1080px`; drop detail `max-width: 880px`;
  wide two-column tool pages `max-width: 1180px`. Center with `margin: 0 auto`.
- **Page padding:** fluid `clamp(24px, 6vw, 96px)` horizontal is the house standard.
- **Feed grid:** `repeat(2, 1fr)`, `gap: 32px`; collapses to 1 column at `≤720px`.
- **Radii:** 12px (inputs), 14px (buttons), 16px (cards/covers), 999px (pills).
- **Borders:** 1px hairlines in low-opacity white; turn green on hover/focus.
- **Z-index ladder:** grid `0`, vignette `1`, grain `2`, content/deck/header `3`.
- Spacing rhythm is roomy — lean on `clamp()` for anything that scales with viewport.

---

## 6. Motion

Motion is subtle and premium — never bouncy or loud.

- **Page transitions:** fade out (`body.fading`, 0.7s) before navigating; fade in
  (`body.fade-in`, `page-fade 0.8s`) on load.
- **Element entrances:** `rise` keyframe (fade + 18px up), staggered delays (0.05s, 0.15s,
  0.38s, 0.55s…).
- **Grid cursor-warp** (port from `home.html` script): track normalized cursor `tx,ty`
  in `[-1,1]`, ease toward it (`cx += (tx-cx)*0.06`) in a `requestAnimationFrame` loop, and
  set `grid.transform = perspective(1200px) rotateX(-cy*1.6) rotateY(cx*1.6) translate(-cx*8px,-cy*8px) scale(1.08)`.
- **Mobile gyro tilt:** a `deviceorientation` handler feeds the same `tx,ty` using
  `(gamma-g0)/18` and `(beta-b0)/18`, clamped to `[-1.6, 1.6]` (mobile leans harder than the
  cursor). First reading sets a neutral baseline. iOS 13+ requires
  `DeviceOrientationEvent.requestPermission()` on first touch/click.
- **Card hover tilt:** `perspective(900px) rotateX(-y*2.4) rotateY(x*2.4) translateY(-3px)`
  from the card-local cursor offset; reset on `mouseleave`.
- **Easing:** camera/parallax uses `cubic-bezier(0.76, 0, 0.24, 1)`; most UI uses `ease`,
  ~0.2–0.25s.
- **Panel-to-panel transitions (HOUSE STANDARD):** whenever one panel/modal changes into
  another (e.g. sign up ⇄ log in, profile ⇄ Pro), match the sign-up/log-in panel's mode
  switch exactly: **content fades 0.4s `ease`, the panel's shape change 0.5s
  `cubic-bezier(0.16, 1, 0.3, 1)`**. Pattern: old content fades out → the card shell
  morphs size/border on one continuous backdrop → new content fades in (see the
  profile ⇄ Pro morph in `auth.js`/`auth.css`).
- **Accessibility:** everything respects `@media (prefers-reduced-motion: reduce)` — kill
  animations, force `opacity:1`, drop transitions. Always gate motion JS behind the
  `reduce` check (`matchMedia("(prefers-reduced-motion: reduce)")`) like the existing pages.

---

## 7. Building a new drop / tool page — checklist

A new drop lives in `/drops/00X/` (or a site-root folder like `/subgoal/`, `/gauntlet/`
when an OAuth redirect needs a stable path). Its **setup/landing page** should:

1. Use the site fonts (§2 link) and color tokens (§1).
2. Layer the full backdrop: drifting `.bg-grid` + cursor/gyro warp, `.glow`, `.grain`,
   `body::after` vignette. Respect reduced-motion.
3. Lead with `.site-head` (TEZ✦ wordmark + "← All drops" back-link) and close with `.site-foot`.
4. Hero: Space-Mono `#00X` drop number + a uppercase type-tag (e.g. "Stream Tool") +
   a gradient/`--text` headline.
5. Use the standard `.card`, `.btn`, `.input`, pill components — don't invent new looks.
6. Clean-URL `<base>` shim on **index** pages (they're served at `/drops/00X` with no
   trailing slash, which breaks relative links). Copy the shim from an existing setup page.
7. Add one entry to `drops.js` (instructions at the top of that file). Cover image is
   optional — leave `image:""` to auto-generate the `.cover-gen` panel.
8. Keep the design language **identical** across pages — when something "looks different,"
   the fix is to port the signature chrome from an existing setup page (Live Map's
   `drops/003/` and the Gauntlet `gauntlet/` page are good reference templates).

---

## 8. Quick reference — minimal page skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TEZ Creations — …</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Plus+Jakarta+Sans:wght@400;500;600&family=Space+Mono:wght@700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css" /> <!-- or inline these tokens for a standalone tool -->
</head>
<body class="page fade-in">
  <div class="grid-wrap"><div class="grid-pan"><div class="grid"></div></div></div>
  <div class="glow"></div>
  <div class="grain"></div>

  <header class="site-head">
    <a class="wordmark" href="/home">TEZ<span class="star">✦</span></a>
    <a class="back-link" href="/home">← All drops</a>
  </header>

  <!-- content: hero, cards, buttons … -->

  <footer class="site-foot">TEZ Creations</footer>
  <!-- port the reduced-motion-gated grid-warp script from home.html -->
</body>
</html>
```

---

*Keep this file accurate. If a token, font, or signature behavior changes in the live
code, update it here in the same change.*
