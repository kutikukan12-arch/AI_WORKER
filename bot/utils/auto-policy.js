'use strict';

// =====================================================
// auto-policy.js — Auto Policy 判定モジュール (Phase E-1)
//
// 役割:
//   タスクとコンテキストを受け取り、自動継続ポリシーを返す。
//   既存の自動実行ロジック（!auto on / !auto run）への接続は Phase E-2 以降。
//
// ポリシー優先順位（高→低）:
//   BLOCKED > HUMAN_APPROVAL_REQUIRED > AI_REVIEW_REQUIRED > AUTO_SAFE
//
// 原則:
//   - 迷ったら AI_REVIEW_REQUIRED
//   - 危険なら HUMAN_APPROVAL_REQUIRED
//   - 破壊的なら BLOCKED
//   - AUTO_SAFE は慎重に限定
// =====================================================

// ─────────────────────────────────────────────────────
// Policy 定数
// ─────────────────────────────────────────────────────
const AUTO_POLICY = {
  AUTO_SAFE:                'AUTO_SAFE',
  AI_REVIEW_REQUIRED:       'AI_REVIEW_REQUIRED',
  HUMAN_APPROVAL_REQUIRED:  'HUMAN_APPROVAL_REQUIRED',
  BLOCKED:                  'BLOCKED',
  LARGE_TASK:               'LARGE_TASK',
};

// ─────────────────────────────────────────────────────
// BLOCKED パターン（正規表現）
// プロンプト・コマンドに含まれると自動実行禁止
// ─────────────────────────────────────────────────────
const BLOCKED_PROMPT_PATTERNS = [
  /git\s+push\s+--force/i,          // force push
  /git\s+push\s+-f\b/i,             // force push 短縮形
  /git\s+reset\s+--hard/i,          // 破壊的リセット
  /rm\s+-rf/i,                       // 強制削除
  /del\s+\/s\s+\/f/i,               // Windows 強制削除
  /\.env\s*(を|の)?\s*(表示|出力|cat|show|print)/i,  // .env 表示
  /(秘密情報|secret|APIキー|api.?key|token)\s*(を|の)?\s*(表示|出力|show|print)/i,
  /shutdown/i,                       // シャットダウン
  /format\s+[a-z]:/i,               // ドライブフォーマット
];

// ─────────────────────────────────────────────────────
// HUMAN_APPROVAL_REQUIRED パターン
// プロンプトに含まれると人間承認必須
// ─────────────────────────────────────────────────────
const HUMAN_REQUIRED_PROMPT_PATTERNS = [
  /\.env\s*(を|に|の)\s*(変更|編集|update|edit|write|修正)/i,  // .env 変更
  /(秘密情報|APIキー|api.?key|token)\s*(を|に)\s*(変更|設定|登録)/i,
  /(本番|production|prod)\s*(に|へ|の)\s*(反映|デプロイ|deploy|push)/i,
  /PR\s*(を)?\s*(merge|マージ)/i,    // PR マージ
  /bot\s*(を)?\s*(再起動|restart)/i, // Bot 再起動
  /process\s*\.\s*kill/i,            // プロセスkill
  /taskkill/i,                       // Windows プロセスkill
  /kill\s+-9/i,                      // Unix プロセスkill
];

// ─────────────────────────────────────────────────────
// AUTO_SAFE とみなすタスクタイプ
// ─────────────────────────────────────────────────────
const AUTO_SAFE_TYPES = new Set(['DOCS', 'RESEARCH', 'TEST', 'REVIEW']);

// ─────────────────────────────────────────────────────
// AI_REVIEW_REQUIRED とみなすタスクタイプ（デフォルト）
// ─────────────────────────────────────────────────────
const AI_REVIEW_REQUIRED_TYPES = new Set(['IMPLEMENT', 'FIX', 'REFACTOR']);

// ─────────────────────────────────────────────────────
// read-only 操作パターン（AUTO_SAFE 対象）
// ─────────────────────────────────────────────────────
const READONLY_PATTERNS = [
  /\bgit\s+(status|diff|log|show|branch|remote\s+-v|ls-files)\b/i,
  /\bcat\b.*\.(md|txt|json|js|ts)\b/i,
  /\bls\b|\bdir\b/i,
  /read.only/i,
  /(調査|確認|調べ|レポート|report|investigate|check)\s*(のみ|だけ|のみ)?(\s|$)/i,
];

// ─────────────────────────────────────────────────────
// 通常 git push パターン（AUTO_SAFE 対象）
// force push 以外の通常 push
// ─────────────────────────────────────────────────────
const SAFE_PUSH_PATTERN = /\bgit\s+push\s+origin\s+\S+(?!\s*--force)(?!\s*-f\b)/i;

