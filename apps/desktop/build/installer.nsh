; © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
; No modification or redistribution without the owner’s written permission.
;
; Included by electron-builder's assisted installer (`nsis.include` in scripts/release.mjs).
; Plain ASCII on purpose: makensis is run in whatever code page the build machine happens to have, and a source file
; with wide characters in it compiles differently there than here.
;
; 2026-11-26, a field report: a Windows PC kept "installing" and the folder never had OrangeFilm.exe, so the desktop
; shortcut pointed at nothing. Two causes share that shape, and neither was ever said out loud:
;   * a second installer instance - NSIS serves one at a time, the later one exits with code 2 and writes nothing
;     (invisible with /S, and easy to hit by double-clicking again while the first is still extracting ~1 GB);
;   * an antivirus that quarantines the 235 MB unsigned executable right after it is written.
; So: after the files are placed, look for the executable. If it is not there, say which folder was used and why it
; may be missing, instead of finishing with a shortcut to a file that does not exist.

!macro customInstall
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" orangefilmExePresent 0
    ; a silent install must never wait on a dialog (CI, scripted deployment): the exit code carries the news
    SetErrorLevel 2
    IfSilent orangefilmExeChecked
    MessageBox MB_ICONSTOP|MB_OK "OrangeFilm is not installed completely:$\r$\n$INSTDIR\${APP_EXECUTABLE_FILENAME} is missing.$\r$\n$\r$\nTwo things cause this:$\r$\n  1. Another installer was already running. NSIS allows one at a time; the second one stops without writing anything. Wait for it to finish (about a minute) and run the installer once more.$\r$\n  2. An antivirus removed the file. Add $INSTDIR to its exclusions, then install again.$\r$\n$\r$\nInstall folder: $INSTDIR"
    Goto orangefilmExeChecked
  orangefilmExePresent:
    FileOpen $0 "$INSTDIR\install-location.txt" w
    FileWrite $0 "${PRODUCT_NAME} ${VERSION}$\r$\n"
    FileWrite $0 "Install folder: $INSTDIR$\r$\n"
    FileWrite $0 "Client: $INSTDIR\${APP_EXECUTABLE_FILENAME}$\r$\n"
    FileWrite $0 "Command line: %APPDATA%\OrangeFilm\bin\orangefilm.cmd (written the first time the app runs)$\r$\n"
    FileClose $0
  orangefilmExeChecked:
!macroend

!macro customUnInstall
  Delete "$INSTDIR\install-location.txt"
!macroend
