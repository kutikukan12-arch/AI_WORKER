'use strict';
// =====================================================
// workflow-budget.js — Conversation Budget (Phase1)
//
// 目的:
//   workflow 単位でのターン数を管理し、
//   無限ループ・同一2者間循環を検知する。
//
// ルール:
//   - conversationId ごとに maxTurns を設定
//   - 上限到達 → 神崎 VP へエスカレーション（CEO 判断待ち）
//   - 同一 2 者間ループ検知 → 即停止
//   - eval / exec / task / decision 自動作成なし
//
// 黒川の役割維持:
//   ✅ ターン数管理
//   ✅ ループ検知
//   ✅ エスカレーション通知
//   ❌ 判断代理なし
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const BUDGET_FILE  = path.join(DATA_DIR, 'workflow-budget.json');

// デフォルト設定
const DEFAULT_MAX_TURNS       = 6;   // 1ワークフロー最大6ターン
const LOOP_DETECT_WINDOW      = 4;   // 直近4ターンで循環検知
const SAME_PAIR_MAX           = 3;   // 同一2者間の最大往復数

// CEO 判断が必要なイベント（自動停止）
const CEO_REQUIRED_EVENTS = new Set([
  'BLOCKED', 'HUMAN_APPROVAL_REQUIRED', 'COST_REQUIRED',
]);

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(BUDGET_FILE)) return {};
    return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  } catch { return {}; }
}

function _save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = BUDGET_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, BUDGET_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

// ─────────────────────────────────────────────────────
// openConversation(convId, opts) — 会話を開始
// ─────────────────────────────────────────────────────
function openConversation(convId, opts = {}) {
  const data = _load();
  if (data[convId]) return { ok: false, reason: 'already_open', conv: data[convId] };
  data[convId] = {
    id:           convId,
    taskId:       opts.taskId || null,
    openedAt:     new Date().toISOString(),
    maxTurns:     opts.maxTurns !== undefined ? opts.maxTurns : DEFAULT_MAX_TURNS,
    currentTurns: 0,
    history:      [],  // [{ from, to, event, at }]
    status:       'open',
  };
  _save(data);
  return { ok: true, conv: data[convId] };
}

// ─────────────────────────────────────────────────────
// recordTurn(convId, from, to, event) — ターンを記録
//
// 戻り値:
//   { allowed: true }  — 続行可
//   { allowed: false, reason, action } — 停止
//     action: 'escalate_vp' | 'ceo_required' | 'loop_detected'
// ─────────────────────────────────────────────────────
function recordTurn(convId, from, to, event) {
  const data = _load();
  if (!data[convId]) {
    // 会話が存在しない場合は自動オープン
    openConversation(convId);
    return recordTurn(convId, from, to, event);
  }
  const conv = data[convId];

  // CEO 判断必要イベントは即停止
  if (CEO_REQUIRED_EVENTS.has(event)) {
    conv.status = 'ceo_required';
    _save(data);
    return {
      allowed: false,
      reason:  `CEO判断が必要なイベント: ${event}`,
      action:  'ceo_required',
      conv,
    };
  }

  // ターン上限チェック
  if (conv.currentTurns >= conv.maxTurns) {
    conv.status = 'limit_reached';
    _save(data);
    return {
      allowed: false,
      reason:  `ターン上限 (${conv.maxTurns}) に達しました`,
      action:  'escalate_vp',
      conv,
    };
  }

  // 同一2者間ループ検知
  const loopResult = _detectLoop(conv.history, from, to);
  if (loopResult.detected) {
    conv.status = 'loop_detected';
    _save(data);
    return {
      allowed: false,
      reason:  `ループ検知: ${from}↔${to} が ${loopResult.count}回繰り返されています`,
      action:  'loop_detected',
      conv,
    };
  }

  // 記録・カウントアップ
  conv.history.push({ from, to, event, at: new Date().toISOString() });
  conv.currentTurns++;
  _save(data);
  return { allowed: true, conv };
}

// ─────────────────────────────────────────────────────
// _detectLoop(history, from, to) — 循環検知
// ─────────────────────────────────────────────────────
function _detectLoop(history, from, to) {
  if (history.length < LOOP_DETECT_WINDOW) return { detected: false };

  // 直近 N ターンで同一ペアが SAME_PAIR_MAX 回以上か
  const recent = history.slice(-LOOP_DETECT_WINDOW);
  const pairKey = [from, to].sort().join(':');
  const count = recent.filter(h => {
    return [h.from, h.to].sort().join(':') === pairKey;
  }).length;

  if (count >= SAME_PAIR_MAX) {
    return { detected: true, count, pairKey };
  }
  return { detected: false };
}

// ─────────────────────────────────────────────────────
// closeConversation(convId, reason?) — 会話を閉じる
// ─────────────────────────────────────────────────────
function closeConversation(convId, reason = 'completed') {
  const data = _load();
  if (!data[convId]) return { ok: false };
  data[convId].status    = 'closed';
  data[convId].closedAt  = new Date().toISOString();
  data[convId].closeReason = reason;
  _save(data);
  // close 直後に 7日超の closed を削除（肥大化防止）
  pruneOldConversations(7);
  return { ok: true };
}

// ─────────────────────────────────────────────────────
// getConversation(convId) — 会話状態を取得
// ─────────────────────────────────────────────────────
function getConversation(convId) {
  return _load()[convId] || null;
}

// ─────────────────────────────────────────────────────
// buildEscalationMessage(conv) — 神崎 VP エスカレーション通知
// ─────────────────────────────────────────────────────
function buildEscalationMessage(conv) {
  const route = conv.history
    .slice(-4)
    .map(h => `${h.from}→${h.to}(${h.event})`)
    .join(' | ');

  return [
    `【Workflow エスカレーション通知】`,
    ``,
    `会話ID: ${conv.id}`,
    `理由: ${conv.status}`,
    `ターン数: ${conv.currentTurns} / ${conv.maxTurns}`,
    `直近の経路: ${route}`,
    ``,
    `→ 神崎 VP: 状況を整理して社長に判断材料を提出してください。`,
    `→ 黒川は判断せず、CEOの指示を待ちます。`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// pruneOldConversations(maxAgeDays?) — 古い closed 会話を削除
// Budget ファイルの肥大化防止
// closeConversation() 内から自動呼び出しされる。
// 対象: status==='closed' かつ closedAt が maxAgeDays 超えのもの
// open / その他ステータスの会話は削除しない。
// ─────────────────────────────────────────────────────
function pruneOldConversations(maxAgeDays = 7) {
  const data      = _load();
  const threshold = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let   pruned    = 0;
  for (const [id, conv] of Object.entries(data)) {
    // closed かつ closedAt が閾値より古いもののみ削除
    if (conv.status === 'closed') {
      const closedTime = new Date(conv.closedAt || 0).getTime();
      if (closedTime < threshold) {
        delete data[id];
        pruned++;
      }
    }
    // open / limit_reached / loop_detected 等は削除しない
  }
  if (pruned > 0) _save(data);
  return pruned;
}

module.exports = {
  openConversation,
  recordTurn,
  closeConversation,
  getConversation,
  buildEscalationMessage,
  pruneOldConversations,
  DEFAULT_MAX_TURNS,
  SAME_PAIR_MAX,
  LOOP_DETECT_WINDOW,
  CEO_REQUIRED_EVENTS,
  BUDGET_FILE,
  _load,
  _save,
  _detectLoop,
};
