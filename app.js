'use strict';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const MASK = '********';
const fmtNum = (n) => Math.round(n || 0).toLocaleString();
const validDate = (d) => d && new Date(d).getFullYear() > 2000;

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtClock(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function relTime(d) {
  if (!validDate(d)) return 'never';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString();
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- theme ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}
applyTheme(store.get('irlhub.theme'));
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  store.set('irlhub.theme', next);
  if (S) renderChart(S);
});

// ---------- toasts & confirm ----------
function toast(msg, kind = '', list) {
  if (!msg) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (list && list.length) {
    const ul = document.createElement('ul');
    for (const item of list) { const li = document.createElement('li'); li.textContent = item; ul.append(li); }
    el.append(ul);
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : list ? 9000 : 4500);
}

function confirmAction(title, text, okLabel = 'Confirm') {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); cleanup(); resolve(v); };
    const ok = () => done(true);
    const cancel = () => done(false);
    const cleanup = () => {
      $('#confirmOk').removeEventListener('click', ok);
      $('[data-close]', d).removeEventListener('click', cancel);
      d.removeEventListener('cancel', cancel);
    };
    $('#confirmOk').addEventListener('click', ok);
    $('[data-close]', d).addEventListener('click', cancel);
    d.addEventListener('cancel', cancel);
    d.showModal();
  });
}
$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- website API ----------
// On the dashboard website, /irlhub.json says where the relay API lives
// ({ api, twitchClientId, download }). The local app has no such file and
// serves its API on the same origin.
let CFG = null;

// The session is a bearer token (the API is on another origin, so no
// cookies). Kept in memory too, for browsers that block storage.
const SESSION_KEY = 'irlhub.session';
let memSession = null;
const session = {
  get() { return store.get(SESSION_KEY) || memSession; },
  set(t) { memSession = t; store.set(SESSION_KEY, t); },
  clear() { memSession = null; try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } },
};

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) };
  const tok = CFG && session.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch((CFG ? CFG.api : '') + path, { ...opts, headers });
  if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}

function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Sign in with Twitch (implicit flow): Twitch sends the browser back with a
// token in the URL fragment, which the relay API checks with Twitch and
// swaps for an IRL Hub session. No client secret exists anywhere.
function twitchSignIn() {
  const state = randomHex(16);
  try { sessionStorage.setItem('irlhub.oauth', state); } catch {
    toast('Your browser is blocking storage, which sign-in needs. Allow it for this site and try again.', 'err');
    return;
  }
  const u = new URL('https://id.twitch.tv/oauth2/authorize');
  u.search = new URLSearchParams({
    client_id: CFG.twitchClientId, redirect_uri: location.origin + '/', response_type: 'token', scope: '', state,
  });
  location.assign(u.toString());
}

async function finishTwitchSignIn() {
  const h = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search);
  if (!h.has('access_token') && !q.has('error')) return;
  history.replaceState(null, '', location.pathname); // get the token out of the address bar now
  let expected = null;
  try { expected = sessionStorage.getItem('irlhub.oauth'); sessionStorage.removeItem('irlhub.oauth'); } catch { /* ignore */ }
  const state = h.get('state') || q.get('state');
  if (q.has('error')) return; // cancelled on Twitch's page
  if (!expected || state !== expected) { $('#signinErr').hidden = false; return; }
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ twitchToken: h.get('access_token') }) });
  session.set(r.token);
}

// ---------- socket link to the agent (direct or via the website) ----------
class Link {
  // url is a string, or an async function returning one (the website needs
  // a fresh one-time ticket for every connection attempt)
  constructor(url, handlers) {
    this.url = url; this.h = handlers; this.pending = new Map();
    this.seq = 0; this.retry = 500; this.closed = false; this.fails = 0;
    this.open();
  }
  retryLater() {
    if (this.closed) return;
    this.fails++;
    this.h.onRetry?.(this.fails);
    setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(this.retry * 2, 10000);
  }
  async open() {
    let url;
    try {
      url = typeof this.url === 'function' ? await this.url() : this.url;
    } catch {
      this.h.onConn?.(false);
      this.retryLater();
      return;
    }
    if (this.closed) return;
    const ws = this.ws = new WebSocket(url);
    ws.onopen = () => { this.retry = 500; this.fails = 0; this.h.onConn?.(true); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'state') this.h.onState?.(m.state);
      else if (m.type === 'agent') this.h.onAgent?.(!!m.online);
      else if (m.type === 'result') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.t);
        if (m.ok) p.res(m.result ?? null); else p.rej(new Error(m.error || 'Something went wrong'));
      }
    };
    ws.onclose = () => {
      this.h.onConn?.(false);
      for (const p of this.pending.values()) { clearTimeout(p.t); p.rej(new Error('Connection lost')); }
      this.pending.clear();
      this.retryLater();
    };
  }
  call(cmd, args, timeout = 20000) {
    return new Promise((res, rej) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('Not connected - reconnecting…'));
      const id = String(++this.seq);
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('No response - try again')); }, timeout);
      this.pending.set(id, { res, rej, t });
      this.ws.send(JSON.stringify({ type: 'cmd', id, cmd, args }));
    });
  }
  close() { this.closed = true; this.ws?.close(); }
}

