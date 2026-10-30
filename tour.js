// Guided walkthrough ("demo mode") for new analysts. Plain script, no dependencies.
// Exposes window.DemoTour { start({ resume }), stop(), isActive() } and fires 'demotour:end' ({ completed }) when a person
// finishes, skips or presses Esc. stop() tears down silently.
// The overlay lives under <body>, never inside #app (app.js replaces #app's markup). Each frame it re-queries the
// [data-tour="name"] anchor and repositions the spotlight and card, so re-renders do not break it.
// Wrapped in a function so its helper names cannot collide with app.js's top-level constants.

(() => {
  const STEP_KEY = 'indigo.demoTour.step';

  // ---------------------------------------------------------------------------
  // Content. view: 'list' | 'detail' | null (stay put). target: a data-tour anchor name, or null for a centered card.
  // optional: skip the step when its anchor never appears (the anchor is only rendered in some alert states).
  // ---------------------------------------------------------------------------

  const STEPS = [
    { view: null, target: null, title: 'Welcome to the AI triage assistant',
      body: 'An AI investigates each alert and recommends what to do. You are the human in the loop: you approve, change or escalate. Here are the parts that matter.' },
    { view: 'list', target: 'queue-head', title: 'The queue is in priority order',
      body: 'Live runs first, then alerts that need you: most severe, then longest waiting. Click Waiting to sort by time instead. Click any row to open it.' },
    { view: 'list', target: 'simulate', title: 'Watch the AI work live',
      body: 'Simulate an alert to watch each agent run step by step. Alerts that arrive on their own get a New tag and a popup.' },
    { view: 'detail', target: 'verdict', title: 'The recommendation and why',
      body: 'Read the reasoning first. "Based on" opens the full playbook with the sections it cited highlighted, and What the AI found adds similar past cases, related activity and whether the independent verifier agreed.' },
    { view: 'detail', target: 'decision-actions', optional: true, title: 'Your decision',
      body: 'Approve, change or escalate. Changing the action needs a note. Why? explains how much review the policy requires, and every decision goes to the audit trail.' },
    { view: 'detail', target: 'steps', title: 'Check the AI\'s work',
      body: 'Each agent\'s step in one line. Click a step for its reasoning, inputs and outputs. A failed check sends the draft back for a retry, shown here.' },
    { view: 'list', target: null, title: 'That\'s it',
      body: 'Open the top of the queue, read the recommendation and why, check the cited playbook if needed, then decide. Turn demo mode on again to replay this.' },
  ];

  // ---------------------------------------------------------------------------
  // State and helpers
  // ---------------------------------------------------------------------------

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const onDetail = () => /^#\/alert\//.test(location.hash);

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };

  let active = false;
  let idx = 0;
  let token = 0;          // bumped on every step change and teardown; stale async work checks it and bails out
  let current = null;     // the step being shown: { step, i }
  let tourHref = null;    // the alert chosen for the detail steps, kept for the rest of the tour
  let rafId = 0;
  let lastKey = '';
  let lastScroll = 0;
  let els = null;         // { root, spot, card }

  // The anchor, or null when it is missing or not laid out (display: none).
  function find(name) {
    const el = document.querySelector(`[data-tour="${name}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width || r.height ? el : null;
  }

  // Poll every 100 ms, up to ~5 s. Resolves to the value or null; gives up early when the step was superseded.
  async function until(fn, my, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      if (!active || my !== token) return null;
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  function build() {
    const root = document.createElement('div');
    root.className = 'tour-root';
    root.innerHTML = `<div class="tour-spot tour-spot-none"></div>
      <div class="tour-card" role="dialog" aria-labelledby="tour-title" aria-describedby="tour-body"></div>`;
    document.body.appendChild(root);
    els = { root, spot: root.querySelector('.tour-spot'), card: root.querySelector('.tour-card') };
    els.card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tour-act]');
      if (!b) return;
      const act = b.dataset.tourAct;
      if (act === 'next') next(); else if (act === 'back') back(); else if (act === 'skip') end(false);
    });
  }

  function renderCard(step, i) {
    const last = i === STEPS.length - 1;
    els.card.innerHTML = `<div class="tour-progress" aria-hidden="true"><span style="width:${((i + 1) / STEPS.length) * 100}%"></span></div>
      <div class="tour-inner">
        <div class="tour-count mono">${i + 1} of ${STEPS.length}</div>
        <h2 class="tour-title" id="tour-title">${esc(step.title)}</h2>
        <p class="tour-body" id="tour-body">${esc(step.body)}</p>
        <div class="tour-foot">
          <button type="button" class="tour-skip" data-tour-act="skip">Skip tour</button>
          <span class="tour-nav">
            <button type="button" class="btn btn-sm" data-tour-act="back" ${i === 0 ? 'disabled' : ''}>Back</button>
            <button type="button" class="btn btn-sm btn-primary" data-tour-act="next">${last ? 'Finish' : 'Next'}</button>
          </span>
        </div>
      </div>`;
    const nextBtn = els.card.querySelector('[data-tour-act="next"]');
    if (nextBtn) nextBtn.focus({ preventScroll: true });
  }

  // Put the spotlight over the anchor and the card beside it: below if it fits, else above, else beside, else pinned to the bottom.
  function layout() {
    if (!els || !current) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const cw = els.card.offsetWidth;
    const ch = els.card.offsetHeight;
    const el = current.step.target ? find(current.step.target) : null;
    const r = el ? el.getBoundingClientRect() : null;
    const key = [r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : 'none', vw, vh, cw, ch, current.i].join('|');
    if (key === lastKey) return;
    lastKey = key;

    // Snap (no easing) while the page scrolls so the spotlight does not trail the target; ease otherwise.
    const sy = window.scrollY;
    els.root.classList.toggle('tour-snap', sy !== lastScroll);
    lastScroll = sy;

    const m = 16;
    const gap = 14;
    const pad = 6;
    let left;
    let top;
    if (!r) {
      els.spot.className = 'tour-spot tour-spot-none';
      Object.assign(els.spot.style, { left: vw / 2 + 'px', top: vh / 2 + 'px', width: '0px', height: '0px' });
      left = (vw - cw) / 2;
      top = (vh - ch) / 2;
    } else {
      const s = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
      els.spot.className = 'tour-spot';
      Object.assign(els.spot.style, { left: s.x + 'px', top: s.y + 'px', width: s.w + 'px', height: s.h + 'px' });
      left = r.left + r.width / 2 - cw / 2;
      if (s.y + s.h + gap + ch <= vh - m) top = s.y + s.h + gap;
      else if (s.y - gap - ch >= m) top = s.y - gap - ch;
      else if (s.x + s.w + gap + cw <= vw - m) { left = s.x + s.w + gap; top = r.top; }
      else if (s.x - gap - cw >= m) { left = s.x - gap - cw; top = r.top; }
      else top = vh - ch - m;
    }
    left = clamp(left, m, vw - cw - m);
    top = clamp(top, m, vh - ch - m);
    els.card.style.left = Math.round(left) + 'px';
    els.card.style.top = Math.round(top) + 'px';
  }

  function loop() {
    if (!active) return;
    layout();
    rafId = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------------
  // Routing and steps
  // ---------------------------------------------------------------------------

  // Get the app onto the view a step needs. Detail steps use one alert for the whole tour: the first that needs review.
  async function route(step, my) {
    if (step.view === 'list') {
      if (onDetail()) location.hash = '#/';
    } else if (step.view === 'detail') {
      if (onDetail()) { tourHref = location.hash; return; }
      if (!tourHref) {
        const row = await until(() => {
          const rows = [...document.querySelectorAll('#app a.trow[href^="#/alert/"]')];
          return rows.find((a) => a.textContent.includes('Needs review')) || rows[0] || null;
        }, my);
        if (row) tourHref = row.getAttribute('href');
      }
      if (tourHref && location.hash !== tourHref) location.hash = tourHref;
    }
  }

  async function show(i, dir) {
    if (!active) return;
    const my = ++token;
    if (i >= STEPS.length) { end(true); return; }
    i = Math.max(0, i);
    idx = i;
    store.set(STEP_KEY, String(i));
    const step = STEPS[i];

    await route(step, my);
    if (my !== token) return;
    let el = null;
    if (step.target) {
      // An optional anchor on a page that has already rendered is not coming: skip it without the full wait.
      const loaded = step.optional && find(step.view === 'detail' ? 'summary' : 'kpis');
      el = await until(() => find(step.target), my, loaded ? 600 : 5000);
      if (my !== token) return;
      if (!el && step.optional) { show(i + dir, dir); return; }
    }

    current = { step, i };
    lastKey = '';
    renderCard(step, i);
    layout();
    // Reveal after the first placement so the card does not slide in from the corner.
    requestAnimationFrame(() => { if (els && my === token) els.root.classList.add('tour-on'); });
    if (el) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  const next = () => { if (active) show(idx + 1, 1); };
  const back = () => { if (active && idx > 0) show(idx - 1, -1); };

  function onKey(e) {
    if (!active || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && (t.closest('input, textarea, select') || t.isContentEditable)) return;
    if (e.key === 'Escape') { e.preventDefault(); end(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function teardown() {
    active = false;
    token++;
    current = null;
    cancelAnimationFrame(rafId);
    document.removeEventListener('keydown', onKey, true);
    if (els) els.root.remove();
    els = null;
  }

  function end(completed) {
    if (!active) return;
    teardown();
    store.del(STEP_KEY);
    window.dispatchEvent(new CustomEvent('demotour:end', { detail: { completed: !!completed } }));
  }

  function start(opts) {
    if (active) teardown();
    const saved = parseInt(store.get(STEP_KEY), 10);
    const from = opts && opts.resume && saved >= 0 && saved < STEPS.length ? saved : 0;
    active = true;
    tourHref = null;
    lastScroll = window.scrollY;
    build();
    document.addEventListener('keydown', onKey, true);
    rafId = requestAnimationFrame(loop);
    show(from, 1);
  }

  window.DemoTour = {
    start,
    stop: () => { if (active) teardown(); },
    isActive: () => active,
  };
})();
