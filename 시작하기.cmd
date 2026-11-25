@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 이상이 필요합니다. https://nodejs.org 에서 설치하세요. & pause & exit /b 1)

rem --- 받아쓰기(Whisper) 확인: 없어도 글 대본 정리는 됩니다. ---
python -c "import faster_whisper" >nul 2>nul
if errorlevel 1 echo [안내] faster-whisper가 없어 음성 받아쓰기는 꺼집니다. 켜려면: pip install faster-whisper  (ffmpeg도 필요: winget install Gyan.FFmpeg)

rem --- AI(Ollama): 설치돼 있는데 꺼져 있으면 켭니다. 없어도 규칙 기반으로 동작합니다. ---
where ollama >nul 2>nul
if %errorlevel%==0 (
  curl -s -m 2 http://127.0.0.1:11434/api/tags >nul 2>nul
  if errorlevel 1 (
    echo Ollama를 시작합니다...
    start "" /min ollama serve
    timeout /t 4 /nobreak >nul
  )
)

echo MeetMate를 시작합니다. 종료하려면 이 창에서 Ctrl+C 를 누르세요.
start "" http://127.0.0.1:5500
node server.mjs
pause
