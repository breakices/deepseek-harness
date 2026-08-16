@echo off
rem AR spike instance launcher — isolated home, port 3180, log to .dsh-home\web.log
set DSH_HOME=D:\ar_dsh\ar_deepseek_harness\.dsh-home
cd /d D:\ar_dsh\ar_deepseek_harness
echo [%date% %time%] starting dsh web --port 3180 >> "%DSH_HOME%\web.log"
npx -y pnpm@11.7.0 dsh web --port 3180 >> "%DSH_HOME%\web.log" 2>&1
