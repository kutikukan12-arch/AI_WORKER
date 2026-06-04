'use strict';
// =====================================================
// reply-collector.js — Desktop Operator Reply Collector
//
// 目的:
//   Claude Desktop へ送信後の回答を検出し、
//   data/inbox/<worker>/incoming.md に自動保存する。
//
// 検出方法:
//   クリップボードポーリング（5秒間隔）
//   送信前のクリップボード内容と変化があり、
//   返答フォーマット（## 結論 等）を含む場合に回答とみなす。
//
// 安全境界:
//   ✅ inbox 保存のみ
//   ❌ 回答を自動実行しない
//   ❌ task / decision を自動作成しない
//   ❌ exec / eval 禁止
//
// タイムアウト:
//   REPLY_TIMEOUT_MS 以内に回答がなければ黒川へ通知して停止。
//   無限待機禁止。
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR          = path.join(__dirname, '..', '..', 'data');
const PENDING_FILE      = path.join(DATA_DIR, 'desktop-operator', 'pending-replies.json');
const POLL_INTERVAL_MS  = 5_000;   // 5秒ごとにクリップボードをチェック
const REPLY_TIMEOUT_MS  = 10 * 60 * 1000; // 10分タイムアウト

// 返答フォーマットのシグネチャ（Prompt Wrapper の結果フォーマット）
const REPLY_SIGNATURES = [
  '## 結論',
  '## 実施内容',
  '## 変更ファイル',
  '## テスト結果',
  '## リスク',
  '## 次の配送先候補',
];

// ─────────────────────────────────────────────────────
// Pending Reply 管理
// ─────────────────────────────────────────────────────
function _loadPending() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return {};
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch { return {}; }
}

function _savePending(data) {
  const dir = path.dirname(PENDING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = PENDING_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, PENDING_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

// ─────────────────────────────────────────────────────
// クリップボード読み取り（内容を実行しない）
// ─────────────────────────────────────────────────────
function _readClipboard() {
  try {
    const { spawnSync } = require('child_process');

    if (process.platform === 'win32') {
      // PowerShell で Get-Clipboard（内容は変数として取得するだけ）
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return r.status === 0 ? (r.stdout || '') : null;
    } else if (process.platform === 'darwin') {
      const r = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 3000 });
      return r.status === 0 ? (r.stdout || '') : null;
    } else {
      // Linux: xclip
      const r = spawnSync('xclip', ['-selection', 'clipboard', '-o'],
        { encoding: 'utf8', timeout: 3000 });
      return r.status === 0 ? (r.stdout || '') : null;
    }
  } catch { return null; }
}

// ─────────────────────────────────────────────────────
// 回答テキスト検出（クリップボード内容から判定）
// ─────────────────────────────────────────────────────
function _isReplyContent(text, beforeHash) {
  if (!text || text.trim().length < 50) return false;
  const { createHash } = require('crypto');
  const currentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (currentHash === beforeHash) return false; // 変化なし

  // 返答フォーマットのシグネチャが含まれるか確認
  const hasSignature = REPLY_SIGNATURES.some(sig => text.includes(sig));
  return hasSignature;
}

// ─────────────────────────────────────────────────────
// markWaitingReply(worker, promptHash, histId) — 返信待ち状態を記録
// ─────────────────────────────────────────────────────
function markWaitingReply(worker, promptHash, histId) {
  const pending = _loadPending();
  pending[worker] = {
    worker,
    promptHash,
    histId,
    sentAt:     new Date().toISOString(),
    status:     'waiting_reply',
    clipHash:   null, // 送信時点のクリップボードハッシュ（初期化）
  };
  _savePending(pending);
}

// clipHash を設定（送信直後に呼ぶ）
function setPreSendClipHash(worker) {
  const pending = _loadPending();
  if (!pending[worker]) return;
  const clip = _readClipboard();
  const { createHash } = require('crypto');
  pending[worker].clipHash = clip
    ? createHash('sha256').update(clip).digest('hex').slice(0, 16)
    : 'empty';
  _savePending(pending);
}

// ─────────────────────────────────────────────────────
// clearWaitingReply(worker) — 返信待ち状態を解除
// ─────────────────────────────────────────────────────
function clearWaitingReply(worker) {
  const pending = _loadPending();
  delete pending[worker];
  _savePending(pending);
}

