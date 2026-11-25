# MeetMate — 로컬 음성 받아쓰기 기반 회의 정리 시스템

회의 녹음(또는 대본)을 올리면 **내 PC에서** 받아쓰고, **결정 사항 · 할 일(담당자·기한) · 미결 사항 · 요약**을 원문 근거와 함께 정리합니다. (인공지능 응용 시스템 개발 종합 프로젝트, 작성자 반재영)

- **음성이 밖으로 나가지 않음**: Whisper(faster-whisper)를 내 PC에서 실행하고, 받아쓰기가 끝나면 음성 파일을 바로 삭제합니다.
- **근거 확인**: 모든 항목이 원문 구간(시각)을 가리키며, 누르면 해당 발언으로 이동합니다. 근거 없는 항목은 DB에 저장되지 않습니다.
- **AI를 믿지 않고 검증**: 규칙이 먼저 찾고, 로컬 LLM이 놓친 것을 제안하면 근거·숫자·담당자·말투 단서를 통과한 것만 채택합니다. 기한은 AI가 아니라 코드가 계산합니다.
- **틀린 받아쓰기 교정**: 문장을 고치고 "다시 정리".
- **항상 동작**: LLM·Whisper가 없어도 글 대본 정리는 규칙 기반으로 동작합니다.

## 실행

필수: Node.js 24 이상 (npm 설치 없음)

```powershell
node server.mjs        # 또는 시작하기.cmd 더블클릭
```
브라우저에서 http://127.0.0.1:5500 (내 PC에서만 열림)

### 음성 받아쓰기 켜기(선택)
```powershell
pip install faster-whisper
winget install Gyan.FFmpeg
```
첫 받아쓰기 때 Whisper small 모델(약 480MB)을 `models/`에 내려받습니다. 이후에는 오프라인으로 동작합니다.

### AI(선택)
Ollama를 설치하고 `ollama pull kanana2:3b`. `.env.example`을 `.env`로 복사해 `LLM_PROVIDER=ollama` 등을 설정합니다. Claude·ChatGPT 키도 쓸 수 있습니다(회의 내용이 외부로 나가므로 주의).

## 테스트·평가

```powershell
npm test                          # 자동 테스트
node tools/eval.mjs               # 정리 정확도(규칙)
node tools/eval.mjs --llm --stt   # + AI 포함, 받아쓰기·end-to-end (Ollama·Whisper 필요, 수 분)
powershell -File tools\make_audio.ps1   # 평가용 합성음 생성(Windows 한국어 음성)
```

평가 결과와 한계는 `docs/MeetMate_테스트결과서.md`에 있습니다. **평가에 쓴 대본·음성은 모두 직접 만든 가상 데이터(음성은 합성음)입니다. 실제 회의의 잡음·겹침·말 흐림은 반영되지 않았으므로 정확도는 상한선으로 해석하세요.**

## 구조

| 파일 | 역할 |
|---|---|
| `src/transcript.mjs` | txt·SRT·VTT·받아쓰기 결과 → 구간 목록, 개인정보 마스킹 |
| `src/dates.mjs` | "다음 주 금요일까지" → 실제 날짜(시간대 오류 없이 직접 계산) |
| `src/extract.mjs` | 규칙 추출, AI 제안 검증(근거·숫자·담당자·단서), 요약 |
| `src/stt.mjs` + `tools/transcribe.py` | ffmpeg 변환 + faster-whisper(자식 프로세스), 파일 형식 판별 |
| `src/app.mjs` | 작업 큐(한 번에 하나), 업무 흐름, 음성 즉시 삭제 |
| `src/db.mjs` | SQLite 6개 테이블(복합 외래키로 근거 구간 보장) |
| `src/http.mjs` | API, 크기 제한·호출 제한·소유자 검사·보안 헤더 |
| `src/search.mjs` | 여러 회의 BM25 검색(원문 구간 반환) |
| `src/llm.mjs` | Ollama / Claude / ChatGPT 어댑터 |
| `public/` | 화면(DOM API만 사용, innerHTML 없음) |

모든 소스에는 "무엇을·왜"를 설명하는 주석이 있습니다.

## 한계

- 화자 구분이 없어 음성의 "제가 ~하겠습니다" 담당자는 비어 있습니다(직접 지정).
- 받아쓰기 오인식("배포"→"폐포" 등)이 있어 화면에서 고칠 수 있게 했습니다.
- 규칙이 놓치는 표현은 AI가 보완하지만, 작은 모델(3B)은 분류가 불안정해 검증·단서 관문을 거칩니다.
- 로그인이 없어 서비스를 127.0.0.1에서만 열어 둡니다. 여러 사람이 쓰려면 인증이 필요합니다.
- 실제 사람 목소리·실제 회의에 대한 정확도는 아직 측정하지 못했습니다(12월 예정).
