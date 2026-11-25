// ─────────────────────────────────────────────────────────────────────────────
// search.mjs — 여러 회의에 걸친 검색 ("지난 회의에서 배포 날짜가 뭐였지?")
//
// [방식] BM25(검색 점수식). 구간(segment)을 문서 한 장으로 보고, 질의와 단어가 겹칠수록·그 단어가 드물수록 높은 점수.
//        한국어는 조사 때문에 단어가 달라 보이므로 text.mjs의 토큰(어간 + 글자 2개 묶음)을 씁니다.
// [왜 LLM 답변이 아니라 "구간 목록"을 돌려주나]
//   검색 결과는 원문 구간(회의 제목·시각·말한 사람)이므로 사실 그대로입니다. 요약해 주는 순간 틀릴 수 있어서,
//   "어느 회의 몇 분 몇 초에 이렇게 말했다"를 바로 보여 주는 쪽이 회의록 용도에 더 안전합니다.
// [범위] 내 회의 구간만 검색합니다(userId로 이미 걸러진 목록을 받음). 개인 규모라 매번 색인을 새로 만들어도 충분히 빠릅니다.
// ─────────────────────────────────────────────────────────────────────────────
import { tokens } from './text.mjs';

const K1 = 1.4, B = 0.75;

export function searchSegments(rows, query, { limit = 8 } = {}) {
  const q = [...new Set(tokens(query, { query: true }))];
  if (!q.length || !rows.length) return [];
  const docs = rows.map((r) => {
    const tf = new Map();
    const toks = tokens(`${r.speaker ?? ''} ${r.text}`);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, len: toks.length };
  });
  const N = docs.length, avg = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = rows.map((r, i) => {
    let score = 0;
    for (const t of q) {
      const f = docs[i].tf.get(t); if (!f) continue;
      const n = df.get(t), idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * docs[i].len / avg));
    }
    return { ...r, score };
  }).filter((r) => r.score > 0);
  // 단어(w:) 토큰이 하나도 안 겹치고 글자 조각(b:)만 우연히 겹친 결과는 잡음이므로, 최고점의 35% 미만은 버립니다.
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  return scored.filter((r) => r.score >= top * 0.35).slice(0, limit).map((r) => ({ ...r, score: Math.round(r.score * 100) / 100 }));
}
