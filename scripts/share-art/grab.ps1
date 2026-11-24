param([Parameter(Mandatory = $true)][string]$Name)
# Takes the newest finished image in Downloads, converts it to PNG as art-src\<Name>.png, removes the download.
Add-Type -AssemblyName System.Drawing
$dl = Join-Path $env:USERPROFILE 'Downloads'
$dest = Join-Path 'D:\Code\Plugin\agy-lens\art-src' ($Name + '.png')
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
$deadline = (Get-Date).AddSeconds(30)
$file = $null
while ((Get-Date) -lt $deadline) {
  $file = Get-ChildItem $dl -File | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-3) -and $_.Extension -notin '.crdownload', '.docx', '.exe', '.ini' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($file) {
    $s1 = $file.Length; Start-Sleep -Milliseconds 700; $file.Refresh()
    if ($file.Length -eq $s1 -and $s1 -gt 0) { break }
  }
  Start-Sleep -Milliseconds 700
}
if (-not $file) { Write-Output 'NO_FILE'; exit 1 }
$img = [System.Drawing.Image]::FromFile($file.FullName)
try { $img.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png); $w = $img.Width; $h = $img.Height } finally { $img.Dispose() }
Remove-Item $file.FullName -Confirm:$false
Write-Output ("saved {0} {1}x{2} from {3}" -f $dest, $w, $h, $file.Name)
