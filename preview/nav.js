/* TEZ preview — shared mobile nav.
   Builds a hamburger + slide-in menu from the existing header nav, so every
   preview page gets mobile navigation without duplicating markup. */
(function () {
  function init() {
    var navRight = document.querySelector('header .nav-right');
    var navLinks = document.querySelector('header .nav-links');
    if (!navRight || !navLinks || document.querySelector('.nav-burger')) return;

    // hamburger button (styled to show only on mobile via tez.css)
    var btn = document.createElement('button');
    btn.className = 'nav-burger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';
    navRight.appendChild(btn);

    // mobile menu = the header links + the "Browse drops" action
    var browseCta = navRight.querySelector(':scope > a.cta');
    var browseHref = browseCta ? browseCta.getAttribute('href') : '#drops';
    var menu = document.createElement('div');
    menu.className = 'nav-mobile';
    menu.innerHTML =
      '<nav class="nav-mobile-inner">' + navLinks.innerHTML +
      '<a class="nav-mobile-cta" href="' + browseHref + '">Browse drops</a>' +
      '</nav>';
    document.body.appendChild(menu);

    function setOpen(open) {
      document.body.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    btn.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('nav-open'));
    });
    // close on a link tap or a tap on the backdrop
    menu.addEventListener('click', function (e) {
      if (e.target === menu || e.target.tagName === 'A') setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
