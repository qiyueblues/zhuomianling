; Keep first-time setup interactive. Updates only show installation progress,
; then close the installer and launch the new app without another click.

!include "${__FILEDIR__}\update-theme.nsh"

!macro customInit
  ${if} ${isUpdated}
    SetAutoClose true
  ${endif}
!macroend

!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
  !insertmacro zmlUpdateThemeFunctions

  Function .onInstFailed
    ${if} ${isUpdated}
    ${andIfNot} ${Silent}
      Call zmlUpdateShowFailure
    ${endif}
  FunctionEnd

  Function .onInstSuccess
    ${if} ${isUpdated}
    ${andIf} ${isForceRun}
    ${andIfNot} ${Silent}
      HideWindow
      Call StartApp
    ${endif}
  FunctionEnd
!endif
!macroend

; This hook runs immediately before electron-builder declares its progress page.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW zmlUpdateShowProgress
!macroend

!macro customFinishPage
  ; Match electron-builder's normal finish page for a fresh installation.
  ; Its --updated launch flag is also used for the one-time home notice.
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend
