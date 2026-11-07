!ifndef ZML_UPDATE_THEME_INCLUDED
!define ZML_UPDATE_THEME_INCLUDED

; Application branding only; no pet theme, userData or network access.
!define ZML_UPDATE_ICON "${__FILEDIR__}\..\..\assets\icons\app-icon.ico"
!define ZML_UPDATE_PROGRESS_EXE "${__FILEDIR__}\..\..\.cache\update-progress-ui\zml-update-progress.exe"
!define ZML_UPDATE_BG "F5F7FB"
!define ZML_UPDATE_INK "111827"
!define ZML_UPDATE_MUTED "5F6B7A"
!define ZML_UPDATE_BLUE "0057C2"

!macro zmlUpdateMove HANDLE X Y W H
  IntOp $0 ${X} * $zmlUpdateDpi
  IntOp $0 $0 / 96
  IntOp $1 ${Y} * $zmlUpdateDpi
  IntOp $1 $1 / 96
  IntOp $2 ${W} * $zmlUpdateDpi
  IntOp $2 $2 / 96
  IntOp $3 ${H} * $zmlUpdateDpi
  IntOp $3 $3 / 96
  System::Call 'user32::SetWindowPos(p ${HANDLE}, p 0, i r0, i r1, i r2, i r3, i 0x14)'
!macroend

!macro zmlUpdateLabel OUT TEXT X Y W H FONT COLOR BG STYLE
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${STYLE}, i 0, i 0, i 0, i 0, p $mui.InstFilesPage, p 0, p 0, p 0) p.s'
  Pop ${OUT}
  !insertmacro zmlUpdateMove ${OUT} ${X} ${Y} ${W} ${H}
  SendMessage ${OUT} ${WM_SETFONT} ${FONT} 1
  SetCtlColors ${OUT} "${COLOR}" "${BG}"
!macroend

