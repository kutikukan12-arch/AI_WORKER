'use strict';

// =====================================================
// doctor.js - AI_WORKER 診断ツール
//
// 役割:
//   !doctor コマンドで実行する起動診断。
//   設定・環境・ログ・タスク状態を確認し、
//   OK / 注意 / 要対応 + 次にやること1行 で報告する。
//
// 重要ルール:
//   ・管理者（DISCORD_OWNER_ID）のみ実行可能
//   ・Token・チャンネルIDの実値は絶対に表示しない
//   ・ログ本文は表示しない（サイズ・件数のみ）
//   ・プロセス情報の全文は表示しない
//   ・自動修正・削除・install は行わない（診断専用）
//   ・起動時Discord通知は行わない（重大エラー時のみ）
// =====================================================

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT_DIR  = path.join(__dirname, '..', '..');
const LOGS_DIR  = path.join(ROOT_DIR, 'logs');
const DATA_FILE = path.join(ROOT_DIR, 'data', 'tasks.json');

// ─── 判定絵文字 ───
const STATUS_EMOJI = { 'OK': '🟢', '注意': '🟡', '要対応': '🔴' };

// ─────────────────────────────────────────────────────
// 1. .env 設定チェック（値は表示しない）
// ─────────────────────────────────────────────────────
function checkEnvSettings() {
  const required = [
    'DISCORD_TOKEN',
    'ALLOWED_CHANNEL_IDS',
    'DISCORD_OWNER_ID',
  ];
  const optional = [
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'ENABLE_GITHUB',
    'ENABLE_PR',
    'BATCH_ENABLED',
  ];

  const missing = required.filter(k => !process.env[k] || process.env[k].includes('ここに'));
  const optSet  = optional.filter(k => !!process.env[k]).length;

  if (missing.length > 0) {
    return {
      label:  '.env 必須設定',
      status: '要対応',
      detail: `未設定: ${missing.join(', ')}`,
      action: `.env に ${missing[0]} を設定してください`,
    };
  }

  return {
    label:  '.env 必須設定',
    status: 'OK',
    detail: `必須${required.length}件: 設定済み | オプション${optSet}/${optional.length}件: 設定済み`,
    action: '特になし',
  };
}

// ─────────────────────────────────────────────────────
// 2. Claude コマンド確認
//    claude-runner.js と同じ解決ロジックで実際の実行コマンドを表示する
// ─────────────────────────────────────────────────────
function resolveClaudeCommandForDoctor() {
  const { execFileSync: execFile } = require('child_process');
  const fs2 = require('fs');
  const envCmd = process.env.CLAUDE_COMMAND || '';

  if (envCmd && (path.isAbsolute(envCmd) || envCmd.endsWith('.exe'))) return envCmd;

  if (process.platform === 'win32') {
    const searchName = (envCmd && envCmd.endsWith('.cmd')) ? envCmd : 'claude.cmd';
    try {
      const found = execFile('where.exe', [searchName], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
      }).trim().split(/\r?\n/)[0].trim();
      const exePath = path.join(
        path.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
      );
      if (fs2.existsSync(exePath)) return exePath;
    } catch { /* fallback */ }
    return envCmd || 'claude.cmd';
  }
  return envCmd || 'claude';
}

function checkClaudeCommand() {
  const cmd = resolveClaudeCommandForDoctor();
  try {
    // execFileSync は shell を使わず exe を直接呼ぶ（shell:false 相当）
    const { execFileSync: execFile2 } = require('child_process');
    execFile2(cmd, ['--version'], { stdio: 'pipe', timeout: 5000 });
    return {
      label:  'Claude CLI',
      status: 'OK',
      detail: `起動確認済み | コマンド: ${path.basename(cmd)}`,
      action: '特になし',
    };
  } catch {
    return {
      label:  'Claude CLI',
      status: '要対応',
      detail: `未検出 | コマンド: ${cmd}`,
      action: 'npm install -g @anthropic-ai/claude-code を実行してください',
    };
  }
}

