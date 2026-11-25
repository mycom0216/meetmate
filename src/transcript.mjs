// ─────────────────────────────────────────────────────────────────────────────
// transcript.mjs — 회의 대본(텍스트·SRT·VTT·받아쓰기 결과)을 "구간(segment)" 목록으로 통일
//
// [왜 필요한가]
//   입력 경로가 둘입니다: ① 음성 → Whisper가 만든 구간(시작/끝 시각 있음) ② 사용자가 붙여 넣은 글/자막 파일.
//   이후 단계(요약·할 일 추출·검색·화면)는 "구간 목록"만 알면 되도록 여기서 모양을 하나로 맞춥니다.
//   구간 = { idx, start, end, speaker, text }  (start/end/speaker는 없을 수 있어 null)
//
// [왜 "구간"이 중요한가 — 근거 추적]
//   결정·할 일 항목마다 "어느 구간에서 나온 말인지(seg_idx)"를 저장합니다. 화면에서 항목을 누르면
//   원문 구간과 시각이 보이므로 사용자가 AI의 정리가 맞는지 바로 확인할 수 있습니다(환각 방지의 핵심).
//
// [개인정보]
//   회의에는 전화번호·이메일이 말로/글로 나올 수 있어 저장 전에 maskPII로 가립니다.
// ─────────────────────────────────────────────────────────────────────────────
import { maskPII, sentences } from './text.mjs';

export const LIMITS = { maxChars: 200000, maxSegments: 4000 };

// "[01:02:03]" "[12:30]" "01:02:03" 같은 시각 표기를 초로 바꿉니다. 모양이 안 맞으면 null.
export function toSeconds(str) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/u.exec(String(str).trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

// 초 → "mm:ss" (1시간 이상이면 "h:mm:ss"). 화면 표시용.
export function clock(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

// 형식 자동 판별: WEBVTT 머리말/SRT의 "-->" 가 있으면 자막, 아니면 일반 글.
export function detectFormat(text) {
  const t = String(text ?? '');
  if (/^﻿?WEBVTT/u.test(t)) return 'vtt';
  if (/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/u.test(t)) return 'srt';
  return 'txt';
}

// "이름: 내용" 에서 화자를 뗍니다. 화자명은 12자 이내의 글자·숫자·공백만 허용해서
// "결정사항: ..." 같은 일반 문장 머리말과 시각("10:30")을 화자로 오인하지 않게 합니다(시각은 숫자만이라 제외).
const SPEAKER = /^([\p{L}][\p{L}\p{N}_ ]{0,11})\s*[:：]\s*(.+)$/u;
const NOT_SPEAKER = new Set(['결정', '결정사항', '안건', '참석자', '일시', '장소', '요약', '비고', '참고', '주의', '결론', '다음']);

function parseSubtitle(text) {
  // SRT·VTT: 빈 줄로 블록을 나누고, "시작 --> 끝" 줄 다음이 자막 본문입니다. 번호 줄·큐 이름은 건너뜁니다.
  const segs = [];
  for (const block of text.replace(/^﻿?WEBVTT[^\n]*\n/u, '').split(/\r?\n\r?\n+/u)) {
    const lines = block.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map((s) => s.trim().split(/\s+/u)[0]);
    const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/gu, '').trim(); // VTT의 <v 화자> 같은 태그 제거
    if (!body) continue;
    const sp = SPEAKER.exec(body);
    segs.push({ start: toSeconds(a), end: toSeconds(b), speaker: sp && !NOT_SPEAKER.has(sp[1].trim()) ? sp[1].trim() : null, text: sp && !NOT_SPEAKER.has(sp[1].trim()) ? sp[2].trim() : body });
  }
  return segs;
}

function parsePlain(text) {
  const segs = [];
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line) continue;
    let start = null;
    const ts = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.*)$/u.exec(line); // 줄 맨 앞의 [mm:ss] 시각
    if (ts && ts[2] && toSeconds(ts[1]) != null) { start = toSeconds(ts[1]); line = ts[2]; }
    let speaker = null;
    const sp = SPEAKER.exec(line);
    if (sp && !NOT_SPEAKER.has(sp[1].trim())) { speaker = sp[1].trim(); line = sp[2]; }
    // 한 줄이 길면(여러 문장) 문장 단위로 쪼개 근거 구간을 더 정밀하게 만듭니다.
    const parts = line.length > 120 ? sentences(line) : [line];
    for (const p of parts) if (p.trim()) segs.push({ start, end: null, speaker, text: p.trim() });
  }
  return segs;
}

// 입력(글 또는 STT 결과 배열) → 정리된 구간 목록. 개인정보는 여기서 마스킹합니다.
export function toSegments(input, { format } = {}) {
  let raw;
  if (Array.isArray(input)) raw = input.map((s) => ({ start: s.start ?? null, end: s.end ?? null, speaker: s.speaker ?? null, text: String(s.text ?? '') }));
  else {
    const text = String(input ?? '');
    if (text.length > LIMITS.maxChars) throw new RangeError(`대본이 너무 깁니다(최대 ${LIMITS.maxChars.toLocaleString()}자).`);
    const f = format ?? detectFormat(text);
    raw = f === 'txt' ? parsePlain(text) : parseSubtitle(text);
  }
  const pii = new Set();
  const segs = raw
    .map((s) => ({ ...s, text: s.text.replace(/\s+/gu, ' ').trim() }))
    .filter((s) => s.text)
    .slice(0, LIMITS.maxSegments)
    .map((s, idx) => {
      const m = maskPII(s.text);
      m.found.forEach((f) => pii.add(f));
      return { idx, start: s.start, end: s.end, speaker: s.speaker, text: m.masked };
    });
  return { segments: segs, piiFound: [...pii] };
}
