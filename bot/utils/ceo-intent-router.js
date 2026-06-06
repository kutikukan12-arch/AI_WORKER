'use strict';

// =====================================================
// ceo-intent-router.js — CEO Intent Router
//
// 役割:
//   CEOのDiscord自然文を解析してインテントを分類し、
//   適切なアクション（状態確認・runner起動・問題確認など）を
//   AI組織内で自動実行する。
//
//   CEOが ! コマンドを覚える必要をなくす。
//
// インテント分類:
//   STATUS_CHECK   — 「今どう？」「YouTubeどう？」
//   RUN_REQUEST    — 「進めて」「続けといて」
//   PROBLEM_CHECK  — 「止まってない？」「問題ある？」
//   READY_CHECK    — 「公開できる？」「YouTube完成した？」
//   SUMMARY_REQUEST — 「今日なにした？」「今日の結果は？」
//   APPROVE_HINT   — 「OK」「進めて」（approval文脈）
//   UNKNOWN        — 通常タスク登録へフォールスルー
//
// 禁止:
//   - 既存安全承認の削除・弱体化
//   - CEO必須操作（外部公開/課金/秘密情報）の自動実行
//   - YouTube診断β機能追加
// =====================================================

const logger = require('./logger');

// ─────────────────────────────────────────────────────
// インテント定数
// ─────────────────────────────────────────────────────
const INTENTS = {
  STATUS_CHECK:    'status_check',    // 状態・進捗確認
  RUN_REQUEST:     'run_request',     // runner起動・続行
  PROBLEM_CHECK:   'problem_check',   // 問題・エラー確認
  READY_CHECK:     'ready_check',     // リリース・完成確認
  SUMMARY_REQUEST: 'summary_request', // 日次サマリー
  APPROVE_HINT:    'approve_hint',    // 承認ヒント（文脈確認必要）
  UNKNOWN:         'unknown',         // フォールスルー
};

// ─────────────────────────────────────────────────────
// インテント判定パターン
// ─────────────────────────────────────────────────────
const INTENT_PATTERNS = [
  // STATUS_CHECK: 状態・進捗確認
  {
    intent: INTENTS.STATUS_CHECK,
    patterns: [
      /今どう[？?]?$/,
      /どう[？?]$/,
      /状態は[？?]?$/,
      /進捗[？?]$/,
      /どうなってる[？?]?$/,
      /状況教えて/,
      /(.+)どう[？?]?$/,      // 「YouTubeどう？」
      /進んでる[？?]?$/,
      /稼働してる[？?]?$/,
      /動いてる[？?]?$/,
      /何してる[？?]?$/,
    ],
  },

  // RUN_REQUEST: 続行・起動
  {
    intent: INTENTS.RUN_REQUEST,
    patterns: [
      /^進めといて[。\.！!]?$/,
      /^進めて[。\.！!]?$/,
      /^続けて[。\.！!]?$/,
      /^続けといて[。\.！!]?$/,
      /^やっといて[。\.！!]?$/,
      /^動かして[。\.！!]?$/,
      /^開始して[。\.！!]?$/,
      /^再開して[。\.！!]?$/,
      /^始めて[。\.！!]?$/,
      /^走らせて[。\.！!]?$/,
      /自動.*動かして/,
      /auto.*on/i,
    ],
  },

  // PROBLEM_CHECK: 問題確認
  {
    intent: INTENTS.PROBLEM_CHECK,
    patterns: [
      /止まってない[？?]?$/,
      /問題ある[？?]?$/,
      /エラー.*ある[？?]?$/,
      /詰まってない[？?]?$/,
      /ブロックされてない[？?]?$/,
      /承認.*待ち.*ある[？?]?$/,
      /何か.*困ってる[？?]?$/,
      /異常.*ない[？?]?$/,
    ],
  },

  // READY_CHECK: 完成・リリース確認
  {
    intent: INTENTS.READY_CHECK,
    patterns: [
      /公開できる[？?]?$/,
      /リリースできる[？?]?$/,
      /完成した[？?]?$/,
      /できた[？?]?$/,
      /使える[？?]?$/,
      /(.+)(完成|できた|OK)[？?]?$/,   // 「YouTube完成した？」
      /準備.*できてる[？?]?$/,
      /リリース.*準備.*できてる[？?]?$/,
    ],
  },

  // SUMMARY_REQUEST: 日次サマリー
  {
    intent: INTENTS.SUMMARY_REQUEST,
    patterns: [
      /今日.*した[？?]?$/,
      /今日.*やった[？?]?$/,
      /今日.*どうだった[？?]?$/,
      /今日.*結果[？?]?$/,
      /今日.*完了[？?]?$/,
      /今日.*成果[？?]?$/,
      /日報[？?]?$/,
      /報告して/,
      /何.*完了した[？?]?$/,
    ],
  },

  // APPROVE_HINT: 承認ヒント（承認待ちタスクがあれば確認を促す）
  {
    intent: INTENTS.APPROVE_HINT,
    patterns: [
      /^OK[。\.！!]?$/i,
      /^オッケー[。\.！!]?$/,
      /^承認[。\.！!]?$/,
      /^許可[。\.！!]?$/,
      /^いいよ[。\.！!]?$/,
      /^問題ない[。\.！!]?$/,
    ],
  },
];

