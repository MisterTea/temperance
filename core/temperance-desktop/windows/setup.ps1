# Run by the installer as an administrator: installs WireGuard for Windows if it
# is missing, and creates the data directory that only SYSTEM and administrators
# may read (it holds the device's private key and token).
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$wireguard = Join-Path $programFiles 'WireGuard\wireguard.exe'
if ($Uninstall) {
    # wireguard.exe returns before the service is gone; the uninstaller must not finish first.
    # Without the service (a parent's computer) it shows an error and waits for a click.
    if ((Test-Path $wireguard) -and (Get-Service 'WireGuardTunnel$temperance' -ErrorAction SilentlyContinue)) {
        Start-Process $wireguard -ArgumentList '/uninstalltunnelservice', 'temperance' -Wait -WindowStyle Hidden
        for ($i = 0; $i -lt 30 -and (Get-Service 'WireGuardTunnel$temperance' -ErrorAction SilentlyContinue); $i++) {
            Start-Sleep 1
        }
    }
    exit 0
}
if (-not (Test-Path $wireguard)) {
    winget install --id WireGuard.WireGuard --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    if (-not (Test-Path $wireguard)) { throw 'WireGuard installation failed. Install it from wireguard.com, then run Temperance.' }
}
$dir = Join-Path $env:ProgramData 'Temperance'
New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the Temperance data directory' }
