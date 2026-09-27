import { api } from './api.js';
import { City } from './city.js';
import { Inspector } from './inspector.js';
import {
  COLOR_METRICS, GROUPINGS, HEIGHT_METRICS, compileQuery,
} from './layout.js';
import {
  bytes, duration, esc, pct, rate, sparkline,
} from './format.js';

const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------ settings
const PREFS_KEY = 'process-city:prefs';
const defaults = {
  groupBy: 'app', height: 'memory', color: 'cpu', showKernel: false, links: false, labels: true, autoRotate: true, topBy: 'cpu',
};
function loadPrefs() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...defaults }; }
}
const prefs = loadPrefs();
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// --------------------------------------------------------------- state
let snapshot = null;
let byPid = new Map();
let paused = false;
let interval = 1.5;
let query = '';
let queryFn = null;

// ------------------------------------------------------------ the city
const city = new City($('#stage'));
city.setOptions({
  groupBy: prefs.groupBy, height: prefs.height, color: prefs.color, showKernel: prefs.showKernel, links: prefs.links, labels: prefs.labels,
});
city.controls.autoRotate = prefs.autoRotate;

const inspector = new Inspector($('#inspector'), {
  lookup: (pid) => byPid.get(pid),
  onNavigate: (pid, { focusOnly = false } = {}) => {
    if (focusOnly) { city.focus(pid); return; }
    if (!city.get(pid)) { toast(`pid ${pid} isn't in the city (hidden or exited)`, true); }
    city.select(pid, { fly: true });
  },
  onClose: () => city.select(null),
  toast,
});

city.onSelect = (proc) => {
  if (proc) inspector.open(proc.pid);
  else inspector.close();
  document.body.classList.toggle('inspecting', !!proc);
};
city.onAutoRotate = (on) => { prefs.autoRotate = on; $('#optRotate').checked = on; savePrefs(); };

// ------------------------------------------------------------- tooltip
const tip = $('#tooltip');
city.onHover = (p, at) => {
  if (!p || !at) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.innerHTML = `
    <div class="tt-name">${esc(p.name)} <span>${p.pid}</span></div>
    <div class="tt-grid">
      <span>CPU</span><b>${pct(p.cpu_percent)}</b>
      <span>Memory</span><b>${bytes(p.rss)}</b>
      <span>Threads</span><b>${p.num_threads ?? '—'}</b>
      <span>User</span><b>${esc(p.username ?? '—')}</b>
      <span>State</span><b>${esc(p.status)}</b>
    </div>
    ${p.cmd ? `<div class="tt-cmd">${esc(p.cmd.slice(0, 160))}</div>` : ''}
    <div class="tt-hint">click to inspect · double-click to zoom</div>`;
  const pad = 16;
  const r = tip.getBoundingClientRect();
  let x = at.x + pad;
  let y = at.y + pad;
  if (x + r.width > innerWidth - 8) x = at.x - r.width - pad;
  if (y + r.height > innerHeight - 8) y = at.y - r.height - pad;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
};

// ------------------------------------------------------------ controls
function fillSelect(el, entries, value) {
  el.innerHTML = Object.entries(entries).map(([k, v]) => `<option value="${k}">${typeof v === 'string' ? v : v.label}</option>`).join('');
  el.value = value;
}
fillSelect($('#groupBy'), GROUPINGS, prefs.groupBy);
fillSelect($('#height'), HEIGHT_METRICS, prefs.height);
fillSelect($('#color'), COLOR_METRICS, prefs.color);

for (const [id, key] of [['#groupBy', 'groupBy'], ['#height', 'height'], ['#color', 'color']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = e.target.value;
    savePrefs();
    city.setOptions({ [key]: e.target.value });
    renderLegend();
  });
}

const toggles = [
  ['#optKernel', 'showKernel', (v) => city.setOptions({ showKernel: v })],
  ['#optLinks', 'links', (v) => city.setOptions({ links: v })],
  ['#optLabels', 'labels', (v) => city.setOptions({ labels: v })],
  ['#optRotate', 'autoRotate', (v) => { city.controls.autoRotate = v; }],
];
for (const [id, key, apply] of toggles) {
  const el = $(id);
  el.checked = prefs[key];
  el.addEventListener('change', () => { prefs[key] = el.checked; savePrefs(); apply(el.checked); });
}

