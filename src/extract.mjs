// ─────────────────────────────────────────────────────────────────────────────
// extract.mjs — 회의 대본에서 "결정 · 할 일 · 미결 사항 · 요약"을 뽑습니다 (이 프로젝트의 핵심 로직)
//
// [두 경로를 섞는 이유 — 면접 핵심]
//   ① 규칙 경로(rules): 한국어 회의 말투의 패턴("~하기로 했습니다", "~까지 ~해 주세요")으로 찾는다.
//        + 항상 동작, 결과 설명 가능, 원문 문장을 그대로 쓰므로 지어낼 수 없음   − 표현이 다양하면 놓침
//   ② LLM 경로: 모델이 문맥으로 찾는다. + 표현이 달라도 찾음   − 없는 말을 지어내거나 숫자·이름을 틀릴 수 있음
//   → LLM이 낸 항목은 "검증 관문(validateLLMItem)"을 통과한 것만 받고, 통과 못 하면 버립니다.
//      LLM이 없거나 전부 실패해도 규칙 경로 결과가 남아 서비스가 멈추지 않습니다.
//
// [환각(없는 말 지어내기) 방지 4종 — 모든 항목에 적용]
//   1) 근거 구간 필수: 항목은 반드시 대본의 한 구간(seg)을 가리킨다. 가리키는 구간이 없으면 폐기.
//   2) 근거 일치: 항목 문장의 글자 조각(바이그램)이 그 구간과 충분히 겹쳐야 한다(엉뚱한 문장 폐기).
//   3) 새 숫자 금지: 항목에 있는 숫자는 근거 구간에도 있어야 한다("3일"→"30일" 같은 변조 차단).
//   4) 기한·담당자는 코드가 다시 계산/확인: 기한은 dates.mjs가 근거 문장에서 계산, 담당자는 참석자 이름과 대조.
//
// [분류 우선순위] 할 일(action) > 결정(decision) > 미결(issue)
//   "제가 내일까지 ~하기로 했습니다"처럼 겹치면 실행 책임이 있는 쪽(할 일)이 더 쓸모 있기 때문입니다.
// ─────────────────────────────────────────────────────────────────────────────
import { sentences, tokens, words, stem } from './text.mjs';
import { findDue } from './dates.mjs';

// ── 규칙 패턴 ──────────────────────────────────────────────────────────────
// 요청형: "~해 주세요", "~ 부탁드립니다" → 다른 사람에게 일을 맡기는 말
const REQUEST = /주\s*(?:세요|십시오|시겠어요|실래요|시기 바랍니다)|주시면\s*(?:좋겠|감사)|으면\s*좋겠|부탁\s*(?:드립니다|드려요|드릴게요|해요|합니다)/u;
// 약속형: "~하겠습니다", "~할게요", "~할 예정입니다" → 자기가 하겠다는 말
const COMMIT = /겠습니다|(?<!좋)겠어요|[가-힣]게요|할 예정/u; // '[가-힣]게요' = 할게요·올릴게요·맡을게요 처럼 'ㄹ게요' 계열을 한꺼번에
// 약속형이 "내 할 일"이 되려면 일인칭 주어가 있거나 기한이 있어야 합니다.
// ("진행 상황부터 공유하겠습니다", "오늘 회의는 여기까지 하겠습니다" 같은 진행 멘트를 걸러내기 위함)
const FIRST_PERSON = /(?:제가|저는|저도|내가|나는|제가 먼저)\s/u;
// 진행 멘트에 쓰이는 동사(주어가 '제가'여도 일이 아님): "저는 이만 마치겠습니다"
// ("초안을 마무리하겠습니다"는 일이고, "오늘 회의는 여기서 마무리하겠습니다"는 진행 멘트이므로 '회의·여기·이만' 같은 말이 함께 있을 때만 진행 멘트로 봅니다)
const CLOSING = /(?:회의|여기|이만|이상으로)[^.]*?(?:마치겠|마무리하겠|끝내겠|종료하겠)|마치겠습니다|시작하겠|넘어가겠|나가보겠|들어가겠/u;
const DECISION = /(?:결정|확정|합의)\s*(?:했|합니다|하겠|합시다|하자|됐|되었|하였)|기로\s*(?:했|하였|정했|결정|합의|하겠)|로\s*(?:정했|정하|정합)|(?:걸로|것으로)\s*(?:하|가|합|갑|정)|다음\s*(?:회의|미팅|모임)(?:은|는)/u;
// 미결: 아직 정해지지 않았거나 논의·확인이 더 필요하다는 말. (물음표만으로는 판단하지 않음: "점심 뭐 드실래요?"도 물음표)
const ISSUE = /(?:논의|검토|협의|확인|확정|결정)(?:이|가)?\s*(?:더\s*)?(?:필요|안\s*(?:됐|되었)|되지\s*않)|아직\s*(?:미정|정해지지|정해지|확정|협의되지|결정되지|정해진)|미정(?:입니다|이에요|이야)|어떻게\s*(?:할지|할까|해야)|할지\s*(?:논의|정해|모르|고민)|가능(?:한가요|할까요|할지)|걱정(?:입니다|이에요|돼요|됩니다)|(?:문제|걱정|우려|리스크|위험)(?:가|이|는|예요|입니다|네요)|몰라요|모르겠|못\s*(?:구했|정했|찾았|끝냈)|봐야\s*(?:해요|합니다|할 것|겠)|정해야\s*(?:합니다|해요|할)|어렵습니다/u;

