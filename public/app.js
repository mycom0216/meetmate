// MeetMate 화면 로직.
// [보안] 서버에서 온 글(대본·항목·제목)은 전부 textContent/DOM API로만 넣습니다. innerHTML을 쓰지 않으므로
//        대본에 <script>가 들어 있어도 실행되지 않습니다(XSS 방지). CSP 헤더가 한 번 더 막습니다.
const $ = (s) => document.querySelector(s);

// 익명 ID: 브라우저가 만든 난수. 이름·연락처를 받지 않습니다. (삭제하면 새 ID가 발급됩니다)
const newId = () => 'u-' + crypto.randomUUID().replace(/-/gu, '').slice(0, 24);
const safe = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } } };
let userId = safe.get('mm_user') || newId(); safe.set('mm_user', userId);

// 작은 DOM 생성 도우미: h('div', {class:'x'}, '글', 자식…)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, { method, headers: raw ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `오류 ${res.status}`);
  return data;
}
const qs = (o) => new URLSearchParams({ userId, ...o }).toString();
const clock = (s) => { if (s == null) return ''; s = Math.floor(s); const m = Math.floor(s / 60), r = s % 60; return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };
const KIND = { decision: '결정 사항', action: '할 일', issue: '미결 사항' };

// ── 상태 줄 ────────────────────────────────────────────────
async function showStatus(reconnect = false) {
  try {
    const s = reconnect ? await api('/api/llm/reconnect', { method: 'POST', body: {} }) : await api('/api/status');
    $('#status').textContent = `받아쓰기: ${s.stt} · AI: ${s.llm}`;
    const noStt = !s.sttAvailable;
    $('#goAudio').disabled = noStt; $('#rec').disabled = noStt;
    $('#goAudio').title = noStt ? '받아쓰기를 사용할 수 없습니다. 글 대본으로 올려 주세요.' : '';
  } catch (e) { $('#status').textContent = '서버 연결 실패'; }
}
$('#reconnect').addEventListener('click', async () => { $('#reconnect').disabled = true; await showStatus(true); $('#reconnect').disabled = false; });

// ── 탭 ─────────────────────────────────────────────────────
function openTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const n of ['new', 'list', 'actions', 'search']) $('#tab-' + n).classList.toggle('hidden', n !== name);
  $('#view').classList.add('hidden');
  if (name === 'list') loadList(); if (name === 'actions') loadActions();
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => openTab(t.dataset.tab));

// ── 새 회의 ────────────────────────────────────────────────
$('#heldAt').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (로컬 날짜)
let recorded = null; // 녹음 결과(Blob)

