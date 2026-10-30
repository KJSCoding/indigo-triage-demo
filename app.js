// AI triage assistant: analyst console. Two views, picked by the URL hash:
//   #/              alert queue: what needs a human first
//   #/alert/<id>    one alert: recommendation and decision, next steps, how the AI decided, related activity
// Short summaries everywhere; full detail opens on click. Live runs update every second through /api/live.
// Data comes from server.py's /api endpoints; there is no build step.

const app = document.getElementById('app');
const noteEl = document.getElementById('note');
const toastEl = document.getElementById('toast');

const state = {
  list: null, totals: null, filter: 'all', query: '', showMetrics: false, sort: 'priority',
  detail: null, detailId: null, openSteps: new Set(), expanded: new Set(), showTech: false, techKey: null,
  overrideOpen: false, note: '', noteError: '', playbooks: {}, pbScroll: false,
  version: -1, knownIds: null, newIds: {}, lastFull: 0, busy: false,
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtK = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const fmtCost = (c) => (c == null ? '—' : c === 0 ? '$0' : '$' + c.toFixed(c < 0.01 ? 4 : 3));
const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '—');
const shortModel = (m) => (m || '').replace(/^databricks-/, '');
const firstSentence = (t) => { const m = String(t || '').match(/^.*?[.!?](\s|$)/); return m ? m[0].trim() : String(t || ''); };

function parseTs(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  const d = new Date(t);
  return isNaN(d) ? null : d;
}
const tsMs = (s) => (parseTs(s) || { getTime: () => 0 }).getTime();
function fmtWhen(s) {
  const d = parseTs(s);
  return d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
}
function fmtAge(s) {
  const d = parseTs(s);
  if (!d) return '—';
  const m = Math.max(0, (Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'now';
  if (Math.round(m) < 60) return Math.round(m) + 'm';
  if (m < 48 * 60) return Math.round(m / 60) + 'h';
  return Math.round(m / 1440) + 'd';
}

const ACT = { isolate: ['#B42318', '#FEECEB'], escalate: ['#A74306', '#FEF0E1'], monitor: ['#1E58B0', '#E8F0FD'], close: ['#127A4B', '#E4F5EC'] };
const SEVC = { Critical: '#C92A2A', High: '#C2410C', Medium: '#866300', Low: '#2B7A3B' };
const SEV_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };
const STATUS = {
  running: ['Running', '#3730A3', '#EEF0FF'],
  failed: ['Run failed', '#B42318', '#FEECEB'],
  pending: ['Needs review', '#8A4B00', '#FFF1D6'],
  approved: ['Approved', '#127A4B', '#E4F5EC'],
  overridden: ['Overridden', '#6D28D9', '#F1EAFE'],
  escalated: ['Escalated', '#A74306', '#FEF0E1'],
  auto: ['Auto-handled', '#52525B', '#F0F0EE'],
};
const REVIEW = {
  must_escalate: ['Analyst must decide', '#B42318', '#FEECEB'],
  needs_approval: ['Needs your approval', '#8A4B00', '#FFF1D6'],
  auto: ['No action needed', '#3F3F46', '#F0F0EE'],
};
const STEP_VERB = { triage: 'Triaging', context: 'Gathering context', investigate: 'Investigating', verify: 'Verifying', decide: 'Deciding' };
const BARC = { triage: '#6366F1', context: '#0E9AAE', investigate: '#8B5CF6', verify: '#D19A00', decide: '#71717A' };
const barColor = (key) => BARC[(key || '').split('_')[0]] || '#71717A';
const FILTERS = [['all', 'All'], ['review', 'Needs review'], ['auto', 'Auto-handled'], ['done', 'Resolved']];
const inFilter = {
  all: () => true,
  review: (a) => ['pending', 'running', 'failed'].includes(a.status),
  auto: (a) => a.status === 'auto',
  done: (a) => ['approved', 'overridden', 'escalated'].includes(a.status),
};

const ICON = {
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#127A4B" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>',
  cross: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C92A2A" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  person: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  retry: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  book: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  history: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
  link: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  shield: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#127A4B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
};
const SPIN = '<span class="spinner" aria-hidden="true"></span>';
// A live elapsed timer: tick() updates its text every 200 ms without re-rendering the page.
const timer = (since) => `<span class="mono" data-since="${esc(since)}">${fmtMs(Date.now() - tsMs(since))}</span>`;

const chip = (label, fg, bg, cls = '') => `<span class="chip ${cls}" style="color:${fg};background:${bg}">${label}</span>`;
function actionChip(a) {
  if (!a.final_action) return '';
  const [fg, bg] = ACT[a.final_action] || ['#3F3F46', '#F0F0EE'];
  const was = a.status === 'overridden' && a.recommended_action !== a.final_action ? ` <s>${esc(a.recommended_action)}</s>` : '';
  return chip(esc(cap(a.final_action)) + was, fg, bg);
}
function statusChip(a) {
  const [label, fg, bg] = STATUS[a.status] || STATUS.pending;
  if (a.status === 'running') return chip(`${SPIN}${esc(a.current || 'Starting')}`, fg, bg, 'pill');
  return chip(label, fg, bg, 'pill');
}
const sevLabel = (sev) => (sev ? `<span class="sev" style="color:${SEVC[sev] || '#3F3F46'}"><span class="dot" style="background:${SEVC[sev] || '#A1A1AA'}"></span>${esc(sev)}</span>` : '<span class="muted">—</span>');
const attackChip = (id) => (id ? `<span class="attack" title="MITRE ATT&amp;CK technique">${esc(id)}</span>` : '');
const moreBtn = (key, label = 'More') => `<button type="button" class="more" data-expand="${esc(key)}" aria-expanded="${state.expanded.has(key)}">${state.expanded.has(key) ? 'Less' : label}</button>`;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) { /* not JSON */ }
    throw new Error(msg);
  }
  return res.json();
}

