'use strict';

// =====================================================
// project-planner.js — Auto Project Runner: Planner
//
// 役割:
//   プロジェクトの現状を分析し「次に何をすべきか」を決定する。
//   runPlannerStep() から呼ばれ、生成すべきタスクを返す。
//
// Phase B-4: Codex 高/中危険度 → FIX タスク候補生成
// Phase C-1: IMPLEMENT完了後 → REVIEW タスク候補生成（優先度: FIX > REVIEW）
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

  // ── Phase D-1: project_done 判定 ──────────────────────────────────
  // FIX / REVIEW 生成条件がすべて満たされなかった場合に、
  // プロジェクト内に残作業がないか確認する。
  // 残作業なし → action:'project_done'（runner停止は呼び出し元に任せる）
  const tasks = (() => {
    try { return require('./task-manager').listTasks(); } catch { return []; }
  })();
  const activeStates = new Set(['未着手', '作業中', 'レビュー待ち']);
  const projectActiveTasks = tasks.filter(t =>
    t.projectId === projectId && activeStates.has(t.state)
  );

  if (projectActiveTasks.length === 0) {
    logger.info(`[Planner] project_done 候補: ${projectId} (残作業なし)`);
    return {
      action:        'project_done',
      reason:        `プロジェクト内に未着手・作業中・レビュー待ちのタスクが存在しません`,
      suggestedTask: null,
      summary:
        `🏁 **Planner: プロジェクト完了候補**\n` +
        `Project: \`${projectId}\`\n` +
        `残作業: 0件\n` +
        `\`!project runner off\` で Runner を停止してください。`,
    };
  }

  // ── Phase C-1: IMPLEMENT完了後 → REVIEW タスク候補生成 ──────────────
  // context.completedTask が存在し type=IMPLEMENT の場合に REVIEW を提案する。
  // FIX 生成（B-4）が優先されるため、ここに到達するのは低危険度か reviewResult なしの場合。
  // ※ tasks.json への書き込みはまだしない（副作用なし）。
  const completedTask = context.completedTask || null;

  if (completedTask && completedTask.type === 'IMPLEMENT') {
    const taskTitle   = (completedTask.prompt || completedTask.title || completedTask.id || '').slice(0, 80);
    const reviewPrompt = [
      `[IMPLEMENT完了後レビュー] ${taskTitle}`,
      ``,
      `対象の実装が正しく機能するか、品質上の問題がないかを確認してください。`,
      `コード変更は禁止。問題点と改善案の提示のみ。`,
    ].join('\n');

    logger.info(`[Planner] REVIEW タスク候補を生成: ${projectId} | 完了IMPLEMENT: ${completedTask.id}`);

    return {
      action: 'create_task',
      reason: `IMPLEMENT タスク (${completedTask.id}) が完了したため品質確認のREVIEWを提案`,
      suggestedTask: {
        type:              'REVIEW',
        priority:          '中',
        title:             `IMPLEMENT完了後レビュー`,
        prompt:            reviewPrompt,
        sourceImplementId: completedTask.id,
      },
      summary:
        `👀 **Planner: REVIEW タスク候補**\n` +
        `IMPLEMENT完了: \`${completedTask.id}\`\n` +
        `${taskTitle.slice(0, 50)}${taskTitle.length > 50 ? '...' : ''}\n` +
        `(Phase C-1: 候補のみ。自動登録は Phase C-2 以降)`,
    };
  }

  // 条件なし / 低危険度 / 完了タスクなし → 何もしない
  return {
    action:        'none',
    reason:        reviewResult
      ? `Codexレビューの危険度が低いため自動生成不要 (danger: ${reviewResult.danger || 'なし'})`
      : completedTask
      ? `completedTask.type=${completedTask.type} は REVIEW 生成対象外`
      : 'レビュー結果も完了タスク情報もないため判断不可',
    suggestedTask: null,
    summary:       '📋 Planner: 自動生成条件を満たしません',
  };
}

