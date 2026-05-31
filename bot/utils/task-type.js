'use strict';

// =====================================================
// task-type.js - タスク種別 & サイズバリデーター
//
// 役割:
//   1. TaskType 判定: IMPLEMENT / RESEARCH / DESIGN / REVIEW
//   2. TaskSize 判定: SMALL / MEDIUM / LARGE（大すぎる場合は分割提案）
//
// TaskType 別完了条件:
//   IMPLEMENT → コード変更あり必須
//   RESEARCH  → 出力内容があれば完了（変更なしでOK）
//   DESIGN    → 出力内容があれば完了（変更なしでOK）
//   REVIEW    → 出力内容があれば完了（変更なしでOK）
//
// TaskSize 判定基準:
//   変更予定ファイル > 3 → LARGE
//   関数追加 > 3        → LARGE
//   Phase数 > 3         → LARGE
//   LARGE → 実行前に分割提案を返す
//
// 使い方（明示的指定）:
//   !claude [RESEARCH] index.js の全コマンド一覧を調べてください
//   !claude [DESIGN] approvalシステムの設計方針を考えてください
// =====================================================

const logger = require('./logger');

// ─── TaskType 定数 ───
const TASK_TYPES = {
  IMPLEMENT: 'IMPLEMENT', // コード変更必須
  RESEARCH:  'RESEARCH',  // 調査・確認（変更不要）
  DESIGN:    'DESIGN',    // 設計・方針（変更不要）
  REVIEW:    'REVIEW',    // レビュー（変更不要）
  OPS:       'OPS',       // 運用・診断・Git操作（変更不要）
};

// ─── TaskSize 定数 ───
const TASK_SIZES = {
  SMALL:  'SMALL',  // 1-2ファイル・1-3関数
  MEDIUM: 'MEDIUM', // 3ファイル・3関数前後
  LARGE:  'LARGE',  // 4+ファイル or 4+関数 or 4+Phase → 分割推奨
};

// ─── TaskType絵文字 ───
const TYPE_EMOJI = {
  IMPLEMENT: '🔨',
  RESEARCH:  '🔍',
  DESIGN:    '📐',
  REVIEW:    '🧐',
  OPS:       '⚙️',
};

// ─── TaskSize絵文字 ───
const SIZE_EMOJI = {
  SMALL:  '🟢',
  MEDIUM: '🟡',
  LARGE:  '🔴',
};

// ─────────────────────────────────────────────────────
// IMPLEMENT 強シグナル（これがあれば必ずIMPLEMENT）
// ─────────────────────────────────────────────────────
const IMPLEMENT_KEYWORDS = [
  '実装', '作成して', '追加して', '修正して', '変更して', '書いて',
  'implement', 'create', 'fix', 'build', 'add', 'write',
  '開発', '作って', '直して', '新規', '作ってください', '実装してください',
  '追加してください', '修正してください',
];

// ─────────────────────────────────────────────────────
// RESEARCH 強シグナル
// ─────────────────────────────────────────────────────
const RESEARCH_KEYWORDS = [
  '調査', '調べて', '調べてください', 'research',
  '原因を特定', '問題を特定', '何が起きて', 'どこで起きて',
  '一覧を出して', 'リストアップ', '列挙して',
];

// ─────────────────────────────────────────────────────
// DESIGN 強シグナル
// ─────────────────────────────────────────────────────
const DESIGN_KEYWORDS = [
  '設計', '方針を', '方針を考えて', 'design', 'plan',
  'アーキテクチャ', '仕様を決めて', 'どうすべきか教えて',
  '計画して', '設計してください', '方針を教えて',
];

// ─────────────────────────────────────────────────────
// REVIEW 強シグナル
// ─────────────────────────────────────────────────────
const REVIEW_KEYWORDS = [
  'レビュー', 'review', 'コードレビュー',
  '問題点を指摘', '改善点を教えて', 'チェックして', 'コードを確認',
];

// ─────────────────────────────────────────────────────
// OPS 強シグナル（運用・診断・Git操作）
// ─────────────────────────────────────────────────────
const OPS_KEYWORDS = [
  'push', 'status', 'diagnose', 'diagnostic',
  '\u8a3a\u65ad', '\u78ba\u8a8d', '\u8abf\u67fb',
  '診断', 'git push', 'git status', 'git log', 'git diff',
  'push診断', 'push確認', 'status確認', 'status確認',
  'デプロイ確認', '疎通確認', '動作確認', '起動確認',
];

