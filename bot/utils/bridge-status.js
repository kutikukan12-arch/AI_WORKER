'use strict';
// =====================================================
// bridge-status.js — !bridge status 表示生成
//
// 目的:
//   CEO の手動中継ポイントを4分類で一覧表示する。
//   task-manager / workflow-state / workflow-audit /
//   desktop-operator-state / worker-status を直接読み取る。
//   新規状態管理は持たない。
//
// 4分類（順序固定・AI判断による並べ替えなし）:
//   ① CEO判断待ち  — 人間確認待ちタスク / CEO_CONFIRM_REQUIRED
//   ② 停止中       — 保留タスク / operator blocked
//   ③ 進行中       — 作業中タスク / working workers
//   ④ 完了         — 直近24h の完了タスク / audit成功
//
// 安全設計:
//   ✅ 読み取り専用 — 状態変更なし
//   ✅ 出典表示     — 各項目に !コマンド 出典を付与
//   ✅ redact 適用  — 全表示テキストに適用
//   ✅ 表示順固定   — 重みスコアによる並べ替えなし（固定バケツ順）
//   ❌ 判断代理なし  — READY / NEED_FIX 生成禁止
//   ❌ 自動承認なし
//   ❌ タスク作成なし
//   ❌ 優先順位判断なし
//   ❌ 新規状態ファイルなし
// =====================================================

const { redact } = require('./redact');

// 24時間
const RECENT_DONE_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────
// _collectCeoPending() — ① CEO判断待ち
//
// 出典: task-manager (人間確認待ち), workflow-audit (CEO_CONFIRM_REQUIRED),
//       workflow-state (ceo 宛ての未解決 handoff)
// ─────────────────────────────────────────────────────
function _collectCeoPending() {
  const items = [];

  // 人間確認待ちタスク
  try {
    const tm = require('./task-manager');
    tm.listTasks('人間確認待ち').forEach(t => {
      items.push({
        label: `[${t.id}] ${redact(t.title || '').slice(0, 60)}`,
        src:   '!task list',
        type:  'task_awaiting',
      });
    });
  } catch { /* ignore */ }

  // workflow-audit: CEO_CONFIRM_REQUIRED / safe:false
  try {
    const audit = require('./workflow-audit');
    const recent = audit.getRecentAudit(50);
    for (const entry of recent) {
      if (entry.stopReason && entry.stopReason.includes('ceo') ||
          entry.safe === false && entry.action === 'ceo_required') {
        const from = entry.from || '?';
        const to   = entry.to   || '?';
        const ev   = entry.event || '?';
        items.push({
          label: `CEO_CONFIRM_REQUIRED: ${from} → ${to} [${ev}]`,
          src:   '!workflow status',
          type:  'ceo_confirm',
        });
      }
    }
  } catch { /* ignore */ }

  // workflow-state: ceo 宛ての未解決 handoff
  try {
    const wstate = require('./workflow-state');
    const state  = wstate._load();
    (state.handoffs || [])
      .filter(h => h.to === 'ceo' && !h.resolvedAt)
      .forEach(h => {
        items.push({
          label: `handoff待ち: ${h.from || '?'} → CEO [${h.event}] ${_ageLabel(h.createdAt)}`,
          src:   '!workflow status',
          type:  'handoff_ceo',
        });
      });
  } catch { /* ignore */ }

  return items;
}

// ─────────────────────────────────────────────────────
// _collectStopped() — ② 停止中
//
// 出典: task-manager (保留), desktop-operator/history.json (blocked),
//       workflow-audit (safe:false / BLOCKED)
// ─────────────────────────────────────────────────────
function _collectStopped() {
  const items = [];

  // 保留タスク
  try {
    const tm = require('./task-manager');
    tm.listTasks('保留').forEach(t => {
      items.push({
        label: `[${t.id}] ${redact(t.title || '').slice(0, 60)}`,
        src:   '!task list',
        type:  'task_on_hold',
      });
    });
  } catch { /* ignore */ }

  // operator history: blockedReason あり (直近10件)
  try {
    const opState = require('./desktop-operator-state');
    const hist = opState.loadHistory();
    const recentBlocked = hist.filter(h => h.blockedReason).slice(-10);
    for (const h of recentBlocked) {
      const reason = redact(h.blockedReason || '').slice(0, 80);
      items.push({
        label: `operator停止 [${h.worker}]: ${reason}`,
        src:   '!operator reliability',
        type:  'operator_blocked',
      });
    }
  } catch { /* ignore */ }

  // workflow-audit: safe:false (BLOCKED 等)
  try {
    const audit = require('./workflow-audit');
    const recent = audit.getRecentAudit(20);
    for (const entry of recent) {
      if (entry.safe === false && entry.stopAction === 'block') {
        const from = entry.from || '?';
        const ev   = entry.event || '?';
        items.push({
          label: `workflow停止: ${from} [${ev}] — ${redact(entry.stopReason || '').slice(0, 60)}`,
          src:   '!workflow status',
          type:  'workflow_blocked',
        });
      }
    }
  } catch { /* ignore */ }

  return items;
}

