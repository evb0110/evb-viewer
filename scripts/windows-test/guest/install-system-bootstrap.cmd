@echo off
setlocal
set "EVB_ROOT=C:\EVBViewerTests"
set "EVB_SYSTEM=C:\Windows\System32\GroupPolicy\Machine\Scripts\Startup"
if not exist "%EVB_SYSTEM%" mkdir "%EVB_SYSTEM%"
if not exist "%EVB_SYSTEM%" exit /b 21
if not exist "%EVB_ROOT%\state" mkdir "%EVB_ROOT%\state" >nul 2>&1
>"%EVB_ROOT%\state\installer-start.marker" echo startup-installer user=%USERNAME%
copy /Y "%~dp0system-bootstrap-worker.cmd" "%EVB_SYSTEM%\system-bootstrap-worker.cmd" >nul 2>&1
copy /Y "%~dp0start-worker.cmd" "%EVB_SYSTEM%\start-worker.cmd" >nul 2>&1
copy /Y "%~dp0node.zip" "%EVB_SYSTEM%\node.zip" >nul 2>&1
copy /Y "%~dp0guestWorker.cjs" "%EVB_SYSTEM%\guestWorker.cjs" >nul 2>&1
copy /Y "%~dp0guestWorker.cjs.map" "%EVB_SYSTEM%\guestWorker.cjs.map" >nul 2>&1
copy /Y "%~dp0test-account.secret" "%EVB_SYSTEM%\test-account.secret" >nul 2>&1
copy /Y "%~dp0scripts.ini" "C:\Windows\System32\GroupPolicy\Machine\Scripts\scripts.ini" >nul 2>&1
schtasks.exe /create /sc onstart /tn "EVB Windows Test SYSTEM Bootstrap" /tr "cmd.exe /c C:\Windows\System32\GroupPolicy\Machine\Scripts\Startup\system-bootstrap-worker.cmd" /ru SYSTEM /f >nul 2>&1
schtasks.exe /run /tn "EVB Windows Test SYSTEM Bootstrap" >nul 2>&1
exit /b %ERRORLEVEL%
