!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var TexelOpenRouterCheckbox
Var TexelFalCheckbox
Var TexelLocalAiCheckbox
Var TexelInstallOpenRouter
Var TexelInstallFal
Var TexelInstallLocalAi

!macro customInit
  StrCpy $TexelInstallOpenRouter ${BST_CHECKED}
  StrCpy $TexelInstallFal ${BST_CHECKED}
  StrCpy $TexelInstallLocalAi ${BST_CHECKED}
!macroend

Function TexelPackagesPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Package dependencies are selected together. You can add more packages after installation in a future release."
  Pop $0
  ${NSD_CreateCheckbox} 0 36u 100% 12u "OpenRouter"
  Pop $TexelOpenRouterCheckbox
  ${NSD_Check} $TexelOpenRouterCheckbox
  ${NSD_CreateCheckbox} 0 58u 100% 12u "Fal.ai"
  Pop $TexelFalCheckbox
  ${NSD_Check} $TexelFalCheckbox
  ${NSD_CreateCheckbox} 0 80u 100% 12u "Local AI — Vulkan (includes Local AI base)"
  Pop $TexelLocalAiCheckbox
  ${NSD_Check} $TexelLocalAiCheckbox
  nsDialogs::Show
FunctionEnd

Function TexelPackagesPageLeave
  ${NSD_GetState} $TexelOpenRouterCheckbox $TexelInstallOpenRouter
  ${NSD_GetState} $TexelFalCheckbox $TexelInstallFal
  ${NSD_GetState} $TexelLocalAiCheckbox $TexelInstallLocalAi
FunctionEnd

!macro customPageAfterChangeDir
  Page custom TexelPackagesPageCreate TexelPackagesPageLeave
!macroend

!macro customInstall
  ; Quote both paths, including an installation directory or document name containing spaces.
  WriteRegStr SHELL_CONTEXT "Software\Classes\Texel.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${If} $TexelInstallOpenRouter != ${BST_CHECKED}
    RMDir /r "$INSTDIR\resources\packages\texel-editor\openrouter"
  ${EndIf}
  ${If} $TexelInstallFal != ${BST_CHECKED}
    RMDir /r "$INSTDIR\resources\packages\texel-editor\fal"
  ${EndIf}
  ${If} $TexelInstallLocalAi != ${BST_CHECKED}
    RMDir /r "$INSTDIR\resources\packages\texel-editor\local-ai-vulkan"
    RMDir /r "$INSTDIR\resources\packages\texel-editor\local-ai-base"
  ${EndIf}
!macroend
!endif
