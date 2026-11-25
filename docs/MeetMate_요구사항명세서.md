# MeetMate 요구사항 명세서

작성일 2026-11-26 · 작성자 반재영 · 버전 1.0 · 우선순위: M(Must) S(Should) C(Could)

## 1. 기능 요구사항

| ID | 요구사항 | 상세 명세 | 우선 | 수용 기준(검증 방법) | 구현 | 상태 |
|---|---|---|---|---|---|---|
| FR-01 | 회의 입력(음성·글) | 음성: wav·mp3·m4a·ogg·flac·webm, 최대 100MB·60분(초과분은 앞 60분만). 글: txt·SRT·VTT, 최대 200,000자, 2줄 이상. 회의 날짜는 YYYY-MM-DD(존재하는 날짜). 형식은 확장자가 아니라 파일 앞부분 바이트로 판별 | M | 실행파일·HTML을 .wav로 올리면 415, 100MB 초과 413, 짧은 대본·잘못된 날짜 400, 거부된 업로드가 디스크에 남지 않음 | stt.mjs sniffAudio, http.mjs, transcript.mjs | 완료 |
| FR-02 | 로컬 받아쓰기 | ffmpeg로 16kHz 모노 wav 변환 후 faster-whisper(small)로 받아쓰기. 구간마다 시작·끝 시각. 외부 서버로 음성을 보내지 않음 | M | 합성음 5건 실측 오류율, 가짜 STT로 전체 흐름 테스트, 실패 시 일반 문구 | stt.mjs, tools/transcribe.py | 완료 |
| FR-03 | 음성 즉시 삭제 | 업로드한 음성·변환 파일은 받아쓰기가 끝나면(성공·실패 모두) 삭제. DB에는 텍스트만 저장 | M | 성공·STT 오류·말 없음·STT 불가 모든 경로에서 임시 폴더가 비어 있음 | app.mjs | 완료 |
| FR-04 | 개인정보 마스킹 | 전화·이메일·주민번호·카드번호를 저장 전에 치환, 화면에 "가려서 저장" 안내 | M | 원문 번호가 DB·응답에 없음 | text.mjs maskPII, transcript.mjs | 완료 |
| FR-05 | 규칙 기반 정리 | 문장 단위로 결정·할 일·미결 분류. 할 일은 담당자(요청형 "OO 님이 ~해 주세요" 또는 말한 사람)와 기한 추출. 진행 멘트("공유하겠습니다", "마치겠습니다")는 제외 | M | 작성 대본 5건 37/37, held-out 5건 정밀도·재현율 실측(평가서) | extract.mjs | 완료 |
| FR-06 | 기한 날짜 계산 | "내일까지·모레·이번 주 금요일·다음 주 월요일·12월 5일·이번 주 안으로·이번 달 말"을 회의 날짜 기준 실제 날짜로 변환. 마감 표지(까지·중으로·안으로 등)가 없으면 기한으로 보지 않음 | M | 월~일 전체·해 넘김·존재하지 않는 날짜(2/30)·같은 요일 처리 테스트 | dates.mjs | 완료 |
| FR-07 | AI 보조 추출 + 검증 | 로컬 LLM(Ollama)이 규칙이 놓친 항목을 제안. 근거 구간 존재·문장 일치(글자 쌍 50%↑)·새 숫자 금지·참석자 이름 확인을 통과한 것만 채택, 기한은 항상 코드가 재계산, 규칙이 이미 분류한 구간은 덮어쓰지 않음. LLM 없음·오류·JSON 아님이면 규칙 결과만 | S | 환각 항목(없는 구간·숫자 변조·엉뚱한 문장·모르는 담당자) 폐기, LLM 오류 시 규칙 결과 유지 | extract.mjs | 완료 |
| FR-08 | 요약 | 결정·할 일·미결 건수 + 핵심 문장. 기본은 원문 발췌(지어낼 수 없음), AI 요약은 새 숫자 금지·대본 어휘 60%↑ 검증 통과 시에만 사용하고 화면에 구분 표시 | M | 규칙 요약이 항목 문장과 중복되지 않음, 검증 실패 시 발췌로 대체 | extract.mjs | 완료 |
| FR-09 | 근거 구간 연결 | 모든 항목이 근거 구간 번호를 가지며, 항목을 누르면 대본의 해당 위치·시각으로 이동. 근거 없는 항목은 DB에 저장되지 않음 | M | 존재하지 않는 구간을 가리키는 항목 저장 거부(복합 외래키), 화면 이동 확인 | db.mjs, app.js | 완료 |
| FR-10 | 받아쓰기 교정·다시 정리 | 구간 문장을 고치고(교정됨 표시) "다시 정리"하면 요약·항목을 새로 생성. 이미 완료 처리한 할 일은 같은 문장이면 완료 상태 유지 | M | 교정 후 분류가 바뀜, 완료 상태 유지, 빈 문장 400·없는 구간 404 | app.mjs, db.mjs | 완료 |
| FR-11 | 할 일 관리 | 완료 체크, 담당자·기한 수정(기한은 YYYY-MM-DD), 모든 회의의 열린 할 일을 기한 순으로 모아보기(기한 없음은 뒤) | M | 잘못된 상태·기한 400, 남의 항목 404, 정렬 순서 | db.mjs, http.mjs | 완료 |
| FR-12 | 회의 검색 | 내 모든 회의 구간을 BM25로 검색해 원문 발언(회의·시각·말한 사람)을 반환. 조사가 달라도 검색, 관련 없으면 빈 결과. AI 답변 생성 없음 | S | "배포 날짜가 언제였지"로 해당 발언 1위, 남의 회의는 검색되지 않음 | search.mjs | 완료 |
| FR-13 | 회의록 내보내기 | 요약·결정·할 일(체크·담당·기한)·미결·전체 대본을 마크다운으로 내려받기 | S | 내려받기 응답·형식, 남의 회의 404 | app.mjs exportMarkdown | 완료 |
| FR-14 | 비동기 작업 처리 | 요청은 즉시 jobId 반환, 처리는 한 번에 하나씩 순서대로, 화면은 진행 단계(변환·받아쓰기·정리)를 조회. 완료·실패 작업은 1시간 후 정리 | M | 동시 3건 제출 시 동시 실행 1, 남의 작업 404 | app.mjs | 완료 |
| FR-15 | 기록 삭제 | 회의 1건 삭제, 「내 기록 모두 삭제」(확인창 + `confirm:true` 필수, 복구 불가). 구간·요약·항목·평가까지 연쇄 삭제, 다른 사용자 영향 없음 | M | confirm 없으면 400, 삭제 후 목록·검색·할 일 모두 비어 있음 | db.mjs, app.js | 완료 |
| FR-16 | 피드백·지표 | 항목별 👍/👎(재평가는 덮어쓰기), 회의·구간·항목·도움됨 수 통계 | C | 중복 평가 1건 유지, 남의 항목 404 | db.mjs | 완료 |
| FR-17 | 브라우저 녹음 | 화면에서 바로 녹음(MediaRecorder) 후 업로드. 마이크 권한은 이 사이트만 | C | 녹음 UI 동작(수동), 서버는 webm 판별·변환 | app.js, stt.mjs | 완료(수동 확인 필요) |

