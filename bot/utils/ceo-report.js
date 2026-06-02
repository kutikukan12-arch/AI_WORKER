'use strict';
// =====================================================
// ceo-report.js — CEO Report 生成ユーティリティ
// 拡張ロール（UX/Finance/Sales/Support/Legal/Security/CostOptimizer）は
// ai-company-roles.js で管理し、Part4 として出力する。
//
// Project Runner 完了後、非エンジニア向けに
// 「今何が終わったか・次何が必要か・外部相談用コピー文」
// をまとめた経営目線レポートを生成する。
//
// ルールベース（LLM 不使用）。
// Board Report と連携し、同じ runStats / quality を受け取る。
//
// 現在判定:
//   RELEASE_READY        — リリース可能に近い
//   CONTINUE_DEVELOPMENT — 開発継続が必要
//   NEED_HUMAN_DECISION  — 人間の判断が必要
//   BLOCKED              — 問題で停止中
// =====================================================

const companyRoles = require('./ai-company-roles');

const EXEC_STATUS = {
  RELEASE_READY:       'RELEASE_READY',
  CONTINUE_DEVELOPMENT:'CONTINUE_DEVELOPMENT',
  NEED_HUMAN_DECISION: 'NEED_HUMAN_DECISION',
  BLOCKED:             'BLOCKED',
};

const EXEC_EMOJI = {
  RELEASE_READY:        '✅',
  CONTINUE_DEVELOPMENT: '🚧',
  NEED_HUMAN_DECISION:  '🤔',
  BLOCKED:              '🛑',
};

const EXEC_LABEL = {
  RELEASE_READY:        'RELEASE READY',
  CONTINUE_DEVELOPMENT: 'CONTINUE DEVELOPMENT',
  NEED_HUMAN_DECISION:  'NEED HUMAN DECISION',
  BLOCKED:              'BLOCKED',
};

// ─────────────────────────────────────────────────────
// Board Report の BOARD_STATUS → CEO EXEC_STATUS に変換
// ─────────────────────────────────────────────────────
function boardStatusToExecStatus(boardStatus, runStats, taskSummary) {
  const { tasksFailed = 0, stopReason = '' } = runStats;
  const { awaiting = 0, inProgress = 0 } = taskSummary;

  // IN_PROGRESS タスクあり → 開発実行中（商品完成とは別）
  if (inProgress > 0) {
    return EXEC_STATUS.CONTINUE_DEVELOPMENT;
  }

  // stopReason が "作業中タスク待ち" 系
  if (/waiting_for_in_progress|development_running/.test(stopReason)) {
    return EXEC_STATUS.CONTINUE_DEVELOPMENT;
  }

  switch (boardStatus) {
    case 'BLOCKED':
      // 承認待ちは人間判断、それ以外はBLOCKED
      return awaiting > 0 ? EXEC_STATUS.NEED_HUMAN_DECISION : EXEC_STATUS.BLOCKED;
    case 'NEEDS_REVIEW':
      return EXEC_STATUS.NEED_HUMAN_DECISION;
    case 'NEEDS_REFINEMENT':
      return EXEC_STATUS.CONTINUE_DEVELOPMENT;
    case 'RELEASE_READY':
      return EXEC_STATUS.RELEASE_READY;
    default:
      return EXEC_STATUS.CONTINUE_DEVELOPMENT;
  }
}

