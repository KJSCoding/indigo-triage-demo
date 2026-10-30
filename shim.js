// Public demo shim: answers the console's /api calls from a snapshot of real pipeline results (data.json),
// so the page runs with no server and no login. Analyst decisions are kept in this browser only.
(function () {
  const realFetch = window.fetch.bind(window);
  const KEY = 'indigo.publicDemo.audit';
  let version = 1;
  const dataReady = realFetch('data.json').then((r) => r.json());

  const loadAudit = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
  const saveAudit = (a) => { try { localStorage.setItem(KEY, JSON.stringify(a.filter((e) => !String(e.alert_id).startsWith('SIM-')))); } catch (e) { /* storage blocked */ } };
  let audit = loadAudit();

  const STATUS = { approve: 'approved', escalate: 'escalated', override: 'overridden' };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function applyDecision(summary, id) {
    let last = null;
    for (const e of audit) if (e.alert_id === id && e.event_type === 'analyst_action') last = e;
    if (!last) return summary;
    return { ...summary, status: STATUS[last.payload.decision] || 'approved',
      final_action: last.payload.final_action || summary.recommended_action, decided_at: last.ts };
  }

  function listResponse(snap) {
    const d = clone(snap['/api/alerts']);
    d.alerts = d.alerts.map((a) => applyDecision(a, a.alert_id));
    const sims = Object.entries(runs).map(([i, r]) => runSummary(i, r));
    d.alerts = sims.filter((a) => a.status === 'running').concat(sims.filter((a) => a.status !== 'running').reverse(), d.alerts);
    d.totals.triaged = d.alerts.filter((a) => a.status !== 'running').length;
    d.totals.auto = d.alerts.filter((a) => a.status === 'auto').length;
    d.totals.needs_review = d.alerts.filter((a) => a.status === 'pending').length;
    return d;
  }

  function detailResponse(snap, id) {
    const base = snap['/api/alerts/' + id];
    if (!base) return null;
    const d = clone(base);
    d.audit = (d.audit || []).concat(audit.filter((e) => e.alert_id === id));
    d.summary = applyDecision(d.summary, id);
    return d;
  }


  // ---- Simulate: replay a run the real pipeline recorded, stage by stage, at its recorded timings ----
  const runs = {};   // SIM id -> {base, t0, plan}
  const used = new Set();
  const ms = (iso) => new Date(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z')).getTime();
  const iso = (t) => new Date(t).toISOString();

  function startRun(snap) {
    const pool = snap['/api/alerts'].alerts.filter((a) => a.has_stages && !used.has(a.alert_id));
    const pick = pool[Math.floor(Math.random() * pool.length)] || snap['/api/alerts'].alerts[0];
    used.add(pick.alert_id);
    const base = snap['/api/alerts/' + pick.alert_id];
    const st = base.stages.filter((x) => x.started_at);
    const o0 = Math.min(...st.map((x) => ms(x.started_at)));
    const id = 'SIM-' + Math.random().toString(16).slice(2, 8).toUpperCase();
    runs[id] = { base, t0: Date.now() + 600, plan: base.stages.map((x) => ({ x, off: ms(x.started_at) - o0, end: ms(x.started_at) - o0 + (x.duration_ms || 0) })) };
    audit.push({ audit_id: id + '-r', alert_id: id, event_type: 'alert_received',
      payload: { source: 'simulated', replay_of: pick.alert_id, description: base.summary.description },
      actor: 'you (public demo)', ts: iso(Date.now()), trace_id: '' });
    return id;
  }

  function stagesAt(run) {
    const e = Date.now() - run.t0;
    return run.plan.map(({ x, off, end }) => {
      const started = iso(run.t0 + off);
      if (e >= end && e >= 0) return { ...x, started_at: started };
      if (e >= off && e >= 0) return { ...x, status: 'running', started_at: started, duration_ms: 0, input_tokens: 0, output_tokens: 0, cost: 0, llm_calls: [], tools: [], output: null, reasoning: '' };
      return { ...x, status: 'queued', started_at: null, duration_ms: 0, input_tokens: 0, output_tokens: 0, cost: 0, llm_calls: [], tools: [], input: null, output: null, reasoning: '', model: '' };
    });
  }
  const isFinished = (run) => Date.now() - run.t0 >= Math.max(...run.plan.map((p) => p.end));

  function metrics(done) {
    if (!done.length) return { duration_ms: null, input_tokens: null, output_tokens: null, cost: null, models: [] };
    const starts = done.map((x) => ms(x.started_at)), ends = done.map((x, i) => starts[i] + (x.duration_ms || 0));
    return { duration_ms: Math.round(Math.max(...ends) - Math.min(...starts)),
      input_tokens: done.reduce((a, x) => a + (x.input_tokens || 0), 0), output_tokens: done.reduce((a, x) => a + (x.output_tokens || 0), 0),
      cost: done.reduce((a, x) => a + (x.cost || 0), 0), models: [...new Set(done.map((x) => x.model).filter(Boolean))].sort() };
  }

  function runSummary(id, run) {
    const b = run.base.summary, stages = stagesAt(run);
    if (isFinished(run)) {
      return applyDecision({ ...b, alert_id: id, received_at: iso(run.t0), triaged_at: iso(run.t0 + Math.max(...run.plan.map((p) => p.end))),
        decided_at: '', status: b.autonomy === 'auto' ? 'auto' : 'pending', final_action: b.recommended_action, ...metrics(stages) }, id);
    }
    const done = stages.filter((x) => x.status !== 'running' && x.status !== 'queued');
    const tri = (done.find((x) => x.key === 'triage') || {}).output || {};
    return { alert_id: id, received_at: iso(run.t0), triaged_at: '', incident_type: tri.incident_type || '', severity: tri.severity || '',
      given_severity: b.given_severity, severity_consistent: true, description: b.description, recommended_action: '', final_action: '',
      affected_user: b.affected_user, affected_device: b.affected_device, attack_id: '', decided_at: '', status: 'running', autonomy: '',
      confidence: 0, verified: true, has_stages: true, progress: `${done.length} of ${stages.length}`,
      current: (stages.find((x) => x.status === 'running') || {}).name || 'Starting', error: '', ...metrics(done) };
  }

  function runDetail(id, run) {
    const s = runSummary(id, run), stages = stagesAt(run), mine = audit.filter((e) => e.alert_id === id);
    if (s.status === 'running') return { summary: s, running: true, alert: run.base.alert, stages, audit: mine, error: '' };
    return { ...clone(run.base), summary: s, running: false, stages, audit: mine, trace_id: '' };
  }

  const liveVersion = () => version + Object.values(runs).reduce((a, r) => a + stagesAt(r).filter((x) => x.status === 'ok' || x.status === 'running').length + (isFinished(r) ? 1 : 0), 0);

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const ACTIONS = ['monitor', 'isolate', 'escalate', 'close'];

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(location.origin, '').split('?')[0];
    if (!path.startsWith('/api/')) return realFetch(input, init);
    const snap = await dataReady;
    const method = (init && init.method) || 'GET';

    if (path === '/api/live') return json({ version: liveVersion(), running: Object.entries(runs).filter(([, r]) => !isFinished(r)).map(([i, r]) => runSummary(i, r)) });
    if (path === '/api/config') return json({ features: { demo_mode: true } });
    if (path === '/api/alerts') return json(listResponse(snap));
    if (path.startsWith('/api/playbooks/')) {
      const pb = snap[path];
      return pb ? json(pb) : json({ detail: 'No such playbook' }, 404);
    }
    const m = path.match(/^\/api\/alerts\/([^/]+)(\/(decision|rerun))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (runs[id] && m[3] !== 'decision') return json(runDetail(id, runs[id]));
      if (m[3] === 'rerun') return json({ detail: 'Running the pipeline is turned off in this public copy.' }, 400);
      if (m[3] === 'decision' && method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        const s = runs[id] ? runSummary(id, runs[id]) : snap['/api/alerts/' + id]?.summary;
        if (!s) return json({ detail: 'Unknown alert' }, 404);
        const final = { approve: s.recommended_action, escalate: 'escalate' }[body.decision] || body.final_action;
        if (!ACTIONS.includes(final)) return json({ detail: 'Pick an action.' }, 400);
        audit.push({ audit_id: String(Date.now()), alert_id: id, event_type: 'analyst_action',
          payload: { recommended_action: s.recommended_action, autonomy: s.autonomy, confidence: s.confidence,
            note: body.note || '', decision: body.decision, final_action: final },
          actor: 'you (public demo)', ts: new Date().toISOString(), trace_id: '' });
        saveAudit(audit);
        version += 1;
        return json(runs[id] ? runDetail(id, runs[id]) : detailResponse(snap, id));
      }
      const d = detailResponse(snap, id);
      return d ? json(d) : json({ detail: 'Unknown alert' }, 404);
    }
    if (path === '/api/simulate') { const id = startRun(snap); version += 1; return json({ alert_id: id }); }
    return json({ detail: 'Not available in the public demo' }, 404);
  };
})();
