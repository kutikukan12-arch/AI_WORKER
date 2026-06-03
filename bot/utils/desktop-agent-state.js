'use strict';
// =====================================================
// desktop-agent-state.js — Desktop Agent 状態管理
//
// data/desktop-agent/state.json を管理する。
// Desktop Agent が outbox/inbox の変化を検出するための
// ハッシュ・タイムスタンプ・通知履歴を保持する。
//
// スキーマ:
// {
//   version:    "1",
//   updatedAt:  ISO,
//   workers: {
//     miyagi: {
//       lastOutgoingHash: "hex16",  // outgoing.md の最終既読ハッシュ
//       lastNotifiedAt:   ISO,      // 最後に通知した時刻
//       hasIncoming:      bool,     // inbox に未確認の incoming.md があるか
//       lastIncomingHash: "hex16"   // incoming.md の最終既読ハッシュ
//     },
//     ...
//   },
//   pendingWorkers:  string[],  // 新しい outgoing がある社員
//   incomingWorkers: string[],  // incoming がある社員
//   errorLog:        { at, msg }[]  // 直近10件のエラー
// }
// =====================================================

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const AGENT_DIR   = path.join(DATA_DIR, 'desktop-agent');
const STATE_FILE  = path.join(AGENT_DIR, 'state.json');
const MAX_ERRORS  = 10;

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return _emptyState();
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return _emptyState();
  }
}

function saveState(state) {
  if (!fs.existsSync(AGENT_DIR)) fs.mkdirSync(AGENT_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  state.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function _emptyState() {
  return {
    version:         '1',
    updatedAt:       null,
    workers:         {},
    pendingWorkers:  [],
    incomingWorkers: [],
    errorLog:        [],
  };
}

// ─────────────────────────────────────────────────────
// ハッシュ計算
// ─────────────────────────────────────────────────────
function hashContent(content) {
  if (!content) return '';
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────
// 状態操作 API
// ─────────────────────────────────────────────────────

// 社員の outgoing ハッシュを更新（既読マーク）
function markOutgoingSeen(worker, hash) {
  const state = loadState();
  if (!state.workers[worker]) state.workers[worker] = {};
  state.workers[worker].lastOutgoingHash = hash;
  state.workers[worker].lastNotifiedAt   = new Date().toISOString();
  // pendingWorkers から除外
  state.pendingWorkers = (state.pendingWorkers || []).filter(w => w !== worker);
  saveState(state);
}

// 社員の incoming を既読にする
function markIncomingSeen(worker, hash) {
  const state = loadState();
  if (!state.workers[worker]) state.workers[worker] = {};
  state.workers[worker].lastIncomingHash = hash;
  state.workers[worker].hasIncoming      = false;
  // incomingWorkers から除外
  state.incomingWorkers = (state.incomingWorkers || []).filter(w => w !== worker);
  saveState(state);
}

// pending / incoming を更新
function updatePending(pendingWorkers, incomingWorkers) {
  const state = loadState();
  state.pendingWorkers  = pendingWorkers;
  state.incomingWorkers = incomingWorkers;
  // workers の hasIncoming を同期
  for (const w of incomingWorkers) {
    if (!state.workers[w]) state.workers[w] = {};
    state.workers[w].hasIncoming = true;
  }
  saveState(state);
}

// エラーを記録（直近 MAX_ERRORS 件のみ保持）
function logError(msg) {
  const state = loadState();
  state.errorLog = state.errorLog || [];
  state.errorLog.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 200) });
  if (state.errorLog.length > MAX_ERRORS) {
    state.errorLog = state.errorLog.slice(-MAX_ERRORS);
  }
  saveState(state);
}

// 社員の前回ハッシュを取得
function getWorkerHashes(worker) {
  const state = loadState();
  const w     = state.workers[worker] || {};
  return {
    outgoingHash: w.lastOutgoingHash || null,
    incomingHash: w.lastIncomingHash || null,
    hasIncoming:  !!w.hasIncoming,
  };
}

module.exports = {
  loadState,
  saveState,
  hashContent,
  markOutgoingSeen,
  markIncomingSeen,
  updatePending,
  logError,
  getWorkerHashes,
  STATE_FILE,
  AGENT_DIR,
};
