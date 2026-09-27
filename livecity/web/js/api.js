// Thin wrapper around the backend's JSON API.

const token = new URLSearchParams(location.search).get('token');

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers['X-LiveCity-Token'] = token;
  const res = await fetch(path, { ...options, headers, cache: 'no-store' });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error */ }
  if (res.ok && body === null) throw new Error(`${path} returned invalid JSON (HTTP ${res.status})`);
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const api = {
  config: () => request('/api/config'),
  snapshot: () => request('/api/snapshot'),
  process: (pid) => request(`/api/process/${pid}`),
  signal: (pid, signal) => request(`/api/process/${pid}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LiveCity': '1' },
    body: JSON.stringify({ signal }),
  }),
};