// ─────────────────────────────────────────────────────
// 大量削除パターン（HUMAN_APPROVAL_REQUIRED 対象）
// ─────────────────────────────────────────────────────
const MASS_DELETE_PATTERNS = [
  /delete.*\d{2,}\s*(files?|ファイル)/i,
  /大量.*(削除|delete)/i,
  /DROP\s+TABLE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM.*WHERE\s+1\s*=\s*1/i,
];

// ─────────────────────────────────────────────────────
// _matchesAny — パターン配列の1つでも一致するか
// ─────────────────────────────────────────────────────
function _matchesAny(text, patterns) {
  if (!text || typeof text !== 'string') return false;
  return patterns.some(re => re.test(text));
}

// ─────────────────────────────────────────────────────
// classifyTask(task, context = {}) — Phase E-1 メイン関数
//
// 引数:
//   task    - { id, type, size, prompt, ... }
//   context - {
//               danger:        string,  // '高'|'中'|'低' (事前危険度)
//               codexDanger:   string,  // '高'|'中'|'低' (Codex判定)
//               reviewVerdict: string,  // '問題なし'|'修正推奨'|'却下推奨'
//               command:       string,  // ユーザーが入力したコマンド文字列（任意）
//               securityBlocked: bool,  // security.js が弾いた場合 true
//               changedFiles:  string[], // 変更ファイル一覧（任意）
//             }
//
// 戻り値: AUTO_POLICY 定数のいずれか
// ─────────────────────────────────────────────────────
function classifyTask(task, context = {}) {
  // null / undefined 対応
  if (!task || typeof task !== 'object') task = {};
  if (!context || typeof context !== 'object') context = {};

  const taskType   = String(task.type  || 'IMPLEMENT').toUpperCase();
  const taskSize   = String(task.size  || 'MEDIUM').toUpperCase();
  const prompt     = String(task.prompt || '');
  const command    = String(context.command || '');
  const searchText = prompt + ' ' + command;

  const codexDanger   = context.codexDanger   || context.danger || '';
  const reviewVerdict = context.reviewVerdict  || '';

  // ══════════════════════════════════════════════════
  // 1. BLOCKED チェック（最高優先度）
  // ══════════════════════════════════════════════════

  // security.js が弾いた場合
  if (context.securityBlocked === true) {
    return AUTO_POLICY.BLOCKED;
  }

  // LARGE タスクはサイズ超過停止（セキュリティ停止とは別扱い）
  if (taskSize === 'LARGE') {
    return AUTO_POLICY.LARGE_TASK;
  }

  // 破壊的コマンドパターン
  if (_matchesAny(searchText, BLOCKED_PROMPT_PATTERNS)) {
    return AUTO_POLICY.BLOCKED;
  }

  // ══════════════════════════════════════════════════
  // 2. HUMAN_APPROVAL_REQUIRED チェック
  // ══════════════════════════════════════════════════

  // Codex / AIレビュー 高危険度
  if (codexDanger === '高') {
    return AUTO_POLICY.HUMAN_APPROVAL_REQUIRED;
  }
  if (reviewVerdict === '却下推奨') {
    return AUTO_POLICY.HUMAN_APPROVAL_REQUIRED;
  }
  // 事前危険度判定（assessDanger の結果）
  if (context.danger === '高') {
    return AUTO_POLICY.HUMAN_APPROVAL_REQUIRED;
  }

  // 危険な操作パターン
  if (_matchesAny(searchText, HUMAN_REQUIRED_PROMPT_PATTERNS)) {
    return AUTO_POLICY.HUMAN_APPROVAL_REQUIRED;
  }

  // 大量削除
  if (_matchesAny(searchText, MASS_DELETE_PATTERNS)) {
    return AUTO_POLICY.HUMAN_APPROVAL_REQUIRED;
  }

  // 変更ファイルに機密ファイルが含まれる場合
  const changedFiles = context.changedFiles || [];
  const sensitiveFiles = ['.env', '.key', '.pem', '.cert', '.secret', 'id_rsa', 'credentials'];
  if (changedFiles.some(f => sensitiveFiles.some(s => f.includes(s)))) {
    return AUTO_POLICY.HUMAN_APPROVAL_REQUIRED;
  }

  // ══════════════════════════════════════════════════
  // 3. AUTO_SAFE チェック
  // ══════════════════════════════════════════════════

  // Codex / AIレビューで問題なし
  if (codexDanger === '低') {
    return AUTO_POLICY.AUTO_SAFE;
  }
  if (reviewVerdict === '問題なし') {
    return AUTO_POLICY.AUTO_SAFE;
  }

  // AUTO_SAFE タイプ（DOCS/RESEARCH/TEST/REVIEW）
  if (AUTO_SAFE_TYPES.has(taskType)) {
    return AUTO_POLICY.AUTO_SAFE;
  }

  // SMALL サイズかつ危険条件なし
  if (taskSize === 'SMALL' && !AI_REVIEW_REQUIRED_TYPES.has(taskType)) {
    return AUTO_POLICY.AUTO_SAFE;
  }

  // read-only 操作
  if (_matchesAny(searchText, READONLY_PATTERNS)) {
    return AUTO_POLICY.AUTO_SAFE;
  }

  // 通常 git push（force なし）
  if (SAFE_PUSH_PATTERN.test(searchText)) {
    return AUTO_POLICY.AUTO_SAFE;
  }

  // ══════════════════════════════════════════════════
  // 4. AI_REVIEW_REQUIRED（デフォルト・迷ったらここ）
  // ══════════════════════════════════════════════════

  // Codex 中危険度
  if (codexDanger === '中') {
    return AUTO_POLICY.AI_REVIEW_REQUIRED;
  }
  if (reviewVerdict === '修正推奨') {
    return AUTO_POLICY.AI_REVIEW_REQUIRED;
  }

  // IMPLEMENT / FIX / REFACTOR
  if (AI_REVIEW_REQUIRED_TYPES.has(taskType)) {
    return AUTO_POLICY.AI_REVIEW_REQUIRED;
  }

  // それ以外（判断不能）→ 安全側（AIレビュー必須）
  return AUTO_POLICY.AI_REVIEW_REQUIRED;
}

