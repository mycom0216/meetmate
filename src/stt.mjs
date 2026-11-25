// ─────────────────────────────────────────────────────────────────────────────
// stt.mjs — 음성 받아쓰기(STT, Speech-to-Text) 어댑터
//
// [흐름] 업로드된 음성 파일 → ffmpeg로 16kHz 모노 wav 변환 → faster-whisper(tools/transcribe.py) → 구간 목록
//
// [왜 이렇게 만들었나 — 면접 핵심]
//   1) 로컬 처리: 회의 음성은 민감합니다. 외부 API로 보내지 않고 내 PC의 Whisper 모델로만 처리하므로
//      음성이 밖으로 나가지 않고 API 비용도 없습니다(대신 PC 성능에 따라 느림).
//   2) 자식 프로세스 분리: 무거운 모델·파이썬 라이브러리를 Node 서버 안에 넣지 않고 별도 프로세스로 실행합니다.
//      → 받아쓰기가 실패·멈춰도 서버는 살아 있고(타임아웃으로 강제 종료), 모델을 바꿔도 서버 코드는 그대로입니다.
//   3) 명령 주입 방지: execFile(셸 없이 인자 배열로 실행)만 사용하고, 파일 이름은 서버가 만든 난수 이름만 넘깁니다.
//      사용자가 보낸 파일명은 명령에 들어가지 않습니다.
//   4) 확장자가 아니라 "파일 내용의 첫 바이트(매직 넘버)"로 형식을 판별합니다(이름만 .wav로 바꾼 파일 차단).
//   5) 러너(run)를 주입할 수 있어, 테스트에서는 진짜 Whisper 없이 가짜 결과로 전체 흐름을 검증합니다.
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_AUDIO_SEC = 3600; // 한 번에 최대 60분. 더 길면 앞 60분만 처리(메모리·시간 보호)

// 파일의 첫 바이트로 오디오 형식을 판별합니다. 모르는 형식이면 null.
export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  const s4 = buf.subarray(0, 4).toString('latin1');
  if (s4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (s4 === 'OggS') return 'ogg';
  if (s4 === 'fLaC') return 'flac';
  if (s4.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a'; // mp4/m4a 컨테이너
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'; // 브라우저 녹음(MediaRecorder)
  return null;
}

// 기본 러너: 셸 없이 프로그램 실행. stdout을 문자열로 돌려줍니다.
export const defaultRun = (cmd, args, { timeout = 600000, maxBuffer = 64 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr ?? '').slice(-400); return reject(err); }
      resolve({ stdout: String(stdout) });
    });
  });

export class SpeechToText {
  constructor({ env = process.env, run = defaultRun, model, timeoutMs } = {}) {
    this.env = env; this.run = run;
    this.python = env.PYTHON || 'python';
    this.ffmpeg = env.FFMPEG_PATH || 'ffmpeg';
    this.model = model || env.WHISPER_MODEL || 'small';
    this.modelsDir = env.WHISPER_MODELS_DIR || join(HERE, '..', 'models');
    this.script = join(HERE, '..', 'tools', 'transcribe.py');
    this.timeoutMs = timeoutMs ?? Number(env.STT_TIMEOUT_MS || 1800000); // 30분
    this.available = null; // null=아직 확인 안 함
    this.lastError = null;
  }

  get label() { return this.available ? `faster-whisper:${this.model}` : '사용 불가(텍스트 대본만 가능)'; }

  // faster-whisper와 ffmpeg가 있는지 확인합니다(한 번 확인하면 결과를 기억).
  async check({ force = false } = {}) {
    if (this.available !== null && !force) return this.available;
    try {
      await this.run(this.python, ['-I', '-c', 'import faster_whisper'], { timeout: 20000 });
      await this.run(this.ffmpeg, ['-version'], { timeout: 10000 });
      this.available = true; this.lastError = null;
    } catch (e) {
      this.available = false;
      this.lastError = /faster_whisper/u.test(e.stderr ?? '') ? 'faster-whisper가 설치되어 있지 않습니다(pip install faster-whisper).' : 'Python 또는 ffmpeg를 찾을 수 없습니다.';
    }
    return this.available;
  }

  // 입력 파일 → 16kHz 모노 wav. -t 로 길이 상한을 걸고, -vn 으로 영상 트랙은 버립니다.
  async toWav(input, output) {
    await this.run(this.ffmpeg, ['-y', '-v', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', '-t', String(MAX_AUDIO_SEC), output], { timeout: 300000 });
    return output;
  }

  // 변환된 wav → { segments, duration, language }
  async transcribeWav(wav) {
    const args = ['-I', this.script, wav, '--model', this.model, '--lang', 'ko', '--models-dir', this.modelsDir];
    let out;
    try { out = await this.run(this.python, args, { timeout: this.timeoutMs }); }
    catch (e) { this.lastError = '받아쓰기에 실패했습니다.'; throw Object.assign(new Error('stt failed'), { detail: e.stderr }); }
    let data;
    try { data = JSON.parse(out.stdout.trim().split(/\r?\n/u).pop()); } catch { throw new Error('stt output is not JSON'); }
    if (data.error) throw new Error(`stt: ${data.error}`);
    return { segments: (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })), duration: data.duration ?? null, language: data.language ?? 'ko', engine: this.label };
  }
}
