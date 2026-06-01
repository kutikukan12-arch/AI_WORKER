'use strict';
// =====================================================
// ai-board-report.js — AI Board Report 生成ユーティリティ
//
// project_done 時または !project board コマンドで
// 「本当に完成か / 次に何が必要か」をまとめた総評を生成する。
//
// 判定は完全ルールベース（LLM呼び出しなし）。
// 安全側（NEEDS_REFINEMENT 寄り）に設計。
//
// 状態候補:
//   RELEASE_READY      — 本当に完了に近い（厳格）
//   NEEDS_REFINEMENT   — 登録タスク完了だが不足機能確認が必要
//   NEEDS_REVIEW       — 実装完了だが評価が必要
//   BLOCKED            — エラー/承認待ち/失敗で止まっている
// =====================================================

const path = require('path');
const fs   = require('fs');

// 状態定数
const BOARD_STATUS = {
  RELEASE_READY:    'RELEASE_READY',
  NEEDS_REFINEMENT: 'NEEDS_REFINEMENT',
  NEEDS_REVIEW:     'NEEDS_REVIEW',
  BLOCKED:          'BLOCKED',
};

const STATUS_EMOJI = {
  RELEASE_READY:    '✅',
  NEEDS_REFINEMENT: '🚧',
  NEEDS_REVIEW:     '🧪',
  BLOCKED:          '⚠️',
};

const STATUS_LABEL = {
  RELEASE_READY:    'RELEASE READY',
  NEEDS_REFINEMENT: 'NEEDS REFINEMENT',
  NEEDS_REVIEW:     'NEEDS REVIEW',
  BLOCKED:          'BLOCKED',
};

// ─────────────────────────────────────────────────────
// 状態判定ロジック
//
// 入力:
//   runStats   — { tasksDone, tasksFailed, stopReason, yellowCount }
//   quality    — { level: 'GREEN'|'YELLOW'|'RED', score, redTriggers }
//   taskSummary — { pending, onHold, reviewing, awaiting }
//   projectId  — string
//
// 戻り値: BOARD_STATUS のいずれか
// ─────────────────────────────────────────────────────
// 状態判定の優先順位（タスク消化と商品完成を分離）:
//   1. IN_PROGRESS あり        → DEVELOPMENT_RUNNING（実行中）
//   2. HUMAN_CHECK / BLOCKED  → BLOCKED
//   3. REVIEW待ち / YELLOW    → NEEDS_REVIEW
//   4. PENDING / ON_HOLD あり → NEEDS_REFINEMENT
//   5. 商品完成はここでは判定しない（外部検証で決まる）
const BOARD_STATUS_DEVELOPMENT_RUNNING = 'DEVELOPMENT_RUNNING';

function determineStatus(runStats, quality, taskSummary) {
  const { tasksFailed = 0, stopReason = '' } = runStats;
  const { level = 'GREEN', redTriggers = [] } = quality;
  const { pending = 0, onHold = 0, reviewing = 0, awaiting = 0,
          inProgress = 0 } = taskSummary;

  // ── 優先1: 作業中タスクあり（タスク消化中・商品完成とは別）
  if (inProgress > 0) {
    return BOARD_STATUS.NEEDS_REFINEMENT; // 作業継続中 = まだ完成ではない
  }

  // ── 優先2: BLOCKED 判定 ─────────────────────────────
  // 失敗あり / Quality RED / 承認待ち / 連続エラー停止
  if (
    tasksFailed > 0 ||
    level === 'RED' ||
    awaiting > 0 ||
    /blocked|human_approval|timeout_limit|consecutive_error|denied|awaiting/.test(stopReason)
  ) {
    return BOARD_STATUS.BLOCKED;
  }

  // ── 優先3: NEEDS_REVIEW（実装完了だが評価が必要）─────
  // YELLOW / レビュー待ちあり
  if (level === 'YELLOW' || reviewing > 0) {
    return BOARD_STATUS.NEEDS_REVIEW;
  }

  // ── 優先4: NEEDS_REFINEMENT（登録タスク終了だが不足あり）
  // project_done 直後・残タスクあり・最初はほぼここ
  if (
    stopReason === 'project_done' ||
    pending > 0 ||
    onHold > 0 ||
    /no_pending_tasks|waiting_for_in_progress/.test(stopReason)
  ) {
    return BOARD_STATUS.NEEDS_REFINEMENT;
  }

  // ── 優先5: RELEASE_READY（非常に厳格）─────────────────
  // 全て0 + GREEN + project_done + tasksFailed=0 でのみ
  // ※ 商品完成は外部検証（Product Audit）が必要
  return BOARD_STATUS.NEEDS_REFINEMENT; // 安全側
}