// ─────────────────────────────────────────────────────
// describePolicy(policy) — Discord 表示用の説明文
// ─────────────────────────────────────────────────────
function describePolicy(policy) {
  switch (policy) {
    case AUTO_POLICY.AUTO_SAFE:
      return '✅ AUTO_SAFE — 自動続行可能';
    case AUTO_POLICY.AI_REVIEW_REQUIRED:
      return '🤖 AI_REVIEW_REQUIRED — AIレビュー後に自動続行';
    case AUTO_POLICY.HUMAN_APPROVAL_REQUIRED:
      return '⚠️ HUMAN_APPROVAL_REQUIRED — 人間の承認が必要';
    case AUTO_POLICY.BLOCKED:
      return '🚫 SECURITY BLOCKED — 安全上停止';
    case AUTO_POLICY.LARGE_TASK:
      return '🔴 LARGE — タスクが大きすぎます';
    default:
      return `❓ UNKNOWN: ${policy}`;
  }
}

// ─────────────────────────────────────────────────────
// UNSAFE_HOLD_KEYWORDS — 保留理由がテスト/ダミー由来であることを示すキーワード
// これらを含む保留タスクは Auto Resume しない
// ─────────────────────────────────────────────────────
const UNSAFE_HOLD_KEYWORDS = [
  'テスト', 'ダミー', 'D4e-test', 'D5-test', 'd7c', 'd8',
  'smoke', '通しテスト', '明示的テスト', '一時保留',
];

// UNSAFE_PROMPT_KEYWORDS — prompt 内容がテスト/ダミー由来であることを示すキーワード
const UNSAFE_PROMPT_KEYWORDS = [
  '[D4e-test]', 'ダミータスク', 'action:none', 'test2',
];

// ─────────────────────────────────────────────────────
// classifyHoldNote(stateNote, prompt) — Phase E-2
//
// 保留理由ノートとプロンプトを確認し、Auto Resume が安全かどうかを返す。
// 戻り値: 'SAFE' | 'UNSAFE'
//
// UNSAFE: テスト/ダミー由来のタスクは Auto Resume しない
// SAFE:   実案件タスクは Auto Resume 候補として扱う
// ─────────────────────────────────────────────────────
function classifyHoldNote(stateNote = '', prompt = '') {
  const noteStr   = String(stateNote || '');
  const promptStr = String(prompt    || '');

  if (UNSAFE_HOLD_KEYWORDS.some(k => noteStr.includes(k)))   return 'UNSAFE';
  if (UNSAFE_PROMPT_KEYWORDS.some(k => promptStr.includes(k))) return 'UNSAFE';

  return 'SAFE';
}

module.exports = {
  AUTO_POLICY,
  classifyTask,
  classifyHoldNote,
  describePolicy,
};
