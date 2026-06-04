@echo off
:: Kurokawa Desktop Operator - Launcher
:: This bat delegates all work to start-operator.ps1
:: No Japanese / No UTF-8 / No special chars here

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-operator.ps1"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] PowerShell launch failed. Code: %errorlevel%
    echo [HINT]  Try running start-operator.ps1 directly.
    pause
)