// ─────────────────────────────────────────────────────
// TaskType 判定
//
// 優先順位:
//   1. 明示的プレフィックス [TYPE]
//   2. IMPLEMENT キーワード（あれば確定）
//   3. RESEARCH > DESIGN > REVIEW（最初にマッチした方）
//   4. デフォルト: IMPLEMENT
// ─────────────────────────────────────────────────────
function detectTaskType(prompt) {
  // 1. 明示的プレフィックス [TYPE] または [type]
  const prefixMatch = prompt.match(/^\[(IMPLEMENT|RESEARCH|DESIGN|REVIEW|OPS)\]\s*/i);
  if (prefixMatch) {
    const t = prefixMatch[1].toUpperCase();
    logger.info(`TaskType 明示指定: ${t}`);
    return t;
  }

  const text = prompt.toLowerCase();

  // 2. IMPLEMENT キーワード（最優先）
  if (IMPLEMENT_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
    return TASK_TYPES.IMPLEMENT;
  }

  // 3. RESEARCH
  if (RESEARCH_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
    return TASK_TYPES.RESEARCH;
  }

  // 4. DESIGN
  if (DESIGN_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
    return TASK_TYPES.DESIGN;
  }

  // 5. REVIEW
  if (REVIEW_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
    return TASK_TYPES.REVIEW;
  }

  // 6. OPS（診断・Git操作・運用確認）
  if (OPS_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
    return TASK_TYPES.OPS;
  }

  // 7. デフォルト
  return TASK_TYPES.IMPLEMENT;
}

