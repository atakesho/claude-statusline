<#
.SYNOPSIS
  Installs the Claude Code statusline on Windows.

.DESCRIPTION
  Copies statusline-command.js into the Claude config directory and points
  settings.json at it. Requires Node.js on PATH (Claude Code needs it anyway).
  settings.json is backed up before it is rewritten and only its "statusLine"
  key is touched. No admin rights, no PATH changes, nothing outside the
  Claude config directory.

.PARAMETER Uninstall
  Removes the statusLine entry, the installed script and the usage cache.

.PARAMETER DryRun
  Prints what would change and writes nothing.

.PARAMETER NodePath
  Writes the absolute path of this Node.js into settings.json instead of the
  bare "node". Use it when Claude Code launches with a different PATH.

.PARAMETER Force
  With -Uninstall, removes a statusLine entry even when another tool owns it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$NodePath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $scriptDir 'install.js'
$statusline = Join-Path $scriptDir 'statusline-command.js'

if (-not (Test-Path -LiteralPath $installer)) {
  Write-Error "install.js not found in $scriptDir. Run this from the cloned repository."
}
if (-not (Test-Path -LiteralPath $statusline)) {
  Write-Error "statusline-command.js not found in $scriptDir. Run this from the cloned repository."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js was not found on PATH. Install it from https://nodejs.org (no admin rights needed for the .zip build), then re-run this script."
}

# No stderr redirection here: in PowerShell 5.1 redirecting a native command's
# stderr turns each line into a NativeCommandError, and $ErrorActionPreference
# = 'Stop' then kills the install even though node exited 0.
$version = & node --version
if ($LASTEXITCODE -ne 0) {
  Write-Error "node --version failed with exit code $LASTEXITCODE."
}
$version = ($version | Select-Object -First 1 | Out-String).Trim()
Write-Host "node: $($node.Source) $version"

# Fail closed: an unparseable version is treated as unsupported, not as "probably fine".
if ($version -match '^v(\d+)\.') {
  if ([int]$Matches[1] -lt 18) {
    Write-Error "Node.js 18 or newer is required (found $version)."
  }
} else {
  Write-Error "Could not read the Node.js version (got: '$version'). Install Node.js 18+ from https://nodejs.org and re-run."
}

$argsList = @($installer)
if ($Uninstall) { $argsList += '--uninstall' }
if ($DryRun)    { $argsList += '--dry-run' }
if ($NodePath)  { $argsList += '--node-path' }
if ($Force)     { $argsList += '--force' }

& node @argsList
if ($LASTEXITCODE -ne 0) {
  Write-Error "install.js exited with code $LASTEXITCODE."
}

if (-not $Uninstall -and -not $DryRun) {
  Write-Host ''
  Write-Host 'If the bars stay hidden, check these in order:' -ForegroundColor Cyan
  Write-Host '  1. Claude Code is logged in with a claude.ai account (API-key setups have no usage data).'
  Write-Host '  2. Behind a corporate proxy, HTTPS_PROXY is set in the environment Claude Code runs in.'
  Write-Host '  3. Run it by hand to see the raw output:'
  Write-Host '     echo {} | node "$env:USERPROFILE\.claude\statusline-command.js"'
}