$('#viewBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#viewMenu').hidden = !$('#viewMenu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('#viewMenu')) $('#viewMenu').hidden = true; });
$('#pauseBtn').addEventListener('click', togglePause);
$('#resetBtn').addEventListener('click', () => city.resetView());
$('#helpBtn').addEventListener('click', () => { $('#help').hidden = !$('#help').hidden; });
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help' || e.target.closest('[data-close]')) $('#help').hidden = true; });

function togglePause() {
  paused = !paused;
  $('#pauseBtn').classList.toggle('on', paused);
  $('#pauseBtn').textContent = paused ? '▶' : '❚❚';
  $('#live').classList.toggle('paused', paused);
  $('#live').lastChild.textContent = paused ? ' PAUSED' : ' LIVE';
  if (!paused && snapshot) applySnapshot(snapshot);
}

for (const btn of document.querySelectorAll('#topTabs button')) {
  btn.classList.toggle('active', btn.dataset.top === prefs.topBy);
  btn.addEventListener('click', () => {
    prefs.topBy = btn.dataset.top;
    savePrefs();
    for (const b of document.querySelectorAll('#topTabs button')) b.classList.toggle('active', b === btn);
    renderTop();
  });
}
$('#topList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-pid]');
  if (li) city.select(Number(li.dataset.pid), { fly: true });
});

// -------------------------------------------------------------- search
const search = $('#search');
const results = $('#results');
let resultIndex = 0;

function runSearch() {
  query = search.value;
  try { queryFn = compileQuery(query); } catch { queryFn = null; }
  city.setFilter(queryFn);
  renderResults();
}

function renderResults() {
  if (!queryFn || document.activeElement !== search || !snapshot) { results.hidden = true; return; }
  const matches = snapshot.processes.filter(queryFn).sort((a, b) => b.cpu_percent - a.cpu_percent || (b.rss || 0) - (a.rss || 0));
  resultIndex = Math.min(resultIndex, Math.max(0, matches.length - 1));
  results.hidden = false;
  results.innerHTML = `<div class="res-count">${matches.length} match${matches.length === 1 ? '' : 'es'}</div>${
    matches.slice(0, 9).map((p, i) => `<div class="res ${i === resultIndex ? 'active' : ''}" data-pid="${p.pid}">
      <b>${esc(p.name)}</b><span>${p.pid}</span><em>${pct(p.cpu_percent)} · ${bytes(p.rss, 0)}</em><small>${esc((p.cmd || '').slice(0, 80))}</small></div>`).join('')}`;
}

search.addEventListener('input', () => { resultIndex = 0; runSearch(); });
search.addEventListener('focus', renderResults);
search.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
search.addEventListener('keydown', (e) => {
  const items = results.querySelectorAll('.res');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    resultIndex = (resultIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
    renderResults();
  } else if (e.key === 'Enter') {
    const pick = items[resultIndex];
    if (pick) { city.select(Number(pick.dataset.pid), { fly: true }); search.blur(); }
  } else if (e.key === 'Escape') {
    search.value = '';
    runSearch();
    search.blur();
  }
});
results.addEventListener('mousedown', (e) => {
  const r = e.target.closest('[data-pid]');
  if (r) { e.preventDefault(); city.select(Number(r.dataset.pid), { fly: true }); search.blur(); }
});

// ------------------------------------------------------------ keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
  else if (e.key === 'Escape') { if (!$('#help').hidden) $('#help').hidden = true; else city.select(null); }
  else if (e.key === 'f' || e.key === 'F') { if (city.selectedPid !== null) city.focus(city.selectedPid, true); }
  else if (e.key === 'r' || e.key === 'R') city.resetView();
  else if (e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === '?') $('#help').hidden = !$('#help').hidden;
  else if (e.key === 'p' || e.key === 'P') {
    const p = byPid.get(city.selectedPid);
    if (p?.ppid) city.select(p.ppid, { fly: true });
  }
});

