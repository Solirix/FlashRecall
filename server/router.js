'use strict';

const { json, readBody, httpError } = require('./util');

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

class Router {
  constructor() {
    this.routes = [];
  }

  register(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) + '$'
    );
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern, handler) { this.register('GET', pattern, handler); }
  post(pattern, handler) { this.register('POST', pattern, handler); }
  put(pattern, handler) { this.register('PUT', pattern, handler); }
  patch(pattern, handler) { this.register('PATCH', pattern, handler); }
  delete(pattern, handler) { this.register('DELETE', pattern, handler); }

  // Returns true if a route matched and handled the request.
  async dispatch(req, res, pathname) {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      try {
        const params = {};
        route.keys.forEach((key, i) => {
          try {
            params[key] = decodeURIComponent(m[i + 1]);
          } catch {
            throw httpError(400, 'malformed URL encoding in path');
          }
        });
        let body = {};
        if (BODY_METHODS.has(req.method)) {
          const raw = await readBody(req);
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              throw httpError(400, 'invalid JSON body');
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
              throw httpError(400, 'JSON body must be an object');
            }
          }
        }
        await route.handler(req, res, params, body);
      } catch (err) {
        if (err && typeof err.status === 'number') {
          json(res, { error: err.message || 'error' }, err.status);
        } else {
          console.error('Unhandled route error:', err);
          json(res, { error: 'internal server error' }, 500);
        }
      }
      return true;
    }
    return false;
  }
}

module.exports = { Router };