// ─────────────────────────────────────────────────────
// タスクサマリーを収集
// ─────────────────────────────────────────────────────
function gatherTaskSummary(projectId, taskManager, projectManager) {
  try {
    const allTasks    = taskManager.listTasks();
    const projTasks   = projectManager.filterTasksByProject(allTasks, projectId);
    return {
      total:     projTasks.length,
      pending:   projTasks.filter(t => t.state === taskManager.STATES.PENDING).length,
      onHold:    projTasks.filter(t => t.state === taskManager.STATES.ON_HOLD).length,
      reviewing: projTasks.filter(t => t.state === taskManager.STATES.REVIEWING).length,
      awaiting:  projTasks.filter(t => t.state === taskManager.STATES.AWAITING).length,
      inProgress: projTasks.filter(t => t.state === taskManager.STATES.IN_PROGRESS).length,
    };
  } catch {
    return { total: 0, pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 0 };
  }
}

// ─────────────────────────────────────────────────────
// 次にやるべきことを生成（ルールベース）
// ─────────────────────────────────────────────────────
function buildNextSteps(status, runStats, taskSummary, projectId) {
  const steps = [];
  const { tasksFailed, stopReason } = runStats;
  const { pending, onHold, reviewing, awaiting } = taskSummary;

  switch (status) {
    case BOARD_STATUS.BLOCKED:
      if (awaiting > 0)
        steps.push(`\`!approve\` / \`!deny\` — ${awaiting}件の承認待ちを解決`);
      if (tasksFailed > 0)
        steps.push(`\`!task list\` — 失敗タスク(${tasksFailed}件)を確認`);
      if (/timeout_limit/.test(stopReason))
        steps.push(`\`!task show <id>\` — タイムアウト 2回タスクの内容を分割・修正`);
      steps.push(`\`!quality status ${projectId}\` — 品質状態を確認`);
      steps.push(`\`!project run ${projectId}\` — 問題解決後に再実行`);
      break;

    case BOARD_STATUS.NEEDS_REVIEW:
      if (reviewing > 0)
        steps.push(`\`!review list\` — ${reviewing}件のレビュー待ちを確認`);
      steps.push(`\`!quality status ${projectId}\` — YELLOW 要因を確認・解消`);
      steps.push(`\`!project run ${projectId}\` — 解消後に再実行`);
      break;

    case BOARD_STATUS.NEEDS_REFINEMENT:
      steps.push(`\`!project refine ${projectId}\` — 不足機能を分析・タスク案を生成`);
      if (pending > 0 || onHold > 0)
        steps.push(`\`!task list\` — 残タスク(pending:${pending} on_hold:${onHold})を確認`);
      steps.push(`\`!project run ${projectId}\` — 新しいタスク登録後に再実行`);
      break;

    case BOARD_STATUS.RELEASE_READY:
      steps.push('外部レビュー・テスト・ドキュメント作成を実施してください');
      steps.push(`\`!project refine ${projectId}\` — 最終確認として不足機能を再チェック`);
      break;
  }

  return steps;
}

// ─────────────────────────────────────────────────────
// 非エンジニア向け AI 総評を生成（ルールベース）
// ─────────────────────────────────────────────────────
function buildSummaryText(status, runStats, quality, taskSummary, projectId) {
  const { tasksDone, tasksFailed, stopReason } = runStats;
  const { level, score } = quality;

  switch (status) {
    case BOARD_STATUS.BLOCKED:
      if (runStats.tasksFailed > 0)
        return `${tasksDone}件のタスクを完了しましたが、${tasksFailed}件が失敗しました。` +
               `エラーの原因を確認し、修正後に再実行してください。`;
      if (taskSummary.awaiting > 0)
        return `AIが判断できない処理で止まっています。承認または却下の判断をしてください。`;
      return `エラーや問題で処理が止まっています。詳細を確認してから再実行してください。`;

    case BOARD_STATUS.NEEDS_REVIEW:
      return `実装は${tasksDone}件完了しましたが、コード品質スコアが${score}/100 (${level}) です。` +
             `品質の問題を解消してから次のステップに進むことをお勧めします。`;

    case BOARD_STATUS.NEEDS_REFINEMENT:
      return `登録されていたタスク ${tasksDone}件 が完了しました。` +
             `ただしこれは「登録したタスクが終わった」だけであり、プロジェクトの完成を意味しません。` +
             `「!project refine」で不足機能の分析を実施してください。`;

    case BOARD_STATUS.RELEASE_READY:
      return `登録タスク${tasksDone}件が完了し、品質スコアも${score}/100 (${level}) です。` +
             `外部レビュー・テスト・ドキュメント作成など最終確認を実施してください。`;

    default:
      return `タスク実行が完了しました（完了:${tasksDone}件）。次のステップを確認してください。`;
  }
}

