/* ===== TEZ Creations — global navigation sidebar =====
   Single source for the left nav, injected into every catalog page
   (home.html, drop.html, about.html). Reads window.DROPS (from drops.js)
   to build the Drops list grouped by category, and marks the active item
   based on the current page. Include AFTER drops.js:

     <script src="drops.js"></script>
     <script src="sidebar.js"></script>

   The page body needs class "app-shell" and its content wrapped in
   <main class="shell-main"> … </main>. Layout lives in styles.css.
*/
(function () {
  /* ---- Work out which page / drop is active ---- */
  const file = (location.pathname.replace(/\/+$/, "").split("/").pop() || "").toLowerCase();
  const params = new URLSearchParams(location.search);
  const onHome = file === "" || file === "home" || file === "home.html" || file === "index" || file === "index.html";
  const onDrop = file === "drop" || file === "drop.html";
  const onAbout = file === "about" || file === "about.html";
  const activeId = onDrop ? params.get("id") : null;

  /* ---- Group drops by category (order set here, rest appended) ---- */
  const CAT_ORDER = ["Stream Tools", "Apps"];
  const drops = Array.isArray(window.DROPS) ? window.DROPS : [];
  const byCat = {};
  drops.forEach((d) => {
    const c = d.category || "Other";
    (byCat[c] = byCat[c] || []).push(d);
  });
  const cats = [
    ...CAT_ORDER.filter((c) => byCat[c]),
    ...Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)).sort()
  ];

  let dropsHTML = "";
  cats.forEach((c) => {
    dropsHTML += `<div class="nav-cat">${c}</div>`;
    byCat[c]
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id))
      .forEach((d) => {
        const act = d.id === activeId ? " active" : "";
        dropsHTML +=
          `<a class="nav-drop${act}" href="drop.html?id=${d.id}">` +
          `<span class="dnum">#${d.id}</span><span class="dtitle">${d.title}</span></a>`;
      });
  });

  const dropsActive = onHome || onDrop ? " active" : "";
  const aboutActive = onAbout ? " active" : "";

  /* ---- Build the sidebar ---- */
  const aside = document.createElement("aside");
  aside.className = "sidebar";
  aside.innerHTML = `
    <a class="side-brand" href="home.html">TEZ<span class="star">✦</span></a>
    <p class="side-tag">random creations</p>
    <nav class="side-nav">
      <a class="nav-link${dropsActive}" href="home.html"><span class="ico">◆</span> Drops</a>
      <div class="nav-sub">${dropsHTML}</div>
      <a class="nav-link nav-ai" href="ai/"><span class="ico">✦</span> TEZ AI <span class="nav-soon">soon</span></a>
      <a class="nav-link${aboutActive}" href="about.html"><span class="ico">○</span> About</a>
      <div class="side-spacer"></div>
      <div class="side-foot">© 2026 TEZ Creations</div>
    </nav>`;

  /* ---- Mobile: hamburger toggle + scrim ---- */
  const toggle = document.createElement("button");
  toggle.className = "nav-toggle";
  toggle.setAttribute("aria-label", "Open menu");
  toggle.innerHTML = "<span></span><span></span><span></span>";

  const scrim = document.createElement("div");
  scrim.className = "nav-scrim";

  function closeNav() {
    document.body.classList.remove("nav-open");
    toggle.setAttribute("aria-label", "Open menu");
  }
  toggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  scrim.addEventListener("click", closeNav);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNav();
  });

  document.body.appendChild(scrim);
  document.body.appendChild(aside);
  document.body.appendChild(toggle);
})();
