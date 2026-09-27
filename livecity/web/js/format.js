// Small formatting helpers shared by the HUD and the inspector.

export function bytes(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function rate(n) {
  if (n === null || n === undefined) return '—';
  return `${bytes(n)}/s`;
}

export function pct(n, digits = 1) {
  if (n === null || n === undefined) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

export function num(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

export function duration(sec) {
  if (sec === null || sec === undefined || sec < 0) return '—';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function secs(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1) return `${(n * 1000).toFixed(0)} ms`;
  if (n < 120) return `${n.toFixed(2)} s`;
  return duration(n);
}

export function datetime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// "1.5G", "200M", "64k" -> bytes, used by the search query parser.
export function parseSize(s) {
  const m = /^([\d.]+)\s*([kmgt]?)i?b?$/i.exec(s.trim());
  if (!m) return NaN;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return parseFloat(m[1]) * mult;
}

export function sparkline(canvas, values, { color = '#ff9a3c', max = null, fill = true } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const vals = values.filter((v) => v !== null && v !== undefined);
  if (vals.length < 2) return;
  const hi = max ?? Math.max(...vals, 1e-9);
  const step = w / (values.length - 1);
  ctx.beginPath();
  values.forEach((v, i) => {
    const y = h - 2 - ((v ?? 0) / hi) * (h - 4);
    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * step, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.stroke();
  if (fill) {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, `${color}55`);
    g.addColorStop(1, `${color}00`);
    ctx.fillStyle = g;
    ctx.shadowBlur = 0;
    ctx.fill();
  }
}
