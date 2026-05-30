'use strict';

// =====================================================
// codex.js - Codex（OpenAI）連携ユーティリティ
//
// 役割:
//   1. Codex に回すべきタスクを判断
//   2. Codex 依頼文を自動生成
//   3. reviews/ フォルダに保存
//   4. Discord 送信用メッセージを生成
//   5. OpenAI API キーがあれば実際に API 呼び出し（任意）
//
// 注意:
//   「Codex」は OpenAI の GPT-4 系 API で実現します。
//   OPENAI_API_KEY が未設定の場合は依頼文の生成のみ行います。
//
// 必要な .env 設定:
//   ENABLE_CODEX=true
//   OPENAI_API_KEY=sk-xxxxxxxxxx   （任意: API直接呼び出し用）
// =====================================================

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { formatForCodex, buildCodexFileSection, truncateMarkdown, MAX_MESSAGE } = require('./formatter');

// reviews フォルダのパス
const REVIEWS_PATH = path.join(__dirname, '..', '..', 'reviews');

// ─────────────────────────────────────────────────────
// Codex に回すべきキーワード（コード改善・修正系）
// ─────────────────────────────────────────────────────
const CODEX_TRIGGER_KEYWORDS = [
  'エラー', 'バグ', 'bug', 'error', '失敗', '動かない', 'うまくいかない',
  '最適化', 'optimize', 'リファクタ', 'refactor', '改善',
  '軽量', '高速化', 'パフォーマンス', 'performance', '遅い',
  '非同期', 'async', 'await', '並列',
  'セキュリティ', 'security', '脆弱性',
  '修正', 'fix', '直して', '整理',
];

