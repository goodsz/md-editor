; ---------------------------------------------------------------------------
; 自定义 NSIS 脚本（electron-builder 自动读取 build/installer.nsh）
; ---------------------------------------------------------------------------
; 「选择安装目录」页由 electron-builder 的 allowToChangeInstallationDirectory
; 提供（配合 oneClick:false）。electron-builder 未内置「桌面快捷方式」勾选框，
; 故本脚本补充一个自定义页：安装时可选择是否创建桌面快捷方式（默认勾选）。
;
; 由于 package.json 中 createDesktopShortcut 设为 false，模板不再创建/删除桌面
; 快捷方式，改由本脚本负责：勾选时创建，卸载时删除。
;
; 注意：安装包会分两趟编译（安装程序 / 卸载程序）。页面相关的代码只在安装趟
; 生效，必须用 !ifndef BUILD_UNINSTALLER 包住，否则卸载趟会因页面函数未被引用
; 触发 NSIS 6010 警告（被 electron-builder 视为错误）。

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER

Var CreateDesktopShortcutCheckbox
Var CreateDesktopShortcutState

; 目录选择页之后、开始安装之前插入自定义选项页
!macro customPageAfterChangeDir
  Page custom CreateDesktopShortcutPage CreateDesktopShortcutPageLeave
!macroend

Function CreateDesktopShortcutPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0u 100% 24u "请选择附加的安装选项："
  Pop $1

  ${NSD_CreateCheckbox} 0 26u 100% 12u "创建桌面快捷方式"
  Pop $CreateDesktopShortcutCheckbox
  ${NSD_SetState} $CreateDesktopShortcutCheckbox 1 ; 默认勾选

  nsDialogs::Show
FunctionEnd

Function CreateDesktopShortcutPageLeave
  ${NSD_GetState} $CreateDesktopShortcutCheckbox $CreateDesktopShortcutState
FunctionEnd

; 安装完成后按勾选状态创建桌面快捷方式
!macro customInstall
  ${If} $CreateDesktopShortcutState == "1"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  ; 强制 Shell 重绘桌面图标（覆盖安装时 exe 路径未变，Explorer 会沿用旧图标缓存位图）：
  ; 1) SHCNE_ASSOCCHANGED：通知文件关联变更，触发 Explorer 全局刷新图标缓存
  ; 2) SHCNE_UPDATEITEM：通知桌面快捷方式自身立即更新图标（0x2005 = SHCNF_PATHW|SHCNF_FLUSHNOWAIT）
  ; 3) SHCNE_UPDATEDIR：通知桌面目录整体重绘
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x2005, w "$newDesktopLink", p 0)'
  System::Call 'Shell32::SHChangeNotify(i 0x00001000, i 0x2005, w "$DESKTOP", p 0)'
!macroend

!endif ; !ifndef BUILD_UNINSTALLER

; 卸载时删除桌面快捷方式（无论当时是否勾选，删除不存在项无副作用）
!macro customUnInstall
  WinShell::UninstShortcut "$newDesktopLink"
  Delete "$newDesktopLink"
  ClearErrors
!macroend
