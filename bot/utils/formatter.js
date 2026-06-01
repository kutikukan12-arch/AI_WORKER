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
// formatSmartphoneCommand
//
// スマホ Discord でワンタップコピーできるコマンドブロックを生成。
//
// 引数:
//   label   - "次のコマンド:" などの説明ラベル
//   command - コマンド文字列
// ─────────────────────────────────────────────────────
function formatSmartphoneCommand(label, command) {
  return `${label}\n\`\`\`txt\n${command}\n\`\`\``;
}

// ─────────────────────────────────────────────────────
// formatTypeGuard
//
// 危険度に応じたスマホ向けアクション指針を返す。
// コマンドブロックの直後に `---` セパレータ付きで表示する想定。
//
// 引数:
//   danger - '低' | '中' | '高' (絵文字付き可)
// ─────────────────────────────────────────────────────
function formatTypeGuard(danger) {
  const d = (danger || '').replace(/[🔴🟡🟢⬜]/g, '').trim();
  if (d.includes('高')) {
    return `---\n【Type Guard: REJECT】\n・却下推奨 — 人間確認が必要`;
  }
  if (d.includes('中')) {
    return `---\n【Type Guard: IMPLEMENT】\n・実装してよい\n・必要ならテストも追加してよい`;
  }
  return `---\n【Type Guard: SKIP】\n・問題なし — 適用不要`;
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

// =====================================================
// CEO 向けフォーマッター — Phase D-1 Communication Manager
//
// 目的: 通知を「CEO向け（非エンジニア）」と「技術詳細」に分離する。
//   技術情報は消さず、平易な説明を上部に追加する。
//
// エントリポイント: formatForCEO(type, data)
// =====================================================

// ─── エラー種別 → 日本語翻訳 ───────────────────────────
const ERROR_TYPE_TRANSLATION = {
  TIMEOUT:    { label: '作業時間超過',         desc: 'AI がタスクを時間内に完了できませんでした。' },
  AUTH:       { label: 'アクセス権問題',       desc: 'GitHub や外部サービスへのアクセスが拒否されました。' },
  PERMISSION: { label: '操作禁止',             desc: '許可されていない操作が実行されようとしました。' },
  SYNTAX:     { label: 'コード形式の問題',     desc: '生成されたコードに文法エラーが含まれています。' },
  NETWORK:    { label: 'ネットワーク接続エラー', desc: '外部サービスへの接続に失敗しました。ネットワークまたは DNS を確認してください。' },
  UNKNOWN:    { label: '原因調査必要',         desc: '予期しない問題が発生しました。ログで詳細を確認してください。' },
};

function translateErrorType(errorType) {
  return ERROR_TYPE_TRANSLATION[errorType] || ERROR_TYPE_TRANSLATION.UNKNOWN;
}

// ─── HUMAN_CHECK 理由 → 日本語翻訳 ─────────────────────
function translateHumanCheckReason(reason) {
  if (/AUTH|認証|token|credential/i.test(reason))
    return 'GitHub や外部サービスへのアクセスに問題が発生しました。';
  if (/PERMISSION|権限/i.test(reason))
    return '許可されていない操作が必要になりました。';
  if (/soft.*red|validator|未完了|completion/i.test(reason))
    return 'AI が作業を完了できたか確認できませんでした。';
  if (/timeout|タイムアウト/i.test(reason))
    return 'AI が時間内に作業を完了できず、2回続けてタイムアウトしました。';
  if (/AWAITING|人間確認待ち/i.test(reason))
    return '前のステップで人間の確認が求められています。';
  if (/AIレビュー|却下推奨/i.test(reason))
    return 'AI のコードレビューで問題が検出されました。人間による判断が推奨されます。';
  return reason;
}

// ─────────────────────────────────────────────────────
// ① GitHub Push 失敗フォーマット
//    data: { taskId, pushError }
// ─────────────────────────────────────────────────────
function formatGitHubPushFailed({ taskId = '', pushError = '' }) {
  let techCategory = '認証または接続の問題';
  if (/403|permission|denied/i.test(pushError))         techCategory = 'GitHub Token の権限不足 (403)';
  else if (/404|not found/i.test(pushError))             techCategory = 'リポジトリが見つからない (404)';
  else if (/timeout|timed/i.test(pushError))             techCategory = '接続タイムアウト';
  else if (/network|connect|ENOTFOUND/i.test(pushError)) techCategory = 'ネットワーク接続エラー';

  return (
    `⚠️ **外部バックアップ失敗**\n\n` +
    `**状況:** 作業内容はこの PC 内に保存済みです。GitHub へのバックアップだけ失敗しました。\n\n` +
    `**影響:** PC が故障した場合、最新の変更（このタスク以降）を失う可能性があります。\n\n` +
    `**放置すると:** バックアップなしで開発が続きます。チームへの共有もできません。\n\n` +
    `**📋 AI おすすめ: 修復推奨**\n理由: 作業履歴の保護とチーム共有のため。\n\n` +
    `**次の行動:**\n` +
    `  1. \`!doctor\` でシステム診断\n` +
    `  2. GitHub Personal Access Token を再発行して \`.env\` を更新\n` +
    `  3. \`!restart\` で Bot を再起動\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔧 **技術詳細** | タスク: \`${taskId}\` | 分類: ${techCategory}`
  );
}

// ─────────────────────────────────────────────────────
// ② タスクエラーフォーマット
//    data: { taskId, errorType, maskedErrMsg, taskWorkspace, taskType }
// ─────────────────────────────────────────────────────
function formatTaskError({ taskId = '', errorType = 'UNKNOWN', maskedErrMsg = '', taskType = '' }) {
  const { label: errLabel, desc: errDesc } = translateErrorType(errorType);

  const dataStatus = (errorType === 'TIMEOUT' || errorType === 'SYNTAX')
    ? '途中まで生成されたファイルはワークスペースに保存されています。'
    : '作業内容は保護されています（タスクは保留状態になりました）。';

  const autoRecovery = errorType === 'TIMEOUT'
    ? '次回実行時に自動でタスクが分割・再試行されます。'
    : errorType === 'AUTH' || errorType === 'PERMISSION'
    ? '認証情報を修正後、`!project run` または `!auto run 1` で再実行してください。'
    : errorType === 'SYNTAX'
    ? 'AI が次回実行時に修正タスクを自動生成します。'
    : errorType === 'NETWORK'
    ? 'ネットワーク回復後、`!project run` で再実行してください。'
    : '内容を確認してから手動で再実行してください。';

  const humanNeeded = (errorType === 'AUTH' || errorType === 'PERMISSION')
    ? '⚠️ **人間の対応が必要** — 認証情報を確認してください。'
    : errorType === 'TIMEOUT'
    ? 'AI が自動で対処します（次回実行時に小タスクへ分割）。'
    : errorType === 'NETWORK'
    ? '⚠️ **人間の確認推奨** — インターネット接続・DNS・VPN を確認してください。'
    : '状況を確認してから判断してください。';

  const nextCmd = errorType === 'AUTH' || errorType === 'PERMISSION'
    ? `\`!doctor\` → 認証情報を確認・修正 → \`!restart\``
    : errorType === 'TIMEOUT'
    ? `\`!task list\` → タスク分割状況を確認 → \`!project run\``
    : errorType === 'NETWORK'
    ? `\`!doctor\` → ネットワーク状態を確認 → \`!project run\` で再実行`
    : `\`!task list\` → タスク状況を確認 → \`!project run\` で再実行`;

  return (
    `🛑 **作業が止まりました**${taskType ? ` — ${taskType} タスク` : ''}\n\n` +
    `**何が起きた:** ${errDesc}\n問題の種類: **${errLabel}**\n\n` +
    `**作業データ:** ${dataStatus}\n\n` +
    `**自動復旧:** ${autoRecovery}\n\n` +
    `**人間対応:** ${humanNeeded}\n\n` +
    `**次の行動:** ${nextCmd}\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔧 **技術詳細** | タスク: \`${taskId}\` | エラー種別: ${errorType} | ログ: \`logs/\``
  );
}

// ─────────────────────────────────────────────────────
// ③ HUMAN_CHECK フォーマット
//    data: { taskId, projectId, reason, details, task }
// ─────────────────────────────────────────────────────
function formatHumanCheck({ taskId = '', projectId = '', reason = '', details = '', task = null }) {
  const friendlyReason = translateHumanCheckReason(reason);
  const taskPrompt     = (task?.prompt || '').slice(0, 60);
  const taskType       = task?.type || '';
  const taskDesc       = taskPrompt
    ? `作業内容: ${taskPrompt}${taskType ? ` [${taskType}]` : ''}`
    : `タスク: \`${taskId}\``;

  return (
    `⚠️ **AI が判断を止めました — 確認してください**\n\n` +
    `Project: \`${projectId}\`\n${taskDesc}\n\n` +
    `**何が起きた:** ${friendlyReason}\n` +
    (details ? `補足: ${String(details).slice(0, 150)}\n` : '') +
    `\n**承認すると:** → 処理が再開し、次のタスクへ進みます。\n\n` +
    `**却下すると:** → このタスクをキャンセルし、Runner が安全に停止します。\n\n` +
    `**放置すると:** → 処理は止まったままです。自動で動き出すことはありません。\n\n` +
    `**操作:**\n\`\`\`\n` +
    `!task show ${taskId}  → タスク詳細を確認\n` +
    `!approve ${taskId}    → 承認して再開\n` +
    `!deny   ${taskId}    → 却下して停止\n` +
    `\`\`\`\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔧 **技術詳細** | 理由: ${reason} | タスクID: \`${taskId}\``
  );
}

// ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────
// ④ Codex 高危険度 HUMAN_CHECK フォーマット
//
// data:
//   taskId    — string
//   codexFile — string（reviews/codex_task_xxx.md）
//   danger    — '高' | '中' | '低'（デフォルト: '高'）
//   taskType  — string（任意）
// ─────────────────────────────────────────────────────
function formatCodexHighDanger({ taskId = '', codexFile = '', danger = '高', taskType = '' }) {
  return (
    `⚠️ **AI レビュー依頼に高危険度の内容が含まれる可能性があります**\n\n` +
    `**何が起きたか:**\n` +
    `2人目の AI（Codex）へのレビュー依頼の内容に、高危険度の操作が含まれている可能性があります。` +
    (taskType ? `（タスク種別: ${taskType}）` : '') + `\n\n` +
    `**なぜ止まっているか:**\n` +
    `高危険度タスクは、人間が確認してから実行する設計になっています（安全のため）。\n\n` +
    `**承認すると:** → Codex レビュー依頼を続行します。コードレビューが実施されます。\n\n` +
    `**却下すると:** → このレビュー依頼を取りやめます。タスク自体はキャンセルされません。\n\n` +
    `**放置すると:** → このタスクは判断待ちで止まったままです。自動で進むことはありません。\n\n` +
    `**📋 AI おすすめ:** 承認前にレビュー内容を確認\n` +
    `理由: 高危険度と判定されたコードが自動実行される前に、内容を確認することが重要です。\n\n` +
    `**操作コマンド:**\n` +
    `\`\`\`\n` +
    `!approve ${taskId}   → 承認して Codex レビューを続行\n` +
    `!deny   ${taskId}   → 却下して取りやめ\n` +
    `\`\`\`\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔧 **技術詳細** | タスク: \`${taskId}\` | 危険度: 高 | ファイル: \`${codexFile}\``
  );
}

// メインエントリポイント
// ─────────────────────────────────────────────────────
/**
 * formatForCEO(type, data)
 *   type: 'github_push_failed' | 'task_error' | 'human_check' | 'codex_high_danger'
 */
function formatForCEO(type, data = {}) {
  switch (type) {
    case 'github_push_failed': return formatGitHubPushFailed(data);
    case 'task_error':         return formatTaskError(data);
    case 'human_check':        return formatHumanCheck(data);
    case 'codex_high_danger':  return formatCodexHighDanger(data);
    default: return `[${type}] ${JSON.stringify(data).slice(0, 100)}`;
  }
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
  // スマホ向けヘルパー
  formatSmartphoneCommand,
  formatTypeGuard,
  // ショートカット
  embedField,
  embedDesc,
  message,
  // CEO 向けフォーマッター（Phase D-1）
  formatForCEO,
  formatGitHubPushFailed,
  formatTaskError,
  formatHumanCheck,
  formatCodexHighDanger,
  translateErrorType,
  translateHumanCheckReason,
};
