'use strict';

// =====================================================
// codex-feedback.js - Codex回答 → Claude Code フィードバック
//
// 役割:
//   Codex のレビュー結果（reviews/codex_task_ID.md）を読み込み、
//   Claude Code に修正指示としてフィードバックする。
//
// 使い方（Discord コマンド）:
//   !apply-review task_1748344800000
//
// 動作モード:
//   [自動] OPENAI_API_KEY が設定されている場合
//     → Codex API 回答を自動取得して即フィードバック
//
//   [手動] API キーなしの場合
//     → reviews/codex_task_ID.md を人間が編集
//     → !apply-review コマンドで適用
//
// フィードバックフロー:
//   reviews/codex_task_ID.md を読む
//   ↓
//   Codex の回答を解析
//   ↓
//   判定: 問題なし / 修正推奨 / 却下推奨
//   ↓
//   修正推奨 → Claude Code に修正指示を出す
//   却下推奨 → 人間確認を促す
//   問題なし → そのまま続行
// =====================================================

const fs           = require('fs');
const path         = require('path');
const claudeRunner = require('./claude-runner');
const logger       = require('./logger');

const REVIEWS_PATH  = path.join(__dirname, '..', '..', 'reviews');
const WORKSPACE_PATH = path.join(__dirname, '..', '..', 'workspace');

// ─────────────────────────────────────────────────────
// Codex レビューファイルから回答テキストを抽出する
// ─────────────────────────────────────────────────────
function parseCodexResponse(content) {
  // パターン1: OpenAI API 自動取得セクション
  const apiMatch = content.match(
    /## Codex API 回答[^\n]*\n\n?([\s\S]*?)(?=\n---|\n## |$)/
  );
  if (apiMatch) {
    const text = apiMatch[1].trim();
    if (text) return text;
  }

  // パターン2: 手動記入セクション
  const manualMatch = content.match(
    /## Codex の回答[^\n]*\n\n?([\s\S]*?)(?=\n---|\n## |$)/
  );
  if (manualMatch) {
    const text = manualMatch[1].trim();
    // プレースホルダーテキストの場合は null を返す
    if (text && !text.includes('ここに Codex の結果を貼り付け')) return text;
  }

  return null;
}

// ─────────────────────────────────────────────────────
// Codex 回答から判定を読み取る
// 戻り値: '問題なし' | '修正推奨' | '却下推奨'
// ─────────────────────────────────────────────────────
function parseVerdict(response) {
  if (!response) return '問題なし';
  const text = response.toLowerCase();

  // 修正・改善が必要というシグナル
  if (
    text.includes('修正推奨') || text.includes('要修正') ||
    text.includes('修正すべき') || text.includes('改善が必要') ||
    text.includes('should be') || text.includes('recommend') ||
    text.includes('improve') || text.includes('issue') ||
    (text.includes('修正') && !text.includes('修正不要'))
  ) return '修正推奨';

  // 却下・重大な問題のシグナル
  if (
    text.includes('却下') || text.includes('危険') ||
    text.includes('reject') || text.includes('critical') ||
    text.includes('重大な問題') || text.includes('使用不可')
  ) return '却下推奨';

  return '問題なし';
}

