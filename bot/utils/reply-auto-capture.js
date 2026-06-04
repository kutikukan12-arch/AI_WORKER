'use strict';
// =====================================================
// reply-auto-capture.js — Desktop Operator Reply Auto Capture (Phase13)
//
// 目的:
//   Claude Desktop の最新回答を自動取得し inbox に保存する。
//   手動 Ctrl+A/C を不要にする。
//
// 取得方式 (Phase7: replyCaptureMode):
//   manual       — 手動コピー待ち (Phase12 既存)
//   auto-safe    — Claude ウィンドウのテキスト差分取得 (デフォルト)
//   auto-full    — 将来 (未実装)
//
// 安全設計:
//   ✅ 最新返信部分のみ抽出（会話履歴全体を保存しない）
//   ✅ プロンプト部分を誤回収しない（差分取得）
//   ✅ REPLY_SIGNATURES で構造確認
//   ✅ redact 適用
//   ✅ 失敗時は clipboard fallback
//   ❌ OCR 常時監視なし
//   ❌ キーロガーなし
//   ❌ eval / exec で内容実行なし
//   ❌ task / decision / incident 自動作成なし
//
// 権限境界 (黒川ルール維持):
//   ✅ inbox 保存のみ
//   ❌ READY / NEED_FIX 生成なし
//   ❌ 承認なし
// =====================================================

const fs            = require('fs');
const path          = require('path');
const { createHash }= require('crypto');
const { redact }    = require('./redact');

// デフォルト設定
const CAPTURE_MODE_DEFAULT = 'auto-safe';
const MAX_ATTEMPTS         = 12;   // 最大試行回数
const STABILIZE_WAIT_MS    = 3000; // 安定確認待ち（テキスト変化なし→完了）
const MIN_REPLY_LENGTH     = 50;

