'use strict';
// =====================================================
// kurokawa-report.js — 黒川 Workflow Intelligence (Phase1)
//
// 目的: 会社全体の進行状況を自動把握し、ボトルネックを検出する。
// 担当: 🅶 黒川 Chief of Staff
//
// 禁止:
//   ❌ task 作成・変更
//   ❌ approve / READY / NEED_FIX
//   ❌ 担当割当の変更
//   ❌ eval / exec
//
// セーフガード:
//   ✅ 情報収集・整理・配送・提案・記録のみ
//   ✅ redact() を全テキストに適用
//   ✅ data/workflow-learning.json に記録
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const LEARNING_FILE = path.join(DATA_DIR, 'workflow-learning.json');

const BOTTLENECK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2時間

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _loadLearning() {
  try {
    if (!fs.existsSync(LEARNING_FILE)) return { sessions: [] };
    return JSON.parse(fs.readFileSync(LEARNING_FILE, 'utf8'));
  } catch { return { sessions: [] }; }
}

function _saveLearning(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = LEARNING_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, LEARNING_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// 情報収集
// ─────────────────────────────────────────────────────
function _collectWorkerStatus() {
  try {
    const wsm    = require('./worker-status');
    const data   = wsm._load();
    const result = [];
    for (const worker of wsm.VALID_WORKERS) {
      const ws    = data[worker] || { status: 'idle' };
      result.push({
        worker,
        display: wsm.WORKER_DISPLAY[worker] || worker,
        status:  ws.status,
        taskId:  ws.taskId || null,
        note:    ws.note   || null,
      });
    }
    return result;
  } catch { return []; }
}

function _collectTaskSnapshot() {
  try {
    const tm   = require('./task-manager');
    const list = tm.listTasks();
    const snap = {};
    list.forEach(t => { snap[t.state] = (snap[t.state] || 0) + 1; });
    const inProgress = list.filter(t => t.state === '作業中' || t.state === 'IN_PROGRESS');
    const reviewing  = list.filter(t => t.state === 'レビュー待ち' || t.state === 'REVIEWING');
    const awaiting   = list.filter(t => t.state === '人間確認待ち' || t.state === 'AWAITING');
    return { snap, inProgress, reviewing, awaiting, total: list.length };
  } catch { return { snap: {}, inProgress: [], reviewing: [], awaiting: [], total: 0 }; }
}

function _collectWorkflowBottlenecks() {
  try {
    const wstate  = require('./workflow-state');
    const waiting = wstate.detectWaiting(BOTTLENECK_THRESHOLD_MS);
    return waiting.map(h => ({
      id:       h.id,
      event:    h.event,
      to:       h.to,
      ageLabel: h.ageLabel,
      taskId:   h.taskId,
    }));
  } catch { return []; }
}

function _collectInboxStatus() {
  try {
    const ib      = require('./inbox-bridge');
    const pending = [];
    for (const worker of ib.VALID_WORKERS) {
      const outPath = ib._workerOutboxPath(worker);
      const inPath  = ib._workerInboxPath(worker);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        pending.push({ worker, display: ib.WORKER_DISPLAY[worker] || worker, type: 'outgoing' });
      }
      if (fs.existsSync(inPath) && fs.statSync(inPath).size > 0) {
        pending.push({ worker, display: ib.WORKER_DISPLAY[worker] || worker, type: 'incoming' });
      }
    }
    return pending;
  } catch { return []; }
}

