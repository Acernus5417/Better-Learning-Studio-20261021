@echo off
setlocal
set "studioRoot=%~dp0"

if not exist "%studioRoot%start-studio.ps1" (
    echo Better Learning Studio launcher is missing: "%studioRoot%start-studio.ps1"
    pause
    exit /b 1
)

start "" /D "%studioRoot%" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%studioRoot%start-studio.ps1" -SkipBuild -ShowErrorDialog
exit /b %errorlevel%