async function poll(jobId, onStep) {
  for (;;) {
    const j = await api('/api/jobs/status?' + qs({ jobId }));
    onStep(j);
    if (j.status === 'done') return j;
    if (j.status === 'error') throw new Error(j.error || '처리 실패');
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function run(startFn, btn) {
  const msg = $('#newMsg'); msg.className = 'progress'; msg.textContent = '올리는 중…'; btn.disabled = true;
  try {
    const { jobId } = await startFn();
    const j = await poll(jobId, (s) => { msg.textContent = s.step + '…'; });
    msg.className = 'muted'; msg.textContent = '';
    openMeeting(j.meetingId);
  } catch (e) { msg.className = 'err'; msg.textContent = e.message; } finally { btn.disabled = false; }
}
const meta = () => ({ title: $('#title').value.trim(), heldAt: $('#heldAt').value, useLlm: $('#useLlm').checked });

$('#goText').addEventListener('click', (ev) => run(() => api('/api/meetings/text', { method: 'POST', body: { userId, ...meta(), text: $('#text').value } }), ev.currentTarget));
$('#goAudio').addEventListener('click', (ev) => {
  const f = $('#file').files[0] ?? recorded;
  if (!f) { $('#newMsg').className = 'err'; $('#newMsg').textContent = '음성 파일을 고르거나 녹음해 주세요.'; return; }
  const m = meta();
  run(() => api('/api/meetings/audio?' + qs({ title: m.title, heldAt: m.heldAt, useLlm: m.useLlm ? '1' : '0' }), { method: 'POST', raw: f }), ev.currentTarget);
});
$('#sample').addEventListener('click', async () => { const s = await api('/api/sample'); $('#title').value = s.title ?? ''; $('#heldAt').value = s.heldAt ?? $('#heldAt').value; $('#text').value = s.text ?? ''; });

// 브라우저 녹음(MediaRecorder). 형식은 브라우저가 정합니다(보통 webm) — 서버가 내용으로 판별하고 ffmpeg로 변환합니다.
let rec = null, tick = null;
$('#rec').addEventListener('click', async () => {
  if (rec) { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = []; rec = new MediaRecorder(stream); const t0 = Date.now();
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); clearInterval(tick);
      recorded = new Blob(chunks, { type: rec.mimeType }); rec = null;
      $('#rec').textContent = '다시 녹음'; $('#recTime').textContent = '녹음 완료';
      $('#player').src = URL.createObjectURL(recorded); $('#player').classList.remove('hidden');
    };
    rec.start(); $('#rec').textContent = '녹음 멈춤';
    tick = setInterval(() => { $('#recTime').textContent = clock((Date.now() - t0) / 1000); }, 500);
  } catch { $('#newMsg').className = 'err'; $('#newMsg').textContent = '마이크를 사용할 수 없습니다. 권한을 허용하거나 파일로 올려 주세요.'; }
});