!macro zmlUpdateThemeFunctions
  Var zmlUpdateDpi
  Var zmlUpdateFont
  Var zmlUpdateBrandFont
  Var zmlUpdateTitleFont
  Var zmlUpdateSmallFont
  Var zmlUpdateIcon
  Var zmlUpdateTitle
  Var zmlUpdateSubtitle
  Var zmlUpdateStatus
  Var zmlUpdateProgressLabel
  Var zmlUpdateVersionLabel

  Function zmlUpdateShowProgress
    ${ifNot} ${isUpdated}
      Return
    ${endif}
    ${if} ${Silent}
      Return
    ${endif}
    System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.s'
    Pop $zmlUpdateDpi
    ${if} $zmlUpdateDpi == 0
      StrCpy $zmlUpdateDpi 96
    ${endif}
    CreateFont $zmlUpdateFont "Microsoft YaHei UI" 10 400
    CreateFont $zmlUpdateSmallFont "Microsoft YaHei UI" 9 400
    CreateFont $zmlUpdateBrandFont "Microsoft YaHei UI" 13 600
    CreateFont $zmlUpdateTitleFont "Microsoft YaHei UI" 18 600

    ; Keep the actual NSIS progress control and hide the unused wizard chrome.
    System::Call 'user32::GetWindow(p $HWNDPARENT, i 5) p.r4'
    ${doWhile} $4 != 0
      ${if} $4 != $mui.InstFilesPage
        ShowWindow $4 ${SW_HIDE}
      ${endif}
      System::Call 'user32::GetWindow(p r4, i 2) p.r4'
    ${loop}
    ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
    SetCtlColors $HWNDPARENT "${ZML_UPDATE_INK}" "${ZML_UPDATE_BG}"
    SetCtlColors $mui.InstFilesPage "${ZML_UPDATE_INK}" "${ZML_UPDATE_BG}"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:桌面灵 · 软件更新"

    ; Logical pixels plus the system's current non-client area.
    IntOp $2 528 * $zmlUpdateDpi
    IntOp $2 $2 / 96
    IntOp $3 276 * $zmlUpdateDpi
    IntOp $3 $3 / 96
    System::Call '*(i 0, i 0, i r2, i r3) p.r4'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r5'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i.r6'
    System::Call 'user32::AdjustWindowRectEx(p r4, i r5, i 0, i r6)'
    System::Call '*$4(i.r0, i.r1, i.r2, i.r3)'
    System::Free $4
    IntOp $2 $2 - $0
    IntOp $3 $3 - $1
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r2, i r3, i 0x16)'
    !insertmacro zmlUpdateMove $mui.InstFilesPage 0 0 528 276

    !insertmacro zmlUpdateLabel $4 "" 24 100 480 152 $zmlUpdateFont "${ZML_UPDATE_INK}" "FFFFFF" 0x50000000
    IntOp $2 480 * $zmlUpdateDpi
    IntOp $2 $2 / 96
    IntOp $3 152 * $zmlUpdateDpi
    IntOp $3 $3 / 96
    IntOp $5 28 * $zmlUpdateDpi
    IntOp $5 $5 / 96
    System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r2, i r3, i r5, i r5) p.r6'
    System::Call 'user32::SetWindowRgn(p r4, p r6, i 1)'

    InitPluginsDir
    SetDetailsPrint none
    File /oname=$PLUGINSDIR\zml-update.ico "${ZML_UPDATE_ICON}"
    !insertmacro zmlUpdateLabel $4 "" 28 26 44 44 $zmlUpdateFont "${ZML_UPDATE_INK}" "${ZML_UPDATE_BG}" 0x50000003
    IntOp $2 44 * $zmlUpdateDpi
    IntOp $2 $2 / 96
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\zml-update.ico", i 1, i r2, i r2, i 0x10) p.s'
    Pop $zmlUpdateIcon
    SendMessage $4 0x170 $zmlUpdateIcon 0
    !insertmacro zmlUpdateLabel $4 "桌面灵" 86 26 240 27 $zmlUpdateBrandFont "${ZML_UPDATE_INK}" "${ZML_UPDATE_BG}" 0x50000000
    !insertmacro zmlUpdateLabel $4 "软件更新" 87 55 240 20 $zmlUpdateSmallFont "${ZML_UPDATE_MUTED}" "${ZML_UPDATE_BG}" 0x50000000
    !insertmacro zmlUpdateLabel $zmlUpdateStatus "正在安装" 391 37 110 26 $zmlUpdateSmallFont "${ZML_UPDATE_BLUE}" "${ZML_UPDATE_BG}" 0x50000202
    !insertmacro zmlUpdateLabel $zmlUpdateTitle "正在更新桌面灵" 44 119 440 38 $zmlUpdateTitleFont "${ZML_UPDATE_INK}" "FFFFFF" 0x50000000
    !insertmacro zmlUpdateLabel $zmlUpdateSubtitle "安装完成后会自动打开新版，请稍候。" 45 163 438 26 $zmlUpdateFont "${ZML_UPDATE_MUTED}" "FFFFFF" 0x50000000
    !insertmacro zmlUpdateLabel $zmlUpdateProgressLabel "安装新版本" 45 204 220 23 $zmlUpdateSmallFont "${ZML_UPDATE_BLUE}" "FFFFFF" 0x50000000
    !insertmacro zmlUpdateLabel $zmlUpdateVersionLabel "${VERSION}" 308 204 174 23 $zmlUpdateSmallFont "${ZML_UPDATE_MUTED}" "FFFFFF" 0x50000002

    System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w "", w "")'
    System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16) i.r4'
    IntOp $4 $4 & 0xFF7FFFFF
    System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16, i r4)'
    System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -20) i.r4'
    IntOp $4 $4 & 0xFFFDFDFF
    System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -20, i r4)'
    SendMessage $mui.InstFilesPage.ProgressBar 0x409 0 0x00FF7A00
    SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 0x00F7EDE6
    !insertmacro zmlUpdateMove $mui.InstFilesPage.ProgressBar 45 232 438 8
    System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.ProgressBar, p 0, i 0, i 0, i 0, i 0, i 0x33)'

    System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i.r5, i 0) i.r6'
    ${if} $6 != 0
    ${andIf} $5 != 0
      ; Optional drawing surface only. Native progress stays underneath if
      ; .NET is absent, the surface fails to start, or it exits unexpectedly.
      ReadRegDWORD $4 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
      ${if} $4 >= 378389
        File /oname=$PLUGINSDIR\zml-update-progress.exe "${ZML_UPDATE_PROGRESS_EXE}"
        System::Call 'kernel32::GetCurrentProcessId() i.r4'
        Exec '"$PLUGINSDIR\zml-update-progress.exe" $HWNDPARENT $mui.InstFilesPage.ProgressBar $4'
      ${endif}
      ShowWindow $HWNDPARENT ${SW_HIDE}
      System::Call 'user32::AnimateWindow(p $HWNDPARENT, i 180, i 0x80000)'
      ShowWindow $HWNDPARENT ${SW_SHOW}
    ${endif}
    System::Call 'user32::InvalidateRect(p $mui.InstFilesPage, p 0, i 1)'
  FunctionEnd

  Function zmlUpdateShowFailure
    SendMessage $zmlUpdateTitle ${WM_SETTEXT} 0 "STR:更新未完成"
    SendMessage $zmlUpdateSubtitle ${WM_SETTEXT} 0 "STR:请关闭此窗口，然后重新打开软件重试。"
    SendMessage $zmlUpdateStatus ${WM_SETTEXT} 0 "STR:更新未完成"
    SetCtlColors $zmlUpdateTitle "B64145" "FFFFFF"
    SetCtlColors $zmlUpdateStatus "B64145" "${ZML_UPDATE_BG}"
    ShowWindow $mui.InstFilesPage.ProgressBar ${SW_HIDE}
    ShowWindow $zmlUpdateProgressLabel ${SW_HIDE}
    ShowWindow $zmlUpdateVersionLabel ${SW_HIDE}
    GetDlgItem $4 $HWNDPARENT 2
    SendMessage $4 ${WM_SETTEXT} 0 "STR:关闭"
    EnableWindow $4 1
    !insertmacro zmlUpdateMove $4 390 204 90 30
    ShowWindow $4 ${SW_SHOW}
    System::Call 'user32::SetWindowPos(p r4, p 0, i 0, i 0, i 0, i 0, i 0x13)'
  FunctionEnd
!macroend
!endif
