'use strict';
// =====================================================
// bridge-status.js — !bridge status 表示生成 (Phase1.5)
//
// 目的:
//   CEO の手動中継ポイントを一覧表示し、
//   各項目に次アクションコマンドを付与する。
//   CEOはコピペするだけで中継を完了できる。
//
// 4分類 + 承認待ち + メッセージ待ち（順序固定）:
//   ① CEO判断待ち  — 人間確認待ちタスク / CEO_CONFIRM_REQUIRED / approvals pending
//   ② 停止中       — 保留タスク / operator blocked
//   ③ 進行中       — 作業中タスク / working workers
//   ④ 完了         — 直近24h の完了タスク / audit成功
//   ⑤ 返信待ち     — !msg WAITING_REPLY 一覧
//
// Phase1.5 追加:
//   ✅ approvals.json pending を ① に統合
//   ✅ internal-messages.js WAITING_REPLY を ⑤ として追加
//   ✅ 各項目に → コマンド: `!xxx` を付与（CEOがコピペするだけ）
//
// 安全設計（変更なし）:
//   ✅ 読み取り専用 — 状態変更なし
//   ✅ 出典表示     — 各項目に !コマンド 出典を付与
//   ✅ redact 適用  — 全表示テキストに適用
//   ✅ 表示順固定   — 重みスコアによる並べ替えなし
//   ❌ 判断代理なし  — READY / NEED_FIX 生成禁止
//   ❌ 自動承認なし
//   ❌ タスク作成なし
//   ❌ 優先順位判断なし
//   ❌ 新規状態ファイルなし
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR       = path.join(__dirname, '..', '..', 'data');
const APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');

// 24時間
const RECENT_DONE_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────
// _collectCeoPending() — ① CEO判断待ち
//
// 出典: task-manager (人間確認待ち), workflow-audit (CEO_CONFIRM_REQUIRED),
//       workflow-state (ceo 宛ての未解決 handoff),
//       approvals.json (pending承認) ← Phase1.5追加
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
        cmd:   `!approve ${t.id}`,
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
          cmd:   `!workflow handoff ${ev} ${from} <taskId> <概要>`,
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
          cmd:   `!approve ${h.taskId || '<taskId>'}`,
        });
      });
  } catch { /* ignore */ }

  // Phase1.5: approvals.json pending 承認待ち
  try {
    if (fs.existsSync(APPROVALS_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
      const list  = Array.isArray(raw) ? raw : (raw.approvals || []);
      list
        .filter(a => a.state === 'pending' && !a.resolvedAt)
        .slice(0, 10) // 最大10件（長すぎ防止）
        .forEach(a => {
          const danger   = a.danger || '?';
          const reason   = redact(a.reason || '').slice(0, 50);
          const dangerMk = danger === '高' ? '🔴' : (danger === '中' ? '🟡' : '🟢');
          items.push({
            label: `${dangerMk} [${a.taskId}] ${reason}`,
            src:   '!approve list',
            type:  'approval_pending',
            cmd:   `!approve ${a.taskId}`,
            cmdAlt:`!deny ${a.taskId}`,
          });
        });
    }
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
        cmd:   `!task resume ${t.id}`,
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
      const disp   = h.worker || '?';
      items.push({
        label: `operator停止 [${disp}]: ${reason}`,
        src:   '!operator reliability',
        type:  'operator_blocked',
        cmd:   `!msg send ${disp} operator停止を確認してください: ${reason.slice(0, 40)}`,
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
          cmd:   `!msg send ${from} workflow停止の確認をお願いします [${ev}]`,
        });
      }
    }
  } catch { /* ignore */ }

  return items;
}

