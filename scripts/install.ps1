param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "Aoike123/antigravity-pulse"
$PluginName = "antigravity-pulse"
$PluginsRoot = Join-Path $HOME ".gemini\config\plugins"
$TargetDir = Join-Path $PluginsRoot $PluginName

if ($Version) {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  $Url = "https://github.com/$Repo/releases/download/$Tag/$PluginName-$Tag.zip"
} else {
  $Url = "https://github.com/$Repo/releases/latest/download/$PluginName.zip"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pulse-install-" + [Guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempDir "$PluginName.zip"
$ExtractDir = Join-Path $TempDir "extract"
$BackupDir = "$TargetDir.bak-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)

try {
  New-Item -ItemType Directory -Force -Path $TempDir, $ExtractDir, $PluginsRoot | Out-Null
  Write-Host "Downloading Pulse ($Url)..." -ForegroundColor Cyan
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

  Write-Host ""
  Write-Host "Pulse installed to: $TargetDir" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps / 接下来只需 3 步:" -ForegroundColor White
  Write-Host "  1. Restart Antigravity 2.0 / 重启 Antigravity"
  Write-Host "  2. Open Customizations -> Installed, and enable 'Pulse' / 在设置 Customizations -> Installed 中启用 Pulse"
  Write-Host "  3. Open any conversation and open 'Pulse' in the right-side pane / 打开任意对话，在右侧边栏打开 Pulse"

  $OldDir = Join-Path $PluginsRoot "desktop-context"
  if (Test-Path $OldDir) {
    Write-Host ""
    Write-Host "Note: Legacy folder found at $OldDir. Remove or disable it to avoid duplicate panels." -ForegroundColor Yellow
  }
} finally {
  if (Test-Path $TempDir) {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
