'use strict';

// =====================================================
// next-task.js - 次タスク担当AI判断ユーティリティ
// 役割: 作業完了後に「次に誰が対応すべきか」を判断し
//       Discord 投稿用メッセージを生成する
//
// 判断対象:
//   Codex      → バグ修正・最適化・リファクタ
//   ChatGPT    → 仕様相談・設計見直し（DESIGN/RESEARCH のみ）
//   Claude Code → 大規模実装・新機能・次フェーズ
//
// TaskType による制限:
//   IMPLEMENT → ChatGPT に振らない（Codex or Claude Code のみ）
//   DESIGN    → ChatGPT を含む全AI対象
//   RESEARCH  → ChatGPT を含む全AI対象
// =====================================================

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// ドキュメント保存先
const DOCS_PATH = path.join(__dirname, '..', '..', 'docs');

// ─────────────────────────────────────────────────────
// 担当AI判断キーワード
// ─────────────────────────────────────────────────────

// Codex に回すべきキーワード（コード改善・修正系）
const CODEX_KEYWORDS = [
  'エラー', 'バグ', 'bug', 'error', '失敗', '動かない',
  '最適化', 'optimize', 'リファクタ', 'refactor',
  '軽量', '高速化', 'performance', 'パフォーマンス',
  '非同期', 'async', 'await', '並列',
  'セキュリティ', 'security', '脆弱性', 'vulnerability',
  '修正', 'fix', '直して', '改善',
];

// ChatGPT に回すべきキーワード（仕様・設計系）
const CHATGPT_KEYWORDS = [
  '仕様', '設計', 'spec', 'design', '方針',
  '相談', 'アドバイス', '提案', 'advice',
  '優先', 'priority', '判断',
  '運用', 'operation', 'ops',
  'UI', 'UX', 'インターフェース', 'デザイン',
  '機能整理', '整理', '見直し',
  '次に何', '次は何', '何をすべき',
];

// ─────────────────────────────────────────────────────
// 次タスク担当AIを決定する関数
//
// 引数:
//   prompt   - 元の指示文
//   output   - Claude Code の出力
//   taskType - 'IMPLEMENT'|'RESEARCH'|'DESIGN'|'REVIEW'
//              IMPLEMENT の場合 ChatGPT へは振らない
// ─────────────────────────────────────────────────────
function decide(prompt, output, taskType = 'IMPLEMENT') {
  // プロンプトと出力を合わせてキーワード検索
  const combinedText = (prompt + ' ' + (output || '')).toLowerCase();

  // Codex スコア（全 TaskType で計算）
  const codexScore = CODEX_KEYWORDS.filter(kw =>
    combinedText.includes(kw.toLowerCase())
  ).length;

  // ChatGPT スコア: IMPLEMENT の場合は計算しない（0固定）
  // 理由: '設計'/'方針'/'優先'等が実装プロンプトにも頻出するため誤判定を防ぐ
  const isChatGPTEligible = (taskType === 'DESIGN' || taskType === 'RESEARCH');
  const chatgptScore = isChatGPTEligible
    ? CHATGPT_KEYWORDS.filter(kw => combinedText.includes(kw.toLowerCase())).length
    : 0;

  let assignee, reason, priority;

  if (codexScore > chatgptScore && codexScore > 0) {
    // Codex が最適
    assignee = 'Codex';
    reason = 'コード最適化・バグ修正・セキュリティ改善が必要です';
    priority = '高';
  } else if (chatgptScore > codexScore && chatgptScore > 0) {
    // ChatGPT が最適（DESIGN/RESEARCH のみ到達可能）
    assignee = 'ChatGPT';
    reason = '仕様確認・設計相談・運用改善が必要です';
    priority = '中';
  } else {
    // Claude Code が最適（次フェーズへ進む）
    assignee = 'Claude Code';
    reason = '実装が完了し、次フェーズの開発に進む準備ができました';
    priority = '中';
  }

  logger.info(`次タスク判断 → ${assignee}（TaskType:${taskType} Codex=${codexScore} / ChatGPT=${chatgptScore}）`);

  // 人間向け短文説明
  const humanSummary = buildHumanSummary(assignee, prompt);

  // スマホコピペ用依頼文
  const copyableMessage = buildCopyableMessage(assignee, prompt);

  // Discord 投稿用メッセージを生成（スマホ対応フォーマット）
  const discordMessage = buildDiscordMessage(assignee, reason, copyableMessage, priority);

  return { assignee, reason, priority, discordMessage, humanSummary, copyableMessage };
}