// ─────────────────────────────────────────────────────
// 3. Node.js バージョン確認
// ─────────────────────────────────────────────────────
function checkNodeVersion() {
  const ver     = process.versions.node;
  const major   = parseInt(ver.split('.')[0], 10);
  const isOK    = major >= 18;

  return {
    label:  'Node.js',
    status: isOK ? 'OK' : '要対応',
    detail: `v${ver}`,
    action: isOK ? '特になし' : 'Node.js v18 以上へアップグレードしてください',
  };
}

// ─────────────────────────────────────────────────────
// 4. ログファイル状態（本文は表示しない）
// ─────────────────────────────────────────────────────
function checkLogs() {
  if (!fs.existsSync(LOGS_DIR)) {
    return { label: 'ログ', status: 'OK', detail: 'フォルダなし（問題なし）', action: '特になし' };
  }

  const cutoff7  = Date.now() - 7  * 24 * 60 * 60 * 1000;
  const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;

  let totalBytes = 0;
  let oldCount   = 0;
  let veryOld    = 0;

  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
  for (const f of files) {
    const st = fs.statSync(path.join(LOGS_DIR, f));
    totalBytes += st.size;
    if (st.mtimeMs < cutoff7)  oldCount++;
    if (st.mtimeMs < cutoff30) veryOld++;
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  const status  = veryOld > 5 ? '注意' : 'OK';

  return {
    label:  'ログ',
    status,
    detail: `合計 ${totalMB}MB / ${files.length}件 | 7日超: ${oldCount}件`,
    action: status === '注意'
      ? `!batch を実行してログを整理してください（${veryOld}件が30日超）`
      : '特になし',
  };
}

// ─────────────────────────────────────────────────────
// 5. タスク状態
// ─────────────────────────────────────────────────────
function checkTasks() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { label: 'タスク', status: 'OK', detail: 'データなし', action: '特になし' };
    }
    const { tasks } = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const inProgress = tasks.filter(t => t.state === '作業中').length;
    const awaiting   = tasks.filter(t => t.state === '人間確認待ち').length;
    const total      = tasks.length;

    // 24時間以上「作業中」のタスクを検出
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const stuck     = tasks.filter(t =>
      t.state === '作業中' && new Date(t.updatedAt).getTime() < cutoff24h
    ).length;

    const status = awaiting > 0 ? '注意' : stuck > 0 ? '注意' : 'OK';
    const action = awaiting > 0
      ? `${awaiting}件が人間確認待ちです: !task list で確認してください`
      : stuck > 0
      ? `${stuck}件が24時間以上停止中です: !task hold で保留にしてください`
      : '特になし';

    return {
      label:  'タスク',
      status,
      detail: `全${total}件 | 作業中:${inProgress} | 人間確認待ち:${awaiting}`,
      action,
    };
  } catch (e) {
    return { label: 'タスク', status: '注意', detail: 'データ読み込みエラー', action: 'data/tasks.json を確認してください' };
  }
}

// ─────────────────────────────────────────────────────
// 6. workspace 状態
// ─────────────────────────────────────────────────────
function checkWorkspace() {
  const wsDir = path.join(ROOT_DIR, 'workspace');
  if (!fs.existsSync(wsDir)) {
    return { label: 'workspace', status: 'OK', detail: 'フォルダなし（初回起動前）', action: '!claude で最初のタスクを実行してください' };
  }

  const taskDirs = fs.readdirSync(wsDir).filter(d => d.startsWith('task_'));
  const cutoff7  = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const old7     = taskDirs.filter(d => {
    try { return fs.statSync(path.join(wsDir, d)).mtimeMs < cutoff7; } catch { return false; }
  }).length;

  const status = old7 > 20 ? '注意' : 'OK';
  return {
    label:  'workspace',
    status,
    detail: `タスクフォルダ: ${taskDirs.length}件 | 7日超: ${old7}件`,
    action: status === '注意' ? '!batch でアーカイブ整理を実行してください' : '特になし',
  };
}

