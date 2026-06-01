'use strict';
// =====================================================
// task-state-watcher.js — タスク状態監視ユーティリティ
//
// 目的:
//   Auto Runner / Project Runner が固定sleepなしで
//   task.state の変化に即応できるようにする。
//
//   executeClaudeTask() のサブプロセスが完了するより前に
//   task.state が更新された場合（DONE/AWAITING 等）を
//   ポーリングで検出し、後処理をバックグラウンドに任せて
//   次タスクへ即時移行できる。
//
// 状態遷移マッピング:
//   task が取得できない（アーカイブ済み）→ 'done'
//   REVIEWING                           → 'reviewing'
//   AWAITING（人間確認待ち）             → 'awaiting'
//   ON_HOLD（失敗/保留）                 → 'on_hold'
//   その他非 IN_PROGRESS                → 'unknown'
//   maxWaitMs 超過                       → 'timeout'
//   checkStopFn() が true を返した       → 'stopped'
// =====================================================

/**
 * タスクの状態が IN_PROGRESS から変化するまでポーリングする。
 *
 * @param {string}   taskId
 * @param {object}   taskManager   — task-manager モジュール
 * @param {object}   opts
 * @param {number}   opts.maxWaitMs       — 最大待機時間（デフォルト: 310000）
 * @param {number}   opts.pollIntervalMs  — ポーリング間隔（デフォルト: 1500）
 * @param {Function} opts.checkStopFn     — true を返すと即 'stopped' で終了
 * @returns {Promise<{ outcome: string, task: object|null }>}
 */
async function waitForStateChange(taskId, taskManager, opts = {}) {
  const {
    maxWaitMs      = 310_000,  // TASK_TIMEOUT_SECONDS(300s) + 10s バッファ
    pollIntervalMs = 1_500,
    checkStopFn    = () => false,
  } = opts;

  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    // 停止要求チェック（ctx.stopRequested など）
    if (checkStopFn()) {
      return { outcome: 'stopped', task: taskManager.getTask(taskId) };
    }

    const task = taskManager.getTask(taskId);

    // タスクが取得できない = DONE でアーカイブ済み
    if (!task) {
      return { outcome: 'done', task: null };
    }

    // IN_PROGRESS 以外に変化した → 即返却
    if (task.state !== taskManager.STATES.IN_PROGRESS) {
      const outcomeMap = {
        [taskManager.STATES.DONE]:      'done',
        [taskManager.STATES.REVIEWING]: 'reviewing',
        [taskManager.STATES.AWAITING]:  'awaiting',
        [taskManager.STATES.ON_HOLD]:   'on_hold',
        [taskManager.STATES.PENDING]:   'pending',
      };
      const outcome = outcomeMap[task.state] || 'unknown';
      return { outcome, task };
    }

    // まだ IN_PROGRESS → ポーリング間隔待機
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // タイムアウト
  return { outcome: 'timeout', task: taskManager.getTask(taskId) };
}

module.exports = { waitForStateChange };
