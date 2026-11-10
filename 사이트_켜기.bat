@echo off
title 전국 파크골프장 사이트 - 이 창을 닫으면 사이트가 꺼집니다
cd /d "%~dp0"

netstat -ano | findstr /r /c:":5000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo 사이트가 이미 켜져 있습니다. 브라우저를 엽니다.
  start "" "http://127.0.0.1:5000"
  timeout /t 3 >nul
  exit /b
)

if not exist ".venv\Scripts\python.exe" (
  echo 처음 실행 준비 중입니다. 1~2분 걸립니다...
  python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
)

echo.
echo  ==============================================
echo    전국 파크골프장 사이트를 켜는 중입니다.
echo    잠시 후 브라우저가 자동으로 열립니다.
echo    주소: http://127.0.0.1:5000
echo.
echo    사이트를 끄려면 이 창을 닫으세요.
echo  ==============================================
echo.
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" app.py --open
echo.
echo 사이트가 멈췄습니다. 위의 메시지를 확인하세요.
pause
