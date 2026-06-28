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
    const items = byCat[c].slice().sort((a, b) => Number(b.id) - Number(a.id));
    const hasActive = items.some((d) => d.id === activeId);
    // Collapsed by default; auto-open the category holding the active drop.
    const open = hasActive;
    const linksHTML = items
      .map((d) => {
        const act = d.id === activeId ? " active" : "";
        return (
          `<a class="nav-drop${act}" href="drop.html?id=${d.id}">` +
          `<span class="dnum">#${d.id}</span><span class="dtitle">${d.title}</span></a>`
        );
      })
      .join("");
    dropsHTML +=
      `<div class="nav-group${open ? " open" : ""}">` +
      `<button class="nav-cat" type="button" aria-expanded="${open}">` +
      `<span class="cat-arrow">▸</span><span class="cat-label">${c}</span>` +
      `<span class="cat-count">${items.length}</span></button>` +
      `<div class="nav-cat-drops"><div class="nav-cat-inner">${linksHTML}</div></div>` +
      `</div>`;
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
      <a class="nav-link nav-ak9" href="/ak9awards"><span class="ico">★</span> AK9 Awards</a>
      <a class="nav-link${dropsActive}" href="home.html"><span class="ico">◆</span> Drops</a>
      <div class="nav-sub">${dropsHTML}</div>
      <a class="nav-link nav-ai" href="ai/"><span class="ico">✦</span> TEZ AI <span class="nav-soon">soon</span></a>
      <a class="nav-link${aboutActive}" href="about.html"><span class="ico">○</span> About</a>
      <div class="side-spacer"></div>
      <div class="side-foot">© 2026 TEZ Creations</div>
    </nav>`;

  /* ---- Collapsible category sections (click a category to reveal its drops) ---- */
  aside.querySelectorAll(".nav-cat").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.parentElement;
      const open = group.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
  });

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
