'use strict';
// =====================================================
// operator-status-check.js — Operator 状態判定ユーティリティ
//
// !operator status (Discord) と
// node scripts/desktop-operator.js status (CLI) の
// 判定ロジックを共通化する。
//
// PID 生存確認ルール:
//   EPERM → プロセス生存（権限エラーは「存在するが触れない」）
//   ESRCH → プロセス死亡
//   その他 → プロセス生存とみなす（保守的）
//
// 表示優先順位:
//   paused            → ⏸️ 一時停止
//   restart_requested → 🔄 再起動待ち
//   heartbeat fresh + PID alive → 🟢 勤務中
//   それ以外          → 🔴 停止中
// =====================================================

const fs   = require('fs');
const path = require('path');

const HEARTBEAT_STALE_MS = 30_000; // 30秒以内なら freshとみなす

// ─────────────────────────────────────────────────────
// isPidAlive(pid) — PID 生存確認
//
// EPERM = プロセス存在（権限なし） → true（生存）
// ESRCH = プロセスなし            → false（死亡）
// その他 = 不明                   → true（保守的に生存とみなす）
// ─────────────────────────────────────────────────────
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true; // シグナル送信成功 = 生存
  } catch (e) {
    if (e.code === 'ESRCH') return false; // No such process
    // EPERM (権限なし) やその他 = プロセスは存在する
    return true;
  }
}

// ─────────────────────────────────────────────────────
// checkOperatorRunning(opState) — 稼働状態を判定
//
// 戻り値:
//   {
//     isRunning:   bool,
//     statusCode:  'running' | 'paused' | 'restart_requested' | 'stopped',
//     statusLabel: '🟢 勤務中' | '⏸️ 一時停止' | '🔄 再起動待ち' | '🔴 停止中',
//     hbAge:       number (ms),
//     hbFresh:     bool,
//     pidAlive:    bool,
//     pid:         number | null,
//   }
// ─────────────────────────────────────────────────────
function checkOperatorRunning(opState) {
  const state = opState.loadState();
  const opSt  = state.operatorStatus || null;

  // heartbeat age
  const hbAge   = opSt?.lastHeartbeat
    ? Date.now() - new Date(opSt.lastHeartbeat).getTime()
    : Infinity;
  const hbFresh = hbAge < HEARTBEAT_STALE_MS;

  // PID 生存確認（state.json の operatorStatus.pid を優先）
  const pid      = opSt?.pid || _getLockPid(opState);
  const pidAlive = pid ? isPidAlive(pid) : false;

  // ステータス別判定（優先順位あり）
  const rawStatus = opSt?.status;

  let statusCode;
  if (state.paused || rawStatus === 'paused') {
    statusCode = 'paused';
  } else if (rawStatus === 'restart_requested') {
    statusCode = 'restart_requested';
  } else if (hbFresh && pidAlive && rawStatus !== 'stopped') {
    statusCode = 'running';
  } else {
    statusCode = 'stopped';
  }

  const STATUS_LABELS = {
    running:           '🟢 勤務中',
    paused:            '⏸️ 一時停止',
    restart_requested: '🔄 再起動待ち',
    stopped:           '🔴 停止中',
  };

  return {
    isRunning:   statusCode === 'running',
    statusCode,
    statusLabel: STATUS_LABELS[statusCode] || '🔴 停止中',
    hbAge,
    hbFresh,
    pidAlive,
    pid,
    hbAgeSeconds: Math.floor(hbAge / 1000),
  };
}

// lock ファイルから PID を取得（フォールバック）
function _getLockPid(opState) {
  try {
    const lockPath = path.join(opState.OP_DIR, 'operator.lock');
    if (!fs.existsSync(lockPath)) return null;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return lock.pid || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────
// formatStatus(opState, hist?) — Discord / CLI 用テキスト
// ─────────────────────────────────────────────────────
function formatStatus(opState, hist = []) {
  const state  = opState.loadState();
  const opSt   = state.operatorStatus || null;
  const check  = checkOperatorRunning(opState);
  const now    = new Date().toLocaleString('ja-JP');

  const sentCount  = hist.filter(h => h.autoSent).length;
  const blockedCnt = hist.filter(h => h.blockedReason).length;
  const lastSent   = hist.filter(h => h.autoSent).slice(-1)[0];

  let lastLabel = '（なし）';
  try {
    const { WORKER_DISPLAY } = require('./inbox-bridge');
    if (lastSent) lastLabel = `${WORKER_DISPLAY[lastSent.worker] || lastSent.worker} → ${lastSent.event || '?'}`;
  } catch {}

  const hbStr = opSt?.lastHeartbeat
    ? `${new Date(opSt.lastHeartbeat).toLocaleString('ja-JP')} (${check.hbAgeSeconds}秒前)`
    : '—';

  const lines = [
    `🅶 **黒川 Desktop Operator**`,
    ``,
    `状態: ${check.statusLabel}`,
    `PID: ${check.pid || '—'}${check.pidAlive ? '' : ' (停止)'}`,
    opSt?.startedAt ? `起動: ${new Date(opSt.startedAt).toLocaleString('ja-JP')}` : '',
    `最終 Heartbeat: ${hbStr}`,
    `モード: ${opSt?.mode || '—'}`,
    `処理数: ${hist.length}件 (送信 ${sentCount} / ブロック ${blockedCnt})`,
    `最終配送: ${lastLabel}`,
    opSt?.lastError ? `⚠️ 最終エラー: ${opSt.lastError}` : '',
    ``,
    `Lock: \`data/desktop-operator/operator.lock\``,
    `State: \`data/desktop-operator/state.json\``,
    ``,
    ...hist.filter(h => h.blockedReason).slice(-2).map(h =>
      `🚫 [${h.worker}] ${h.blockedReason}`
    ),
    ``,
    check.isRunning
      ? '> 稼働中: `npm run operator:once` で即時チェック可'
      : '> 起動: `powershell -ExecutionPolicy Bypass -File start-operator.ps1`',
  ].filter(l => l !== '');

  return { ok: true, text: lines.join('\n').slice(0, 1900), check };
}

module.exports = {
  isPidAlive,
  checkOperatorRunning,
  formatStatus,
  HEARTBEAT_STALE_MS,
};
