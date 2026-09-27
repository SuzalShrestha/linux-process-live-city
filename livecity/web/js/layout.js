// Turns a process snapshot into a city plan: districts (groups of
// processes) laid out as blocks, each process a building on a lot.

import { parseSize } from './format.js';

export const CELL = 3.0;       // lot size, world units
export const ROAD = 7.0;       // gap between districts
const MAX_FOOT = CELL * 0.78;  // widest a building may get

// ---------------------------------------------------------------- metrics
const log2 = Math.log2;

export const HEIGHT_METRICS = {
  memory: { label: 'Memory (RSS)', fn: (p) => 0.35 + 3.1 * log2(1 + (p.rss || 0) / (4 * 1024 ** 2)) },
  cpu: { label: 'CPU %', fn: (p) => 0.35 + 34 * Math.sqrt(Math.min(p.cpu_percent || 0, 400) / 100) },
  threads: { label: 'Threads', fn: (p) => 0.35 + 5 * log2(Math.max(1, p.num_threads || 1)) },
  fds: { label: 'Open files', fn: (p) => 0.35 + 3.6 * log2(1 + (p.num_fds || 0)) },
  uptime: { label: 'Uptime', fn: (p, now) => 0.35 + 2.6 * log2(1 + Math.max(0, now - (p.create_time || now)) / 60) },
  vms: { label: 'Virtual memory', fn: (p) => 0.35 + 2.2 * log2(1 + (p.vms || 0) / (16 * 1024 ** 2)) },
};

// Each returns "heat" in [0, 1]: 0 renders cool blue glass, 1 hot orange.
export const COLOR_METRICS = {
  cpu: { label: 'CPU %', fn: (p) => Math.min(1, Math.sqrt((p.cpu_percent || 0) / 60)), legend: ['idle', 'busy'] },
  memory: { label: 'Memory', fn: (p, ctx) => Math.min(1, Math.sqrt((p.rss || 0) / ctx.maxRss)), legend: ['small', 'largest'] },
  io: { label: 'Disk IO', fn: (p) => Math.min(1, Math.log10(1 + (p.io_read || 0) + (p.io_write || 0)) / 7), legend: ['quiet', '10 MB/s+'] },
  status: {
    label: 'State',
    fn: (p) => ({ running: 1, 'disk-sleep': 0.75, waking: 0.6, sleeping: 0.18 }[p.status] ?? 0.05),
    legend: ['idle', 'running'],
  },
  age: { label: 'Age', fn: (p, ctx) => Math.min(1, Math.max(0, 1 - (ctx.now - (p.create_time || 0)) / 3600)), legend: ['old', 'new (<1h)'] },
};

export function footprint(p) {
  return Math.min(MAX_FOOT, 1.05 + 0.3 * log2(Math.max(1, p.num_threads || 1)));
}

// ------------------------------------------------------------- grouping
const SESSION_ROOTS = new Set(['systemd', 'launchd', 'init', 'kthreadd', 'kernel_task']);

export const GROUPINGS = {
  app: 'App (process tree)',
  user: 'User',
  name: 'Process name',
  status: 'State',
  none: 'One big city',
};

export function groupKey(p, mode, byPid) {
  switch (mode) {
    case 'user': return p.username || 'restricted';
    case 'name': return p.name || '?';
    case 'status': return p.status || '?';
    case 'none': return 'city';
    default: {
      if (p.kernel) return 'kernel';
      // Walk up to the top-most ancestor below a session root (init,
      // systemd --user, launchd...) so each app tree becomes a district.
      let cur = p;
      for (let guard = 0; guard < 64; guard++) {
        const parent = byPid.get(cur.ppid);
        if (!parent || parent.pid === cur.pid || parent.pid <= 1 || SESSION_ROOTS.has(parent.name)) break;
        cur = parent;
      }
      return cur.name || '?';
    }
  }
}