// ─────────────────────────────────────────────────────
// _collectInProgress() — ③ 進行中
//
// 出典: task-manager (作業中), worker-status (working)
// ─────────────────────────────────────────────────────
function _collectInProgress() {
  const items = [];

  // 作業中タスク (最大10件)
  try {
    const tm = require('./task-manager');
    tm.listTasks('作業中').slice(0, 10).forEach(t => {
      items.push({
        label: `[${t.id}] ${redact(t.title || '').slice(0, 60)}`,
        src:   '!task list',
        type:  'task_in_progress',
      });
    });
  } catch { /* ignore */ }

  // working 状態の worker
  try {
    const wsm  = require('./worker-status');
    const data = wsm._load();
    for (const w of wsm.VALID_WORKERS) {
      const ws = data[w];
      if (ws && ws.status === 'working') {
        const disp = wsm.WORKER_DISPLAY[w] || w;
        const task = ws.taskId ? ` [${ws.taskId}]` : '';
        items.push({
          label: `${disp}: 作業中${task}`,
          src:   '!worker status',
          type:  'worker_working',
        });
      }
    }
  } catch { /* ignore */ }

  return items;
}

// ─────────────────────────────────────────────────────
// _collectRecentDone() — ④ 完了 (直近24h)
//
// 出典: task-manager (完了), workflow-audit (safe:true, 直近)
// ─────────────────────────────────────────────────────
function _collectRecentDone() {
  const items  = [];
  const cutoff = Date.now() - RECENT_DONE_MS;

  // 直近24h の完了タスク (最大10件)
  try {
    const tm = require('./task-manager');
    tm.listTasks('完了')
      .filter(t => t.updatedAt && new Date(t.updatedAt).getTime() >= cutoff)
      .slice(0, 10)
      .forEach(t => {
        items.push({
          label: `[${t.id}] ${redact(t.title || '').slice(0, 60)}`,
          src:   '!task list',
          type:  'task_done',
        });
      });
  } catch { /* ignore */ }

  // workflow-audit: safe:true の直近配送 (最大5件)
  try {
    const audit = require('./workflow-audit');
    audit.getRecentAudit(20)
      .filter(e => e.safe === true && e.at && new Date(e.at).getTime() >= cutoff)
      .slice(0, 5)
      .forEach(e => {
        const from = e.from || '?';
        const to   = e.to   || '?';
        const ev   = e.event || '?';
        items.push({
          label: `handoff完了: ${from} → ${to} [${ev}]`,
          src:   '!workflow status',
          type:  'audit_done',
        });
      });
  } catch { /* ignore */ }

  return items;
}

// ─────────────────────────────────────────────────────
// _ageLabel(isoString) — 経過時間ラベル
// ─────────────────────────────────────────────────────
function _ageLabel(isoString) {
  if (!isoString) return '';
  const ms  = Date.now() - new Date(isoString).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60)  return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr  < 24)  return `${hr}時間前`;
  return `${Math.floor(hr / 24)}日前`;
}

// ─────────────────────────────────────────────────────
// _renderSection(emoji, title, items, emptyMsg) — セクション整形
// ─────────────────────────────────────────────────────
function _renderSection(emoji, title, items, emptyMsg) {
  const lines = [`${emoji} **${title}** (${items.length}件)`];
  if (!items.length) {
    lines.push(`  ${emptyMsg}`);
  } else {
    for (const item of items) {
      // 出典を付与
      const srcNote = item.src ? `  ← \`${item.src}\`` : '';
      lines.push(`  ${item.label}${srcNote}`);
    }
  }
  return lines;
}

// ─────────────────────────────────────────────────────
// getBridgeStatus() — !bridge status のメイン関数
//
// 戻り値: { ok: true, text: string, summary: {...} }
// ─────────────────────────────────────────────────────
function getBridgeStatus() {
  const now      = new Date().toLocaleString('ja-JP');
  const ceo      = _collectCeoPending();
  const stopped  = _collectStopped();
  const inProg   = _collectInProgress();
  const done     = _collectRecentDone();

  const lines = [
    `🌉 **Bridge Status** — CEO中継ポイント一覧`,
    `確認時刻: ${now}`,
    ``,
  ];

  lines.push(..._renderSection('🟠①', 'CEO判断待ち', ceo, '現在なし'));
  lines.push('');
  lines.push(..._renderSection('⏸️②', '停止中', stopped, '現在なし'));
  lines.push('');
  lines.push(..._renderSection('🔵③', '進行中', inProg, '現在なし'));
  lines.push('');
  lines.push(..._renderSection('✅④', '完了 (直近24h)', done, '直近24hの完了なし'));
  lines.push('');
  lines.push(`> ⚠️ 読み取り専用。変更・承認は社長が行います。`);
  lines.push(`> 詳細: \`!msg pending\` / \`!task list\` / \`!workflow status\` / \`!operator reliability\``);

  const text = lines.join('\n');

  return {
    ok:   true,
    text: text.slice(0, 1950),
    summary: {
      ceoPending: ceo.length,
      stopped:    stopped.length,
      inProgress: inProg.length,
      recentDone: done.length,
    },
  };
}

module.exports = {
  getBridgeStatus,
  // テスト用 (内部コレクター公開)
  _collectCeoPending,
  _collectStopped,
  _collectInProgress,
  _collectRecentDone,
  _ageLabel,
};