// ─────────────────────────────────────────────────────
// Codex レビューが必要か判断
// ─────────────────────────────────────────────────────
function needsCodexReview(prompt, output) {
  const text = (prompt + ' ' + (output || '')).toLowerCase();
  return CODEX_TRIGGER_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

// ─────────────────────────────────────────────────────
// 危険度を判断（Codex 依頼の重要度に使う）
// ─────────────────────────────────────────────────────
function assessDanger(prompt, output, changedFiles = []) {
  const text = (prompt + ' ' + (output || '')).toLowerCase();

  // 高危険度キーワード（データ削除・認証・外部公開系）
  const HIGH = ['delete', '削除', 'drop', 'database', 'credential', 'password', 'token', '秘密', 'auth', '認証'];
  // 中危険度キーワード（設定変更・パッケージ追加系）
  const MID  = ['install', 'package', 'dependency', '.env', 'config', '設定変更', 'npm install'];

  if (HIGH.some(kw => text.includes(kw))) return '高';
  if (MID.some(kw => text.includes(kw))) return '中';
  if (changedFiles.length > 15) return '中'; // 大量変更は中危険
  return '低';
}

// ─────────────────────────────────────────────────────
// Codex への依頼文を生成（Discord 投稿用フォーマット）
// ─────────────────────────────────────────────────────
function generateCodexRequest(taskId, prompt, output, changedFiles = [], reviewResult = {}) {
  const danger = assessDanger(prompt, output, changedFiles);

  // formatter.formatForCodex で 1000〜1500文字の Codex 専用フォーマットを生成
  const request = formatForCodex(taskId, prompt, output, reviewResult, changedFiles);

  // originalPrompt: saveReview() でファイルに全文保存するために渡す
  return { request, danger, changedFiles, taskId, originalPrompt: prompt };
}

// ─────────────────────────────────────────────────────
// 改善提案を自動生成（プロンプト内容から推測）
// ─────────────────────────────────────────────────────
function buildSuggestions(prompt, output) {
  const text = (prompt + ' ' + (output || '')).toLowerCase();
  const points = [];

  if (text.includes('エラー') || text.includes('error') || text.includes('バグ')) {
    points.push('・エラーの原因を特定して修正してください');
  }
  if (text.includes('最適化') || text.includes('遅い') || text.includes('パフォーマンス')) {
    points.push('・処理速度を改善してください');
  }
  if (text.includes('非同期') || text.includes('async')) {
    points.push('・非同期処理を適切に改善してください');
  }
  if (text.includes('セキュリティ') || text.includes('脆弱性')) {
    points.push('・セキュリティ上の問題点を指摘・修正してください');
  }
  if (text.includes('リファクタ') || text.includes('整理')) {
    points.push('・コードを読みやすく整理してください');
  }
  if (text.includes('軽量') || text.includes('シンプル')) {
    points.push('・不要なコードを削除して軽量化してください');
  }

  if (points.length === 0) {
    points.push('・コード全体をレビューして改善点を教えてください');
  }

  return points.join('\n');
}

// ─────────────────────────────────────────────────────
// Discord 送信用メッセージを生成
// ─────────────────────────────────────────────────────
function generateDiscordMessage(taskId, codexRequest) {
  // Discord通知は最大5行・短文のみ（詳細はreviews/に保存）
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[codexRequest.danger] || '⬜';
  return [
    `🤖 **Codex レビュー依頼** | 危険度: ${dangerEmoji} ${codexRequest.danger}`,
    `📋 タスク: \`${taskId}\``,
    `📄 詳細: \`reviews/codex_${taskId}.md\``,
    `❓ レビュー後: \`!apply-review ${taskId}\``,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// Codex 依頼内容を reviews/ に保存
// ─────────────────────────────────────────────────────
function saveReview(taskId, codexInfo) {
  // reviews フォルダを確保
  if (!fs.existsSync(REVIEWS_PATH)) {
    fs.mkdirSync(REVIEWS_PATH, { recursive: true });
  }

  const timestamp = new Date().toLocaleString('ja-JP');
  const content = [
    `# Codex レビュー依頼: ${taskId}`,
    ``,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| 作成日時 | ${timestamp} |`,
    `| 危険度   | ${codexInfo.danger} |`,
    `| タスクID | ${taskId} |`,
    ``,
    // 元の依頼全文（Discord通知は短文のまま。ファイルにのみ全文保存）
    buildCodexFileSection(codexInfo.originalPrompt || ''),
    ``,
    `## Codex向け要約`,
    ``,
    codexInfo.request,
    ``,
    `## Discord 投稿用メッセージ`,
    ``,
    `\`\`\``,
    codexInfo.discordMessage || '（未生成）',
    `\`\`\``,
    ``,
    `## Codex の回答（手動で記入してください）`,
    ``,
    `（ここに Codex の結果を貼り付けてください）`,
  ].join('\n');

  const filePath = path.join(REVIEWS_PATH, `codex_${taskId}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  logger.info(`Codex 依頼を保存: reviews/codex_${taskId}.md | 危険度: ${codexInfo.danger}`);

  return filePath;
}

// ─────────────────────────────────────────────────────
// OpenAI API を直接呼び出す（OPENAI_API_KEY が設定されている場合のみ）
// 注意: API 呼び出しには費用が発生します
// ─────────────────────────────────────────────────────
async function callCodexAPI(prompt, codeContent, model = 'gpt-4o') {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    logger.info('OPENAI_API_KEY が未設定のため Codex API 呼び出しをスキップ');
    return null;
  }

  logger.info(`Codex API 呼び出し開始 (モデル: ${model})`);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'あなたはコードレビューの専門家です。' +
              '提供されたコードと依頼内容を確認し、' +
              '問題点・改善点を日本語で簡潔に指摘してください。' +
              '初心者でも理解できる説明を心がけてください。',
          },
          {
            role: 'user',
            content:
              `以下のコードをレビューしてください:\n\n` +
              `\`\`\`\n${(codeContent || '').slice(0, 3000)}\n\`\`\`\n\n` +
              `依頼内容: ${prompt.slice(0, 500)}`,
          },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API エラー (${response.status}): ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content || null;
    logger.info('Codex API 呼び出し完了');
    return result;

  } catch (err) {
    logger.error(`Codex API 呼び出し失敗: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────
// Codex の回答を reviews/ に追記保存
// ─────────────────────────────────────────────────────
function saveCodexResponse(taskId, response) {
  const filePath = path.join(REVIEWS_PATH, `codex_${taskId}.md`);
  if (!fs.existsSync(filePath)) return;

  const timestamp = new Date().toLocaleString('ja-JP');
  const appendContent = [
    ``,
    `---`,
    ``,
    `## Codex API 回答（自動取得: ${timestamp}）`,
    ``,
    response || '（回答なし）',
  ].join('\n');

  fs.appendFileSync(filePath, appendContent, 'utf8');
  logger.info(`Codex 回答を追記保存: reviews/codex_${taskId}.md`);
}

// ─────────────────────────────────────────────────────
// !codex コマンド: スマホから直接送った内容を1000文字以内に整形
// ─────────────────────────────────────────────────────
function buildDirectCodexRequest(userContent) {
  const content = userContent.slice(0, 800).replace(/\n{3,}/g, '\n\n');

  const body = [
    `【依頼内容】`,
    content,
    ``,
    `【回答形式】（必ずこの形式で回答してください）`,
    `【問題】（問題点や要点を2〜3行で）`,
    `【危険度】高 / 中 / 低`,
    `【改善案】（具体的な改善方法を2〜3行で）`,
  ].join('\n');

  return truncateMarkdown(body, 1000, '');
}

// ─────────────────────────────────────────────────────
// !codex コマンド: OpenAI API を呼び出し（強制フォーマット付き）
// ─────────────────────────────────────────────────────
async function callDirectCodexReview(userContent, taskId) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    logger.info(`!codex: OPENAI_API_KEY 未設定 — API スキップ (${taskId})`);
    return null;
  }

  const request = buildDirectCodexRequest(userContent);
  logger.info(`!codex API 呼び出し開始 (${taskId})`);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'あなたはコードレビューと技術相談の専門家です。' +
              '必ず以下の形式だけで回答してください:\n' +
              '【問題】（問題点や要点を2〜3行）\n' +
              '【危険度】高 / 中 / 低 のどれか1つ\n' +
              '【改善案】（具体的な改善方法を2〜3行）\n\n' +
              '形式を崩さず、日本語で簡潔に答えてください。',
          },
          {
            role: 'user',
            content: request,
          },
        ],
        max_tokens: 400,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API エラー (${response.status}): ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content || null;
    logger.info(`!codex API 完了 (${taskId})`);
    return result;

  } catch (err) {
    logger.error(`!codex API 失敗: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────
// Codex 回答を【問題】【危険度】【改善案】にパース
// ─────────────────────────────────────────────────────
function parseCodexResult(apiResponse) {
  if (!apiResponse) return { problem: '', danger: '不明', suggestion: '', raw: '' };

  const extract = (label) => {
    const regex = new RegExp(`【${label}】([\\s\\S]*?)(?=【|$)`, 'i');
    const match  = apiResponse.match(regex);
    return match ? match[1].trim() : '';
  };

  const problem    = extract('問題');
  const dangerRaw  = extract('危険度');
  const suggestion = extract('改善案');

  // 危険度を正規化（高/中/低 のみ）
  let danger = '低';
  if (dangerRaw.includes('高'))      danger = '高';
  else if (dangerRaw.includes('中')) danger = '中';

  return { problem, danger, suggestion, raw: apiResponse };
}

// ─────────────────────────────────────────────────────
// Codex 結果を Discord 向け5行以内に整形
// ─────────────────────────────────────────────────────
function formatCodexResultForDiscord(parsed, taskId) {
  const { problem, danger, suggestion } = parsed;
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[danger] || '⬜';

  return [
    `🔧 **Codex 結果** | 危険度: ${dangerEmoji} ${danger}`,
    `【問題】 ${(problem   || '問題なし').slice(0, 100)}`,
    `【改善案】 ${(suggestion || '改善不要').slice(0, 100)}`,
    `📄 詳細: \`reviews/codex_direct_${taskId}.md\``,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// !codex の依頼・回答を reviews/ に保存
// ─────────────────────────────────────────────────────
function saveDirectReview(taskId, userContent, apiResult, parsed) {
  if (!fs.existsSync(REVIEWS_PATH)) {
    fs.mkdirSync(REVIEWS_PATH, { recursive: true });
  }

  const timestamp  = new Date().toLocaleString('ja-JP');
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[parsed?.danger] || '⬜';

  const content = [
    `# Codex 直接レビュー: ${taskId}`,
    ``,
    `| 項目     | 内容 |`,
    `|----------|------|`,
    `| 作成日時 | ${timestamp} |`,
    `| 危険度   | ${dangerEmoji} ${parsed?.danger || '不明'} |`,
    `| タスクID | ${taskId} |`,
    ``,
    `## 依頼内容（スマホから送信）`,
    ``,
    userContent || '（内容なし）',
    ``,
    `## Codex 回答（自動取得）`,
    ``,
    apiResult || '（API 未呼び出し — OPENAI_API_KEY を設定してください）',
    ``,
    `## パース結果`,
    ``,
    `**【問題】** ${parsed?.problem || '—'}`,
    ``,
    `**【危険度】** ${dangerEmoji} ${parsed?.danger || '不明'}`,
    ``,
    `**【改善案】** ${parsed?.suggestion || '—'}`,
  ].join('\n');

  const filePath = path.join(REVIEWS_PATH, `codex_direct_${taskId}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  logger.info(`!codex 保存: reviews/codex_direct_${taskId}.md | 危険度: ${parsed?.danger}`);

  return filePath;
}

module.exports = {
  needsCodexReview,
  generateCodexRequest,
  generateDiscordMessage,
  saveReview,
  callCodexAPI,
  saveCodexResponse,
  assessDanger,
  // !codex コマンド用
  buildDirectCodexRequest,
  callDirectCodexReview,
  parseCodexResult,
  formatCodexResultForDiscord,
  saveDirectReview,
};
