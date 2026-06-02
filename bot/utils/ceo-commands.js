'use strict';
// =====================================================
// ceo-commands.js — CEO Command Layer Phase 1
// 目的: AI_W の調査・設計
//
// !ceo status         — 全体状況サマリー（非エンジニア向け）
// !ceo investigate    — 調査: 現在の問題・ボトルネック分析
// !ceo design         — 設計: 次に実装すべき機能の提案
// =====================================================

// ─────────────────────────────────────────────────────
// buildCeoStatus(taskManager, qualityGate, autoProjectRunner)
//
// 全体状況を非エンジニア向けに1画面でまとめる。
// ceoReport.formatDailyDigest + Runner 状態 + 品質状態。
// ─────────────────────────────────────────────────────
function buildCeoStatus(taskManager, qualityGate, autoProjectRunner, projectManager) {
  const ceoReport = require('./ceo-report');
  const digest = ceoReport.formatDailyDigest(taskManager);

  // Runner 状態
  let runnerSection = '';
  try {
    const projects = projectManager.listProjects ? projectManager.listProjects() : [];
    const running = [];
    for (const p of projects) {
      const state = autoProjectRunner.getRunnerState(p.id || p.name);
      if (state && state.enabled) {
        const loop = state.loopCount || 0;
        const max  = state.maxLoop  || 0;
        running.push(`  ・${p.id || p.name}: ループ ${loop}/${max > 0 ? max : '∞'}`);
      }
    }
    if (running.length > 0) {
      runnerSection = '\n\n🔄 **Auto Runner 稼働中:**\n' + running.join('\n');
    }
  } catch { /* runner 情報が取れない場合はスキップ */ }

  // 品質状態
  let qualitySection = '';
  try {
    const qa    = qualityGate.assessQuality(null);
    const icon  = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[qa.level] || '❓';
    const score = qa.score !== null && qa.score !== undefined ? ` (${qa.score}/100)` : '';
    qualitySection = `\n${icon} **品質:** ${qa.level}${score}`;
    if (qa.level === 'RED' && qa.redTriggers && qa.redTriggers.length > 0) {
      qualitySection += '\n  ' + qa.redTriggers.slice(0, 2).join('\n  ');
    }
  } catch { /* 品質情報が取れない場合はスキップ */ }

  return digest + runnerSection + qualitySection;
}

