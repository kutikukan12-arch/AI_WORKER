'use strict';

// =====================================================
// project-planner.js — Auto Project Runner: Planner
//
// 役割:
//   プロジェクトの現状を分析し「次に何をすべきか」を決定する。
//   runPlannerStep() から呼ばれ、生成すべきタスクを返す。
//
// Phase B-3 (現状): 骨格のみ。常に action:'none' を返す。
// Phase B-4 以降:   FIX / REVIEW / IMPLEMENT 等を自動生成。
//
// 戻り値 (planNextTask):
//   {
//     action:        'none' | 'create_task' | 'project_done',
//     reason:        string,          // 判断理由
//     suggestedTask: object | null,   // 生成すべきタスク情報
//     summary:       string,          // Discord 通知用の短文
//   }
// =====================================================

const logger = require('./logger');

// ─────────────────────────────────────────────────────
// planNextTask(projectId, context)
//
// プロジェクトの現状を受け取り、次に生成すべきタスクを返す。
//
// 引数:
//   projectId - プロジェクトID
//   context   - { tasks, completedTaskIds, latestReview } 等（将来拡張用）
//
// 戻り値:
//   { action, reason, suggestedTask, summary }
//
// Phase B-3 では常に action:'none' を返す（副作用なし）。
// Phase B-4 以降で FIX / REVIEW / IMPLEMENT を判断するロジックを追加する。
// ─────────────────────────────────────────────────────
function planNextTask(projectId, context = {}) {
  logger.debug(`[Planner] planNextTask called: ${projectId}`);

  // Phase B-3: 骨格のみ。常に 'none' を返す。
  // Phase B-4 でここに判断ロジックを追加する:
  //   - Codex高/中危険度レビュー → FIX タスク生成
  //   - IMPLEMENT完了後 → REVIEW タスク生成
  //   - 全タスク完了 → 'project_done'

  return {
    action:        'none',
    reason:        'Planner は骨格実装中です (Phase B-3)',
    suggestedTask: null,
    summary:       '📋 Planner: まだ自動タスク生成はしません (Phase B-4 以降)',
  };
}

module.exports = {
  planNextTask,
};
