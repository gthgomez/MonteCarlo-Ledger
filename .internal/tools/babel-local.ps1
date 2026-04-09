[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$CliArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
$current = (Resolve-Path $scriptDir).Path
while ($true) {
    if (Test-Path -LiteralPath (Join-Path $current 'Babel-private')) {
        break
    }

    $parent = Split-Path -Path $current -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
        throw 'Could not locate workspace root containing Babel-private.'
    }

    $current = $parent
}

$workspaceLauncher = Join-Path $current 'babel-local.ps1'
if (-not (Test-Path -LiteralPath $workspaceLauncher)) {
    throw "Workspace launcher not found at $workspaceLauncher"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $workspaceLauncher @CliArgs
exit $LASTEXITCODE