// ─────────────────────────────────────────────────────
// キーワード → 必要タスク のルールテーブル（Phase D-4a）
//
// keyword:  goals / description に含まれるキーワード
// tasks:    keyword が検出された場合に必要と推定されるタスク定義
// doneHint: doneTasks にこのキーワードが含まれていれば「実装済み」とみなす
// ─────────────────────────────────────────────────────
const KEYWORD_RULES = [
  {
    keyword:  'YouTube',
    tasks: [
      { type: 'RESEARCH',  priority: '高', title: 'YouTube API 仕様調査',   reason: 'API 仕様の確認が必要' },
      { type: 'DOCS',      priority: '高', title: 'MVP 仕様書作成',         reason: '仕様が未確定' },
      { type: 'IMPLEMENT', priority: '中', title: 'YouTube データ取得実装', reason: 'MVP 中核機能' },
    ],
    doneHint: 'YouTube',
  },
  {
    keyword:  'AI',
    tasks: [
      { type: 'RESEARCH',  priority: '高', title: 'AI モデル選定・調査',   reason: 'モデル選定が必要' },
      { type: 'IMPLEMENT', priority: '中', title: 'AI 推論エンジン実装',   reason: 'コア機能' },
      { type: 'TEST',      priority: '低', title: 'AI 精度テスト',          reason: '品質確認' },
    ],
    doneHint: 'AI',
  },
  {
    keyword:  'API',
    tasks: [
      { type: 'IMPLEMENT', priority: '高', title: 'API エンドポイント実装', reason: 'API は MVP 必須' },
      { type: 'DOCS',      priority: '中', title: 'API ドキュメント作成',   reason: '利用者向け仕様書' },
      { type: 'TEST',      priority: '低', title: 'API テスト追加',          reason: '動作保証' },
    ],
    doneHint: 'API',
  },
  {
    keyword:  '認証',
    tasks: [
      { type: 'IMPLEMENT', priority: '高', title: '認証機能実装',           reason: 'セキュリティ必須' },
      { type: 'TEST',      priority: '中', title: '認証テスト追加',          reason: '脆弱性防止' },
    ],
    doneHint: '認証',
  },
  {
    keyword:  'DB',
    tasks: [
      { type: 'IMPLEMENT', priority: '高', title: 'DB スキーマ設計・実装',  reason: 'データ永続化' },
      { type: 'TEST',      priority: '中', title: 'DB マイグレーションテスト', reason: 'データ整合性' },
    ],
    doneHint: 'DB',
  },
  {
    keyword:  'UI',
    tasks: [
      { type: 'IMPLEMENT', priority: '中', title: 'UI 実装',                reason: 'ユーザー操作画面' },
      { type: 'REVIEW',    priority: '低', title: 'UI/UX レビュー',          reason: 'UX 品質確認' },
    ],
    doneHint: 'UI',
  },
  {
    keyword:  '診断',
    tasks: [
      { type: 'DOCS',      priority: '高', title: '診断ロジック仕様書',      reason: '診断基準の明文化' },
      { type: 'IMPLEMENT', priority: '高', title: '診断エンジン実装',        reason: 'MVP コア機能' },
    ],
    doneHint: '診断',
  },
  {
    keyword:  '予測',
    tasks: [
      { type: 'RESEARCH',  priority: '高', title: '予測モデル調査',          reason: 'モデル選定が必要' },
      { type: 'IMPLEMENT', priority: '高', title: '予測モデル実装',          reason: 'コア機能' },
    ],
    doneHint: '予測',
  },
];

// ─────────────────────────────────────────────────────
// doneHint が doneTasks に含まれているか判定するヘルパー
// ─────────────────────────────────────────────────────
function isDone(hint, doneTasks) {
  const hintL = hint.toLowerCase();
  return doneTasks.some(d => d.toLowerCase().includes(hintL));
}

// ─────────────────────────────────────────────────────
// planProjectGoals(projectId, input) — Phase D-4a
//
// プロジェクト目標から不足機能（gaps）を推定し、
// 次タスク候補（nextCandidates）を返す。
// Phase D-4a はルールベース推定。Claude/Codex API はまだ使わない。
//
// 引数:
//   projectId - プロジェクトID
//   input     - {
//                 description: string,  // project の説明・目標
//                 docs:        string,  // docs/*.md の内容（任意）
//                 doneTasks:   string[], // 完了済みタスクのサマリー
//               }
//
// 戻り値:
//   { goals, implemented, gaps, nextCandidates, summary }
// ─────────────────────────────────────────────────────
function planProjectGoals(projectId, input = {}) {
  logger.debug(`[Planner] planProjectGoals called: ${projectId}`);

  const description = (input.description || '').trim();
  const docs        = (input.docs        || '').trim();
  const doneTasks   = input.doneTasks    || [];
  const allText     = (description + ' ' + docs).toLowerCase();

  // goals: description から簡易抽出
  const goals = description
    .split(/[\n\r・\-\*]/)
    .map(l => l.trim())
    .filter(l => l.length > 5)
    .slice(0, 10);

  const implemented = doneTasks.slice(0, 10);

  // ── Phase D-4a: ルールベース gaps / nextCandidates 生成 ──
  const gapSet       = new Set();   // 重複なし gap
  const candidateMap = new Map();   // title → candidate（重複排除）

  for (const rule of KEYWORD_RULES) {
    if (!allText.includes(rule.keyword.toLowerCase())) continue;

    const alreadyDone = isDone(rule.doneHint, doneTasks);

    for (const task of rule.tasks) {
      if (candidateMap.has(task.title)) continue;

      // doneTasks にその type のキーワードが含まれていれば済みとみなす
      const typeAlreadyDone = doneTasks.some(d =>
        d.toUpperCase().includes(task.type)
      );
      if (typeAlreadyDone && task.type !== 'REVIEW' && task.type !== 'TEST') continue;
      if (alreadyDone && task.type === 'RESEARCH') continue;

      gapSet.add(task.title);
      candidateMap.set(task.title, {
        type:     task.type,
        priority: task.priority,
        title:    task.title,
        reason:   task.reason,
        prompt:   `[${task.type}] ${task.title}\n${task.reason}`,
      });
    }
  }

  const gaps           = [...gapSet];
  const nextCandidates = [...candidateMap.values()]
    .sort((a, b) => {
      const p = { '高': 0, '中': 1, '低': 2 };
      return (p[a.priority] ?? 3) - (p[b.priority] ?? 3);
    })
    .slice(0, 5);

  logger.info(
    `[Planner] planProjectGoals D-4a: ${projectId} | goals:${goals.length} | gaps:${gaps.length} | candidates:${nextCandidates.length}`
  );

  return {
    goals,
    implemented,
    gaps,
    nextCandidates,
    summary:
      `📊 **Project Goals 分析** (D-4a: ルールベース)\n` +
      `Project: \`${projectId}\`\n` +
      `目標: ${goals.length}件\n` +
      `実装済み: ${implemented.length}件\n` +
      `不足推定: ${gaps.length}件\n` +
      (nextCandidates.length > 0
        ? `\n**次タスク候補:**\n` + nextCandidates.slice(0, 3).map(
            c => `・[${c.type}] ${c.title}`
          ).join('\n')
        : ''),
  };
}

module.exports = {
  planNextTask,
  planProjectGoals,
};
