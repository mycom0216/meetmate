// ─────────────────────────────────────────────────────────────────────────────
// dates.mjs — "다음 주 금요일까지", "내일까지", "12월 5일까지" 같은 기한 표현을 실제 날짜(YYYY-MM-DD)로 바꿉니다
//
// [왜 LLM이 아니라 직접 계산하나]
//   날짜 계산은 LLM이 자주 틀리고(요일·월말), 틀려도 그럴듯해 보입니다. 규칙으로 계산하면
//   ① 항상 같은 결과(재현성) ② 테스트로 검증 가능 ③ 회의 날짜(heldAt)만 정확하면 틀릴 일이 없습니다.
//   LLM이 기한을 "말해도" 쓰지 않고, 근거 문장에서 여기서 다시 계산한 값만 저장합니다.
//
// [주의: 시간대(Timezone) 함정]
//   new Date('2026-12-01')은 UTC 자정이라 한국에서 날짜가 하루 어긋날 수 있습니다.
//   그래서 모든 계산을 Date.UTC 기반(시간대 영향 없음)으로 하고, 문자열로만 주고받습니다.
//
// [주의: "기한"으로 인정하는 조건]
//   "오늘 회의는 여기까지"의 '오늘'을 기한으로 오인하면 안 됩니다. 날짜 표현 뒤에
//   '까지·중으로·안으로·이내·전에' 같은 마감 표지가 붙어야 기한으로 봅니다.
// ─────────────────────────────────────────────────────────────────────────────
const DAY = 86400000;
const WD = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 0 }; // JS getUTCDay 기준(일요일=0)

export const parseISO = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(s ?? ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  // 2월 30일 같은 존재하지 않는 날짜는 Date가 3월로 넘겨 버리므로, 되돌려 비교해 걸러냅니다.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
};
export const fmt = (t) => new Date(t).toISOString().slice(0, 10);
export const isValidDate = (s) => parseISO(s) != null;

// 그 주의 월요일(주는 월~일). "이번 주 금요일"은 월요일 + 4일.
const mondayOf = (t) => { const wd = new Date(t).getUTCDay(); return t - ((wd + 6) % 7) * DAY; };
const MARK = '(?:까지|까지는|중으로|중에|안으로|안에|이내|전까지|전에)'; // 마감 표지

// 기한 표현을 찾습니다. 반환: { iso, expr } 또는 null. heldAt은 'YYYY-MM-DD'.
export function findDue(sentence, heldAt) {
  const base = parseISO(heldAt);
  if (base == null) return null;
  const s = String(sentence ?? '');
  let m;
  const out = (t, expr) => ({ iso: fmt(t), expr: expr.trim() });

  // 1) 이번/다음 주 + 요일: "다음 주 월요일까지"
  if ((m = new RegExp(`(이번|다음)\\s*주\\s*(월|화|수|목|금|토|일)요일\\s*${MARK}`, 'u').exec(s))) {
    return out(mondayOf(base) + (m[1] === '다음' ? 7 : 0) * DAY + ((WD[m[2]] + 6) % 7) * DAY, m[0]);
  }
  // 2) "이번 주 안으로/이번 주 중으로" → 그 주 금요일(업무일 기준)
  if ((m = /이번\s*주\s*(?:안으로|안에|중으로|중에|내로|내에)/u.exec(s))) return out(mondayOf(base) + 4 * DAY, m[0]);
  // 3) 절대 날짜: "12월 5일까지" (지난 달이면 다음 해로 봅니다)
  if ((m = new RegExp(`(\\d{1,2})월\\s*(\\d{1,2})일\\s*(?:\\S{0,3}요일)?\\s*${MARK}`, 'u').exec(s))) {
    const y = new Date(base).getUTCFullYear();
    let t = Date.UTC(y, +m[1] - 1, +m[2]);
    if (parseISO(fmt(t)) == null || new Date(t).getUTCMonth() !== +m[1] - 1) return null; // 13월·2월 30일 등
    if (t < base - 30 * DAY) t = Date.UTC(y + 1, +m[1] - 1, +m[2]);
    return out(t, m[0]);
  }
  // 4) 오늘/내일/모레 (+마감 표지)
  if ((m = new RegExp(`(오늘|내일|모레)\\s*${MARK}`, 'u').exec(s))) {
    return out(base + ({ 오늘: 0, 내일: 1, 모레: 2 })[m[1]] * DAY, m[0]);
  }
  // 5) 요일만: "금요일까지" → 회의 다음날부터 처음 오는 그 요일
  if ((m = new RegExp(`(월|화|수|목|금|토|일)요일\\s*${MARK}`, 'u').exec(s))) {
    let t = base + DAY;
    while (new Date(t).getUTCDay() !== WD[m[1]]) t += DAY;
    return out(t, m[0]);
  }
  // 6) 이번 달 말
  if ((m = /이번\s*달\s*(?:말|말까지|안으로)/u.exec(s))) {
    const d = new Date(base);
    return out(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0), m[0]);
  }
  return null;
}
