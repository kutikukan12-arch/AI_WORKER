'use strict';

// =====================================================
// ai-meeting.js - AI チーム会議シミュレーター
//
// 役割:
//   Claude Code に「Claude / Codex / ChatGPT の三者が
//   議題について議論する場面」を演じてもらい、
//   優先度・担当・対応策を合議で決定する。
//   結果は docs/meetings/ に保存し Discord に通知する。
//
// フロー:
//   !meeting <議題>
//     → Claude に議論プロンプトを送信
//     → 議事録を docs/meetings/YYYY-MM-DD_topic.md に保存
//     → Discord に要約を通知
//     → 必要なら人間をメンション
//
// 設定（.env）:
//   CLAUDE_COMMAND=claude       Claude コマンド
//   MEETING_CHANNEL_ID=         会議結果通知チャンネル（空=コマンドch）
// =====================================================

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const logger = require('./logger');

const CLAUDE_CMD     = process.env.CLAUDE_COMMAND || 'claude';
const MEETINGS_BASE  = path.join(__dirname, '..', '..', 'docs', 'meetings');
const MEETING_CHANNEL_ID = process.env.MEETING_CHANNEL_ID || '';
const MEETING_TIMEOUT = 120000; // 2分

function getMeetingDir(projectId = 'default') {
  return path.join(MEETINGS_BASE, projectId);
}

// ─────────────────────────────────────────────────────
// Claude への議論プロンプトを生成
// shortMode=true → 討論省略・結論のみ（デフォルト）
// shortMode=false → 詳細討論あり（!meeting full）
// ─────────────────────────────────────────────────────
function buildMeetingPrompt(topic, context = '', shortMode = true) {
  const contextSection = context
    ? `\n## 追加コンテキスト\n${context}\n`
    : '';

  if (shortMode) {
    // ── ショートモード: 結論だけ出す（トークン節約）──
    return `あなたは AI 開発チームのリーダーです。
以下の議題について、Claude / Codex / ChatGPT の視点を踏まえて即座に結論を出してください。
長文討論は不要です。結論・理由・担当・人間確認のみ答えてください。
${contextSection}
## 議題

${topic}

## 出力フォーマット（厳守）

### 決定事項

- 優先度: 高/中/低
- 担当: Claude Code / Codex / ChatGPT / 人間
- 推奨アクション: （1〜2文で具体的に）
- 人間確認: はい/いいえ（理由を1文で）

このフォーマットのみ出力してください。前置きや解説は不要です。`;
  }

  // ── フルモード: 3者討論あり（!meeting full）──
  return `あなたは AI 開発チームのファシリテーターです。
以下の議題について、3人の AI メンバーが議論する場面を演じてください。
${contextSection}
## 参加メンバー

- **Claude**: コード品質・安全性を重視。実装の実現可能性を評価する。
- **Codex**: バグ修正・最適化が得意。技術的リスクを指摘する。
- **ChatGPT**: 仕様整理・設計が得意。ユーザー視点でフィードバックする。

## 議題

${topic}

## 議論のルール

1. 各メンバーが自分の視点から意見を述べること（各50〜100文字以内）
2. 意見の食い違いは建設的に解決すること
3. 最終的に以下を決定すること

## 出力フォーマット

### 議論

**Claude:** （意見）

**Codex:** （意見）

**ChatGPT:** （意見）

**Claude（まとめ）:** （合意内容）

### 決定事項

- 優先度: 高/中/低
- 担当: Claude Code / Codex / ChatGPT / 人間
- 推奨アクション: （1〜3文）
- 人間確認: はい/いいえ（理由）

このフォーマットを厳守してください。`;
}

