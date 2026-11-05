@echo off
rem Double-click to start Lop Hoc Chu, then the control page opens in the default browser.
rem Keep this window open while streaming: closing it stops the game.
chcp 65001 >nul
title Lop Hoc Chu - KHONG DONG CUA SO NAY KHI DANG LIVE
cd /d "%~dp0"

echo.
echo   ==========================================================
echo     LOP HOC CHU - LIVE
echo   ----------------------------------------------------------
echo     Trang dieu khien : http://localhost:3006
echo     Link LIVE Studio : http://lvh.me:3006/?view=stage
echo     Bao cao buoi live: http://localhost:3006/bao-cao
echo.
echo     KHONG dong cua so nay trong luc live.
echo     Dong cua so nay = tat game.
echo   ==========================================================
echo.

set NODE_ENV=production
set PORT=3006
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3006"
rem Treo live ca ngay: server tat (loi, het bo nho...) thi tu bat lai sau 5 giay; trang stage tu noi lai, khong mat diem.
:run
"%~dp0node\node.exe" "%~dp0server.mjs"
rem ma 42 = vua cai ban cap nhat tu trang dieu khien: bat server moi ngay (trang dang mo tu tai lai)
if %ERRORLEVEL%==42 (
  echo.
  echo   Da cap nhat xong, dang khoi dong lai...
  goto run
)
echo.
echo   [%date% %time%] Server bi tat, tu bat lai sau 5 giay... (dong cua so nay de tat han)
timeout /t 5 >nul
goto run
