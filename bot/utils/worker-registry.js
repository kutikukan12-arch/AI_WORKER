'use strict';

// =====================================================
// worker-registry.js — Worker Role 管理 (Phase E-5b)
//
// 役割:
//   並列実行に参加する Worker（論理スロット）を永続管理する。
//   各 Worker は role に応じて特定の task.type だけを claim できる。
//
// Role → task.type 対応:
//   IMPLEMENTER  → IMPLEMENT / FIX / REFACTOR
//   REVIEWER     → REVIEW
//   TESTER       → TEST
//   RESEARCHER   → RESEARCH / DOCS
//
// フォールバック:
//   Worker が1件も登録されていない場合は現状どおり動作する。
//   該当 role の Worker が全員 busy のときも同様にフォールバック。
//
// 保存先:
//   data/workers.json
// =====================================================

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const WORKERS_FILE = path.join(DATA_DIR, 'workers.json');

// ─── Worker Role 定数 ───
const WORKER_ROLES = {
  IMPLEMENTER: 'IMPLEMENTER',
  REVIEWER:    'REVIEWER',
  TESTER:      'TESTER',
  RESEARCHER:  'RESEARCHER',
};

// ─── Role → claimable task.type マッピング ───
const ROLE_TYPE_MAP = {
  IMPLEMENTER: new Set(['IMPLEMENT', 'FIX', 'REFACTOR']),
  REVIEWER:    new Set(['REVIEW']),
  TESTER:      new Set(['TEST']),
  RESEARCHER:  new Set(['RESEARCH', 'DOCS']),
};

// ─── Role 絵文字（Discord 表示用）───
const ROLE_EMOJI = {
  IMPLEMENTER: '🔨',
  REVIEWER:    '👀',
  TESTER:      '🧪',
  RESEARCHER:  '🔍',
};

// ─── workerId 自動生成プレフィックス ───
const ROLE_ID_PREFIX = {
  IMPLEMENTER: 'impl',
  REVIEWER:    'rev',
  TESTER:      'test',
  RESEARCHER:  'res',
};

// ─── Worker status ───
const WORKER_STATUS = {
  IDLE:    'idle',
  BUSY:    'busy',
  OFFLINE: 'offline',
};

// 最大 Worker 数（環境変数で上書き可）
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '4', 10);

// ─────────────────────────────────────────────────────
// I/O ヘルパー
// ─────────────────────────────────────────────────────

function loadWorkers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORKERS_FILE)) return [];
  try {
    const raw = fs.readFileSync(WORKERS_FILE, 'utf8');
    return JSON.parse(raw).workers || [];
  } catch (e) {
    logger.error(`[WorkerRegistry] workers.json 読み込み失敗: ${e.message}`);
    return [];
  }
}

function saveWorkers(workers) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    WORKERS_FILE,
    JSON.stringify({ workers, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

// ─────────────────────────────────────────────────────
// generateWorkerId(role) — role に合わせた workerId を自動生成
//
// 既存の同 prefix worker の最大番号 + 1 を使う。
// 例: impl-1, impl-2, rev-1
// ─────────────────────────────────────────────────────
function generateWorkerId(role) {
  const prefix  = ROLE_ID_PREFIX[role] || role.toLowerCase().slice(0, 4);
  const workers = loadWorkers();
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const nums    = workers
    .map(w => { const m = w.workerId.match(pattern); return m ? parseInt(m[1], 10) : 0; })
    .filter(n => n > 0);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${next}`;
}

// ─────────────────────────────────────────────────────
// addWorker(role, workerId, projectId)
//
// Worker を登録する。
//
// 引数:
//   role      - IMPLEMENTER|REVIEWER|TESTER|RESEARCHER
//   workerId  - 任意文字列（省略 or null: 自動生成）
//   projectId - '*' = 全プロジェクト（省略時: '*'）
//
// 戻り値:
//   { ok: true, worker }
//   { ok: false, reason }
// ─────────────────────────────────────────────────────
function addWorker(role, workerId = null, projectId = '*') {
  const normalizedRole = String(role || '').toUpperCase();
  if (!WORKER_ROLES[normalizedRole]) {
    return {
      ok:     false,
      reason: `無効な role: **${role}**\n使用可能: ${Object.keys(WORKER_ROLES).join(' / ')}`,
    };
  }

  const workers = loadWorkers();

  if (workers.length >= MAX_WORKERS) {
    return {
      ok:     false,
      reason: `Worker 数が上限（${MAX_WORKERS}）に達しています。\n\`!worker rm <workerId>\` で解除してから登録してください。`,
    };
  }

  const id = workerId || generateWorkerId(normalizedRole);

  if (workers.find(w => w.workerId === id)) {
    return {
      ok:     false,
      reason: `\`${id}\` は既に登録されています。別の workerId を指定してください。`,
    };
  }

  const now    = new Date().toISOString();
  const worker = {
    workerId:      id,
    role:          normalizedRole,
    projectId:     projectId || '*',
    status:        WORKER_STATUS.IDLE,
    currentTaskId: null,
    registeredAt:  now,
    lastHeartbeat: now,
    maxConcurrent: 1,
  };

  workers.push(worker);
  saveWorkers(workers);
  logger.info(`[WorkerRegistry] 登録: ${id} [${normalizedRole}] project:${projectId}`);
  return { ok: true, worker };
}

