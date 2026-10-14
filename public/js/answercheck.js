// Instant answer checker for practice tests. Forgiving on purpose: ignores
// case, punctuation, markdown, leading articles and small typos, accepts any
// listed alternative ("colour / color"), and falls back to key-word overlap
// for long answers. Verdicts are suggestions; the user can always override.
//
// checkAnswer(given, expected) -> { correct: bool, reason: string, sure: bool }

const ARTICLES = /^(the|a|an|to|el|la|los|las|le|les|un|une|der|die|das)\s+/;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was',
  'were', 'is', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'an', 'a', 'it', 'its', 'be', 'as']);

function base(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\*\*|__|`|\*/g, '')
    .replace(/(\d)[, ](?=\d{3}\b)/g, '$1')
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s) {
  return base(s).replace(ARTICLES, '');
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

// "Paris (France)" -> ["Paris (France)", "Paris"]; "colour / color; hue" -> each part.
function alternatives(expected) {
  const raw = String(expected ?? '');
  const out = new Set([raw]);
  const noParens = raw.replace(/\([^)]*\)/g, ' ').trim();
  if (noParens) out.add(noParens);
  for (const src of [raw, noParens]) {
    for (const part of src.split(/\s*(?:\/|;|\||\bor\b)\s*/i)) if (part.trim()) out.add(part.trim());
  }
  return [...out].map(norm).filter(Boolean);
}

function compareShort(given, alt) {
  if (given === alt) return { correct: true, reason: 'Exact match', sure: true };
  const ga = stripAccents(given);
  const aa = stripAccents(alt);
  if (ga === aa) return { correct: true, reason: 'Correct — check your accents', sure: true };
  // Word order doesn't matter for short lists like "red, green".
  const sortWords = (s) => s.split(' ').sort().join(' ');
  if (sortWords(ga) === sortWords(aa)) return { correct: true, reason: 'Correct (different order)', sure: true };
  const sim = similarity(ga, aa);
  const tolerance = aa.length <= 3 ? 1 : aa.length <= 6 ? 0.8 : 0.85;
  if (aa.length > 3 && sim >= tolerance) return { correct: true, reason: 'Close enough — minor typo', sure: false };
  // "Shakespeare" for "William Shakespeare": nothing extra, and most of the answer.
  const altWords = aa.split(' ');
  if (ga.split(' ').every((w) => altWords.includes(w)) && ga.length / aa.length >= 0.5) {
    return { correct: true, reason: 'Partial match — double-check', sure: false };
  }
  return { correct: false, reason: 'Doesn’t match', sure: sim < 0.5, sim };
}

function keywords(s) {
  return stripAccents(norm(s)).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
}

export function checkAnswer(given, expected) {
  const g = norm(given);
  if (!g) return { correct: false, reason: 'No answer', sure: true };

  let best = null;
  for (const alt of alternatives(expected)) {
    const r = compareShort(g, alt);
    if (r.correct) return r;
    if (!best || (r.sim ?? 0) > (best.sim ?? 0)) best = r;
  }

  // Long answers: count how many of the key words the user got.
  const keys = [...new Set(keywords(expected))];
  if (keys.length >= 4) {
    const words = keywords(given);
    const hit = keys.filter((k) => words.some((w) => w === k || (k.length > 4 && similarity(w, k) >= 0.8))).length;
    const ratio = hit / keys.length;
    if (ratio >= 0.6) {
      return { correct: true, reason: `Covers ${hit} of ${keys.length} key words — double-check`, sure: false };
    }
    return { correct: false, reason: `Only ${hit} of ${keys.length} key words`, sure: ratio < 0.3 };
  }
  return { correct: false, reason: best ? best.reason : 'Doesn’t match', sure: best ? best.sure : true };
}
