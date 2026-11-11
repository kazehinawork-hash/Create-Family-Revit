@echo off
chcp 65001 >nul
title Windows Revit Connector - Cloud Sync Service
echo ============================================================
echo   WINDOWS REVIT CONNECTOR (HYBRID CLOUD SYNC)
echo ============================================================
echo.
echo Đang kết nối tới Cloudflare Worker:
echo URL: https://revit.creat-family.workers.dev
echo.
echo [1/2] Kiểm tra kết nối Revit Add-in...
echo [2/2] Bắt đầu lắng nghe và nhận Job dựng RFA từ Web Cloud...
echo.
echo (Nhấn Ctrl+C để dừng service)
echo ------------------------------------------------------------
echo.

set CLOUD_API_URL=https://revit.creat-family.workers.dev
node connector/src/index.js

pause

