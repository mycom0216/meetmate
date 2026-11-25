# transcribe.py — faster-whisper로 음성 파일을 받아써서 JSON으로 출력합니다.
# 사용: python transcribe.py <wav> [--model small] [--lang ko] [--models-dir DIR]
# 출력(stdout, 한 줄 JSON): {"language","duration","segments":[{"start","end","text"}]}
# 왜 별도 스크립트? Node 서버는 외부 패키지 없이 유지하고, 무거운 음성 모델은 자식 프로세스로 격리해
# (1) 실패해도 서버가 죽지 않고 (2) 모델을 바꾸거나 없애도 서버 코드를 고칠 필요가 없게 하기 위함입니다.
import argparse, json, sys

ap = argparse.ArgumentParser()
ap.add_argument("wav"); ap.add_argument("--model", default="small"); ap.add_argument("--lang", default="ko")
ap.add_argument("--models-dir", default=None)
a = ap.parse_args()
try:
    from faster_whisper import WhisperModel
except ImportError:
    print(json.dumps({"error": "faster-whisper 미설치"}, ensure_ascii=False)); sys.exit(2)
# int8: CPU에서도 메모리·속도가 무난. GPU(GTX 1050)는 VRAM이 작아 CPU 사용.
model = WhisperModel(a.model, device="cpu", compute_type="int8", download_root=a.models_dir)
# vad_filter: 말 없는 구간을 건너뛰어 "환청(없는 말 지어내기)"을 줄입니다. beam_size 5: 정확도/속도 균형.
# 입력은 서버가 ffmpeg로 만든 16kHz 모노 16bit wav입니다. av(디코더) 버전 충돌을 피하려고 표준 wave 모듈로 직접 읽어
# float32 배열로 넘깁니다(faster-whisper는 배열 입력을 지원). 이러면 PyAV 없이도 동작합니다.
import wave
import numpy as np
with wave.open(a.wav, "rb") as w:
    if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
        print(json.dumps({"error": "wav는 16kHz 모노 16bit여야 합니다(ffmpeg 변환 필요)"}, ensure_ascii=False)); sys.exit(3)
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
segs, info = model.transcribe(audio, language=a.lang, vad_filter=True, beam_size=5, condition_on_previous_text=False)
out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs if s.text.strip()]
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps({"language": info.language, "duration": round(info.duration, 2), "segments": out}, ensure_ascii=False))
