/**
 * 토큰 수량을 K / M 단위 축약 문자열로 포맷
 * @author Jangsung
 * @param {Number} n
 * @return {String}
 */
export function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

/**
 * ISO 또는 ms 타임스탬프를 로컬 YYYY-MM-DD 키로 변환
 * @author Jangsung
 * @param {String|Number} ts
 * @return {String}
 */
export function toLocalDateKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 소요 시간(ms)을 한국어 기간 문자열(일/시간/분)로 변환
 * @author Jangsung
 * @param {Number} durationMs
 * @return {String}
 */
export function formatDuration(durationMs) {
  const ms = Math.max(0, Number(durationMs) || 0);
  if (ms < 60 * 1000) return '1분 미만';
  const totalMin = Math.floor(ms / (60 * 1000));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) {
    return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  }
  return `${mins}분`;
}

/**
 * ISO 타임스탬프를 짧은 로컬 날짜·시각(MM/DD HH:mm 또는 YYYY-MM-DD HH:mm)으로 포맷
 * @author Jangsung
 * @param {String|Number} ts
 * @param {Boolean} includeYear
 * @return {String}
 */
export function formatLocalDateTime(ts, includeYear = false) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '-';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return includeYear ? `${y}-${m}-${day} ${hh}:${mm}` : `${m}/${day} ${hh}:${mm}`;
}

/**
 * 시작~종료 시각과 소요 시간을 한 줄 범위 문자열로 포맷
 * @author Jangsung
 * @param {String|null} startIso
 * @param {String|null} endIso
 * @param {Number} durationMs
 * @param {Boolean} includeYear
 * @return {String}
 */
export function formatPeriodRange(startIso, endIso, durationMs = 0, includeYear = false) {
  if (!startIso && !endIso) return '-';
  const s = startIso || endIso;
  const e = endIso || startIso;
  const sStr = formatLocalDateTime(s, includeYear);
  const sameDay = toLocalDateKey(s) && toLocalDateKey(s) === toLocalDateKey(e);
  const eDate = new Date(e);
  const eStr = sameDay && Number.isFinite(eDate.getTime())
    ? `${String(eDate.getHours()).padStart(2, '0')}:${String(eDate.getMinutes()).padStart(2, '0')}`
    : formatLocalDateTime(e, includeYear);
  const calcDur = durationMs > 0
    ? durationMs
    : Math.max(0, new Date(e).getTime() - new Date(s).getTime());
  return `${sStr} ~ ${eStr} (${formatDuration(calcDur)})`;
}
