@echo off
title Cai dat khoi dong ngam cung Windows
echo ========================================================
echo   CAI DAT TU DONG KHOI DONG CUNG WINDOWS - COBE DENIM
echo ========================================================
echo.
cd /d "%~dp0"

cscript //nologo scripts\install-startup.vbs
if %ERRORLEVEL% EQU 0 (
    echo.
    echo [THANH CONG] Da cai dat tu dong khoi dong cung Windows!
    echo Tu bay gio:
    echo 1. Moi khi mo may tinh, he thong se tu dong chay ngam.
    echo 2. Cứ moi 2 tieng, he thong se tu dong quet token Chrome
    echo    va cap nhat ton kho tu MShopKeeper.
    echo 3. Khong can mo bat ky cua so terminal hay web nao!
    echo.
) else (
    echo.
    echo [LOI] Khong the tao shortcut khoi dong.
    echo.
)

pause
