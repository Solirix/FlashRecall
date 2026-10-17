// Fuzzy matcher shared by the command palette (browser) and the search engine
// (server, via require()). Case- and accent-insensitive, tolerant of typos and
// half-typed words, and reports match ranges in the ORIGINAL string so callers
// can highlight without re-deriving offsets.
//
// terms(query)                 -> folded query words
// prepare(text)                -> { orig, folded, map } (reusable across queries)
// scoreFields(qterms, fields)  -> { score, ranges: [[s, e]...][] } | null  (every term must hit)
// scoreText(query, text)       -> { score, ranges } | null
// highlight(qterms, text)      -> [[s, e]...] for whichever terms hit (no all-terms rule)
// parts(text, ranges)          -> [{ text, hit }] for rendering

const MARKS = /\p{M}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const WORDS = /[\p{L}\p{N}]+/gu;
const ASCII = /^[\x00-\x7f]*$/;

export function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(MARKS, '').toLowerCase();
}

export function terms(query) {
  const seen = new Set();
  for (const t of fold(query).split(/\s+/)) if (t) seen.add(t);
  return [...seen];
}

// Folded copy of `text` plus, for non-ASCII input, a map from each folded index
// back to its source index (with a sentinel at folded.length).
export function prepare(text) {
  const orig = String(text ?? '');
  if (ASCII.test(orig)) return { orig, folded: orig.toLowerCase(), map: null };
  let folded = '';
  const map = [];
  for (let i = 0; i < orig.length;) {
    const code = orig.charCodeAt(i);
    if (code < 0x80) {
      folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : orig[i];
      map.push(i);
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(orig.codePointAt(i));
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(orig.length);
  return { orig, folded, map };
}

const isWord = (c) => c !== undefined && WORD_CHAR.test(c);

// Optimal string alignment distance, bailing out once it must exceed `max`.
// Three rolling rows reused across calls: this runs for every word of every
// typo-pass candidate, so it must not allocate.
let rowA = new Int32Array(64);
let rowB = new Int32Array(64);
let rowC = new Int32Array(64);
function osa(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length + 1;
  if (rowA.length < n) { rowA = new Int32Array(n * 2); rowB = new Int32Array(n * 2); rowC = new Int32Array(n * 2); }
  let prev2 = rowA;
  let prev = rowB;
  let cur = rowC;
  for (let j = 0; j < n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j < n; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = prev[j - 1] + (ai === bj ? 0 : 1);
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj && prev2[j - 2] + 1 < v) {
        v = prev2[j - 2] + 1;
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}

const maxEdits = (q) => (q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0);

// Is folded word `w` a typo of folded term `q` (whole word, or a prefix of a
// word still being typed)? -> { score: 0.55-0.8, len } | null. Exact equality
// is the caller's job.
export function nearWord(q, w, max = maxEdits(q)) {
  if (!max || w.length + max < q.length) return null;
  const d = osa(q, w, max);
  if (d <= max) return { score: 0.8 - 0.15 * (d - 1), len: w.length };
  let best = null;
  for (let k = Math.max(q.length - 1, 1); k <= q.length + 1 && k < w.length; k++) {
    const dp = osa(q, w.slice(0, k), max);
    if (dp <= max && (!best || 0.7 - 0.15 * (dp - 1) > best.score)) best = { score: 0.7 - 0.15 * (dp - 1), len: k };
  }
  return best;
}

// Best match of one folded term in a prepared text, in folded coordinates.
// Score bands: exact substring >= 1, typo 0.55-0.8, subsequence 0.3-0.65.
function matchTerm(q, p, subseq) {
  const t = p.folded;
  let best = null;

  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) {
    const atStart = !isWord(t[i - 1]);
    const atEnd = !isWord(t[i + q.length]);
    const s = 1 + (atStart ? 0.15 : 0) + (atStart && atEnd ? 0.1 : 0) - Math.min(i, 400) / 8000;
    if (!best || s > best.score) best = { score: s, ranges: [[i, i + q.length]] };
    if (atStart && atEnd) break;
  }
  if (best) return best;

  const max = maxEdits(q);
  if (max && !/\s/.test(q)) {
    for (const m of t.matchAll(WORDS)) {
      const near = nearWord(q, m[0], max);
      if (near && (!best || near.score > best.score)) {
        best = { score: near.score, ranges: [[m.index, m.index + near.len]] };
      }
    }
    if (best) return best;
  }

  if (subseq && q.length >= 2 && t.length <= 600) {
    // fzf-ish: starts on a word boundary, rewards compact spans and word-start hits
    for (let i = t.indexOf(q[0]); i !== -1; i = t.indexOf(q[0], i + 1)) {
      if (isWord(t[i - 1])) continue;
      const ranges = [[i, i + 1]];
      let pos = i + 1;
      let starts = 1;
      let ok = true;
      for (let k = 1; k < q.length; k++) {
        const at = t.indexOf(q[k], pos);
        if (at === -1) { ok = false; break; }
        if (!isWord(t[at - 1])) starts += 1;
        const last = ranges[ranges.length - 1];
        if (last[1] === at) last[1] = at + 1;
        else ranges.push([at, at + 1]);
        pos = at + 1;
      }
      if (!ok) break;
      const span = pos - i;
      if (span > q.length * 4) continue;
      const s = 0.3 + 0.25 * (q.length / span) + 0.1 * (starts / q.length);
      if (!best || s > best.score) best = { score: s, ranges };
    }
  }
  return best;
}

function toOrig(p, ranges) {
  if (!p.map) return ranges;
  return ranges.map(([s, e]) => [p.map[s], p.map[e] ?? p.orig.length]);
}

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const asPrepared = (x) => (typeof x === 'string' ? prepare(x) : x);

// fields: [{ text | prepared, weight? }]. Every term must match some field.
export function scoreFields(qterms, fields, { subseq = false, min = 0.3 } = {}) {
  if (!qterms.length) return null;
  const prepared = fields.map((f) => ({ p: asPrepared(f.prepared || f.text || ''), w: f.weight ?? 1 }));
  const ranges = prepared.map(() => []);
  let total = 0;
  for (const q of qterms) {
    let best = null;
    let bestField = -1;
    prepared.forEach(({ p, w }, idx) => {
      const m = matchTerm(q, p, subseq);
      if (m && m.score * w > (best ? best.score : 0)) { best = { ...m, score: m.score * w }; bestField = idx; }
    });
    if (!best || best.score < min) return null;
    total += best.score;
    ranges[bestField].push(...toOrig(prepared[bestField].p, best.ranges));
  }
  return { score: total / qterms.length, ranges: ranges.map(merge) };
}

export function scoreText(query, text, opts) {
  const qterms = Array.isArray(query) ? query : terms(query);
  const r = scoreFields(qterms, [{ text }], opts);
  return r && { score: r.score, ranges: r.ranges[0] };
}

export function highlight(qterms, text, { subseq = false } = {}) {
  const p = asPrepared(text);
  const out = [];
  for (const q of qterms) {
    const m = matchTerm(q, p, subseq);
    if (m) out.push(...toOrig(p, m.ranges));
  }
  return merge(out);
}

export function parts(text, ranges) {
  const out = [];
  let at = 0;
  for (const [s, e] of ranges || []) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
