<#
.SYNOPSIS
  Install the `vid` binary from GitHub Releases.

.DESCRIPTION
  Windows PowerShell 5.1 and PowerShell 7+, no bash and no Git for Windows:

    irm https://raw.githubusercontent.com/ctxshift/video-feed/main/scripts/install.ps1 | iex

  Settings come from the environment rather than parameters, because a script
  piped into `iex` never gets to parse an argument list.

    $env:VID_VERSION     = 'v0.1.0'    # tag to install    (default: latest)
    $env:VID_INSTALL_DIR = 'C:\tools'  # where to put it   (default: %LOCALAPPDATA%\Programs\vid)
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still negotiates TLS 1.0 by default, which GitHub
# refuses. Harmless on 7+, where this is already the default.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Invoke-WebRequest spends most of a download repainting a progress bar.
$ProgressPreference = 'SilentlyContinue'

$Repo = 'ctxshift/video-feed'
$Version = if ($env:VID_VERSION) { $env:VID_VERSION } else { 'latest' }
$InstallDir = if ($env:VID_INSTALL_DIR) {
  $env:VID_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'Programs\vid'
}

function Info($msg) { Write-Host "  $msg" }
function Die($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# --- which build? -----------------------------------------------------------
# Only windows-x64 is published. On ARM64 that is still the right answer: the
# x64 emulator runs it, and there is no native build to prefer over it.
$procArch = $env:PROCESSOR_ARCHITECTURE
if ($procArch -eq 'ARM64') {
  Info 'arm64 Windows: installing the x64 build, which runs under emulation'
} elseif (-not [Environment]::Is64BitOperatingSystem) {
  Die 'vid needs 64-bit Windows. Build from source: https://github.com/ctxshift/video-feed'
}

$asset = 'vid-windows-x64.exe'
$base = if ($Version -eq 'latest') {
  "https://github.com/$Repo/releases/latest/download"
} else {
  "https://github.com/$Repo/releases/download/$Version"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("vid-" + [Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  # --- fetch ----------------------------------------------------------------
  Info "downloading $asset ($Version)"
  $downloaded = Join-Path $tmp $asset
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $downloaded -UseBasicParsing
  } catch {
    Die "no build published for windows-x64 at $Version ($($_.Exception.Message))"
  }

  # --- verify ---------------------------------------------------------------
  # A truncated download installs fine and then dies on first run, which is a
  # much worse failure than refusing to install.
  $sums = Join-Path $tmp 'SHA256SUMS'
  $haveSums = $true
  try {
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
  } catch {
    $haveSums = $false
    Info 'no SHA256SUMS published; skipping checksum'
  }

  if ($haveSums) {
    $want = $null
    foreach ($line in Get-Content $sums) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) {
        $want = $parts[0]
        break
      }
    }
    if (-not $want) { Die "$asset is not listed in SHA256SUMS" }

    $got = (Get-FileHash -Path $downloaded -Algorithm SHA256).Hash
    if ($got.ToUpperInvariant() -ne $want.ToUpperInvariant()) {
      Die "checksum mismatch for $asset (got $got, want $want)"
    }
    Info 'checksum ok'
  }

  # --- install --------------------------------------------------------------
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $target = Join-Path $InstallDir 'vid.exe'

  # Windows locks a running executable, so overwriting one in place fails. The
  # old file can be renamed out of the way even while running, and deleted on
  # the next install.
  if (Test-Path $target) {
    $stale = "$target.old"
    Remove-Item -Path $stale -Force -ErrorAction SilentlyContinue
    try {
      Move-Item -Path $target -Destination $stale -Force
    } catch {
      Die "$target is in use. Close any running vid and re-run."
    }
  }
  Move-Item -Path $downloaded -Destination $target -Force
  Remove-Item -Path "$target.old" -Force -ErrorAction SilentlyContinue

  Info "installed $target"
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- PATH -------------------------------------------------------------------
# Windows has no ~/.local/bin convention that is already on PATH, so an install
# that does not do this leaves a binary the user cannot run. User scope only:
# no elevation, and nothing outside this profile is touched.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
$already = @($entries | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') })

if ($already) {
  Info "$InstallDir already on PATH"
} else {
  $updated = ((@($entries) + $InstallDir) -join ';')
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  Info "added $InstallDir to your user PATH"
  Info 'open a new terminal for that to take effect'
}

# Make it usable in this session too, without waiting for a new terminal.
if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') })) {
  $env:Path = "$env:Path;$InstallDir"
}

# --- check ------------------------------------------------------------------
$target = Join-Path $InstallDir 'vid.exe'
$version = & $target --version 2>$null
if ($LASTEXITCODE -ne 0 -or -not $version) { Die 'installed binary does not run' }

Write-Host ''
Info "vid $version"
Info 'Next: vid config --init'
Write-Host ''
Info 'vid also needs three external tools:'
Info '  winget install --id=astral-sh.uv     # runs the transcription sidecar'
Info '  uv tool install yt-dlp               # downloading'
Info '  winget install Gyan.FFmpeg           # audio handling'