let env = null;       // /api/env
let S = null;         // latest agent state
let link = null;
let agentOnline = true;
let agents = [];      // website: the user's PCs
let currentAgent = null;

async function run(btn, cmd, args, { ok, timeout } = {}) {
  btn?.classList.add('busy');
  try {
    const r = await link.call(cmd, args, timeout);
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'ok');
    if (r && r.note) toast(r.note);
    return r;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  } finally {
    btn?.classList.remove('busy');
  }
}
const quiet = (p) => p.catch(() => {});

// ---------- views ----------
function show(id) {
  for (const v of ['loading', 'landing', 'linkView', 'dash']) $('#' + v).hidden = v !== id;
}

function setConn(state, text) {
  const b = $('#connBadge');
  b.hidden = false;
  b.className = `conn ${state}`;
  b.textContent = text;
}

// ---------- form helper: live state never clobbers unsaved edits ----------
function managedForm(form, { fill, collect, submit }) {
  const actions = $('.form-actions', form);
  let dirty = false;
  const setDirty = (d) => { dirty = d; if (actions) actions.hidden = !d; };
  form.addEventListener('input', () => setDirty(true));
  form.addEventListener('change', () => setDirty(true));
  $('[data-cancel]', form)?.addEventListener('click', () => { setDirty(false); if (S) fill(S); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn?.classList.add('busy');
    try {
      await submit(collect());
      setDirty(false);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn?.classList.remove('busy');
    }
  });
  return { update(state) { if (!dirty) fill(state); }, reset() { setDirty(false); } };
}

// ---------- status pill ----------
const ICONS = {
  live: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.1 2.1 4.3-4.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  low: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1L8 1.5Z" fill="currentColor"/><path d="M8 6v3.6" stroke="#111" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="#111"/></svg>',
  offline: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5.5 5.5 5 5m0-5-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  stopped: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="currentColor"/></svg>',
};
const LABELS = { live: 'Live', low: 'Low bitrate', offline: 'Offline', stopped: 'Server stopped', connecting: 'Connecting' };

// ---------- render: feed + chart ----------
function renderFeed(s) {
  const cls = !s.server.running ? 'stopped' : s.feed.online && s.feed.measuring ? 'connecting' : s.feed.class;
  const pill = $('#feedPill');
  pill.className = `status-pill ${cls === 'connecting' ? 'stopped' : cls}`;
  pill.innerHTML = ICONS[cls === 'connecting' ? 'live' : cls] + `<span>${LABELS[cls]}</span>`;
  $('#feedKbps').textContent = s.feed.online ? fmtNum(s.feed.kbps) : '0';
  const f = s.feed;
  const meta = [];
  if (f.online && f.width) meta.push(`${f.width}×${f.height}`);
  if (f.online && f.fps) meta.push(`${Math.round(f.fps)} fps`);
  if (f.online && f.codec) meta.push(f.codec);
  if (!f.online) meta.push(s.server.running ? 'Waiting for your phone to connect' : 'Start the RTMP server to receive your phone');
  $('#feedMeta').textContent = meta.join(' · ');
  $('#feedUptime').textContent = f.online ? fmtDur(f.uptimeSec) : '–';
  $('#srvStatus').textContent = s.server.running ? 'Running' : 'Stopped';
  renderChart(s);
}

const chart = { hover: null, data: [], geom: null };

function niceMax(v) {
  // maxima whose halfway gridline is also a round number
  const steps = [500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 16000, 20000, 30000, 40000, 50000, 60000, 80000, 100000];
  return steps.find((x) => x >= v) || Math.ceil(v / 10000) * 10000;
}
function kbpsLabel(v) { return v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(v); }