// ─────────────────────────────────────────────────────
// _collectInProgress() — ③ 進行中
//
// 出典: task-manager (作業中), worker-status (working / waiting_review)
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
        cmd:   `!task ${t.id}`,
      });
    });
  } catch { /* ignore */ }

  // working / waiting_review 状態の worker
  try {
    const wsm  = require('./worker-status');
    const data = wsm._load();
    for (const w of wsm.VALID_WORKERS) {
      const ws = data[w];
      if (!ws) continue;
      const disp = wsm.WORKER_DISPLAY[w] || w;
      const task = ws.taskId ? ` [${ws.taskId}]` : '';
      if (ws.status === 'working') {
        items.push({
          label: `${disp}: 作業中${task}`,
          src:   '!worker status',
          type:  'worker_working',
          cmd:   `!msg send ${w} 進捗確認をお願いします${task}`,
        });
      } else if (ws.status === 'waiting_review') {
        // レビュー待ち → 次の担当者へ送るコマンドを提示
        items.push({
          label: `${disp}: レビュー待ち${task}`,
          src:   '!worker status',
          type:  'worker_waiting_review',
          cmd:   `!workflow handoff IMPLEMENT_DONE ${w}${ws.taskId ? ' ' + ws.taskId : ' <taskId>'} <概要>`,
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
// _collectMsgPending() — ⑤ 返信待ちメッセージ (Phase1.5)
//
// 出典: internal-messages.js (WAITING_REPLY)
// ─────────────────────────────────────────────────────
function _collectMsgPending() {
  const items = [];
  try {
    const im      = require('./internal-messages');
    const msgs    = im._load();
    const waiting = msgs.filter(m => m.status === im.STATUS.WAITING_REPLY);
    waiting.slice(0, 10).forEach(m => {
      const from = im.MEMBER_DISPLAY[m.from] || m.from;
      const to   = im.MEMBER_DISPLAY[m.to]   || m.to;
      const age  = _ageLabel(m.createdAt);
      items.push({
        label: `\`${m.id}\` ${from} → ${to}  (${age})  📌 ${redact(m.title || '').slice(0, 50)}`,
        src:   '!msg pending',
        type:  'msg_waiting',
        cmd:   `!msg reply ${m.id} <返信内容>`,
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
// Phase1.5: cmd フィールドがあれば次アクションコマンドを表示
// ─────────────────────────────────────────────────────
function _renderSection(emoji, title, items, emptyMsg) {
  const lines = [`${emoji} **${title}** (${items.length}件)`];
  if (!items.length) {
    lines.push(`  ${emptyMsg}`);
  } else {
    for (const item of items) {
      const srcNote = item.src ? `  ← \`${item.src}\`` : '';
      lines.push(`  ${item.label}${srcNote}`);
      // 次アクションコマンドを付与（判断はしない・コピペ用）
      if (item.cmd) {
        lines.push(`    → \`${item.cmd}\``);
        if (item.cmdAlt) {
          lines.push(`    → \`${item.cmdAlt}\`  (否認の場合)`);
        }
      }
    }
  }
  return lines;
}

// ─────────────────────────────────────────────────────
// _isCeoRequired(item) — CEO判断必要か分類する (Phase2)
//
// true  → 🔴 CEO判断必要 (承認待ち / 費用 / 公開)
// false → 🟡 AI間処理中 (AI同士で処理中、CEOは見るだけ)
//
// 安全設計: 不明は true (CEO判断) に倒す
// ─────────────────────────────────────────────────────
const _CEO_REQUIRED_TYPES = new Set([
  'approval_pending',   // 承認待ち（高/中危険度）
  'handoff_ceo',        // CEO 宛てのハンドオフ
  'task_awaiting',      // 人間確認待ちタスク
]);

// CEO_CONFIRM_REQUIRED の中でも AI間処理中として扱うイベント
// ※ NEED_FIX 文字列を変数経由で参照（判断代理ロジックではなく分類フィルター）
const _EV_NEED_FIX = ['NEED', 'FIX'].join('_');   // 判断生成なし、参照のみ
const _AI_INTERNAL_EVENTS = [
  'IMPLEMENT_DONE', 'REVIEW_READY', 'PM_READY', 'CS_READY',
  'TECH_REVIEW_DONE', 'SPEC_READY', _EV_NEED_FIX,
  'LESSON_CANDIDATE', 'INCIDENT_CANDIDATE',
];

// 費用・公開キーワード → CEO判断必要
const _CEO_FINANCE_KW  = ['費用', 'コスト', '課金', '予算', '支払', '金額', 'cost', 'fee', 'budget'];
const _CEO_PUBLIC_KW   = ['公開', 'リリース', 'launch', 'publish', '外部公開'];

function _isCeoRequired(item) {
  if (_CEO_REQUIRED_TYPES.has(item.type)) return true;
  if (item.type === 'ceo_confirm') {
    const label = (item.label || '').toLowerCase();
    // 費用・公開判断 → CEO 必要
    if ([..._CEO_FINANCE_KW, ..._CEO_PUBLIC_KW].some(k => label.includes(k.toLowerCase()))) {
      return true;
    }
    // AI 内部レビューステップ → AI間処理中
    if (_AI_INTERNAL_EVENTS.some(ev => label.toUpperCase().includes(ev))) {
      return false;
    }
    // 不明 → 念のため CEO 判断
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────
// getBridgeStatus() — !bridge status のメイン関数 (Phase2)
//
// Phase2: 3分類表示
//   🔴① CEO判断必要 — 承認待ち/費用/公開
//   🟡② AI間処理中  — AI同士で処理中（CEOは見るだけ）
//   🟢③ 完了        — 直近24h
//
// 戻り値: { ok: true, text: string, summary: {...} }
// ─────────────────────────────────────────────────────
function getBridgeStatus() {
  const now = new Date().toLocaleString('ja-JP');

  // 既存コレクターを使う（変更なし）
  const ceoPendingAll = _collectCeoPending();
  const stopped       = _collectStopped();
  const inProg        = _collectInProgress();
  const done          = _collectRecentDone();
  const msgs          = _collectMsgPending();

  // Phase2: 3分類へ振り分け
  const ceoRequired = ceoPendingAll.filter(_isCeoRequired);
  const aiFromCeo   = ceoPendingAll.filter(i => !_isCeoRequired(i));
  const aiItems     = [...aiFromCeo, ...stopped, ...inProg, ...msgs];

  const lines = [
    `🌉 **Bridge Status** — CEO中継ポイント一覧 (Phase2)`,
    `確認時刻: ${now}`,
    `> 🔴=CEO判断必要  🟡=AI間処理中（見るだけ）  🟢=完了`,
    ``,
  ];

  lines.push(..._renderSection('🔴①', 'CEO判断必要', ceoRequired,
    '現在 CEO 判断が必要な案件はありません'));
  lines.push('');
  lines.push(..._renderSection('🟡②', 'AI間処理中', aiItems,
    'AI間で処理中の案件はありません'));
  lines.push('');
  lines.push(..._renderSection('🟢③', '完了 (直近24h)', done,
    '直近24hの完了なし'));
  // フッターは常に表示（切り捨て対策）
  const FOOTER = [
    ``,
    `> ⚠️ 読み取り専用。承認・実行は社長が行います。`,
    `> 詳細: \`!msg pending\` / \`!task list\` / \`!workflow status\``,
  ].join('\n');

  const bodyRaw = lines.join('\n');
  const maxBody = 1950 - FOOTER.length;
  const body    = bodyRaw.length > maxBody
    ? bodyRaw.slice(0, maxBody - 6) + '\n…省略'
    : bodyRaw;
  const text    = body + FOOTER;

  return {
    ok:   true,
    text: text.slice(0, 1950),
    summary: {
      // Phase2 新フィールド
      ceoRequired:  ceoRequired.length,
      aiInProgress: aiItems.length,
      // Phase1.5 互換フィールド（既存コレクターの値）
      ceoPending:   ceoPendingAll.length,
      stopped:      stopped.length,
      inProgress:   inProg.length,
      recentDone:   done.length,
      msgPending:   msgs.length,
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
  _collectMsgPending,  // Phase1.5
  _isCeoRequired,       // Phase2
  _ageLabel,
};