// ─────────────────────────────────────────────────────
// メイン: Board Report オブジェクトを生成
//
// 引数:
//   projectId      — string
//   runStats       — { tasksDone, tasksFailed, stopReason, yellowCount }
//   quality        — assessQuality() の戻り値
//   taskManager    — task-manager モジュール
//   projectManager — project-manager モジュール
//
// 戻り値:
//   { projectId, status, statusEmoji, statusLabel, runStats, quality, taskSummary, summaryText, nextSteps, generatedAt }
// ─────────────────────────────────────────────────────
function generateBoardReport(projectId, runStats, quality, taskManager, projectManager) {
  const taskSummary = gatherTaskSummary(projectId, taskManager, projectManager);
  const status      = determineStatus(runStats, quality, taskSummary);
  const summaryText = buildSummaryText(status, runStats, quality, taskSummary, projectId);
  const nextSteps   = buildNextSteps(status, runStats, taskSummary, projectId);

  return {
    projectId,
    status,
    statusEmoji: STATUS_EMOJI[status],
    statusLabel: STATUS_LABEL[status],
    runStats: { ...runStats },
    quality:  { level: quality.level, score: quality.score, redTriggers: quality.redTriggers || [] },
    taskSummary,
    summaryText,
    nextSteps,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────
// Discord 向けテキストにフォーマット
// ─────────────────────────────────────────────────────
function formatBoardReport(report) {
  const { projectId, status, statusEmoji, statusLabel, runStats, quality, taskSummary, summaryText, nextSteps } = report;
  const { tasksDone, tasksFailed, stopReason, yellowCount = 0 } = runStats;
  const qualIcon = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[quality.level] || '❓';
  const qScore   = quality.score !== null ? ` (${quality.score}/100)` : '';

  const taskLine =
    `✅ 完了: ${tasksDone}件 | ❌ 失敗: ${tasksFailed}件` +
    (yellowCount > 0 ? ` | 🟡 YELLOW警告: ${yellowCount}回` : '');

  const remainLine = [
    taskSummary.pending > 0    ? `未着手: ${taskSummary.pending}件` : '',
    taskSummary.onHold > 0     ? `保留: ${taskSummary.onHold}件` : '',
    taskSummary.reviewing > 0  ? `レビュー待ち: ${taskSummary.reviewing}件` : '',
    taskSummary.awaiting > 0   ? `人間確認待ち: ${taskSummary.awaiting}件` : '',
  ].filter(Boolean).join(' | ') || '（なし）';

  const nextStepsText = nextSteps.length > 0
    ? nextSteps.map(s => `  → ${s}`).join('\n')
    : '  → 現時点で推奨アクションはありません';

  const redNote = quality.redTriggers.length > 0
    ? '\n  RED要因: ' + quality.redTriggers.join(', ')
    : '';

  const qualityNote =
    '\n> ⚠️ **Quality GREEN はコード品質の指標であり、製品の完成を意味しません。**';

  return (
    `📊 **AI Board Report** — Project: \`${projectId}\`\n\n` +
    `**状態: ${statusEmoji} ${statusLabel}**\n\n` +
    `**今回の Runner 結果:**\n${taskLine}\n` +
    `停止理由: ${stopReason || '（完了）'}\n` +
    `${qualIcon} Quality: **${quality.level}**${qScore}${redNote}\n\n` +
    `**残タスク:**\n${remainLine}\n\n` +
    `**📝 AI 総評:**\n${summaryText}\n\n` +
    `**次にやるべきこと:**\n${nextStepsText}` +
    qualityNote
  );
}

module.exports = {
  BOARD_STATUS,
  STATUS_EMOJI,
  STATUS_LABEL,
  generateBoardReport,
  formatBoardReport,
  // テスト用内部関数
  _determineStatus:    determineStatus,
  _gatherTaskSummary:  gatherTaskSummary,
  _buildNextSteps:     buildNextSteps,
  _buildSummaryText:   buildSummaryText,
};
