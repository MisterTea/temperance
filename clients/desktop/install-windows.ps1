# Run in an elevated PowerShell session. Requires the binary built from this repository.
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run PowerShell as Administrator to install the VPN app.' }
if (-not (Test-Path "$env:ProgramFiles\WireGuard\wireguard.exe")) {
    winget install --id WireGuard.WireGuard --exact --source winget
    if ($LASTEXITCODE -ne 0) { throw 'WireGuard installation failed' }
}
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$dir = Join-Path $env:ProgramData 'Temperance'
New-Item -ItemType Directory -Force $dir | Out-Null
# Private keys and enrollment tokens may be read only by SYSTEM and administrators.
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure application directory' }
Copy-Item (Join-Path $PSScriptRoot "..\..\build\temperance-windows-$arch.exe") (Join-Path $dir 'temperance.exe') -Force
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Temperance.lnk'))
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-NoProfile -Command Start-Process -Verb RunAs -FilePath '$dir\temperance.exe' -ArgumentList '--data', '$dir'"
$shortcut.Save()
Write-Host 'Launch Temperance as administrator, open its printed localhost URL, enroll, then Install / start VPN. The WireGuard tunnel service starts at boot.'
