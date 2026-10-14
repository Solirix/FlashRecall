// Fetch wrapper for the FlashRecall API.
// - credentials: same-origin (session cookie)
// - JSON in/out
// - throws { status, message } on failure
// - any 401 (outside login/register) notifies the app so it can redirect to #/login

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw { status: 0, message: 'network error — is the server running?' };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = { status: res.status, message: (data && data.error) || `request failed (${res.status})` };
    if (res.status === 401 && onUnauthorized
        && !path.startsWith('/api/login') && !path.startsWith('/api/register')
        && !path.startsWith('/api/me')) { // PATCH /api/me 401 = wrong current password, not an expired session
      onUnauthorized(err);
    }
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => request(path, { method: 'PATCH', body: body ?? {} }),
  put: (path, body) => request(path, { method: 'PUT', body: body ?? {} }),
  del: (path) => request(path, { method: 'DELETE' }),
};
