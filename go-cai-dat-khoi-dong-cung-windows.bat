@echo off
title Go bo khoi dong cung Windows
echo ========================================================
echo   GO BO TU DONG KHOI DONG CUNG WINDOWS - COBE DENIM
echo ========================================================
echo.
cd /d "%~dp0"

cscript //nologo scripts\uninstall-startup.vbs
echo.
echo [HOAN TAT] Da go bo khoi dong ngam cung Windows.
echo.
pause