function renderChart(s) {
  const svg = $('#chartSvg');
  const W = Math.max(280, svg.clientWidth || 600), H = 190;
  const padL = 40, padR = 10, padT = 12, padB = 22;
  const N = 120;
  const hist = s.feed.history || [];
  const data = Array(Math.max(0, N - hist.length)).fill(null).concat(hist.slice(-N));
  const low = s.switcher.lowKbps || 0;
  const vals = data.filter((v) => v != null);
  const max = niceMax(Math.max(500, low * 1.5, ...vals.map((v) => v * 1.1)));
  const x = (i) => padL + (i / (N - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  chart.data = data; chart.geom = { x, y, padL, padR, W, H, N };

  let out = '';
  for (const t of [0, max / 2, max]) {
    out += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
    out += `<text class="axis-label" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${kbpsLabel(t)}</text>`;
  }
  for (const [i, lbl, anchor] of [[0, '2 min ago', 'start'], [60, '1 min ago', 'middle'], [N - 1, 'now', 'end']]) {
    out += `<text class="axis-label" x="${x(i)}" y="${H - 5}" text-anchor="${anchor}">${lbl}</text>`;
  }
  // line + area over the defined samples
  let line = '', first = -1, last = -1;
  data.forEach((v, i) => {
    if (v == null) return;
    line += `${first < 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    if (first < 0) first = i;
    last = i;
  });
  if (first >= 0) {
    out += `<path class="area" d="${line}L${x(last).toFixed(1)},${y(0)}L${x(first).toFixed(1)},${y(0)}Z"/>`;
    out += `<path class="line" d="${line}"/>`;
  }
  if (low > 0 && low < max) {
    out += `<line class="threshold" x1="${padL}" x2="${W - padR}" y1="${y(low)}" y2="${y(low)}"/>`;
    // left side: the newest samples draw on the right
    out += `<text class="threshold-label" x="${padL + 6}" y="${y(low) - 5}">Low bitrate · ${fmtNum(low)} kbps</text>`;
  }
  if (chart.hover != null && data[chart.hover] != null) {
    const hx = x(chart.hover), hy = y(data[chart.hover]);
    out += `<line class="cross" x1="${hx}" x2="${hx}" y1="${padT}" y2="${H - padB}"/>`;
    out += `<circle class="dot" cx="${hx}" cy="${hy}" r="4.5"/>`;
  }
  // generous hit area for hover
  out += `<rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="chartHit"/>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  updateTip();

  if (vals.length) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    $('#chartSummary').textContent =
      `Average ${fmtNum(avg)} kbps · min ${fmtNum(Math.min(...vals))} · max ${fmtNum(Math.max(...vals))} over the last ${vals.length} s`;
  } else {
    $('#chartSummary').textContent = 'No samples yet.';
  }
}

function updateTip() {
  const tip = $('#chartTip');
  const i = chart.hover;
  if (i == null || chart.data[i] == null) { tip.hidden = true; return; }
  const ago = chart.geom.N - 1 - i;
  tip.innerHTML = `<b>${fmtNum(chart.data[i])} kbps</b><br><span class="muted">${ago === 0 ? 'now' : `${ago} s ago`}</span>`;
  const svg = $('#chartSvg');
  const scale = svg.clientWidth / chart.geom.W;
  const left = Math.min(Math.max(chart.geom.x(i) * scale, 60), svg.clientWidth - 60);
  tip.style.left = `${left}px`;
  tip.hidden = false;
}

$('#chartSvg').addEventListener('pointermove', (e) => {
  if (!chart.geom) return;
  const svg = $('#chartSvg');
  const r = svg.getBoundingClientRect();
  const px = (e.clientX - r.left) * (chart.geom.W / r.width);
  const { padL, padR, W, N } = chart.geom;
  const i = Math.round(((px - padL) / (W - padL - padR)) * (N - 1));
  const next = i >= 0 && i < N ? i : null;
  if (next !== chart.hover) { chart.hover = next; if (S) renderChart(S); }
});
$('#chartSvg').addEventListener('pointerleave', () => { chart.hover = null; if (S) renderChart(S); });
addEventListener('resize', () => { if (S) renderChart(S); });

// ---------- render: OBS & scenes ----------
function renderOBS(s) {
  const o = s.obs;
  $('#obsConn').textContent = o.connected ? `Connected${o.version ? ` (WebSocket ${o.version})` : ''}` : 'Not connected';
  $('#obsStream').textContent = !o.connected ? '–' : o.streaming ? `Live · ${fmtClock(o.durationMs)}` : 'Not streaming';
  $('#obsScene').textContent = o.connected ? (o.scene || '–') : '–';
  $('#obsCongRow').hidden = !(o.connected && o.streaming);
  $('#obsCong').textContent = `${Math.round((o.congestion || 0) * 100)}%`;
  const err = $('#obsErr');
  err.hidden = o.connected || !o.error;
  err.textContent = o.error || '';
  const sb = $('#streamBtn');
  sb.disabled = !o.connected;
  sb.textContent = o.streaming ? 'Stop stream' : 'Start stream';
  sb.className = o.streaming ? 'btn danger' : 'btn primary';
  $('#refreshFeedBtn').disabled = !o.connected;
  $('#setupScenesBtn').disabled = !o.connected;
}

let sceneSig = '';
function renderScenes(s) {
  const o = s.obs, sw = s.switcher;
  const roles = {};
  if (sw.liveScene) roles[sw.liveScene] = 'Live';
  if (sw.lowScene) roles[sw.lowScene] = (roles[sw.lowScene] ? roles[sw.lowScene] + ' · ' : '') + 'Low';
  if (sw.offlineScene) roles[sw.offlineScene] = (roles[sw.offlineScene] ? roles[sw.offlineScene] + ' · ' : '') + 'Offline';
  const sig = JSON.stringify([o.connected, o.scenes, o.scene, o.streaming, roles]);
  if (sig === sceneSig) return;
  sceneSig = sig;
  const g = $('#sceneGrid');
  if (!o.connected) { g.innerHTML = '<p class="muted">Connect OBS to see your scenes.</p>'; return; }
  if (!o.scenes || !o.scenes.length) { g.innerHTML = '<p class="muted">No scenes yet. Use “Set up OBS scenes”.</p>'; return; }
  g.innerHTML = o.scenes.map((n) => {
    const active = n === o.scene;
    return `<button type="button" class="scene-btn${active ? ' active' : ''}" data-scene="${esc(n)}" aria-pressed="${active}">` +
      `${esc(n)}${roles[n] ? `<span class="role">${esc(roles[n])}</span>` : ''}` +
      `${active && o.streaming ? '<span class="onair">ON AIR</span>' : ''}</button>`;
  }).join('');
}
$('#sceneGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scene]');
  if (b && !b.classList.contains('active')) quiet(run(b, 'obs.scene', { scene: b.dataset.scene }));
});

$('#streamBtn').addEventListener('click', async (e) => {
  const live = S?.obs.streaming;
  if (live && !(await confirmAction('Stop the stream?', 'Your stream ends for viewers on every platform.', 'Stop stream'))) return;
  quiet(run(e.currentTarget, 'obs.stream', { action: live ? 'stop' : 'start' }, { ok: live ? 'Stream stopped' : 'Stream starting…' }));
});
$('#refreshFeedBtn').addEventListener('click', (e) => quiet(run(e.currentTarget, 'obs.refreshFeed', null, { ok: 'Feed refreshed' })));
$('#setupScenesBtn').addEventListener('click', async (e) => {
  try {
    const r = await run(e.currentTarget, 'obs.setupScenes', null, { timeout: 60000 });
    toast('OBS scenes are ready', 'ok', r?.log);
  } catch { /* toasted */ }
});

// ---------- render: switcher ----------
function sceneOptions(sel, scenes, value, allowNone) {
  const names = [...(scenes || [])];
  if (value && !names.includes(value)) names.push(value);
  sel.innerHTML = (allowNone ? '<option value="">None (use Live scene)</option>' : '') +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}${scenes && !scenes.includes(n) ? ' (not in OBS)' : ''}</option>`).join('');
  sel.value = value || '';
}

const swForm = managedForm($('#swForm'), {
  fill(s) {
    const f = $('#swForm'), sw = s.switcher;
    sceneOptions(f.liveScene, s.obs.scenes, sw.liveScene, false);
    sceneOptions(f.lowScene, s.obs.scenes, sw.lowScene, true);
    sceneOptions(f.offlineScene, s.obs.scenes, sw.offlineScene, false);
    f.lowKbps.value = sw.lowKbps;
    f.onlyWhenStreaming.checked = sw.onlyWhenStreaming;
  },
  collect() {
    const f = $('#swForm');
    return {
      enabled: $('#swEnabled').checked,
      liveScene: f.liveScene.value, lowScene: f.lowScene.value, offlineScene: f.offlineScene.value,
      lowKbps: parseInt(f.lowKbps.value, 10) || 0, onlyWhenStreaming: f.onlyWhenStreaming.checked,
    };
  },
  submit: (v) => run(null, 'switcher.set', v, { ok: 'Auto-switcher saved' }),
});
$('#swEnabled').addEventListener('change', (e) => {
  const sw = S.switcher;
  quiet(run(null, 'switcher.set', {
    enabled: e.target.checked, liveScene: sw.liveScene, lowScene: sw.lowScene, offlineScene: sw.offlineScene,
    lowKbps: sw.lowKbps, onlyWhenStreaming: sw.onlyWhenStreaming,
  }, { ok: e.target.checked ? 'Auto-switcher on' : 'Auto-switcher off' }));
});

let logSig = '';
function renderSwitcher(s) {
  const sw = s.switcher;
  $('#swEnabled').checked = sw.enabled;
  $('#swStatus').textContent = sw.status || '–';
  swForm.update(s);
  const sig = JSON.stringify(sw.log);
  if (sig !== logSig) {
    logSig = sig;
    $('#swLog').innerHTML = (sw.log || []).length
      ? sw.log.map((e) => `<li><time>${esc(new Date(e.at).toLocaleTimeString())}</time>${esc(e.msg)}</li>`).join('')
      : '<li class="muted">Nothing yet.</li>';
  }
}

// ---------- render: phone QR ----------
let net = store.get('irlhub.net') || 'anywhere';
let qrKey = '', qrData = null, qrLoading = false;
$$('.seg [data-net]').forEach((b) => b.addEventListener('click', () => {
  net = b.dataset.net;
  store.set('irlhub.net', net);
  paintQR();
}));

async function loadQR(s) {
  const key = `${s.ingest.anywhere}|${s.ingest.lan}`;
  if (key === qrKey || qrLoading) return;
  qrLoading = true;
  try {
    qrData = await link.call('qr.get');
    qrKey = key;
    paintQR();
  } catch { /* retried on next state */ } finally { qrLoading = false; }
}

function paintQR() {
  $$('.seg [data-net]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.net === net)));
  const set = qrData && qrData[net];
  const rtmpPort = S?.settings.rtmpPort ?? 1935;
  $('#qrRow').hidden = !set;
  if (set) {
    $('#qrIrlpro').src = set.irlpro;
    $('#qrMoblin').src = set.moblin;
    $('#qrUrl').textContent = set.url;
  } else {
    $('#qrUrl').textContent = '–';
  }
  $('#qrNote').textContent = net === 'anywhere'
    ? (set ? `Works over mobile data. Your router must forward TCP port ${rtmpPort} to this PC.`
           : 'Set up Dynamic DNS (or a public host in Settings) to stream over mobile data.')
    : 'Works when your phone is on the same network as this PC.';
}

function renderPhone(s) {
  loadQR(s);
  if (!qrData) paintQR();
}

// ---------- render: server ----------
let keyShown = false;
function renderServer(s) {
  const sv = s.server;
  $('#srvStatus2').textContent = sv.running ? `Running since ${new Date(sv.since).toLocaleTimeString()}` : 'Stopped';
  $('#srvPort').textContent = sv.rtmpPort;
  $('#srvErr').hidden = !sv.error;
  $('#srvErr').textContent = sv.error || '';
  $('#srvToggle').textContent = sv.running ? 'Stop' : 'Start';
  $('#srvToggle').className = sv.running ? 'btn' : 'btn primary';
  $('#srvRestart').disabled = !sv.running;
  $('#streamKey').textContent = keyShown ? s.settings.streamKey : '••••••••';
  $('#revealKey').textContent = keyShown ? 'Hide' : 'Show';
  $('#obsIngest').textContent = s.ingest.obs;
}
$('#revealKey').addEventListener('click', () => { keyShown = !keyShown; if (S) renderServer(S); });
async function confirmDropFeed(verb) {
  if (!S.feed.online && !S.obs.streaming) return true;
  return confirmAction(`${verb} the RTMP server?`, 'Your phone feed drops until the server is back. Viewers will see your Offline scene.', verb);
}
$('#srvToggle').addEventListener('click', async (e) => {
  const running = S.server.running;
  if (running && !(await confirmDropFeed('Stop'))) return;
  quiet(run(e.currentTarget, running ? 'server.stop' : 'server.start', null, { ok: running ? 'RTMP server stopped' : 'RTMP server started' }));
});
$('#srvRestart').addEventListener('click', async (e) => {
  if (!(await confirmDropFeed('Restart'))) return;
  quiet(run(e.currentTarget, 'server.restart', null, { ok: 'RTMP server restarted' }));
});
$('#regenKey').addEventListener('click', async (e) => {
  if (!(await confirmAction('Make a new stream key?', 'Your phone stops connecting until you scan the new QR code, and OBS needs “Set up OBS scenes” to pull the new key.', 'New key'))) return;
  quiet(run(e.currentTarget, 'streamKey.regenerate'));
});

// ---------- render: DDNS ----------
const SECRET_LABEL = { namecheap: 'Dynamic DNS password', cloudflare: 'API token', duckdns: 'Token' };
function ddnsFields() {
  const p = $('#ddnsForm').provider.value;
  $$('#ddnsForm [data-ddns]').forEach((el) => { el.hidden = !p; });
  $('#ddnsForm [data-ddns-cf]').hidden = p !== 'cloudflare';
  $('#ddnsSecretLabel').textContent = SECRET_LABEL[p] || 'Password';
  $('#ddnsForm').hostname.placeholder = p === 'duckdns' ? 'yourname.duckdns.org' : 'irl.example.com';
}
$('#ddnsForm').provider.addEventListener('change', ddnsFields);

const ddnsForm = managedForm($('#ddnsForm'), {
  fill(s) {
    const f = $('#ddnsForm'), d = s.ddns;
    f.provider.value = d.provider || '';
    f.hostname.value = d.hostname || '';
    f.secret.value = d.hasSecret ? MASK : '';
    f.zoneId.value = '';
    ddnsFields();
  },
  collect() {
    const f = $('#ddnsForm');
    return { provider: f.provider.value, hostname: f.hostname.value.trim(), secret: f.secret.value, zoneId: f.zoneId.value.trim() };
  },
  submit: (v) => run(null, 'ddns.set', v, { ok: 'Dynamic DNS saved - updating…' }),
});

function renderDDNS(s) {
  const d = s.ddns;
  ddnsForm.update(s);
  $('#ddnsIp').textContent = d.publicIp || '–';
  $('#ddnsLast').textContent = d.provider ? (validDate(d.lastUpdate) ? `${relTime(d.lastUpdate)} → ${d.pushedIp}` : 'not yet') : 'off';
  $('#ddnsErr').hidden = !d.error;
  $('#ddnsErr').textContent = d.error || '';
  $('#ddnsNow').disabled = !d.provider;
}
$('#ddnsNow').addEventListener('click', (e) => quiet(run(e.currentTarget, 'ddns.updateNow', null, { ok: 'Checking your IP…' })));

// ---------- render: multistream ----------
const PRESETS = {
  twitch: { name: 'Twitch', server: 'rtmp://live.twitch.tv/app' },
  youtube: { name: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2' },
  custom: { name: 'Custom', server: 'rtmp://' },
};
function msRow(t) {
  const li = document.createElement('li');
  li.dataset.id = t.id || '';
  li.innerHTML =
    `<div class="ms-top"><input type="checkbox" name="enabled" aria-label="Enabled"${t.enabled ? ' checked' : ''}>` +
    `<input name="name" value="${esc(t.name)}" aria-label="Name" maxlength="40">` +
    `<button type="button" class="btn ghost sm ms-rm" aria-label="Remove">Remove</button></div>` +
    `<input name="server" value="${esc(t.server)}" aria-label="Server" spellcheck="false" placeholder="rtmp://host/app">` +
    `<input name="key" type="password" value="${t.hasKey ? MASK : ''}" aria-label="Stream key" placeholder="Stream key" autocomplete="new-password">`;
  return li;
}
function msEmpty(list) {
  if (!list.children.length) list.innerHTML = '<li class="ms-empty">No platforms yet.</li>';
}
const msForm = managedForm($('#msForm'), {
  fill(s) {
    const list = $('#msList');
    list.innerHTML = '';
    for (const t of s.multistream || []) list.append(msRow(t));
    msEmpty(list);
  },
  collect() {
    return {
      targets: $$('#msList li[data-id]').map((li) => ({
        id: li.dataset.id, name: $('[name=name]', li).value, server: $('[name=server]', li).value,
        key: $('[name=key]', li).value, enabled: $('[name=enabled]', li).checked,
      })),
    };
  },
  submit: (v) => run(null, 'multistream.set', v, { ok: 'Multistream saved' }),
});
$('#msForm').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  const rm = e.target.closest('.ms-rm');
  const list = $('#msList');
  if (add) {
    $('.ms-empty', list)?.remove();
    const row = msRow({ ...PRESETS[add.dataset.add], enabled: false });
    list.append(row);
    $('[name=key]', row).focus();
    $('#msForm').dispatchEvent(new Event('input'));
  } else if (rm) {
    rm.closest('li').remove();
    msEmpty(list);
    $('#msForm').dispatchEvent(new Event('input'));
  }
});
function renderMultistream(s) {
  msForm.update(s);
  $('#msLive').hidden = !s.feed.restreamLive;
  $('#msTarget').textContent = `rtmp://127.0.0.1:${s.settings.rtmpPort}/restream`;
}
$('#routeMs').addEventListener('click', async (e) => {
  if (!(await confirmAction('Point OBS at multistream?', 'OBS’s stream server changes to this PC’s multistream relay. Your old stream key in OBS is replaced, so add that platform here first.', 'Change OBS'))) return;
  quiet(run(e.currentTarget, 'obs.routeMultistream', null, { ok: 'OBS now streams through multistream' }));
});

