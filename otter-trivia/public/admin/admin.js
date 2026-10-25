'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  let data = null;
  let refreshTimer = null;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(() => { throw new Error('Network error. Check your connection.'); });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null));
    return node;
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  // ---- views ----
  function showLogin() {
    clearInterval(refreshTimer);
    $('#loginView').hidden = false;
    $('#dashView').hidden = true;
    $('#logoutBtn').hidden = true;
    $('#password').focus();
  }

  function showDash() {
    $('#loginView').hidden = true;
    $('#dashView').hidden = false;
    $('#logoutBtn').hidden = false;
    load();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(load, 15000);
  }

  async function load() {
    try {
      data = await api('/api/admin/participants');
      render();
    } catch (err) {
      if (err.status === 401) return showLogin();
      toast(err.message);
    }
  }

  function render() {
    const s = data.stats;
    $('#stats').replaceChildren(
      ...[
        ['Registered', s.registered],
        ['Completed', s.completed],
        ['Raffle entries', s.raffleEntries],
        ['Marketing opt-ins', s.marketingOptIns],
        ['Avg score', s.averageScore == null ? '–' : `${s.averageScore.toFixed(1)}/8`],
      ].map(([k, v]) => el('div', { className: 'stat' }, el('span', { textContent: k }), el('strong', { textContent: String(v) }))),
    );

    const ev = data.event;
    $('#raffleRule').textContent =
      (ev.raffleMinScore > 0
        ? `Everyone who finishes with ${ev.raffleMinScore}+ correct gets one entry. `
        : 'Everyone who finishes the quiz gets one equal entry, whatever their score. ') +
      `Prize: ${ev.prizeName}. Each draw picks uniformly at random from eligible entries not drawn before.`;

    const drawnIds = new Set(data.draws.map((d) => d.participantId));
    const pool = data.participants.filter((p) => p.raffleEligible && !drawnIds.has(p.id)).length;
    $('#poolCount').textContent = String(pool);
    $('#poolLabel').textContent = pool === 1 ? 'eligible entry' : 'eligible entries';
    $('#drawBtn').disabled = pool === 0;
    $('#drawCount').textContent = String(data.draws.length);
    $('#drawList').replaceChildren(
      ...data.draws.map((d) => el('li', { textContent: `${fmtTime(d.drawnAt)}: ${d.fullName} (${d.entryCode}), drawn from ${d.poolSize} entries` })),
    );

    const url = `${data.publicUrl}/`;
    $('#qrUrl').textContent = url;
    const img = $('#qrImg');
    if (!img.src) img.src = `/qr.svg?v=${Date.now()}`;
    $('#qrWarn').hidden = /^https:\/\//.test(url) && !/\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(url);

    renderRows(drawnIds);
  }

  function matches(p, q, filter) {
    if (filter === 'completed' && p.status !== 'completed') return false;
    if (filter === 'incomplete' && p.status === 'completed') return false;
    if (filter === 'raffle' && !p.raffleEligible) return false;
    if (filter === 'consent' && !p.marketingConsent) return false;
    if (!q) return true;
    const digits = q.replace(/\D/g, '');
    return (
      p.fullName.toLowerCase().includes(q) ||
      p.business.toLowerCase().includes(q) ||
      p.entryCode.toLowerCase().includes(q) ||
      (digits.length >= 3 && p.phone.includes(digits))
    );
  }

  function statusTag(p) {
    if (p.status === 'completed') return el('span', { className: 'tag ok', textContent: 'Completed' });
    if (p.answered > 0) return el('span', { className: 'tag pending', textContent: `In progress ${p.answered}/${p.total}` });
    return el('span', { className: 'tag no', textContent: 'Registered' });
  }

  function renderRows(drawnIds) {
    const q = $('#search').value.trim().toLowerCase();
    const filter = $('#filter').value;
    const list = data.participants.filter((p) => matches(p, q, filter));
    $('#tableMeta').textContent = `Showing ${list.length} of ${data.participants.length} participants · refreshes every 15s`;
    const rows = list.map((p) => {
      const del = el('button', { className: 'btn danger', type: 'button', textContent: 'Delete' });
      del.addEventListener('click', () => onDelete(p));
      const tr = el('tr', {},
        el('td', { className: 'wrap-cell' }, el('strong', { textContent: p.fullName })),
        el('td', { textContent: p.phoneDisplay }),
        el('td', { className: 'wrap-cell', textContent: p.business || '–' }),
        el('td', {}, el('span', { className: `tag ${p.marketingConsent ? 'ok' : 'no'}`, textContent: p.marketingConsent ? 'Yes' : 'No' })),
        el('td', { textContent: fmtTime(p.registeredAt) }),
        el('td', { textContent: p.status === 'completed' ? `${p.score}/${p.total}` : '–' }),
        el('td', {}, statusTag(p)),
        el('td', { className: 'code', textContent: p.raffleEligible ? p.entryCode : '–' }),
        el('td', {}, del),
      );
      if (drawnIds.has(p.id)) tr.className = 'is-winner';
      return tr;
    });
    if (!rows.length) rows.push(el('tr', {}, el('td', { colSpan: 9, className: 'empty', textContent: data.participants.length ? 'No matches.' : 'No participants yet.' })));
    $('#rows').replaceChildren(...rows);
  }

  // ---- actions ----
  async function onDraw() {
    if (!window.confirm('Draw a raffle winner now? The draw is recorded in the history.')) return;
    const btn = $('#drawBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/admin/draw', { method: 'POST', body: {} });
      const w = r.winner;
      const box = $('#winnerBox');
      box.replaceChildren(
        el('p', { className: 'w-label', textContent: '🎉 Winner' }),
        el('p', { className: 'w-name', textContent: w.fullName }),
        el('p', { textContent: `${w.phoneDisplay}${w.business ? ` · ${w.business}` : ''}` }),
        el('p', { className: 'code', textContent: `Entry ${w.entryCode} · score ${w.score}/${w.total}` }),
        el('p', { className: 'muted small', textContent: `Picked at random from ${r.poolSize} eligible entries at ${fmtTime(r.drawnAt)}. If the winner can't be reached, draw again.` }),
      );
      box.hidden = false;
      await load();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }

  async function onDelete(p) {
    if (!window.confirm(`Permanently delete ${p.fullName}'s registration? This can't be undone.`)) return;
    try {
      await api(`/api/admin/participants/${p.id}`, { method: 'DELETE' });
      toast('Participant deleted.');
      load();
    } catch (err) {
      toast(err.message);
    }
  }

  async function onLogin(e) {
    e.preventDefault();
    $('#loginError').textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      showDash();
    } catch (err) {
      $('#loginError').textContent = err.message;
    }
  }

  async function onLogout() {
    await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {});
    data = null;
    $('#rows').replaceChildren();
    showLogin();
  }

  async function boot() {
    $('#loginForm').addEventListener('submit', onLogin);
    $('#logoutBtn').addEventListener('click', onLogout);
    $('#drawBtn').addEventListener('click', onDraw);
    $('#search').addEventListener('input', () => data && renderRows(new Set(data.draws.map((d) => d.participantId))));
    $('#filter').addEventListener('change', () => data && renderRows(new Set(data.draws.map((d) => d.participantId))));
    try {
      const s = await api('/api/admin/session');
      if (s.authenticated) showDash();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  boot();
})();
