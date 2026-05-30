'use strict';

// =====================================================
// formatter.js - AI別フォーマッター + 安全なtruncate
//
// 役割:
//   ・AI（Codex / Claude / 人間）ごとに最適な形式に変換
//   ・Discord文字数制限を一元管理
//   ・コードブロックを壊さない安全なtruncate
//
// Discord制限値（余裕を持たせた実用値）:
//   MAX_MESSAGE    = 1800  （API上限2000）
//   MAX_EMBED_DESC = 3000  （API上限4096）
//   MAX_FIELD      = 900   （API上限1024）
//
// Codex形式:
//   1000〜1500文字以内
//   問題 / 対象 / 期待出力 のみ
// =====================================================

// ─── Discord 文字数制限 ───
const MAX_MESSAGE    = 1800;   // プレーンメッセージ
const MAX_EMBED_DESC = 3000;   // Embed.setDescription()
const MAX_FIELD      = 900;    // Embed.addFields() の value

// ─────────────────────────────────────────────────────
// truncateMarkdown
//
// コードブロックを閉じてから省略する（単純sliceは禁止）。
// 省略時は必ず [省略: reviews/... を参照] を付ける。
//
// 引数:
//   text    - 対象テキスト
//   maxLen  - 最大文字数
//   refPath - reviews/ 以下のパス（例: "codex_task_xxx.md"）
// ─────────────────────────────────────────────────────
function truncateMarkdown(text, maxLen = MAX_MESSAGE, refPath = '') {
  if (!text || text.length <= maxLen) return text;

  // 省略マーカー分の余白を確保（最大50文字）
  const suffix = refPath
    ? `\n[省略: reviews/${refPath} を参照]`
    : '\n[省略]';
  const cutLen = Math.max(0, maxLen - suffix.length - 10);

  let truncated = text.slice(0, cutLen);

  // 開いたままのコードブロックを検出して閉じる
  const markerCount = (truncated.match(/```/g) || []).length;
  if (markerCount % 2 !== 0) {
    // 最後の不完全な行を削除してから閉じる（行の途中で切れているかもしれないので）
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > cutLen - 30) {
      truncated = truncated.slice(0, lastNewline);
    }
    truncated += '\n```';
  }

  return truncated + suffix;
}

// ─────────────────────────────────────────────────────
// formatForHuman
//
// 人間（Discord スマホ）向け。最大5行。専門用語なし。
//
// 引数:
//   summary  - 1行サマリー（完了・エラーなど）
//   details  - { review, git, codex, taskId, nextAssignee }
// ─────────────────────────────────────────────────────
function formatForHuman(summary, details = {}) {
  const {
    review      = '',
    git         = '',
    codex       = '',
    taskId      = '',
    nextAssignee = '',
  } = details;

  const lines = [];

  // 1行目: サマリー
  lines.push(summary.slice(0, 100));

  // 2行目: レビュー（あれば）
  if (review) {
    const emoji = { '問題なし': '🟢', '修正推奨': '🟡', '却下推奨': '🔴' }[review] || '🔍';
    lines.push(`${emoji} レビュー: ${review}`);
  }

  // 3行目: Git/PR（あれば）
  if (git) lines.push(`🔗 ${git}`);

  // 4行目: 次担当（あれば）
  if (nextAssignee) lines.push(`🤖 次担当: ${nextAssignee}`);

  // 5行目: 詳細参照（taskIdがあれば）
  if (taskId) {
    if (codex) {
      lines.push(`📄 詳細: \`reviews/codex_${taskId}.md\``);
    } else {
      lines.push(`📄 詳細: \`workspace/${taskId}/result.md\``);
    }
  }

  // 最大5行で打ち切り
  return lines.slice(0, 5).join('\n');
}

// ─────────────────────────────────────────────────────
// formatForClaude
//
// Claude Code（AI内部）向け。キーバリュー形式・超短文。
// トークン消費を最小化する。
//
// 引数:
//   taskId  - タスクID
//   data    - { prompt, verdict, files, danger, action }
// ─────────────────────────────────────────────────────
function formatForClaude(taskId, data = {}) {
  const {
    prompt  = '',
    verdict = '',
    files   = 0,
    danger  = '低',
    action  = '',
  } = data;

  const lines = [
    `task=${taskId}`,
    `prompt=${prompt.slice(0, 80).replace(/\n/g, ' ')}`,
    verdict ? `verdict=${verdict}` : null,
    files   ? `files=${files}`   : null,
    danger !== '低' ? `danger=${danger}` : null,
    action  ? `action=${action}`  : null,
  ].filter(Boolean);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// formatForCodex
//
// Codex（GPT-4o）向け。問題・対象・期待出力のみ。
// 1000〜1500文字以内に収める。
//
// 引数:
//   taskId       - タスクID
//   prompt       - 依頼内容
//   output       - Claude の出力（抜粋）
//   review       - AIレビュー結果オブジェクト { verdict, issues, warnings }
//   changedFiles - 変更ファイル一覧（最大5件）
// ─────────────────────────────────────────────────────
function formatForCodex(taskId, prompt, output, review = {}, changedFiles = []) {
  const { verdict = '未実施', issues = [], warnings = [] } = review;

  // 問題（400文字以内 — Codex が文脈を把握できるよう拡張）
  const problemText = issues.length > 0
    ? issues.slice(0, 3).join(' / ')
    : prompt.slice(0, 400).replace(/\n/g, ' ');

  // 対象ファイル（300文字以内、最大5件）
  const fileList = changedFiles.length > 0
    ? changedFiles.slice(0, 5).map(f => `  ${f.slice(0, 40)}`).join('\n')
    : '  （変更ファイルを確認してください）';

  // 実装状況（出力抜粋、500文字以内）
  const outputExcerpt = truncateMarkdown(
    (output || '').slice(0, 600),
    500,
    `codex_${taskId}.md`
  );

  // 期待出力（固定テキスト）
  const expectText = verdict === '却下推奨'
    ? '問題を解消できる修正案を提示してください'
    : warnings.length > 0
    ? '警告点の改善案を提示してください'
    : 'コード品質の改善点があれば教えてください';

  const body = [
    `【問題】`,
    problemText,
    ``,
    `【対象】`,
    fileList,
    ``,
    `【実装状況】`,
    outputExcerpt || '（出力なし）',
    ``,
    `【期待出力】`,
    expectText,
    ``,
    `【タスクID】 ${taskId}`,
  ].join('\n');

  // 1500文字で安全にtruncate
  return truncateMarkdown(body, 1500, `codex_${taskId}.md`);
}

// ─────────────────────────────────────────────────────
// buildCodexFileSection
//
// reviews/codex_*.md 保存用の「元の依頼全文」セクションを返す。
//
// 目的:
//   Discord 通知は短文のまま。
//   ファイルにだけ全文を保存するために使用。
//   codex.js の saveReview() から呼ばれる。
//
// 引数:
//   prompt - 元の依頼文（全文）
// ─────────────────────────────────────────────────────
function buildCodexFileSection(prompt) {
  return [
    `## 元の依頼全文`,
    ``,
    prompt || '（内容なし）',
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// embedField - Embed field value を安全にtruncate
// ─────────────────────────────────────────────────────
function embedField(text, refPath = '') {
  return truncateMarkdown(text || '', MAX_FIELD, refPath);
}

// ─────────────────────────────────────────────────────
// embedDesc - Embed description を安全にtruncate
// ─────────────────────────────────────────────────────
function embedDesc(text, refPath = '') {
  return truncateMarkdown(text || '', MAX_EMBED_DESC, refPath);
}

// ─────────────────────────────────────────────────────
// message - プレーンメッセージを安全にtruncate
// ─────────────────────────────────────────────────────
function message(text, refPath = '') {
  return truncateMarkdown(text || '', MAX_MESSAGE, refPath);
}

module.exports = {
  // 文字数定数
  MAX_MESSAGE,
  MAX_EMBED_DESC,
  MAX_FIELD,
  // コア関数
  truncateMarkdown,
  formatForHuman,
  formatForClaude,
  formatForCodex,
  buildCodexFileSection,
  // ショートカット
  embedField,
  embedDesc,
  message,
};
