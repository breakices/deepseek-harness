@echo off
rem Knevo 初见者启动器:登录（换设备 token）→ 注入 → 起 dsh（连 dev 云端）。
rem 首次运行会提示账号口令（先在 https://dev.ar.knevo.ai 用邀请码注册）。
setlocal
set DSH_HOME=%~dp0.dsh-home
cd /d %~dp0

rem 系统代理会劫持部分请求,dsh 只连 dev 公网,清掉更稳
set HTTP_PROXY=
set HTTPS_PROXY=
set http_proxy=
set https_proxy=

if not exist "%DSH_HOME%\.device-token" (
  echo 首次使用,请登录你的 Knevo 账号（未注册请先到 https://dev.ar.knevo.ai 注册）。
  node "%~dp0knevo-login.mjs"
)
if not exist "%DSH_HOME%\.device-token" (
  echo 登录未完成,已退出。
  exit /b 1
)
set /p AR_DEVICE_TOKEN=<"%DSH_HOME%\.device-token"

echo 启动 Knevo（连接 dev.ar.knevo.ai）...
npx -y pnpm@11.7.0 dsh --profile web --port 3180
endlocal