// ── 목록 · 할 일 · 검색 ─────────────────────────────────────
async function loadList() {
  const box = $('#list'); box.replaceChildren();
  const rows = await api('/api/meetings?' + qs());
  if (!rows.length) { box.append(h('p', { class: 'muted' }, '아직 회의가 없습니다. "새 회의"에서 올려 보세요.')); return; }
  for (const m of rows) {
    box.append(h('div', { class: 'card', onclick: () => openMeeting(m.id) },
      h('div', {}, h('b', {}, m.title), ' ', h('span', { class: 'small' }, `${m.heldAt}${m.source === 'audio' ? ' · 음성 ' + clock(m.durationSec) : ' · 글'}`)),
      h('div', {}, h('span', { class: 'badge' }, `결정 ${m.decisions}`), h('span', { class: 'badge' }, `할 일 ${m.openActions}/${m.actions}`), h('span', { class: 'badge warn' }, `미결 ${m.issues}`))));
  }
}
async function loadActions() {
  const box = $('#actions'); box.replaceChildren();
  const rows = await api('/api/actions?' + qs({ status: $('#allActions').checked ? 'all' : 'open' }));
  if (!rows.length) { box.append(h('p', { class: 'muted' }, '남은 할 일이 없습니다.')); return; }
  for (const a of rows) box.append(h('div', { class: 'item action' + (a.status === 'done' ? ' done' : '') },
    h('div', { class: 'txt', onclick: () => openMeeting(a.meetingId, a.segIdx) }, a.text),
    h('div', { class: 'meta' }, h('span', { class: 'badge' }, a.owner ?? '담당 미지정'), a.due ? h('span', {}, '기한 ' + a.due) : h('span', { class: 'muted' }, '기한 없음'), h('span', { class: 'muted' }, `· ${a.meetingTitle} (${a.heldAt})`))));
}
$('#allActions').addEventListener('change', loadActions);
async function doSearch() {
  const q = $('#q').value.trim(), box = $('#hits'); box.replaceChildren();
  if (!q) return;
  const hits = await api('/api/search?' + qs({ q }));
  if (!hits.length) { box.append(h('p', { class: 'muted' }, '일치하는 발언이 없습니다.')); return; }
  for (const x of hits) box.append(h('div', { class: 'hit', onclick: () => openMeeting(x.meetingId, x.idx) },
    h('div', { class: 'small' }, `${x.meetingTitle} · ${x.heldAt}${x.time ? ' · ' + x.time : ''}${x.speaker ? ' · ' + x.speaker : ''}`), h('div', {}, x.text)));
}
$('#goSearch').addEventListener('click', doSearch);
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// ── 회의 상세 ──────────────────────────────────────────────
async function openMeeting(id, focusIdx) {
  for (const n of ['new', 'list', 'actions', 'search']) $('#tab-' + n).classList.add('hidden');
  const view = $('#view'); view.classList.remove('hidden'); view.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
  let m;
  try { m = await api('/api/meetings/get?' + qs({ id })); } catch (e) { view.replaceChildren(h('p', { class: 'err' }, e.message)); return; }
  const segEls = new Map();
  const jump = (idx) => { const el = segEls.get(idx); if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('hl'); setTimeout(() => el.classList.remove('hl'), 2500); };

  const section = (kind) => {
    const xs = m.items.filter((i) => i.kind === kind);
    return h('div', { class: 'panel' }, h('h2', {}, `${KIND[kind]} (${xs.length})`),
      xs.length ? xs.map((i) => itemEl(i, jump)) : h('p', { class: 'muted' }, '없음'));
  };
  const segs = h('div', { class: 'panel' }, h('h2', {}, '전체 대본'),
    h('p', { class: 'hint' }, '받아쓰기가 틀렸다면 ✎ 로 고치고 "다시 정리"를 누르세요. 항목을 누르면 근거 구간으로 이동합니다.'));
  for (const s of m.segments) {
    const el = segEl(m, s); segEls.set(s.idx, el); segs.append(el);
  }
  view.replaceChildren(...[
    h('div', { class: 'bar' },
      h('button', { class: 'ghost', type: 'button', onclick: () => openTab('list') }, '← 목록'),
      h('h2', { style: 'margin:0' }, m.title), h('span', { class: 'small' }, `${m.heldAt}${m.durationSec ? ' · ' + clock(m.durationSec) : ''}`),
      h('a', { href: '/api/meetings/export?' + qs({ id }), download: '' }, h('button', { class: 'ghost', type: 'button' }, '회의록 내려받기(.md)')),
      h('button', { class: 'ghost', type: 'button', onclick: () => reextract(m) }, '다시 정리'),
      h('button', { class: 'ghost danger', type: 'button', onclick: () => removeMeeting(m) }, '이 회의 삭제')),
    m.pii.length ? h('div', { class: 'notice' }, `개인정보(${m.pii.join('·')})가 있어 [ ]로 가려서 저장했습니다.`) : null,
    h('div', { class: 'panel' }, h('h2', {}, '요약 ', h('span', { class: 'badge ' + (m.summary?.method === 'llm' ? 'llm' : '') }, m.summary?.method === 'llm' ? 'AI 요약(검증됨)' : '원문 발췌')), h('div', { class: 'summary' }, m.summary?.body ?? '')),
    m.source === 'audio' ? h('div', { class: 'notice' }, '음성 받아쓰기는 단어를 잘못 들을 수 있고 화자를 구분하지 못합니다. "제가 ~하겠습니다"의 담당자는 직접 지정해 주세요.') : null,
    section('decision'), section('action'), section('issue'), segs].filter(Boolean));
  if (focusIdx != null) setTimeout(() => jump(focusIdx), 100);
}

