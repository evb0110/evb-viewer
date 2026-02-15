!macro customInstall
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf" "" "Combine into PDF with EVB Viewer"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" %*'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf"
!macroend
