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

  /* ---------- account chip ---------- */
  var chip;
  function renderChip(user) {
    if (!user) { if (chip) { chip.remove(); chip = null; } return; }
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "auth-chip";
      document.body.appendChild(chip);
    }
    var initial = (user.name || user.email).trim().charAt(0).toUpperCase();
    var tier = user.tier || "free";
    var tierBadge = tier !== "free"
      ? '<span class="auth-chip-tier ' + tier + '">' + (tier === "exclusive" ? "EXCLUSIVE" : "PRO") + '</span>'
      : "";
    chip.innerHTML =
      '<span class="auth-chip-avatar">' + initial + '</span>' +
      '<span class="auth-chip-meta">' +
        '<span class="auth-chip-name">' + escapeHtml(user.name || user.email) + tierBadge + '</span>' +
        (user.code ? '<span class="auth-chip-code">' + escapeHtml(user.code) + '</span>' : '') +
      '</span>' +
      '<button class="auth-logout" type="button">Log out</button>';
    chip.querySelector(".auth-logout").addEventListener("click", function () {
      clearSession();
      emitChange();
    });
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
  function buildProModal() {
    if (proOverlay) return;
    proOverlay = document.createElement("div");
    proOverlay.className = "pro-overlay";
    proOverlay.hidden = true;
    proOverlay.innerHTML =
      '<div class="pro-card" role="dialog" aria-modal="true" aria-label="TEZ Pro">' +
        '<button class="pro-close" aria-label="Close">×</button>' +
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
  function openPro(reason) {
    buildProModal();
    var r = proOverlay.querySelector(".pro-reason");
    if (reason) { r.textContent = reason; r.hidden = false; } else { r.hidden = true; }
    proOverlay.hidden = false;
    document.body.classList.add("auth-open"); // pause bg animation → smooth
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { proOverlay.classList.add("show"); });
    });
  }
  function closePro() {
    if (!proOverlay) return;
    proOverlay.classList.remove("show");
    setTimeout(function () {
      if (proOverlay) proOverlay.hidden = true;
      document.body.classList.remove("auth-open");
    }, 320);
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
