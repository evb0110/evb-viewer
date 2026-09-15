@echo off
setlocal EnableExtensions
set "EVB_ROOT=C:\EVBViewerTests"
if not exist "%EVB_ROOT%\state" mkdir "%EVB_ROOT%\state"
>"%EVB_ROOT%\state\task-marker.json" echo task-started user=%USERNAME%
if /I not "%USERNAME%"=="EVBTester" exit /b 11
if not exist "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" exit /b 12
if not exist "%EVB_ROOT%\worker\guestWorker.cjs" exit /b 13
if not exist "%EVB_ROOT%\worker\powershell\start-worker-logon.ps1" exit /b 14
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%EVB_ROOT%\worker\powershell\start-worker-logon.ps1" -NodeExecutable "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" -WorkerScript "%EVB_ROOT%\worker\guestWorker.cjs" -GuestRoot "%EVB_ROOT%" -ExpectedUserName EVBTester 1>"%EVB_ROOT%\state\worker.log" 2>"%EVB_ROOT%\state\worker.stderr.log"
>"%EVB_ROOT%\state\worker-launch-marker.txt" echo launch-issued exit=%ERRORLEVEL%
exit /b %ERRORLEVEL%
