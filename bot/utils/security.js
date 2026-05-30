'use strict';

// =====================================================
// security.js - セキュリティチェックユーティリティ
// 役割: 危険なコマンドや指示を事前にブロックする
// 注意: Claude Code の実行前に必ずチェックすること
// =====================================================

const logger = require('./logger');

// ─────────────────────────────────────────────────────
// 危険パターン一覧
// これらのパターンがプロンプトに含まれていた場合はブロックする
// ─────────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  // ファイル・フォルダ削除系
  { pattern: /rm\s+-rf/i,                  reason: 'rm -rf（強制削除コマンド）は禁止です' },
  { pattern: /rmdir\s+\/s/i,               reason: 'rmdir /s（フォルダ削除コマンド）は禁止です' },
  { pattern: /del\s+\/[sfq]/i,             reason: 'del /s /f /q（ファイル強制削除）は禁止です' },
  { pattern: /remove-item\s+-recurse/i,    reason: 'Remove-Item -Recurse（フォルダ削除）は禁止です' },

  // システム操作系
  { pattern: /shutdown\s+\/[srfa]/i,       reason: 'shutdownコマンドは禁止です' },
  { pattern: /restart-computer/i,          reason: 'Restart-Computerは禁止です' },
  { pattern: /stop-computer/i,             reason: 'Stop-Computerは禁止です' },
  { pattern: /format\s+[a-z]:/i,          reason: 'formatコマンド（ドライブ初期化）は禁止です' },

  // プロセス操作系
  { pattern: /taskkill\s+\/[fpi]/i,        reason: 'taskkillコマンドは禁止です' },
  { pattern: /kill\s+-9/i,                 reason: 'kill -9コマンドは禁止です' },
  { pattern: /stop-process/i,              reason: 'Stop-Processは禁止です' },

  // レジストリ・システム設定変更
  { pattern: /reg\s+(delete|add|import)/i, reason: 'レジストリ操作は禁止です' },
  { pattern: /regedit/i,                   reason: 'regeditの起動は禁止です' },

  // ネットワーク設定変更
  { pattern: /netsh\s+advfirewall/i,       reason: 'ファイアウォール変更は禁止です' },
  { pattern: /netsh\s+interface/i,         reason: 'ネットワーク設定変更は禁止です' },

  // 危険なコマンド実行
  { pattern: /powershell\s+-exec\s+bypass/i, reason: '実行ポリシー回避は禁止です' },
  { pattern: /curl.*\|.*sh/i,              reason: 'ダウンロード→即実行パターンは禁止です' },
  { pattern: /wget.*\|.*bash/i,            reason: 'ダウンロード→即実行パターンは禁止です' },
  { pattern: /invoke-expression.*download/i, reason: 'リモートスクリプト実行は禁止です' },
  { pattern: /iex\s*\(/i,                  reason: 'Invoke-Expression（コード動的実行）は禁止です' },

  // ディレクトリトラバーサル（workspace外へのアクセス試行）
  { pattern: /\.\.[\/\\]\.\.[\/\\]/,       reason: '上位フォルダへのアクセス（../..）は禁止です' },
  { pattern: /[Cc]:\\/,                    reason: 'Cドライブへの直接アクセスは禁止です' },
  { pattern: /[Dd]:\\/,                    reason: '絶対パスでのドライブアクセスは禁止です' },
];

// ─────────────────────────────────────────────────────
// 最大長チェック
// 極端に長いプロンプトはトークン爆発・誤動作の原因になる
// ─────────────────────────────────────────────────────
const MAX_PROMPT_LENGTH = 2000;

// ─────────────────────────────────────────────────────
// プロンプトの安全性チェック関数
// 戻り値: { safe: true } または { safe: false, reason: 'エラー理由' }
// ─────────────────────────────────────────────────────
function checkPrompt(prompt) {
  // 長さチェック
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      safe: false,
      reason: `プロンプトが長すぎます（${prompt.length}文字 / 最大${MAX_PROMPT_LENGTH}文字）`
    };
  }

  // 空白のみチェック
  if (!prompt.trim()) {
    return { safe: false, reason: 'プロンプトが空です' };
  }

  // 危険パターンのチェック
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(prompt)) {
      logger.warn(`危険パターン検出: ${reason} | パターン: ${pattern}`);
      return { safe: false, reason };
    }
  }

  return { safe: true };
}

module.exports = { checkPrompt };
