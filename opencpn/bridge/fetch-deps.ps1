# Fetch build dependencies for ocpn_bridge_pi (not committed to git).
# Layout after running: ..\ocpn-bridge-libs (OpenCPN plugin API), .\cache\wxWidgets.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not (Test-Path "$root\..\ocpn-bridge-libs\api-18\ocpn_plugin.h")) {
  git clone --depth 1 https://github.com/OpenCPN/opencpn-libs.git "$root\..\ocpn-bridge-libs"
}

$wx = "$root\cache\wxWidgets"
if (-not (Test-Path "$wx\include\wx")) {
  New-Item -ItemType Directory -Force "$root\cache" | Out-Null
  $base = "https://github.com/wxWidgets/wxWidgets/releases/download/v3.2.6"
  Invoke-WebRequest "$base/wxWidgets-3.2.6-headers.7z" -OutFile "$root\cache\wx-headers.7z"
  Invoke-WebRequest "$base/wxMSW-3.2.6_vc14x_Dev.7z" -OutFile "$root\cache\wx-dev.7z"
  $7z = "C:\Program Files\7-Zip\7z.exe"
  if (-not (Test-Path $7z)) { throw "need 7-Zip (or the standalone 7zr.exe from 7-zip.org)" }
  & $7z x -aoa "$root\cache\wx-headers.7z" "-o$wx" | Out-Null
  & $7z x -aoa "$root\cache\wx-dev.7z" "-o$wx" | Out-Null
  Rename-Item "$wx\lib\vc14x_dll" "vc_dll"
}
Write-Output "deps ready: ..\ocpn-bridge-libs + cache\wxWidgets"
