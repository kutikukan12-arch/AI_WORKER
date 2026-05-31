'use strict';

// =====================================================
// completion-validator.js - タスク完了バリデーター
//
// 役割:
//   Claude Code 実行後、「本当にコード変更が発生したか」を
//   多角的に検証する。変更なしの場合は完了扱いを阻止する。
//
// チェック内容（優先順位順・全て実行）:
//   1. changedFiles / mtime で変更ファイル検出
//   2. 変更ありなら構文チェックして完了OK
//   3. 変更なしのとき以下を全てチェック:
//      a. handoff検出（「次担当」「コピペ用依頼文」等）
//      b. 会話応答検出（「教えてください」「了解しました」等）[Fix2]
//      c. 短文検出（100文字未満）                          [Fix3]
//      d. 質問文検出（「？」「ですか」で終わる）           [Fix4]
//      e. git未使用でも変更0件 → 未完了                   [Fix1]
//
// 判定方針:
//   変更あり  → 完了OK（構文エラーは警告のみ）
//   変更なし  → 上記a〜eのいずれかで未完了
//
// 戻り値:
//   {
//     ok: boolean,
//     reason: string,
//     changedFiles: string[],
//     modifiedFiles: { file, mtimeMs }[],
//     diffStat: string,
//     addedLines: number, removedLines: number,
//     syntaxOk: boolean, syntaxErrors: [],
//     isHandoffOnly: boolean,
//     isConversational: boolean,    // 会話応答検出フラグ
//     isShortResponse: boolean,     // 短文検出フラグ
//     isQuestionEnding: boolean,    // 質問文検出フラグ
//     conversationalReason: string, // 検出したパターン説明
//     summary: string,
//   }
//
// 禁止:
//   ・自動修正（診断のみ）
//   ・ログファイル本文の表示
//   ・Token / 認証情報の表示
// =====================================================

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

// ─────────────────────────────────────────────────────
// handoff出力を示すパターン
// ─────────────────────────────────────────────────────
const HANDOFF_ONLY_PATTERNS = [
  /次担当[^\n]{0,20}[\r\n]/,
  /コピペ用依頼文/,
  /続きを実装してください/,
  /以下の続きを実装/,
  /以下の実装について設計/,
  /以下のコードをレビュー/,
  /実装が完了し.*次フェーズ/,
  /handoff/i,
];

// ─────────────────────────────────────────────────────
// 会話応答を示すパターン [Fix2]
// 変更0件のときに検出 → 未完了
// ─────────────────────────────────────────────────────
const CONVERSATIONAL_PATTERNS = [
  { re: /続きを教えてください/,      label: '「続きを教えてください」' },
  { re: /教えてください/,            label: '「教えてください」' },
  { re: /どんな問題/,               label: '「どんな問題」' },
  { re: /詳細をください/,            label: '「詳細をください」' },
  { re: /詳しく教えて/,             label: '「詳しく教えて」' },
  { re: /何が起きています/,          label: '「何が起きていますか」' },
  { re: /どのような問題/,            label: '「どのような問題」' },
  { re: /もう少し情報/,             label: '「もう少し情報が必要」' },
  { re: /情報が必要/,               label: '「情報が必要」' },
  { re: /確認します/,               label: '「確認します」' },
  { re: /了解しました/,             label: '「了解しました」' },
  { re: /了解です/,                 label: '「了解です」' },
  { re: /承知しました/,             label: '「承知しました」' },
  { re: /承知です/,                 label: '「承知です」' },
  { re: /ご確認ください/,            label: '「ご確認ください」' },
  { re: /何をしたいですか/,          label: '「何をしたいですか」' },
  { re: /どうなっています/,          label: '「どうなっていますか」' },
];

