<#
.SYNOPSIS
    Verifies and repairs the QEMU guest agent Windows service.
.DESCRIPTION
    Run this helper through the guest agent before changing accounts or
    rebooting a copied image. It records only service state, recovery actions,
    and event identifiers. It does not include event text or secrets.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $service = Get-CimInstance Win32_Service -Filter "Name='qemu-ga'"
    if ($null -eq $service) {
        [Console]::Error.WriteLine('The QEMU guest agent service is not installed.')
        exit 2
    }

    Set-Service -Name qemu-ga -StartupType Automatic
    Start-Service -Name qemu-ga -ErrorAction SilentlyContinue
    $failureOutput = @(sc.exe failure qemu-ga actions= restart/60000/restart/60000/0 reset= 86400)
    $eventIds = @(Get-WinEvent -FilterHashtable @{LogName = 'System'; ProviderName = 'QEMU-GA'} -MaxEvents 20 -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    [pscustomobject]@{
        status = 'ready'
        service = [pscustomobject]@{
            state = (Get-Service -Name qemu-ga).Status.ToString()
            startupType = (Get-CimInstance Win32_Service -Filter "Name='qemu-ga'").StartMode
        }
        recovery = @($failureOutput | Where-Object { $_ -match 'FAILURE|RESTART|RESET|SERVICE_NAME' } | ForEach-Object { $_.Trim() })
        eventIds = $eventIds
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
} catch {
    [Console]::Error.WriteLine("Could not repair the QEMU guest agent service: $($_.Exception.ToString())")
    exit 3
}