// ─────────────────────────────────────────────────────
// buildCeoInvestigate(projectId, taskManager, qualityGate, autoProjectRunner)
//
// 調査レポート: タスク状態分布・問題検出・ボトルネック特定。
// projectId が指定されたときはそのプロジェクトに絞る。
// ─────────────────────────────────────────────────────
function buildCeoInvestigate(projectId, taskManager, qualityGate, autoProjectRunner) {
  const S = taskManager.STATES;

  let tasks = [];
  try { tasks = taskManager.listTasks() || []; } catch {}

  const projTasks = projectId
    ? tasks.filter(t => t.projectId === projectId)
    : tasks;

  const counts = {
    pending:    projTasks.filter(t => t.state === S.PENDING).length,
    inProgress: projTasks.filter(t => t.state === S.IN_PROGRESS).length,
    reviewing:  projTasks.filter(t => t.state === S.REVIEWING).length,
    awaiting:   projTasks.filter(t => t.state === S.AWAITING).length,
    onHold:     projTasks.filter(t => t.state === S.ON_HOLD).length,
    done:       projTasks.filter(t => t.state === S.DONE).length,
  };
  const total = projTasks.length;

  // 問題リスト
  const issues = [];
  if (counts.awaiting > 0)
    issues.push(`✋ 承認待ち **${counts.awaiting}件** — \`!approve\` で確認・承認が必要`);
  if (counts.onHold > 0)
    issues.push(`⚠️ 保留タスク **${counts.onHold}件** — 失敗・ブロック状態。\`!task list\` で確認`);
  if (counts.pending > 15)
    issues.push(`📋 未着手 ${counts.pending}件 — タスク過多の可能性。\`!project runner\` で自律実行を検討`);
  if (counts.inProgress + counts.reviewing > 5)
    issues.push(`🔄 進行中 ${counts.inProgress + counts.reviewing}件 — 並列過多の可能性`);

  // 品質問題
  let qualityIssue = '';
  try {
    const qa = qualityGate.assessQuality(projectId || null);
    if (qa.level === 'RED') {
      qualityIssue = '\n\n🔴 **品質 RED 検出:**\n' +
        (qa.redTriggers || []).map(t => `  ${t}`).join('\n') +
        '\n  → `!quality report` で詳細確認を推奨';
    } else if (qa.level === 'YELLOW') {
      const score = qa.score !== null ? ` (${qa.score}/100)` : '';
      qualityIssue = `\n\n🟡 **品質 YELLOW**${score} — 改善推奨事項あり。\`!quality status\` で確認`;
    }
  } catch {}

  const pidLabel = projectId ? ` — ${projectId}` : '';
  const issueSection = issues.length > 0
    ? '\n\n**⚡ 検出された問題:**\n' + issues.map(i => `  ${i}`).join('\n')
    : '\n\n✅ **問題は検出されませんでした**';

  const doneRate = total > 0 ? Math.round((counts.done / total) * 100) : 0;

  return [
    `🔍 **CEO 調査レポート**${pidLabel}`,
    '',
    `**タスク状態（全${total}件）:**`,
    `  未着手: ${counts.pending}件 | 実行中: ${counts.inProgress}件 | レビュー中: ${counts.reviewing}件`,
    `  承認待ち: ${counts.awaiting}件 | 保留: ${counts.onHold}件 | 完了: ${counts.done}件`,
    `  完了率: ${doneRate}%`,
    issueSection,
    qualityIssue,
    '',
    `**次のステップ:** \`!ceo design${projectId ? ' ' + projectId : ''}\` で設計提案を表示`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// buildCeoDesign(projectId, taskManager, projectManager)
//
// 設計提案: 次に実装すべき機能・タスクを優先度付きで提示。
// ─────────────────────────────────────────────────────
function buildCeoDesign(projectId, taskManager, projectManager) {
  const S = taskManager.STATES;

  let tasks = [];
  try { tasks = taskManager.listTasks() || []; } catch {}

  const projTasks = projectId
    ? tasks.filter(t => t.projectId === projectId)
    : tasks;

  const pending = projTasks.filter(t => t.state === S.PENDING);
  const onHold  = projTasks.filter(t => t.state === S.ON_HOLD);

  // 優先度の高い未着手タスク（最大3件）
  const topTasks = pending
    .slice(0, 3)
    .map((t, i) =>
      `  ${i + 1}. [${t.type || '?'}] ${(t.prompt || '(内容なし)').slice(0, 55)}${(t.prompt || '').length > 55 ? '…' : ''}`
    );

  // 保留中タスク（最大2件）
  const holdTasks = onHold
    .slice(0, 2)
    .map(t =>
      `  ・[${t.type || '?'}] ${(t.prompt || '(内容なし)').slice(0, 50)}${(t.prompt || '').length > 50 ? '…' : ''} — 再開 or 破棄要`
    );

  // 推奨アクション生成
  const actions = [];
  if (pending.length === 0 && onHold.length === 0) {
    actions.push('① `!project refine <projectId>` — 不足機能を AI が分析してタスク案を生成');
    actions.push('② `!project run <projectId>` — 自律開発ループを開始');
  } else {
    if (pending.length > 0)
      actions.push(`① \`!project run ${projectId || '<projectId>'}\` — ${pending.length}件の未着手タスクを自律実行`);
    if (onHold.length > 0)
      actions.push(`② \`!task resume <id>\` — 保留タスク${onHold.length}件を確認・再開`);
    actions.push(`③ \`!project refine ${projectId || '<projectId>'}\` — 不足機能を追加分析`);
  }

  const pidLabel = projectId ? ` — ${projectId}` : '';
  const parts = [`🎯 **CEO 設計提案**${pidLabel}`, ''];

  if (topTasks.length > 0) {
    parts.push('**実行候補タスク（優先順）:**');
    parts.push(topTasks.join('\n'));
    parts.push('');
  } else {
    parts.push('**実行候補タスク:** なし（全タスク完了 or 未登録）');
    parts.push('');
  }

  if (holdTasks.length > 0) {
    parts.push('**保留中（要判断）:**');
    parts.push(holdTasks.join('\n'));
    parts.push('');
  }

  parts.push('**推奨アクション:**');
  parts.push(actions.map(a => `  ${a}`).join('\n'));

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────
// buildCeoHelp() — !ceo コマンドのヘルプテキスト
// ─────────────────────────────────────────────────────
function buildCeoHelp() {
  return [
    '**👑 !ceo コマンド一覧（CEO Command Layer Phase 1）**',
    '```',
    '!ceo status                  → 全体状況サマリー（非エンジニア向け）',
    '!ceo investigate             → 調査: 全プロジェクトの問題・ボトルネック分析',
    '!ceo investigate <projectId> → 調査: 指定プロジェクトに絞った分析',
    '!ceo design                  → 設計: 次に実装すべき機能の提案',
    '!ceo design <projectId>      → 設計: 指定プロジェクトの次ステップ提案',
    '```',
    '`!ceo` だけで `!ceo status` と同じです。',
  ].join('\n');
}

// ─── 内部ヘルパー ───
function counts(arr) { return Array.isArray(arr) ? arr.length : 0; }

module.exports = {
  buildCeoStatus,
  buildCeoInvestigate,
  buildCeoDesign,
  buildCeoHelp,
};