// --------------------------------------------------------------- layout
// Returns { lots: Map(pid -> {x, z, district}), districts: [{key, x, z, w, d, count}] }
export function computeLayout(procs, mode) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const groups = new Map();
  for (const p of procs) {
    const k = groupKey(p, mode, byPid);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const districts = [...groups.entries()].map(([key, members]) => {
    members.sort((a, b) => a.pid - b.pid);
    const cols = Math.ceil(Math.sqrt(members.length));
    const rows = Math.ceil(members.length / cols);
    return { key, members, cols, rows, w: cols * CELL + 2, d: rows * CELL + 2, count: members.length };
  });
  // Biggest districts first gives a dense downtown; ties broken by name
  // so the plan stays put between refreshes.
  districts.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));

  // Shelf packing into a roughly square city.
  const area = districts.reduce((s, d) => s + (d.w + ROAD) * (d.d + ROAD), 0);
  const targetW = Math.max(Math.sqrt(area) * 1.05, districts[0] ? districts[0].w : 0);
  let x = 0; let z = 0; let shelf = 0; let maxX = 0;
  for (const d of districts) {
    if (x > 0 && x + d.w > targetW) { x = 0; z += shelf + ROAD; shelf = 0; }
    d.x = x; d.z = z;
    x += d.w + ROAD;
    shelf = Math.max(shelf, d.d);
    maxX = Math.max(maxX, d.x + d.w);
  }
  const totalD = z + shelf;
  const ox = maxX / 2; const oz = totalD / 2;

  const lots = new Map();
  for (const d of districts) {
    d.x -= ox; d.z -= oz;
    d.members.forEach((p, i) => {
      const c = i % d.cols; const r = Math.floor(i / d.cols);
      lots.set(p.pid, {
        x: d.x + 1 + c * CELL + CELL / 2,
        z: d.z + 1 + r * CELL + CELL / 2,
        district: d.key,
      });
    });
    delete d.members;
  }
  return { lots, districts, radius: Math.hypot(maxX, totalD) / 2 };
}

// ---------------------------------------------------------------- search
// Query language: space separated terms, all must match.
//   firefox          substring of name / command / user / pid
//   user:root        field match (user, name, cmd, status, pid, ppid)
//   cpu>5  mem>200M  threads>=10  fds>100  (comparisons: > < >= <= =)
export function compileQuery(q) {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const tests = terms.map((t) => {
    const cmp = /^(cpu|mem|rss|vms|threads|fds|pid|ppid|nice)(>=|<=|>|<|=)(.+)$/.exec(t);
    if (cmp) {
      const [, field, op, raw] = cmp;
      const val = ['mem', 'rss', 'vms'].includes(field) ? parseSize(raw) : parseFloat(raw);
      const get = {
        cpu: (p) => p.cpu_percent, mem: (p) => p.rss, rss: (p) => p.rss, vms: (p) => p.vms,
        threads: (p) => p.num_threads, fds: (p) => p.num_fds, pid: (p) => p.pid,
        ppid: (p) => p.ppid, nice: (p) => p.nice,
      }[field];
      return (p) => {
        const v = get(p);
        if (v === null || v === undefined || Number.isNaN(val)) return false;
        return op === '>' ? v > val : op === '<' ? v < val : op === '>=' ? v >= val : op === '<=' ? v <= val : v === val;
      };
    }
    const kv = /^(user|name|cmd|status|pid|ppid):(.+)$/.exec(t);
    if (kv) {
      const [, field, val] = kv;
      if (field === 'pid' || field === 'ppid') return (p) => String(p[field]) === val;
      const key = { user: 'username', name: 'name', cmd: 'cmd', status: 'status' }[field];
      return (p) => (p[key] || '').toLowerCase().includes(val);
    }
    return (p) => String(p.pid) === t
      || (p.name || '').toLowerCase().includes(t)
      || (p.cmd || '').toLowerCase().includes(t)
      || (p.username || '').toLowerCase().includes(t);
  });
  return (p) => tests.every((fn) => fn(p));
}
