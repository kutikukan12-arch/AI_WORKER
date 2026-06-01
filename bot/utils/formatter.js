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
// HUMAN_CHECK 用: 理由タイプ別に承認/却下/AI推奨テキストを生成
// ─────────────────────────────────────────────────────
function _humanCheckContext(reason) {
  // AUTH / PERMISSION
  if (/AUTH|認証|token|credential|PERMISSION|権限/i.test(reason)) {
    return {
      situation: 'APIキーや認証情報に問題が発生しました。外部サービスへのアクセスができない状態です。',
      stopReason: '認証情報の確認なしに続行すると、エラーが繰り返されるだけなので一時停止しました。',
      approveResult: '処理が再開します。ただし認証情報が正しくない場合は再びエラーになります。',
      approveSuccessNote: '認証が成功すると自動で次のタスクへ進みます。',
      approveFailNote: '再びエラーになった場合は、また止まって確認を求めます。',
      approveDanger: '中',
      denyResult: 'このタスクをキャンセルし、Runner が停止します。`!doctor` で認証情報を確認してから `!project run` で再開できます。',
      aiRecommend: '内容確認推奨',
      aiReason: 'まず `!doctor` でシステム診断を実行し、認証情報を確認してから承認することをお勧めします。',
    };
  }
  // soft RED / validator failure
  if (/soft.*red|validator|未完了|completion/i.test(reason)) {
    return {
      situation: 'AIが作業を行いましたが、完了チェックで問題が検出されました。コードの変更が不完全な可能性があります。',
      stopReason: '2回試みても自動修正できなかったため、人間の判断を求めています。',
      approveResult: '処理が再開し、次のタスクへ進みます。今回の作業結果はそのまま使用されます。',
      approveSuccessNote: '次のタスクで問題が解消される可能性があります。',
      approveFailNote: '問題が残ったまま進むリスクがあります。',
      approveDanger: '中',
      denyResult: 'このタスクをキャンセルし、Runner が停止します。`!task list` で状況を確認できます。',
      aiRecommend: '内容確認推奨',
      aiReason: '`!review list` でコードレビュー結果を確認し、変更内容に問題がないか確認してから判断してください。',
    };
  }
  // timeout
  if (/timeout|タイムアウト/i.test(reason)) {
    return {
      situation: '同じタスクが時間内に完了できない状態が続いています（2回連続タイムアウト）。',
      stopReason: '自動で何度も再試行し続けると時間とコストが無駄になるため停止しました。',
      approveResult: 'タスクの内容を確認したうえで処理を再開します。',
      approveSuccessNote: '簡単なタスクならそのまま完了します。',
      approveFailNote: '複雑な作業の場合は再度タイムアウトする可能性があります。',
      approveDanger: '低',
      denyResult: 'このタスクをスキップします。`!task list` で残りのタスクを確認できます。',
      aiRecommend: '内容確認推奨',
      aiReason: 'タスクが複雑すぎる可能性があります。`!task show` で内容を確認し、必要なら分割を検討してください。',
    };
  }
  // AI レビュー却下推奨
  if (/AIレビュー|却下推奨/i.test(reason)) {
    return {
      situation: 'AIによるコードレビューの結果、このコードには問題がある可能性が指摘されました。',
      stopReason: '問題のあるコードをそのままリリースするリスクを防ぐために停止しました。',
      approveResult: '指摘があっても処理を続行します。コードはそのまま使用されます。',
      approveSuccessNote: '次のステップへ進めます。',
      approveFailNote: 'AIが指摘した問題が残ったままになります。',
      approveDanger: '高',
      denyResult: 'このタスクをキャンセルします。`!review list` で詳細を確認できます。',
      aiRecommend: '内容確認推奨',
      aiReason: 'AIレビューで問題が見つかっています。`!review list` で詳細を確認してから判断することをお勧めします。',
    };
  }
  // デフォルト
  return {
    situation: 'AIが自動で判断できない状況が発生しました。',
    stopReason: '安全のため、人間に確認を求めて停止しました。',
    approveResult: '処理が再開し、次のステップへ進みます。',
    approveSuccessNote: '正常に続行します。',
    approveFailNote: '問題があれば再度停止します。',
    approveDanger: '中',
    denyResult: 'このタスクをキャンセルし、Runner が停止します。',
    aiRecommend: '内容確認推奨',
    aiReason: '状況を確認してから判断することをお勧めします。',
  };
}