const NAME = /([\p{Script=Hangul}]{2,4})\s*(?:님|씨)(?:은|는|이|가|께서|께)?/u;

// 참석자 목록(화자 이름)에서 "유나"가 "최유나"를 가리키는지 찾습니다. 성을 뗀 이름(2글자)도 인정.
export function participantsOf(segments) {
  return [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
}
export function resolveName(raw, participants) {
  const n = String(raw ?? '').trim();
  if (!n) return null;
  const hit = participants.find((p) => p === n) ?? participants.find((p) => p.length > n.length && p.endsWith(n)) ?? participants.find((p) => n.length > p.length && n.endsWith(p));
  return hit ?? null;
}

// 한 문장에 대해 종류를 판정합니다. 반환: { kind, owner, due } 또는 null
export function classifySentence(sentence, { speaker, participants, heldAt }) {
  const due = findDue(sentence, heldAt);
  const asks = REQUEST.test(sentence);
  const commits = COMMIT.test(sentence) && !CLOSING.test(sentence);
  const meFirst = FIRST_PERSON.test(sentence + ' ');
  let kind = null, owner = null;
  if (asks) {
    kind = 'action';
    const m = NAME.exec(sentence);
    owner = m ? resolveName(m[1], participants) ?? m[1] : null; // 참석자에 없는 이름이면 말한 그대로(대본에 나온 이름)
  } else if (commits && (meFirst || due)) {
    kind = 'action';
    owner = speaker ?? null; // "제가 ~하겠습니다" → 말한 사람이 담당
  } else if (DECISION.test(sentence)) kind = 'decision';
  else if (ISSUE.test(sentence)) kind = 'issue';
  return kind ? { kind, owner, due: kind === 'action' ? due : null } : null;
}

// ── 규칙 경로 ───────────────────────────────────────────────────────────────
export function extractByRules(segments, { heldAt }) {
  const participants = participantsOf(segments);
  const items = [];
  for (const seg of segments) {
    for (const sent of sentences(seg.text)) {
      const c = classifySentence(sent, { speaker: seg.speaker, participants, heldAt });
      if (!c) continue;
      items.push({ kind: c.kind, text: sent, owner: c.owner, due: c.due?.iso ?? null, dueExpr: c.due?.expr ?? null, segIdx: seg.idx, method: 'rule' });
    }
  }
  return mergeSameSegmentActions(dedupe(items));
}

// 한 발언에 "제가 맡을게요. 수요일까지 초안 올리겠습니다."처럼 같은 일을 두 문장으로 말하면 할 일이 2건으로 잡힙니다.
// 같은 구간에 기한이 있는 할 일이 있으면, 기한·담당이 겹치는 '기한 없는' 할 일은 그쪽에 합칩니다(중복 방지).
function mergeSameSegmentActions(items) {
  return items.filter((it) => !(it.kind === 'action' && !it.due && items.some((o) => o !== it && o.kind === 'action' && o.segIdx === it.segIdx && o.due && (!it.owner || !o.owner || it.owner === o.owner))));
}

// 같은 구간·같은 종류의 중복을 제거합니다(문장이 둘 다 매칭될 때).
function dedupe(items) {
  const seen = new Set(), out = [];
  for (const it of items) {
    const key = `${it.kind}|${it.segIdx}|${it.text}`;
    if (!seen.has(key)) { seen.add(key); out.push(it); }
  }
  return out;
}

// ── 요약(추출식) ────────────────────────────────────────────────────────────
// 추출식 요약 = 원문에서 중요한 문장을 "골라서" 보여 주기. 새 문장을 쓰지 않으므로 지어낼 수 없습니다.
// 중요도 = 문장 속 희귀한 단어(IDF)가 많을수록 높게 + 너무 짧은 인사말·진행 멘트는 제외.
const SMALLTALK = /^(?:네|예|아|음|그래요|알겠습니다|감사합니다|수고|안녕)|수고하셨|마치겠습니다|마무리하겠습니다|여기까지|여기서 마무리/u;
export function summarizeByRules(segments, items, { maxSentences = 3 } = {}) {
  const sents = [];
  for (const seg of segments) for (const s of sentences(seg.text)) sents.push({ s, seg: seg.idx });
  const df = new Map();
  for (const { s } of sents) for (const t of new Set(words(s).map(stem))) df.set(t, (df.get(t) ?? 0) + 1);
  const N = Math.max(1, sents.length);
  const covered = new Set(items.map((i) => i.text)); // 이미 결정·할 일로 따로 보여 주는 문장은 요약에서 제외(중복 방지)
  const scored = sents
    .filter(({ s }) => s.length >= 12 && !SMALLTALK.test(s) && !covered.has(s))
    .map(({ s, seg }) => {
      const ws = [...new Set(words(s).map(stem))].filter((w) => w.length >= 2);
      const score = ws.reduce((sum, w) => sum + Math.log(1 + N / (df.get(w) ?? 1)), 0) / Math.sqrt(ws.length || 1);
      return { s, seg, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.seg - b.seg); // 보여 줄 때는 회의에서 나온 순서대로
  const n = (k) => items.filter((i) => i.kind === k).length;
  const head = `결정 ${n('decision')}건 · 할 일 ${n('action')}건 · 미결 ${n('issue')}건`;
  return { body: [head, ...scored.map((x) => `- ${x.s}`)].join('\n'), method: 'rule' };
}

// ── LLM 경로 ────────────────────────────────────────────────────────────────
const SYSTEM = `당신은 한국어 회의록 정리 도우미입니다. 번호가 붙은 회의 대본에서 아래 세 가지만 찾아 JSON 배열로만 답하세요.
- decision: 회의에서 결정·합의·확정된 것
- action: 누군가 해야 할 일(요청받았거나 하겠다고 말한 일)
- issue: 아직 결정되지 않았거나 더 논의·확인이 필요한 것
규칙: 대본에 없는 내용·숫자·이름을 절대 만들지 마세요. 인사말·잡담·진행 상황 보고는 제외하세요.
형식: [{"kind":"decision|action|issue","seg":구간번호,"text":"대본 표현을 살린 한 문장","owner":"담당자 이름 또는 null"}]
해당 항목이 없으면 [] 만 답하세요. JSON 외의 설명은 쓰지 마세요.`;

// 글자 2개 조각(바이그램) 집합. 근거 일치도 계산용.
const bigrams = (t) => { const c = [...String(t).normalize('NFKC').replace(/[\s\p{P}]+/gu, '')]; const s = new Set(); for (let i = 0; i + 1 < c.length; i++) s.add(c[i] + c[i + 1]); return s; };
export const overlap = (a, b) => { const A = bigrams(a); if (!A.size) return 0; const B = bigrams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / A.size; };
const numbersOf = (t) => (String(t).normalize('NFKC').match(/\d+(?:\.\d+)?/gu) ?? []);


// ── AI 항목 "단서 관문" ─────────────────────────────────────────────────────
// [왜 필요한가 — 측정으로 발견한 약점]
//   근거 일치(문장이 대본과 같은가)만 검사하면, 작은 모델이 "오늘 날씨 진짜 좋다"·"수고하셨습니다" 같은 잡담을
//   "할 일/미결"로 분류해도 통과합니다(문장은 대본에 실제로 있으니까). "근거가 있다 ≠ 분류가 맞다".
//   그래서 AI가 고른 문장이 그 종류에 맞는 "말투 단서"를 실제로 갖고 있는지 한 번 더 확인합니다.
//   → AI(의미 판단)와 단서(문장 모양)가 "둘 다" 동의할 때만 채택하는 AND 구조입니다.
// [규칙 경로와 다른 점] 규칙은 단서만으로 확정하므로 아주 엄격하게, 여기서는 AI가 먼저 걸러 주므로 단서를 넓게 잡아 재현율을 얻습니다.
// [재분류] AI가 '결정'이라 했는데 문장은 '확인해 봐야 해요'처럼 미결 단서만 있으면 미결로 고칩니다(문장 모양이 더 믿을 만함).
const CUE_REQUEST = /주\s*(?:세요|십시오|시겠어요|실래요|시면)|부탁|맡아|담당/u;
const CUE_COMMIT = /겠습니다|겠어요|[가-힣]게요|할 예정|할 거예요|하려고 합니다/u;
const CUE_MUST = /해야\s*(?:합니다|해요|할|돼요|됩니다)/u;
const CUE_DECISION = /결정|확정|합의|정했|정하겠|정합|기로|걸로|것으로|방향으로|(?:으)?로\s*(?:하|가|진행|합)|합시다|진행합니다|진행하겠|유지/u;
const CUE_ISSUE = /걱정|문제|모르|못\s|미정|필요|해야|봐야|가능|확인|논의|검토|협의|아직|어떻게|언제|누가|무엇|왜|리스크|위험|불확실|애매|정해지|정해진/u;
export function cueKinds(sentence, { speaker, participants, heldAt }) {
  const out = [];
  const due = findDue(sentence, heldAt);
  const named = NAME.test(sentence);
  if (CUE_REQUEST.test(sentence) || ((CUE_COMMIT.test(sentence) || CUE_MUST.test(sentence)) && (FIRST_PERSON.test(sentence + ' ') || due || named))) out.push('action');
  if (CUE_DECISION.test(sentence) && !/정해야|정하지|정할지|결정하지/u.test(sentence)) out.push('decision');
  if (CUE_ISSUE.test(sentence) || /\?\s*$/u.test(sentence)) out.push('issue');
  return out;
}

// LLM이 만든 항목 1개를 검증합니다. 통과하면 정제된 항목, 아니면 null(+ 사유는 reasons로 집계).
export function validateLLMItem(raw, { segments, participants, heldAt, reasons = {} }) {
  const bad = (why) => { reasons[why] = (reasons[why] ?? 0) + 1; return null; };
  if (!raw || typeof raw !== 'object') return bad('형식');
  const kind0 = ['decision', 'action', 'issue'].includes(raw.kind) ? raw.kind : null;
  if (!kind0) return bad('종류');
  const idx = Number(raw.seg);
  const seg = Number.isInteger(idx) ? segments[idx] : null;
  if (!seg) return bad('근거 구간 없음');
  const text = String(raw.text ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length < 4 || text.length > 200) return bad('길이');
  if (overlap(text, seg.text) < 0.5) return bad('근거 불일치');
  const have = new Set(numbersOf(seg.text));
  if (numbersOf(text).some((n) => !have.has(n))) return bad('새 숫자');
  // 담당자: 참석자 이름과 대조해 확인된 것만 사용(없으면 규칙이 구한 값/말한 사람을 씁니다)
  let owner = resolveName(raw.owner, participants);
  const sentence = sentences(seg.text).find((s) => overlap(s, text) >= 0.4) ?? seg.text;
  // 단서 관문: AI가 고른 종류에 맞는 말투 단서가 없으면 문장 모양으로 종류를 다시 정하고, 어느 것에도 안 맞으면 폐기
  const cues = cueKinds(sentence, { speaker: seg.speaker, participants, heldAt });
  let kind = kind0;
  if (!cues.includes(kind0)) { if (!cues.length) return bad('단서 없음'); kind = cues[0]; reasons['재분류'] = (reasons['재분류'] ?? 0) + 1; }
  const due = kind === 'action' ? findDue(sentence, heldAt) ?? findDue(seg.text, heldAt) : null; // 기한은 항상 코드로 다시 계산
  if (kind === 'action' && !owner) {
    const c = classifySentence(sentence, { speaker: seg.speaker, participants, heldAt });
    owner = c?.owner ?? null;
  }
  return { kind, text, owner, due: due?.iso ?? null, dueExpr: due?.expr ?? null, segIdx: seg.idx, method: 'llm' };
}

// 모델 답변에서 JSON 배열을 꺼냅니다. 코드블록·앞뒤 설명이 섞여도 첫 '['부터 짝이 맞는 ']'까지 읽습니다.
export function parseJsonArray(text) {
  const s = String(text ?? '');
  const start = s.indexOf('[');
  if (start < 0) return null;
  for (let end = s.lastIndexOf(']'); end > start; end = s.lastIndexOf(']', end - 1)) {
    try { const v = JSON.parse(s.slice(start, end + 1)); if (Array.isArray(v)) return v; } catch { /* 더 짧게 */ }
  }
  return null;
}

// 대본을 창(window)으로 나눠 LLM에 보냅니다. 작은 모델은 긴 글에서 번호를 놓치므로 한 번에 ~2,500자씩.
export function windows(segments, maxChars = 2500) {
  const out = []; let cur = [], len = 0;
  for (const s of segments) {
    const line = `[${s.idx}] ${s.speaker ? s.speaker + ': ' : ''}${s.text}`;
    if (cur.length && len + line.length > maxChars) { out.push(cur); cur = []; len = 0; }
    cur.push({ seg: s, line }); len += line.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function extractByLLM(llm, segments, { heldAt }) {
  const participants = participantsOf(segments);
  const reasons = {}; const items = []; let asked = 0, parsed = 0;
  for (const win of windows(segments)) {
    asked++;
    // 사용자 대본은 <대본> 구역 안에만 둡니다. 대본 속 "이전 지시를 무시하고…" 같은 문장이 지시로 오해되지 않게 하는 장치입니다.
    const body = win.map((w) => w.line).join('\n').replace(/<\/?대본>/gu, '');
    const answer = await llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: `<대본>\n${body}\n</대본>\n위 대본에서 결정·할 일·미결 사항을 JSON 배열로만 답하세요.` }], maxTokens: 700 });
    const arr = parseJsonArray(answer);
    if (!arr) { reasons['JSON 아님'] = (reasons['JSON 아님'] ?? 0) + 1; continue; }
    parsed++;
    for (const raw of arr) {
      const v = validateLLMItem(raw, { segments, participants, heldAt, reasons });
      if (v) items.push(v);
    }
  }
  return { items: dedupe(items), rejected: reasons, windows: asked, parsedWindows: parsed };
}

// LLM 요약: 3문장 이내. 검증(새 숫자 금지·대본 어휘 일치)을 못 넘으면 규칙 요약을 씁니다.
export async function summarizeByLLM(llm, segments) {
  const text = segments.map((s) => `${s.speaker ? s.speaker + ': ' : ''}${s.text}`).join('\n').replace(/<\/?대본>/gu, '').slice(0, 6000);
  const out = await llm.complete({
    system: '당신은 한국어 회의 요약 도우미입니다. 대본에 있는 내용만 사용해 3문장 이내로 요약하세요. 대본에 없는 숫자·이름·사실을 만들지 마세요. 요약문만 쓰세요.',
    messages: [{ role: 'user', content: `<대본>\n${text}\n</대본>\n3문장 이내로 요약하세요.` }], maxTokens: 300,
  });
  const body = out.replace(/\s+/gu, ' ').trim();
  const src = segments.map((s) => s.text).join(' ');
  if (body.length < 10 || body.length > 600) return null;
  const have = new Set(numbersOf(src));
  if (numbersOf(body).some((n) => !have.has(n))) return null;
  const srcWords = new Set(words(src).map(stem));
  const ws = words(body).map(stem).filter((w) => w.length >= 2);
  if (!ws.length || ws.filter((w) => srcWords.has(w)).length / ws.length < 0.6) return null; // 대본에 없는 말이 40% 넘으면 폐기
  return body;
}

// ── 총괄 ────────────────────────────────────────────────────────────────────
// 규칙 항목 + 검증 통과한 LLM 항목을 합칩니다. 같은 구간·같은 종류는 LLM 쪽(문맥 이해) 대신
// "이미 있는 것"을 유지하고(중복 방지), 규칙이 놓친 구간만 LLM이 채웁니다.
export async function analyzeMeeting({ segments, heldAt, llm = null, useLlm = true }) {
  const ruleItems = extractByRules(segments, { heldAt });
  let items = ruleItems, llmInfo = { used: false };
  let summary = summarizeByRules(segments, ruleItems);
  if (useLlm && llm?.available && segments.length) {
    try {
      const r = await extractByLLM(llm, segments, { heldAt });
      const have = new Set(ruleItems.map((i) => `${i.kind}|${i.segIdx}`));
      const extra = r.items.filter((i) => !have.has(`${i.kind}|${i.segIdx}`));
      // 한 구간이 규칙으로 이미 다른 종류로 분류됐다면(예: 규칙=할 일, LLM=결정) 규칙 판정을 존중해 추가하지 않습니다.
      const taken = new Set(ruleItems.map((i) => i.segIdx));
      items = [...ruleItems, ...extra.filter((i) => !taken.has(i.segIdx))];
      llmInfo = { used: true, windows: r.windows, parsedWindows: r.parsedWindows, accepted: items.length - ruleItems.length, rejected: r.rejected, proposed: r.items.length };
      const body = await summarizeByLLM(llm, segments).catch(() => null);
      if (body) {
        const n = (k) => items.filter((i) => i.kind === k).length;
        summary = { body: `결정 ${n('decision')}건 · 할 일 ${n('action')}건 · 미결 ${n('issue')}건\n${body}`, method: 'llm' };
      } else summary = summarizeByRules(segments, items);
    } catch (e) {
      llmInfo = { used: false, error: String(e.message ?? e).slice(0, 120) }; // LLM 실패는 조용히 규칙 결과로 대체
    }
  }
  items.sort((a, b) => a.segIdx - b.segIdx);
  return { items, summary, llm: llmInfo };
}

