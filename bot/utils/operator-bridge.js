'use strict';
// =====================================================
// operator-bridge.js — Desktop Operator Phase11 自動往復化
//
// Phase1: Outbox Queue 処理
// Phase2: Claude Desktop Bridge（clipboard → 送信）
// Phase3: Reply 回収（incoming.md 保存）
// Phase4: Safety（allowlist / redact / path traversal 防止）
//
// 重要ルール:
//   ✅ 黒川は内容を変更しない / 要約しない / 判断追加しない
//   ✅ 許可: コピー / 貼り付け / 送信 / 状態記録
//   ❌ 禁止: 内容判断 / READY-NEED_FIX生成 / 承認 / タスク作成
//   ❌ 禁止: eval / exec で本文実行 / path traversal
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ─── allowlist ────────────────────────────────────────
// Phase4: 許可された worker のみ操作する
const ALLOWED_WORKERS = new Set([
  'miyagi', 'moriya', 'shiraishi', 'aizawa',
  'ichikawa', 'kanemori', 'kurokawa', 'ikuno', 'kanzaki',
]);

// ─────────────────────────────────────────────────────
// Phase4: Path traversal 防止
// ─────────────────────────────────────────────────────
function _safePath(worker, type) {
  // worker 名がホワイトリスト外なら null を返す
  if (!ALLOWED_WORKERS.has(worker)) return null;
  // 絶対パスとして組み立て、DATA_DIR 配下かを確認
  const base = path.join(DATA_DIR, type, worker);
  const resolved = path.resolve(base);
  if (!resolved.startsWith(path.resolve(DATA_DIR))) return null;
  return resolved;
}

function getOutboxPath(worker) {
  const dir = _safePath(worker, 'outbox');
  return dir ? path.join(dir, 'outgoing.md') : null;
}

function getInboxPath(worker) {
  const dir = _safePath(worker, 'inbox');
  return dir ? path.join(dir, 'incoming.md') : null;
}

// ─────────────────────────────────────────────────────
// Phase1: Outbox Queue 読み込み
//
// 各 worker の outgoing.md を読み、
// redact 済みのコンテンツを返す。
// hash で変更検出・二重処理防止。
// ─────────────────────────────────────────────────────
function readOutboxQueue(opState) {
  const queue     = [];
  const state     = opState.loadState();
  const processed = new Set(state.processedIds || []);

  for (const worker of ALLOWED_WORKERS) {
    const outPath = getOutboxPath(worker);
    if (!outPath || !fs.existsSync(outPath)) continue;

    const raw  = fs.readFileSync(outPath, 'utf8').trim();
    if (!raw) continue;

    const hash = opState.hashContent(raw);
    const key  = `outbox_${worker}_${hash}`;

    // 二重処理防止
    if (processed.has(key)) continue;

    queue.push({
      worker,
      outboxPath: outPath,
      rawContent: raw,
      safeContent: redact(raw),  // 表示・送信用 redact 済み
      hash,
      processKey: key,
    });
  }
  return queue;
}

// ─────────────────────────────────────────────────────
// Phase2: Claude Desktop Bridge
//
// 内容をクリップボードにコピーする（変更なし）。
// auto-send モードでは PowerShell でウィンドウを探して貼り付ける。
// 黒川は内容を一切変更しない。
//
// sendMode: 'clipboard' | 'auto'
// ─────────────────────────────────────────────────────
function bridgeToClaudeDesktop(prompt, opts = {}) {
  const { sendMode = 'clipboard', workerLabel = 'worker' } = opts;
  const safePrompt = String(prompt); // 既に redact 済みを前提

  // clipboard コピー（spawnSync stdin 経由 — 本文をコマンド引数にしない）
  const { spawnSync } = require('child_process');
  let clipResult = { ok: false, method: null };

  const clipCommands = {
    win32:  [['clip']],
    darwin: [['pbcopy']],
    linux:  [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]],
  };
  const cmds = clipCommands[process.platform] || clipCommands.linux;

  for (const [prog, args = []] of cmds) {
    try {
      const r = spawnSync(prog, args, { input: safePrompt, encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) { clipResult = { ok: true, method: `${prog}` }; break; }
    } catch { /* try next */ }
  }

  if (!clipResult.ok) {
    return { ok: false, mode: 'clipboard', error: 'クリップボードへのコピーに失敗しました' };
  }

  let autoSendResult = null;

  // auto-send: PowerShell で Claude Desktop へ送信（Windows のみ）
  if (sendMode === 'auto' && process.platform === 'win32') {
    autoSendResult = _autoSendWindows(safePrompt, workerLabel);
  }

  return {
    ok:         true,
    mode:       sendMode === 'auto' && autoSendResult?.ok ? 'auto' : 'clipboard',
    clipOk:     clipResult.ok,
    autoSendOk: autoSendResult?.ok || false,
    autoSendError: autoSendResult?.error || null,
  };
}

