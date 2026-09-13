@echo off
setlocal
set "EVB_ROOT=C:\EVBViewerTests"
set "EVB_STAGE=%~dp0"
if not exist "%EVB_ROOT%\state" mkdir "%EVB_ROOT%\state"
if not exist "%EVB_ROOT%\worker" mkdir "%EVB_ROOT%\worker"
if not exist "%EVB_ROOT%\node" mkdir "%EVB_ROOT%\node"
if /I not "%USERNAME%"=="EVBTester" if exist "%EVB_STAGE%test-account.secret" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$secret=(Get-Content -LiteralPath '%EVB_STAGE%test-account.secret' -Raw).Trim(); $secure=[System.Net.NetworkCredential]::new('', $secret).SecurePassword; if (-not (Get-LocalUser -Name EVBTester -ErrorAction SilentlyContinue)) { New-LocalUser -Name EVBTester -Password $secure -AccountNeverExpires -PasswordNeverExpires | Out-Null } else { Set-LocalUser -Name EVBTester -Password $secure }; Add-LocalGroupMember -Group Users -Member EVBTester -ErrorAction SilentlyContinue; Remove-LocalGroupMember -Group Administrators -Member EVBTester -ErrorAction SilentlyContinue; reg.exe add 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' /v AutoAdminLogon /t REG_SZ /d 1 /f; reg.exe add 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' /v DefaultUserName /t REG_SZ /d EVBTester /f; reg.exe add 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' /v DefaultPassword /t REG_SZ /d $secret /f; shutdown.exe /r /t 5"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%EVB_STAGE%node.zip' -DestinationPath '%EVB_ROOT%\node' -Force"
copy /Y "%EVB_STAGE%guestWorker.cjs" "%EVB_ROOT%\worker\guestWorker.cjs" >nul
copy /Y "%EVB_STAGE%guestWorker.cjs.map" "%EVB_ROOT%\worker\guestWorker.cjs.map" >nul
>"%EVB_ROOT%\state\test-marker.json" echo {"imageId":"evb-win518-recovery","guestTestMarker":"autostart"}
>"%EVB_ROOT%\state\autostart-marker.json" echo {"schemaVersion":1,"status":"started"}
if /I not "%USERNAME%"=="EVBTester" exit /b 0
start "EVB Windows Test Worker" /b "%EVB_ROOT%\node\node-v22.23.2-win-arm64\node.exe" "%EVB_ROOT%\worker\guestWorker.cjs" 1>"%EVB_ROOT%\state\autostart-worker.log" 2>&1
exit /b 0
