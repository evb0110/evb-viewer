<#
.SYNOPSIS
    Holds an exclusive handle on a file for a bounded time so a save can be observed under denial.
.DESCRIPTION
    WIN-SAVE-04 needs a real sharing violation, not a simulated one. The script opens the file with
    FileShare::None, writes the ready file so the case can synchronize, then releases the handle after
    the requested duration or as soon as "<ReadyFile>.release" appears. The duration is bounded so a
    crashed case cannot leave a file locked forever.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 600)]
    [int]$DurationSeconds,

    [Parameter(Mandatory = $true)]
    [string]$ReadyFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    [Console]::Error.WriteLine("File not found: $Path")
    exit 2
}

$releaseFile = "$ReadyFile.release"
$readyDirectory = Split-Path -Parent $ReadyFile
if ($readyDirectory -and -not (Test-Path -LiteralPath $readyDirectory)) {
    New-Item -ItemType Directory -Path $readyDirectory -Force | Out-Null
}
if (Test-Path -LiteralPath $releaseFile) {
    Remove-Item -LiteralPath $releaseFile -Force
}

$stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None)
try {
    Set-Content -LiteralPath $ReadyFile -Value ((Get-Date).ToUniversalTime().ToString('o')) -Encoding UTF8
    $deadline = (Get-Date).AddSeconds($DurationSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $releaseFile) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
}
finally {
    $stream.Close()
    $stream.Dispose()
}

ConvertTo-Json -InputObject ([ordered]@{
    path      = $Path
    heldUntil = (Get-Date).ToUniversalTime().ToString('o')
    released  = $true
}) -Depth 3 -Compress
exit 0