async function loadList() {
  const d = await api('/api/alerts');
  const ids = d.alerts.map((a) => a.alert_id);
  if (state.knownIds) {
    const fresh = ids.filter((id) => !state.knownIds.has(id));
    for (const id of fresh) state.newIds[id] = Date.now();
    const r = route();
    const notHere = fresh.filter((id) => !(r.view === 'detail' && r.id === id));
    if (notHere.length) showToast(notHere[0], notHere.length);
  }
  state.knownIds = new Set(ids);
  state.list = d.alerts;
  state.totals = d.totals;
  noteEl.hidden = !d.note;
  noteEl.textContent = d.note || '';
}

async function loadDetail(id) {
  const d = await api('/api/alerts/' + encodeURIComponent(id));
  if (state.detailId !== id) {
    Object.assign(state, { openSteps: new Set(), expanded: new Set(), showTech: false, techKey: null, overrideOpen: false, note: '', noteError: '' });
  }
  state.detail = d;
  state.detailId = id;
}

let toastTimer = null;
function showToast(id, count) {
  toastEl.innerHTML = `<span>${count > 1 ? `${count} new alerts` : 'New alert'} <span class="mono">${esc(id)}</span></span><a href="#/alert/${encodeURIComponent(id)}">Open</a>`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 8000);
}

