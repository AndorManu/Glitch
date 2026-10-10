; Installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; "Start with Windows" (src-tauri/src/autostart.rs) is a value in the current
; user's Run key. Uninstalling Glitch removes it, so nothing is left pointing
; at a program that is gone. The name is the one autostart.rs writes: "Glitch"
; for the real app, "Glitch (<identifier>)" for any other build.
;
; An auto-update runs the old uninstaller too and removes the value; Glitch
; writes it again when it starts (autostart::sync_on_start).

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} "${BUNDLEID}" == "dev.glitch.companion"
    StrCpy $R9 "Glitch"
  ${Else}
    StrCpy $R9 "Glitch (${BUNDLEID})"
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$R9"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "$R9"
!macroend
