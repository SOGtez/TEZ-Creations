/* ============================================================
   TEZ Creations — sign up / log in panel
   ------------------------------------------------------------
   Front-end of the account system. Drops a dismissible sign-up /
   log-in modal over any page that includes this script, and exposes
   a small window.TezAuth API the rest of the site can call.

   Behaviour (per spec):
   • On entering the drops catalog, the panel auto-appears — but it's
     NOT required: an X (and "Maybe later") closes it. Once dismissed
     it won't nag again for the rest of the session.
   • Premium features call TezAuth.requireAuth(reason): if the user is
     logged in it resolves true (the paywall takes over from there); if
     not, the panel re-appears with that reason. They can still exit.

   Accounts are real now: this talks to /api/auth (Supabase + scrypt hashing
   server-side). We keep only a signed session token + a cached public profile
   in localStorage; the server is the source of truth and revalidates on load.
   ============================================================ */
(function () {
  "use strict";

  var TOKEN_KEY = "tez_token";       // signed session token (HMAC, 30d)
  var USER_KEY = "tez_user";         // cached public profile {id,name,email,pro}
  var DISMISS_KEY = "tez_auth_seen"; // session flag: don't re-nag after dismiss
  var API = "/api/auth";

  function norm(email) { return String(email || "").trim().toLowerCase(); }

  /* ---------- session store (cached; the server is the source of truth) ---------- */
  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function currentUser() {
    if (!getToken()) return null;
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
    catch (e) { return null; }
  }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  var listeners = [];
  function emitChange() {
    var u = currentUser();
    renderChip(u);
    listeners.forEach(function (cb) { try { cb(u); } catch (e) {} });
  }

  /* ---------- API ---------- */
  function api(route, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.auth) { var t = getToken(); if (t) headers.Authorization = "Bearer " + t; }
    return fetch(API + "?route=" + route, {
      method: opts.method || "POST",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, data: j };
      });
    });
  }

  // signUp / logIn return a Promise resolving to { user } or { error }.
  function signUp(name, email, pass) {
    if (!name || name.trim().length < 2) return Promise.resolve({ error: "Enter your name." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(email))) return Promise.resolve({ error: "Enter a valid email." });
    if (!pass || pass.length < 6) return Promise.resolve({ error: "Password must be at least 6 characters." });
    return api("signup", { body: { name: name.trim(), email: norm(email), password: pass } }).then(onAuth);
  }
  function logIn(email, pass) {
    if (!norm(email) || !pass) return Promise.resolve({ error: "Enter your email and password." });
    return api("login", { body: { email: norm(email), password: pass } }).then(onAuth);
  }
  function onAuth(res) {
    if (!res.ok || !res.data || !res.data.token) {
      return { error: (res.data && res.data.error) || "Something went wrong. Try again." };
    }
    setSession(res.data.token, res.data.user);
    return { user: res.data.user };
  }

  /* ---------- DOM: the modal ---------- */
  var overlay, card, errEl, form, tabs, tabsEl, fields, submitBtn, reasonEl, switchEl;
  var mode = "signup"; // 'signup' | 'login'
  var firstSet = true; // first setMode after open shouldn't animate the Name field

  // Drive the Name field's height in px so collapse and expand are symmetric.
  function setNameOpen(field, open, instant) {
    clearTimeout(field._collapseT);
    if (open) {
      field.classList.remove("collapsed");
      if (instant) { field.style.height = "auto"; return; }
      field.style.height = "0px";
      void field.offsetHeight; // reflow so the transition has a start value
      field.style.height = field.scrollHeight + "px";
      field._collapseT = setTimeout(function () { field.style.height = "auto"; }, 540);
    } else {
      if (instant) { field.classList.add("collapsed"); field.style.height = "0px"; return; }
      field.style.height = field.scrollHeight + "px"; // pin current height
      void field.offsetHeight;
      field.classList.add("collapsed");
      field.style.height = "0px";
    }
  }

  function buildModal() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "auth-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="auth-card" role="dialog" aria-modal="true" aria-label="Sign up or log in">' +
        '<button class="auth-close" aria-label="Close">×</button>' +
        '<div class="auth-brand">TEZ<span>✦</span></div>' +
        '<p class="auth-reason" hidden></p>' +
        '<div class="auth-tabs">' +
          '<span class="auth-tab-slider" aria-hidden="true"></span>' +
          '<button type="button" class="auth-tab is-active" data-mode="signup">Sign up</button>' +
          '<button type="button" class="auth-tab" data-mode="login">Log in</button>' +
        '</div>' +
        '<form class="auth-form" novalidate>' +
          '<label class="auth-field js-name"><div class="auth-field-inner"><span>Name</span>' +
            '<input class="auth-input" type="text" autocomplete="name" placeholder="What should we call you?"></div></label>' +
          '<label class="auth-field"><span>Email</span>' +
            '<input class="auth-input" type="email" autocomplete="email" placeholder="you@email.com"></label>' +
          '<label class="auth-field"><span>Password</span>' +
            '<input class="auth-input" type="password" autocomplete="current-password" placeholder="At least 6 characters"></label>' +
          '<p class="auth-err"></p>' +
          '<button type="submit" class="btn btn-primary auth-submit">Create account</button>' +
        '</form>' +
        '<p class="auth-switch"></p>' +
        '<button type="button" class="auth-later">Maybe later</button>' +
      '</div>';
    document.body.appendChild(overlay);

    card = overlay.querySelector(".auth-card");
    errEl = overlay.querySelector(".auth-err");
    form = overlay.querySelector(".auth-form");
    tabs = overlay.querySelectorAll(".auth-tab");
    tabsEl = overlay.querySelector(".auth-tabs");
    fields = overlay.querySelectorAll(".auth-input");
    submitBtn = overlay.querySelector(".auth-submit");
    reasonEl = overlay.querySelector(".auth-reason");
    switchEl = overlay.querySelector(".auth-switch");

    overlay.querySelector(".auth-close").addEventListener("click", function () { close(true); });
    overlay.querySelector(".auth-later").addEventListener("click", function () { close(true); });
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(true); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !overlay.hidden) close(true);
    });

    tabs.forEach(function (t) {
      t.addEventListener("click", function () { setMode(t.getAttribute("data-mode")); });
    });
    switchEl.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") setMode(mode === "signup" ? "login" : "signup");
    });
    form.addEventListener("submit", onSubmit);
  }

  function setMode(m) {
    mode = m;
    tabs.forEach(function (t) { t.classList.toggle("is-active", t.getAttribute("data-mode") === m); });
    tabsEl.classList.toggle("is-login", m === "login"); // glide the pill
    var nameField = overlay.querySelector(".js-name");
    setNameOpen(nameField, m === "signup", firstSet); // smooth resize + fade
    firstSet = false;
    submitBtn.textContent = m === "signup" ? "Create account" : "Log in";
    fields[2].setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
    switchEl.innerHTML = m === "signup"
      ? 'Already have an account? <button type="button">Log in</button>'
      : 'New to TEZ? <button type="button">Sign up</button>';
    showErr("");
  }

  function showErr(msg) {
    errEl.textContent = msg || "";
    errEl.classList.toggle("show", !!msg);
    if (msg) {
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
    }
  }

  var busy = false;
  function setBusy(b) {
    busy = b;
    if (!submitBtn) return;
    submitBtn.disabled = b;
    submitBtn.textContent = b ? "Working…" : (mode === "signup" ? "Create account" : "Log in");
  }

  function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    var name = fields[0].value;
    var email = fields[1].value;
    var pass = fields[2].value;
    setBusy(true);
    (mode === "signup" ? signUp(name, email, pass) : logIn(email, pass)).then(function (res) {
      setBusy(false);
      if (res.error) { showErr(res.error); return; }
      emitChange();
      close(false);
      if (pendingResolve) { pendingResolve(true); pendingResolve = null; }
    }).catch(function () {
      setBusy(false);
      showErr("Couldn't reach the server. Try again.");
    });
  }

  /* ---------- open / close ---------- */
  var pendingResolve = null;

  function open(opts) {
    opts = opts || {};
    buildModal();
    firstSet = true; // open in the target mode without animating the Name field
    setMode(opts.mode || "signup");
    fields[0].value = fields[1].value = fields[2].value = "";
    if (opts.reason) { reasonEl.textContent = opts.reason; reasonEl.hidden = false; }
    else { reasonEl.hidden = true; }
    overlay.hidden = false;
    document.body.classList.add("auth-open"); // pause bg animation → smooth typing
    // next frame so the CSS transition runs
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add("show");
        var first = mode === "signup" ? fields[0] : fields[1];
        try { first.focus(); } catch (e) {}
      });
    });
  }

  function close(userDismissed) {
    if (!overlay) return;
    overlay.classList.remove("show");
    if (userDismissed) {
      sessionStorage.setItem(DISMISS_KEY, "1");
      if (pendingResolve) { pendingResolve(false); pendingResolve = null; }
    }
    setTimeout(function () {
      if (overlay) overlay.hidden = true;
      document.body.classList.remove("auth-open"); // resume bg animation
    }, 380);
  }

  /* ---------- account chip + corner nav ---------- */
  // A fixed top-right stack: the account chip (when logged in) sits on top, with a
  // universal "All drops" back-to-catalog link beneath it. Injected on every page
  // that loads auth.js, so the treatment is consistent site-wide.
  var chip, cornerEl;
  function ensureCorner() {
    if (cornerEl) return;
    cornerEl = document.createElement("div");
    cornerEl.className = "tez-corner";
    document.body.appendChild(cornerEl);
    // "All drops" on every page EXCEPT the catalog itself (home), where it'd be circular.
    var onCatalog = /^\/(home)?\/?$/.test(location.pathname) || document.body.hasAttribute("data-auth-greet");
    if (!onCatalog) {
      var link = document.createElement("a");
      link.className = "tez-alldrops";
      link.href = "/home";
      link.innerHTML = '<span aria-hidden="true">←</span> All drops';
      cornerEl.appendChild(link);
    }
  }
  function renderChip(user) {
    ensureCorner();
    if (!user) { if (chip) { chip.remove(); chip = null; } return; }
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.className = "auth-chip";
      chip.addEventListener("click", openProfile);
      cornerEl.insertBefore(chip, cornerEl.firstChild); // chip on top, All drops below
    }
    var initial = (user.name || user.email).trim().charAt(0).toUpperCase();
    var tier = user.tier || "free";
    var tierLabel = tier === "exclusive" ? "EXCLUSIVE" : (tier === "pro" ? "PRO" : "FREE");
    var tierBadge = '<span class="auth-chip-tier ' + tier + '">' + tierLabel + '</span>';
    chip.innerHTML =
      '<span class="auth-chip-avatar">' + initial + '</span>' +
      '<span class="auth-chip-meta">' +
        '<span class="auth-chip-nameRow">' +
          '<span class="auth-chip-name">' + escapeHtml(user.name || user.email) + '</span>' +
          tierBadge +
        '</span>' +
        (user.code ? '<span class="auth-chip-code">' + escapeHtml(user.code) + '</span>' : '') +
      '</span>' +
      '<span class="auth-chip-caret" aria-hidden="true">⌄</span>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- tiers (free < pro < exclusive) ---------- */
  function tierOf() { var u = currentUser(); return (u && u.tier) || "free"; }
  function isPro() { var t = tierOf(); return t === "pro" || t === "exclusive"; }
  function isExclusive() { return tierOf() === "exclusive"; }

  function requireAuth(reason) {
    return new Promise(function (resolve) {
      if (currentUser()) { resolve(true); return; }
      pendingResolve = resolve;
      open({ mode: "signup", reason: reason || "Create a free account to continue." });
    });
  }

  // Gate a Pro feature. Resolves true only if the user already has Pro/Exclusive.
  // Otherwise it shows the right next step (sign up first, or the Pro upsell) and
  // resolves false — the caller simply doesn't run the Pro action.
  function requirePro(reason) {
    if (isPro()) return Promise.resolve(true);
    if (!currentUser()) {
      return requireAuth(reason || "Create a free account first — then unlock Pro.")
        .then(function (ok) {
          if (!ok) return false;
          if (isPro()) return true;
          openPro(reason);
          return false;
        });
    }
    openPro(reason);
    return Promise.resolve(false);
  }

  /* ---------- Pro upsell modal (universal across drops) ---------- */
  var proOverlay;
  var proFromProfile = false; // Pro opened via the profile panel → close morphs back to it
  function buildProModal() {
    if (proOverlay) return;
    proOverlay = document.createElement("div");
    proOverlay.className = "pro-overlay";
    proOverlay.hidden = true;
    proOverlay.innerHTML =
      '<div class="pro-card" role="dialog" aria-modal="true" aria-label="TEZ Pro">' +
        '<button class="pro-close" aria-label="Close">×</button>' +
        '<div class="pro-body">' + // fades as one unit during the panel morph
          '<div class="pro-badge">PRO</div>' +
          '<h2 class="pro-title">TEZ Pro</h2>' +
          '<p class="pro-reason" hidden></p>' +
          '<ul class="pro-feats">' +
            '<li>Bigger Handle Hunter hunts — 200+ names a run</li>' +
            '<li>Every style filter unlocked</li>' +
            '<li>Save &amp; export your finds</li>' +
            '<li>Premium features across every TEZ drop</li>' +
          '</ul>' +
          '<p class="pro-soon">Pro is launching soon.</p>' +
          '<button type="button" class="btn btn-primary pro-cta">Notify me when it’s live</button>' +
          '<p class="pro-excl">Want in now? <strong>Exclusive</strong> access is invite-only — reach out to get it.</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(proOverlay);
    proOverlay.querySelector(".pro-close").addEventListener("click", closePro);
    proOverlay.addEventListener("mousedown", function (e) { if (e.target === proOverlay) closePro(); });
    proOverlay.querySelector(".pro-cta").addEventListener("click", function () {
      // TODO: wire Stripe checkout here when Pro billing goes live.
      closePro();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && proOverlay && !proOverlay.hidden) closePro();
    });
  }
  // Panel morph timing: content fade, then the shell resizes, then content fade.
  var FADE_MS = 190, MORPH_MS = 360;
  var proMorphing = false; // ignore open/close requests while a morph is running

  function openPro(reason, fromProfile) {
    if (proMorphing) return;
    buildProModal();
    var r = proOverlay.querySelector(".pro-reason");
    if (reason) { r.textContent = reason; r.hidden = false; } else { r.hidden = true; }
    proFromProfile = !!fromProfile && !!profileOverlay && !profileOverlay.hidden;
    document.body.classList.add("auth-open"); // pause bg animation → smooth

    if (!proFromProfile) {
      // Standalone (e.g. a locked Pro filter): original fade/scale-in.
      proOverlay.hidden = false;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { proOverlay.classList.add("show"); });
      });
      return;
    }

    // From the profile panel: the PANEL ITSELF morphs — profile content fades
    // out, the card shell animates to the Pro card's size/border, then the Pro
    // content fades in. The profile backdrop stays up the whole time.
    proMorphing = true;
    proOverlay.classList.add("stacked");
    document.body.appendChild(proOverlay); // ensure it stacks above the profile overlay
    var profCard = profileOverlay.querySelector(".profile-card");
    var proCard = proOverlay.querySelector(".pro-card");

    profCard.classList.add("content-hidden"); // 1. old content fades out
    setTimeout(function () {
      var from = profCard.getBoundingClientRect();
      var shell = getComputedStyle(profCard);
      // Show the Pro overlay and measure the card's natural (target) size.
      // Everything below runs before the browser paints, so nothing flickers.
      proOverlay.hidden = false;
      proOverlay.classList.add("show"); // .stacked = no backdrop, no fade
      proCard.classList.add("content-hidden");
      var toW = proCard.offsetWidth, toH = proCard.offsetHeight;
      // 2. pin the Pro shell to the profile card's exact box, swap the cards
      //    (identical rects → invisible), then animate to its own box.
      proCard.classList.add("morphing");
      proCard.style.transition = "none";
      proCard.style.width = from.width + "px";
      proCard.style.height = from.height + "px";
      proCard.style.borderColor = shell.borderColor;
      proCard.style.boxShadow = shell.boxShadow;
      void proCard.offsetHeight; // commit the start box before enabling the transition
      profCard.style.visibility = "hidden";
      proCard.style.transition = "";
      proCard.style.width = toW + "px";
      proCard.style.height = toH + "px";
      proCard.style.borderColor = "";
      proCard.style.boxShadow = "";
      setTimeout(function () {
        proCard.classList.remove("content-hidden"); // 3. new content fades in
        setTimeout(function () {
          proCard.classList.remove("morphing");
          proCard.style.width = ""; proCard.style.height = "";
          proMorphing = false;
        }, FADE_MS + 30);
      }, MORPH_MS);
    }, FADE_MS);
  }

  function closePro() {
    if (!proOverlay || proMorphing) return;
    if (!proFromProfile) {
      proOverlay.classList.remove("show");
      setTimeout(function () {
        if (proOverlay) proOverlay.hidden = true;
        document.body.classList.remove("auth-open");
      }, 320);
      return;
    }
    // Morph back: Pro content fades out, the shell resizes to the profile
    // card's box, the cards swap, and the profile content fades back in.
    proMorphing = true;
    proFromProfile = false;
    var profCard = profileOverlay.querySelector(".profile-card");
    var proCard = proOverlay.querySelector(".pro-card");

    proCard.classList.add("content-hidden"); // 1. Pro content fades out
    setTimeout(function () {
      var to = profCard.getBoundingClientRect(); // visibility:hidden keeps layout
      var shell = getComputedStyle(profCard);
      proCard.classList.add("morphing");
      proCard.style.transition = "none";
      proCard.style.width = proCard.offsetWidth + "px";
      proCard.style.height = proCard.offsetHeight + "px";
      void proCard.offsetHeight;
      proCard.style.transition = "";
      proCard.style.width = to.width + "px"; // 2. shell morphs back
      proCard.style.height = to.height + "px";
      proCard.style.borderColor = shell.borderColor;
      proCard.style.boxShadow = shell.boxShadow;
      setTimeout(function () {
        profCard.style.visibility = ""; // identical rects → invisible swap
        proOverlay.hidden = true;
        proOverlay.classList.remove("show", "stacked");
        proCard.classList.remove("morphing", "content-hidden");
        proCard.style.width = ""; proCard.style.height = "";
        proCard.style.borderColor = ""; proCard.style.boxShadow = "";
        profCard.classList.remove("content-hidden"); // 3. profile content fades in
        proMorphing = false;
        // body keeps auth-open — the profile panel is open again
      }, MORPH_MS);
    }, FADE_MS);
  }

  /* ---------- profile panel (opens when the account chip is clicked) ---------- */
  var profileOverlay, pf = {};
  function buildProfileModal() {
    if (profileOverlay) return;
    profileOverlay = document.createElement("div");
    profileOverlay.className = "profile-overlay";
    profileOverlay.hidden = true;
    profileOverlay.innerHTML =
      '<div class="profile-card" role="dialog" aria-modal="true" aria-label="Your profile">' +
        '<button class="profile-close" aria-label="Close">×</button>' +
        '<div class="profile-body">' + // fades as one unit during the panel morph
        '<div class="profile-head">' +
          '<span class="profile-avatar"></span>' +
          '<div class="profile-id">' +
            '<div class="profile-name-line"><span class="profile-name"></span><span class="profile-tier"></span></div>' +
            '<div class="profile-email"></div>' +
          '</div>' +
        '</div>' +
        '<div class="profile-rows">' +
          '<div class="profile-row"><span class="pr-k">Member code</span><span class="pr-v profile-code"></span></div>' +
          '<div class="profile-row"><span class="pr-k">Plan</span><span class="pr-v profile-plan"></span></div>' +
          '<div class="profile-row"><span class="pr-k">Member since</span><span class="pr-v profile-since"></span></div>' +
        '</div>' +
        '<div class="profile-sec">' +
          '<p class="profile-sec-title">Settings</p>' +
          '<label class="profile-field"><span>Display name</span>' +
            '<div class="profile-inline">' +
              '<input class="profile-input" id="pfName" type="text" autocomplete="name" maxlength="60">' +
              '<button type="button" class="profile-save" id="pfNameSave">Save</button>' +
            '</div>' +
            '<span class="profile-hint" id="pfNameHint" hidden></span>' +
          '</label>' +
          '<label class="profile-field"><span>Change password</span>' +
            '<input class="profile-input" id="pfCur" type="password" autocomplete="current-password" placeholder="Current password">' +
            '<input class="profile-input" id="pfNew" type="password" autocomplete="new-password" placeholder="New password (6+ characters)">' +
            '<button type="button" class="profile-save wide" id="pfPassSave">Update password</button>' +
          '</label>' +
          '<p class="profile-msg" id="pfMsg"></p>' +
        '</div>' +
        '<button type="button" class="profile-logout" id="pfLogout">Log out</button>' +
        '</div>' + // /.profile-body
      '</div>';
    document.body.appendChild(profileOverlay);

    pf = {
      avatar: profileOverlay.querySelector(".profile-avatar"),
      name: profileOverlay.querySelector(".profile-name"),
      tier: profileOverlay.querySelector(".profile-tier"),
      email: profileOverlay.querySelector(".profile-email"),
      code: profileOverlay.querySelector(".profile-code"),
      plan: profileOverlay.querySelector(".profile-plan"),
      since: profileOverlay.querySelector(".profile-since"),
      nameInput: profileOverlay.querySelector("#pfName"),
      nameSave: profileOverlay.querySelector("#pfNameSave"),
      nameHint: profileOverlay.querySelector("#pfNameHint"),
      cur: profileOverlay.querySelector("#pfCur"),
      newpw: profileOverlay.querySelector("#pfNew"),
      passSave: profileOverlay.querySelector("#pfPassSave"),
      msg: profileOverlay.querySelector("#pfMsg"),
    };

    profileOverlay.querySelector(".profile-close").addEventListener("click", closeProfile);
    profileOverlay.addEventListener("mousedown", function (e) { if (e.target === profileOverlay) closeProfile(); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !profileOverlay || profileOverlay.hidden) return;
      if (proOverlay && !proOverlay.hidden) return; // Pro panel is on top — its handler morphs back
      closeProfile();
    });
    profileOverlay.querySelector("#pfLogout").addEventListener("click", function () {
      closeProfile(); clearSession(); emitChange();
    });
    pf.nameSave.addEventListener("click", saveName);
    pf.passSave.addEventListener("click", savePassword);
    pf.plan.addEventListener("click", function (e) {
      if (e.target && e.target.classList.contains("pr-upgrade")) {
        openPro("Upgrade to unlock Pro across every drop.", true); // morph, profile stays beneath
      }
    });
  }

  function fmtSince(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }); }
    catch (e) { return "—"; }
  }

  var NAME_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // display name: once per 14 days
  function fmtDay(v) {
    try { return new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
    catch (e) { return ""; }
  }

  function fillProfile(user) {
    var tier = user.tier || "free";
    var tierLabel = tier === "exclusive" ? "EXCLUSIVE" : (tier === "pro" ? "PRO" : "FREE");
    pf.avatar.textContent = (user.name || user.email).trim().charAt(0).toUpperCase();
    pf.name.textContent = user.name || user.email;
    pf.tier.className = "profile-tier auth-chip-tier " + tier;
    pf.tier.textContent = tierLabel;
    pf.email.textContent = user.email || "";
    pf.code.textContent = user.code || "—";
    var until = "";
    if (user.pro_until) {
      try { until = new Date(user.pro_until).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
      catch (e) { until = ""; }
    }
    pf.plan.innerHTML = tier === "free"
      ? 'Free · <button type="button" class="pr-upgrade">Go Pro →</button>'
      : (tier === "exclusive" ? "Exclusive" : ("Pro" + (until ? " · until " + until : "")));
    pf.since.textContent = fmtSince(user.created_at);
    pf.nameInput.value = user.name || "";
    // Display name can only change once every 14 days.
    var locked = false, nextChange = null;
    if (user.name_changed_at) {
      var next = Date.parse(user.name_changed_at) + NAME_COOLDOWN_MS;
      if (Date.now() < next) { locked = true; nextChange = next; }
    }
    pf.nameInput.disabled = locked;
    pf.nameSave.disabled = locked;
    pf.nameHint.hidden = false;
    pf.nameHint.textContent = locked
      ? "You can change your name again on " + fmtDay(nextChange) + "."
      : "You can change your name once every 14 days.";
    pf.cur.value = ""; pf.newpw.value = "";
    setProfileMsg("");
  }

  function openProfile() {
    var user = currentUser();
    if (!user) return;
    buildProfileModal();
    fillProfile(user);
    profileOverlay.hidden = false;
    document.body.classList.add("auth-open");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { profileOverlay.classList.add("show"); });
    });
  }
  function closeProfile() {
    if (!profileOverlay || proMorphing) return;
    profileOverlay.classList.remove("show");
    setTimeout(function () {
      if (profileOverlay) profileOverlay.hidden = true;
      document.body.classList.remove("auth-open");
    }, 320);
  }

  function setProfileMsg(msg, ok) {
    if (!pf.msg) return;
    pf.msg.textContent = msg || "";
    pf.msg.className = "profile-msg" + (msg ? (ok ? " ok" : " err") : "");
  }

  function saveName() {
    var name = pf.nameInput.value.trim();
    if (name.length < 2) { setProfileMsg("Enter your name (2+ characters).", false); return; }
    pf.nameSave.disabled = true;
    api("update", { body: { name: name }, auth: true }).then(function (res) {
      pf.nameSave.disabled = false;
      if (!res.ok || !res.data || !res.data.user) {
        var msg = (res.data && res.data.error) || "Could not save.";
        if (res.data && res.data.nextChange) {
          msg = "Name changes are limited to once every 14 days — you can rename again on " + fmtDay(res.data.nextChange) + ".";
        }
        setProfileMsg(msg, false);
        return;
      }
      setSession(getToken(), res.data.user);
      emitChange();
      fillProfile(res.data.user);
      setProfileMsg("Name updated.", true);
    }).catch(function () { pf.nameSave.disabled = false; setProfileMsg("Couldn't reach the server.", false); });
  }

  function savePassword() {
    var cur = pf.cur.value, next = pf.newpw.value;
    if (!cur) { setProfileMsg("Enter your current password.", false); return; }
    if ((next || "").length < 6) { setProfileMsg("New password must be at least 6 characters.", false); return; }
    pf.passSave.disabled = true;
    api("password", { body: { current: cur, next: next }, auth: true }).then(function (res) {
      pf.passSave.disabled = false;
      if (!res.ok) { setProfileMsg((res.data && res.data.error) || "Could not update password.", false); return; }
      pf.cur.value = ""; pf.newpw.value = "";
      setProfileMsg("Password updated.", true);
    }).catch(function () { pf.passSave.disabled = false; setProfileMsg("Couldn't reach the server.", false); });
  }

  /* ---------- public API ---------- */
  window.TezAuth = {
    isLoggedIn: function () { return !!currentUser(); },
    currentUser: currentUser,
    token: getToken, // signed session token, for authenticated calls elsewhere
    tier: tierOf,
    isPro: isPro,
    isExclusive: isExclusive,
    open: open,
    openPro: openPro, // show the Pro upsell directly
    openProfile: openProfile, // show the profile / settings panel
    logout: function () { clearSession(); emitChange(); },
    onChange: function (cb) { if (typeof cb === "function") listeners.push(cb); },
    // Gate a sign-in-required action. Resolves true if logged in (now or after
    // they sign up), false if they dismiss.
    requireAuth: requireAuth,
    // Gate a Pro action. Resolves true only if they already have Pro/Exclusive.
    requirePro: requirePro,
  };

  /* ---------- boot ---------- */
  function boot() {
    var user = currentUser();
    renderChip(user); // optimistic from cache so the chip shows instantly
    // Revalidate the token with the server; refresh the cached profile or sign out.
    if (user) {
      api("me", { method: "GET", auth: true }).then(function (res) {
        if (res.ok && res.data && res.data.user) {
          setSession(getToken(), res.data.user);
          emitChange();
        } else if (res.status === 401) {
          clearSession();
          emitChange();
        }
        // other errors (offline/500): keep the optimistic session
      }).catch(function () { /* offline — keep cached session */ });
    }
    // Auto-greet on the catalog: only if logged out and not dismissed this session.
    if (!user && !sessionStorage.getItem(DISMISS_KEY) && document.body.hasAttribute("data-auth-greet")) {
      setTimeout(function () { if (!currentUser()) open({ mode: "signup" }); }, 700);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
