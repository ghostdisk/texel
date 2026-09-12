!macro customInstall
  ; Quote both paths, including an installation directory or document name containing spaces.
  WriteRegStr SHELL_CONTEXT "Software\Classes\Texel.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend