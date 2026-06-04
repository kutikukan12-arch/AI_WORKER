@echo off
chcp 65001 > nul 2>&1
title 黒川 Desktop Operator

:: ─── 最小構成: Desktop Operator のみ起動 ───────────
:: Bot 起動確認なし・シンプル版
:: ダブルクリックで黒川が出勤する。

cd /d "%~dp0"

:: Node.js チェック
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません: https://nodejs.org
    pause & exit /b 1
)

:: desktop-operator.js チェック
if not exist "scripts\desktop-operator.js" (
    echo [ERROR] scripts\desktop-operator.js が見つかりません
    echo         このファイルは AI_WORKER フォルダに置いてください
    pause & exit /b 1
)

:: stale lock 自動解除
node -e "
  const fs=require('fs');
  const p='data/desktop-operator/operator.lock';
  if(!fs.existsSync(p))process.exit(0);
  try{
    const l=JSON.parse(fs.readFileSync(p,'utf8'));
    const age=Date.now()-new Date(l.startedAt).getTime();
    try{process.kill(l.pid,0);if(age<300000)process.exit(1);}catch{}
    fs.unlinkSync(p);
    console.log('[OK] stale lock 解除 pid='+l.pid);
  }catch{process.exit(0);}
" 2>nul

if %errorlevel% equ 1 (
    echo 黒川は勤務中です。
    node scripts\desktop-operator.js status
    pause & exit /b 0
)

echo 🅶 黒川 Desktop Operator — 出勤
echo    Ctrl+C で退勤
echo.
node scripts\desktop-operator.js watch

echo.
echo 🅶 黒川 退勤しました。
pause
