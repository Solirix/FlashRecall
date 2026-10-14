'use strict';

const { json, badRequest, mergeSettings, DEFAULT_SETTINGS } = require('../util');
const { hashPassword, verifyPassword } = require('../auth');

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

function validateSettingsPatch(body) {
  const patch = {};
  for (const key of Object.keys(body)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const value = body[key];
    switch (key) {
      case 'theme':
        if (typeof value !== 'string' || value.length === 0 || value.length > 32) {
          throw badRequest('theme must be a string of 1-32 chars');
        }
        patch.theme = value;
        break;
      case 'accent':
        if (value !== null && (typeof value !== 'string' || !ACCENT_RE.test(value))) {
          throw badRequest('accent must be #rrggbb or null');
        }
        patch.accent = value;
        break;
      case 'fontSize':
        if (typeof value !== 'number' || value < 12 || value > 20) {
          throw badRequest('fontSize must be a number 12-20');
        }
        patch.fontSize = value;
        break;
      case 'borderRadius':
        if (typeof value !== 'number' || value < 0 || value > 24) {
          throw badRequest('borderRadius must be a number 0-24');
        }
        patch.borderRadius = value;
        break;
      case 'reducedMotion':
        if (typeof value !== 'boolean') throw badRequest('reducedMotion must be a boolean');
        patch.reducedMotion = value;
        break;
      case 'desiredRetention':
        if (typeof value !== 'number' || value < 0.80 || value > 0.97) {
          throw badRequest('desiredRetention must be a number 0.80-0.97');
        }
        patch.desiredRetention = value;
        break;
      case 'newPerDayDefault':
        if (!Number.isInteger(value) || value < 0 || value > 9999) {
          throw badRequest('newPerDayDefault must be an integer 0-9999');
        }
        patch.newPerDayDefault = value;
        break;
      case 'reviewCap':
        if (!Number.isInteger(value) || value < 0 || value > 99999) {
          throw badRequest('reviewCap must be an integer 0-99999');
        }
        patch.reviewCap = value;
        break;
      case 'leechThreshold':
        if (!Number.isInteger(value) || value < 3 || value > 20) {
          throw badRequest('leechThreshold must be an integer 3-20');
        }
        patch.leechThreshold = value;
        break;
      default:
        break;
    }
  }
  return patch;
}

function meJson(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    settings: mergeSettings(user),
  };
}

module.exports = function registerSettingsRoutes(router, db) {
  router.get('/api/settings', (req, res) => {
    json(res, mergeSettings(req.user));
  });

  router.put('/api/settings', (req, res, params, body) => {
    const patch = validateSettingsPatch(body);
    const merged = { ...mergeSettings(req.user), ...patch };
    db.prepare('UPDATE users SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify(merged), req.user.id);
    json(res, merged);
  });

  router.patch('/api/me', (req, res, params, body) => {
    let displayName = req.user.display_name;
    if (body.displayName !== undefined) {
      if (body.displayName !== null && (typeof body.displayName !== 'string' || body.displayName.length > 64)) {
        throw badRequest('displayName must be a string of at most 64 chars or null');
      }
      displayName = body.displayName;
    }
    if (body.newPassword !== undefined) {
      if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
        throw badRequest('newPassword must be at least 8 chars');
      }
      if (typeof body.currentPassword !== 'string'
          || !verifyPassword(body.currentPassword, req.user.salt, req.user.pass_hash)) {
        const err = { status: 401, message: 'current password is incorrect' };
        throw err;
      }
      const { salt, hash } = hashPassword(body.newPassword);
      db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, req.user.id);
      // Other sessions are invalidated by password change.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
        .run(req.user.id, req.sessionToken || '');
    }
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    json(res, meJson(updated));
  });
};

module.exports.meJson = meJson;
