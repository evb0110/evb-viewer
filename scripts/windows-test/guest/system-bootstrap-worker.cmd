@echo off
setlocal EnableExtensions
set "EVB_ROOT=C:\EVBViewerTests"
set "EVB_STAGE=%~dp0"
set "EVB_STATE=%EVB_ROOT%\state"
set "EVB_MARKER=%EVB_STATE%\system-bootstrap.marker"
set "EVB_FAILURE=0"
if not exist "%EVB_STATE%" mkdir "%EVB_STATE%" >nul 2>&1
if not exist "%EVB_ROOT%\worker" mkdir "%EVB_ROOT%\worker" >nul 2>&1
if not exist "%EVB_ROOT%\node" mkdir "%EVB_ROOT%\node" >nul 2>&1
if not exist "%EVB_STAGE%test-account.secret" (
  >"%EVB_MARKER%" echo step=read-secret;exit=2
  exit /b 2
)
findstr /c:"complete=v2" "%EVB_STATE%\system-bootstrap-complete.marker" >nul 2>&1
if errorlevel 1 goto configure
goto stage

:configure
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$secret=(Get-Content -LiteralPath '%EVB_STAGE%test-account.secret' -Raw).Trim(); $secure=[System.Net.NetworkCredential]::new('', $secret).SecurePassword; $user=Get-LocalUser -Name EVBTester -ErrorAction SilentlyContinue; if ($null -eq $user) { New-LocalUser -Name EVBTester -Password $secure -AccountNeverExpires -PasswordNeverExpires | Out-Null } else { Set-LocalUser -Name EVBTester -Password $secure }; Add-LocalGroupMember -Group Users -Member EVBTester -ErrorAction SilentlyContinue; Remove-LocalGroupMember -Group Administrators -Member EVBTester -ErrorAction SilentlyContinue; New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon -Value 1 -Type String; Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultUserName -Value EVBTester -Type String; Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultPassword -Value $secret -Type String; Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultDomainName -Value . -Type String" >nul 2>&1
call :record account-and-autologon %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" /v DevicePasswordLessBuildVersion /t REG_DWORD /d 0 /f >nul 2>&1
call :record passwordless-device-disabled %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Policies\Microsoft\Windows\OOBE" /v DisablePrivacyExperience /t REG_DWORD /d 1 /f >nul 2>&1
call :record oobe-privacy-disabled %ERRORLEVEL%
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v EnableFirstLogonAnimation /t REG_DWORD /d 0 /f >nul 2>&1
call :record first-logon-animation-disabled %ERRORLEVEL%
reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonCount >nul 2>&1
if errorlevel 1 goto auto-logon-count-absent
reg.exe delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonCount /f >nul 2>&1
call :record auto-logon-count-removed %ERRORLEVEL%
goto auto-logon-count-recorded
:auto-logon-count-absent
>>"%EVB_MARKER%" echo step=auto-logon-count-absent;exit=observed
:auto-logon-count-recorded
reg.exe add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableLockWorkstation /t REG_DWORD /d 1 /f >nul 2>&1
call :record disable-lock-on-resume %ERRORLEVEL%
goto stage

