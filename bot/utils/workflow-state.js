'use strict';
// =====================================================
// workflow-state.js — Workflow State + Waiting Detection (Phase8+9)
//
// Phase8: 待ち時間の長いアイテムを検出
// Phase9: Daily Closing 用データ保存（自動投稿はしない）
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const STATE_FILE  = path.join(DATA_DIR, 'workflow-state.json');

const DEFAULT_WAIT_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3時間

// ─── スキーマ ─────────────────────────────────────────
// {
//   handoffs: [{ id, event, from, to, taskId, createdAt, resolvedAt? }],
//   dailyLog: [{ date, completed:[], incomplete:[], blocked:[], memo }],
//   updatedAt: ISO
// }

function _load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return _empty();
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return _empty(); }
}

function _save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  data.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function _empty() {
  return { handoffs: [], dailyLog: [], updatedAt: null };
}

// ─────────────────────────────────────────────────────
// recordHandoff(routeResult, taskId?) — ハンドオフを記録
// ─────────────────────────────────────────────────────
function recordHandoff(routeResult, taskId) {
  if (!routeResult?.ok) return;
  const state = _load();
  const now   = new Date().toISOString();
  const id    = `hoff_${Date.now()}${Math.floor(Math.random()*0x100).toString(16).padStart(2,'0')}`;
  state.handoffs.push({
    id,
    event:     routeResult.event,
    from:      routeResult.from || null,
    to:        routeResult.to,
    taskId:    taskId || null,
    createdAt: now,
    resolvedAt: null,
  });
  // 直近100件のみ保持
  if (state.handoffs.length > 100) state.handoffs = state.handoffs.slice(-100);
  _save(state);
  return id;
}

// resolveHandoff(id) — 解決済みマーク
function resolveHandoff(id) {
  const state = _load();
  const h = state.handoffs.find(h => h.id === id || h.taskId === id);
  if (h) { h.resolvedAt = new Date().toISOString(); _save(state); }
}

// ─────────────────────────────────────────────────────
// detectWaiting(thresholdMs?) — 長待ちアイテム検出 (Phase8)
//
// resolvedAt が null で createdAt から thresholdMs 以上経過したものを返す
// ─────────────────────────────────────────────────────
function detectWaiting(thresholdMs = DEFAULT_WAIT_THRESHOLD_MS) {
  const state   = _load();
  const now     = Date.now();
  const waiting = state.handoffs.filter(h => {
    if (h.resolvedAt) return false;
    const age = now - new Date(h.createdAt).getTime();
    return age >= thresholdMs;
  });
  return waiting.map(h => ({
    ...h,
    ageMs:     now - new Date(h.createdAt).getTime(),
    ageLabel:  _ageLabel(now - new Date(h.createdAt).getTime()),
  }));
}

function _ageLabel(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}日`;
  if (h > 0)  return `${h}時間`;
  return `${m}分`;
}

// ─────────────────────────────────────────────────────
// saveDailySnapshot(data) — Phase9: 日次データ保存
//
// data: { completed[], incomplete[], blocked[], memo? }
// 自動投稿はしない。データ保存のみ。
// ─────────────────────────────────────────────────────
function saveDailySnapshot(data) {
  const state = _load();
  const today = new Date().toISOString().slice(0, 10);

  // 今日のエントリを上書き or 追加
  const idx = state.dailyLog.findIndex(e => e.date === today);
  const entry = {
    date:       today,
    completed:  data.completed  || [],
    incomplete: data.incomplete || [],
    blocked:    data.blocked    || [],
    memo:       data.memo       || '',
    savedAt:    new Date().toISOString(),
  };

  if (idx >= 0) state.dailyLog[idx] = entry;
  else state.dailyLog.push(entry);

  // 直近30日分のみ保持
  if (state.dailyLog.length > 30) state.dailyLog = state.dailyLog.slice(-30);
  _save(state);
  return entry;
}

// getLatestDailySnapshot() — 最新の日次スナップショットを取得
function getLatestDailySnapshot() {
  const state = _load();
  if (!state.dailyLog.length) return null;
  return state.dailyLog[state.dailyLog.length - 1];
}

// ─────────────────────────────────────────────────────
// formatWorkflowStatus() — !workflow status 表示 (Phase8)
// ─────────────────────────────────────────────────────
function formatWorkflowStatus() {
  const state    = _load();
  const waiting  = detectWaiting();
  const total    = state.handoffs.length;
  const resolved = state.handoffs.filter(h => h.resolvedAt).length;
  const pending  = total - resolved;

  const lines = [
    `📊 **Workflow 状態** (黒川 進行管理)`,
    ``,
    `ハンドオフ総数: ${total}件 / 解決済み: ${resolved}件 / 未解決: ${pending}件`,
    ``,
  ];

  if (waiting.length > 0) {
    lines.push(`⚠️ **長待ち検出 (${waiting.length}件)**`);
    for (const h of waiting) {
      const WORKER_JP = { miyagi:'宮城', moriya:'守谷', shiraishi:'白石', aizawa:'相沢',
                          ichikawa:'市川', kanemori:'金森', kurokawa:'黒川', ikuno:'育野', ceo:'CEO' };
      const toLabel = WORKER_JP[h.to] || h.to;
      lines.push(`  ⏳ \`${h.id}\` → ${toLabel} / ${h.event} / ${h.ageLabel}待ち`);
      if (h.taskId) lines.push(`     タスク: \`${h.taskId}\``);
    }
    lines.push('');
  } else {
    lines.push('✅ 長待ちなし');
    lines.push('');
  }

  // 最新日次スナップショット
  const snap = getLatestDailySnapshot();
  if (snap) {
    lines.push(`📅 **本日のスナップショット (${snap.date})**`);
    lines.push(`  完了: ${snap.completed.length}件`);
    lines.push(`  未完了: ${snap.incomplete.length}件`);
    lines.push(`  停止: ${snap.blocked.length}件`);
    if (snap.memo) lines.push(`  メモ: ${snap.memo}`);
    lines.push('');
  }

  lines.push('*黒川 CoS は配送・管理のみ。判断は CEO / 各担当者が行います。*');
  return { ok: true, text: lines.join('\n').trimEnd() };
}

module.exports = {
  recordHandoff,
  resolveHandoff,
  detectWaiting,
  saveDailySnapshot,
  getLatestDailySnapshot,
  formatWorkflowStatus,
  STATE_FILE,
  DEFAULT_WAIT_THRESHOLD_MS,
  _load,
  _save,
};
