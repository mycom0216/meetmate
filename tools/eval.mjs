// eval.mjs — 정리(추출) 정확도와 받아쓰기(STT) 정확도 측정
//
// 사용:
//   node tools/eval.mjs            규칙 경로: 개발용 대본 5건 + held-out 5건
//   node tools/eval.mjs --llm      + AI(Ollama)+검증 경로(held-out)  ※ 회의당 수십 초
//   node tools/eval.mjs --stt      + 받아쓰기(Whisper) CER/WER와 음성→정리 end-to-end (samples/audio 필요: tools/make_audio.ps1)
//
// [측정 방식]
//   · 줄(발언) 단위 채점: 정답(gold)이 있는 줄에서 같은 종류를 찾으면 TP, 틀린 종류/정답 없는 줄에서 찾으면 FP, 못 찾으면 FN.
//   · 정밀도 = TP/(TP+FP), 재현율 = TP/(TP+FN), F1 = 둘의 조화평균.
//   · 할 일은 담당자·기한까지 맞아야 "세부 정확"으로 따로 셉니다(둘 다 맞은 비율).
// [주의 — 해석 한계]
//   · 개발용 대본(scripts.json)은 규칙을 만들고 다듬는 데 쓴 것이라 점수가 부풀려져 있습니다(참고용).
//   · held-out(heldout.json)은 규칙을 다 만든 뒤에 말투를 달리해 작성했고, 이 세트로는 규칙을 고치지 않았습니다.
//   · 두 세트 모두 내가 직접 쓴 가상 대본입니다. 실제 회의의 다양성·잡음을 대표하지 않습니다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSegments } from '../src/transcript.mjs';
import { extractByRules, analyzeMeeting, overlap } from '../src/extract.mjs';
import { LLM } from '../src/llm.mjs';
import { SpeechToText } from '../src/stt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(readFileSync(join(ROOT, 'samples', f), 'utf8')).meetings;
const KINDS = ['decision', 'action', 'issue'];
const pct = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');

// 레코드: 항목이 가리키는 "줄 번호"를 구해 줍니다. (텍스트 입력이면 segIdx == 줄 번호, 음성이면 문장 유사도로 찾음)
function score(meetings, itemsOf, { byText = false, checkOwner = true } = {}) {
  const c = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0 }]));
  let actionTP = 0, actionExact = 0, dueOk = 0;
  const misses = [], extras = [];
  for (const m of meetings) {
    const items = itemsOf(m);
    const lineOf = (it) => {
      if (!byText) return it.segIdx;
      let best = -1, bs = 0;
      m.lines.forEach((l, j) => { const o = overlap(it.text, l.text); if (o > bs) { bs = o; best = j; } });
      return bs >= 0.5 ? best : -1;
    };
    const byLine = new Map();
    for (const it of items) { const j = lineOf(it); if (!byLine.has(j)) byLine.set(j, []); byLine.get(j).push(it); }
    m.lines.forEach((l, j) => {
      const got = byLine.get(j) ?? [];
      const g = l.gold;
      if (g) {
        const hit = got.find((x) => x.kind === g.kind);
        if (hit) {
          c[g.kind].tp++;
          if (g.kind === 'action') {
            actionTP++;
            const due = hit.due === g.due, owner = !checkOwner || hit.owner === g.owner;
            if (due) dueOk++;
            if (due && owner) actionExact++;
          }
        } else { c[g.kind].fn++; misses.push(`${m.id}:${j} [${g.kind}] ${l.text}`); }
        for (const x of got) if (x.kind !== g.kind) { c[x.kind].fp++; extras.push(`${m.id}:${j} 오분류 [${x.kind}≠${g.kind}] ${l.text}`); }
      } else for (const x of got) { c[x.kind].fp++; extras.push(`${m.id}:${j} [${x.kind}] ${l.text}`); }
    });
    for (const [j, xs] of byLine) if (j < 0) for (const x of xs) { c[x.kind].fp++; extras.push(`${m.id}:? [${x.kind}] ${x.text}`); }
  }
  const sum = (f) => KINDS.reduce((s, k) => s + c[k][f], 0);
  const prf = ({ tp, fp, fn }) => { const p = tp + fp ? tp / (tp + fp) : null, r = tp + fn ? tp / (tp + fn) : null; return { p, r, f1: p && r ? (2 * p * r) / (p + r) : 0 }; };
  return { per: Object.fromEntries(KINDS.map((k) => [k, { ...c[k], ...prf(c[k]) }])), all: { tp: sum('tp'), fp: sum('fp'), fn: sum('fn'), ...prf({ tp: sum('tp'), fp: sum('fp'), fn: sum('fn') }) }, actionTP, actionExact, dueOk, misses, extras };
}

