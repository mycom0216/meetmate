// ─────────────────────────────────────────────────────────────────────────────
// text.mjs — 한국어 텍스트 처리 도구 모음 (정규화 · 토큰화 · 문장 분리 · 개인정보 마스킹)
//
// [왜 이 파일이 필요한가]
//   RAG(검색 증강 생성)의 첫 단계는 "검색"이고, 검색은 글자를 잘게 나눈 '토큰'으로 이루어집니다.
//   한국어는 "백엔드를/백엔드는/백엔드로"처럼 조사가 붙어 같은 단어가 다르게 보이므로
//   영어처럼 공백으로만 자르면 검색이 잘 안 됩니다.
//
// [왜 형태소 분석기를 쓰지 않았나]
//   외부 라이브러리(npm 패키지) 없이 Node.js 기본 기능만으로 실행되게 하려는 의도입니다.
//   (설치 오류·보안 취약점·라이선스 부담을 줄이고, 심사자가 `node server.mjs` 한 줄로 실행 가능)
//   대신 "어절 + 글자 2개씩 묶음(바이그램)"을 함께 써서 조사·어미 변화에 견디게 했습니다.
// ─────────────────────────────────────────────────────────────────────────────

// 어절 끝에 붙는 조사. 길이가 긴 것부터 적어야 "으로"가 "로"보다 먼저 매칭됩니다.
const JOSA = /(으로|에서|에게|까지|부터|이나|이랑|입니다|은|는|이|가|을|를|에|로|의|도|만|과|와|요)$/u;

// 유니코드 정규화(NFKC)로 전각/호환 문자를 통일하고, 소문자화·공백 정리를 합니다.
// 왜? "Python"과 "python", 전각 "ＡＩ"와 "AI"를 같은 글자로 취급하기 위해서입니다.
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

// 글자·숫자로 이루어진 덩어리(어절)만 뽑습니다. 특수문자는 버립니다. (C++ 같은 건 skills 사전에서 따로 처리)
export function words(text) {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// 질의(검색어)에서 뺄 군말. "직무 추천해줘"의 "추천해줘"는 검색 단서가 되지 못합니다.
export const FILLER = new Set([
  '알려줘', '알려주세요', '해줘', '해주세요', '어때', '어떻게', '되나요', '있나요', '궁금해요', '싶어요', '뭐야', '뭔가요',
  '설명해줘', '추천', '추천해줘', '좀', '혹시', '그냥', '정말', '진짜', '저', '제가', '저는', '나', '내가',
]);

// 조사를 떼어 어간만 남깁니다(2글자 이하는 오작동 위험이 커서 그대로 둠).
export const stem = (w) => (w.length > 2 ? w.replace(JOSA, '') : w);

// 토큰 종류를 접두어로 구분합니다: w:어간 / b:글자2개 / c:한글자
//   - w: 완전한 단어 일치 (정확도↑)
//   - b: 바이그램 (조사·오타·띄어쓰기 차이에 강함, 재현율↑)
export function tokens(text, { query = false } = {}) {
  const out = [];
  for (const w of words(text)) {
    if (query && FILLER.has(w)) continue;
    const st = stem(w);
    if (st.length >= 2) out.push('w:' + st);
    const chars = [...st];
    if (chars.length === 1) out.push('c:' + chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) out.push('b:' + chars[i] + chars[i + 1]);
  }
  return out;
}

// 문장 분리: 마침표/물음표/느낌표 뒤 공백, 또는 줄바꿈 기준.
// 이력서는 줄바꿈 글머리표가 많아서 줄바꿈도 문장 경계로 봅니다.
export function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?。])\s+|\n+/u)
    .map((s) => s.replace(/^[\s•\-*·▪■●○◦]+/u, '').trim())
    .filter((s) => s.length > 0);
}

// 개인정보 마스킹: 이력서에는 연락처·주민번호가 들어가기 쉽습니다.
// 저장·외부 LLM 전송 "전에" 가려야 유출 위험이 줄어듭니다(개인정보 최소수집 원칙).
// 반환: { masked: 가려진 텍스트, found: 찾은 종류 목록 }
export function maskPII(text) {
  const found = [];
  let masked = String(text ?? '');
  const rules = [
    // 순서 중요: 주민번호(13자리)를 전화번호 규칙보다 먼저 처리해야 일부만 잘리지 않습니다.
    ['주민등록번호', /\b\d{6}[- ]?[1-4]\d{6}\b/gu, '[주민번호]'],
    ['카드번호', /\b(?:\d{4}[- ]?){3}\d{4}\b/gu, '[카드번호]'],
    ['전화번호', /\b0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}\b/gu, '[전화번호]'],
    ['이메일', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, '[이메일]'],
  ];
  for (const [name, re, repl] of rules) {
    const next = masked.replace(re, repl);
    if (next !== masked) found.push(name);
    masked = next;
  }
  return { masked, found };
}
