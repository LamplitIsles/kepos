@echo off
setlocal
set "SCRIPT=%~dp0install.ps1"
if not exist "%SCRIPT%" (
  echo Kepos installer is missing its adjacent install.ps1.
  set "EXITCODE=1"
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
  set "EXITCODE=%ERRORLEVEL%"
)
if not "%EXITCODE%"=="0" echo Kepos installation failed with exit code %EXITCODE%.
if not defined KEPOS_INSTALLER_NO_PAUSE pause
endlocal & exit /b %EXITCODE%