// ─────────────────────────────────────────────────────
// getWaitingReplies() — タイムアウトしていない返信待ち一覧
// ─────────────────────────────────────────────────────
function getWaitingReplies() {
  const pending = _loadPending();
  const now     = Date.now();
  const result  = [];
  for (const [worker, info] of Object.entries(pending)) {
    const age = now - new Date(info.sentAt).getTime();
    result.push({ ...info, ageMs: age, timedOut: age >= REPLY_TIMEOUT_MS });
  }
  return result;
}

// ─────────────────────────────────────────────────────
// pollClipboardForReply(worker) — クリップボードポーリング
//
// 返信が検出されたら incoming.md に保存して returning する。
// タイムアウトなら null を返す。
// ─────────────────────────────────────────────────────
function pollClipboardForReply(worker) {
  const pending = _loadPending()[worker];
  if (!pending) return { ok: false, reason: 'not_waiting' };

  const clip = _readClipboard();
  if (!clip) return { ok: false, reason: 'clipboard_read_failed' };

  // 変化 + 返答シグネチャ確認
  if (!_isReplyContent(clip, pending.clipHash)) {
    const age = Date.now() - new Date(pending.sentAt).getTime();
    if (age >= REPLY_TIMEOUT_MS) {
      clearWaitingReply(worker);
      return { ok: false, reason: 'timeout', ageMs: age };
    }
    return { ok: false, reason: 'no_reply_yet', ageMs: age };
  }

  // 回答を inbox に保存
  const saveResult = _saveReplyToInbox(worker, clip);
  if (saveResult.ok) {
    clearWaitingReply(worker);
  }
  return { ok: saveResult.ok, reason: 'reply_collected', ...saveResult };
}

// ─────────────────────────────────────────────────────
// _saveReplyToInbox(worker, replyText) — inbox に保存
//
// 安全境界:
//   ✅ redact 適用
//   ✅ 保存のみ
//   ❌ 内容を実行・判断しない
// ─────────────────────────────────────────────────────
function _saveReplyToInbox(worker, replyText) {
  try {
    const ib = require('./operator-bridge');
    // collectReply の content モードで保存
    return ib.collectReply(worker, { source: 'clipboard', content: replyText });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────
// startPolling(worker, callback, intervalMs?) — ポーリング開始
//
// callback(result): reply_collected / timeout / error 時に呼ばれる
// 戻り値: { stop() } — 停止関数
//
// 禁止:
//   ❌ callback から task/decision を自動作成しない
//   ❌ callback から Claude に再送しない
// ─────────────────────────────────────────────────────
function startPolling(worker, callback, intervalMs = POLL_INTERVAL_MS) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const result = pollClipboardForReply(worker);
    if (result.reason === 'no_reply_yet') return; // まだ待機中
    stopped = true;
    clearInterval(timer);
    if (typeof callback === 'function') callback(result);
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ─────────────────────────────────────────────────────
// buildTimeoutNotification(worker, info) — タイムアウト通知文
// ─────────────────────────────────────────────────────
function buildTimeoutNotification(worker, info) {
  const mins = Math.floor((info.ageMs || REPLY_TIMEOUT_MS) / 60000);
  const { WORKER_DISPLAY } = (() => {
    try { return require('./inbox-bridge'); } catch { return { WORKER_DISPLAY: {} }; }
  })();
  const disp = WORKER_DISPLAY[worker] || worker;

  return [
    `【Reply タイムアウト通知】`,
    ``,
    `${disp} への送信から ${mins}分 経過しましたが回答がありません。`,
    ``,
    `対応候補:`,
    `1. Claude Desktop を確認して回答をコピーしてください`,
    `2. !inbox check ${worker} で incoming.md を確認してください`,
    `3. 再送が必要な場合は !operator once で再試行してください`,
    ``,
    `※ これはタイムアウト通知のみです。自動的な再送はしません。`,
  ].join('\n');
}

module.exports = {
  markWaitingReply,
  setPreSendClipHash,
  clearWaitingReply,
  getWaitingReplies,
  pollClipboardForReply,
  startPolling,
  buildTimeoutNotification,
  PENDING_FILE,
  POLL_INTERVAL_MS,
  REPLY_TIMEOUT_MS,
  REPLY_SIGNATURES,
  // テスト用
  _readClipboard,
  _isReplyContent,
  _saveReplyToInbox,
  _loadPending,
  _savePending,
};
