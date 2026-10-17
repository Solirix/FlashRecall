// #/settings — account, appearance (live-previewed), scheduling, sharing, about.

import { api } from '../api.js';
import { el, icon, toast, passwordField } from '../ui.js';
import { state, applyTheme, cacheSettings, navigate, refreshDecks } from '../app.js';

const THEMES = [
  { id: 'recall-dark', name: 'Recall Dark', bg: '#0b0e14', accent: '#7c6cff' },
  { id: 'light', name: 'Light', bg: '#f7f8fc', accent: '#6a5ae0' },
  { id: 'midnight', name: 'Midnight OLED', bg: '#000000', accent: '#7c6cff' },
  { id: 'solarized', name: 'Solarized', bg: '#002b36', accent: '#6c71c4' },
];

const TINTS = [
  { id: '', name: 'None', color: 'transparent' },
  { id: '#5ea2f7', name: 'Blue', color: '#5ea2f7' },
  { id: '#8b7cff', name: 'Violet', color: '#8b7cff' },
  { id: '#2dd4bf', name: 'Teal', color: '#2dd4bf' },
];

export async function render(main) {
  main.innerHTML = '';
  const s = state.settings || {};
  const wrap = el('div', { class: 'settings-wrap' }, el('h2', { text: 'Settings' }));
  main.append(wrap);

  async function saveSettings(patch) {
    try {
      const merged = await api.put('/api/settings', patch);
      state.settings = merged;
      applyTheme(merged);
      return merged;
    } catch (err) {
      toast(err.message || 'failed to save settings', 'error');
      return null;
    }
  }

  const section = (title, ...children) =>
    wrap.append(el('section', { class: 'card' },
      el('h3', { text: title, style: 'margin-bottom:6px' }), ...children));

  const row = (name, desc, control, val) =>
    el('div', { class: 'setting-row' },
      el('div', { class: 'sr-label' },
        el('div', { class: 'sr-name', text: name }),
        desc ? el('div', { class: 'sr-desc', text: desc }) : null),
      val || null, control);

  // ---------- Account ----------

  const nameInput = el('input', { type: 'text', value: state.user?.displayName || '', placeholder: state.user?.username || '' });
  const curPw = el('input', { type: 'password', placeholder: 'current password', autocomplete: 'current-password' });
  const newPw = el('input', { type: 'password', placeholder: 'new password (min 8)', autocomplete: 'new-password' });
  section('Account',
    row('Display name', `@${state.user?.username}`, el('button', {
      class: 'btn',
      onclick: async () => {
        try {
          const me = await api.patch('/api/me', { displayName: nameInput.value.trim() || null });
          state.user = me;
          toast('Saved', 'success');
        } catch (err) { toast(err.message || 'failed', 'error'); }
      },
    }, 'Save'), nameInput),
    row('Change password', 'other sessions are signed out', el('button', {
      class: 'btn',
      onclick: async () => {
        try {
          await api.patch('/api/me', { currentPassword: curPw.value, newPassword: newPw.value });
          curPw.value = ''; newPw.value = '';
          toast('Password changed', 'success');
        } catch (err) { toast(err.message || 'failed', 'error'); }
      },
    }, 'Change'),
    el('div', { style: 'display:flex;flex-direction:column;gap:6px;width:190px' }, passwordField(curPw), passwordField(newPw))),
    row('Log out', null, el('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        try { await api.post('/api/logout'); } catch { /* still leave */ }
        state.user = null;
        navigate('#/login');
      },
    }, 'Log out')));

  // ---------- Appearance ----------

  const themeGrid = el('div', { class: 'theme-grid' }, THEMES.map((t) =>
    el('button', {
      class: `theme-swatch${(s.theme || 'recall-dark') === t.id ? ' active' : ''}`,
      type: 'button',
      onclick: async (e) => {
        themeGrid.querySelectorAll('.theme-swatch').forEach((n) => n.classList.remove('active'));
        e.currentTarget.classList.add('active');
        await saveSettings({ theme: t.id });
      },
    },
    el('div', { class: 'sw-preview', style: `background:${t.bg}` },
      el('span', { class: 'sw-dot', style: `background:${t.accent}` }),
      el('span', { class: 'sw-dot', style: 'background:var(--border-strong)' }),
      el('span', { class: 'sw-dot', style: 'background:var(--border-strong)' })),
    t.name)));

  let cached = {};
  try { cached = JSON.parse(localStorage.getItem('recall.settings') || '{}'); } catch { /* fresh */ }
  const tintRow = el('div', { class: 'tint-row' }, TINTS.map((t) =>
    el('button', {
      class: `tint-dot${(cached.tint || '') === t.id ? ' active' : ''}`,
      type: 'button', title: t.name,
      style: `background:${t.color === 'transparent' ? 'var(--surface-3)' : t.color}`,
      onclick: (e) => {
        tintRow.querySelectorAll('.tint-dot').forEach((n) => n.classList.remove('active'));
        e.currentTarget.classList.add('active');
        cacheSettings({ tint: t.id || null });
        if (t.id) document.documentElement.style.setProperty('--tint', t.id);
        else document.documentElement.style.removeProperty('--tint');
      },
    })));

  const accentInput = el('input', {
    type: 'color', value: s.accent || '#7c6cff',
    oninput: (e) => document.documentElement.style.setProperty('--accent', e.target.value),
    onchange: async (e) => { await saveSettings({ accent: e.target.value }); },
  });
  const fontSlider = el('input', {
    type: 'range', min: 12, max: 20, step: 1, value: s.fontSize || 16,
    oninput: (e) => {
      document.documentElement.style.setProperty('--font-size', `${e.target.value}px`);
      fontVal.textContent = `${e.target.value}px`;
    },
    onchange: async (e) => { await saveSettings({ fontSize: Number(e.target.value) }); },
  });
  const fontVal = el('span', { class: 'sr-val', text: `${s.fontSize || 16}px` });
  const radiusSlider = el('input', {
    type: 'range', min: 0, max: 24, step: 1, value: s.borderRadius ?? 12,
    oninput: (e) => {
      document.documentElement.style.setProperty('--radius', `${e.target.value}px`);
      radiusVal.textContent = `${e.target.value}px`;
    },
    onchange: async (e) => { await saveSettings({ borderRadius: Number(e.target.value) }); },
  });
  const radiusVal = el('span', { class: 'sr-val', text: `${s.borderRadius ?? 12}px` });
  const motionToggle = el('input', {
    type: 'checkbox', class: 'switch', checked: !!s.reducedMotion || null,
    onchange: async (e) => { await saveSettings({ reducedMotion: e.target.checked }); },
  });

  section('Appearance',
    el('div', { class: 'field-label', text: 'Theme' }), themeGrid,
    row('Accent color', null, el('button', {
      class: 'btn btn-ghost', style: 'padding:6px 10px;font-size:12px',
      onclick: async () => {
        accentInput.value = '#7c6cff';
        document.documentElement.style.removeProperty('--accent');
        await saveSettings({ accent: null });
      },
    }, 'Reset'), accentInput),
    row('Background tint', 'subtle hue shift of surfaces (this device only)', null, tintRow),
    row('Font size', null, fontVal, fontSlider),
    row('Border radius', null, radiusVal, radiusSlider),
    row('Reduced motion', 'disable transitions and animations', motionToggle));

  // ---------- Scheduling ----------

  const drSlider = el('input', {
    type: 'range', min: 0.8, max: 0.97, step: 0.01, value: s.desiredRetention ?? 0.9,
    oninput: (e) => { drVal.textContent = `${Math.round(Number(e.target.value) * 100)}%`; },
    onchange: async (e) => { await saveSettings({ desiredRetention: Number(e.target.value) }); },
  });
  const drVal = el('span', { class: 'sr-val', text: `${Math.round((s.desiredRetention ?? 0.9) * 100)}%` });
  const numField = (val, min, max, key) => el('input', {
    type: 'number', min, max, value: val,
    onchange: async (e) => {
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < min || n > max) { toast(`must be an integer ${min}–${max}`, 'error'); e.target.value = val; return; }
      if (await saveSettings({ [key]: n })) val = n;
    },
  });

  section('Scheduling',
    row('Desired retention', 'FSRS target recall probability', drVal, drSlider),
    row('New cards / day default', null, numField(s.newPerDayDefault ?? 20, 0, 9999, 'newPerDayDefault')),
    row('Review cap', 'max reviews per day', numField(s.reviewCap ?? 9999, 0, 99999, 'reviewCap')),
    row('Leech threshold', 'lapses before a note is tagged leech', numField(s.leechThreshold ?? 8, 3, 20, 'leechThreshold')));

  // ---------- Sharing ----------

  const shareCard = el('section', { class: 'card' }, el('h3', { text: 'Sharing', style: 'margin-bottom:6px' }),
    el('div', { class: 'spinner', style: 'margin:20px auto' }));
  wrap.append(shareCard);

  try {
    const shares = await api.get('/api/shares');
    shareCard.innerHTML = '';
    shareCard.append(el('h3', { text: 'Sharing', style: 'margin-bottom:6px' }));

    shareCard.append(el('div', { class: 'section-label', style: 'margin:6px 0 2px', text: 'Incoming' }));
    if (!shares.incoming.length) shareCard.append(el('div', { class: 'empty-line', text: 'No pending shares.' }));
    for (const sh of shares.incoming) {
      shareCard.append(el('div', { class: 'share-row' },
        el('div', { class: 'share-meta' },
          el('div', { text: sh.deckName }),
          el('div', { class: 'share-sub', text: `from ${sh.fromUsername}` })),
        el('button', {
          class: 'btn btn-primary', style: 'min-height:30px;padding:4px 14px;font-size:12px',
          onclick: async () => {
            try {
              const res = await api.post(`/api/shares/${sh.id}/accept`);
              toast(`Added “${res.deckName}” (${res.notes} notes)`, 'success');
              await refreshDecks().catch(() => {});
              render(main);
            } catch (err) { toast(err.message || 'accept failed', 'error'); }
          },
        }, 'Accept'),
        el('button', {
          class: 'btn', style: 'min-height:30px;padding:4px 14px;font-size:12px',
          onclick: async () => {
            try {
              await api.post(`/api/shares/${sh.id}/decline`);
              render(main);
            } catch (err) { toast(err.message || 'decline failed', 'error'); }
          },
        }, 'Decline')));
    }

    shareCard.append(el('div', { class: 'section-label', style: 'margin:14px 0 2px', text: 'Sent' }));
    if (!shares.sent.length) shareCard.append(el('div', { class: 'empty-line', text: 'Nothing shared yet.' }));
    for (const sh of shares.sent) {
      shareCard.append(el('div', { class: 'share-row' },
        el('div', { class: 'share-meta' },
          el('div', { text: sh.deckName }),
          el('div', { class: 'share-sub', text: `to ${sh.toUsername}` })),
        el('span', { class: `chip ${sh.status === 'accepted' ? 'c-rev' : sh.status === 'declined' ? 'c-lrn' : ''}`, text: sh.status })));
    }

    const shareDeck = el('select', {}, state.decks.map((d) => el('option', { value: d.id, text: d.name })));
    const shareUser = el('input', { type: 'text', placeholder: 'username' });
    shareCard.append(
      el('div', { class: 'section-label', style: 'margin:14px 0 6px', text: 'Share a deck' }),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        el('div', { style: 'flex:1;min-width:130px' }, shareDeck),
        el('div', { style: 'flex:1;min-width:130px' }, shareUser),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!shareUser.value.trim()) { toast('enter a username', 'error'); return; }
            try {
              await api.post('/api/shares', { deckId: Number(shareDeck.value), toUsername: shareUser.value.trim() });
              toast('Share sent', 'success');
              render(main);
            } catch (err) { toast(err.message || 'share failed', 'error'); }
          },
        }, 'Share')));
  } catch (err) {
    if (err.status !== 401) {
      shareCard.innerHTML = '';
      shareCard.append(el('div', { class: 'empty-line', text: err.message || 'failed to load shares' }));
    }
  }

  // ---------- About ----------

  section('About',
    el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.6' },
      'FlashRecall 1.0.0 — a zero-dependency, self-hosted spaced-repetition app. ',
      'FSRS-4.5 scheduling · Node stdlib server · no build step.'));
}