// ─────────────────────────────────────────────────────
// 7. 通知先チャンネル設定チェック
//
// 引数:
//   notifyChannelInfo - index.js が収集したチャンネル情報
//   { [type]: { id, name, ok, error } }
//
// 検出:
//   ・channelId 未設定
//   ・チャンネル取得失敗
//   ・送信権限なし
//   ・AIレビューとCodexレビューが同じID（重複）
// ─────────────────────────────────────────────────────
const NOTIFY_LABELS = {
  history:    '全タスク履歴',
  aiReview:   'AIレビュー',
  codexReview: 'Codexレビュー',
  error:      'エラー通知',
  meeting:    '会議結果',
  git:        'GitHub',
  pr:         'PR',
};

function checkNotificationChannels(notifyChannelInfo) {
  if (!notifyChannelInfo) {
    return {
      label:  '通知先チャンネル',
      status: '注意',
      detail: '情報なし（!doctor を再実行してください）',
      action: '特になし',
    };
  }

  const lines   = [];
  let hasWarn   = false;
  let hasError  = false;

  for (const [type, info] of Object.entries(notifyChannelInfo)) {
    const label = NOTIFY_LABELS[type] || type;
    if (!info.id) {
      lines.push(`⬜ ${label}: 未設定`);
      hasWarn = true;
    } else if (!info.ok) {
      lines.push(`🔴 ${label}: ${info.name || info.id} — ${info.error}`);
      hasError = true;
    } else {
      lines.push(`🟢 ${label}: ${info.name}`);
    }
  }

  // 重複チェック（AIレビューとCodexレビューが同じIDは特に重要）
  const ai    = notifyChannelInfo.aiReview?.id;
  const codex = notifyChannelInfo.codexReview?.id;
  if (ai && codex && ai === codex) {
    lines.push(`⚠️ 警告: AIレビューとCodexレビューが同じチャンネル（${ai}）`);
    hasWarn = true;
  }

  // 他の重複もチェック
  const ids = Object.values(notifyChannelInfo)
    .map(i => i.id).filter(Boolean);
  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupIds.length > 0 && !(dupIds.length === 1 && dupIds[0] === ai)) {
    lines.push(`⚠️ 重複ID: ${dupIds.join(', ')}`);
    hasWarn = true;
  }

  const status = hasError ? '要対応' : hasWarn ? '注意' : 'OK';
  const action = hasError
    ? '送信失敗チャンネルの権限または .env の channelId を確認してください'
    : hasWarn
    ? '.env の通知先チャンネルIDを確認してください'
    : '特になし';

  return {
    label:  '通知先チャンネル',
    status,
    detail: lines.join('\n　'),
    action,
  };
}

// ─────────────────────────────────────────────────────
// 全診断を実行してテキスト結果を返す
//
// 引数:
//   projectId        - 現在のプロジェクトID
//   notifyChannelInfo - index.js が収集した通知先チャンネル情報（省略可）
// ─────────────────────────────────────────────────────
function runDiagnostics(projectId = 'default', notifyChannelInfo = null) {
  const checks = [
    checkEnvSettings(),
    checkClaudeCommand(),
    checkNodeVersion(),
    checkLogs(),
    checkTasks(),
    checkWorkspace(),
    checkNotificationChannels(notifyChannelInfo),
  ];

  const hasError = checks.some(c => c.status === '要対応');
  const hasWarn  = checks.some(c => c.status === '注意');
  const overall  = hasError ? '🔴 要対応あり' : hasWarn ? '🟡 注意あり' : '🟢 すべてOK';

  // Discord 向けテキストを組み立て（短文・スマホ対応）
  const lines = [
    `🩺 **AI_WORKER 診断結果** — ${overall}`,
    `現在Project: ${projectId}`,
    ``,
  ];

  for (const c of checks) {
    const emoji = STATUS_EMOJI[c.status] || '❓';
    lines.push(`${emoji} **${c.label}** | ${c.status}`);
    lines.push(`　${c.detail}`);
    if (c.action !== '特になし') {
      lines.push(`　→ **${c.action}**`);
    }
    lines.push('');
  }

  lines.push(`> ⚠️ 自動修正は行いません。上記を参考に手動で対応してください。`);

  logger.info(`!doctor 実行 | 結果: ${overall}`);
  return lines.join('\n');
}

module.exports = { runDiagnostics };
