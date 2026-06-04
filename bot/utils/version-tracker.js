'use strict';
// =====================================================
// version-tracker.js — Version & Update Tracker (Phase1+2)
//
// 目的:
//   Bot / Desktop Operator のコミットバージョン差異を検出し、
//   更新が必要な場合に黒川へ通知する。
//
// Phase1: バージョン状態管理
// Phase2: 更新検出・黒川通知
//
// 役割分担:
//   宮城: 更新作業担当
//   黒川: 状態監視担当
//   CEO:  プロセス管理しない
// =====================================================

const fs   = require('fs');
const path = require('path');

const ROOT_DIR      = path.join(__dirname, '..', '..');
const DATA_DIR      = path.join(ROOT_DIR, 'data');
const VERSION_FILE  = path.join(DATA_DIR, 'version-state.json');

// ─────────────────────────────────────────────────────
// Git ユーティリティ
//
// M-1 対応: execSync のシェル補間を廃止し execFileSync を使用。
// commit hash は /^[0-9a-f]{7,40}$/ で検証して
// シェルインジェクションを防止する。
// ─────────────────────────────────────────────────────

// commit hash 検証（M-1: インジェクション防止）
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;

function _validateCommit(hash) {
  if (!hash || !COMMIT_HASH_RE.test(hash)) return null;
  return hash;
}

function getHeadCommit() {
  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT_DIR, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return _validateCommit(raw);
  } catch { return null; }
}