// ─────────────────────────────────────────────────────
// 人間向け短文説明（専門用語なし）
// ─────────────────────────────────────────────────────
function buildHumanSummary(assignee, prompt) {
  const short = prompt.slice(0, 60).replace(/[\r\n]+/g, ' ');
  const summaries = {
    'Codex':       `「${short}」の作業が完了しました。コードの品質チェック・最適化をCodexに依頼します。`,
    'ChatGPT':     `「${short}」の作業が完了しました。次の方針・設計をChatGPTに相談します。`,
    'Claude Code': `「${short}」の作業が完了しました。続きの実装をClaude Codeに依頼します。`,
  };
  return summaries[assignee] || `「${short}」の作業が完了しました。`;
}

// ─────────────────────────────────────────────────────
// スマホからそのままコピペできる依頼文
//
// Discord 通知は短文（5行以内）で行う。
// このメッセージは docs/next_task.md に保存し、
// 人間がスマホで Codex/ChatGPT にコピペするために使う。
// → 最低1000文字まで保持（改行も保持）
// ─────────────────────────────────────────────────────
function buildCopyableMessage(assignee, originalPrompt) {
  // 1000文字まで保持。3行以上の連続空行だけ詰める（フォーマット保持）
  const body = originalPrompt.slice(0, 1000).replace(/\r?\n{3,}/g, '\n\n');

  if (assignee === 'Codex') {
    return `以下のコードをレビュー・最適化してください。\n\n${body}`;
  }
  if (assignee === 'ChatGPT') {
    return `以下の実装について設計・方針を相談したいです。\n\n${body}`;
  }
  // Claude Code
  return `以下の続きを実装してください。\n\n${body}`;
}

// ─────────────────────────────────────────────────────
// Discord 投稿用フォーマット（スマホ長押しコピー対応）
// ─────────────────────────────────────────────────────
function buildDiscordMessage(assignee, reason, copyableMessage, priority) {
  const prioEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[priority] || '⬜';
  const assigneeEmoji = { 'Codex': '🔧', 'ChatGPT': '💬', 'Claude Code': '🤖' }[assignee] || '🤖';

  return [
    `【次担当】`,
    `${assigneeEmoji} ${assignee}`,
    ``,
    `【理由】`,
    `${reason}`,
    ``,
    `【コピペ用依頼文】`,
    `${copyableMessage}`,
    ``,
    `【優先度】 ${prioEmoji} ${priority}`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// next_task.md と履歴ファイルを保存する
// ─────────────────────────────────────────────────────
function saveFiles(taskId, prompt, output, decision) {
  // docs フォルダを確保
  const historyDir = path.join(DOCS_PATH, 'history');
  [DOCS_PATH, historyDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  const timestamp = new Date().toLocaleString('ja-JP');

  // 保存する内容
  const content = [
    `# 次のタスク情報`,
    ``,
    `## 基本情報`,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| タスクID | ${taskId} |`,
    `| 作成日時 | ${timestamp} |`,
    `| 次担当AI | **${decision.assignee}** |`,
    `| 優先度 | ${decision.priority} |`,
    ``,
    `## 判断理由`,
    `${decision.reason}`,
    ``,
    `## 元の指示内容`,
    `\`\`\``,
    prompt,
    `\`\`\``,
    ``,
    `## Discord 投稿用メッセージ（コピーしてそのまま貼り付けてください）`,
    `\`\`\``,
    decision.discordMessage,
    `\`\`\``,
    ``,
    `## 実行結果（抜粋）`,
    (output || '（出力なし）').slice(0, 800) + (output && output.length > 800 ? '\n\n...（省略）' : ''),
  ].join('\n');

  // docs/next_task.md を上書き（常に最新を保持）
  fs.writeFileSync(path.join(DOCS_PATH, 'next_task.md'), content, 'utf8');

  // docs/history/タスクID.md として履歴保存
  fs.writeFileSync(path.join(historyDir, `${taskId}.md`), content, 'utf8');

  logger.info(`docs/next_task.md を保存 | 次担当: ${decision.assignee}`);
}

module.exports = { decide, saveFiles };