// -------------------------------------------------------------- panels
function renderHud(sys) {
  $('#host').textContent = `${sys.hostname} · ${sys.os}`;
  $('#cpuTotal').textContent = pct(sys.cpu_percent);
  sparkline($('#cpuSpark'), sys.history.map((h) => h[1]), { color: '#ff9a3c', max: 100 });
  $('#cores').innerHTML = sys.per_cpu.map((v, i) => `<i title="CPU ${i}: ${v.toFixed(0)}%" style="--v:${Math.min(100, v)}%" class="${v > 70 ? 'hot' : ''}"></i>`).join('');
  $('#memBar').style.setProperty('--v', `${sys.mem_percent}%`);
  $('#memText').textContent = `${bytes(sys.mem_used)} / ${bytes(sys.mem_total)}`;
  const swp = sys.swap_total ? (sys.swap_used / sys.swap_total) * 100 : 0;
  $('#swapBar').style.setProperty('--v', `${swp}%`);
  $('#swapText').textContent = sys.swap_total ? `${bytes(sys.swap_used)} / ${bytes(sys.swap_total)}` : 'none';
  $('#stLoad').textContent = sys.load ? sys.load.map((l) => l.toFixed(2)).join('  ') : '—';
  $('#stProcs').textContent = `${sys.processes.toLocaleString()} · ${sys.threads.toLocaleString()} thr`;
  $('#stNet').textContent = sys.net ? `↓ ${rate(sys.net.recv)}  ↑ ${rate(sys.net.sent)}` : '—';
  $('#stDisk').textContent = sys.disk ? `R ${rate(sys.disk.read)}  W ${rate(sys.disk.write)}` : '—';
  $('#stUptime').textContent = duration(Date.now() / 1000 - sys.boot_time);
  $('#stCores').textContent = `${sys.cpu_count} cores`;
}

function renderTop() {
  if (!snapshot) return;
  const key = prefs.topBy === 'mem' ? (p) => p.rss || 0 : (p) => p.cpu_percent || 0;
  const list = snapshot.processes.filter((p) => !p.kernel).sort((a, b) => key(b) - key(a)).slice(0, 10);
  const max = Math.max(1e-9, ...list.map(key));
  $('#topList').innerHTML = list.map((p) => `
    <li data-pid="${p.pid}" class="${p.pid === city.selectedPid ? 'sel' : ''}">
      <span class="t-name">${esc(p.name)}</span>
      <span class="t-val">${prefs.topBy === 'mem' ? bytes(p.rss, 0) : pct(p.cpu_percent)}</span>
      <span class="t-bar"><span style="width:${((key(p) / max) * 100).toFixed(1)}%"></span></span>
    </li>`).join('');
}

function renderLegend() {
  const c = COLOR_METRICS[prefs.color];
  $('#legend').innerHTML = `
    <div class="lg-row"><span class="lg-k">Glow</span><span>${c.label}</span></div>
    <div class="lg-ramp"></div>
    <div class="lg-ends"><span>${c.legend[0]}</span><span>${c.legend[1]}</span></div>
    <div class="lg-row"><span class="lg-k">Height</span><span>${HEIGHT_METRICS[prefs.height].label}</span></div>
    <div class="lg-row"><span class="lg-k">Width</span><span>Threads</span></div>
    <div class="lg-row"><span class="lg-k">District</span><span>${GROUPINGS[prefs.groupBy]}</span></div>
    <div class="lg-sw"><i class="z"></i>zombie <i class="s"></i>stopped <i class="d"></i>restricted <i class="b"></i>roof = disk IO</div>`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isError ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

// ---------------------------------------------------------------- loop
function applySnapshot(snap) {
  byPid = new Map(snap.processes.map((p) => [p.pid, p]));
  city.setData(snap.processes, snap.time);
  renderTop();
  if (document.activeElement === search) renderResults();
  inspector.render();
}

let lastSeq = -1;
let failures = 0;
async function poll() {
  try {
    const snap = await api.snapshot();
    failures = 0;
    $('#live').classList.remove('lost');
    document.body.classList.add('ready');
    if (snap.seq !== lastSeq) {
      lastSeq = snap.seq;
      snapshot = snap;
      renderHud(snap.system);
      if (!paused) {
        applySnapshot(snap);
        inspector.refresh();
      }
    }
  } catch (err) {
    failures++;
    $('#live').classList.add('lost');
    if (!document.body.classList.contains('ready')) {
      window.__bootFail?.(`Could not load process data: ${err.message}\n${err.stack || ''}`);
    } else if (failures === 1) {
      toast(`Lost connection to the Process City server (${err.message}) — retrying…`, true);
    }
    if (err.status === 401) $('#bootMsg').textContent = 'Unauthorized: open the URL printed by the server (it includes a ?token=).';
  }
  setTimeout(poll, Math.max(400, interval * 1000));
}

async function boot() {
  renderLegend();
  try {
    const cfg = await api.config();
    interval = cfg.interval;
    inspector.setConfig(cfg);
    if (!cfg.is_root) $('#rootHint').hidden = false;
  } catch (err) {
    $('#bootMsg').textContent = `Can't reach the server: ${err.message}`;
  }
  poll();
}
boot();

// Handy for debugging from the console.
window.processCity = { city, get snapshot() { return snapshot; } };