// Windows PowerShell で Claude Desktop ウィンドウを探して貼り付け＋Enter
// 注意: 本文をコマンド引数に渡さない。クリップボードから Ctrl+V するだけ。
function _autoSendWindows(prompt, workerLabel) {
  const { spawnSync } = require('child_process');

  // PowerShell スクリプト: クリップボードを貼り付けて Enter を押す
  // - Claude ウィンドウを探す
  // - 見つかったらアクティブ化して Ctrl+V + Enter
  // - セキュリティ: 本文は埋め込まない、クリップボードから取得
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$claude = Get-Process | Where-Object { $_.MainWindowTitle -match 'Claude' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $claude) { Write-Error 'Claude Desktop window not found'; exit 1 }
[System.Windows.Forms.Form]$f = [System.Windows.Forms.Form]::new()
$null = $f.Handle
$null = [System.Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate([System.Windows.Forms.NativeMethods])
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
}
"@
[WinAPI]::SetForegroundWindow($claude.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output "sent"
`.trim();

  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout:  10000,
      // 本文はクリップボード経由 — ここには渡さない
    });
    if (r.status === 0 && r.stdout.includes('sent')) {
      return { ok: true };
    }
    return { ok: false, error: r.stderr?.trim() || 'PowerShell error' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────
// Phase3: Reply 回収
//
// クリップボードから回答を取得、または
// ユーザーが手動で incoming.md に貼った内容を読む。
//
// source: 'clipboard' | 'file'
// ─────────────────────────────────────────────────────
function collectReply(worker, opts = {}) {
  const { source = 'file', content = null } = opts;
  const inPath = getInboxPath(worker);
  if (!inPath) return { ok: false, error: `worker '${worker}' は allowlist 外` };

  let replyContent = null;

  if (source === 'clipboard' && content) {
    replyContent = content;
  } else if (source === 'file') {
    if (!fs.existsSync(inPath)) return { ok: false, error: 'incoming.md が存在しません' };
    replyContent = fs.readFileSync(inPath, 'utf8').trim();
  }

  if (!replyContent) return { ok: false, error: '回答内容が空です' };

  // redact してから保存
  const safeReply = redact(replyContent);
  const dir = path.dirname(inPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 既存内容に追記（タイムスタンプ付き）
  const entry = `\n---\n**回答受信: ${new Date().toLocaleString('ja-JP')}**\n\n${safeReply}\n`;
  fs.appendFileSync(inPath, entry, 'utf8');

  return {
    ok:        true,
    worker,
    inboxPath: inPath,
    preview:   safeReply.slice(0, 100),
  };
}

// ─────────────────────────────────────────────────────
// Phase5: Pause / Resume
// ─────────────────────────────────────────────────────
function setPaused(opState, paused, reason = '') {
  const state = opState.loadState();
  state.paused       = paused;
  state.pausedReason = paused ? reason : null;
  state.pausedAt     = paused ? new Date().toISOString() : null;
  opState.saveState(state);
}

function isPaused(opState) {
  const state = opState.loadState();
  return !!state.paused;
}

module.exports = {
  readOutboxQueue,
  bridgeToClaudeDesktop,
  collectReply,
  setPaused,
  isPaused,
  getOutboxPath,
  getInboxPath,
  ALLOWED_WORKERS,
};
