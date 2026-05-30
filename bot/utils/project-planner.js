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

  // ── Phase B-4: Codex レビュー結果からの FIX タスク候補生成 ──
  // context.reviewResult がある場合、危険度を判定して FIX タスクを提案する。
  // ※ tasks.json への書き込みはまだしない（副作用なし）。
  const reviewResult = context.reviewResult || null;

  if (reviewResult) {
    const danger  = reviewResult.danger || '';
    const isHigh  = danger.includes('高');
    const isMid   = danger.includes('中');

    if (isHigh || isMid) {
      const priority    = isHigh ? '高' : '中';
      const dangerEmoji = isHigh ? '🔴' : '🟡';
      const problem     = (reviewResult.problem || 'Codex指摘事項あり').slice(0, 120);
      const suggestion  = (reviewResult.suggestion || '').slice(0, 120);

      const fixPrompt = [
        `[Codex指摘対応] ${problem}`,
        suggestion ? `\n改善案: ${suggestion}` : '',
        `\n最小限の修正のみ行うこと。関係ない変更は禁止。`,
      ].join('');

      logger.info(`[Planner] FIX タスク候補を生成: ${projectId} | 危険度 ${danger}`);

      return {
        action: 'create_task',
        reason: `Codexレビューで危険度 ${dangerEmoji} ${danger.trim()} を検出`,
        suggestedTask: {
          type:     'FIX',
          priority,
          title:    `Codex指摘対応 (危険度: ${danger.trim()})`,
          prompt:   fixPrompt,
          sourceReviewDanger: danger.trim(),
        },
        summary:
          `🔧 **Planner: FIX タスク候補**\n` +
          `危険度: ${dangerEmoji} ${danger.trim()}\n` +
          `問題: ${problem.slice(0, 60)}${problem.length > 60 ? '...' : ''}\n` +
          `(Phase B-5 以降で自動登録されます)`,
      };
    }
  }

  // Codexレビューがない / 低危険度 / その他 → まだ何もしない
  return {
    action:        'none',
    reason:        reviewResult
      ? `Codexレビューの危険度が低いため自動生成不要 (danger: ${reviewResult.danger || 'なし'})`
      : 'レビュー結果がないため判断不可',
    suggestedTask: null,
    summary:       '📋 Planner: 自動生成条件を満たしません',
  };
}

module.exports = {
  planNextTask,
};