// ─────────────────────────────────────────────────────
// ③ HUMAN_CHECK フォーマット（CEO向け判断支援フォーマット）
//    data: { taskId, projectId, reason, details, task }
// ─────────────────────────────────────────────────────
function formatHumanCheck({ taskId = '', projectId = '', reason = '', details = '', task = null }) {
  const taskPrompt = (task?.prompt || '').slice(0, 60);
  const taskType   = task?.type || '';
  const ctx        = _humanCheckContext(reason);
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[ctx.approveDanger] || '🟡';
  const recEmoji    = ctx.aiRecommend.includes('承認') ? '✅' : '⚠️';

  const taskLine = taskPrompt
    ? `作業: ${taskPrompt}${taskType ? ` [${taskType}]` : ''}`
    : `タスク: \`${taskId}\``;

  return (
    `⚠️ **確認が必要です** — Project: \`${projectId}\`\n\n` +

    `📌 **状況**\n${ctx.situation}\n` +
    (details ? `補足: ${String(details).slice(0, 120)}\n` : '') +
    `${taskLine}\n\n` +

    `🛑 **止めた理由**\n${ctx.stopReason}\n\n` +

    `━━━━━━━━━━━━━━━\n\n` +

    `✅ **承認した場合**\n` +
    `結果: ${ctx.approveResult}\n` +
    `　・成功: ${ctx.approveSuccessNote}\n` +
    `　・失敗: ${ctx.approveFailNote}\n` +
    `危険度: ${dangerEmoji} ${ctx.approveDanger}\n` +
    `おすすめ: ${recEmoji} ${ctx.aiRecommend}\n\n` +

    `❌ **却下した場合**\n` +
    `結果: ${ctx.denyResult}\n` +
    `　・プロジェクトへの影響: タスクが1件スキップされます\n` +
    `　・再実行: \`!project run ${projectId}\` でいつでも再開できます\n\n` +

    `⏸ **放置した場合**\n` +
    `結果: AI_WORKER が待機したまま、自動で作業は進みません。\n\n` +

    `🤖 **AI 判断**\n` +
    `おすすめ操作: **${ctx.aiRecommend}**\n` +
    `理由: ${ctx.aiReason}\n\n` +

    `\`\`\`\n` +
    `!task show ${taskId}  → タスク詳細を確認\n` +
    `!approve ${taskId}    → 承認して再開\n` +
    `!deny   ${taskId}    → 却下して停止\n` +
    `\`\`\`\n\n` +

    `━━━━━━━━━━━━━━━\n` +
    `🔧 **技術詳細** | 理由: ${reason} | タスクID: \`${taskId}\``
  );
}

