param(
  [string]$Version = "",
  [switch]$DryRun,
  [switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PositionalArgs = @()
if ($Version) { $PositionalArgs += $Version }
if ($RemainingArgs) { $PositionalArgs += $RemainingArgs }

$ResolvedVersion = ""
foreach ($Arg in $PositionalArgs) {
  if ($Arg -eq "--dry-run" -or $Arg -eq "-n") {
    $DryRun = $true
  } elseif ($Arg -eq "--help" -or $Arg -eq "-h") {
    $Help = $true
  } elseif ($Arg.StartsWith("-")) {
    throw "Unknown option: $Arg"
  } elseif (-not $ResolvedVersion) {
    $ResolvedVersion = $Arg
  } else {
    throw "Unexpected argument: $Arg"
  }
}
$Version = $ResolvedVersion

$Repo = "Aoike123/agy-lens"
$PluginName = "agy-lens"
$PluginsRoot = Join-Path $HOME ".gemini\config\plugins"
$TargetDir = Join-Path $PluginsRoot $PluginName
$LegacyPulseDir = Join-Path $PluginsRoot "antigravity-pulse"
$LegacyDesktopDir = Join-Path $PluginsRoot "desktop-context"

if ($Help) {
  Write-Host "Agy Lens ($PluginName) Installer"
  Write-Host ""
  Write-Host "Usage:"
  Write-Host "  install.ps1 [-Version <version>] [-DryRun]"
  Write-Host "  install.ps1 [--dry-run] [version]"
  return
}

if ($Version) {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  $Url = "https://github.com/$Repo/releases/download/$Tag/$PluginName-$Tag.zip"
} else {
  $Url = "https://github.com/$Repo/releases/latest/download/$PluginName.zip"
}

if ($DryRun) {
  Write-Host "[dry-run] Agy Lens installer"
  Write-Host "[dry-run] Repository:   $Repo"
  Write-Host "[dry-run] Download URL: $Url"
  Write-Host "[dry-run] Target dir:   $TargetDir"
  if ((Test-Path $LegacyPulseDir) -and ($LegacyPulseDir -ne $TargetDir)) {
    Write-Host "[dry-run] Would remove legacy install: $LegacyPulseDir"
  }
  if (Test-Path $LegacyDesktopDir) {
    Write-Host "[dry-run] Note: Legacy folder exists at $LegacyDesktopDir"
  }
  return
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-lens-install-" + [Guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempDir "$PluginName.zip"
$ExtractDir = Join-Path $TempDir "extract"
$BackupDir = "$TargetDir.bak-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)

try {
  New-Item -ItemType Directory -Force -Path $TempDir, $ExtractDir, $PluginsRoot | Out-Null
  Write-Host "Downloading Agy Lens ($Url)..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

  Write-Host "Extracting package..." -ForegroundColor Cyan
  Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

  $SourceDir = Join-Path $ExtractDir $PluginName
  if (-not (Test-Path (Join-Path $SourceDir "plugin.json"))) {
    throw "Invalid package: missing $PluginName/plugin.json"
  }

  $MovedBackup = $false
  if (Test-Path $TargetDir) {
    Move-Item -Path $TargetDir -Destination $BackupDir -Force
    $MovedBackup = $true
  }
  try {
    Move-Item -Path $SourceDir -Destination $TargetDir -Force
    if ($MovedBackup -and (Test-Path $BackupDir)) {
      Remove-Item -Path $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
    if ($MovedBackup -and -not (Test-Path $TargetDir) -and (Test-Path $BackupDir)) {
      Move-Item -Path $BackupDir -Destination $TargetDir -Force -ErrorAction SilentlyContinue
    }
    throw
  }

  if ((Test-Path $LegacyPulseDir) -and ($LegacyPulseDir -ne $TargetDir)) {
    Remove-Item -Path $LegacyPulseDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed legacy plugin folder: $LegacyPulseDir" -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "Agy Lens installed to: $TargetDir" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps / 接下来只需 3 步:" -ForegroundColor White
  Write-Host "  1. Restart Antigravity 2.0 / 重启 Antigravity"
  Write-Host "  2. Open Customizations -> Installed, and enable 'Agy Lens' / 在设置 Customizations -> Installed 中启用 Agy Lens"
  Write-Host "  3. Open any conversation and open 'Agy Lens' in the right-side pane / 打开任意对话，在右侧边栏打开 Agy Lens"

  if (Test-Path $LegacyDesktopDir) {
    Write-Host ""
    Write-Host "Note: Legacy folder found at $LegacyDesktopDir. Remove or disable it to avoid duplicate panels." -ForegroundColor Yellow
  }
} finally {
  if (Test-Path $TempDir) {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
