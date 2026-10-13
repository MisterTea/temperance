; The installer is 32-bit: Sysnative reaches the native PowerShell, whose Program Files
; is the one WireGuard installs into. PowerShell waits on the stdin that nsExec leaves
; open unless told not to read it.
!macro TEMPERANCE_POWERSHELL
  StrCpy $R8 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists $R8 +2
    StrCpy $R8 "powershell.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Setting up WireGuard and the Temperance data folder"
  !insertmacro TEMPERANCE_POWERSHELL
  nsExec::ExecToLog '"$R8" -NoProfile -NonInteractive -InputFormat None -ExecutionPolicy Bypass -File "$INSTDIR\setup.ps1"'
  Pop $0
  StrCmp $0 "0" +2
    MessageBox MB_ICONEXCLAMATION "Temperance could not finish setting up WireGuard (code $0). Install WireGuard from wireguard.com, then start Temperance." /SD IDOK
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TEMPERANCE_POWERSHELL
  nsExec::ExecToLog '"$R8" -NoProfile -NonInteractive -InputFormat None -ExecutionPolicy Bypass -File "$INSTDIR\setup.ps1" -Uninstall'
  Pop $0
!macroend