// ─────────────────────────────────────────────────────
// 実装完了を示す積極的シグナル
// 変更0件でも、これらが含まれていれば会話応答と判定しない
// ─────────────────────────────────────────────────────
const IMPLEMENTATION_SIGNALS = [
  /追加しました/,
  /変更しました/,
  /修正しました/,
  /作成しました/,
  /保存しました/,
  /書き込みました/,
  /更新しました/,
  /実装しました/,
  /\.js.*編集/,
  /編集.*\.js/,
  /Edit\(|Write\(|Bash\(/,
  /✅.*完了/,
  /function\s+\w+\s*\(/,
  /module\.exports/,
];

// ─────────────────────────────────────────────────────
// Git診断結果を示すパターン
// OPS タスクでコード変更0件でも完了とみなすための証拠
// ─────────────────────────────────────────────────────
const GIT_DIAGNOSTIC_PATTERNS = [
  /On branch\s+\S+/,
  /HEAD detached at/i,
  /nothing to commit/i,
  /Changes not staged for commit/i,
  /Changes to be committed/i,
  /Your branch is (?:up to date|ahead|behind)/i,
  /Everything up-to-date/i,
  /remote:\s+\S/,
  /fatal:.*(?:not a git|repository)/i,
  /error:.*failed to push/i,
  /\[(?:master|main|develop|HEAD)[^\]]*\]/,
  /push.*(?:success|reject|denied|error)/i,
];

// ─────────────────────────────────────────────────────
// reports/research_*.md または reviews/result_*.md の
// タスク開始後の生成を確認する
// ─────────────────────────────────────────────────────
function findRecentlyCreatedReport(repoPath, sinceMs) {
  const checks = [
    { dir: path.join(repoPath, 'reports'), re: /^research_.*\.(md|txt|json)$/ },
    { dir: path.join(repoPath, 'reviews'), re: /^result_.*\.(md|txt|json)$/ },
  ];
  for (const { dir, re } of checks) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!re.test(f)) continue;
        if (fs.statSync(path.join(dir, f)).mtimeMs >= sinceMs) return f;
      }
    } catch { /* dir が存在しない場合はスキップ */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────
// git diff --name-only で変更ファイルを取得
// ─────────────────────────────────────────────────────
function getChangedFilesFromGit(repoPath) {
  try {
    const output = execSync('git diff --name-only HEAD', {
      cwd:      repoPath,
      encoding: 'utf8',
      timeout:  10000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];
    return output.split('\n').map(f => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────
// git diff --stat で追加/削除行数を取得
// ─────────────────────────────────────────────────────
function getDiffStat(repoPath) {
  try {
    const output = execSync('git diff --stat HEAD', {
      cwd:      repoPath,
      encoding: 'utf8',
      timeout:  10000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    }).trim();

    const lastLine     = output.split('\n').pop() || '';
    const addMatch     = lastLine.match(/(\d+) insertion/);
    const delMatch     = lastLine.match(/(\d+) deletion/);
    const addedLines   = addMatch ? parseInt(addMatch[1], 10) : 0;
    const removedLines = delMatch ? parseInt(delMatch[1], 10) : 0;

    return { raw: output.slice(0, 400), diffStat: `+${addedLines} -${removedLines}`, addedLines, removedLines };
  } catch {
    return { raw: '', diffStat: '+0 -0', addedLines: 0, removedLines: 0 };
  }
}

// ─────────────────────────────────────────────────────
// node --check で構文チェック（.js ファイルのみ）
// ─────────────────────────────────────────────────────
function checkSyntaxOfChangedFiles(changedFiles, repoPath) {
  const jsFiles = changedFiles.filter(f => f.endsWith('.js'));
  const errors  = [];

  for (const f of jsFiles.slice(0, 10)) {
    const absPath = path.join(repoPath, f);
    if (!fs.existsSync(absPath)) continue;

    try {
      execSync(`node --check "${absPath}"`, { stdio: 'pipe', timeout: 8000, shell: true });
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message || '').slice(0, 200);
      errors.push({ file: f, error: msg });
      logger.warn(`構文エラー: ${f} — ${msg.slice(0, 80)}`);
    }
  }

  return { syntaxOk: errors.length === 0, syntaxErrors: errors };
}

// ─────────────────────────────────────────────────────
// mtime でプロジェクトファイルの変更を検出（git不使用環境向け）
// ─────────────────────────────────────────────────────
function findRecentlyModified(
  projectRoot,
  sinceMs,
  extensions = ['.js'],
  excludeDirs = ['node_modules', 'workspace', '.git', 'data', 'reviews', 'logs'],
) {
  const results = [];

  function walk(dir, depth = 0) {
    if (depth > 5) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (excludeDirs.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs >= sinceMs) {
              results.push({
                file:    path.relative(projectRoot, fullPath).replace(/\\/g, '/'),
                mtimeMs: stat.mtimeMs,
              });
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  walk(projectRoot);
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─────────────────────────────────────────────────────
// handoff出力判定
// ─────────────────────────────────────────────────────
function detectHandoffOnly(output, changedFiles, modifiedFiles = []) {
  if (changedFiles.length > 0 || modifiedFiles.length > 0) return false;
  if (!output || output.length < 10) return true;

  // 実装シグナルがあれば handoff ではない
  if (IMPLEMENTATION_SIGNALS.some(re => re.test(output))) return false;

  const matched = HANDOFF_ONLY_PATTERNS.filter(re => re.test(output));
  return matched.length >= 2;
}

// ─────────────────────────────────────────────────────
// 会話応答判定 [Fix2]
// 変更0件のとき、会話パターンが1つ以上あれば未完了
// ただし実装シグナルがあれば覆す
// ─────────────────────────────────────────────────────
function detectConversational(output) {
  if (!output || output.length < 3) return { detected: false, label: '' };

  // 実装シグナルがあれば会話ではない
  if (IMPLEMENTATION_SIGNALS.some(re => re.test(output))) {
    return { detected: false, label: '' };
  }

  const matched = CONVERSATIONAL_PATTERNS.filter(({ re }) => re.test(output));
  if (matched.length === 0) return { detected: false, label: '' };

  return {
    detected: true,
    label:    matched.map(m => m.label).slice(0, 3).join(' / '),
  };
}

// ─────────────────────────────────────────────────────
// 短文応答判定 [Fix3]
// 100文字未満 かつ 実装シグナルなし
// ─────────────────────────────────────────────────────
function detectShortResponse(output) {
  const trimmed = (output || '').trim();
  if (trimmed.length === 0) return true; // 空
  if (trimmed.length >= 100) return false;
  // 短くても実装シグナルがあればOK
  if (IMPLEMENTATION_SIGNALS.some(re => re.test(trimmed))) return false;
  return true;
}

// ─────────────────────────────────────────────────────
// 質問文終了判定 [Fix4]
// 「？」「?」「ですか」「ますか」で終わる
// ─────────────────────────────────────────────────────
function detectQuestionEnding(output) {
  const trimmed = (output || '').trim();
  return (
    /[？?]\s*$/.test(trimmed) ||
    /ですか[。\s]*$/.test(trimmed) ||
    /ますか[。\s]*$/.test(trimmed) ||
    /でしょうか[。\s]*$/.test(trimmed)
  );
}

// ─────────────────────────────────────────────────────
// Discord 表示用サマリー生成 [Fix5]
// 未完了時: 変更件数・会話検出・handoff検出を表示
// ─────────────────────────────────────────────────────
function buildValidationSummary(result) {
  const statusEmoji = result.ok ? '🟢' : '🔴';
  const statusLabel = result.ok ? '完了OK' : '未完了';
  const typeLabel   = result.taskType ? ` [${result.taskType}]` : '';

  const lines = [`${statusEmoji} **完了バリデーション: ${statusLabel}${typeLabel}**`];

  // 変更ファイル情報
  if (result.modifiedFiles && result.modifiedFiles.length > 0) {
    const list = result.modifiedFiles.slice(0, 3).map(f => f.file).join(', ');
    const more = result.modifiedFiles.length > 3 ? ` …他${result.modifiedFiles.length - 3}件` : '';
    lines.push(`更新ファイル(mtime): ${list}${more}`);
  } else if (result.changedFiles.length > 0) {
    const list = result.changedFiles.slice(0, 3).join(', ');
    const more = result.changedFiles.length > 3 ? ` …他${result.changedFiles.length - 3}件` : '';
    lines.push(`変更ファイル(git): ${list}${more}`);
  } else {
    lines.push(`変更ファイル: 0件 | diff: ${result.diffStat}`);
  }

  // 未完了の検出内容 [Fix5]
  if (!result.ok) {
    if (result.isHandoffOnly) {
      lines.push(`🔴 handoff検出: 「次担当」「コピペ用依頼文」等を検出`);
    }
    if (result.isConversational) {
      lines.push(`🔴 会話応答検出: ${result.conversationalReason}`);
    }
    if (result.isShortResponse) {
      lines.push(`🔴 短文検出: 出力${(result._outputLength || 0)}文字（100文字未満）`);
    }
    if (result.isQuestionEnding) {
      lines.push(`🔴 質問文検出: 「？」「ですか」等で終了`);
    }
    lines.push(`💡 対処: \`!claude ${result.suggestedTaskId || 'task_xxx'} 続行して実装してください\``);
  } else if (!result.syntaxOk && result.syntaxErrors.length > 0) {
    lines.push(`⚠️ 構文エラー: ${result.syntaxErrors.map(e => e.file).join(', ')}`);
  } else {
    lines.push(`🟢 構文チェック: OK`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// RESEARCH / DESIGN / REVIEW 向け: 出力内容があるか確認
// 実装不要タイプはコード変更なしでOK。
// ただし以下なら未完了:
//   - 出力が200文字未満（調査結果として短すぎる）
//   - 会話応答パターン（「教えてください」等）
//   - 質問文で終わる
// ─────────────────────────────────────────────────────
const NON_IMPLEMENT_MIN_LENGTH = 200; // 調査/設計/レビュー結果の最低文字数
const NON_CODE_CHANGE_TYPES = new Set(['RESEARCH', 'DESIGN', 'REVIEW', 'DOCS', 'OPS']);
const CODE_CHANGE_REQUIRED_TYPES = new Set(['IMPLEMENT', 'FIX', 'REFACTOR']);
const OPS_PROMPT_PATTERNS = [
  /\bpush\b/i,
  /\bstatus\b/i,
  /\u8a3a\u65ad/, // 診断
  /\u78ba\u8a8d/, // 確認
  /\u8abf\u67fb/, // 調査
  /送信/,  // 送信（GitHub送信確認 等）
];

function isOperationLikePrompt(prompt = '') {
  return OPS_PROMPT_PATTERNS.some(re => re.test(prompt || ''));
}

function findTaskOutputArtifact(repoPath, taskId, sinceMs) {
  if (!repoPath || !taskId) return null;
  const workspaceRoot = path.join(repoPath, 'workspace');
  const names = new Set(['result.md', 'output.md', 'log.md']);

  function inspectTaskDir(dir) {
    try {
      for (const name of names) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const stat = fs.statSync(file);
        if (!sinceMs || stat.mtimeMs >= sinceMs) return file;
      }
    } catch { /* ignore */ }
    return null;
  }

  const direct = inspectTaskDir(path.join(workspaceRoot, taskId));
  if (direct) return direct;

  try {
    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = inspectTaskDir(path.join(workspaceRoot, entry.name, taskId));
      if (found) return found;
    }
  } catch { /* workspace がない場合は証拠なし */ }

  return null;
}

function allowsNoCodeChange(taskType, prompt = '') {
  const normalizedType = String(taskType || 'IMPLEMENT').toUpperCase();
  if (NON_CODE_CHANGE_TYPES.has(normalizedType)) return true;
  // OPS キーワードは task.type に関係なく最優先（IMPLEMENT/FIX/REFACTOR でも上書き）
  if (isOperationLikePrompt(prompt)) return true;
  if (CODE_CHANGE_REQUIRED_TYPES.has(normalizedType)) return false;
  return false;
}

function validateNonImplement(output, taskType) {
  const outputLength = (output || '').trim().length;

  // 出力なし / 極端に短い
  if (outputLength < NON_IMPLEMENT_MIN_LENGTH) {
    return {
      ok:     false,
      reason: `${taskType}タスク: 出力が短すぎます（${outputLength}文字 / 最低${NON_IMPLEMENT_MIN_LENGTH}文字必要）`,
    };
  }

  // 会話応答パターン（「教えてください」等）は NG
  const conv = detectConversational(output);
  if (conv.detected) {
    return {
      ok:     false,
      reason: `${taskType}タスク: 会話応答のみ — ${conv.label}`,
    };
  }

  // 質問文で終わる
  if (detectQuestionEnding(output)) {
    return {
      ok:     false,
      reason: `${taskType}タスク: 質問文で終了（調査・設計結果ではない）`,
    };
  }

  return { ok: true, reason: `${taskType}完了（出力${outputLength}文字）` };
}

// ─────────────────────────────────────────────────────
// メイン: 全バリデーションを実行
//
// 引数:
//   output      - Claude Code の出力テキスト
//   repoPath    - プロジェクトルートのパス
//   taskId      - タスクID（サジェスト用）
//   passedFiles - 既に取得済みの changedFiles（省略可）
//   beforeMs    - タスク開始時刻（ミリ秒）。mtime比較用
//   taskType    - 'IMPLEMENT'|'RESEARCH'|'DESIGN'|'REVIEW'|'OPS'（省略時 IMPLEMENT）
// ─────────────────────────────────────────────────────
function validate(output, repoPath, taskId = '', passedFiles = null, beforeMs = null, taskType = 'IMPLEMENT', prompt = '') {
  const normalizedTaskType = String(taskType || 'IMPLEMENT').toUpperCase();
  logger.info(`完了バリデーション開始: ${taskId} [${taskType}]`);

  // ── 1. 変更検出（IMPLEMENT以外でも参考情報として取得）──
  // DOCS タイプは .md / .txt も変更対象に含める
  const DOCS_SCAN_EXTENSIONS = ['.js', '.md', '.txt', '.json'];
  const scanExtensions = (normalizedTaskType === 'DOCS') ? DOCS_SCAN_EXTENSIONS : ['.js'];

  const changedFiles   = passedFiles ?? getChangedFilesFromGit(repoPath);
  const { diffStat, addedLines, removedLines, raw: diffRaw } = getDiffStat(repoPath);
  const sinceMs        = beforeMs ?? (Date.now() - 60 * 1000);
  const modifiedFiles  = findRecentlyModified(repoPath, sinceMs, scanExtensions);
  const hasAnyChanges  = changedFiles.length > 0 || modifiedFiles.length > 0 || addedLines > 0;
  const operationLike  = isOperationLikePrompt(prompt);
  const outputArtifact = operationLike ? findTaskOutputArtifact(repoPath, taskId, sinceMs) : null;

  // ── 2. 構文チェック（変更があった .js のみ）──
  const allChangedFiles = [...changedFiles, ...modifiedFiles.map(f => f.file)];
  const { syntaxOk, syntaxErrors } = checkSyntaxOfChangedFiles(allChangedFiles, repoPath);

  const outputLength = (output || '').trim().length;

  // ── 3. TaskType 別判定 ──
  let ok, reason;
  let isHandoffOnly    = false;
  let isConversational = false;
  let conversationalReason = '';
  let isShortResponse  = false;
  let isQuestionEnding = false;

  if (allowsNoCodeChange(normalizedTaskType, prompt)) {
    // ── 非IMPLEMENTタイプ: コード変更なしでOK、出力内容で判定 ──
    // DOCS: .md ファイルの作成・更新でも完了OK。出力内容チェックで判定。
    // OPS キーワード（診断/確認/push/status/調査）を含む場合: 会話応答ログがあれば完了
    if (operationLike) {
      // 会話応答ログが取れなくてもプロセス正常終了で完了扱い
      ok     = true;
      reason = outputLength > 0
        ? `OPSタスク完了（会話応答ログ${outputLength}文字）`
        : outputArtifact
          ? `OPSタスク完了（出力ファイルあり: ${path.basename(outputArtifact)}）`
          : 'OPSタスク完了（Claude正常終了）';
    } else {
      const nonImplResult = validateNonImplement(output, normalizedTaskType);
      ok     = nonImplResult.ok;
      reason = nonImplResult.reason;
    }

    // 詳細フラグも設定（Embed表示用）
    const conv = detectConversational(output);
    isConversational   = conv.detected;
    conversationalReason = conv.label;
    isShortResponse    = outputLength < NON_IMPLEMENT_MIN_LENGTH;
    isQuestionEnding   = detectQuestionEnding(output);
  } else {
    // ── IMPLEMENT タイプ: 変更あり必須 ──
    isHandoffOnly      = detectHandoffOnly(output, changedFiles, modifiedFiles);
    const conv         = detectConversational(output);
    isConversational   = conv.detected;
    conversationalReason = conv.label;
    isShortResponse    = !hasAnyChanges && detectShortResponse(output);
    isQuestionEnding   = !hasAnyChanges && detectQuestionEnding(output);

    if (hasAnyChanges) {
      ok = true;
      if (!syntaxOk) {
        reason = `変更あり（構文エラー注意: ${syntaxErrors.map(e => e.file).join(', ')}）`;
      } else {
        const src = modifiedFiles.length > 0
          ? `mtime:${modifiedFiles.length}件`
          : `git:${changedFiles.length}件`;
        reason = `変更あり（${src} | ${diffStat}）`;
      }
    } else {
      ok = false;
      if (isHandoffOnly) {
        reason = 'handoffテキストのみ（「次担当」「コピペ用依頼文」等を検出）';
      } else if (isConversational) {
        reason = `会話応答のみ — ${conversationalReason}`;
      } else if (isShortResponse) {
        reason = `短文応答（${outputLength}文字）かつ変更0件`;
      } else if (isQuestionEnding) {
        reason = '質問文で終了かつ変更0件';
      } else {
        reason = 'mtime/git変更0件 — 実装された形跡なし';
      }
    }
  }

  const result = {
    ok,
    reason,
    taskType: normalizedTaskType,
    changedFiles,
    modifiedFiles,
    diffStat,
    addedLines,
    removedLines,
    diffRaw,
    syntaxOk,
    syntaxErrors,
    isHandoffOnly,
    isConversational,
    conversationalReason,
    isShortResponse,
    isQuestionEnding,
    suggestedTaskId: taskId,
    _outputLength:   outputLength,
    summary: '',
  };

  result.summary = buildValidationSummary(result);

  logger.info(
    `完了バリデーション: ${ok ? 'OK' : 'NG'} [${taskType}] | ` +
    `git:${changedFiles.length}件 mtime:${modifiedFiles.length}件 | ` +
    `diff:${diffStat} | ` +
    `handoff:${isHandoffOnly} conv:${isConversational} short:${isShortResponse} q:${isQuestionEnding}`
  );

  return result;
}

module.exports = {
  validate,
  allowsNoCodeChange,
  isOperationLikePrompt,
  getChangedFilesFromGit,
  getDiffStat,
  checkSyntaxOfChangedFiles,
  detectHandoffOnly,
  detectConversational,
  detectShortResponse,
  detectQuestionEnding,
  findRecentlyModified,
};