function route() {
  let m = location.hash.match(/^#\/alert\/([^/]+)/);
  if (m) return { view: 'detail', id: decodeURIComponent(m[1]) };
  m = location.hash.match(/^#\/playbook\/([a-z0-9_]+)(?:\/([a-z0-9_]+))?/);
  if (m) return { view: 'playbook', name: m[1], section: m[2] || '' };
  return { view: 'list' };
}

// Queue order: live runs, then what needs a human (most severe, then longest waiting), then the rest (newest first).
function prioritized(list) {
  const group = (a) => (a.status === 'running' || a.status === 'failed' ? 0 : a.status === 'pending' ? 1 : 2);
  return [...list].sort((a, b) => group(a) - group(b)
    || (group(a) === 1 ? ((SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0)) || (tsMs(a.triaged_at) - tsMs(b.triaged_at)) : 0)
    || (tsMs(b.decided_at || b.triaged_at) - tsMs(a.decided_at || a.triaged_at)));
}

function matchesQuery(a) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [a.alert_id, a.affected_user, a.affected_device, a.incident_type, a.description, a.attack_id]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

// Clicking the Waiting header cycles: priority (default) -> newest first -> oldest first -> priority.
// Live runs stay on top in every order.
const SORTS = { priority: ['newest', 'Sort by waiting time, newest first'], newest: ['oldest', 'Sort by waiting time, oldest first'], oldest: ['priority', 'Sort by priority'] };
function sorted(list) {
  if (state.sort === 'priority') return prioritized(list);
  const live = (a) => (a.status === 'running' || a.status === 'failed' ? 0 : 1);
  const when = (a) => tsMs(a.triaged_at || a.received_at);
  const dir = state.sort === 'newest' ? -1 : 1;
  return [...list].sort((a, b) => live(a) - live(b) || dir * (when(a) - when(b)));
}

const visibleAlerts = () => sorted((state.list || []).filter(inFilter[state.filter]).filter(matchesQuery));
const isNew = (id) => state.newIds[id] && Date.now() - state.newIds[id] < 120000;

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function renderList() {
  const alerts = state.list || [];
  const t = state.totals || {};
  const pending = alerts.filter((a) => a.status === 'pending');
  const bySev = (s) => pending.filter((a) => a.severity === s).length;
  const oldest = pending.reduce((o, a) => (!o || tsMs(a.triaged_at) < tsMs(o.triaged_at) ? a : o), null);
  const kpis = [
    ['Needs review', fmtN(pending.length), `${bySev('Critical')} critical · ${bySev('High')} high`, '#8A4B00'],
    ['Oldest waiting', oldest ? { html: `<span data-age="${esc(oldest.triaged_at)}"></span>` } : '—', oldest ? oldest.alert_id : ''],
    ['Auto-handled', fmtN(t.auto), pct(t.auto, t.triaged)],
    ['Resolved', fmtN(alerts.filter(inFilter.done).length), ''],
  ];
  const metrics = [
    ['Triaged', fmtN(t.triaged), ''],
    ['Verification pass', pct(t.verified, t.triaged), ''],
    ['Avg time per alert', fmtMs(t.avg_duration_ms), ''],
    ['Tokens', fmtK(t.measured ? t.input_tokens + t.output_tokens : null), ''],
    ['Est. cost', fmtCost(t.measured ? t.cost : null), t.measured ? `${fmtCost(t.cost / t.measured)} per alert` : ''],
  ];
  const kpiHtml = (rows) => rows.map(([l, v, s, c]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value" style="color:${c || 'var(--ink)'}">${v && v.html ? v.html : esc(v)}</div>${s ? `<div class="kpi-sub">${esc(s)}</div>` : ''}</div>`).join('');

  const rows = visibleAlerts().map((a) => {
    const type = a.incident_type || (a.status === 'running' ? 'Classifying…' : '—');
    // Filled in by tick(): baking the age into the markup redrew the whole list every minute boundary.
    const waiting = a.status === 'pending' ? `<span data-age="${esc(a.triaged_at)}"></span>` : '';
    return `<a class="trow${isNew(a.alert_id) ? ' is-new' : ''}" href="#/alert/${encodeURIComponent(a.alert_id)}">
      <span class="mono" style="font-size:12.5px;font-weight:500">${esc(a.alert_id)}${isNew(a.alert_id) ? ' <span class="new-tag">New</span>' : ''}</span>
      <span class="mono" style="font-size:12.5px;color:#8A4B00">${waiting}</span>
      <span class="cell-type"><b>${esc(type)} ${attackChip(a.attack_id)}</b><span>${esc(a.description)}</span></span>
      <span class="cell-asset"><span>${esc(a.affected_user || '—')}</span><span>${esc(a.affected_device || '')}</span></span>
      <span style="font-size:12.5px">${sevLabel(a.severity)}</span>
      <span>${actionChip(a)}</span>
      <span>${statusChip(a)}</span>
      <span style="color:#A1A1AA">${ICON.right}</span>
    </a>`;
  }).join('');

  setApp(`
    <section aria-label="Queue summary">
      <div class="kpis" data-tour="kpis">${kpiHtml(kpis)}</div>
      <button type="button" class="link-btn" data-tour="metrics-toggle" data-toggle-metrics aria-expanded="${state.showMetrics}">${state.showMetrics ? 'Hide' : 'Show'} pipeline metrics</button>
      ${state.showMetrics ? `<div class="kpis kpis-quiet">${kpiHtml(metrics)}</div>` : ''}
    </section>
    <section class="card" aria-label="Alerts" data-tour="alert-table">
      <div class="toolbar">
        <h1>Alerts</h1>
        <div class="segmented" data-tour="filters" role="group" aria-label="Filter alerts">${FILTERS.map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${state.filter === k}">${l} <span class="count">${alerts.filter(inFilter[k]).length}</span></button>`).join('')}</div>
        <label class="search" data-tour="search">${ICON.search}<span class="sr-only">Search alerts</span><input id="search" type="search" placeholder="Search ID, user, device or type" value="${esc(state.query)}" autocomplete="off"></label>
      </div>
      <div class="scroll-x"><div class="table">
        <div class="trow thead" data-tour="queue-head"><span>Alert</span><button type="button" class="sort-btn" data-sort title="${SORTS[state.sort][1]}" aria-label="Waiting. ${SORTS[state.sort][1]}">Waiting${state.sort === 'priority' ? '' : `<span aria-hidden="true">${state.sort === 'newest' ? '↑' : '↓'}</span>`}</button><span>Type</span><span>Affected</span><span>Severity</span><span>Recommended Action</span><span>Status</span><span></span></div>
        ${rows || `<div class="empty">${state.query ? 'No alerts match that search.' : 'No alerts in this view.'}</div>`}
      </div></div>
    </section>`);
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

const isDone = (s) => ['ok', 'failed', 'error'].includes(s.status);

// One entry per agent step; Verify carries its retries (the re-investigation and the second check).
function groupSteps(stages) {
  const by = (k) => stages.find((s) => s.key === k);
  const groups = [];
  const add = (key, label, parts) => {
    const list = parts.filter(Boolean);
    if (list.length) groups.push({ key, label, parts: list });
  };
  add('triage', 'Triage', [by('triage')]);
  add('context', 'Gather context', [by('context')]);
  add('investigate', 'Investigate', [by('investigate')]);
  add('verify', 'Verify', stages.filter((s) => /^(verify(_\d+)?|investigate_\d+)$/.test(s.key)));
  add('decide', 'Decide', [by('decide')]);
  for (const g of groups) {
    const checks = g.parts.filter((p) => p.key.startsWith(g.key));
    g.last = checks[checks.length - 1];
    g.running = g.parts.find((p) => p.status === 'running');
    g.status = g.running ? 'running' : g.parts.every((p) => p.status === 'queued') ? 'queued' : g.last.status;
    g.ms = g.parts.filter(isDone).reduce((t, p) => t + (p.duration_ms || 0), 0);
    g.model = (g.parts.find((p) => p.model) || {}).model || '';
    g.retried = g.parts.length > 1;
    const end = Math.max(0, ...g.parts.filter(isDone).map((p) => tsMs(p.started_at) + (p.duration_ms || 0)));
    g.justDone = g.status !== 'running' && end > 0 && Date.now() - end < 2500;
  }
  return groups;
}

// One short line per step; the full reasoning is one click away.
function stepResult(g) {
  if (g.last.status === 'error') return 'Error, open for details';
  const o = g.last.output || {};
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  switch (g.key) {
    case 'triage': return `${o.incident_type || '—'} · ${o.severity || '—'}`;
    case 'context': return `${n(o.playbook_sections)} playbook sections · ${n(o.similar_incidents)} past cases · ${n(o.related_alerts)} related`;
    case 'investigate': return `${cap(o.recommended_action || '—')} · ${Number(o.confidence || 0).toFixed(2)}`;
    case 'verify': return o.passed ? 'Passed' : 'Failed: ' + ((o.issues || [])[0] || 'did not pass');
    case 'decide': return (REVIEW[o.autonomy] || REVIEW.needs_approval)[0];
    default: return '';
  }
}

function retryLine(g) {
  if (!g.retried) return '';
  const inv = g.parts.filter((p) => p.key.startsWith('investigate'));
  const again = g.parts.filter((p) => p.key.startsWith('verify')).slice(1);
  let text;
  if (inv.some((p) => p.status === 'running')) text = 'Verify failed, re-investigating…';
  else if (again.some((p) => p.status === 'running')) text = 'Re-checking the new draft…';
  else {
    const revised = (inv[inv.length - 1].output || {}).recommended_action;
    text = `Retried${revised ? `: new draft ${revised}` : ''}, ${g.last.status === 'ok' ? 'passed' : 'failed again'}`;
  }
  return `<div class="retry">${g.running ? SPIN : ICON.retry}<span>${esc(text)}</span></div>`;
}

const pretty = (v) => esc(v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function partDetail(p, many) {
  if (!isDone(p)) return `<p class="muted">${p.status === 'running' ? 'Running now…' : 'Not started yet.'}</p>`;
  const issues = (p.output || {}).issues || [];
  return `<div class="part">
    ${many ? `<h4>${esc(p.name)}</h4>` : ''}
    <div class="part-meta mono">${p.model ? esc(shortModel(p.model)) : 'code'} · ${fmtMs(p.duration_ms)} · ${fmtN(p.input_tokens)} in / ${fmtN(p.output_tokens)} out · ${fmtCost(p.cost)}</div>
    ${p.error ? `<div class="error-box">${esc(p.error)}</div>` : ''}
    ${issues.length ? `<div><h5>Issues found</h5><ul class="issues">${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : `<div><h5>Reasoning</h5><p>${esc(p.reasoning || '—')}</p></div>`}
    ${(p.tools || []).length ? `<div><h5>Tool calls</h5>${p.tools.map((t) => `<div class="tool"><span class="mono">${esc(t.name)}</span><span>${esc(t.summary)}</span><span class="mono muted">${fmtMs(t.duration_ms)}</span></div>`).join('')}</div>` : ''}
    <div class="io">
      <div><h5>Input</h5><pre class="code light">${pretty(p.input)}</pre></div>
      <div><h5>Output</h5><pre class="code dark">${pretty(p.output)}</pre></div>
    </div>
  </div>`;
}

function stepRow(g) {
  const open = state.openSteps.has(g.key);
  const failed = g.last.status === 'failed' || g.last.status === 'error';
  const finished = g.status !== 'running' && g.status !== 'queued';
  let icon = ICON.check;
  if (g.status === 'running') icon = SPIN;
  else if (g.status === 'queued') icon = '<span class="qdot" aria-hidden="true"></span>';
  else if (failed) icon = ICON.cross;
  else if (g.key === 'decide' && (g.last.output || {}).autonomy !== 'auto') icon = `<span style="color:#B45309">${ICON.person}</span>`;

  let result;
  let meta;
  if (g.status === 'running') {
    const live = g.running;
    const tools = (live.tools || []).map((t) => `<span class="tick">${ICON.check}${esc(t.name)}</span>`).join('');
    result = `<span class="working">${esc(STEP_VERB[live.key.split('_')[0]] || 'Working')}${live.model ? ` with ${esc(shortModel(live.model))}` : ''}…</span>${tools ? `<span class="ticks">${tools}</span>` : '<span class="skeleton"></span>'}`;
    meta = timer(live.started_at);
  } else if (g.status === 'queued') {
    result = '<span class="muted">Waiting</span>';
    meta = '';
  } else {
    result = esc(stepResult(g));
    meta = `${g.model ? esc(shortModel(g.model)) : 'code'} · ${fmtMs(g.ms)}`;
  }
  const cls = ['step', failed && finished ? 'step-failed' : '', g.status === 'queued' ? 'step-queued' : '', g.status === 'running' ? 'step-running' : '', g.justDone ? 'just-done' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}">
    <button type="button" class="step-row" data-step="${g.key}" aria-expanded="${open}" ${isDone(g.parts[0]) ? '' : 'disabled'}>
      <span class="step-icon">${icon}</span>
      <span class="step-title">${esc(g.label)}</span>
      <span class="step-result">${result}</span>
      <span class="step-meta mono">${meta}</span>
      <span class="step-chevron" style="transform:rotate(${open ? 90 : 0}deg)">${ICON.right}</span>
    </button>
    ${retryLine(g)}
    ${open ? `<div class="step-detail">${g.parts.map((p) => partDetail(p, g.parts.length > 1)).join('')}</div>` : ''}
  </li>`;
}

function stepsCard(d) {
  const s = d.summary;
  const stages = d.stages || [];
  if (!stages.length) {
    return `<section class="card pad" data-tour="steps"><div class="card-head"><h2>How the AI decided</h2></div><div class="no-stages"><span>Steps weren't recorded for this result.</span><button type="button" class="btn btn-sm" data-rerun>Run again</button></div></section>`;
  }
  const groups = groupSteps(stages);
  const running = stages.find((p) => p.status === 'running');
  const bars = stages.filter((p) => isDone(p) || p.status === 'running').map((p) => {
    if (p.status === 'running') return `<span class="bar-live" data-grow-since="${esc(p.started_at)}" style="flex:${Math.max(1, Date.now() - tsMs(p.started_at))} 1 0"></span>`;
    return `<span title="${esc(p.name)} ${fmtMs(p.duration_ms)}" style="flex:${Math.max(p.duration_ms, 1)} 1 0;background:${p.status === 'ok' ? (p.model ? 'var(--accent)' : '#A1A1AA') : '#DC2626'}"></span>`;
  }).join('');
  const first = stages.find((p) => p.started_at);
  const total = running && first ? timer(first.started_at) : s.duration_ms == null ? '' : fmtMs(s.duration_ms);
  const tech = state.showTech ? `<div class="tech-meta mono">${s.input_tokens == null ? '' : `${fmtN(s.input_tokens + s.output_tokens)} tokens · ${fmtCost(s.cost)} · ${(s.models || []).map(shortModel).join(', ')}`}${d.trace_id ? ` · trace ${esc(d.trace_id)}` : ''}</div>${techTimeline(stages)}` : '';
  return `<section class="card pad" aria-label="How the AI decided" data-tour="steps">
    <div class="card-head"><h2>How the AI decided</h2><span class="mono muted" style="margin-left:auto;font-size:12px">${total}</span></div>
    <div class="timebar" aria-hidden="true">${bars}</div>
    <ol class="steps">${groups.map(stepRow).join('')}</ol>
    <div class="card-foot"><button type="button" class="link-btn" data-tour="tech-toggle" data-toggle-tech aria-expanded="${state.showTech}">${state.showTech ? 'Hide' : 'Show'} technical details</button></div>
    ${tech}
  </section>`;
}

// Engineer view: every stage and tool call placed on a time axis, with a side panel for the selected stage.
function techTimeline(stages) {
  const timed = stages.filter((p) => p.started_at);
  if (!timed.length) return '';
  const t0 = Math.min(...timed.map((p) => tsMs(p.started_at)));
  const now = Date.now();
  const span = (p) => { const a = tsMs(p.started_at) - t0; return [a, p.status === 'running' ? now - t0 - a : p.duration_ms || 0]; };
  const total = Math.max(1, ...timed.map((p) => { const [a, b] = span(p); return a + b; }));
  const P = (ms) => (100 * ms) / total;
  const key = state.techKey || timed[0].key;
  const rows = [];
  for (const p of timed) {
    const [start, dur] = span(p);
    const color = p.status === 'failed' || p.status === 'error' ? '#DC2626' : p.status === 'running' ? 'var(--accent)' : barColor(p.key);
    rows.push(`<button type="button" class="wrow" data-tech="${esc(p.key)}" aria-pressed="${key === p.key}">
      <span class="wname"><span style="font-weight:600">${esc(p.name)}</span></span>
      <span class="wmodel${p.model ? '' : ' none'}">${p.model ? esc(shortModel(p.model)) : '—'}</span>
      <span class="wnum">${p.input_tokens ? `${fmtN(p.input_tokens)} / ${fmtN(p.output_tokens)}` : '—'}</span>
      <span class="wnum">${isDone(p) ? fmtMs(p.duration_ms) : 'running'}</span>
      <span class="track"><span class="bar" style="left:${P(start)}%;width:${Math.max(P(dur), 0.4)}%;background:${color}"></span></span>
    </button>`);
    let cursor = start;
    for (const t of p.tools || []) {
      rows.push(`<button type="button" class="wrow child" data-tech="${esc(p.key)}" aria-pressed="${key === p.key}">
        <span class="wname" style="padding-left:18px"><span class="mono" style="color:var(--ink-2)">${esc(t.name)}</span></span>
        <span class="wmodel none">tool</span><span class="wnum">—</span><span class="wnum">${fmtMs(t.duration_ms)}</span>
        <span class="track"><span class="bar" style="left:${P(cursor)}%;width:${Math.max(P(t.duration_ms), 0.3)}%;background:${color}"></span></span>
      </button>`);
      cursor += t.duration_ms;
    }
  }
  const sel = stages.find((p) => p.key === key) || timed[0];
  return `<div class="tech">
    <div class="scroll-x tech-left"><div class="wf">
      <div class="wrow whead"><span>Stage</span><span>Model</span><span class="right">Tokens in/out</span><span class="right">Time</span>
        <span class="axis"><span style="left:0">0</span><span style="left:50%;transform:translateX(-50%)">${fmtMs(total / 2)}</span><span style="left:100%;transform:translateX(-100%)">${fmtMs(total)}</span></span></div>
      ${rows.join('')}
    </div></div>
    <div class="tech-right">${partDetail(sel, true)}</div>
  </div>`;
}

function auditList(d) {
  const items = (d.audit || []).filter((e) => e.event_type !== 'alert_received').map((e) => {
    const p = e.payload || {};
    let what = e.event_type.replace(/_/g, ' ');
    if (e.event_type === 'analyst_action') {
      what = p.decision === 'override' ? `changed ${p.recommended_action} → ${p.final_action}` : p.decision === 'escalate' ? 'escalated to Tier 2' : `approved ${p.final_action}`;
    }
    return { ts: e.ts, html: `<li><span class="mono muted when">${esc(fmtWhen(e.ts))}</span><div><b>${esc(e.actor)}</b> ${esc(what)}${p.note ? `<div class="muted" style="font-style:italic">“${esc(p.note)}”</div>` : ''}</div></li>` };
  });
  const s = d.summary;
  if (s.triaged_at) items.unshift({ ts: s.triaged_at, html: `<li><span class="mono muted when">${esc(fmtWhen(s.triaged_at))}</span><div><b>AI</b> recommended ${esc(s.recommended_action)}${s.status === 'auto' ? ', auto-handled' : ''}</div></li>` });
  // Oldest first: a re-run after an analyst decision lands after that decision, not on top of it.
  items.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  return items.length ? `<ol class="audit">${items.map((x) => x.html).join('')}</ol>` : '<p class="muted">No events yet.</p>';
}

function sideCards(d) {
  const related = d.related || [];
  return `
    <section class="card pad" aria-label="Related alerts" data-tour="related">
      <div class="card-head"><h2>Related alerts</h2><span class="count-badge">${related.length}</span></div>
      ${related.length ? `<ul class="plain">${related.map((r) => {
        const inner = `<span class="rel-top"><span class="mono">${esc(r.alert_id)}</span><span class="muted">${esc(r.match)}</span></span><span class="rel-type">${esc(r.incident_type || r.description)}</span>`;
        return `<li>${r.has_result ? `<a class="rel" href="#/alert/${encodeURIComponent(r.alert_id)}">${inner}</a>` : `<div class="rel">${inner}</div>`}</li>`;
      }).join('')}</ul>` : '<p class="muted">None in the last 72 hours.</p>'}
    </section>
    <section class="card pad" aria-label="Similar past incidents" data-tour="similar">
      <div class="card-head"><h2>Similar past incidents</h2></div>
      ${(d.similar || []).length ? `<ul class="plain">${d.similar.map((x) => {
        const key = 'sim-' + x.incident_id;
        return `<li class="sim"><div><span class="mono" style="color:var(--accent)">${esc(x.incident_id)}</span> <span class="muted">${esc(x.outcome)}</span> ${x.resolution ? moreBtn(key, 'How') : ''}</div>${state.expanded.has(key) ? `<p>${esc(x.resolution)}</p>` : ''}</li>`;
      }).join('')}</ul>` : '<p class="muted">None found.</p>'}
    </section>
    <section class="card pad" aria-label="Audit trail" data-tour="audit">
      <div class="card-head"><h2>Audit trail</h2></div>
      ${auditList(d)}
    </section>`;
}

function verdictBlock(d) {
  const s = d.summary;
  if (s.status === 'running') {
    const stages = d.stages || [];
    const cur = stages.find((x) => x.status === 'running');
    const base = stages.filter((x) => !/_\d+$/.test(x.key));
    const n = base.length || 5;
    const idx = Math.max(1, base.filter((x) => x.status !== 'queued').length);
    return `<div class="verdict-card"><div class="running-box">${SPIN}<div><b>${esc(cur ? STEP_VERB[cur.key.split('_')[0]] || cur.name : 'Starting')}…</b><div class="muted" style="font-size:12.5px">Step ${idx} of ${n}${cur ? ' · ' + timer(cur.started_at) : ''}</div></div></div></div>`;
  }
  if (s.status === 'failed') {
    return `<div class="verdict-card"><div class="error-box"><b>The pipeline failed on this alert.</b><div style="margin-top:4px">${esc(d.error || s.error)}</div><button type="button" class="btn btn-sm" data-rerun style="margin-top:10px">Run again</button></div></div>`;
  }
  const [afg] = ACT[s.final_action] || ['#3F3F46'];
  const rv = REVIEW[s.autonomy] || REVIEW.needs_approval;
  const reasons = d.policy_reasons || [];
  const why = state.expanded.has('reasons') && reasons.length ? `<ul class="issues review-why">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  let decision;
  if (s.status === 'pending') {
    decision = `<div class="verdict-actions" data-tour="decision-actions">
        <button type="button" class="btn btn-dark" data-decide="approve">Approve ${esc(s.recommended_action)}</button>
        <button type="button" class="btn" data-toggle-override aria-expanded="${state.overrideOpen}">Change action</button>
        ${s.recommended_action === 'escalate' ? '' : '<button type="button" class="btn" data-decide="escalate">Escalate to Tier 2</button>'}
        <span class="review-line">${ICON.person}${esc(rv[0])} ${reasons.length ? moreBtn('reasons', 'Why?') : ''}</span>
      </div>
      ${why}
      ${state.overrideOpen ? `<div class="actions" style="margin-top:8px">${['monitor', 'isolate', 'escalate', 'close'].filter((x) => x !== s.recommended_action).map((x) => `<button type="button" class="btn btn-sm" data-override="${x}" style="border:0;color:${ACT[x][0]};background:${ACT[x][1]};font-weight:600">${cap(x)}</button>`).join('')}</div>` : ''}
      <input id="note" class="note-input${state.noteError ? ' invalid' : ''}" type="text" aria-label="Note" placeholder="${state.overrideOpen ? 'Why are you changing it? (required)' : 'Note (optional)'}" value="${esc(state.note)}" ${state.noteError ? 'aria-invalid="true" aria-describedby="note-err"' : ''}>
      ${state.noteError ? `<div id="note-err" class="field-error">${esc(state.noteError)}</div>` : ''}`;
  } else if (s.status === 'auto') {
    decision = `<div class="verdict-actions"><div class="decided">${ICON.check} Auto-handled by policy, no analyst needed</div></div>`;
  } else {
    decision = `<div class="verdict-actions"><div class="decided">${ICON.check} ${esc(STATUS[s.status][0])}${s.decided_at ? ' · ' + esc(fmtWhen(s.decided_at)) : ''}</div></div>`;
  }
  const cites = d.citations || [];
  return `<div class="verdict-card" data-tour="verdict">
      <div class="verdict-head">
        <span class="verdict-label">Recommended action</span>
        <span class="verdict-action" style="color:${afg}">${esc(cap(s.final_action))}${s.status === 'overridden' ? ` <s>${esc(s.recommended_action)}</s>` : ''}</span>
        <span class="verdict-conf">confidence ${s.confidence.toFixed(2)}</span>
      </div>
      ${d.reasoning ? `<p class="verdict-why">${esc(d.reasoning)}</p>` : ''}
      ${cites.length ? `<div class="based-on"><span class="label">Based on</span>${playbookLinks(cites)}</div>` : ''}
      <div class="findings" data-tour="findings"><h3>What the AI found</h3><ul>${findings(d).map(([icon, text, cls]) => `<li class="${cls}"><span class="ficon">${icon}</span><span class="clamp2">${esc(text)}</span></li>`).join('')}</ul></div>
      ${decision}
    </div>`;
}

// One link per cited playbook ("DDoS playbook · Detection, Analysis"). It opens the whole playbook with the cited
// sections highlighted.
function playbookLinks(cites) {
  const books = new Map();
  for (const c of cites) {
    const name = c.playbook || (c.chunk_id || '').split('::')[0];
    if (!books.has(name)) books.set(name, { title: c.title || cap(name.replace(/_/g, ' ')), sections: [] });
    books.get(name).sections.push(c.section);
  }
  return [...books].map(([name, b]) => `<a class="pb-link" href="#/playbook/${encodeURIComponent(name)}">${ICON.book}${esc(b.title)} playbook</a><span class="muted">${esc(b.sections.join(', '))}</span>`).join('');
}

// Three short facts the header doesn't already show: what similar cases became, related activity, and whether
// Verify agreed. (Type and severity are in the title; a severity disagreement shows as the "source said" tag.)
function findings(d) {
  const stages = d.stages || [];
  const similar = d.similar || [];
  const related = d.related || [];
  const ver = d.verification || {};
  const retried = stages.some((p) => /^verify_\d+$/.test(p.key));
  const out = [];
  if (similar.length) out.push([ICON.history, `${similar.length} similar past ${similar.length === 1 ? 'case' : 'cases'}: ${similar.map((x) => x.outcome).filter(Boolean).join('; ')}`, '']);
  out.push([ICON.link, related.length ? `${related.length} other ${related.length === 1 ? 'alert' : 'alerts'} for this user or device in the last 72 hours` : 'No other alerts for this user or device in the last 72 hours', '']);
  out.push(ver.passed === false
    ? [ICON.cross, `Verifier flagged: ${(ver.issues || [])[0] || 'the citations did not support the action'}`, 'bad']
    : [ICON.shield, `Verified: citations and evidence check out${retried ? ' (after one retry)' : ''}`, 'good']);
  return out;
}

function renderDetail(id) {
  const d = state.detail;
  if (!d || state.detailId !== id) { setApp('<p class="muted">Loading alert…</p>'); return; }
  const s = d.summary;
  const visible = visibleAlerts();
  const order = visible.some((a) => a.alert_id === id) ? visible : prioritized(state.list || []);
  const idx = order.findIndex((a) => a.alert_id === id);
  const prev = idx > 0 ? order[idx - 1] : null;
  const next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const navLink = (a, label, icon) => (a ? `<a class="btn btn-icon" href="#/alert/${encodeURIComponent(a.alert_id)}" aria-label="${label}">${icon}</a>` : `<span class="btn btn-icon" aria-disabled="true" aria-label="${label}">${icon}</span>`);
  const done = s.status !== 'running' && s.status !== 'failed';
  const fields = [
    ['Received', fmtWhen(s.received_at)], ['Source', d.alert.source_system], ['Source severity', s.given_severity],
    ['User', d.alert.affected_user], ['Device', d.alert.affected_device],
  ];
  const mismatch = done && !s.severity_consistent;

  setApp(`
    <nav class="crumbs" data-tour="crumbs" aria-label="Alert navigation">
      <a class="btn btn-sm" href="#/">${ICON.left} All alerts</a>
      <span class="mono" style="font-size:13px">${esc(id)}</span>
      <span class="pos">${idx >= 0 ? `${idx + 1} of ${order.length}` : ''}${navLink(prev, 'Previous alert', ICON.left)}${navLink(next, 'Next alert', ICON.right)}</span>
    </nav>
    <section class="card" aria-label="Alert summary">
      <div class="summary">
        <div class="summary-main" data-tour="summary">
          <h1>${esc(s.incident_type || 'New alert')} ${attackChip(s.attack_id)}</h1>
          <div class="sub">${s.severity ? sevLabel(s.severity) : ''}${mismatch ? `<span class="warn-inline">source said ${esc(s.given_severity)}</span>` : ''}${statusChip(s)}</div>
          <p>${esc(s.description)}</p>
          <dl class="fields" data-tour="fields">${fields.map(([l, v]) => `<div><dt>${l}</dt><dd>${esc(v || '—')}</dd></div>`).join('')}</dl>
        </div>
      </div>
      ${verdictBlock(d)}
    </section>
    <div class="columns">
      <div class="col-main">
        ${stepsCard(d)}
      </div>
      <div class="col-side">${done ? sideCards(d) : ''}</div>
    </div>`);
}

// ---------------------------------------------------------------------------
// Playbook page: the whole playbook, with the sections this alert cited highlighted and the linked one in view.
// ---------------------------------------------------------------------------

function renderPlaybook(r) {
  const pb = state.playbooks[r.name];
  if (!pb) { setApp('<p class="muted">Loading playbook…</p>'); return; }
  const fromAlert = state.detailId && state.detail;
  const cited = new Set(((fromAlert && state.detail.citations) || []).map((c) => c.chunk_id));
  if (r.section) cited.add(`${r.name}::${r.section}`);
  setApp(`
    <nav class="crumbs" aria-label="Playbook navigation">
      <a class="btn btn-sm" href="${fromAlert ? `#/alert/${encodeURIComponent(state.detailId)}` : '#/'}">${ICON.left} ${fromAlert ? esc(state.detailId) : 'All alerts'}</a>
    </nav>
    <section class="card" aria-label="${esc(pb.title)} playbook">
      <div class="pb-head"><h1>${esc(pb.title)} playbook</h1>${pb.attack ? `<p>ATT&amp;CK ${esc(pb.attack)}</p>` : ''}</div>
      ${pb.sections.map((sec) => {
        const on = cited.has(sec.chunk_id);
        const body = sec.blocks.map((b) => (b.list ? `<ul>${b.list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(b.text)}</p>`)).join('');
        return `<section class="pb-section${on ? ' cited' : ''}" id="pb-${esc(sec.slug)}"><h2>${esc(sec.section)}${on ? '<span class="cited-tag">Cited</span>' : ''}</h2>${body}</section>`;
      }).join('')}
    </section>`);
  if (state.pbScroll && r.section) {
    state.pbScroll = false;
    document.getElementById('pb-' + r.section)?.scrollIntoView({ block: 'start' });
  }
}

// ---------------------------------------------------------------------------
// Rendering, events, polling
// ---------------------------------------------------------------------------

// Only touch the DOM when the markup changed, and keep focus and caret in a text field across redraws.
let lastHtml = '';
function setApp(html) {
  if (html === lastHtml) return;
  const active = document.activeElement;
  const id = active && app.contains(active) ? active.id : '';
  const caret = id && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  lastHtml = html;
  app.innerHTML = html;
  if (id) {
    const el = document.getElementById(id);
    if (el) {
      el.focus({ preventScroll: true });
      if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
    }
  }
  tick();
}

function render() {
  const r = route();
  if (r.view === 'detail') renderDetail(r.id);
  else if (r.view === 'playbook') renderPlaybook(r);
  else renderList();
}

// Live timers and the growing progress bar, updated in place so spinners keep spinning smoothly.
function tick() {
  const now = Date.now();
  for (const el of app.querySelectorAll('[data-since]')) el.textContent = fmtMs(now - tsMs(el.dataset.since));
  for (const el of app.querySelectorAll('[data-age]')) { const v = fmtAge(el.dataset.age); if (el.textContent !== v) el.textContent = v; }
  for (const el of app.querySelectorAll('[data-grow-since]')) el.style.flexGrow = String(Math.max(1, now - tsMs(el.dataset.growSince)));
}

// Every second: ask the server for its version number; reload the list (and the open alert) only when it changed.
async function refresh(force = false) {
  const r = route();
  try {
    if (r.view === 'playbook') {  // static content: load once, no polling
      if (!state.playbooks[r.name]) state.playbooks[r.name] = await api('/api/playbooks/' + r.name);
      render();
      return;
    }
    const live = await api('/api/live');
    const changed = force || live.version !== state.version || Date.now() - state.lastFull > 30000;
    if (changed) {
      state.version = live.version;
      state.lastFull = Date.now();
      await loadList();
      if (r.view === 'detail') await loadDetail(r.id);
    } else if (r.view === 'detail' && state.detailId !== r.id) {
      await loadDetail(r.id);
    }
  } catch (e) {
    noteEl.hidden = false;
    noteEl.textContent = "Couldn't reach the server: " + e.message.slice(0, 200);
  }
  render();
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); state.pbScroll = true; refresh(true); });

app.addEventListener('input', (e) => {
  if (e.target.id === 'note') { state.note = e.target.value; if (state.noteError && state.note.trim()) { state.noteError = ''; render(); } }
  if (e.target.id === 'search') { state.query = e.target.value; render(); }
});

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-filter],[data-sort],[data-step],[data-tech],[data-expand],[data-decide],[data-override],[data-toggle-override],[data-toggle-metrics],[data-toggle-tech],[data-rerun]');
  if (!el || state.busy) return;
  const id = state.detailId;
  const ds = el.dataset;
  const toggle = (set, key) => { if (set.has(key)) set.delete(key); else set.add(key); render(); };
  if (ds.filter) { state.filter = ds.filter; render(); return; }
  if ('sort' in ds) { state.sort = SORTS[state.sort][0]; render(); return; }
  if ('toggleMetrics' in ds) { state.showMetrics = !state.showMetrics; render(); return; }
  if ('toggleTech' in ds) { state.showTech = !state.showTech; render(); return; }
  if (ds.tech) { state.techKey = ds.tech; render(); return; }
  if (ds.expand) { e.preventDefault(); toggle(state.expanded, ds.expand); return; }
  if (ds.step) { toggle(state.openSteps, ds.step); return; }
  if ('toggleOverride' in ds) { state.overrideOpen = !state.overrideOpen; render(); return; }
  if (ds.override && !state.note.trim()) {
    state.noteError = 'Add a note explaining the change.';
    render();
    document.getElementById('note')?.focus();
    return;
  }
  state.busy = true;
  el.disabled = true;
  el.textContent = 'rerun' in ds ? 'Starting…' : 'Saving…';
  try {
    if (ds.decide) {
      state.detail = await api(`/api/alerts/${encodeURIComponent(id)}/decision`, { decision: ds.decide, note: state.note });
    } else if (ds.override) {
      state.detail = await api(`/api/alerts/${encodeURIComponent(id)}/decision`, { decision: 'override', final_action: ds.override, note: state.note });
    } else if ('rerun' in ds) {
      await api(`/api/alerts/${encodeURIComponent(id)}/rerun`, {});
      await loadDetail(id);
    }
    Object.assign(state, { overrideOpen: false, note: '', noteError: '' });
    await loadList();
  } catch (err) {
    alert("That didn't work: " + err.message.slice(0, 300));
  } finally {
    state.busy = false;
    lastHtml = '';
    render();
  }
});

document.getElementById('simulate').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { alert_id } = await api('/api/simulate', {});
    state.knownIds?.add(alert_id);  // you opened it yourself: no toast
    state.newIds[alert_id] = Date.now();
    location.hash = '#/alert/' + encodeURIComponent(alert_id);
  } catch (err) {
    alert("Couldn't simulate an alert: " + err.message.slice(0, 300));
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Demo mode: guided walkthrough for new analysts (switch state is per browser; the server can hide it)
// ---------------------------------------------------------------------------

const demoToggle = document.getElementById('demo-toggle');
const DEMO_KEY = 'indigo.demoMode';
const demoSaved = () => { try { return localStorage.getItem(DEMO_KEY) === '1'; } catch (e) { return false; } };
const demoSave = (on) => { try { localStorage.setItem(DEMO_KEY, on ? '1' : '0'); } catch (e) { /* storage blocked */ } };

function demoShow(on) {
  demoToggle.setAttribute('aria-checked', String(on));
  demoToggle.title = on ? 'Demo mode is on: guided walkthrough running' : '';
  demoSave(on);
}

function setDemo(on, { resume = false } = {}) {
  demoShow(on);
  if (on) window.DemoTour?.start({ resume });
  else window.DemoTour?.stop();
}

demoToggle.addEventListener('click', () => setDemo(demoToggle.getAttribute('aria-checked') !== 'true', { resume: false }));

// The tour ended itself (finished, skipped or Esc): flip the switch off without stopping it again.
window.addEventListener('demotour:end', () => demoShow(false));

refresh(true);
setInterval(refresh, 1000);
setInterval(tick, 200);

api('/api/config').then((cfg) => {
  if (!cfg.features?.demo_mode) return;
  demoToggle.hidden = false;
  if (demoSaved()) setDemo(true, { resume: true });
}).catch(() => { /* no config: leave the switch hidden */ });
