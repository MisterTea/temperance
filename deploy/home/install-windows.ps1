# Install Temperance as a Windows service. Run from a checkout in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\home\install-windows.ps1
# Data, settings and secrets: %ProgramData%\Temperance. Node.js runs under WinSW
# (https://github.com/winsw/winsw, MIT), which provides the service control handler.
$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrators")) {
  throw "Run from an elevated (Administrator) PowerShell"
}
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$data = Join-Path $env:ProgramData "Temperance"
$app = Join-Path $data "app"
$envFile = Join-Path $data "temperance.env"
$node = (Get-Command node -ErrorAction Stop).Source
if ([int](& $node -p "process.versions.node.split('.')[0]") -lt 24) { throw "Node.js 24 or newer is required" }

New-Item -ItemType Directory -Force $data | Out-Null
# Only SYSTEM and Administrators may read the secrets and the gateway key.
icacls $data /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

Push-Location "$repo\web"
try {
  npm ci --no-audit --no-fund
  $name = "temperance-gateway.win32-x64.node"
  if (-not (Test-Path "gateway-addon\$name")) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "Put the prebuilt gateway-addon\$name in web\, or install Rust" }
    npm run build:gateway
  }
  npm run build
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  Copy-Item -Recurse ".next\standalone" $app
  Copy-Item -Recurse ".next\static" "$app\.next\static"
  if (Test-Path "public") { Copy-Item -Recurse "public" "$app\public" }
} finally { Pop-Location }

function Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ([Convert]::ToBase64String($b)) -replace '[/+=]', ''
}
if (-not (Test-Path $envFile)) {
  (Get-Content "$repo\deploy\.env.example") `
    -replace '^TEMPERANCE_ADMIN_PASSWORD=.*', "TEMPERANCE_ADMIN_PASSWORD=$(Secret 18)" `
    -replace '^TEMPERANCE_GATEWAY_TOKEN=.*', "TEMPERANCE_GATEWAY_TOKEN=$(Secret 36)" |
    Where-Object { $_ -notmatch '^TEMPERANCE_DATA_DIR=' } | Set-Content -Encoding ascii $envFile
  Write-Host "Created $envFile with a generated admin password. Set TEMPERANCE_PUBLIC_URL and TEMPERANCE_VPN_ENDPOINT, then rerun this script."
}

$envXml = (Get-Content $envFile | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  "  <env name=`"$k`" value=`"$([Security.SecurityElement]::Escape($v))`"/>"
}) -join "`n"
$service = Join-Path $data "temperance-service.exe"
if (-not (Test-Path $service)) {
  Invoke-WebRequest "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe" -OutFile $service
}
@"
<service>
  <id>Temperance</id>
  <name>Temperance</name>
  <description>Temperance dashboard, policy API and WireGuard gateway</description>
  <executable>$node</executable>
  <arguments>"$app\server.js"</arguments>
  <workingdirectory>$app</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="TEMPERANCE_DATA_DIR" value="$data"/>
$envXml
  <onfailure action="restart" delay="3 sec"/>
  <log mode="roll"/>
  <logpath>$data\logs</logpath>
  <startmode>Automatic</startmode>
</service>
"@ | Set-Content -Encoding utf8 (Join-Path $data "temperance-service.xml")

if (Get-Service Temperance -ErrorAction SilentlyContinue) { & $service stop | Out-Null; & $service uninstall | Out-Null }
& $service install
& $service start
if (-not (Get-NetFirewallRule -DisplayName "Temperance WireGuard" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Temperance WireGuard" -Direction Inbound -Protocol UDP -LocalPort 51820 -Action Allow | Out-Null
}
Write-Host "Temperance is running: http://127.0.0.1:3000 (admin password in $envFile)."
Write-Host "Forward UDP 51820 on your router to this PC, and see docs\deployment.md for HTTPS."