## 2. 비기능 요구사항

| ID | 분류 | 명세 | 우선 | 검증 | 상태 |
|---|---|---|---|---|---|
| NFR-01 | 가용성 | LLM·Whisper 없이도 글 대본 정리가 동작. Whisper가 없으면 음성 버튼만 비활성화하고 이유 안내 | M | LLM off·STT 불가 상태 테스트 | 완료 |
| NFR-02 | 성능 | 규칙 정리는 대본 5건 모두 1초 이내. 받아쓰기는 CPU 기준 실시간 대비 속도를 실측해 문서화 | S | tools/eval.mjs 실측(평가서) | 완료 |
| NFR-03 | 개인정보 | 회의 음성은 PC 밖으로 나가지 않고 저장하지 않음. 저장 텍스트는 마스킹. 익명 ID만 사용, 서비스는 127.0.0.1에서만 열림 | M | 음성 삭제 테스트, 외부 호출 없음(Whisper·Ollama 모두 로컬) | 완료 |
| NFR-04 | 보안 | 모든 조회·수정에 소유자 조건(IDOR 방지), 본문 크기 제한, 사용자별 호출 간격 제한(429), 경로 이탈 차단, CSP·보안 헤더, 명령 주입 방지(셸 없이 인자 배열 실행·서버가 만든 파일명만 사용), 대본 속 HTML 무해화(textContent) | M | 자동 테스트 | 완료 |
| NFR-05 | 신뢰성 | 받아쓰기·AI 오류는 사용자에게 일반 문구, 상세 원인은 서버 로그. 한 작업 실패가 다른 작업·서버에 영향 없음. 임시 파일 항상 정리 | M | 실패 경로 테스트 | 완료 |
| NFR-06 | 정직성 | AI가 만든 항목·요약에는 "AI 추가·검증됨"/"AI 요약" 표시, 받아쓰기 오류 가능성과 화자 구분 불가를 화면에 안내 | M | 화면 확인 | 완료 |
| NFR-07 | 이식성 | Node.js 24 이상(npm 설치 불필요). 음성 기능은 Python + faster-whisper + ffmpeg가 선택 사항 | S | README 절차 | 완료 |
| NFR-08 | 유지보수 | 모든 소스에 "무엇을·왜" 주석, 자동 테스트로 회귀 방지 | S | 테스트 실행 | 완료 |