:stage
if "%EVB_FAILURE%"=="1" (
  >>"%EVB_MARKER%" echo step=configure-failed;exit=1
  exit /b 1
)
for %%F in (node.zip guestWorker.cjs guestWorker.cjs.map start-worker.cmd test-account.secret) do if not exist "%EVB_STAGE%%%F" (
  >>"%EVB_MARKER%" echo step=required-artifact-%%F;exit=2
  set "EVB_FAILURE=1"
)
if "%EVB_FAILURE%"=="1" exit /b 2
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%EVB_STAGE%node.zip' -DestinationPath '%EVB_ROOT%\node' -Force" >nul 2>&1
call :record node-expand %ERRORLEVEL%
if not exist "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" call :record node-executable-missing 2
copy /Y "%EVB_STAGE%guestWorker.cjs" "%EVB_ROOT%\worker\guestWorker.cjs" >nul 2>&1
call :record worker-copy %ERRORLEVEL%
copy /Y "%EVB_STAGE%guestWorker.cjs.map" "%EVB_ROOT%\worker\guestWorker.cjs.map" >nul 2>&1
call :record worker-map-copy %ERRORLEVEL%
xcopy /E /I /Y "%EVB_STAGE%powershell" "%EVB_ROOT%\worker\powershell" >nul 2>&1
call :record powershell-copy %ERRORLEVEL%
if not exist "%EVB_ROOT%\worker\powershell\start-worker-logon.ps1" call :record logon-entrypoint-missing 2
if not exist "C:\Users\EVBTester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup" mkdir "C:\Users\EVBTester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup" >nul 2>&1
copy /Y "%EVB_ROOT%\worker\start-worker.cmd" "C:\Users\EVBTester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\start-worker.cmd" >nul 2>&1
call :record user-startup-launcher-copy %ERRORLEVEL%
query user >"%EVB_STATE%\system-session.log" 2>&1
if errorlevel 1 (
  >>"%EVB_MARKER%" echo step=query-user;exit=observed-no-session
) else (
  call :record query-user 0
)
>"%EVB_STATE%\test-marker.json" echo {"imageId":"evb-win518-recovery","guestTestMarker":"system-startup"}
if exist "%EVB_STATE%\test-marker.json" (
  call :record test-marker-write 0
) else (
  call :record test-marker-write 1
)
copy /Y "%EVB_STAGE%start-worker.cmd" "%EVB_ROOT%\worker\start-worker.cmd" >nul 2>&1
call :record worker-launcher-copy %ERRORLEVEL%
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%EVB_ROOT%\worker\powershell\register-worker-logon-task.ps1" -UserName EVBTester -NodeExecutable "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" -WorkerScript "%EVB_ROOT%\worker\guestWorker.cjs" -GuestRoot "%EVB_ROOT%" -WorkingDirectory "%EVB_ROOT%\worker" >"%EVB_STATE%\register-worker-logon.stdout.log" 2>"%EVB_STATE%\register-worker-logon.stderr.log"
call :record register-worker-logon %ERRORLEVEL%
if exist "%EVB_STATE%\register-worker-logon.stderr.log" type "%EVB_STATE%\register-worker-logon.stderr.log" >>"%EVB_MARKER%"
>"%EVB_STATE%\boot-diagnostic.log" (
  echo [qemu-ga service]
  sc query qemu-ga
  sc qc qemu-ga
  echo [qemu-ga executable lookup]
  where qemu-ga.exe
  echo [qemu-ga version]
  for /f "delims=" %%P in ('where qemu-ga.exe 2^>nul') do "%%P" --version
  echo [interactive sessions]
  query user
  echo [worker task]
  schtasks.exe /query /tn "EVB Windows Test Worker" /v /fo list
  echo [winlogon policy]
  reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon
  reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultUserName
  reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultDomainName
  reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonCount
  reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonSID
  reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v ForceAutoLogon
  reg.exe query "HKLM\SECURITY\Policy\Secrets\DefaultPassword" >nul 2>&1 && echo DefaultPasswordSecret present || echo DefaultPasswordSecret absent
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$w=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue; $d=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' -ErrorAction SilentlyContinue; $u=Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue; $os=Get-CimInstance Win32_OperatingSystem; [ordered]@{DefaultPasswordExists=$null -ne $w.DefaultPassword; DevicePasswordLessBuildVersion=[string]$d.DevicePasswordLessBuildVersion; CurrentAccountPrincipalSource=if($u){[string]$u.PrincipalSource}else{'unknown'}; CurrentAccountPasswordRequired=if($u){[bool]$u.PasswordRequired}else{$null}; LastBootUpTime=[DateTime]$os.LastBootUpTime} | ConvertTo-Json -Compress"
)
call :record boot-diagnostic 0
if "%EVB_FAILURE%"=="1" exit /b 1
>"%EVB_STATE%\system-bootstrap-complete.marker" echo complete=v2
exit /b 0

:record
>>"%EVB_MARKER%" echo step=%~1;exit=%~2
if not "%~2"=="0" set "EVB_FAILURE=1"
exit /b 0