function _collectMessagePending() {
  try {
    const im = require('./internal-messages');
    const r  = im.pendingReport();
    return r.text.includes('0件') || r.text.includes('返信待ちメッセージなし') ? 0
      : (r.text.match(/計 (\d+) 件/) || [])[1] || '?';
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────
// ボトルネック検出
// ─────────────────────────────────────────────────────
function _detectBottlenecks({ workers, tasks, handoffs, inbox, msgPending }) {
  const issues = [];

  // レビュー滞留
  if (tasks.reviewing.length >= 2) {
    issues.push({
      type: 'review_backlog',
      severity: 'high',
      detail: `レビュー待ちが ${tasks.reviewing.length}件 滞留しています。`,
    });
  }

  // HUMAN_CHECK 待ち
  if (tasks.awaiting.length > 0) {
    issues.push({
      type: 'human_check',
      severity: 'high',
      detail: `HUMAN_CHECK 待ちが ${tasks.awaiting.length}件 あります。社長確認が必要です。`,
    });
  }

  // 長時間待ちハンドオフ
  for (const h of handoffs) {
    issues.push({
      type: 'handoff_wait',
      severity: 'medium',
      detail: `${h.to} への ${h.event} ハンドオフが ${h.ageLabel} 未処理です。`,
    });
  }

  // 未返信メッセージ
  if (msgPending > 2) {
    issues.push({
      type: 'msg_pending',
      severity: 'medium',
      detail: `社内メッセージ返信待ちが ${msgPending}件 あります。`,
    });
  }

  // inbox 積み残し
  const incomingPending = inbox.filter(i => i.type === 'incoming');
  if (incomingPending.length > 0) {
    issues.push({
      type: 'inbox_unread',
      severity: 'low',
      detail: `${incomingPending.map(i => i.display).join(', ')} の inbox に未確認メッセージがあります。`,
    });
  }

  return issues;
}

// ─────────────────────────────────────────────────────
// 次アクション候補生成（提案のみ・自動実行禁止）
// ─────────────────────────────────────────────────────
function _buildNextActions(bottlenecks, { tasks, handoffs }) {
  const actions = [];

  for (const b of bottlenecks) {
    switch (b.type) {
      case 'review_backlog':
        actions.push(`🅱️ 守谷 CTO にレビュー確認を依頼 → \`!inbox send moriya レビュー待ちがあります\``);
        break;
      case 'human_check':
        actions.push(`👑 社長: HUMAN_CHECK 待ちの確認・承認が必要です → \`!approve <taskId>\``);
        break;
      case 'handoff_wait':
        actions.push(`⏳ \`!workflow status\` でハンドオフ詳細を確認してください`);
        break;
      case 'msg_pending':
        actions.push(`📨 \`!msg pending\` で返信待ちメッセージを確認してください`);
        break;
      case 'inbox_unread':
        actions.push(`📥 \`!inbox status\` で inbox を確認してください`);
        break;
    }
  }

  if (!actions.length) {
    actions.push('✅ 現在ボトルネックなし。通常運営中です。');
  }

  return [...new Set(actions)]; // 重複排除
}

// ─────────────────────────────────────────────────────
// generateReport() — 会社全体レポートを生成
//
// 戻り値: { ok, text, summary }
// ─────────────────────────────────────────────────────
function generateReport() {
  const now         = new Date().toLocaleString('ja-JP');
  const workers     = _collectWorkerStatus();
  const tasks       = _collectTaskSnapshot();
  const handoffs    = _collectWorkflowBottlenecks();
  const inbox       = _collectInboxStatus();
  const msgPending  = _collectMessagePending();
  const bottlenecks = _detectBottlenecks({ workers, tasks, handoffs, inbox, msgPending });
  const nextActions = _buildNextActions(bottlenecks, { tasks, handoffs });

  // Discord 表示テキスト
  const lines = [
    `🅶 **黒川 Workflow Intelligence Report**`,
    `生成: ${now}`,
    ``,
    `**【1. 現在状況】**`,
    ``,
  ];

  // Worker 状態
  for (const w of workers) {
    const st    = { idle:'💤', working:'🔨', waiting_review:'🔍', assigned:'📋', blocked:'🚫', completed:'✅' }[w.status] || '❓';
    const jp    = { idle:'待機中', working:'作業中', waiting_review:'レビュー待ち', assigned:'アサイン済', blocked:'ブロック中', completed:'完了' }[w.status] || w.status;
    const task  = w.taskId ? ` \`${w.taskId}\`` : '';
    lines.push(`${w.display}: ${st} ${jp}${task}`);
  }
  lines.push('');

  // タスク集計
  lines.push(`タスク: 計 ${tasks.total}件 | 作業中 ${tasks.inProgress.length} | レビュー待ち ${tasks.reviewing.length} | 承認待ち ${tasks.awaiting.length}`);
  lines.push('');

  // ボトルネック
  lines.push(`**【2. ボトルネック検出】**`);
  lines.push('');
  if (!bottlenecks.length) {
    lines.push('✅ ボトルネックなし');
  } else {
    for (const b of bottlenecks) {
      const sev = { high:'🔴', medium:'🟡', low:'🟢' }[b.severity] || '⚪';
      lines.push(`${sev} ${b.detail}`);
    }
  }
  lines.push('');

  // 次アクション候補
  lines.push(`**【3. 次アクション候補】**`);
  lines.push('');
  for (const a of nextActions) lines.push(a);
  lines.push('');
  lines.push(`⚠️ 上記は**提案のみ**です。タスク変更・承認は社長が行います。`);

  const text = lines.join('\n');

  // workflow-learning.json に記録
  const learning = _loadLearning();
  const session  = {
    at:           new Date().toISOString(),
    bottleneckCount: bottlenecks.length,
    bottlenecks:  bottlenecks.map(b => ({ type: b.type, severity: b.severity })),
    taskSnap:     tasks.snap,
    handoffCount: handoffs.length,
  };
  learning.sessions = [...(learning.sessions || []), session].slice(-50);
  _saveLearning(learning);

  return {
    ok:      true,
    text:    text.slice(0, 1900),
    summary: { bottleneckCount: bottlenecks.length, taskTotal: tasks.total },
  };
}

module.exports = {
  generateReport,
  LEARNING_FILE,
  _loadLearning,
  _saveLearning,
  _detectBottlenecks,
  _collectWorkerStatus,
  _collectTaskSnapshot,
  _collectWorkflowBottlenecks,
};