// ─────────────────────────────────────────────────────
// Claude に会議プロンプトを送信して結果を取得
// ─────────────────────────────────────────────────────
function runMeeting(topic, context = '', shortMode = true) {
  const prompt = buildMeetingPrompt(topic, context, shortMode);

  // プロンプトを一時ファイルに書いてから渡す（文字化け対策）
  const tmpFile = path.join(os.tmpdir(), `ai_meeting_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    const cmd = `${CLAUDE_CMD} -p "$(Get-Content -Raw '${tmpFile}')" --dangerously-skip-permissions --allowedTools Read`;
    // PowerShell 経由は複雑なので直接 -p にプロンプト文字列を渡す
    const output = execSync(
      `${CLAUDE_CMD} -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" --dangerously-skip-permissions --allowedTools Read`,
      {
        encoding: 'utf8',
        timeout:  MEETING_TIMEOUT,
        stdio:    ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        // Windows: shell 経由で実行
        shell: true,
      }
    );
    return output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// 会議結果から決定事項を抽出
// ─────────────────────────────────────────────────────
function parseDecisions(output) {
  const result = {
    priority:       '中',
    assignee:       'Claude Code',
    action:         '',
    needsHuman:     false,
    needsHumanReason: '',
  };

  // 優先度
  const prioMatch = output.match(/優先度[:：]\s*([高中低])/);
  if (prioMatch) result.priority = prioMatch[1];

  // 担当
  const assignMatch = output.match(/担当[:：]\s*(.+?)[\n\r]/);
  if (assignMatch) result.assignee = assignMatch[1].trim().slice(0, 30);

  // 推奨アクション
  const actionMatch = output.match(/推奨アクション[:：]\s*(.+?)(?:\n|$)/s);
  if (actionMatch) result.action = actionMatch[1].trim().slice(0, 200);

  // 人間確認
  const humanMatch = output.match(/人間確認[:：]\s*(はい|いいえ)(.+?)(?:\n|$)/);
  if (humanMatch) {
    result.needsHuman = humanMatch[1] === 'はい';
    result.needsHumanReason = humanMatch[2].trim().slice(0, 100);
  }

  return result;
}

// ─────────────────────────────────────────────────────
// 会議結果を docs/meetings/<projectId>/ に保存
// ─────────────────────────────────────────────────────
function saveMeetingLog(topic, output, decisions, projectId = 'default') {
  const meetingDir = getMeetingDir(projectId);
  if (!fs.existsSync(meetingDir)) fs.mkdirSync(meetingDir, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  const safeTopic = topic.slice(0, 30).replace(/[\\/:*?"<>|\r\n]/g, '_');
  const filename  = `${date}_${safeTopic}.md`;
  const filePath  = path.join(meetingDir, filename);
  const timestamp = new Date().toLocaleString('ja-JP');

  const content = [
    `# AI チーム会議議事録`,
    ``,
    `- **日時:** ${timestamp}`,
    `- **Project:** ${projectId}`,
    `- **議題:** ${topic}`,
    ``,
    `---`,
    ``,
    `## 議論内容`,
    ``,
    output,
    ``,
    `---`,
    ``,
    `## 決定事項まとめ`,
    ``,
    `| 項目 | 決定 |`,
    `|------|------|`,
    `| 優先度 | ${decisions.priority} |`,
    `| 担当 | ${decisions.assignee} |`,
    `| 推奨アクション | ${decisions.action} |`,
    `| 人間確認 | ${decisions.needsHuman ? `はい（${decisions.needsHumanReason}）` : 'いいえ'} |`,
    ``,
    `_AI_WORKER Phase4 自動生成_`,
  ].join('\n');

  fs.writeFileSync(filePath, content, 'utf8');
  logger.info(`会議議事録保存: ${projectId}/${filename}`);
  return { filePath, filename, projectId };
}

// ─────────────────────────────────────────────────────
// Discord 用サマリーテキストを生成（3〜7行・要点のみ）
//
// 絵文字:
//   🟢 実装OK（人間確認不要 かつ 優先度が高でない）
//   🟡 要注意（優先度: 高）
//   🔴 確認必要（人間確認あり）
// ─────────────────────────────────────────────────────
function buildMeetingSummary(topic, decisions, filename, projectId = 'default') {
  const statusEmoji = decisions.needsHuman ? '🔴'
    : decisions.priority === '高' ? '🟡' : '🟢';
  const statusLabel = decisions.needsHuman ? '確認必要'
    : decisions.priority === '高' ? '要注意' : '実装OK';

  const lines = [
    `🤝 **AI会議 完了** | ${statusEmoji} ${statusLabel} | project: ${projectId}`,
    `議題: ${topic.slice(0, 60)}`,
    `決定: ${decisions.action.slice(0, 80) || '（未決定）'}`,
    `担当: ${decisions.assignee}`,
    decisions.needsHuman
      ? `確認: ⚠️ 必要 — ${decisions.needsHumanReason.slice(0, 60)}`
      : `確認: 不要`,
    `📄 \`docs/meetings/${projectId}/${filename}\``,
  ];
  return lines.join('\n');
}

// 旧関数（後方互換のため残す・内部では使わない）
function formatMeetingSummary(topic, decisions, filename) {
  return buildMeetingSummary(topic, decisions, filename);
}

// ─────────────────────────────────────────────────────
// メイン: 会議を実行して結果を返す
//
// 引数:
//   topic      - 議題（Discord メッセージから）
//   context    - 追加コンテキスト（省略可）
//
// 戻り値:
//   { output, decisions, summary, filename, needsHuman }
// ─────────────────────────────────────────────────────
async function conductMeeting(topic, context = '', shortMode = true, projectId = 'default') {
  logger.info(`AI 会議開始 [${shortMode ? 'short' : 'full'}] project:${projectId}: ${topic.slice(0, 50)}`);

  let output;
  try {
    output = runMeeting(topic, context, shortMode);
  } catch (e) {
    logger.error(`AI 会議 Claude 実行失敗: ${e.message}`);
    throw new Error(`会議の実行に失敗しました: ${e.message}`);
  }

  const decisions = parseDecisions(output);
  const { filename } = saveMeetingLog(topic, output, decisions, projectId);
  const summary = buildMeetingSummary(topic, decisions, filename, projectId);

  logger.info(`AI 会議完了 | 優先度: ${decisions.priority} | 担当: ${decisions.assignee}`);

  return {
    output,
    decisions,
    summary,
    filename,
    needsHuman: decisions.needsHuman,
    needsHumanReason: decisions.needsHumanReason,
    MEETING_CHANNEL_ID,
  };
}

module.exports = {
  conductMeeting,
  buildMeetingPrompt,
  buildMeetingSummary,
  formatMeetingSummary,
  parseDecisions,
  MEETING_CHANNEL_ID,
};
