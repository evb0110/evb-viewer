@echo off
setlocal
set "EVB_ROOT=C:\EVBViewerTests"
if not exist "%EVB_ROOT%\state" mkdir "%EVB_ROOT%\state"
>"%EVB_ROOT%\state\task-marker.json" echo task-started user=%USERNAME%
if /I not "%USERNAME%"=="EVBTester" exit /b 11
if not exist "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" exit /b 12
if not exist "%EVB_ROOT%\worker\guestWorker.cjs" exit /b 13
start "EVB Windows Test Worker" /b "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" "%EVB_ROOT%\worker\guestWorker.cjs" 1>"%EVB_ROOT%\state\worker.log" 2>&1
>"%EVB_ROOT%\state\worker-launch-marker.txt" echo launch-issued exit=%ERRORLEVEL%
exit /b 0
