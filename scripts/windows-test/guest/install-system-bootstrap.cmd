@echo off
setlocal
set "EVB_ROOT=C:\EVBViewerTests"
set "EVB_SYSTEM=C:\Windows\System32\GroupPolicy\Machine\Scripts\Startup"
if not exist "%EVB_SYSTEM%" mkdir "%EVB_SYSTEM%"
if not exist "%EVB_SYSTEM%" exit /b 21
if not exist "%EVB_ROOT%\state" mkdir "%EVB_ROOT%\state" >nul 2>&1
>"%EVB_ROOT%\state\installer-start.marker" echo startup-installer user=%USERNAME%
set "EVB_FAILURE=0"
call :copy-required system-bootstrap-worker.cmd "%EVB_SYSTEM%\system-bootstrap-worker.cmd"
call :copy-required start-worker.cmd "%EVB_SYSTEM%\start-worker.cmd"
call :copy-required node.zip "%EVB_SYSTEM%\node.zip"
call :copy-required guestWorker.cjs "%EVB_SYSTEM%\guestWorker.cjs"
call :copy-required guestWorker.cjs.map "%EVB_SYSTEM%\guestWorker.cjs.map"
if not exist "%~dp0powershell" (
  echo required-artifact-powershell;exit=2
  exit /b 22
)
xcopy /E /I /Y "%~dp0powershell" "%EVB_SYSTEM%\powershell" >nul 2>&1
call :record copy-powershell %ERRORLEVEL%
call :copy-required test-account.secret "%EVB_SYSTEM%\test-account.secret"
call :copy-required scripts.ini "C:\Windows\System32\GroupPolicy\Machine\Scripts\scripts.ini"
schtasks.exe /create /sc onstart /tn "EVB Windows Test SYSTEM Bootstrap" /tr "cmd.exe /c C:\Windows\System32\GroupPolicy\Machine\Scripts\Startup\system-bootstrap-worker.cmd" /ru SYSTEM /f >nul 2>&1
call :record task-create %ERRORLEVEL%
if "%EVB_FAILURE%"=="1" exit /b 22
if exist "%EVB_ROOT%\state\system-bootstrap-complete.marker" del "%EVB_ROOT%\state\system-bootstrap-complete.marker"
if exist "%EVB_ROOT%\state\system-bootstrap-complete.marker" exit /b 23
schtasks.exe /run /tn "EVB Windows Test SYSTEM Bootstrap" >nul 2>&1
exit /b %ERRORLEVEL%

:copy-required
copy /Y "%~dp0%~1" "%~2" >nul 2>&1
call :record copy-%~1 %ERRORLEVEL%
exit /b 0

:record
if not "%~2"=="0" set "EVB_FAILURE=1"
exit /b 0
