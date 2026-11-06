# Installs a peel command and a Start menu entry for this checkout on Windows.
# Run it with: powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot

$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCommand) { $bun = $bunCommand.Source }
elseif (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") { $bun = "$env:USERPROFILE\.bun\bin\bun.exe" }
else { Write-Host 'Install Bun before installing Peel.'; exit 1 }

Push-Location $project
try {
  & $bun install --frozen-lockfile
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally { Pop-Location }

# A release install (bun src/update.ts install) sets PEEL_RELEASE_ROOT. Its launcher starts whichever
# version current names, so updates need no new launcher. The icon is copied there, because old
# versions are removed after an update.
$releaseRoot = $env:PEEL_RELEASE_ROOT
$assets = Join-Path $project 'assets'
if ($releaseRoot) {
  $assets = Join-Path $releaseRoot 'assets'
  New-Item -ItemType Directory -Force -Path $assets | Out-Null
  Copy-Item (Join-Path $project 'assets\peel.*') $assets -Force
}

$bin = Join-Path $env:LOCALAPPDATA 'Peel\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$launcher = Join-Path $bin 'peel.cmd'
if ((Test-Path $launcher) -and -not (Select-String -Path $launcher -Pattern '^rem Peel launcher' -Quiet)) {
  Write-Host "An existing $launcher belongs to another program. Leaving it in place."
  exit 1
}
# chcp switches cmd to UTF-8 before it reads the paths, so folders with any name work.
# Batch files treat % as a variable marker, so a literal % is doubled.
if ($releaseRoot) {
  $root = $releaseRoot.Replace('%', '%%')
  $start = @(
    'set "PEEL_VERSION="',
    ('set /p PEEL_VERSION=<"{0}\current"' -f $root),
    ('cd /d "{0}\versions\%PEEL_VERSION%"' -f $root),
    # Every version shares one engine download.
    ('set "PEEL_ELECTRON_DIR={0}\electron"' -f $root)
  )
} else {
  $start = @(('cd /d "{0}"' -f $project.Replace('%', '%%')))
}
$lines = @('@echo off', 'rem Peel launcher', 'setlocal', 'chcp 65001 >nul') + $start + @(('"{0}" src\index.ts %*' -f $bun.Replace('%', '%%')))
[System.IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding $false))

# New terminals find peel once its folder is on the user's PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $bin)) {
  $newPath = if ($userPath) { "$userPath;$bin" } else { $bin }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}

# Windows Terminal shows Peel's colours and Unicode symbols. The older console host is the fallback.
$description = 'Search your Apple Music library and control playback'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Peel.lnk'
$shell = New-Object -ComObject WScript.Shell
if ((Test-Path $shortcutPath) -and $shell.CreateShortcut($shortcutPath).Description -ne $description) {
  Write-Host "An existing $shortcutPath belongs to another program. Leaving it in place."
  exit 1
}
$shortcut = $shell.CreateShortcut($shortcutPath)
$terminal = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($terminal) {
  $shortcut.TargetPath = $terminal.Source
  $shortcut.Arguments = ('--title Peel "{0}"' -f $launcher)
} else {
  $shortcut.TargetPath = $launcher
  $shortcut.Arguments = ''
}
$shortcut.WorkingDirectory = if ($releaseRoot) { $releaseRoot } else { $project }
$shortcut.Description = $description
$shortcut.IconLocation = Join-Path $assets 'peel.ico'
$shortcut.Save()

Write-Host "Installed $launcher and the Peel Start menu entry. Open a new terminal, run peel --connect once, then peel."