// ─────────────────────────────────────────────────────
// TaskSize 推定
//
// プロンプトを解析して変更規模を推定する。
// 判定基準（いずれか1つでも超えたら LARGE）:
//   fileCount > 3  — .js/.ts/.md 等のファイル言及数
//   funcCount > 3  — `function()` 形式の関数言及数
//   phaseCount > 3 — Phase1/Phase2 等の Phase 数
//
// 返り値:
//   { size, fileCount, funcCount, phaseCount, bulletCount, issues }
// ─────────────────────────────────────────────────────
function estimateTaskSize(prompt) {
  // ─ ファイル言及カウント ─
  // 例: ai-meeting.js, index.js, task-type.js
  const fileMatches = [...new Set(
    (prompt.match(/\b[\w/-]+\.(js|ts|json|md|py|env)\b/g) || [])
      .filter(f => !['node.js', 'discord.js', 'npm'].includes(f.toLowerCase()))
  )];
  const fileCount = fileMatches.length;

  // ─ 関数言及カウント ─
  // 例: detectProjectId(), buildMeetingSummary()
  // バッククォート内 `func()` または 裸の funcName()
  const funcMatches = [...new Set(
    (prompt.match(/`?[a-zA-Z_]\w*\(\)`?/g) || [])
      .map(f => f.replace(/`/g, ''))
      .filter(f => !['console.log()', 'require()', 'module.exports()'].includes(f))
  )];
  const funcCount = funcMatches.length;

  // ─ Phase カウント ─
  // 例: Phase1, Phase2, フェーズ1
  const phaseMatches = [...new Set(
    prompt.match(/Phase\s*\d+|フェーズ\s*\d+/gi) || []
  )];
  const phaseCount = phaseMatches.length;

  // ─ 箇条書きカウント（参考情報）─
  const bulletLines = prompt.split('\n').filter(l => /^[・\-\*]\s/.test(l.trim()));
  const bulletCount = bulletLines.length;

  // ─ LARGE 判定 ─
  const issues = [];
  if (fileCount > 3)  issues.push(`変更ファイル${fileCount}件（上限3件）`);
  if (funcCount > 3)  issues.push(`関数${funcCount}件（上限3件）`);
  if (phaseCount > 3) issues.push(`Phase${phaseCount}個（上限3個）`);

  let size;
  if (issues.length > 0) {
    size = TASK_SIZES.LARGE;
  } else if (fileCount >= 2 || funcCount >= 2 || phaseCount >= 2 || bulletCount >= 6) {
    size = TASK_SIZES.MEDIUM;
  } else {
    size = TASK_SIZES.SMALL;
  }

  logger.info(
    `TaskSize: ${size} | ` +
    `files:${fileCount} funcs:${funcCount} phases:${phaseCount} bullets:${bulletCount}`
  );

  return {
    size, fileCount, funcCount, phaseCount, bulletCount,
    issues,
    fileMatches, funcMatches, phaseMatches,
  };
}

// ─────────────────────────────────────────────────────
// 分割提案テキストを生成
//
// 箇条書きを 2〜3 件ずつ Phase に分割して提示する。
// ─────────────────────────────────────────────────────
function buildSplitSuggestion(prompt, sizeResult) {
  const { fileCount, funcCount, phaseCount, issues, fileMatches, funcMatches, phaseMatches } = sizeResult;

  // 箇条書き行を抽出
  const bullets = prompt.split('\n')
    .map(l => l.trim())
    .filter(l => /^[・\-\*]\s/.test(l))
    .map(l => l.replace(/^[・\-\*]\s+/, ''));

  const lines = [
    `🔴 **タスクが大きすぎます — 分割してください**`,
    ``,
    `**超過している項目:**`,
    ...issues.map(i => `> ❌ ${i}`),
    ``,
    `**分割案（以下を別々に依頼してください）:**`,
  ];

  if (bullets.length > 0) {
    // 2〜3件ずつ Phase に分ける
    const chunkSize = 3;
    let phaseNum = 1;
    for (let i = 0; i < Math.min(bullets.length, 9); i += chunkSize) {
      const chunk = bullets.slice(i, i + chunkSize);
      lines.push(`**Phase${phaseNum}:**`);
      chunk.forEach(b => lines.push(`> ・${b}`));
      phaseNum++;
    }
  } else if (funcMatches.length > 0) {
    // 関数ベースで分割
    const chunkSize = 2;
    let phaseNum = 1;
    for (let i = 0; i < funcMatches.length; i += chunkSize) {
      const chunk = funcMatches.slice(i, i + chunkSize);
      lines.push(`**Phase${phaseNum}:** \`${chunk.join('`  `')}\``);
      phaseNum++;
    }
  } else if (fileMatches.length > 0) {
    // ファイルベースで分割
    const chunkSize = 2;
    let phaseNum = 1;
    for (let i = 0; i < fileMatches.length; i += chunkSize) {
      const chunk = fileMatches.slice(i, i + chunkSize);
      lines.push(`**Phase${phaseNum}:** ${chunk.join(' / ')}`);
      phaseNum++;
    }
  } else {
    lines.push(`指示を 2〜3 機能ずつに分けて、別々に \`!claude\` で依頼してください。`);
  }

  lines.push('');
  lines.push(`💡 \`!claude [RESEARCH]\` など TaskType を指定して依頼することもできます。`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// buildExplorationRules - タイムアウト対策の探索ルールを生成
//
// Claude がプロジェクト全体を無制限に検索して
// タイムアウトするのを防ぐための制約テキストを返す。
//
// 常時適用:
//   ・node_modules / logs / workspace / data を検索禁止
//   ・まず bot/ 配下のみ検索
//
// 条件付き:
//   ・IMPLEMENT + ファイル1件 → そのファイル以外を検索しない
//   ・SMALL / MEDIUM → 広域検索（**/*.js 等）禁止
//
// 引数:
//   taskType       - 'IMPLEMENT'|'RESEARCH'|'DESIGN'|'REVIEW'
//   taskSizeResult - estimateTaskSize() の返り値
//
// 戻り値: プロンプト末尾に追記する文字列
// ─────────────────────────────────────────────────────
function buildExplorationRules(taskType, taskSizeResult) {
  const { size, fileMatches } = taskSizeResult;

  const rules = [
    '',
    '---',
    '【探索ルール】',
    '・node_modules/ は検索禁止',
    '・logs/ は検索禁止',
    '・workspace/ は検索禁止',
    '・data/ は検索禁止（明示的に必要な場合のみ可）',
    '・まず bot/ 配下のみ検索すること',
  ];

  // IMPLEMENT かつ対象ファイルが1件の場合
  if (taskType === TASK_TYPES.IMPLEMENT && fileMatches.length === 1) {
    rules.push(`・対象ファイル（${fileMatches[0]}）以外を検索しない`);
  }

  // SMALL / MEDIUM の場合は広域検索を禁止
  if (size === TASK_SIZES.SMALL || size === TASK_SIZES.MEDIUM) {
    rules.push('・**/*.js 等のプロジェクト全体への広域検索禁止');
    rules.push('・bot/ 配下で見つからない場合は報告して停止すること');
  }

  return rules.join('\n');
}

// ─────────────────────────────────────────────────────
// Discord 表示用: TaskType + TaskSize のサマリー1行
// ─────────────────────────────────────────────────────
function formatTaskInfo(taskType, taskSize) {
  const typeEmoji = TYPE_EMOJI[taskType] || '📋';
  const sizeEmoji = SIZE_EMOJI[taskSize] || '⬜';
  return `TaskType: ${typeEmoji} ${taskType} | TaskSize: ${sizeEmoji} ${taskSize}`;
}

// ─────────────────────────────────────────────────────
// TaskType ごとの完了条件説明（Discord表示用）
// ─────────────────────────────────────────────────────
function getCompletionCriteria(taskType) {
  switch (taskType) {
    case TASK_TYPES.IMPLEMENT: return 'コード変更あり必須';
    case TASK_TYPES.RESEARCH:  return '調査結果の出力があれば完了';
    case TASK_TYPES.DESIGN:    return '設計案・方針書の出力があれば完了';
    case TASK_TYPES.REVIEW:    return 'レビュー結果の出力があれば完了';
    case TASK_TYPES.OPS:       return '実行ログ・診断結果の出力があれば完了';
    default:                   return 'コード変更あり必須';
  }
}

module.exports = {
  TASK_TYPES,
  TASK_SIZES,
  TYPE_EMOJI,
  SIZE_EMOJI,
  detectTaskType,
  estimateTaskSize,
  buildSplitSuggestion,
  buildExplorationRules,
  formatTaskInfo,
  getCompletionCriteria,
};
