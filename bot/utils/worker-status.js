'use strict';
// =====================================================
// worker-status.js — Worker Status Manager (Phase6)
//
// 各 AI社員の作業状態を管理する。
//
// ステータス:
//   idle          — 待機中
//   assigned      — タスクアサイン済み
//   working       — 作業中
//   waiting_review — レビュー待ち
//   blocked       — ブロック中
//   completed     — 完了（当日分）
//
// コマンド: !worker status
// データ: data/worker-status.json (gitignore)
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', '..', 'data');
const STATUS_FILE = path.join(DATA_DIR, 'worker-status.json');

const WORKER_STATUS = {
  IDLE:           'idle',
  ASSIGNED:       'assigned',
  WORKING:        'working',
  WAITING_REVIEW: 'waiting_review',
  BLOCKED:        'blocked',
  COMPLETED:      'completed',
};

const STATUS_EMOJI = {
  idle:           '💤',
  assigned:       '📋',
  working:        '🔨',
  waiting_review: '🔍',
  blocked:        '🚫',
  completed:      '✅',
};

const WORKER_DISPLAY = {
  miyagi:    '🅰️ 宮城 Lead Engineer',
  moriya:    '🅱️ 守谷 CTO',
  shiraishi: '🅲 白石 COO',
  aizawa:    '🅳 相沢 CS',
  ichikawa:  '🅴 市川 PM',
  kanemori:  '🅵 金森 CFO',
  kurokawa:  '🅶 黒川 CoS',
  ikuno:     '🅷 育野',
  kanzaki:   '🅸 神崎 VP',
};

const VALID_WORKERS = Object.keys(WORKER_DISPLAY);

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch { return {}; }
}

function _save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATUS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, STATUS_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// updateStatus(worker, status, opts) — ステータス更新
//
// opts: { taskId?, reason?, note? }
// ─────────────────────────────────────────────────────
function updateStatus(worker, status, opts = {}) {
  if (!VALID_WORKERS.includes(worker)) {
    return { ok: false, error: `不明な社員: ${worker}` };
  }
  if (!Object.values(WORKER_STATUS).includes(status)) {
    return { ok: false, error: `不明なステータス: ${status}` };
  }

  const data = _load();
  const now  = new Date().toISOString();

  data[worker] = {
    status,
    taskId:    opts.taskId  || data[worker]?.taskId  || null,
    reason:    opts.reason  || null,
    note:      opts.note    || null,
    updatedAt: now,
    history: [
      ...(data[worker]?.history || []).slice(-9), // 直近10件
      { status, at: now, note: opts.note || '' },
    ],
  };

  _save(data);
  return { ok: true, worker, status };
}

// ─────────────────────────────────────────────────────
// getStatus(worker?) — ステータス取得
// ─────────────────────────────────────────────────────
function getStatus(worker) {
  const data = _load();
  if (worker) return data[worker] || { status: WORKER_STATUS.IDLE, taskId: null };
  return data;
}

// ─────────────────────────────────────────────────────
// formatStatusReport() — Discord 用ステータス一覧
// ─────────────────────────────────────────────────────
function formatStatusReport() {
  const data = _load();
  const lines = ['📊 **AI社員 ステータス**', ''];

  for (const worker of VALID_WORKERS) {
    const display = WORKER_DISPLAY[worker];
    const ws      = data[worker] || { status: WORKER_STATUS.IDLE };
    const emoji   = STATUS_EMOJI[ws.status] || '❓';
    const statusJp = {
      idle:           '待機中',
      assigned:       'アサイン済み',
      working:        '作業中',
      waiting_review: 'レビュー待ち',
      blocked:        'ブロック中',
      completed:      '完了（本日）',
    }[ws.status] || ws.status;

    lines.push(`${display}`);
    lines.push(`  状態: ${emoji} ${statusJp}`);
    if (ws.taskId) lines.push(`  担当: \`${ws.taskId}\``);
    if (ws.note)   lines.push(`  備考: ${ws.note}`);
    lines.push('');
  }

  // BLOCKED 警告
  const blocked = VALID_WORKERS.filter(w => data[w]?.status === WORKER_STATUS.BLOCKED);
  if (blocked.length > 0) {
    lines.push(`⚠️ **ブロック検出**: ${blocked.map(w => WORKER_DISPLAY[w] || w).join(', ')}`);
    lines.push('→ CEO への報告が必要です。');
  }

  return { ok: true, text: lines.join('\n').trimEnd() };
}

module.exports = {
  updateStatus,
  getStatus,
  formatStatusReport,
  WORKER_STATUS,
  STATUS_EMOJI,
  WORKER_DISPLAY,
  VALID_WORKERS,
  STATUS_FILE,
  _load,
  _save,
};
