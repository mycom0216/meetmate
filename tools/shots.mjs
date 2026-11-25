// tools/shots.mjs — 실행 중인 MeetMate 화면을 단계별로 캡처해 docs/images/ui-*.png 로 저장합니다.
// 사용법: (서버 실행 중, samples/audio/m1.wav 필요) node tools/shots.mjs [서버주소=http://127.0.0.1:5500]
// 원리: Edge를 headless로 띄우고 CDP(WebSocket)로 클릭·입력·캡처를 지시합니다. 외부 라이브러리 없음.
// 촬영용 데이터: 임시 사용자 ID로 샘플 대본(글)과 합성음 m1.wav(음성)를 올린 뒤 화면을 찍습니다(AI는 꺼서 빠르게).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5500';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!EDGE) throw new Error('Edge 또는 Chrome을 찾을 수 없습니다.');
const out = join(ROOT, 'docs', 'images');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UID = 'u-shots0000000000000001';

async function job(path, init) {
  const r = await (await fetch(BASE + path, init)).json();
  for (let i = 0; i < 120; i++) {
    const j = await (await fetch(`${BASE}/api/jobs/status?userId=${UID}&jobId=${r.jobId}`)).json();
    if (j.status === 'done') return j.meetingId;
    if (j.status === 'error') throw new Error(j.error);
    await sleep(1500);
  }
  throw new Error('작업 시간 초과');
}

const profile = mkdtempSync(join(tmpdir(), 'mm-shot-'));
const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--window-size=1180,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
try {
  // 1) 촬영용 음성 회의를 먼저 올려 둡니다(받아쓰기에 약 20초).
  const wavFile = join(ROOT, 'samples', 'audio', 'm1.wav');
  if (existsSync(wavFile)) await job(`/api/meetings/audio?userId=${UID}&title=${encodeURIComponent('주간 회의(음성)')}&heldAt=2026-11-30&useLlm=0`, { method: 'POST', body: readFileSync(wavFile) });

  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(300); try { target = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((t) => t.type === 'page'); } catch { /* 부팅 중 */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const png = async (name, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } }); writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
  const shot = async (name) => { const m = (await send('Page.getLayoutMetrics')).result.cssContentSize; await png(name, { x: 0, y: 0, width: 1180, height: Math.ceil(m.height) }); };
  // 선택자 구간 캡처: top 요소의 위쪽부터 bottom 요소(마지막 항목) 끝까지, 항목이 잘리지 않게
  const clipShot = async (name, topSel, lastSel) => {
    const r = await js(`(() => { const t = document.querySelector('${topSel}').getBoundingClientRect(); const l = [...document.querySelectorAll('${lastSel}')].pop().getBoundingClientRect(); const y = t.top + scrollY; return { x: Math.floor(t.left), y: Math.floor(y), width: Math.ceil(t.width), height: Math.ceil(l.bottom + scrollY - y + 12) }; })()`);
    await png(name, r); console.log('  ', r.width + 'x' + r.height);
  };

  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  await js(`localStorage.setItem('mm_user', '${UID}')`);
  await send('Page.navigate', { url: BASE }); await sleep(1500);
  await js("document.getElementById('sample').click()"); await sleep(600);
  await js("document.getElementById('useLlm').checked = false");
  await shot('ui-1-input.png');
  await js("document.getElementById('goText').click()"); await sleep(3500);
  await shot('ui-2-result.png');
  await clipShot('crop-result.png', '#view .bar', '#view .item.action');
  await js("document.querySelector('.tab[data-tab=list]').click()"); await sleep(800);
  await js("[...document.querySelectorAll('#list .card')].find((c) => c.textContent.includes('음성')).click()"); await sleep(1200);
  await shot('ui-3-audio.png');
  await clipShot('crop-audio.png', '#view .notice', '#view .item.issue');
  await js("document.querySelector('.tab[data-tab=actions]').click()"); await sleep(800);
  await shot('ui-4-actions.png');
  await js("document.querySelector('.tab[data-tab=search]').click()"); await sleep(300);
  await js("document.getElementById('q').value = '배포 날짜'; document.getElementById('goSearch').click()"); await sleep(800);
  await shot('ui-5-search.png');
} finally { try { ws?.close(); } catch { /* 이미 닫힘 */ } proc.kill(); }