// ---------- render: settings ----------
const setForm = managedForm($('#setForm'), {
  fill(s) {
    const f = $('#setForm'), st = s.settings;
    f.obsHost.value = st.obsHost; f.obsPort.value = st.obsPort;
    f.obsPassword.value = st.hasObsPassword ? MASK : '';
    f.streamKey.value = st.streamKey; f.rtmpPort.value = st.rtmpPort;
    f.publicHost.value = st.publicHost; f.autoServer.checked = st.autoServer;
    f.brbChannel.value = st.brbChannel; f.statPort.value = st.statPort; f.uiPort.value = st.uiPort;
  },
  collect() {
    const f = $('#setForm');
    return {
      obsHost: f.obsHost.value.trim(), obsPort: +f.obsPort.value, obsPassword: f.obsPassword.value,
      streamKey: f.streamKey.value.trim(), rtmpPort: +f.rtmpPort.value, publicHost: f.publicHost.value.trim(),
      autoServer: f.autoServer.checked, brbChannel: f.brbChannel.value.trim(),
      statPort: +f.statPort.value, uiPort: +f.uiPort.value,
    };
  },
  submit: (v) => run(null, 'settings.set', v, { ok: 'Settings saved' }),
});
function renderSettings(s) {
  setForm.update(s);
  $('#obsDetectedNote').textContent = s.settings.obsDetected
    ? 'Using the password from OBS on this PC automatically. Enter one here only to override it.'
    : 'In OBS: Tools → WebSocket Server Settings → Show Connect Info.';
  $('#autoStart').checked = s.settings.autoStart;
}
$('#autoStart').addEventListener('change', (e) => quiet(run(null, 'autostart.set', { enabled: e.target.checked },
  { ok: e.target.checked ? 'IRL Hub will start with Windows' : 'IRL Hub won’t start with Windows' })));