function table(title, r) {
  const L = [`### ${title}`, '| 종류 | 정답 | 찾음(TP) | 잘못 찾음(FP) | 놓침(FN) | 정밀도 | 재현율 | F1 |', '|---|---|---|---|---|---|---|---|'];
  const name = { decision: '결정', action: '할 일', issue: '미결' };
  for (const k of KINDS) { const x = r.per[k]; L.push(`| ${name[k]} | ${x.tp + x.fn} | ${x.tp} | ${x.fp} | ${x.fn} | ${pct(x.p)} | ${pct(x.r)} | ${pct(x.f1)} |`); }
  const a = r.all; L.push(`| **전체** | ${a.tp + a.fn} | ${a.tp} | ${a.fp} | ${a.fn} | ${pct(a.p)} | ${pct(a.r)} | ${pct(a.f1)} |`);
  L.push('', `할 일 세부: 찾은 ${r.actionTP}건 중 기한 일치 ${r.dueOk}건, 담당자·기한 모두 일치 ${r.actionExact}건`);
  return L.join('\n');
}

const toSegs = (m) => toSegments(m.lines.map((l) => ({ speaker: l.speaker, text: l.text }))).segments;
const out = { when: new Date().toISOString() };
const md = [];

const dev = load('scripts.json'), held = load('heldout.json'), held2 = load('heldout2.json');
const rulesOf = (m) => extractByRules(toSegs(m), { heldAt: m.heldAt });
const SETS = [
  ['dev', '개발용 대본 5건 (규칙을 만들 때 쓴 것 — 점수가 부풀려져 있음)', dev],
  ['held1', 'held-out 1 (5건) — 1라운드 평가 후 규칙 보강에 사용함 → 이제는 오염된 세트', held],
  ['held2', 'held-out 2 (5건) — 보강 후 새로 작성, 규칙 수정에 쓰지 않음 → 최종 수치', held2],
];
const R = {};
for (const [key, title, ms] of SETS) {
  R[key] = score(ms, rulesOf); out['rules_' + key] = R[key];
  md.push(table('규칙 경로 — ' + title, R[key]), '');
  if (key !== 'dev') md.push('놓친 항목:', ...(R[key].misses.length ? R[key].misses.map((x) => `- ${x}`) : ['- 없음']), '', '잘못 찾은 항목:', ...(R[key].extras.length ? R[key].extras.map((x) => `- ${x}`) : ['- 없음']), '');
}

if (process.argv.includes('--llm')) {
  const llm = await new LLM({ timeoutMs: 240000 }).init();
  if (!llm.available) { console.error('LLM을 쓸 수 없어 --llm 건너뜀:', llm.lastError); } else {
    for (const [key, title, ms] of SETS.slice(1)) {
      const results = new Map(); const info = { proposed: 0, accepted: 0, rejected: {} }; const t0 = Date.now();
      for (const m of ms) {
        const r = await analyzeMeeting({ segments: toSegs(m), heldAt: m.heldAt, llm });
        results.set(m.id, r.items);
        if (r.llm.used) { info.proposed += r.llm.proposed; info.accepted += r.llm.accepted; for (const [k, v] of Object.entries(r.llm.rejected)) info.rejected[k] = (info.rejected[k] ?? 0) + v; }
        process.stderr.write(`  LLM ${m.id} 완료
`);
      }
      const rL = score(ms, (m) => results.get(m.id));
      out['hybrid_' + key] = rL; out['llmInfo_' + key] = { model: llm.label, seconds: Math.round((Date.now() - t0) / 1000), ...info };
      md.push(table(`규칙 + AI(${llm.label}) + 검증·단서 관문 — ${title}`, rL), '', `AI가 제안한 항목 중 채택된 추가 항목 ${info.accepted}건(검증 통과 ${info.proposed}건 중 규칙과 겹치지 않는 것), 폐기·재분류 사유: ${JSON.stringify(info.rejected)}, 소요 ${out['llmInfo_' + key].seconds}초`, '', '놓친 항목:', ...(rL.misses.length ? rL.misses.map((x) => `- ${x}`) : ['- 없음']), '', '잘못 찾은 항목:', ...(rL.extras.length ? rL.extras.map((x) => `- ${x}`) : ['- 없음']), '');
    }
  }
}

