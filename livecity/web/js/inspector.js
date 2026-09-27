// The right-hand drawer that shows everything about one process.

import { api } from './api.js';
import {
  bytes, datetime, duration, esc, num, pct, secs, sparkline,
} from './format.js';

const TABS = [
  ['overview', 'Overview'],
  ['memory', 'Memory'],
  ['files', 'Files'],
  ['net', 'Network'],
  ['threads', 'Threads'],
  ['env', 'Env'],
  ['tree', 'Tree'],
  ['limits', 'Limits'],
  ['kernel', 'Kernel'],
];

const SECRET_KEY = /(token|secret|passw|pwd|api_?key|auth|cred|cookie|session|private)/i;
const INF = 2 ** 62;

export class Inspector {
  constructor(root, { lookup, onNavigate, onClose, toast }) {
    this.root = root;
    this.lookup = lookup;       // pid -> snapshot row (or undefined)
    this.onNavigate = onNavigate;
    this.onClose = onClose;
    this.toast = toast;
    this.pid = null;
    this.data = null;
    this.tab = 'overview';
    this.config = { allow_signals: false, signals: [] };
    this.revealed = new Set();
    this.loading = false;

    root.innerHTML = `
      <div class="insp-head"></div>
      <div class="insp-actions"></div>
      <nav class="insp-tabs">${TABS.map(([id, label]) => `<button data-tab="${id}">${label}<i></i></button>`).join('')}</nav>
      <div class="insp-filter"><input type="search" placeholder="Filter rows…" spellcheck="false"></div>
      <div class="insp-body"></div>`;
    this.head = root.querySelector('.insp-head');
    this.actions = root.querySelector('.insp-actions');
    this.tabsEl = root.querySelector('.insp-tabs');
    this.filterEl = root.querySelector('.insp-filter input');
    this.body = root.querySelector('.insp-body');

    this.tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      this.tab = btn.dataset.tab;
      this.body.scrollTop = 0;
      this.render();
    });
    this.filterEl.addEventListener('input', () => this._applyFilter());
    root.addEventListener('click', (e) => this._onClick(e));
  }

  setConfig(cfg) { this.config = cfg; }

  open(pid) {
    if (pid !== this.pid) {
      this.pid = pid;
      this.data = null;
      this.gone = false;
      this.revealed.clear();
      this.filterEl.value = '';
    }
    this.root.hidden = false;
    this.render();
    this.refresh();
  }

  close() {
    this.pid = null;
    this.data = null;
    this.root.hidden = true;
  }

  async refresh() {
    if (this.pid === null || this.loading || this.gone) return;
    const pid = this.pid;
    this.loading = true;
    try {
      const data = await api.process(pid);
      if (pid === this.pid) { this.data = data; this.render(); }
    } catch (err) {
      if (pid === this.pid) {
        if (err.status === 404) this.gone = true;
        this.error = err.message;
        this.render();
      }
    } finally {
      this.loading = false;
    }
  }

  // ------------------------------------------------------------- render
  render() {
    if (this.pid === null) return;
    const d = this.data;
    const row = this.lookup(this.pid) || {};
    const name = d?.name ?? row.name ?? '…';
    const status = d?.status ?? row.status ?? '';
    const user = d?.username ?? row.username ?? '';

    this.head.innerHTML = `
      <div class="insp-title">
        <div class="insp-name" title="${esc(name)}">${esc(name)}</div>
        <button class="icon" data-act="close" title="Close (Esc)">✕</button>
      </div>
      <div class="insp-sub">
        <span class="pill">PID ${this.pid}</span>
        <span class="pill status-${esc(status)}">${esc(status || '?')}</span>
        ${user ? `<span class="pill">${esc(user)}</span>` : ''}
        ${row.kernel ? '<span class="pill">kernel thread</span>' : ''}
        ${d?.is_self ? '<span class="pill hot">this server</span>' : ''}
        ${this.gone ? '<span class="pill dead">exited</span>' : ''}
      </div>`;

    const sigs = this.config.allow_signals && !d?.is_self && !this.gone
      ? this.config.signals.map((s) => `<button class="sig ${s === 'KILL' ? 'danger' : ''}" data-sig="${s}">${s}</button>`).join('')
      : '';
    this.actions.innerHTML = `
      <button data-act="focus" title="Fly to building (F)">◎ Focus</button>
      ${row.ppid ? `<button data-act="parent" title="Go to parent">↑ Parent</button>` : ''}
      <button data-act="refresh" title="Refresh now">⟳</button>
      ${sigs ? `<span class="sig-group" title="Send signal">${sigs}</span>` : ''}`;

    const counts = {
      files: d?.open_files?.length,
      net: d?.connections?.length,
      threads: d?.threads?.length,
      env: d?.environ ? Object.keys(d.environ).length : undefined,
      memory: d?.memory_maps?.length,
    };
    for (const btn of this.tabsEl.querySelectorAll('button')) {
      const id = btn.dataset.tab;
      btn.classList.toggle('active', id === this.tab);
      btn.hidden = !!d && ((id === 'kernel' && !d.linux) || (id === 'limits' && !d.rlimits && !d.errors?.rlimits));
      btn.querySelector('i').textContent = counts[id] !== undefined ? counts[id] : '';
    }
    this.filterEl.parentElement.hidden = !['files', 'net', 'threads', 'env', 'memory', 'kernel', 'limits'].includes(this.tab);

    const scroll = this.body.scrollTop;
    if (!d) {
      this.body.innerHTML = this.gone
        ? '<div class="empty">This process has exited.</div>'
        : `<div class="empty">${this.error ? esc(this.error) : 'Loading…'}</div>`;
      return;
    }
    this.body.innerHTML = this[`_${this.tab}`](d, row);
    this.body.scrollTop = scroll;
    this._applyFilter();
    if (this.tab === 'overview') this._drawCharts(d);
  }

  _applyFilter() {
    const q = this.filterEl.value.trim().toLowerCase();
    for (const tr of this.body.querySelectorAll('tbody tr')) {
      tr.hidden = q && !tr.textContent.toLowerCase().includes(q);
    }
  }

  _denied(d, key, what) {
    const err = d.errors?.[key];
    if (!err) return '';
    const hint = err === 'access denied'
      ? 'This process belongs to another user. Restart Process City with <code>sudo</code> to see it.'
      : '';
    return `<div class="locked">🔒 ${esc(what)}: ${esc(err)}. ${hint}</div>`;
  }

  // ------------------------------------------------------------- tabs
  _overview(d, row) {
    const mem = d.memory_full_info || d.memory_info || {};
    const cpu = d.cpu_percent ?? row.cpu_percent;
    const age = d.create_time ? Date.now() / 1000 - d.create_time : null;
    const ct = d.cpu_times || {};
    const io = d.io_counters;
    const ctx = d.num_ctx_switches;
    const stat = (label, value, sub = '') => `<div class="stat"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;

    return `
      <div class="stats">
        ${stat('CPU', pct(cpu), row.cpu_percent !== undefined ? 'of one core' : '')}
        ${stat('Memory', bytes(mem.rss), d.memory_percent !== undefined ? pct(d.memory_percent, 2) + ' of RAM' : '')}
        ${stat('Threads', num(d.num_threads), '')}
        ${stat('Open FDs', num(d.num_fds ?? row.num_fds), '')}
      </div>
      <div class="charts">
        <div><label>CPU % <em id="cpuNow">${pct(cpu)}</em></label><canvas id="chartCpu"></canvas></div>
        <div><label>Resident memory <em>${bytes(mem.rss)}</em></label><canvas id="chartMem"></canvas></div>
      </div>
      <h4>Command</h4>
      ${kv([
        ['Executable', mono(d.exe) || this._err(d, 'exe')],
        ['Working dir', mono(d.cwd) || this._err(d, 'cwd')],
      ])}
      <div class="argv">${(d.cmdline || []).map((a, i) => `<code class="${i ? '' : 'arg0'}">${esc(a)}</code>`).join('') || this._err(d, 'cmdline') || '<span class="muted">(no command line — kernel thread or restricted)</span>'}</div>
      <h4>Identity</h4>
      ${kv([
        ['Parent', d.ppid ? `<a data-pid="${d.ppid}">${esc(this.lookup(d.ppid)?.name || '?')} <span class="muted">${d.ppid}</span></a>` : '—'],
        ['Started', `${datetime(d.create_time)} <span class="muted">(${duration(age)} ago)</span>`],
        ['User', `${esc(d.username ?? '—')}`],
        ['UIDs (r/e/s)', d.uids ? `${d.uids.real} / ${d.uids.effective} / ${d.uids.saved}` : this._err(d, 'uids')],
        ['GIDs (r/e/s)', d.gids ? `${d.gids.real} / ${d.gids.effective} / ${d.gids.saved}` : this._err(d, 'gids')],
        ['Terminal', esc(d.terminal ?? '—')],
        ['Nice', esc(d.nice ?? '—')],
        d.ionice !== undefined ? ['IO priority', d.ionice ? `${esc(String(d.ionice.ioclass).replace('IOPRIO_CLASS_', '').toLowerCase())} ${d.ionice.value}` : '—'] : null,
        d.cpu_affinity !== undefined ? ['CPU affinity', esc(compactRange(d.cpu_affinity))] : null,
        d.cpu_num !== undefined ? ['Last ran on CPU', esc(d.cpu_num)] : null,
      ])}
      <h4>CPU time</h4>
      ${kv([
        ['User', secs(ct.user)],
        ['System', secs(ct.system)],
        ['Children user / sys', `${secs(ct.children_user)} / ${secs(ct.children_system)}`],
        ct.iowait !== undefined ? ['IO wait', secs(ct.iowait)] : null,
        ['Context switches', ctx ? `${num(ctx.voluntary)} voluntary · ${num(ctx.involuntary)} involuntary` : this._err(d, 'num_ctx_switches')],
      ])}
      <h4>I/O</h4>
      ${io ? kv([
        ['Read', `${bytes(io.read_bytes)} <span class="muted">(${num(io.read_count)} calls${io.read_chars !== undefined ? `, ${bytes(io.read_chars)} incl. cache` : ''})</span>`],
        ['Written', `${bytes(io.write_bytes)} <span class="muted">(${num(io.write_count)} calls${io.write_chars !== undefined ? `, ${bytes(io.write_chars)} incl. cache` : ''})</span>`],
        ['Rate now', row.io_read !== undefined && row.io_read !== null ? `↓ ${bytes(row.io_read)}/s · ↑ ${bytes(row.io_write)}/s` : '—'],
      ]) : this._denied(d, 'io_counters', 'I/O counters') || '<div class="muted">Not available on this platform.</div>'}`;
  }

  _drawCharts(d) {
    const hist = d.history || [];
    const c1 = this.body.querySelector('#chartCpu');
    const c2 = this.body.querySelector('#chartMem');
    if (c1) sparkline(c1, hist.map((h) => h[1]), { color: '#ff9a3c', max: Math.max(5, ...hist.map((h) => h[1])) });
    if (c2) sparkline(c2, hist.map((h) => h[2]), { color: '#5b8cff' });
  }

  _memory(d) {
    const mi = d.memory_info || {};
    const full = d.memory_full_info || {};
    const merged = { ...mi, ...full };
    const labels = {
      rss: 'Resident (RSS)', vms: 'Virtual (VMS)', uss: 'Unique (USS)', pss: 'Proportional (PSS)',
      swap: 'Swapped', shared: 'Shared', text: 'Code (text)', data: 'Data + stack', lib: 'Libraries', dirty: 'Dirty pages', pfaults: 'Page faults', pageins: 'Page-ins',
    };
    const rows = Object.entries(merged).map(([k, v]) => [labels[k] || k, ['pfaults', 'pageins'].includes(k) ? num(v) : bytes(v)]);
    let maps = '';
    if (d.memory_maps) {
      const max = Math.max(1, ...d.memory_maps.map((m) => m.rss || 0));
      maps = `<h4>Memory maps <span class="muted">(top ${d.memory_maps.length} by RSS)</span></h4>
        <table class="grid"><thead><tr><th>Mapping</th><th class="r w-num">RSS</th><th class="r w-num">Private</th><th class="r w-num">Swap</th></tr></thead><tbody>
        ${d.memory_maps.map((m) => `<tr>
          <td class="path" title="${esc(m.path)}">${bar((m.rss || 0) / max)}${esc(m.path || '[anon]')}</td>
          <td class="r">${bytes(m.rss)}</td>
          <td class="r">${bytes((m.private_clean || 0) + (m.private_dirty || 0))}</td>
          <td class="r">${bytes(m.swap)}</td></tr>`).join('')}
        </tbody></table>`;
    } else {
      maps = this._denied(d, 'memory_maps', 'Memory maps')
        || '<div class="muted note">Per-mapping memory breakdown is not available on this platform.</div>';
    }
    return `
      ${kv(rows)}
      ${this._denied(d, 'memory_full_info', 'USS/PSS/swap breakdown')}
      ${maps}`;
  }

  _files(d) {
    const files = d.open_files;
    if (!files) return this._denied(d, 'open_files', 'Open files');
    if (!files.length) return '<div class="empty">No regular files open.</div>';
    const fdNote = d.num_fds !== undefined ? `<div class="muted note">${num(d.num_fds)} file descriptors total (files, sockets, pipes…); ${files.length} are regular files.</div>` : '';
    return `${fdNote}<table class="grid"><thead><tr><th class="r">FD</th><th>Path</th><th class="w-mode">Mode</th><th class="r w-num">Offset</th></tr></thead><tbody>
      ${files.sort((a, b) => a.fd - b.fd).map((f) => `<tr><td class="r">${f.fd}</td><td class="path" title="${esc(f.path)}">${esc(f.path)}</td><td>${esc(f.mode ?? '')}</td><td class="r">${f.position !== undefined ? bytes(f.position) : ''}</td></tr>`).join('')}
      </tbody></table>`;
  }

  _net(d) {
    const conns = d.connections;
    if (!conns) return this._denied(d, 'connections', 'Connections');
    if (!conns.length) return '<div class="empty">No sockets open.</div>';
    const fam = { AF_INET: 'IPv4', AF_INET6: 'IPv6', AF_UNIX: 'Unix' };
    const typ = { SOCK_STREAM: 'TCP', SOCK_DGRAM: 'UDP', SOCK_SEQPACKET: 'SEQ', SOCK_RAW: 'RAW' };
    const addr = (a) => {
      if (!a || (Array.isArray(a) && !a.length)) return '<span class="muted">—</span>';
      if (typeof a === 'string') return esc(a);
      if (Array.isArray(a)) return esc(`${a[0].includes(':') ? `[${a[0]}]` : a[0]}:${a[1]}`);
      return esc(`${a.ip.includes(':') ? `[${a.ip}]` : a.ip}:${a.port}`);
    };
    const order = { LISTEN: 0, ESTABLISHED: 1 };
    conns.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
    const listening = conns.filter((c) => c.status === 'LISTEN').length;
    const est = conns.filter((c) => c.status === 'ESTABLISHED').length;
    return `<div class="muted note">${listening} listening · ${est} established · ${conns.length} total</div>
      <table class="grid"><thead><tr><th class="w-proto">Proto</th><th>Local</th><th>Remote</th><th class="w-state">State</th></tr></thead><tbody>
      ${conns.map((c) => `<tr><td>${typ[c.type] || esc(c.type)}/${fam[c.family] || esc(c.family)}</td><td class="path">${addr(c.laddr)}</td><td class="path">${addr(c.raddr)}</td>
        <td><span class="state state-${esc(c.status)}">${esc(c.status === 'NONE' ? '' : c.status)}</span></td></tr>`).join('')}
      </tbody></table>`;
  }

  _threads(d) {
    const th = d.threads;
    if (!th) return this._denied(d, 'threads', 'Threads');
    const rows = th.map((t) => ({ ...t, total: (t.user_time || 0) + (t.system_time || 0) })).sort((a, b) => b.total - a.total);
    const max = Math.max(1e-9, ...rows.map((t) => t.total));
    return `<div class="muted note">Sorted by total CPU time consumed.</div>
      <table class="grid"><thead><tr><th class="r">TID</th><th>CPU time</th><th class="r w-num">User</th><th class="r w-num">System</th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td class="r">${t.id}${t.id === this.pid ? ' <span class="muted">main</span>' : ''}</td><td>${bar(t.total / max, true)}</td><td class="r">${secs(t.user_time)}</td><td class="r">${secs(t.system_time)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  _env(d) {
    const env = d.environ;
    if (!env) return this._denied(d, 'environ', 'Environment');
    const keys = Object.keys(env).sort();
    if (!keys.length) return '<div class="empty">Empty environment.</div>';
    return `<div class="muted note">Values that look like secrets are masked — click to reveal.</div>
      <table class="grid env"><tbody>
      ${keys.map((k) => {
        const masked = SECRET_KEY.test(k) && !this.revealed.has(k);
        const v = masked ? `<span class="masked" data-reveal="${esc(k)}">•••••••• reveal</span>` : esc(env[k]);
        return `<tr><th>${esc(k)}</th><td class="path">${k === 'PATH' ? esc(env[k]).split(':').join(':<wbr>') : v}</td></tr>`;
      }).join('')}
      </tbody></table>`;
  }

  _tree(d) {
    const parents = (d.parents || []).slice().reverse();
    const children = d.children || [];
    const node = (p, cls = '') => {
      const r = this.lookup(p.pid);
      return `<a class="node ${cls}" data-pid="${p.pid}"><b>${esc(p.name)}</b><span>${p.pid}</span>${r ? `<em>${pct(r.cpu_percent)} · ${bytes(r.rss, 0)}</em>` : ''}</a>`;
    };
    return `
      <h4>Ancestry</h4>
      <div class="tree">
        ${parents.map((p, i) => `<div style="--depth:${i}">${node(p)}</div>`).join('')}
        <div style="--depth:${parents.length}">${node({ pid: this.pid, name: d.name }, 'current')}</div>
        ${children.map((c) => `<div style="--depth:${parents.length + 1}">${node(c)}</div>`).join('')}
      </div>
      ${this._denied(d, 'parents', 'Parents')}
      ${children.length ? '' : '<div class="muted note">No child processes.</div>'}`;
  }

  _limits(d) {
    const lim = d.rlimits;
    if (!lim) return this._denied(d, 'rlimits', 'Resource limits') || '<div class="empty">Resource limits are not available on this platform.</div>';
    const sizeish = new Set(['as', 'core', 'data', 'fsize', 'memlock', 'rss', 'stack', 'msgqueue']);
    const fmt = (k, v) => (v < 0 || v >= INF ? '∞' : sizeish.has(k) ? bytes(v) : num(v));
    return `<table class="grid"><thead><tr><th>Limit</th><th class="r w-num">Soft</th><th class="r w-num">Hard</th></tr></thead><tbody>
      ${Object.entries(lim).map(([k, [s, h]]) => `<tr><td>${esc(k.toUpperCase())}</td><td class="r">${fmt(k, s)}</td><td class="r">${fmt(k, h)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  _kernel(d) {
    const lx = d.linux;
    if (!lx) return '<div class="empty">Kernel details are Linux-only.</div>';
    const ns = Object.entries(lx.namespaces || {});
    return `
      <h4>Scheduler & memory killer</h4>
      ${kv([
        ['Waiting in (wchan)', mono(lx.wchan && lx.wchan !== '0' ? lx.wchan : '— (running or not blocked)')],
        ['OOM score', `${esc(lx.oom_score ?? '—')} <span class="muted">adj ${esc(lx.oom_score_adj ?? '—')}</span>`],
        ['Login UID / session', `${esc(lx.loginuid ?? '—')} / ${esc(lx.sessionid ?? '—')}`],
      ])}
      <h4>cgroup</h4>
      <pre>${esc(lx.cgroup || '—')}</pre>
      ${ns.length ? `<h4>Namespaces</h4>${kv(ns.map(([k, v]) => [k, mono(v)]))}` : ''}
      <h4>/proc/${this.pid}/status</h4>
      <table class="grid"><tbody>
        ${Object.entries(lx.status || {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td class="path">${esc(v)}</td></tr>`).join('')}
      </tbody></table>
      ${lx.sched ? `<h4>Scheduler stats</h4><pre>${esc(lx.sched.join('\n'))}</pre>` : ''}`;
  }

  _err(d, key) {
    const e = d.errors?.[key];
    return e ? `<span class="muted">🔒 ${esc(e)}</span>` : '';
  }

  // ------------------------------------------------------------ events
  async _onClick(e) {
    const t = e.target;
    const pidLink = t.closest('[data-pid]');
    if (pidLink) { this.onNavigate(Number(pidLink.dataset.pid)); return; }
    const reveal = t.closest('[data-reveal]');
    if (reveal) { this.revealed.add(reveal.dataset.reveal); this.render(); return; }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'close') this.onClose();
    else if (act === 'focus') this.onNavigate(this.pid, { focusOnly: true });
    else if (act === 'parent') { const r = this.lookup(this.pid); if (r?.ppid) this.onNavigate(r.ppid); }
    else if (act === 'refresh') this.refresh();
    const sig = t.closest('[data-sig]')?.dataset.sig;
    if (sig) {
      const name = this.data?.name || this.lookup(this.pid)?.name || '';
      if (!window.confirm(`Send SIG${sig} to ${name} (pid ${this.pid})?`)) return;
      try {
        await api.signal(this.pid, sig);
        this.toast(`Sent SIG${sig} to ${name} (${this.pid})`);
        setTimeout(() => this.refresh(), 300);
      } catch (err) {
        this.toast(`Signal failed: ${err.message}`, true);
      }
    }
  }
}

// ------------------------------------------------------------- helpers
function kv(rows) {
  return `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v === undefined || v === '' ? '—' : v}</dd>`).join('')}</dl>`;
}

function mono(s) {
  return s ? `<code>${esc(s)}</code>` : '';
}

function bar(frac, standalone = false) {
  const w = Math.max(0, Math.min(1, frac)) * 100;
  return `<span class="bar ${standalone ? 'solo' : ''}"><span style="width:${w.toFixed(1)}%"></span></span>`;
}

function compactRange(list) {
  if (!Array.isArray(list) || !list.length) return '—';
  const out = [];
  let start = list[0]; let prev = list[0];
  for (const n of list.slice(1).concat([null])) {
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  return out.join(', ');
}