// ---------- render: website link (local dashboard only) ----------
function renderCloud(s) {
  const c = s.cloud;
  const site = (c.server || '').replace(/\/$/, '');
  $('#cloudStatus').textContent = !c.linked ? 'Not linked'
    : c.connected ? `Linked · online${c.watchers ? ` · ${c.watchers} watching` : ''}` : 'Linked · connecting…';
  $('#cloudErr').hidden = !c.error;
  $('#cloudErr').textContent = c.error || '';
  $('#cloudCodeBox').hidden = !c.code;
  $('#cloudCode').textContent = c.code || '';
  const a = $('#cloudSite');
  a.textContent = site.replace(/^https?:\/\//, '');
  a.href = site;
  $('#cloudLink').hidden = c.linked || !!c.code;
  $('#cloudUnlink').hidden = !c.linked;
  $('#cloudOpen').hidden = !c.linked;
  $('#cloudOpen').href = site;
}
$('#cloudLink').addEventListener('click', (e) => quiet(run(e.currentTarget, 'cloud.link', {}, { timeout: 30000 })));
$('#cloudUnlink').addEventListener('click', async (e) => {
  if (!(await confirmAction('Unlink from the website?', 'You won’t be able to control this PC from the website until you link it again.', 'Unlink'))) return;
  quiet(run(e.currentTarget, 'cloud.unlink', null, { ok: 'Unlinked' }));
});

// copy buttons
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try {
    await navigator.clipboard.writeText($('#' + b.dataset.copy).textContent);
    toast('Copied', 'ok');
  } catch { toast('Copy failed - select the text and copy it', 'err'); }
});

