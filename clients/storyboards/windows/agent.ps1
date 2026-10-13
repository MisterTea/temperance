# Runs in the Windows VM's desktop session, elevated (the app is), for
# clients/storyboards/drivers/windows.mjs: long-polls the harness for commands,
# acts through UI Automation and the real mouse and keyboard, and records the
# screen with ffmpeg.
param([Parameter(Mandatory)][string]$Base)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  // The visible frame, without the invisible resize borders.
  public static RECT Frame(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))); return r; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll")] static extern int EnumDisplaySettings(string d, int mode, ref DEVMODE dm);
  [DllImport("user32.dll")] static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  public static int Resolution(int w, int h) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
    EnumDisplaySettings(null, -1, ref dm);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettings(ref dm, 0);
  }
}
"@
[Native]::SetProcessDPIAware() | Out-Null
$A = [System.Windows.Automation.AutomationElement]
$Tree = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition
$exe = Join-Path $env:ProgramW6432 'Temperance\temperance.exe'
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) { $ffmpeg = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe | Select-Object -First 1 -ExpandProperty FullName }
$recorder = $null
$typed = $false

function AppWindows {
    $ids = @(Get-Process temperance -ErrorAction SilentlyContinue | ForEach-Object Id)
    # UIA throws while a window is being rebuilt; callers retry.
    $all = try { @($A::RootElement.FindAll($Tree::Children, $True_)) } catch { @() }
    $all | Where-Object { try { $ids -contains $_.Current.ProcessId } catch { $false } }
}
function Window($name) {
    $all = @(AppWindows)
    if ($name -eq 'dashboard') { return $all | Where-Object { $_.Current.Name -like '*dashboard*' } | Select-Object -First 1 }
    return $all | Where-Object { $_.Current.Name -notlike '*dashboard*' } | Select-Object -First 1
}
function Matches($e, $c) {
    $name = $e.Current.Name
    if (-not $name) { return $false }
    # Labels name their field, hint text included.
    if ($c.field) { return $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and ($name -eq $c.field -or $name.StartsWith("$($c.field) ")) }
    if ($c.regex) {
        $options = if ($c.flags -match 'i') { 'IgnoreCase' } else { 'None' }
        return [regex]::IsMatch($name, $c.regex, $options)
    }
    # A button's name includes the description inside it.
    return $name -eq $c.text -or $name.StartsWith("$($c.text) ")
}
function Find($c, [double]$timeout) {
    $end = (Get-Date).AddSeconds($timeout)
    $scrolled = 0
    while ($true) {
        $windows = if ($c.window) { @(Window $c.window) } else { @(AppWindows) | Sort-Object { $_.Current.Name -like '*dashboard*' } }
        foreach ($w in $windows) {
            if (-not $w) { continue }
            # UIA throws while WebView2 rebuilds its tree; that's "not yet".
            $hits = try { @($w.FindAll($Tree::Descendants, $True_) | Where-Object { Matches $_ $c }) } catch { @() }
            # The control itself rather than a wrapper with the same name; otherwise the first on the page
            # (Sort-Object is not stable in Windows PowerShell, so keep document order explicitly).
            $order = 0
            $hit = $hits | ForEach-Object { [pscustomobject]@{ e = $_; i = $order++ } } |
                Sort-Object { $_.e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -and $_.e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit }, i |
                Select-Object -First 1 -ExpandProperty e
            if ($hit) {
                if ($hit.Current.IsOffscreen) {
                    $scroll = $null
                    if ($hit.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) { $scroll.ScrollIntoView(); Start-Sleep -Milliseconds 400 }
                }
                # WebView2 often lacks ScrollItemPattern: wheel the page until the control is inside the window.
                $r = $hit.Current.BoundingRectangle
                $view = $w.Current.BoundingRectangle
                $wheel = if ($r.Bottom -gt $view.Bottom - 12) { -120 } elseif ($r.Top -lt $view.Top + 40) { 120 } else { 0 }
                if ($wheel -and -not $r.IsEmpty -and $scrolled -lt 15) {
                    [Native]::SetCursorPos([int]($view.X + $view.Width / 2), [int]($view.Y + $view.Height / 2)) | Out-Null
                    [Native]::mouse_event(0x800, 0, 0, [uint32][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$wheel), 0), [IntPtr]::Zero)
                    $scrolled++
                    Start-Sleep -Milliseconds 300
                    break
                }
                if (-not $r.IsEmpty) { return $hit }
            }
        }
        if ((Get-Date) -gt $end) { throw "Not on screen: $($c | ConvertTo-Json -Compress)" }
        Start-Sleep -Milliseconds 400
    }
}
function Rect($e) {
    $r = $e.Current.BoundingRectangle
    @{ x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height }
}
function Click($e) {
    $r = $e.Current.BoundingRectangle
    [Native]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
    Start-Sleep -Milliseconds 120
    [Native]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}
function Keys($text) { [System.Windows.Forms.SendKeys]::SendWait(($text -replace '([+^%~(){}\[\]])', '{$1}')) }
function Front {
    $w = Window 'main'
    if ($w) { [Native]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null }
}
function Launch {
    if (-not (Get-Process temperance -ErrorAction SilentlyContinue)) { Start-Process $exe }
    for ($i = 0; $i -lt 60 -and -not (Window 'main'); $i++) { Start-Sleep -Milliseconds 500 }
    $w = Window 'main'
    if (-not $w) { throw 'The Temperance window did not appear' }
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $h = [Math]::Min(760, $screen.Height - 40)
    [Native]::MoveWindow([IntPtr]$w.Current.NativeWindowHandle, [int](($screen.Width - 560) / 2), 20, 560, $h, $true) | Out-Null
    Front
    Start-Sleep -Milliseconds 800
}

