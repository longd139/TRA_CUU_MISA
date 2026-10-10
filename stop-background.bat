@echo off
chcp 65001 > nul
echo Đang dừng máy chủ tra cứu Cobe Denim...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /F /PID %%a > nul 2>&1
)
echo Máy chủ đã được dừng thành công!
pause