function segEl(m, s) {
  const body = h('span', { class: 'body' }, s.text);
  const el = h('div', { class: 'seg' + (s.edited ? ' edited' : ''), id: 'seg-' + s.idx },
    h('span', { class: 't' }, clock(s.start)), h('span', { class: 'sp' }, s.speaker ?? ''), body,
    h('button', { type: 'button', title: '문장 고치기', onclick: () => {
      const ta = h('textarea', { rows: 2 }, s.text); ta.value = s.text;
      const ok = h('button', { class: 'primary', type: 'button', onclick: async () => {
        try { await api('/api/segments/edit', { method: 'POST', body: { userId, meetingId: m.id, idx: s.idx, text: ta.value } }); s.text = ta.value.trim(); body.textContent = s.text; el.classList.add('edited'); } catch (e) { alert(e.message); }
        ta.replaceWith(body); ok.remove(); no.remove();
      } }, '저장');
      const no = h('button', { type: 'button', onclick: () => { ta.replaceWith(body); ok.remove(); no.remove(); } }, '취소');
      body.replaceWith(ta); el.append(ok, no);
    } }, '✎'));
  return el;
}

function itemEl(i, jump) {
  const el = h('div', { class: `item ${i.kind}` + (i.status === 'done' ? ' done' : '') });
  const meta = h('div', { class: 'meta' });
  if (i.kind === 'action') {
    const cb = h('input', { type: 'checkbox', 'aria-label': '완료' }); cb.checked = i.status === 'done';
    cb.addEventListener('change', async () => { await api('/api/items/update', { method: 'POST', body: { userId, itemId: i.id, status: cb.checked ? 'done' : 'open' } }); el.classList.toggle('done', cb.checked); });
    const owner = h('input', { type: 'text', maxlength: 20, placeholder: '담당자', value: i.owner ?? '', size: 8 });
    owner.addEventListener('change', () => api('/api/items/update', { method: 'POST', body: { userId, itemId: i.id, owner: owner.value } }));
    const due = h('input', { type: 'date', value: i.due ?? '' });
    due.addEventListener('change', () => api('/api/items/update', { method: 'POST', body: { userId, itemId: i.id, due: due.value || null } }));
    meta.append(...[cb, owner, due, i.dueExpr ? h('span', { class: 'muted' }, `("${i.dueExpr}")`) : null].filter(Boolean));
  }
  meta.append(...[i.method === 'llm' ? h('span', { class: 'badge llm' }, 'AI 추가·검증됨') : null,
    h('span', { class: 'fb' }, h('button', { type: 'button', title: '도움이 됐어요', onclick: () => feedback(i.id, true) }, '👍'), h('button', { type: 'button', title: '틀렸어요', onclick: () => feedback(i.id, false) }, '👎'))].filter(Boolean));
  el.append(h('div', { class: 'txt', onclick: () => jump(i.segIdx), title: '근거 구간으로 이동' }, i.text), meta);
  return el;
}
const feedback = (itemId, helpful) => api('/api/feedback', { method: 'POST', body: { userId, itemId, helpful } }).catch(() => {});

async function reextract(m) {
  const view = $('#view'); view.prepend(h('div', { class: 'progress' }, '다시 정리하는 중…'));
  try { const { jobId } = await api('/api/meetings/reextract', { method: 'POST', body: { userId, id: m.id } }); await poll(jobId, () => {}); openMeeting(m.id); } catch (e) { alert(e.message); openMeeting(m.id); }
}
async function removeMeeting(m) {
  if (!confirm(`"${m.title}" 회의를 삭제할까요? 복구할 수 없습니다.`)) return;
  await api('/api/meetings/delete', { method: 'POST', body: { userId, id: m.id } }); openTab('list');
}

// 내 기록 모두 삭제: 서버 데이터를 지우고, 새 익명 ID로 시작합니다.
$('#forget').addEventListener('click', async () => {
  if (!confirm('이 브라우저의 모든 회의 기록(대본·요약·할 일)을 서버에서 삭제합니다. 복구할 수 없습니다. 계속할까요?')) return;
  try { await api('/api/forget', { method: 'POST', body: { userId, confirm: true } }); userId = newId(); safe.set('mm_user', userId); location.reload(); } catch (e) { alert(e.message); }
});

showStatus();