// ─────────────────────────────────────────────────────
// detectIntent — 自然文からインテントを検出
//
// 戻り値:
//   { intent, confidence, keyword, projectHint }
//   confidence: 'high' | 'medium' | 'low'
//   projectHint: テキスト中のプロジェクト名ヒント（あれば）
// ─────────────────────────────────────────────────────
function detectIntent(text) {
  const normalized = text.trim();

  // ! コマンドはIntentRouterの対象外
  if (normalized.startsWith('!')) {
    return { intent: INTENTS.UNKNOWN, confidence: 'low' };
  }

  // 長い文章（50文字以上）は通常タスク
  if (normalized.length > 50) {
    return { intent: INTENTS.UNKNOWN, confidence: 'low' };
  }

  // プロジェクト名ヒント抽出（YouTube/診断AI/報告書etc）
  const projectHint = extractProjectHint(normalized);

  for (const entry of INTENT_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(normalized)) {
        logger.debug(`[CIR] intent=${entry.intent} | pattern=${pattern} | text="${normalized}"`);
        return {
          intent:      entry.intent,
          confidence:  'high',
          keyword:     normalized,
          projectHint,
        };
      }
    }
  }

  return { intent: INTENTS.UNKNOWN, confidence: 'low', projectHint };
}

// ─────────────────────────────────────────────────────
// extractProjectHint — テキストからプロジェクト名を抽出
// ─────────────────────────────────────────────────────
function extractProjectHint(text) {
  // YouTube / 診断AI / 報告書 などの固有名詞を抽出
  const PROJECT_KEYWORDS = [
    'youtube', 'YouTube', 'yt', 'YT',
    '診断', '診断AI', '診断β',
    '報告書', 'レポート',
  ];
  const lower = text.toLowerCase();
  for (const kw of PROJECT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

// ─────────────────────────────────────────────────────
// buildStatusReply — STATUS_CHECK の返信を構築
//
// タスク一覧・ブロッカー・runner状態をまとめて自然文サマリーにする。
// ─────────────────────────────────────────────────────
function buildStatusReply(projectId, taskManager, projectHint) {
  const tasks = taskManager.listTasks();
  const projectTasks = projectId
    ? tasks.filter(t => t.projectId === projectId)
    : tasks;

  const inProgress = projectTasks.filter(t =>
    t.state === taskManager.STATES.IN_PROGRESS ||
    t.state === '作業中'
  );
  const pending = projectTasks.filter(t =>
    t.state === taskManager.STATES.PENDING ||
    t.state === '未着手'
  );
  const reviewing = projectTasks.filter(t =>
    t.state === taskManager.STATES.REVIEWING ||
    t.state === 'レビュー待ち'
  );
  const humanWait = projectTasks.filter(t =>
    t.state === taskManager.STATES.HUMAN_CHECK ||
    t.state === '人間確認待ち'
  );
  const done = projectTasks.filter(t =>
    t.state === taskManager.STATES.DONE ||
    t.state === '完了'
  );

  const lines = [];
  const projectLabel = projectHint
    ? `**${projectHint}**`
    : projectId ? `\`${projectId}\`` : '現在のプロジェクト';

  lines.push(`📊 **${projectLabel} 状況サマリー**`);
  lines.push('');

  if (inProgress.length > 0) {
    lines.push(`🔄 **実行中**: ${inProgress.length}件`);
    inProgress.slice(0, 2).forEach(t => {
      lines.push(`  \`${t.id}\` [${t.type}] ${(t.prompt || '').slice(0, 40)}...`);
    });
  } else {
    lines.push('🔄 **実行中**: なし');
  }

  lines.push(`📋 **未着手**: ${pending.length}件`);
  lines.push(`✅ **完了**: ${done.length}件`);

  if (reviewing.length > 0) {
    lines.push(`👀 **レビュー待ち**: ${reviewing.length}件`);
  }

  // ブロッカー表示（重要）
  if (humanWait.length > 0) {
    lines.push('');
    lines.push(`⚠️ **CEO確認待ち**: ${humanWait.length}件`);
    humanWait.slice(0, 2).forEach(t => {
      lines.push(`  → \`${t.id}\`: ${(t.prompt || '').slice(0, 40)}`);
    });
  }

  // 全完了判定
  if (inProgress.length === 0 && pending.length === 0 && reviewing.length === 0) {
    lines.push('');
    if (done.length > 0) {
      lines.push('🎉 全タスク完了しています！');
    } else {
      lines.push('📭 タスクがありません。`!project` でプロジェクトを確認してください。');
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// buildProblemReply — PROBLEM_CHECK の返信を構築
// ─────────────────────────────────────────────────────
function buildProblemReply(projectId, taskManager, approvalManager) {
  const tasks = taskManager.listTasks();
  const projectTasks = projectId
    ? tasks.filter(t => t.projectId === projectId)
    : tasks;

  const humanWait = projectTasks.filter(t =>
    t.state === taskManager.STATES.HUMAN_CHECK ||
    t.state === '人間確認待ち'
  );
  const blocked = projectTasks.filter(t =>
    t.state === 'ブロック' || t.state === 'BLOCKED'
  );

  let pendingApprovals = [];
  try {
    pendingApprovals = approvalManager.listPending();
  } catch {}

  const lines = [];

  if (humanWait.length === 0 && blocked.length === 0 && pendingApprovals.length === 0) {
    lines.push('✅ **問題なし**');
    lines.push('現在ブロッカー・承認待ち・エラーはありません。正常に稼働中です。');
    return lines.join('\n');
  }

  lines.push('⚠️ **問題あり — 要確認**');
  lines.push('');

  if (humanWait.length > 0) {
    lines.push(`🔴 **CEO確認待ち**: ${humanWait.length}件`);
    humanWait.slice(0, 3).forEach(t => {
      lines.push(`  → \`${t.id}\`: ${(t.prompt || '').slice(0, 50)}`);
    });
  }

  if (blocked.length > 0) {
    lines.push(`🚫 **ブロック中**: ${blocked.length}件`);
    blocked.slice(0, 3).forEach(t => {
      lines.push(`  → \`${t.id}\`: ${(t.prompt || '').slice(0, 50)}`);
    });
  }

  if (pendingApprovals.length > 0) {
    lines.push(`📋 **承認待ち**: ${pendingApprovals.length}件`);
    lines.push(`  \`!approval list\` で詳細確認`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// buildReadyCheckReply — READY_CHECK の返信を構築
// ─────────────────────────────────────────────────────
function buildReadyCheckReply(projectId, taskManager, projectHint) {
  const tasks = taskManager.listTasks();
  const projectTasks = projectId
    ? tasks.filter(t => t.projectId === projectId)
    : tasks;

  const notDone = projectTasks.filter(t => {
    const s = t.state || '';
    return !(s === taskManager.STATES.DONE || s === '完了');
  });

  const target = projectHint || projectId || 'プロジェクト';

  if (notDone.length === 0 && projectTasks.length > 0) {
    return [
      `✅ **${target}は完了状態です**`,
      '',
      `全 ${projectTasks.length} 件のタスクが完了しています。`,
      '> ⚠️ リリース判断（外部公開）はCEOが確認してから実施してください。',
      '> `!ceo report` で詳細レポートを確認できます。',
    ].join('\n');
  }

  const inProgress = notDone.filter(t =>
    t.state === taskManager.STATES.IN_PROGRESS || t.state === '作業中'
  );
  const humanWait = notDone.filter(t =>
    t.state === taskManager.STATES.HUMAN_CHECK || t.state === '人間確認待ち'
  );

  const lines = [
    `⏳ **${target}はまだ完了していません**`,
    '',
    `残り: ${notDone.length}件 / 全${projectTasks.length}件`,
  ];

  if (inProgress.length > 0) {
    lines.push(`  🔄 実行中: ${inProgress.length}件`);
  }
  if (humanWait.length > 0) {
    lines.push(`  🔴 CEO確認待ち: ${humanWait.length}件 ← ブロッカー`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// buildApproveHintReply — APPROVE_HINT の返信を構築
//
// 承認待ちタスクがあれば内容を表示してCEOに確認を促す。
// 直接 !approve を実行するわけではない（安全ゲート維持）。
// ─────────────────────────────────────────────────────
function buildApproveHintReply(approvalManager) {
  let pending = [];
  try { pending = approvalManager.listPending(); } catch {}

  if (pending.length === 0) {
    return '✅ 現在、承認待ちのタスクはありません。';
  }

  const first = pending[0];
  const lines = [
    `📋 **承認待ちタスクがあります** (${pending.length}件)`,
    '',
    `**対象**: \`${first.taskId}\``,
    `**内容**: ${(first.prompt || '').slice(0, 80)}`,
    `**理由**: ${(first.reason || '').slice(0, 80)}`,
    `**危険度**: ${first.danger || '?'}`,
    '',
    `承認する場合: \`!approve ${first.taskId}\``,
    `却下する場合: \`!deny ${first.taskId}\``,
  ];

  if (pending.length > 1) {
    lines.push(``, `他 ${pending.length - 1} 件は \`!approval list\` で確認できます。`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// formatIntentResponse — インテントと状態から返信を構築
//
// 各インテントに対する返信テキストを返す。
// 「アクションを取る」ではなく「情報を提供する」が基本。
// runner起動（RUN_REQUEST）だけは実際の操作を行う。
// ─────────────────────────────────────────────────────
function formatIntentResponse(intentResult, deps = {}) {
  const { taskManager, approvalManager, projectId, projectHint } = deps;

  switch (intentResult.intent) {
    case INTENTS.STATUS_CHECK:
      return buildStatusReply(projectId, taskManager, projectHint);

    case INTENTS.PROBLEM_CHECK:
      return buildProblemReply(projectId, taskManager, approvalManager);

    case INTENTS.READY_CHECK:
      return buildReadyCheckReply(projectId, taskManager, projectHint);

    case INTENTS.SUMMARY_REQUEST:
      // Daily Closing Report相当を委譲（呼び出し元でbuildClosingSummaryを使う）
      return null; // null = 呼び出し元がDailyClosingを実行

    case INTENTS.RUN_REQUEST:
      // runner起動シグナル（呼び出し元でauto-onを実行）
      return null; // null = 呼び出し元がrunnerを起動

    case INTENTS.APPROVE_HINT:
      return buildApproveHintReply(approvalManager);

    default:
      return null; // UNKNOWN → フォールスルー
  }
}

// ─────────────────────────────────────────────────────
// CEO_USER_IDs — CEOのDiscord User IDリスト
//
// 環境変数 CEO_USER_IDS (カンマ区切り) から取得。
// 空の場合は全ユーザーを対象とする（開発用）。
// ─────────────────────────────────────────────────────
function getCEOUserIds() {
  const raw = process.env.CEO_USER_IDS || '';
  if (!raw.trim()) return []; // 空 = 制限なし
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isCEOUser(userId) {
  const ids = getCEOUserIds();
  if (ids.length === 0) return false; // 設定なしは対象外（安全側）
  return ids.includes(userId);
}

module.exports = {
  INTENTS,
  detectIntent,
  formatIntentResponse,
  buildStatusReply,
  buildProblemReply,
  buildReadyCheckReply,
  buildApproveHintReply,
  isCEOUser,
  getCEOUserIds,
};