// ─────────────────────────────────────────────────────
// ④ Codex 高危険度 HUMAN_CHECK フォーマット（CEO向け判断支援フォーマット）
//
// data:
//   taskId    — string
//   codexFile — string（reviews/codex_task_xxx.md）
//   danger    — '高' | '中' | '低'（デフォルト: '高'）
//   taskType  — string（任意）
// ─────────────────────────────────────────────────────
function formatCodexHighDanger({ taskId = '', codexFile = '', danger = '高', taskType = '' }) {
  const taskTypeNote = taskType
    ? `（${taskType} タスクのコードが対象です）`
    : '';

  return (
    `⚠️ **確認が必要です** — コードの安全チェック\n\n` +

    `📌 **状況**\n` +
    `AIがコードを作成しました。次に、別のAI（Codex/GPT-4o）がそのコードを確認して、` +
    `不具合や危険な変更がないかチェックしようとしています。${taskTypeNote}\n` +
    `このコードの内容が「高危険度」と判定されたため、確認をお願いしています。\n\n` +

    `🛑 **止めた理由**\n` +
    `コードに削除・上書き・外部送信など影響が大きい変更が含まれている可能性があります。\n` +
    `自動で進める前に、人間が内容を確認する設計になっています。\n\n` +

    `━━━━━━━━━━━━━━━\n\n` +

    `✅ **承認した場合**\n` +
    `結果: 別AI（Codex/GPT-4o）がコードを確認します。\n` +
    `　・成功: レビュー結果が自動で記録され、問題があれば修正タスクが生成されます。\n` +
    `　・失敗: レビューでさらに問題が見つかった場合は再度止まります。\n` +
    `危険度: 🔴 高\n` +
    `おすすめ: ⚠️ 内容確認推奨\n\n` +

    `❌ **却下した場合**\n` +
    `結果: このコードレビューをスキップします。コード自体はそのまま残ります。\n` +
    `　・プロジェクトへの影響: このタスクのレビューが未実施になります\n` +
    `　・再実行: \`!project run\` でいつでも再開できます\n\n` +

    `⏸ **放置した場合**\n` +
    `結果: AI_WORKER が待機したまま、自動で作業は進みません。\n\n` +

    `🤖 **AI 判断**\n` +
    `おすすめ操作: **内容確認推奨**\n` +
    `理由: 承認前に \`!review list\` または \`${codexFile || `reviews/codex_${taskId}.md`}\` を開いて、` +
    `コードの変更内容に問題がないか確認することをお勧めします。\n\n` +

    `\`\`\`\n` +
    `!approve ${taskId}   → 承認して Codex レビューを続行\n` +
    `!deny   ${taskId}   → 却下してスキップ\n` +
    `\`\`\`\n\n` +

    `━━━━━━━━━━━━━━━\n` +
    `🔧 **技術詳細** | タスク: \`${taskId}\` | 危険度: 高 | ファイル: \`${codexFile || `codex_${taskId}.md`}\``
  );
}

// ─────────────────────────────────────────────────────
// classifyDiscordError
//
// エラーメッセージ文字列を分類してスマホ向け説明文を返す。
// timeout / network / auth / file / rate-limit / unknown の6種。
//
// 引数:
//   errMsg - error.message またはそれに準じる文字列
// ─────────────────────────────────────────────────────
function classifyDiscordError(errMsg) {
  const msg = errMsg || '';
  if (/タイムアウト|timeout|timed out/i.test(msg)) {
    return (
      '⏱️ **タイムアウト** — 処理に時間がかかりすぎました。\n' +
      '少し待ってから再試行してください。'
    );
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network.?error|connection.?refused|getaddrinfo/i.test(msg)) {
    return (
      '🌐 **ネットワークエラー** — 外部サービスへの接続に失敗しました。\n' +
      'インターネット接続を確認してから再試行してください。'
    );
  }
  if (/401|403|unauthorized|forbidden|authentication failed|token|credential/i.test(msg)) {
    return (
      '🔑 **認証エラー** — アクセス権限がありません。\n' +
      '`.env` の API キー・トークンを確認してください。`!doctor` で診断できます。'
    );
  }
  if (/ENOENT|EACCES|EPERM|permission denied|no such file/i.test(msg)) {
    return (
      '📁 **ファイルアクセスエラー** — ファイルまたはディレクトリにアクセスできません。\n' +
      'ワークスペースのフォルダ権限を確認してください。'
    );
  }
  if (/quota|rate.?limit|429/i.test(msg)) {
    return (
      '⏳ **API 制限** — リクエスト上限に達しました。\n' +
      'しばらく待ってから再試行してください。'
    );
  }
  return (
    '🔧 **予期しないエラー** — 詳細は `logs/` を確認してください。\n' +
    '再試行しても解決しない場合は管理者に連絡してください。'
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
  classifyDiscordError,
};