// ─────────────────────────────────────────────────────
// removeWorker(workerId)
//
// 戻り値:
//   { ok: true, worker, wasBusy }
//   { ok: false, reason }
// ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────
// removeWorker(workerId, options?)
//
// デフォルトでは busy Worker の削除を拒否する（H1 修正）。
// `{ force: true }` を指定した場合のみ busy でも削除可。
//
// 戻り値:
//   { ok: true,  worker, wasBusy }
//   { ok: false, reason: 'BUSY',      worker }  — busy ガード（force なし）
//   { ok: false, reason: '...not found...' }      — 未登録
// ─────────────────────────────────────────────────────
function removeWorker(workerId, options = {}) {
  const { force = false } = options;
  const workers = loadWorkers();
  const idx     = workers.findIndex(w => w.workerId === workerId);
  if (idx === -1) {
    return { ok: false, reason: `\`${workerId}\` が見つかりません。` };
  }
  const worker  = workers[idx];
  // busy ガード: デフォルトでは busy Worker を削除しない
  if (!force && worker.status === WORKER_STATUS.BUSY) {
    logger.warn(`[WorkerRegistry] removeWorker: ${workerId} は BUSY のため削除不可（force:false）`);
    return { ok: false, reason: 'BUSY', worker };
  }
  workers.splice(idx, 1);
  saveWorkers(workers);
  const wasBusy = worker.status === WORKER_STATUS.BUSY;
  logger.info(`[WorkerRegistry] 削除: ${workerId} | wasBusy:${wasBusy} | force:${force}`);
  return { ok: true, worker, wasBusy };
}

// ─────────────────────────────────────────────────────
// getWorker(workerId)
// ─────────────────────────────────────────────────────
function getWorker(workerId) {
  return loadWorkers().find(w => w.workerId === workerId) || null;
}

// ─────────────────────────────────────────────────────
// listWorkers() — 全 Worker を返す
// ─────────────────────────────────────────────────────
function listWorkers() {
  return loadWorkers();
}

// ─────────────────────────────────────────────────────
// updateWorkerStatus(workerId, status, currentTaskId)
//
// workers.json の status と currentTaskId を更新する。
// ─────────────────────────────────────────────────────
function updateWorkerStatus(workerId, status, currentTaskId) {
  const workers = loadWorkers();
  const worker  = workers.find(w => w.workerId === workerId);
  if (!worker) return null;
  worker.status        = status;
  worker.currentTaskId = currentTaskId || null;
  worker.lastHeartbeat = new Date().toISOString();
  saveWorkers(workers);
  return worker;
}

