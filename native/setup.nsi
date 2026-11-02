Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.14"
!endif
!define PRODUCT_NAME "Local MCP Studio"
!define PRODUCT_KEY "LocalMcpStudioNative"
!define PRODUCT_EXE "LocalMcpStudio.exe"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\dist\Local MCP Studio-${PRODUCT_VERSION}-Setup-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\Local MCP Studio Native"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "InstallLocation"
Icon "..\assets\app.ico"
UninstallIcon "..\assets\app.ico"
ShowInstDetails show
ShowUninstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "stage\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Local MCP Studio"
  CreateShortcut "$SMPROGRAMS\Local MCP Studio\Local MCP Studio.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\assets\app.ico"
  CreateShortcut "$SMPROGRAMS\Local MCP Studio\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Local MCP Studio.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\assets\app.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "DisplayName" "${PRODUCT_NAME} Native"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "Publisher" "Local MCP Studio"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Local MCP Studio.lnk"
  Delete "$SMPROGRAMS\Local MCP Studio\Local MCP Studio.lnk"
  Delete "$SMPROGRAMS\Local MCP Studio\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Local MCP Studio"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
