'use strict';

// =====================================================
// logger.js - ログ管理ユーティリティ
// 役割: 実行記録をファイルとコンソールに保存する
// 保存先: logs/YYYY-MM-DD.log
// =====================================================

const fs = require('fs');
const path = require('path');

// ログを保存するフォルダのパス
const LOGS_PATH = path.join(__dirname, '..', '..', 'logs');

// ログフォルダが存在しない場合は自動作成
if (!fs.existsSync(LOGS_PATH)) {
  fs.mkdirSync(LOGS_PATH, { recursive: true });
}

// 今日の日付でログファイル名を生成（例: 2026-05-28.log）
function getLogFilePath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_PATH, `${today}.log`);
}

// ログレベルに応じてコンソール色を変える設定
const LEVEL_COLORS = {
  INFO:  '\x1b[32m', // 緑
  WARN:  '\x1b[33m', // 黄
  ERROR: '\x1b[31m', // 赤
  DEBUG: '\x1b[36m', // シアン
};
const RESET = '\x1b[0m';

// LOG_LEVEL 環境変数でコンソール出力の最低レベルを制御できる
// 例: LOG_LEVEL=WARN → INFO/DEBUG はコンソールに出ない（ファイルには記録）
const LEVEL_ORDER = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// ─── メインのログ出力関数 ───
function log(level, message) {
  const timestamp = new Date().toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  // コンソールへ色付きで出力（LOG_LEVEL 未満はスキップ）
  const minLevel = LEVEL_ORDER[process.env.LOG_LEVEL] ?? 0;
  if ((LEVEL_ORDER[level] ?? 0) >= minLevel) {
    const color = LEVEL_COLORS[level] || '';
    console.log(`${color}[${timestamp}] [${level}]${RESET} ${message}`);
  }

  // ファイルへ色なしで保存
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(getLogFilePath(), logLine, 'utf8');
  } catch (err) {
    // ログ書き込み失敗はコンソールのみ表示（無限ループ防止）
    console.error('ログファイル書き込みエラー:', err.message);
  }
}

// ─── 各ログレベルの関数 ───
module.exports = {
  info:  (msg) => log('INFO',  msg),
  warn:  (msg) => log('WARN',  msg),
  error: (msg) => log('ERROR', msg),
  debug: (msg) => log('DEBUG', msg),
};