// ---------- state ----------
function renderBanner() {
  const b = $('#banner');
  if (env.mode === 'cloud' && !agentOnline) {
    const name = currentAgent?.name || 'Your PC';
    b.textContent = `${name} is offline. Open IRL Hub on that PC and it reconnects automatically. What you see below is its last known state.`;
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

function render(s) {
  S = s;
  renderFeed(s);
  renderOBS(s);
  renderScenes(s);
  renderSwitcher(s);
  renderPhone(s);
  renderServer(s);
  renderDDNS(s);
  renderMultistream(s);
  renderSettings(s);
  if (env.mode === 'local') renderCloud(s);
  $('#foot').textContent = `${s.app} ${s.version} · ${s.pc}`;
}

function connect(url) {
  link?.close();
  S = null; qrKey = ''; qrData = null; sceneSig = ''; logSig = '';
  for (const f of [swForm, ddnsForm, msForm, setForm]) f.reset();
  link = new Link(url, {
    onState: (st) => { if (!$('#dash').hidden || S === null) { show('dash'); } render(st); },
    onAgent: (on) => {
      agentOnline = on;
      renderBanner();
      if (env.mode === 'cloud') {
        setConn(on ? 'on' : 'off', on ? 'PC online' : 'PC offline');
        if (!S) show('dash');
      }
    },
    onConn: (on) => {
      if (env.mode === 'local') setConn(on ? 'on' : 'off', on ? 'Connected' : 'Reconnecting…');
      else if (!on) setConn('off', 'Reconnecting…');
    },
    onRetry: async (n) => {
      // on the website, a dead socket may mean the session expired
      if (env.mode === 'cloud' && n === 3) {
        try {
          const e = await api('/api/env');
          if (!e.user) { session.clear(); location.href = location.pathname; }
        } catch { /* offline */ }
      }
    },
  });
}

// ---------- website: PCs ----------
async function loadAgents() {
  agents = await api('/api/agents');
  const sel = $('#pcSelect');
  sel.innerHTML = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || 'Unnamed PC')}${a.online ? '' : ' (offline)'}</option>`).join('');
  $('#pcPicker').hidden = !agents.length;
}

// ?pc=<id> rather than a path: GitHub Pages can't route /pc/<id> to the app
const pcParam = () => new URLSearchParams(location.search).get('pc');

function openAgent(id, push = true) {
  currentAgent = agents.find((a) => a.id === id);
  if (!currentAgent) return;
  store.set('irlhub.agent', id);
  $('#pcSelect').value = id;
  if (push && pcParam() !== id) history.pushState(null, '', `${location.pathname}?pc=${encodeURIComponent(id)}`);
  const wsBase = CFG.api.replace(/^http/, 'ws');
  connect(async () => {
    const { ticket } = await api('/api/ws-ticket', { method: 'POST', body: JSON.stringify({ agent: id }) });
    return `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`;
  });
}

function route() {
  const want = pcParam() || store.get('irlhub.agent');
  if (!agents.length) { showLink(false); return; }
  openAgent(agents.some((a) => a.id === want) ? want : agents[0].id, !pcParam());
}

function showLink(canGoBack) {
  link?.close();
  link = null;
  $('#linkBack').hidden = !canGoBack;
  $('#downloadBtn').hidden = !CFG?.download;
  show('linkView');
  $('#linkCode').focus();
}

$('#pcSelect').addEventListener('change', (e) => openAgent(e.target.value));
addEventListener('popstate', () => { if (env?.mode === 'cloud' && env.user) route(); });

$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.classList.add('busy');
  try {
    const a = await api('/api/agents/link', { method: 'POST', body: JSON.stringify({ code: $('#linkCode').value }) });
    toast(`Linked ${a.name || 'your PC'}`, 'ok');
    $('#linkCode').value = '';
    await loadAgents();
    openAgent(a.id);
  } catch (err) { toast(err.message, 'err'); } finally { btn.classList.remove('busy'); }
});
$('#linkCode').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  e.target.value = v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
});
$('#linkBack').addEventListener('click', () => route());

$('#managePcs').addEventListener('click', async () => {
  await loadAgents();
  const ul = $('#pcList');
  ul.innerHTML = agents.map((a) =>
    `<li data-id="${esc(a.id)}"><span class="dot${a.online ? ' on' : ''}" title="${a.online ? 'Online' : 'Offline'}"></span>` +
    `<input value="${esc(a.name)}" maxlength="60" aria-label="PC name">` +
    `<button type="button" class="btn ghost sm" data-remove>Remove</button></li>`).join('');
  $('#pcDialog').showModal();
});
$('#pcList').addEventListener('change', async (e) => {
  const li = e.target.closest('li');
  if (!li || e.target.tagName !== 'INPUT') return;
  try {
    await api(`/api/agents/${encodeURIComponent(li.dataset.id)}/rename`, { method: 'POST', body: JSON.stringify({ name: e.target.value }) });
    await loadAgents();
    $('#pcSelect').value = currentAgent?.id || '';
    toast('Renamed', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});
$('#pcList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const li = b.closest('li');
  $('#pcDialog').close();
  if (!(await confirmAction('Remove this PC?', 'It stops showing up here, and IRL Hub on that PC gets unlinked. You can link it again anytime.', 'Remove'))) return;
  try {
    await api(`/api/agents/${encodeURIComponent(li.dataset.id)}`, { method: 'DELETE' });
    await loadAgents();
    if (currentAgent?.id === li.dataset.id) { history.replaceState(null, '', location.pathname); route(); }
    toast('PC removed', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});
$('#addPc').addEventListener('click', () => { $('#pcDialog').close(); showLink(true); });

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* signing out locally anyway */ }
  session.clear();
  location.href = location.pathname;
});
$('#twitchBtn').addEventListener('click', twitchSignIn);
$('#devLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/login/dev', { method: 'POST', body: JSON.stringify({ password: $('#devPw').value }) });
    session.set(r.token);
    location.href = location.pathname;
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- boot ----------
async function boot() {
  if (location.pathname === '/qr') document.body.classList.add('dock');
  try {
    const r = await fetch('/irlhub.json', { cache: 'no-store' });
    if (r.ok) {
      CFG = await r.json();
      CFG.api = String(CFG.api || '').replace(/\/$/, '');
    }
  } catch { /* not the website */ }
  if (CFG) {
    try { await finishTwitchSignIn(); } catch (err) { $('#signinErr').hidden = false; toast(err.message, 'err'); }
  }
  try {
    env = await api('/api/env');
  } catch {
    $('#loading').textContent = CFG ? 'Can’t reach the IRL Hub service right now. Try again in a minute.' : 'Can’t reach IRL Hub. Is it running?';
    return;
  }
  if (env.mode === 'local') {
    $('#cloudCard').hidden = false;
    $('#autoStartRow').hidden = false;
    connect(`ws://${location.host}/ws`);
    return;
  }
  // website: things that only make sense on the PC itself
  $('#autoStartRow').hidden = true;
  for (const a of [$('#downloadBtn'), $('#downloadBtnLanding')]) if (CFG?.download) a.href = CFG.download;
  if (!env.user) {
    session.clear(); // expired or revoked
    const twitch = !!(env.twitch && CFG?.twitchClientId);
    $('#twitchBtn').hidden = !twitch;
    $('#twitchOff').hidden = twitch || env.devLogin;
    $('#devLogin').hidden = !env.devLogin;
    $('#downloadBtnLanding').hidden = !CFG?.download;
    show('landing');
    return;
  }
  $('#userBox').hidden = false;
  $('#userName').textContent = env.user.displayName || env.user.login;
  if (env.user.avatar) $('#userAvatar').src = env.user.avatar; else $('#userAvatar').hidden = true;
  await loadAgents();
  route();
}
boot();
