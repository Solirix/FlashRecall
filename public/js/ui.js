// Shared UI helpers: el() DOM builder, inline SVG icons, modal, toast,
// formatting utilities, and markdown-lite rendering.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// --- inline SVG icons (stroke-based, 24 viewBox) ---

const P = {
  bolt: 'M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z',
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  layers: 'M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5M3 18l9 5 9-5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  plus: 'M12 5v14M5 12h14',
  chart: 'M4 20V10M10 20V4M16 20v-8M21 20H3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.12-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.4a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.04 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.63.88 1.04 1.56 1.04H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  sync: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  flag: 'M5 21V4m0 1h13l-2.5 4L18 13H5',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  pencil: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
  close: 'M18 6 6 18M6 6l12 12',
  back: 'M19 12H5m7-7-7 7 7 7',
  play: 'M6 4v16l14-8L6 4z',
  speaker: 'M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 3',
  flame: 'M12 22c4 0 7-2.7 7-6.5 0-3-2-5.5-3.5-7C14 7 13 5 13 2c-3 2-5 5-5 8-1-1-1.5-2-2-3.5C4.5 8.5 5 9 5 15.5 5 19.3 8 22 12 22z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M9 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  mic: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8',
  check: 'M20 6 9 17l-5-5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2',
  caret: 'M9 6l6 6-6 6',
  cards: 'M8 3h12v13H8zM4 8v13h12M4 8l1-2',
  clipboard: 'M9 4h6v3H9zM9 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3M9 13l2 2 4-4',
  book: 'M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 2h13v-4M8 7h7M8 11h5',
  print: 'M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
};

export function icon(name, size = 18) {
  const fill = name === 'bolt' || name === 'play';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`;
}

// Wraps a password <input> with an eye button that reveals it (hidden by default).
export function passwordField(input) {
  const toggle = el('button', {
    type: 'button', class: 'pw-toggle', 'aria-label': 'Show password', 'aria-pressed': 'false',
    html: icon('eye', 16),
    onmousedown: (e) => e.preventDefault(), // keep focus and caret in the input
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.innerHTML = icon(show ? 'eyeOff' : 'eye', 16);
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(show));
    },
  });
  return el('div', { class: 'pw-field' }, input, toggle);
}

// --- motion ---

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The in-app "Reduced motion" setting is the single switch for animations.
export function motionOK() {
  return document.documentElement.dataset.motion !== 'reduced';
}

// --- toast ---

export function toast(message, type = 'info', ms = 3400) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const t = el('div', { class: `toast ${type}`, role: 'status', text: message });
  root.append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, ms);
}

// --- modal ---

export function openModal({ title, content, actions = [], onClose } = {}) {
  const root = document.getElementById('modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', keyHandler);
    if (onClose) onClose();
    if (!motionOK()) { overlay.remove(); return; }
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 170);
  };
  const keyHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  const actionEls = actions.map((a) =>
    el('button', {
      class: `btn ${a.class || ''}`,
      onclick: () => { if (a.onClick) a.onClick(close); else close(); },
    }, a.label));
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    title ? el('h3', { text: title }) : null,
    content,
    actionEls.length ? el('div', { class: 'modal-actions' }, actionEls) : null);
  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  }, modal);
  document.addEventListener('keydown', keyHandler);
  window.addEventListener('recall:route-leave', close, { once: true }); // don't outlive the page
  root.append(overlay);
  const focusable = modal.querySelector('input, textarea, select, button');
  if (focusable) focusable.focus();
  return { close, modal };
}

// --- formatting ---

export function relTime(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 45e3) return 'just now';
  if (diff < 3600e3) return `${Math.max(1, Math.round(diff / 60e3))}m ago`;
  if (diff < 86400e3) return `${Math.round(diff / 3600e3)}h ago`;
  return `${Math.round(diff / 86400e3)}d ago`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${String(mins % 60).padStart(2, '0')}m`;
}

export function fmtSecs(ms) {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// --- markdown-lite ---
// Escape HTML first, then transform **bold**, *italic*, __underline__, `code`.

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function mdInline(text) {
  let h = escapeHtml(text);
  h = h.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/__([^_]+)__/g, '<u>$1</u>');
  // bold is consumed first, so remaining single stars are italics
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return h;
}

export function mdBlocks(text) {
  return String(text ?? '').split(/\n{2,}|\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${mdInline(line)}</p>`)
    .join('');
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

export function skeleton(height = 60, width = '100%') {
  return el('div', { class: 'skeleton', style: `height:${height}px;width:${width}` });
}

// Chip-ified tag editor: Enter/comma commits, Backspace pops, click × removes.
export function tagsInput(initial = []) {
  const tags = [...initial];
  const input = el('input', { type: 'text', placeholder: tags.length ? '' : 'add tag…' });
  const box = el('div', { class: 'tags-input', onclick: () => input.focus() });

  function draw() {
    box.innerHTML = '';
    for (const t of tags) {
      box.append(el('span', { class: 'tag-chip' }, `#${t}`,
        el('button', {
          type: 'button', 'aria-label': `remove ${t}`, text: '×',
          onclick: (e) => { e.stopPropagation(); tags.splice(tags.indexOf(t), 1); draw(); },
        })));
    }
    box.append(input);
  }

  function commit() {
    const v = input.value.trim().replace(/^#/, '').replace(/\s+/g, '-');
    if (v && !tags.includes(v)) { tags.push(v); draw(); }
    input.value = '';
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); }
  });
  input.addEventListener('blur', commit);
  draw();
  return { node: box, getTags: () => [...tags], clear: () => { tags.length = 0; draw(); } };
}