function Perform($c) {
    switch ($c.op) {
        'screen' {
            if ($c.width) {
                # The VirtIO display only offers some modes; take the first that fits.
                foreach ($m in @(@($c.width, $c.height), @(1280, 720), @(1024, 768))) {
                    $changed = [Native]::Resolution($m[0], $m[1])
                    if ($changed -eq 0) { break }
                }
                Start-Sleep 2
            }
            $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            return @{ width = $b.Width; height = $b.Height; changed = $changed }
        }
        'launch' { Launch; return @{} }
        'reset' {
            Get-Process temperance -ErrorAction SilentlyContinue | Stop-Process -Force
            Start-Sleep 1
            if (Get-Service 'WireGuardTunnel$temperance' -ErrorAction SilentlyContinue) {
                Start-Process (Join-Path $env:ProgramW6432 'WireGuard\wireguard.exe') -ArgumentList '/uninstalltunnelservice', 'temperance' -Wait -WindowStyle Hidden
                for ($i = 0; $i -lt 30 -and (Get-Service 'WireGuardTunnel$temperance' -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
            }
            Get-ChildItem (Join-Path $env:ProgramData 'Temperance') -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
            Launch
            return @{}
        }
        'find' { return @{ rect = (Rect (Find $c $c.timeout)) } }
        'tap' { Click (Find $c 5); return @{} }
        'type' {
            $e = Find $c 5
            Click $e
            Start-Sleep -Milliseconds 250
            # SendKeys drops the first input after the agent starts.
            if (-not $typed) { Keys ' '; Start-Sleep -Milliseconds 200; $script:typed = $true }
            [System.Windows.Forms.SendKeys]::SendWait('^a{BACKSPACE}')
            $text = [string]$c.text
            if ($c.secret) {
                # Pasted, the way a parent brings in a pairing link or a password manager fills one in.
                # The UTM guest tools hold the clipboard now and then, sometimes for seconds;
                # after that, the text goes in as one burst of keys instead.
                $pasted = $false
                for ($try = 0; $try -lt 5 -and -not $pasted; $try++) {
                    try {
                        [System.Windows.Forms.Clipboard]::SetDataObject($text, $true, 20, 100)
                        $pasted = $true
                    } catch { Start-Sleep -Milliseconds 500 }
                }
                if ($pasted) {
                    [System.Windows.Forms.SendKeys]::SendWait('^v')
                    Start-Sleep -Milliseconds 200
                    try { [System.Windows.Forms.Clipboard]::SetDataObject(' ', $false, 20, 100) } catch {}
                } else {
                    Keys $text
                }
            } else {
                for ($i = 0; $i -lt $text.Length; $i += 3) {
                    Keys $text.Substring($i, [Math]::Min(3, $text.Length - $i))
                    Start-Sleep -Milliseconds 40
                }
            }
            # Closes WebView2's autofill suggestions, which can cover the next button.
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
            return @{}
        }
        'close' {
            $w = Window $c.window
            if ($w) { $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() }
            Start-Sleep -Milliseconds 600
            Front
            return @{}
        }
        'record' {
            Front
            $psi = New-Object System.Diagnostics.ProcessStartInfo $ffmpeg, "-y -loglevel error -f gdigrab -framerate 30 -draw_mouse 1 -i desktop -c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv420p `"$($c.file)`""
            $psi.UseShellExecute = $false
            $psi.RedirectStandardInput = $true
            $psi.CreateNoWindow = $true
            $script:recorder = [System.Diagnostics.Process]::Start($psi)
            Start-Sleep -Milliseconds 1500
            if ($recorder.HasExited) { throw 'ffmpeg could not capture the screen' }
            $out = @{}
            $w = Window 'main'
            if ($w) {
                $r = [Native]::Frame([IntPtr]$w.Current.NativeWindowHandle)
                # Inside the one-pixel window border.
                $out.window = @{ x = $r.Left + 1; y = $r.Top + 1; width = $r.Right - $r.Left - 2; height = $r.Bottom - $r.Top - 2 }
            }
            # The desktop without the taskbar, whose clock is the VM's, not the story's,
            # and without the strip above it where an unactivated VM paints its watermark.
            $a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
            $out.desktop = @{ x = $a.X; y = $a.Y; width = $a.Width - $a.Width % 2; height = $a.Height - 80 - $a.Height % 2 }
            # How far into the video "now" is, so the harness can line its timeline up with it.
            $out.recording = [int]((Get-Date) - $recorder.StartTime).TotalMilliseconds
            return $out
        }
        'stop' {
            if ($recorder) {
                $recorder.StandardInput.Write('q')
                $recorder.StandardInput.Close()
                $recorder.WaitForExit(30000) | Out-Null
                $script:recorder = $null
            }
            return @{ size = (Get-Item $c.file).Length }
        }
        default { throw "Unknown command $($c.op)" }
    }
}

$result = @{ hello = $true }
while ($true) {
    try {
        $cmd = Invoke-RestMethod -Method Post -Uri "$Base/next" -Body ($result | ConvertTo-Json -Compress -Depth 5) -ContentType 'application/json' -TimeoutSec 900
    } catch {
        Start-Sleep 2
        continue
    }
    if (-not $cmd -or $cmd.op -eq 'done') { break }
    if ($cmd.op -eq 'noop') { $result = @{}; continue }
    try { $result = Perform $cmd } catch { $result = @{ error = "$_" } }
    $result.id = $cmd.id
}
