'use strict';
// =====================================================
// desktop-operator-state.js — Desktop Operator State (Phase1+7)
//
// 目的:
//   黒川が outbox を監視し、固定ルート由来のメッセージを
//   Claude Desktop へ安全に届けるための状態管理。
//
// 保存:
//   data/desktop-operator/state.json   — 監視状態
//   data/desktop-operator/history.json — 監査ログ
//   data/desktop-operator/locks/       — 処理中ロック
// =====================================================

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const OP_DIR       = path.join(DATA_DIR, 'desktop-operator');
const STATE_FILE   = path.join(OP_DIR, 'state.json');
const HISTORY_FILE = path.join(OP_DIR, 'history.json');
const LOCKS_DIR    = path.join(OP_DIR, 'locks');

// ─────────────────────────────────────────────────────
// ディレクトリ確保
// ─────────────────────────────────────────────────────
function _ensureDir() {
  [OP_DIR, LOCKS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ─────────────────────────────────────────────────────
// State ファイル操作
// ─────────────────────────────────────────────────────
function loadState() {
  _ensureDir();
  try {
    if (!fs.existsSync(STATE_FILE)) return _emptyState();
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return _emptyState(); }
}

function saveState(state) {
  _ensureDir();
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function _emptyState() {
  return {
    version:   '1',
    updatedAt: null,
    workers:   {},   // { <worker>: { lastHash, lastSeenAt, pendingSendId } }
    processedIds: [], // 重複送信防止: 送信済みhistory id
  };
}

// ─────────────────────────────────────────────────────
// History (Audit Log) ファイル操作
// ─────────────────────────────────────────────────────
function loadHistory() {
  _ensureDir();
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { return []; }
}

function appendHistory(entry) {
  _ensureDir();
  const list = loadHistory();
  list.push(entry);
  // 直近500件を保持
  const trimmed = list.slice(-500);
  const tmp = HISTORY_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// ロック管理（多重起動防止）
// ─────────────────────────────────────────────────────
function acquireLock(worker) {
  _ensureDir();
  const lockFile = path.join(LOCKS_DIR, `${worker}.lock`);
  if (fs.existsSync(lockFile)) {
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const age = Date.now() - new Date(content.at).getTime();
    if (age < 60000) return false; // 60秒以内のロックは有効
    fs.unlinkSync(lockFile); // 古いロックは解除
  }
  fs.writeFileSync(lockFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }));
  return true;
}

function releaseLock(worker) {
  const lockFile = path.join(LOCKS_DIR, `${worker}.lock`);
  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// ハッシュ計算
// ─────────────────────────────────────────────────────
function hashContent(content) {
  if (!content) return '';
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────
// 重複送信チェック
// ─────────────────────────────────────────────────────
function isAlreadyProcessed(historyId) {
  const state = loadState();
  return (state.processedIds || []).includes(historyId);
}

function markProcessed(historyId) {
  const state = loadState();
  state.processedIds = [...(state.processedIds || []), historyId].slice(-200);
  saveState(state);
}

module.exports = {
  loadState,
  saveState,
  loadHistory,
  appendHistory,
  acquireLock,
  releaseLock,
  hashContent,
  isAlreadyProcessed,
  markProcessed,
  STATE_FILE,
  HISTORY_FILE,
  LOCKS_DIR,
  OP_DIR,
};
