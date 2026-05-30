'use strict';

// =====================================================
// review-history.js - AIレビュー履歴 集中管理
//
// 役割:
//   すべてのAIレビュー・人間確認・フィードバック適用を
//   一カ所に記録する。後から「何がいつ起きたか」を
//   人間が追えるようにする。
//
// 保存先:
//   reviews/history.md            ← 全タスク共通の時系列ログ
//   reviews/history/task_ID.md    ← タスクごとの詳細ログ
//
// 記録対象:
//   - Claude Code 実行
//   - AI レビュー（Phase2）
//   - Codex 依頼・回答
//   - フィードバック適用（Phase3）
//   - PR 作成
//   - 人間確認
//   - 却下・修正理由
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const REVIEWS_PATH  = path.join(__dirname, '..', '..', 'reviews');
const HISTORY_FILE  = path.join(REVIEWS_PATH, 'history.md');
const HISTORY_DIR   = path.join(REVIEWS_PATH, 'history');

// ─────────────────────────────────────────────────────
// イベント種別の定義
// ─────────────────────────────────────────────────────
const EVENT_TYPES = {
  CLAUDE_RUN:       'Claude Code 実行',
  AI_REVIEW:        'AI レビュー',
  CODEX_REQUEST:    'Codex 依頼生成',
  CODEX_RESPONSE:   'Codex 回答取得',
  FEEDBACK_APPLY:   'フィードバック適用',
  PR_CREATED:       'PR 作成',
  HUMAN_CONFIRM:    '人間確認',
  HUMAN_MENTION:    '人間メンション',
  REJECTION:        '却下',
  MODIFICATION:     '修正実施',
  GITHUB_PUSH:      'GitHub Push',
  ERROR:            'エラー',
};

// 判定・結果に応じた絵文字
const VERDICT_EMOJI = {
  '問題なし':  '🟢',
  '修正推奨':  '🟡',
  '却下推奨':  '🔴',
  'PR作成':    '🔗',
  '適用済み':  '✅',
  'スキップ':  '⭕',
  'Push済み':  '📤',
  'エラー':    '❌',
  '確認依頼':  '❓',
};

// ─────────────────────────────────────────────────────
// 共通タイムライン（history.md）を初期化
// ─────────────────────────────────────────────────────
function ensureHistoryFile() {
  [REVIEWS_PATH, HISTORY_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, [
      '# AI_WORKER 全レビュー履歴',
      '',
      '> このファイルは自動更新されます。AI 作業の全記録です。',
      '',
      '| 日時 | 種別 | タスクID | 判定 | 概要 |',
      '|------|------|---------|------|------|',
      '',
    ].join('\n'), 'utf8');
    logger.debug('history.md を初期化しました');
  }
}

// ─────────────────────────────────────────────────────
// 履歴エントリを追加
//
// 引数:
//   eventType - EVENT_TYPES の値
//   taskId    - タスクID（例: task_1748344800000）
//   verdict   - 判定結果（例: '問題なし', '修正推奨', 'PR作成'）
//   summary   - 1行の概要（80文字以内推奨）
//   detail    - 詳細（タスク別ログにのみ記録、省略可）
// ─────────────────────────────────────────────────────
function addEntry(eventType, taskId, verdict, summary, detail = '') {
  ensureHistoryFile();

  const timestamp  = new Date().toLocaleString('ja-JP');
  const emoji      = VERDICT_EMOJI[verdict] || '📝';
  const shortSummary = summary.replace(/[\r\n]+/g, ' ').slice(0, 80);

  // ── 共通タイムライン（history.md）に1行追記 ──
  const line = `| ${timestamp} | ${eventType} | \`${taskId}\` | ${emoji} ${verdict} | ${shortSummary} |\n`;
  fs.appendFileSync(HISTORY_FILE, line, 'utf8');

  // ── タスク別ログ（history/task_ID.md）に詳細記録 ──
  const taskHistoryFile = path.join(HISTORY_DIR, `${taskId}.md`);

  // 初回は見出しを作成
  if (!fs.existsSync(taskHistoryFile)) {
    fs.writeFileSync(taskHistoryFile, [
      `# タスク詳細履歴: ${taskId}`,
      '',
      `最終更新: ${timestamp}`,
      '',
      '---',
      '',
    ].join('\n'), 'utf8');
  }

  // エントリを追記
  const detailBlock = detail ? `\n\n${detail.slice(0, 500)}` : '';
  const entry = [
    ``,
    `## ${emoji} ${eventType} (${timestamp})`,
    ``,
    `- **判定:** ${verdict}`,
    `- **概要:** ${shortSummary}`,
    detailBlock,
    ``,
    `---`,
  ].join('\n');

  fs.appendFileSync(taskHistoryFile, entry, 'utf8');

  logger.debug(`履歴記録: ${eventType} | ${taskId} | ${verdict}`);
}

// ─────────────────────────────────────────────────────
// 特定タスクの履歴を取得
// ─────────────────────────────────────────────────────
function getTaskHistory(taskId) {
  const taskHistoryFile = path.join(HISTORY_DIR, `${taskId}.md`);
  if (!fs.existsSync(taskHistoryFile)) return null;
  return fs.readFileSync(taskHistoryFile, 'utf8');
}

// ─────────────────────────────────────────────────────
// 最新N件の履歴を取得（Discord 表示用）
// ─────────────────────────────────────────────────────
function getRecentHistory(limit = 10) {
  if (!fs.existsSync(HISTORY_FILE)) return [];

  const content = fs.readFileSync(HISTORY_FILE, 'utf8');
  const lines = content.split('\n')
    .filter(l => l.startsWith('|') && !l.startsWith('| 日時') && !l.startsWith('|---'))
    .slice(-limit);

  return lines;
}

// ─────────────────────────────────────────────────────
// 人間確認イベントを記録（специальная обертка）
// ─────────────────────────────────────────────────────
function recordHumanConfirm(taskId, reason, dangerLevel) {
  addEntry(
    EVENT_TYPES.HUMAN_CONFIRM,
    taskId,
    '確認依頼',
    `危険度${dangerLevel}: ${reason.slice(0, 60)}`,
    `人間確認を Discord に送信しました。\n\n理由: ${reason}`
  );
}

// ─────────────────────────────────────────────────────
// 却下理由を記録
// ─────────────────────────────────────────────────────
function recordRejection(taskId, reason, rejectedBy) {
  addEntry(
    EVENT_TYPES.REJECTION,
    taskId,
    '却下推奨',
    `${rejectedBy} が却下: ${reason.slice(0, 50)}`,
    `却下理由: ${reason}\n\n却下元: ${rejectedBy}`
  );
}

// ─────────────────────────────────────────────────────
// 修正実施を記録
// ─────────────────────────────────────────────────────
function recordModification(taskId, what, why) {
  addEntry(
    EVENT_TYPES.MODIFICATION,
    taskId,
    '適用済み',
    `修正: ${what.slice(0, 60)}`,
    `修正内容: ${what}\n\n理由: ${why}`
  );
}

module.exports = {
  addEntry,
  getTaskHistory,
  getRecentHistory,
  recordHumanConfirm,
  recordRejection,
  recordModification,
  EVENT_TYPES,
};
