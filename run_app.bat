@echo off
setlocal
title Family Agent - Revit Studio ^& API Server

cd /d "%~dp0"

echo =====================================================================
echo   DANG KHOI DONG CREATE-FAMILY-REVIT (STUDIO ^& LOCAL API)
echo =====================================================================
echo.

:: 1. Kiem tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] Khong tim thay Node.js tren may!
    echo Vui long cai dat Node.js ^(phien ban ^>= 20^) tu https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 2. Tu dong mo trinh duyet sau 3 giay
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5173"

:: 3. Khoi dong dev server
echo Dang khoi dong Backend API (cong 8787) va Studio Web (cong 5173)...
echo Hay giu cua so nay mo khi dang su dung ung dung hoac ket noi tu DG App.
echo.
npm run dev

pause
