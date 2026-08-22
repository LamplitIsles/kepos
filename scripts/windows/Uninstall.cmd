@echo off
setlocal
set "SCRIPT=%~dp0uninstall.ps1"
if not exist "%SCRIPT%" goto missing
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXITCODE=%ERRORLEVEL%"
goto finish
:missing
echo Kepos uninstaller is missing its adjacent uninstall.ps1.
set "EXITCODE=1"
:finish
if not "%EXITCODE%"=="0" echo Kepos uninstall failed with exit code %EXITCODE%.
if not defined KEPOS_INSTALLER_NO_PAUSE pause
endlocal & exit /b %EXITCODE%
