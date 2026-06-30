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

   ⚠️ Accounts are stored in localStorage for now — this is the UI/UX
   layer only. When the real backend lands, swap the two functions
   marked `BACKEND HOOK` for calls to /api/auth and nothing else changes.
   Do NOT treat localStorage passwords as secure; real hashing happens
   server-side later.
   ============================================================ */
(function () {
  "use strict";

  var USERS_KEY = "tez_users";       // { email: { name, email, pass } }
  var CURRENT_KEY = "tez_user";      // current logged-in email (persists)
  var DISMISS_KEY = "tez_auth_seen"; // session flag: don't re-nag after dismiss

  /* ---------- tiny store helpers ---------- */
  function readUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function writeUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
  function norm(email) { return String(email || "").trim().toLowerCase(); }

  /* Placeholder obfuscation — NOT real security. Replaced by server hashing. */
  function weakHash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    return "h" + (h >>> 0).toString(36);
  }

  /* ---------- account model (BACKEND HOOK points) ---------- */
  // BACKEND HOOK: replace with `await fetch('/api/auth?route=signup', …)`
  function signUp(name, email, pass) {
    email = norm(email);
    if (!name || name.trim().length < 2) return { error: "Enter your name." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email." };
    if (!pass || pass.length < 6) return { error: "Password must be at least 6 characters." };
    var users = readUsers();
    if (users[email]) return { error: "An account with that email already exists. Log in instead." };
    users[email] = { name: name.trim(), email: email, pass: weakHash(pass) };
    writeUsers(users);
    return { user: { name: users[email].name, email: email } };
  }

  // BACKEND HOOK: replace with `await fetch('/api/auth?route=login', …)`
  function logIn(email, pass) {
    email = norm(email);
    var users = readUsers();
    var rec = users[email];
    if (!rec || rec.pass !== weakHash(pass || "")) return { error: "Wrong email or password." };
    return { user: { name: rec.name, email: email } };
  }

  /* ---------- session ---------- */
  function currentUser() {
    var email = localStorage.getItem(CURRENT_KEY);
    if (!email) return null;
    var rec = readUsers()[email];
    return rec ? { name: rec.name, email: email } : null;
  }
  function setCurrent(email) { localStorage.setItem(CURRENT_KEY, email); }

  var listeners = [];
  function emitChange() {
    var u = currentUser();
    renderChip(u);
    listeners.forEach(function (cb) { try { cb(u); } catch (e) {} });
  }

  /* ---------- DOM: the modal ---------- */
  var overlay, card, errEl, form, tabs, fields, submitBtn, reasonEl, switchEl;
  var mode = "signup"; // 'signup' | 'login'

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
          '<button type="button" class="auth-tab is-active" data-mode="signup">Sign up</button>' +
          '<button type="button" class="auth-tab" data-mode="login">Log in</button>' +
        '</div>' +
        '<form class="auth-form" novalidate>' +
          '<label class="auth-field js-name"><span>Name</span>' +
            '<input class="auth-input" type="text" autocomplete="name" placeholder="What should we call you?"></label>' +
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
    var nameField = overlay.querySelector(".js-name");
    nameField.classList.toggle("hide", m !== "signup");
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

  function onSubmit(e) {
    e.preventDefault();
    var name = fields[0].value;
    var email = fields[1].value;
    var pass = fields[2].value;
    var res = mode === "signup" ? signUp(name, email, pass) : logIn(email, pass);
    if (res.error) { showErr(res.error); return; }
    setCurrent(res.user.email);
    emitChange();
    close(false);
    if (pendingResolve) { pendingResolve(true); pendingResolve = null; }
  }

  /* ---------- open / close ---------- */
  var pendingResolve = null;

  function open(opts) {
    opts = opts || {};
    buildModal();
    setMode(opts.mode || "signup");
    fields[0].value = fields[1].value = fields[2].value = "";
    if (opts.reason) { reasonEl.textContent = opts.reason; reasonEl.hidden = false; }
    else { reasonEl.hidden = true; }
    overlay.hidden = false;
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
    setTimeout(function () { if (overlay) overlay.hidden = true; }, 380);
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
    chip.innerHTML =
      '<span class="auth-chip-avatar">' + initial + '</span>' +
      '<span class="auth-chip-name">' + escapeHtml(user.name || user.email) + '</span>' +
      '<button class="auth-logout" type="button">Log out</button>';
    chip.querySelector(".auth-logout").addEventListener("click", function () {
      localStorage.removeItem(CURRENT_KEY);
      emitChange();
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- public API ---------- */
  window.TezAuth = {
    isLoggedIn: function () { return !!currentUser(); },
    currentUser: currentUser,
    open: open,
    logout: function () { localStorage.removeItem(CURRENT_KEY); emitChange(); },
    onChange: function (cb) { if (typeof cb === "function") listeners.push(cb); },
    // Gate a premium action. Resolves true if logged in (now or after they
    // sign up), false if they dismiss. The paywall layer chains off `true`.
    requireAuth: function (reason) {
      return new Promise(function (resolve) {
        if (currentUser()) { resolve(true); return; }
        pendingResolve = resolve;
        open({ mode: "signup", reason: reason || "Create a free account to continue." });
      });
    }
  };

  /* ---------- boot ---------- */
  function boot() {
    var user = currentUser();
    renderChip(user);
    // Auto-greet on the catalog: only if logged out and not dismissed this session.
    if (!user && !sessionStorage.getItem(DISMISS_KEY) && document.body.hasAttribute("data-auth-greet")) {
      setTimeout(function () { if (!currentUser()) open({ mode: "signup" }); }, 700);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
