/* TEZ Creations — extension popup.
   Same account system as the site: talks to /api/auth (?route=signup|login|me).
   Session = signed 30-day token + cached public profile, stored in
   chrome.storage.local (the extension's localStorage equivalent). The server is
   the source of truth — we render optimistically from cache, then revalidate
   `me` and refresh or sign out on 401. Mirrors auth.js on the site. */

"use strict";

var API = "https://tez-creations.vercel.app/api";
var TOKEN_KEY = "tez_token";
var USER_KEY = "tez_user";
var ASSIST_KEY = "tez_c4_assist";

/* ---------- session store ---------- */
function getSession() {
  return chrome.storage.local.get([TOKEN_KEY, USER_KEY]).then(function (o) {
    return { token: o[TOKEN_KEY] || "", user: o[USER_KEY] || null };
  });
}
function setSession(token, user) {
  var o = {};
  o[TOKEN_KEY] = token;
  o[USER_KEY] = user;
  return chrome.storage.local.set(o);
}
function clearSession() {
  return chrome.storage.local.remove([TOKEN_KEY, USER_KEY]);
}

/* ---------- API ---------- */
function api(route, opts) {
  opts = opts || {};
  var headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  var ready = opts.auth
    ? getSession().then(function (s) { if (s.token) headers.Authorization = "Bearer " + s.token; })
    : Promise.resolve();
  return ready.then(function () {
    return fetch(API + "/auth?route=" + route, {
      method: opts.method || "POST",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      return { ok: r.ok, status: r.status, data: j };
    });
  });
}

/* ---------- elements ---------- */
var $ = function (id) { return document.getElementById(id); };
var viewAuth = $("view-auth");
var viewMain = $("view-main");
var tierChip = $("tier-chip");
var tabLogin = $("tab-login");
var tabSignup = $("tab-signup");
var fieldName = $("field-name");
var inName = $("in-name");
var inEmail = $("in-email");
var inPass = $("in-pass");
var authErr = $("auth-err");
var btnSubmit = $("btn-submit");
var mode = "login";

/* ---------- rendering ---------- */
function tierOf(user) {
  if (!user) return "free";
  if (user.tier) return user.tier;
  return user.pro ? "pro" : "free";
}

function render(user) {
  var loggedIn = !!user;
  viewAuth.hidden = loggedIn;
  viewMain.hidden = !loggedIn;
  tierChip.hidden = !loggedIn;
  if (!loggedIn) return;

  var tier = tierOf(user);
  tierChip.textContent = tier;
  tierChip.className = "chip " + tier;
  $("acct-name").textContent = user.name || "";
  $("acct-code").textContent = user.code || "";
  renderSiteCard(user);
}

/* ---------- site-aware features ---------- */
function renderSiteCard(user) {
  var tester = !!(user && user.tierTester);
  var toggle = $("c4-toggle");
  toggle.disabled = !tester;
  $("c4-locked").hidden = tester;
  chrome.storage.local.get([ASSIST_KEY], function (o) {
    setSwitch(toggle, o[ASSIST_KEY] !== false);
  });
  // "active on this tab" hint when the current tab is the feature's site
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var url = (tabs && tabs[0] && tabs[0].url) || "";
    var host = "";
    try { host = new URL(url).hostname; } catch (e) { /* chrome:// pages etc. */ }
    var isPapergames = host === "papergames.io" || host.endsWith(".papergames.io");
    $("c4-live").hidden = !(isPapergames && tester);
  });
}

function setSwitch(el, on) {
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", on ? "true" : "false");
}

function setMode(next) {
  mode = next;
  tabLogin.classList.toggle("active", mode === "login");
  tabSignup.classList.toggle("active", mode === "signup");
  fieldName.hidden = mode !== "signup";
  btnSubmit.textContent = mode === "signup" ? "Create account" : "Log in";
  authErr.hidden = true;
}

function showErr(msg) {
  authErr.textContent = msg;
  authErr.hidden = false;
}

/* ---------- auth actions ---------- */
function submit() {
  var email = (inEmail.value || "").trim().toLowerCase();
  var pass = inPass.value || "";
  if (mode === "signup" && (inName.value || "").trim().length < 2) { showErr("Enter your name."); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showErr("Enter a valid email."); return; }
  if (pass.length < 6) { showErr("Password must be at least 6 characters."); return; }

  btnSubmit.disabled = true;
  authErr.hidden = true;
  var body = mode === "signup"
    ? { name: inName.value.trim(), email: email, password: pass }
    : { email: email, password: pass };

  api(mode, { body: body }).then(function (res) {
    btnSubmit.disabled = false;
    if (!res.ok || !res.data || !res.data.token) {
      showErr((res.data && res.data.error) || "Something went wrong. Try again.");
      return;
    }
    setSession(res.data.token, res.data.user).then(function () {
      inPass.value = "";
      render(res.data.user);
    });
  }).catch(function () {
    btnSubmit.disabled = false;
    showErr("Couldn't reach the server.");
  });
}

function logout() {
  clearSession().then(function () { render(null); });
}

/* ---------- boot ---------- */
function boot() {
  tabLogin.addEventListener("click", function () { setMode("login"); });
  tabSignup.addEventListener("click", function () { setMode("signup"); });
  btnSubmit.addEventListener("click", submit);
  inPass.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  $("btn-logout").addEventListener("click", logout);
  $("c4-toggle").addEventListener("click", function () {
    var next = !this.classList.contains("on");
    setSwitch(this, next);
    var o = {};
    o[ASSIST_KEY] = next;
    chrome.storage.local.set(o);
  });

  getSession().then(function (s) {
    render(s.user); // optimistic from cache so the popup shows instantly
    if (!s.user) { setMode("login"); return; }
    // Revalidate with the server; refresh the cached profile or sign out.
    api("me", { method: "GET", auth: true }).then(function (res) {
      if (res.ok && res.data && res.data.user) {
        setSession(s.token, res.data.user).then(function () { render(res.data.user); });
      } else if (res.status === 401) {
        clearSession().then(function () { render(null); setMode("login"); });
      }
      // other errors (offline/500): keep the optimistic session
    }).catch(function () { /* offline — keep cached session */ });
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
