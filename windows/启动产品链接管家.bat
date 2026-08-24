@echo off
chcp 65001 >nul
title 产品链接管家
cd /d "%~dp0"
if not exist "%~dp0web\index.html" goto not_extracted
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" 2>"%~dp0启动错误日志.txt"
set "APP_EXIT=%ERRORLEVEL%"
echo.
echo 产品链接管家已停止，退出代码：%APP_EXIT%
if exist "%~dp0启动错误日志.txt" (
  for %%A in ("%~dp0启动错误日志.txt") do if not "%%~zA"=="0" (
    echo.
    echo 启动错误详情：
    type "%~dp0启动错误日志.txt"
  )
)
echo.
pause
exit /b %APP_EXIT%

:not_extracted
echo.
echo 未找到完整程序文件。
echo 请先右键压缩包，选择“全部解压”，然后在解压后的文件夹中运行。
echo.
pause
exit /b 1
