@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 goto directory_error

set "WRITE_NODE=%CD%\runtime\node.exe"
if exist "%WRITE_NODE%" (
    "%WRITE_NODE%" -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" >nul 2>&1
    if not errorlevel 1 goto launch
)
set "WRITE_NODE=node"
"%WRITE_NODE%" -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" >nul 2>&1
if not errorlevel 1 goto launch

echo 需要 Node.js 22 或更新版本。请下载并安装： https://nodejs.org/zh-cn/download
echo 安装后关闭此窗口，再双击 start.bat。也可以下载 Write 便携版。
if not "%WRITE_NO_PAUSE%"=="1" pause
popd
exit /b 1

:launch
"%WRITE_NODE%" "scripts\start-local.mjs" %*
set "WRITE_STATUS=%ERRORLEVEL%"
if not "%WRITE_STATUS%"=="0" if not "%WRITE_NO_PAUSE%"=="1" pause
popd
exit /b %WRITE_STATUS%

:directory_error
echo 无法进入 Write 目录。请先完整解压项目，再双击 start.bat。
if not "%WRITE_NO_PAUSE%"=="1" pause
exit /b 1