// ─────────────────────────────────────────────────────
// 完了タスクのサマリーを収集（最大5件）
// ─────────────────────────────────────────────────────
function collectRecentDoneTasks(projectId, taskManager, projectManager) {
  try {
    const all   = taskManager.listTasks();
    const proj  = projectManager.filterTasksByProject(all, projectId);

    // DONE のタスクはアーカイブ済みで listTasks に出ない場合がある
    // ON_HOLD（失敗由来）と最近完了したものは stateHistory から拾う
    const recent = proj
      .filter(t =>
        t.state === taskManager.STATES.ON_HOLD ||
        t.state === taskManager.STATES.DONE
      )
      .slice(-5)
      .map(t => `[${t.type || '?'}] ${(t.prompt || '').slice(0, 45)}`)
      .reverse();

    return recent;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────
// 各ロールのコメント生成（ルールベース）
// ─────────────────────────────────────────────────────
function buildRoleEvaluations(execStatus, runStats, quality, taskSummary, recentDone, projectId) {
  const { tasksDone, tasksFailed, stopReason } = runStats;
  const { level, score } = quality;
  const { pending, onHold, reviewing, awaiting } = taskSummary;

  // 🅰️ Developer — 何を作ったか
  let devComment;
  if (tasksDone > 0) {
    const doneList = recentDone.length > 0
      ? recentDone.slice(0, 3).map(d => `  ・${d}`).join('\n')
      : `  ・${tasksDone}件のタスクを実行しました`;
    devComment = `${tasksDone}件のタスクを完了しました。\n${doneList}`;
  } else {
    devComment = '今回の実行では完了タスクがありませんでした。';
  }
  if (tasksFailed > 0) devComment += `\n  ⚠️ ${tasksFailed}件が失敗しました。`;

  // 🅱️ QA — 品質問題
  const qualIcon = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[level] || '❓';
  let qaComment;
  if (level === 'GREEN') {
    qaComment = `${qualIcon} コード品質は良好です（スコア: ${score ?? '—'}/100）。\n  ただしこれはコードの品質であり、製品完成度ではありません。`;
  } else if (level === 'YELLOW') {
    qaComment = `${qualIcon} 品質に改善が必要な点があります（スコア: ${score ?? '—'}/100）。\n  !quality status で詳細を確認してください。`;
  } else {
    qaComment = `${qualIcon} 品質に問題が検出されています（RED）。\n  !quality status で原因を確認し、解消してから進んでください。`;
  }

  // 🅲 PM — 目的達成度
  let pmComment;
  if (execStatus === EXEC_STATUS.RELEASE_READY) {
    pmComment = '登録タスクが完了し、品質も問題ありません。外部評価・最終テストの段階です。';
  } else if (execStatus === EXEC_STATUS.BLOCKED) {
    pmComment = `エラーや問題で処理が止まっています。原因を解消してから再開が必要です。`;
  } else if (execStatus === EXEC_STATUS.NEED_HUMAN_DECISION) {
    pmComment = `AIが判断できない処理があります（${awaiting > 0 ? '承認待ち' : '品質・レビュー確認'}）。人間の判断をお願いします。`;
  } else {
    const remain = pending + onHold;
    pmComment = `登録タスクは一段落しましたが、まだ不足機能がある可能性があります。\n  残タスク: ${remain}件。!project refine で次の計画を立ててください。`;
  }

  // 🅴 Product — ユーザー目線評価
  let productComment;
  if (execStatus === EXEC_STATUS.BLOCKED) {
    productComment = 'システムが問題で止まっており、ユーザーに提供できる状態ではありません。';
  } else if (execStatus === EXEC_STATUS.RELEASE_READY) {
    productComment = '機能的には動く状態に近づいています。ユーザーテストと説明書の準備が必要です。';
  } else if (tasksDone === 0) {
    productComment = 'まだユーザーに使ってもらえる機能が揃っていません。開発を続けてください。';
  } else {
    productComment = `${tasksDone}件の機能が追加・改善されました。まだ全ての機能が揃っていない可能性があります。\n  !project refine で不足機能を確認してください。`;
  }

  // 🅷 Learning — 今回得た学び
  const learnings = [];
  if (tasksFailed > 0)
    learnings.push(`失敗タスク${tasksFailed}件がある → 内容を確認し、次回は分割や指示の改善を検討`);
  if (level === 'YELLOW' || level === 'RED')
    learnings.push(`品質${level} → コードレビュー内容を確認して改善パターンを記録`);
  if (/timeout/.test(stopReason))
    learnings.push(`タイムアウト発生 → タスクが大きすぎた可能性。次回はより細かく分割`);
  if (learnings.length === 0)
    learnings.push(`今回はスムーズに完了。このタスク構成・指示スタイルを継続`);

  return {
    developer: devComment,
    qa:        qaComment,
    pm:        pmComment,
    product:   productComment,
    learning:  learnings.join('\n  ・'),
  };
}

// ─────────────────────────────────────────────────────
// 次の推奨アクション
// ─────────────────────────────────────────────────────
function buildNextActions(execStatus, runStats, taskSummary, projectId) {
  const { tasksFailed, stopReason } = runStats;
  const { pending, onHold, reviewing, awaiting } = taskSummary;
  const actions = [];

  switch (execStatus) {
    case EXEC_STATUS.BLOCKED:
      if (awaiting > 0)  actions.push(`① 承認待ちを解決: \`!approve\` または \`!deny <taskId>\``);
      if (tasksFailed > 0) actions.push(`② 失敗タスクを確認: \`!task list\``);
      actions.push(`③ 品質確認: \`!quality status ${projectId}\``);
      actions.push(`④ 修正後に再実行: \`!project run ${projectId}\``);
      break;
    case EXEC_STATUS.NEED_HUMAN_DECISION:
      if (awaiting > 0)  actions.push(`① 承認または却下: \`!approve\` / \`!deny\``);
      if (reviewing > 0) actions.push(`② レビュー確認: \`!review list\``);
      actions.push(`③ 品質確認: \`!quality status ${projectId}\``);
      break;
    case EXEC_STATUS.RELEASE_READY:
      actions.push(`① 外部テスト・ユーザーレビューを実施`);
      actions.push(`② ドキュメント・README の最終確認`);
      actions.push(`③ 念のため不足確認: \`!project refine ${projectId}\``);
      break;
    case EXEC_STATUS.CONTINUE_DEVELOPMENT:
    default:
      actions.push(`① 不足機能を分析: \`!project refine ${projectId}\``);
      if (pending + onHold > 0)
        actions.push(`② 残タスク確認: \`!task list\``);
      actions.push(`③ 次の開発を実行: \`!project run ${projectId}\``);
      break;
  }
  return actions;
}

// ─────────────────────────────────────────────────────
// GPT 相談用コピー文を生成
// ─────────────────────────────────────────────────────
function buildGptCopyText(projectId, execStatus, runStats, quality, taskSummary, roles) {
  const { tasksDone, tasksFailed, stopReason } = runStats;
  const { level, score } = quality;
  const { pending, onHold } = taskSummary;
  const statusText = EXEC_LABEL[execStatus] || execStatus;

  return `【AI開発プロジェクト状況報告 — ${projectId}】

現状: ${statusText}

実行結果:
・完了タスク: ${tasksDone}件
・失敗タスク: ${tasksFailed}件
・停止理由: ${stopReason || '正常完了'}
・コード品質: ${level}${score !== null ? ` (${score}/100)` : ''}
・残タスク: 未着手${pending}件 / 保留${onHold}件

開発内容概要:
${roles.developer}

品質状況:
${roles.qa.replace(/\n  /g, '\n')}

課題・懸念:
${roles.pm}

次のアクション候補:
・不足機能確認（!project refine）
・品質問題の解消
・残タスクの優先度判断

このプロジェクトについてアドバイスをお願いします。
特に「次に何を優先すべきか」「追加すべき機能はあるか」を教えてください。`;
}

// ─────────────────────────────────────────────────────
// メイン: CEO Report オブジェクトを生成
//
// 引数:
//   projectId      — string
//   runStats       — { tasksDone, tasksFailed, stopReason, yellowCount }
//   quality        — { level, score, redTriggers }
//   boardStatus    — BOARD_STATUS string (from ai-board-report)
//   taskManager    — task-manager モジュール
//   projectManager — project-manager モジュール
// ─────────────────────────────────────────────────────
function generateCeoReport(projectId, runStats, quality, boardStatus, taskManager, projectManager) {
  // taskSummary を収集
  let taskSummary = { pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 0, total: 0 };
  try {
    const all  = taskManager.listTasks();
    const proj = projectManager.filterTasksByProject(all, projectId);
    taskSummary = {
      total:      proj.length,
      pending:    proj.filter(t => t.state === taskManager.STATES.PENDING).length,
      onHold:     proj.filter(t => t.state === taskManager.STATES.ON_HOLD).length,
      reviewing:  proj.filter(t => t.state === taskManager.STATES.REVIEWING).length,
      awaiting:   proj.filter(t => t.state === taskManager.STATES.AWAITING).length,
      inProgress: proj.filter(t => t.state === taskManager.STATES.IN_PROGRESS).length,
    };
  } catch { /* default values */ }

  const execStatus  = boardStatusToExecStatus(boardStatus, runStats, taskSummary);
  const recentDone  = collectRecentDoneTasks(projectId, taskManager, projectManager);
  const roles       = buildRoleEvaluations(execStatus, runStats, quality, taskSummary, recentDone, projectId);
  const nextActions = buildNextActions(execStatus, runStats, taskSummary, projectId);
  const gptCopy     = buildGptCopyText(projectId, execStatus, runStats, quality, taskSummary, roles);

  const companyEvaluations = companyRoles.evaluateAll({ execStatus, runStats, quality, taskSummary });

  return {
    projectId,
    execStatus,
    execEmoji:  EXEC_EMOJI[execStatus],
    execLabel:  EXEC_LABEL[execStatus],
    runStats:   { ...runStats },
    quality:    { level: quality.level, score: quality.score },
    taskSummary,
    roles,
    companyEvaluations,
    nextActions,
    gptCopy,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────
// Discord 向けテキスト（パート1: サマリー + ロール評価）
// ─────────────────────────────────────────────────────
function formatCeoReportPart1(report) {
  const { projectId, execStatus, execEmoji, execLabel, runStats, quality, taskSummary, roles } = report;
  const { tasksDone, tasksFailed, stopReason, yellowCount = 0 } = runStats;
  const qualIcon = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[quality.level] || '❓';

  return (
    `📋 **CEO Report** — Project: \`${projectId}\`\n\n` +
    `**現在判定: ${execEmoji} ${execLabel}**\n\n` +
    `**今回の実行:**\n` +
    `  完了: ${tasksDone}件 | 失敗: ${tasksFailed}件` +
    (yellowCount > 0 ? ` | 品質警告: ${yellowCount}回` : '') + '\n' +
    `  ${qualIcon} 品質: ${quality.level}${quality.score !== null ? ` (${quality.score}/100)` : ''}\n\n` +
    `**各 AI 役割評価:**\n\n` +
    `🅰️ **Developer（何を作ったか）**\n${roles.developer}\n\n` +
    `🅱️ **QA（品質）**\n${roles.qa}\n\n` +
    `🅲 **PM（目的達成度）**\n${roles.pm}`
  );
}

// ─────────────────────────────────────────────────────
// Discord 向けテキスト（パート2: Product + Learning + 次のアクション）
// ─────────────────────────────────────────────────────
function formatCeoReportPart2(report) {
  const { roles, nextActions, projectId } = report;

  const actionsText = nextActions
    .map(a => `  ${a}`)
    .join('\n');

  return (
    `🅴 **Product（ユーザー目線）**\n${roles.product}\n\n` +
    `🅷 **Learning（今回の学び）**\n  ・${roles.learning}\n\n` +
    `**次の推奨アクション:**\n${actionsText}`
  );
}

// ─────────────────────────────────────────────────────
// Discord 向けテキスト（パート3: GPT相談用コピー文）
// ─────────────────────────────────────────────────────
function formatCeoReportPart3(report) {
  return (
    `**💬 GPT相談用コピー文（そのまま貼り付け可）:**\n` +
    `\`\`\`\n${report.gptCopy}\n\`\`\``
  );
}

// ─────────────────────────────────────────────────────
// formatCeoReportPart4 — 拡張ロール評価（UX/Finance/Sales/Support/Legal/Security/CostOptimizer）
// ─────────────────────────────────────────────────────
function formatCeoReportPart4(report) {
  const evaluations = report.companyEvaluations;
  if (!evaluations) return '（拡張ロール評価なし）';

  return (
    `**🏢 AI Board 役割別評価:**\n\n` +
    companyRoles.formatCompanyRolesReport(evaluations)
  );
}

// ─────────────────────────────────────────────────────
// formatDailyDigest — 社長向け「毎日の日報」（非エンジニア向け・日本語）
//
// 朝バッチ（毎日8:00）から呼ばれ、#📊-日報 に投稿する想定。
// 専門用語を使わず、「① 何が起きたか ② 良い/悪い ③ 今日やること」
// が一目で分かる短文を返す。
//
// 引数:
//   taskManager — task-manager モジュール
// 戻り値:
//   string（Discord 投稿用テキスト）
// ─────────────────────────────────────────────────────
function formatDailyDigest(taskManager) {
  const S = taskManager.STATES;
  let tasks = [];
  try { tasks = taskManager.listTasks() || []; } catch { tasks = []; }

  // 過去24時間に完了したタスク
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const within24h = (t) => {
    const ts = new Date(t.updatedAt || t.createdAt || 0).getTime();
    return Number.isFinite(ts) && ts >= since24h;
  };

  const doneRecent = tasks.filter(t => t.state === S.DONE && within24h(t)).length;
  const inProgress = tasks.filter(t => t.state === S.IN_PROGRESS || t.state === S.REVIEWING).length;
  const awaiting   = tasks.filter(t => t.state === S.AWAITING).length;
  const stuck      = tasks.filter(t => t.state === S.ON_HOLD).length;

  // ひとこと判定（③放置可否が分かるように）
  let verdict, todo;
  if (stuck > 0) {
    verdict = '🔴 止まっているものがあります';
    todo = `⚠️ #🚨緊急 と #🔧技術ログ を確認するか、エンジニアに「${stuck}件 止まっている」と伝えてください。`;
  } else if (awaiting > 0) {
    verdict = '🟡 あなたの確認まちがあります';
    todo = `✋ #承認-確認 を開いて、${awaiting}件を承認(approve)するか却下(deny)してください。`;
  } else {
    verdict = '🟢 順調です';
    todo = '特に対応は要りません。このまま進めてOKです。';
  }

  const date = new Date().toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return [
    `📊 **今日の日報**　(${date})`,
    ``,
    `**ひとことで言うと：${verdict}**`,
    ``,
    `・昨日からの完了：**${doneRecent}件**`,
    `・いま作業中：${inProgress}件`,
    `・✋ 承認まち：${awaiting}件${awaiting > 0 ? '　← あなたの確認が必要' : ''}`,
    `・⚠️ 止まっている：${stuck}件`,
    ``,
    `👉 **今日やること：**`,
    `　${todo}`,
  ].join('\n');
}

module.exports = {
  EXEC_STATUS,
  EXEC_EMOJI,
  EXEC_LABEL,
  generateCeoReport,
  formatCeoReportPart1,
  formatCeoReportPart2,
  formatCeoReportPart3,
  formatCeoReportPart4,
  formatDailyDigest,
  // テスト用内部関数
  _boardStatusToExecStatus: boardStatusToExecStatus,
  _buildRoleEvaluations:    buildRoleEvaluations,
  _buildNextActions:        buildNextActions,
  _buildGptCopyText:        buildGptCopyText,
};