// ── 받아쓰기(STT) ──────────────────────────────────────────
const norm = (s) => [...String(s).normalize('NFKC').replace(/[\s\p{P}]+/gu, '')];
function edit(a, b) { // 레벤슈타인 거리(글자 단위)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function wer(ref, hyp) { // 단어(공백 기준) 단위 거리
  const A = String(ref).normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean), B = String(hyp).normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean);
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) { const cur = [i]; for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)); prev = cur; }
  return prev[B.length] / (A.length || 1);
}

if (process.argv.includes('--stt')) {
  const stt = new SpeechToText({ env: { ...process.env } });
  if (!(await stt.check())) console.error('STT를 쓸 수 없어 --stt 건너뜀:', stt.lastError);
  else {
    const rows = [], sttMeetings = [], sttItems = new Map(); let refChars = 0, errChars = 0, wSum = 0, secs = 0, wall = 0;
    for (const m of dev) {
      const wav = join(ROOT, 'samples', 'audio', `${m.id}.wav`);
      if (!existsSync(wav)) { console.error('음성 없음:', wav, '(tools/make_audio.ps1 실행)'); continue; }
      const t0 = Date.now();
      const wav16 = join(ROOT, 'data', `${m.id}.eval16k.wav`); mkdirSync(join(ROOT, 'data'), { recursive: true });
      await stt.toWav(wav, wav16);
      const t = await stt.transcribeWav(wav16);
      const took = (Date.now() - t0) / 1000;
      const ref = m.lines.map((l) => l.text).join(' '), hyp = t.segments.map((s) => s.text).join(' ');
      const cerE = edit(norm(ref), norm(hyp)), cerN = norm(ref).length, w = wer(ref, hyp);
      refChars += cerN; errChars += cerE; wSum += w; secs += t.duration; wall += took;
      rows.push(`| ${m.id} | ${t.duration.toFixed(0)}초 | ${took.toFixed(0)}초 | ${pct(cerE / cerN)} | ${pct(w)} |`);
      // 음성→정리: 화자 정보가 없으므로(합성음 한 목소리) 담당자는 채점에서 제외하고 종류·기한만 봅니다.
      const segs = toSegments(t.segments).segments;
      sttItems.set(m.id, extractByRules(segs, { heldAt: m.heldAt }));
      sttMeetings.push(m);
      out.stt ??= {}; out.stt[m.id] = { cer: cerE / cerN, wer: w, seconds: t.duration, took, hyp };
    }
    if (rows.length) {
      const e2e = score(sttMeetings, (m) => sttItems.get(m.id), { byText: true, checkOwner: false });
      out.sttSummary = { cer: errChars / refChars, werMean: wSum / rows.length, audioSec: secs, wallSec: wall, model: stt.model };
      out.sttE2E = e2e;
      md.push('', `### 받아쓰기(Whisper ${stt.model}, CPU) — 합성음 5건`, '| 회의 | 길이 | 처리 시간 | 글자 오류율(CER) | 단어 오류율(WER) |', '|---|---|---|---|---|', ...rows,
        `| **합계** | ${secs.toFixed(0)}초 | ${wall.toFixed(0)}초 | ${pct(errChars / refChars)} | ${pct(wSum / rows.length)} |`, '',
        table('음성 → 받아쓰기 → 규칙 정리 end-to-end (담당자는 화자 정보가 없어 채점 제외, 기한까지만)', e2e), '', '놓친 항목(음성):', ...e2e.misses.map((x) => `- ${x}`), '', '잘못 찾은 항목(음성):', ...(e2e.extras.length ? e2e.extras.map((x) => `- ${x}`) : ['- 없음']));
    }
  }
}

console.log(md.join('\n'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'eval_results.json'), JSON.stringify(out, null, 1));
