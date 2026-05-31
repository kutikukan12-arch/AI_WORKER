'use strict';

// =====================================================
// worker-registry.js — Worker Role Registry (Phase E-5b)
//
// 役割:
//   複数Worker運用に向けたワーカー登録・管理の土台。
//   単一Botプロセス前提のインメモリ管理。
//
// 最小フィールド（Phase E-5b）:
//   workerId  - ワーカー識別子
//   role      - ROLE_TYPE_MAP のいずれか
//   status    - WORKER_STATUS のいずれか
//
// 未実装（次フェーズ）:
//   heartbeat / offline / maxConcurrent / projectId
// =====================================================

const logger      = require('./logger');
const taskManager = require('./task-manager');

// ─────────────────────────────────────────────────────
// ROLE_TYPE_MAP — ワーカーが担当できるロール
// ─────────────────────────────────────────────────────
const ROLE_TYPE_MAP = {
  EXECUTOR:   'EXECUTOR',   // IMPLEMENT / FIX / REFACTOR を実行
  REVIEWER:   'REVIEWER',   // REVIEW タスクを担当
  RESEARCHER: 'RESEARCHER', // RESEARCH タスクを担当
  GENERAL:    'GENERAL',    // 全タイプに対応（デフォルト）
};

// ─────────────────────────────────────────────────────
// WORKER_STATUS — ワーカーの稼働状態
// ─────────────────────────────────────────────────────
const WORKER_STATUS = {
  IDLE: 'IDLE', // 待機中（タスク受付可能）
  BUSY: 'BUSY', // 実行中（タスク保持中）
};

// ─────────────────────────────────────────────────────
// インメモリ Registry
// Map<workerId, { workerId, role, status }>
// ─────────────────────────────────────────────────────
const _registry = new Map();

// ─────────────────────────────────────────────────────
// addWorker(workerId, role)
//
// ワーカーを登録する。既存 workerId の場合は上書き。
// role が無効な場合は GENERAL にフォールバック。
//
// 戻り値: 登録されたワーカーオブジェクト
// ─────────────────────────────────────────────────────
function addWorker(workerId, role) {
  if (!workerId || typeof workerId !== 'string') {
    throw new Error('workerId は空でない文字列が必要です');
  }
  const safeRole = Object.values(ROLE_TYPE_MAP).includes(role)
    ? role
    : ROLE_TYPE_MAP.GENERAL;

  const worker = { workerId, role: safeRole, status: WORKER_STATUS.IDLE };
  _registry.set(workerId, worker);
  logger.info(`[WorkerRegistry] addWorker: ${workerId} role=${safeRole}`);
  return worker;
}

// ─────────────────────────────────────────────────────
// removeWorker(workerId)
//
// ワーカーを削除する。
// 戻り値: 削除成功なら true、未登録なら false
// ─────────────────────────────────────────────────────
function removeWorker(workerId) {
  if (!_registry.has(workerId)) return false;
  _registry.delete(workerId);
  logger.info(`[WorkerRegistry] removeWorker: ${workerId}`);
  return true;
}

// ─────────────────────────────────────────────────────
// listWorkers()
//
// 登録済みワーカーの一覧を返す。
// 戻り値: ワーカーオブジェクトの配列
// ─────────────────────────────────────────────────────
function listWorkers() {
  return [..._registry.values()];
}

// ─────────────────────────────────────────────────────
// claimForWorker(workerId, projectId)
//
// 指定ワーカーが projectId のタスクを claim する。
// 内部で taskManager.claimNextTask() を呼び、
// 成功した場合にワーカーの status を BUSY にする。
//
// 前提: ワーカーが登録済みであること
//
// 戻り値: { worker, task } | null（タスクなし or ワーカー未登録）
// ─────────────────────────────────────────────────────
function claimForWorker(workerId, projectId) {
  const worker = _registry.get(workerId);
  if (!worker) {
    logger.warn(`[WorkerRegistry] claimForWorker: 未登録ワーカー ${workerId}`);
    return null;
  }
  if (worker.status === WORKER_STATUS.BUSY) {
    logger.warn(`[WorkerRegistry] claimForWorker: ${workerId} は既に BUSY`);
    return null;
  }

  const task = taskManager.claimNextTask(projectId, workerId);
  if (!task) {
    logger.debug(`[WorkerRegistry] claimForWorker: ${workerId} → タスクなし (${projectId})`);
    return null;
  }

  worker.status = WORKER_STATUS.BUSY;
  logger.info(`[WorkerRegistry] claimForWorker: ${workerId} → task:${task.id} [${task.type}]`);
  return { worker: { ...worker }, task };
}

// ─────────────────────────────────────────────────────
// releaseWorker(workerId, taskId)
//
// ワーカーのタスク保持を解放する。
// 内部で taskManager.releaseLease() を呼び、
// ワーカーの status を IDLE に戻す。
//
// 戻り値: { worker, released } | null（ワーカー未登録）
// ─────────────────────────────────────────────────────
function releaseWorker(workerId, taskId) {
  const worker = _registry.get(workerId);
  if (!worker) {
    logger.warn(`[WorkerRegistry] releaseWorker: 未登録ワーカー ${workerId}`);
    return null;
  }

  const released = taskId ? taskManager.releaseLease(taskId) : null;
  worker.status = WORKER_STATUS.IDLE;
  logger.info(`[WorkerRegistry] releaseWorker: ${workerId} → IDLE (task:${taskId || 'none'})`);
  return { worker: { ...worker }, released };
}

module.exports = {
  ROLE_TYPE_MAP,
  WORKER_STATUS,
  addWorker,
  removeWorker,
  listWorkers,
  claimForWorker,
  releaseWorker,
};