## 3. 인터페이스 명세(API)

| 메서드·경로 | 설명 | 주요 입력 | 응답 |
|---|---|---|---|
| GET /api/status | 받아쓰기·AI 상태, 한도 | – | stt, llm, limits |
| POST /api/llm/reconnect | AI·받아쓰기 다시 연결 | – | llm, stt |
| GET /api/sample | 시연용 샘플 대본 | – | title, heldAt, text |
| POST /api/meetings/text | 글 대본 제출 | userId, title, heldAt, text, useLlm | 202 jobId |
| POST /api/meetings/audio?userId&title&heldAt&useLlm | 음성 파일(바이너리 본문) 제출 | 본문=음성 바이트 | 202 jobId, 415·413·400 |
| GET /api/jobs/status?userId&jobId | 작업 진행 | – | status(queued·converting·transcribing·analyzing·done·error), step, meetingId |
| GET /api/meetings?userId | 내 회의 목록 | – | 회의별 결정·할 일·미결 건수 |
| GET /api/meetings/get?userId&id | 회의 상세 | – | segments, summary, items |
| GET /api/meetings/export?userId&id | 회의록 .md | – | 마크다운 첨부 |
| POST /api/meetings/delete | 회의 삭제 | userId, id | ok |
| POST /api/meetings/reextract | 다시 정리 | userId, id, useLlm | 202 jobId |
| POST /api/segments/edit | 구간 교정 | userId, meetingId, idx, text | ok |
| POST /api/items/update | 할 일 수정 | userId, itemId, status·owner·due | ok |
| POST /api/feedback | 항목 평가 | userId, itemId, helpful | ok |
| GET /api/actions?userId&status | 할 일 모아보기 | status=open·all | 항목 목록 |
| GET /api/search?userId&q | 회의 검색 | q | 원문 구간 목록 |
| POST /api/forget | 내 기록 전체 삭제 | userId, confirm:true | 삭제 건수 |
| GET /api/stats | 운영 지표 | – | 사용자·회의·구간·항목·평가 수 |

오류 코드: 400 입력 오류 · 404 대상 없음(남의 것 포함) · 413 크기 초과 · 415 지원하지 않는 파일 · 429 요청 간격 · 500 일반 문구.

## 4. 데이터 요구사항

테이블 6개(users, meetings, segments, summaries, items, feedback), 복합 외래키로 항목의 근거 구간 보장, 사용자 삭제 시 전부 연쇄 삭제 → 「데이터정의서」 참조.

## 5. 검증 매핑

| 요구사항 | 자동 테스트 | 평가 |
|---|---|---|
| FR-01 | app.test: 형식 판별·415·413·400 | – |
| FR-02·03 | app.test: 가짜 STT 전체 흐름, 실패 경로, 임시 파일 | eval --stt: 합성음 5건 오류율 |
| FR-04 | core.test: 마스킹 | – |
| FR-05·06 | core.test: 작성 대본 5건, 기한 계산 | eval: held-out 5건 |
| FR-07·08 | core.test: 검증 규칙 7종, 폴백, 프롬프트 주입 | eval --llm |
| FR-09~11 | app.test: 복합 FK, 교정·재정리, 항목 수정 | – |
| FR-12~16 | app.test: 검색, 내보내기, 큐, 삭제, 평가 | – |