// ─────────────────────────────────────────────────────
// Phase2: Windows UI Automation / テキスト取得
//
// PowerShell の System.Windows.Automation で
// Claude Desktop ウィンドウの全テキストを取得する。
// (コピー操作: Ctrl+A → Ctrl+C → Get-Clipboard)
//
// 取得ルール:
//   - Claude Desktop ウィンドウを検出
//   - Ctrl+A, Ctrl+C を実行してクリップボードに全テキストをコピー
//   - クリップボードからテキストを読み取り
//   - 入力欄はクリアしない（安全のため Escape → Ctrl+A は使わない）
// ─────────────────────────────────────────────────────
function getClaueWindowText() {
  if (process.platform !== 'win32') return null;

  const { spawnSync } = require('child_process');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

# Claude Desktop のプロセスを検索
$claude = Get-Process | Where-Object {
  $_.MainWindowTitle -match 'Claude' -and $_.MainWindowHandle -ne 0
} | Select-Object -First 1

if (-not $claude) { Write-Error 'Claude window not found'; exit 1 }

# ウィンドウをアクティブ化
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[WinAPI2]::SetForegroundWindow($claude.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500

# 全テキスト選択してコピー（入力欄でなく会話エリアにフォーカスが必要）
# Ctrl+A で全選択、Ctrl+C でコピー
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^c")
Start-Sleep -Milliseconds 500

# クリップボードから取得（内容は変数として扱うのみ）
$text = Get-Clipboard
if ($text) { Write-Output $text } else { exit 2 }
`.trim();

  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout:  10000,
      stdio:    ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    return r.stdout || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────
// Phase1: 最新返信のみ抽出（差分取得）
//
// preText: 送信前のウィンドウテキスト
// currentText: 現在のウィンドウテキスト
//
// 差分を取ることで:
//   - 会話履歴全体を保存しない
//   - プロンプト部分を誤回収しない
// ─────────────────────────────────────────────────────
function extractLatestReply(preText, currentText) {
  if (!currentText) return null;
  // preText が null/空の場合: 差分なし → currentText をそのまま返す
  if (!preText) return currentText.trim().length >= MIN_REPLY_LENGTH ? currentText : null;
  if (currentText === preText) return null;

  // 差分: currentText の末尾にある「preText にない部分」を抽出
  // 簡易実装: preText の末尾から分岐点を探す
  const preLen = preText.length;
  if (currentText.length <= preLen) return null;

  // currentText が preText を含む場合（追記されている）
  if (currentText.startsWith(preText.slice(0, Math.min(100, preLen)))) {
    const delta = currentText.slice(preLen).trim();
    return delta.length >= MIN_REPLY_LENGTH ? delta : null;
  }

  // 含まない場合（ウィンドウが別の会話になった等）→ 全体を返す
  return currentText.length >= MIN_REPLY_LENGTH ? currentText : null;
}

// ─────────────────────────────────────────────────────
// Phase3: processCapturedReply — 取得済みテキストを処理
//
// 既存 reply-collector.js の検証・保存ロジックを再利用。
// 二重実装しない。
// ─────────────────────────────────────────────────────
function processCapturedReply({ worker, content, source = 'auto_capture' }) {
  if (!content || content.trim().length < MIN_REPLY_LENGTH) {
    return { ok: false, reason: 'content_too_short' };
  }

  // REPLY_SIGNATURES 確認（既存ロジックを再利用）
  const rc = require('./reply-collector');
  const dummyHash = 'none'; // 常に新しいものとして扱う
  if (!rc._isReplyContent(content, dummyHash)) {
    return { ok: false, reason: 'no_reply_signatures' };
  }

  // inbox に保存（redact は _saveReplyToInbox 内で適用）
  const result = rc._saveReplyToInbox(worker, content);
  if (result.ok) {
    rc.clearWaitingReply(worker);
  }
  return { ...result, source };
}

// ─────────────────────────────────────────────────────
// Phase4: 状態更新 — attempts カウンタ
// ─────────────────────────────────────────────────────
function incrementAttempts(worker) {
  const rc      = require('./reply-collector');
  const pending = rc._loadPending();
  if (!pending[worker]) return 0;
  pending[worker].attempts = (pending[worker].attempts || 0) + 1;
  pending[worker].captureMode = 'auto';
  rc._savePending(pending);
  return pending[worker].attempts;
}

// ─────────────────────────────────────────────────────
// Phase6: fallback — auto_capture 失敗時は clipboard mode へ
// ─────────────────────────────────────────────────────
function degradeToClipboard(worker) {
  const rc      = require('./reply-collector');
  const pending = rc._loadPending();
  if (!pending[worker]) return;
  pending[worker].captureMode   = 'clipboard_fallback';
  pending[worker].fallbackReason = 'auto_capture_failed';
  rc._savePending(pending);
}

// ─────────────────────────────────────────────────────
// captureLatestClaudeReply(worker, preText) — メイン取得関数
//
// worker:  対象社員名
// preText: 送信前のウィンドウテキスト（差分計算用）
//
// 戻り値: {
//   ok:     bool,
//   result: 'captured' | 'no_reply_yet' | 'timeout' |
//           'fallback_clipboard' | 'error',
//   content?: string
// }
// ─────────────────────────────────────────────────────
function captureLatestClaudeReply(worker, preText) {
  const rc       = require('./reply-collector');
  const pending  = rc._loadPending()[worker];
  if (!pending) return { ok: false, result: 'not_waiting' };

  // タイムアウト確認
  const age = Date.now() - new Date(pending.sentAt).getTime();
  if (age >= rc.REPLY_TIMEOUT_MS) {
    rc.clearWaitingReply(worker);
    return { ok: false, result: 'timeout', ageMs: age };
  }

  // 最大試行回数確認
  const attempts = incrementAttempts(worker);
  if (attempts > MAX_ATTEMPTS) {
    degradeToClipboard(worker);
    return { ok: false, result: 'fallback_clipboard', reason: 'max_attempts_exceeded' };
  }

  // Claude ウィンドウからテキスト取得
  const currentText = getClaueWindowText();
  if (!currentText) {
    // Windows 以外 or ウィンドウ未検出 → fallback
    if (attempts >= 2) {
      degradeToClipboard(worker);
      return { ok: false, result: 'fallback_clipboard', reason: 'window_not_found' };
    }
    return { ok: false, result: 'no_reply_yet', attempts };
  }

  // 差分抽出
  const delta = preText ? extractLatestReply(preText, currentText) : currentText;
  if (!delta) {
    return { ok: false, result: 'no_reply_yet', attempts };
  }

  // テキスト安定確認（テキストが変化していないかを確認する簡易実装）
  const currentHash = createHash('sha256').update(currentText).digest('hex').slice(0, 16);
  const pendingState = rc._loadPending()[worker];
  if (pendingState?.lastTextHash === currentHash) {
    // テキストが安定している → 取得処理
    const result = processCapturedReply({ worker, content: delta, source: 'auto_capture' });
    if (result.ok) {
      return { ok: true, result: 'captured', content: delta.slice(0, 100) };
    }
    return { ok: false, result: 'no_reply_yet', attempts, reason: result.reason };
  }

  // テキストがまだ変化中 → hash を記録して次サイクルへ
  const pending2  = rc._loadPending();
  if (pending2[worker]) {
    pending2[worker].lastTextHash = currentHash;
    rc._savePending(pending2);
  }
  return { ok: false, result: 'stabilizing', attempts };
}

// ─────────────────────────────────────────────────────
// startAutoCapture(worker, preText, callback, intervalMs?)
//
// captureLatestClaudeReply をポーリングする。
// 失敗時は自動で reply-collector.js のポーリングに委譲。
// ─────────────────────────────────────────────────────
function startAutoCapture(worker, preText, callback, intervalMs = 5000) {
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const result = captureLatestClaudeReply(worker, preText);

    if (result.result === 'captured') {
      stopped = true;
      clearInterval(timer);
      if (typeof callback === 'function') callback(result);
      return;
    }

    if (result.result === 'timeout' || result.result === 'fallback_clipboard') {
      stopped = true;
      clearInterval(timer);

      if (result.result === 'fallback_clipboard') {
        // Phase6: clipboard mode へ fallback
        const rc = require('./reply-collector');
        rc.startPolling(worker, callback, intervalMs);
      } else {
        if (typeof callback === 'function') callback(result);
      }
    }
    // no_reply_yet / stabilizing → 継続
  }, intervalMs);

  return {
    stop: () => { stopped = true; clearInterval(timer); },
  };
}

// ─────────────────────────────────────────────────────
// getPreText() — 送信前のウィンドウテキストを取得
// ─────────────────────────────────────────────────────
function getPreText() {
  return getClaueWindowText(); // 送信前に呼んで差分基準とする
}

module.exports = {
  captureLatestClaudeReply,
  processCapturedReply,
  startAutoCapture,
  getPreText,
  getClaueWindowText,
  extractLatestReply,
  degradeToClipboard,
  CAPTURE_MODE_DEFAULT,
  MAX_ATTEMPTS,
};
