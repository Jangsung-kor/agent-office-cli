/**
 * 브라우저 localStorage 안전 접근 유틸
 * @author Jangsung
 */

export function readStorage(key, fallback = '') {
  try {
    const val = localStorage.getItem(key);
    return val !== null && val !== undefined && val !== '' ? val : fallback;
  } catch (_) {
    return fallback;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (_) {}
}

export function readNumberStorage(key, fallback, min = -Infinity, max = Infinity) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
  } catch (_) {}
  return fallback;
}