function getLatestCommit() {
  // リモートブランチの最新（git fetch 済みが前提）
  // M-1: shell: true を廃止し execFileSync を使用
  try {
    const { execFileSync } = require('child_process');
    // origin/main を先に試み、失敗したら HEAD を使う
    let raw = null;
    try {
      raw = execFileSync('git', ['rev-parse', '--short', 'origin/main'], {
        cwd: ROOT_DIR, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      raw = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: ROOT_DIR, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }
    return _validateCommit(raw);
  } catch { return getHeadCommit(); }
}

function getChangedFilesSince(commit) {
  if (!commit) return [];
  // M-1: commit hash を検証してから execFileSync で渡す（シェル補間なし）
  const safeCommit = _validateCommit(commit);
  if (!safeCommit) return []; // 不正な hash は拒否
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['diff', '--name-only', `${safeCommit}..HEAD`], {
      cwd: ROOT_DIR, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _loadState() {
  try {
    if (!fs.existsSync(VERSION_FILE)) return _emptyState();
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch { return _emptyState(); }
}

function _saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = VERSION_FILE + '.tmp';
  state.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, VERSION_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function _emptyState() {
  return {
    bot:      { startupCommit: null, startedAt: null, pid: null },
    operator: { startupCommit: null, startedAt: null, pid: null },
    updatedAt: null,
  };
}

// ─────────────────────────────────────────────────────
// Phase1: 起動時にバージョン記録
// ─────────────────────────────────────────────────────
function recordBotStartup() {
  const state = _loadState();
  state.bot = {
    startupCommit: getHeadCommit(),
    startedAt:     new Date().toISOString(),
    pid:           process.pid,
  };
  _saveState(state);
}

function recordOperatorStartup(pid) {
  const state = _loadState();
  state.operator = {
    startupCommit: getHeadCommit(),
    startedAt:     new Date().toISOString(),
    pid:           pid || null,
  };
  _saveState(state);
}

// ─────────────────────────────────────────────────────
// Phase2: 更新検出
// ─────────────────────────────────────────────────────
function detectUpdates() {
  const state   = _loadState();
  const current = getHeadCommit();
  const latest  = getLatestCommit();

  const botOutdated = state.bot?.startupCommit && state.bot.startupCommit !== current;
  const opOutdated  = state.operator?.startupCommit && state.operator.startupCommit !== current;
  const hasNewCommit= current !== latest;

  // Phase4: 変更ファイルから再起動が必要か判定
  const changedFiles = botOutdated ? getChangedFilesSince(state.bot.startupCommit) : [];
  const restartPolicy = _analyzeRestartPolicy(changedFiles);

  return {
    currentCommit:    current,
    latestCommit:     latest,
    botOutdated,
    operatorOutdated: opOutdated,
    hasNewCommit,
    changedFiles,
    restartPolicy,
    botStartupCommit: state.bot?.startupCommit,
    opStartupCommit:  state.operator?.startupCommit,
  };
}

// ─────────────────────────────────────────────────────
// Phase4: Auto Restart Policy
// 変更ファイルリストから再起動が必要かを判定
// ─────────────────────────────────────────────────────
function _analyzeRestartPolicy(changedFiles) {
  if (!changedFiles.length) return { botRestart: false, operatorRestart: false, needsConfirm: false };

  const needsBotRestart      = changedFiles.some(f => f.startsWith('bot/') || f === 'package.json');
  const needsOperatorRestart = changedFiles.some(f =>
    f.startsWith('scripts/desktop-operator') || f === 'package.json'
  );
  const isDocsOnly = changedFiles.every(f =>
    f.startsWith('docs/') || f.endsWith('.md') || f.startsWith('tests/')
  );
  const needsConfirm = changedFiles.includes('package.json');

  return {
    botRestart:      needsBotRestart && !isDocsOnly,
    operatorRestart: needsOperatorRestart && !isDocsOnly,
    docsOnly:        isDocsOnly,
    needsConfirm,
    summary: _buildPolicySummary(changedFiles, needsBotRestart, needsOperatorRestart, isDocsOnly, needsConfirm),
  };
}

function _buildPolicySummary(files, botR, opR, docsOnly, confirm) {
  if (docsOnly) return 'docs/tests 変更のみ → 再起動不要';
  const parts = [];
  if (botR)   parts.push('Bot 再起動推奨');
  if (opR)    parts.push('Operator 再起動推奨');
  if (confirm)parts.push('package.json 変更: 要確認');
  return parts.join(' / ') || '変更あり（再起動判断: 宮城）';
}

// ─────────────────────────────────────────────────────
// Phase1: !system status 用フォーマット
// ─────────────────────────────────────────────────────
function formatSystemStatus() {
  const now    = new Date().toLocaleString('ja-JP');
  const update = detectUpdates();
  const state  = _loadState();

  const botStatus = update.botOutdated ? '⚠️ 更新あり' : '✅ 最新';
  const opStatus  = update.operatorOutdated ? '⚠️ 更新あり' : (state.operator?.startupCommit ? '✅ 最新' : '⭕ 未起動');

  const lines = [
    `🔄 **System Status**`,
    `確認時刻: ${now}`,
    ``,
    `**🤖 Bot**`,
    `  起動コミット: \`${state.bot?.startupCommit || '—'}\``,
    `  現在最新: \`${update.currentCommit || '—'}\``,
    `  状態: ${botStatus}`,
    `  起動時刻: ${state.bot?.startedAt ? new Date(state.bot.startedAt).toLocaleString('ja-JP') : '—'}`,
    `  PID: ${state.bot?.pid || '—'}`,
    ``,
    `**🅶 Desktop Operator**`,
    `  起動コミット: \`${state.operator?.startupCommit || '—'}\``,
    `  現在最新: \`${update.currentCommit || '—'}\``,
    `  状態: ${opStatus}`,
    `  起動時刻: ${state.operator?.startedAt ? new Date(state.operator.startedAt).toLocaleString('ja-JP') : '—'}`,
    `  PID: ${state.operator?.pid || '—'}`,
    ``,
  ];

  if (update.botOutdated || update.operatorOutdated) {
    lines.push(`**⚠️ 更新が必要なコンポーネント:**`);
    if (update.restartPolicy?.summary) lines.push(`  ${update.restartPolicy.summary}`);
    if (update.botOutdated)  lines.push(`  → Bot: \`!system restart bot\` を実行してください`);
    if (update.operatorOutdated) lines.push(`  → Operator: \`!system restart operator\` を実行してください`);
    lines.push('');
  }

  lines.push(`> \`!system restart bot\` / \`!system restart operator\` / \`!system restart all\``);
  return { ok: true, text: lines.join('\n').trimEnd() };
}

// ─────────────────────────────────────────────────────
// Phase2: 更新検出後の黒川通知文
// ─────────────────────────────────────────────────────
function buildUpdateNotification(update) {
  const parts = [];
  if (update.botOutdated)      parts.push('Bot');
  if (update.operatorOutdated) parts.push('Desktop Operator');
  if (!parts.length) return null;

  return [
    `【システム更新通知】`,
    ``,
    `以下のコンポーネントに更新があります:`,
    ...parts.map(p => `• ${p}`),
    ``,
    `対応: \`!system status\` で確認し、\`!system restart <component>\` で再起動してください。`,
    `担当: 宮城 Lead Engineer`,
  ].join('\n');
}

module.exports = {
  recordBotStartup,
  recordOperatorStartup,
  detectUpdates,
  formatSystemStatus,
  buildUpdateNotification,
  getHeadCommit,
  getChangedFilesSince,  // M-1 テスト用にエクスポート
  VERSION_FILE,
};
