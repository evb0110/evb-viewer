<#
.SYNOPSIS
    Creates or repairs the isolated Windows test account.
.DESCRIPTION
    Run this helper as an administrator during image recovery. The password is
    read from standard input so it never appears in the command line or the
    helper's output. The worker refuses administrator tokens, so this helper
    removes the account from Administrators and leaves it in Users.

    The account must still receive an interactive logon before the worker can
    start. This helper does not configure personal-account autologon.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z][A-Za-z0-9._-]{0,31}$')]
    [string]$UserName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$secretText = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($secretText)) {
    [Console]::Error.WriteLine('A non-empty test-account password is required on standard input.')
    exit 2
}

try {
    $secureSecret = [System.Net.NetworkCredential]::new('', $secretText).SecurePassword
    $user = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
    if ($null -eq $user) {
        $newUserArguments = @{
            Name = $UserName
            Password = $secureSecret
            AccountNeverExpires = $true
            PasswordNeverExpires = $true
        }
        New-LocalUser @newUserArguments | Out-Null
    } else {
        $setUserArguments = @{
            Name = $UserName
            Password = $secureSecret
        }
        Set-LocalUser @setUserArguments
    }
    Add-LocalGroupMember -Group Users -Member $UserName -ErrorAction SilentlyContinue
    Remove-LocalGroupMember -Group Administrators -Member $UserName -ErrorAction SilentlyContinue
    [pscustomobject]@{
        status = 'ready'
        account = $UserName
        standard = $true
    } | ConvertTo-Json -Compress
    exit 0
} catch {
    [Console]::Error.WriteLine("Could not prepare the standard test account: $($_.Exception.Message)")
    exit 3
}