// ─────────────────────────────────────────────────────
// claimForWorker(workerId) — Worker が次のタスクを claim する
//
// ROLE_TYPE_MAP に基づいて対象 task.type を絞り込み、
// task-manager.claimNextTaskByFilter() でアトミックに claim する。
//
// フォールバック:
//   ROLE_TYPE_MAP に該当タスクがなければ null を返す。
//   呼び出し元（index.js）が従来の claimNextTask にフォールバックする。
//
// 戻り値: claim されたタスクオブジェクト | null
// ─────────────────────────────────────────────────────
function claimForWorker(workerId) {
  const worker = getWorker(workerId);
  if (!worker) {
    logger.warn(`[WorkerRegistry] claimForWorker: 不明な workerId: ${workerId}`);
    return null;
  }
  if (worker.status === WORKER_STATUS.OFFLINE) {
    logger.warn(`[WorkerRegistry] claimForWorker: offline worker: ${workerId}`);
    return null;
  }
  if (worker.status === WORKER_STATUS.BUSY) {
    logger.warn(`[WorkerRegistry] claimForWorker: ${workerId} は既に BUSY`);
    return null;
  }

  // 遅延 require で循環参照を回避
  const taskManager = require('./task-manager');
  const roleTypes   = ROLE_TYPE_MAP[worker.role];
  const projectCheck = worker.projectId === '*'
    ? () => true
    : t => (t.projectId || 'default') === worker.projectId;

  const filterFn = t => roleTypes.has(t.type) && projectCheck(t);

  const task = taskManager.claimNextTaskByFilter(filterFn, workerId, worker.role);

  if (task) {
    updateWorkerStatus(workerId, WORKER_STATUS.BUSY, task.id);
    logger.info(`[WorkerRegistry] claimed: ${workerId} → task:${task.id} [${task.type}]`);
  }
  return task;
}

// ─────────────────────────────────────────────────────
// releaseWorker(workerId) — Worker の status を idle に戻す
//
// タスク完了・blocked・エラー時に必ず呼ぶ。
// lease 解放（releaseLease）は呼び出し元が別途行うこと。
// ─────────────────────────────────────────────────────
function releaseWorker(workerId) {
  updateWorkerStatus(workerId, WORKER_STATUS.IDLE, null);
  logger.info(`[WorkerRegistry] released: ${workerId}`);
}

// ─────────────────────────────────────────────────────
// formatWorkerList() — !worker list 用の Discord テキスト
// ─────────────────────────────────────────────────────
function formatWorkerList() {
  const workers = loadWorkers();
  if (workers.length === 0) {
    return [
      '**👥 Workers: 未登録**',
      '',
      '`!worker add <role>` で登録してください。',
      '',
      '```',
      '利用可能な role:',
      '  🔨 IMPLEMENTER → IMPLEMENT / FIX / REFACTOR',
      '  👀 REVIEWER    → REVIEW',
      '  🧪 TESTER      → TEST',
      '  🔍 RESEARCHER  → RESEARCH / DOCS',
      '```',
    ].join('\n');
  }

  const busyCount = workers.filter(w => w.status === WORKER_STATUS.BUSY).length;
  const lines = [
    `**👥 Workers (${busyCount}/${workers.length} active)**`,
    '────────────────────────────────────────',
  ];

  for (const w of workers) {
    const roleEmoji  = ROLE_EMOJI[w.role] || '🤖';
    const statusIcon = w.status === WORKER_STATUS.BUSY
      ? `🔵 \`${w.currentTaskId || '?'}\``
      : w.status === WORKER_STATUS.OFFLINE
        ? '⚫ offline'
        : '⬜ idle';
    const proj = w.projectId === '*' ? '*' : w.projectId;
    lines.push(`${roleEmoji} \`${w.workerId}\`  ${w.role.padEnd(12)}  ${statusIcon}  ${proj}`);
  }

  lines.push('');
  lines.push('`!worker add <role> [workerId] [project]` で追加 | `!worker rm <id>` で削除');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// formatWorkerStatus() — !parallel status 用ワンライナー
// ─────────────────────────────────────────────────────
function formatWorkerStatus() {
  const workers = loadWorkers();
  if (workers.length === 0) return '👥 Workers: 未登録';
  const parts = workers.map(w => {
    const emoji = ROLE_EMOJI[w.role] || '🤖';
    const state = w.status === WORKER_STATUS.BUSY
      ? `🔵${w.currentTaskId || '?'}`
      : '⬜idle';
    return `${emoji}${w.workerId}[${state}]`;
  });
  return `👥 Workers: ${parts.join(' ')}`;
}

module.exports = {
  WORKER_ROLES,
  ROLE_TYPE_MAP,
  ROLE_EMOJI,
  WORKER_STATUS,
  MAX_WORKERS,
  addWorker,
  removeWorker,
  getWorker,
  listWorkers,
  updateWorkerStatus,
  claimForWorker,
  releaseWorker,
  formatWorkerList,
  formatWorkerStatus,
};
