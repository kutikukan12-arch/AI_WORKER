@echo off
REM 学習巡回ランナー (Windowsタスクスケジューラ用) — 🅷 Claude H
REM lessons-patrol.js を実行し、コンソール出力を logs\patrol.log に追記する。
REM スクリプトは __dirname 基準でパスを解決するため cwd 非依存。
cd /d "%~dp0.."
echo ======== %DATE% %TIME% patrol start ======== >> "%~dp0..\logs\patrol.log"
node "%~dp0lessons-patrol.js" >> "%~dp0..\logs\patrol.log" 2>&1
