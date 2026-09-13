@echo off
setlocal EnableExtensions
set "EVB_ROOT=C:\EVBViewerTests"
set "EVB_STAGE=%~dp0"
set "EVB_STATE=%EVB_ROOT%\state"
set "EVB_MARKER=%EVB_STATE%\system-bootstrap.marker"
if not exist "%EVB_STATE%" mkdir "%EVB_STATE%" >nul 2>&1
if not exist "%EVB_ROOT%\worker" mkdir "%EVB_ROOT%\worker" >nul 2>&1
if not exist "%EVB_ROOT%\node" mkdir "%EVB_ROOT%\node" >nul 2>&1
if not exist "%EVB_STAGE%test-account.secret" (
  >"%EVB_MARKER%" echo step=read-secret;exit=2
  exit /b 2
)
set /p EVB_SECRET=<"%EVB_STAGE%test-account.secret"
if not exist "%EVB_STATE%\system-bootstrap-complete.marker" goto configure
goto stage

:configure
net user EVBTester "%EVB_SECRET%" /add /y >nul 2>&1
call :record net-user-add %ERRORLEVEL%
net localgroup Users EVBTester /add >nul 2>&1
call :record users-group-add %ERRORLEVEL%
net localgroup Administrators EVBTester /delete >nul 2>&1
call :record administrators-group-remove %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f >nul 2>&1
call :record auto-admin-logon %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultUserName /t REG_SZ /d EVBTester /f >nul 2>&1
call :record default-user-name %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword /t REG_SZ /d "%EVB_SECRET%" /f >nul 2>&1
call :record default-password %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultDomainName /t REG_SZ /d . /f >nul 2>&1
call :record default-domain %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableLockWorkstation /t REG_DWORD /d 1 /f >nul 2>&1
call :record disable-lock-on-resume %ERRORLEVEL%
copy /Y "%EVB_STAGE%start-worker.cmd" "%EVB_ROOT%\worker\start-worker.cmd" >nul 2>&1
call :record worker-launcher-copy %ERRORLEVEL%
schtasks.exe /create /sc onlogon /tn "EVB Windows Test Worker" /tr "cmd.exe /c C:\EVBViewerTests\worker\start-worker.cmd" /ru EVBTester /rp "%EVB_SECRET%" /it /f >nul 2>&1
call :record logon-task-create %ERRORLEVEL%
>"%EVB_STATE%\system-bootstrap-complete.marker" echo complete

:stage
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%EVB_STAGE%node.zip' -DestinationPath '%EVB_ROOT%\node' -Force" >nul 2>&1
call :record node-expand %ERRORLEVEL%
copy /Y "%EVB_STAGE%guestWorker.cjs" "%EVB_ROOT%\worker\guestWorker.cjs" >nul 2>&1
call :record worker-copy %ERRORLEVEL%
copy /Y "%EVB_STAGE%guestWorker.cjs.map" "%EVB_ROOT%\worker\guestWorker.cjs.map" >nul 2>&1
call :record worker-map-copy %ERRORLEVEL%
schtasks.exe /create /sc onlogon /tn "EVB Windows Test Worker" /tr "cmd.exe /c C:\EVBViewerTests\worker\start-worker.cmd" /ru EVBTester /rp "%EVB_SECRET%" /it /f >nul 2>&1
call :record logon-task-refresh %ERRORLEVEL%
>"%EVB_STATE%\test-marker.json" echo {"imageId":"evb-win518-recovery","guestTestMarker":"system-startup"}
call :record test-marker-write %ERRORLEVEL%
exit /b 0

:record
>>"%EVB_MARKER%" echo step=%~1;exit=%~2
exit /b 0