// ─────────────────────────────────────────────────────
// Claude Code へのフィードバックプロンプトを生成
// ─────────────────────────────────────────────────────
function buildFeedbackPrompt(originalPrompt, codexResponse, taskId) {
  return [
    `# Codex レビュー結果のフィードバック`,
    ``,
    `以下の Codex レビュー結果を確認して、必要な修正のみ行ってください。`,
    `過剰な修正はしないでください。現在必要なものだけ修正します。`,
    ``,
    `## 元の依頼内容`,
    originalPrompt,
    ``,
    `## Codex によるレビュー結果`,
    codexResponse,
    ``,
    `## 対応方針（重要）`,
    `- レビュー内容を読んで「本当に必要か」を判断してください`,
    `- 修正が必要な箇所だけを修正してください`,
    `- 不要な機能追加や過剰なリファクタは行わないでください`,
    `- 修正後、以下を workspace/${taskId}/codex_feedback_result.md に記録してください:`,
    `  1. 何を修正したか`,
    `  2. なぜ修正したか`,
    `  3. 修正しなかった点とその理由`,
    ``,
    `## 作業フォルダ`,
    `workspace/${taskId}/`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// 元のプロンプトをレビューファイルまたは workspace から取得
// ─────────────────────────────────────────────────────
function getOriginalPrompt(taskId, reviewContent) {
  // reviews/codex_task_ID.md の「依頼内容」セクションから取得を試みる
  const reviewMatch = reviewContent.match(/## 依頼内容[\s\S]*?```[\s\S]*?\n([\s\S]*?)```/);
  if (reviewMatch) return reviewMatch[1].trim();

  // workspace/task_ID/prompt.md から取得を試みる
  const promptFile = path.join(WORKSPACE_PATH, taskId, 'prompt.md');
  if (fs.existsSync(promptFile)) {
    const content = fs.readFileSync(promptFile, 'utf8');
    // ヘッダー行を除去して本文だけ取得
    const match = content.match(/## 指示内容\n([\s\S]*)/);
    if (match) return match[1].trim();
    return content.replace(/^#.*\n/gm, '').trim();
  }

  return '（元の指示が見つかりません）';
}

// ─────────────────────────────────────────────────────
// フィードバック結果をレビューファイルに追記保存
// ─────────────────────────────────────────────────────
function saveFeedbackRecord(taskId, verdict, codexResponse, claudeOutput) {
  // reviews/codex_task_ID.md に追記
  const reviewFile = path.join(REVIEWS_PATH, `codex_${taskId}.md`);
  const timestamp = new Date().toLocaleString('ja-JP');

  const appendContent = [
    ``,
    `---`,
    ``,
    `## フィードバック適用記録（${timestamp}）`,
    ``,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| 判定 | ${verdict} |`,
    `| 適用日時 | ${timestamp} |`,
    `| Claude 実行 | ${claudeOutput ? '実施' : 'スキップ'} |`,
    ``,
    claudeOutput
      ? `### Claude Code の修正内容\n\n${claudeOutput.slice(0, 500)}`
      : `### Claude Code 実行なし\n\n判定が「問題なし」または「却下推奨」のためスキップしました。`,
  ].join('\n');

  if (fs.existsSync(reviewFile)) {
    fs.appendFileSync(reviewFile, appendContent, 'utf8');
  }

  // workspace にも保存
  const taskWorkspace = path.join(WORKSPACE_PATH, taskId);
  if (fs.existsSync(taskWorkspace)) {
    fs.writeFileSync(
      path.join(taskWorkspace, 'codex_feedback.md'),
      [
        `# Codex フィードバック記録`,
        ``,
        `- タスクID: ${taskId}`,
        `- 適用日時: ${timestamp}`,
        `- 判定: **${verdict}**`,
        ``,
        `## Codex 回答`,
        codexResponse,
        ``,
        claudeOutput
          ? `## Claude Code 修正内容\n\n${claudeOutput}`
          : `## Claude Code 修正\n\nスキップ（${verdict}のため）`,
      ].join('\n'),
      'utf8'
    );
  }
}

// ─────────────────────────────────────────────────────
// メイン: Codex フィードバックを Claude Code に適用
//
// 引数: taskId（例: task_1748344800000）
// 戻り値:
//   { skipped: true, reason }           回答なし・問題なしの場合
//   { skipped: false, verdict,
//     codexResponse, claudeResult }     実行した場合
// ─────────────────────────────────────────────────────
async function applyFeedback(taskId) {
  const reviewFile     = path.join(REVIEWS_PATH, `codex_${taskId}.md`);
  const taskWorkspace  = path.join(WORKSPACE_PATH, taskId);

  // ── ファイル存在チェック ──
  if (!fs.existsSync(reviewFile)) {
    throw new Error(
      `レビューファイルが見つかりません: reviews/codex_${taskId}.md\n\n` +
      `先に !claude コマンドでタスクを実行してください。`
    );
  }

  if (!fs.existsSync(taskWorkspace)) {
    throw new Error(
      `タスクフォルダが見つかりません: workspace/${taskId}/\n\n` +
      `タスクIDが正しいか確認してください。`
    );
  }

  // ── レビュー内容を読み込み ──
  const reviewContent = fs.readFileSync(reviewFile, 'utf8');
  const codexResponse = parseCodexResponse(reviewContent);

  // Codex の回答がまだ記入されていない場合
  if (!codexResponse) {
    return {
      skipped: true,
      reason:
        `Codex の回答がまだ記入されていません。\n\n` +
        `**手動入力の場合:**\n` +
        `\`reviews/codex_${taskId}.md\` を開いて\n` +
        `「Codex の回答」セクションに内容を貼り付けてください。\n\n` +
        `**自動取得の場合:**\n` +
        `.env に OPENAI_API_KEY を設定してください。`,
    };
  }

  // ── 判定を解析 ──
  const verdict = parseVerdict(codexResponse);
  logger.info(`Codex フィードバック | タスク: ${taskId} | 判定: ${verdict}`);

  // ── 元のプロンプトを取得 ──
  const originalPrompt = getOriginalPrompt(taskId, reviewContent);

  // ── 判定に応じた処理 ──
  let claudeResult = null;

  if (verdict === '修正推奨') {
    // Claude Code に修正指示を出す
    logger.info(`Claude Code にフィードバックを送信...`);
    const feedbackPrompt = buildFeedbackPrompt(originalPrompt, codexResponse, taskId);

    claudeResult = await claudeRunner.run(feedbackPrompt, taskWorkspace);
    logger.info(`フィードバック適用完了 | 実行時間: ${claudeResult.duration}秒`);

  } else if (verdict === '却下推奨') {
    // 却下推奨は人間確認が必要（呼び出し元で処理）
    logger.warn(`Codex 却下推奨 | タスク: ${taskId} → 人間確認が必要`);

  } else {
    // 問題なし → 何もしない
    logger.info(`Codex 問題なし | タスク: ${taskId} → スキップ`);
  }

  // ── 結果を保存 ──
  saveFeedbackRecord(taskId, verdict, codexResponse, claudeResult?.output);

  return {
    skipped: false,
    verdict,
    codexResponse,
    claudeResult,
    taskId,
  };
}

module.exports = { applyFeedback, parseCodexResponse, parseVerdict, buildFeedbackPrompt };
