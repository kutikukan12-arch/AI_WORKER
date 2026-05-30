'use strict';

// =====================================================
// task-manager.js - AI タスク管理
//
// 役割:
//   タスクのCRUD・状態管理・Discord表示・履歴を担う。
//   全タスクは data/tasks.json に保存される。
//
// タスク状態:
//   未着手 → 作業中 → レビュー待ち → 人間確認待ち → 完了
//   ※ いつでも「保留」に変更可能
//
// 保存先:
//   data/tasks.json        ← 現在の全タスク
//   data/history/YYYY-MM.json ← 完了タスクの月次アーカイブ
// =====================================================

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const priority = require('./priority');

const DATA_DIR      = path.join(__dirname, '..', '..', 'data');
const TASKS_FILE    = path.join(DATA_DIR, 'tasks.json');
const HISTORY_DIR   = path.join(DATA_DIR, 'history');

// ─── タスク状態 ───
const STATES = {
  PENDING:     '未着手',
  IN_PROGRESS: '作業中',
  REVIEWING:   'レビュー待ち',
  AWAITING:    '人間確認待ち',
  DONE:        '完了',
  ON_HOLD:     '保留',
};

// ─── 状態の絵文字 ───
const STATE_EMOJI = {
  '未着手':       '⬜',
  '作業中':       '🔵',
  'レビュー待ち': '🟡',
  '人間確認待ち': '🟠',
  '完了':         '✅',
  '保留':         '⏸️',
};

// ─────────────────────────────────────────────────────
// 初期化 - data ディレクトリと tasks.json を確保
// ─────────────────────────────────────────────────────
function ensureStore() {
  [DATA_DIR, HISTORY_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  if (!fs.existsSync(TASKS_FILE)) {
    fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: [] }, null, 2), 'utf8');
    logger.debug('tasks.json を初期化しました');
  }
}

// ─────────────────────────────────────────────────────
// 全タスクを読み込む
// ─────────────────────────────────────────────────────
function loadTasks() {
  ensureStore();
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf8');
    return JSON.parse(raw).tasks || [];
  } catch (e) {
    logger.error(`tasks.json 読み込み失敗: ${e.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────
// 全タスクを保存する
// ─────────────────────────────────────────────────────
function saveTasks(tasks) {
  ensureStore();
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks }, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// タスクを作成する
//
// 引数:
//   prompt        - 依頼内容
//   discordUserId - 依頼したDiscordユーザーID
//   taskId        - claude-runner が生成したタスクID（省略時は自動生成）
//   dangerLevel   - 危険度（'高'|'中'|'低'）
//   projectId     - プロジェクトID（Discordチャンネル名から決定。省略時: 'default'）
//
// 戻り値: 作成されたタスクオブジェクト
// ─────────────────────────────────────────────────────
function createTask(prompt, discordUserId, taskId = null, dangerLevel = '低', projectId = 'default') {
  const tasks = loadTasks();
  const id = taskId || `task_${Date.now()}`;
  const now = new Date().toISOString();
  const { priority: p, reason: pReason } = priority.calculate(prompt, dangerLevel);

  const task = {
    id,
    projectId,            // どのプロジェクトのタスクか（workspace 分離に使用）
    prompt:       prompt.slice(0, 500),
    state:        STATES.PENDING,
    priority:     p,
    priorityReason: pReason,
    dangerLevel,
    assignee:     'Claude Code',
    requestedBy:  discordUserId,
    createdAt:    now,
    updatedAt:    now,
    stateHistory: [
      { state: STATES.PENDING, at: now, note: '作成' },
    ],
    reviewResult:  null,
    codexResult:   null,
    prUrl:         null,
    notes:         '',
  };

  tasks.push(task);
  saveTasks(tasks);
  logger.info(`タスク作成: ${id} | project: ${projectId} | 優先度: ${p}`);
  return task;
}

// ─────────────────────────────────────────────────────
// タスクをIDで取得
// ─────────────────────────────────────────────────────
function getTask(taskId) {
  const tasks = loadTasks();
  return tasks.find(t => t.id === taskId) || null;
}

// ─────────────────────────────────────────────────────
// タスクの状態を更新する
// ─────────────────────────────────────────────────────
function updateState(taskId, newState, note = '') {
  const tasks = loadTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) return null;

  const now = new Date().toISOString();
  task.state     = newState;
  task.updatedAt = now;
  task.stateHistory.push({ state: newState, at: now, note });

  // 完了タスクはアーカイブへ
  if (newState === STATES.DONE) {
    archiveTask(task);
    const remaining = tasks.filter(t => t.id !== taskId);
    saveTasks(remaining);
    logger.info(`タスク完了・アーカイブ: ${taskId}`);
    return task;
  }

  saveTasks(tasks);
  logger.info(`タスク状態更新: ${taskId} → ${newState}`);
  return task;
}

// ─────────────────────────────────────────────────────
// タスクにフィールドを更新する（汎用）
// ─────────────────────────────────────────────────────
function updateTask(taskId, fields) {
  const tasks = loadTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) return null;

  Object.assign(task, fields, { updatedAt: new Date().toISOString() });
  saveTasks(tasks);
  return task;
}

// ─────────────────────────────────────────────────────
// 完了タスクをアーカイブ（月次 JSON）
// ─────────────────────────────────────────────────────
function archiveTask(task) {
  const ym = task.updatedAt.slice(0, 7); // YYYY-MM
  const archiveFile = path.join(HISTORY_DIR, `${ym}.json`);

  let archive = { tasks: [] };
  if (fs.existsSync(archiveFile)) {
    try { archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8')); } catch { /* ignore */ }
  }
  archive.tasks.push(task);
  fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// 状態でフィルタしたタスク一覧を返す（省略時: 全タスク）
// ─────────────────────────────────────────────────────
function listTasks(stateFilter = null) {
  const tasks = loadTasks();
  if (!stateFilter) return tasks;
  return tasks.filter(t => t.state === stateFilter);
}

// ─────────────────────────────────────────────────────
// 優先度でソートしたタスク一覧（高→低→中→保留）
// ─────────────────────────────────────────────────────
function listTasksByPriority() {
  const tasks = loadTasks();
  return [...tasks].sort((a, b) => {
    // 保留は最後
    if (a.state === STATES.ON_HOLD && b.state !== STATES.ON_HOLD) return 1;
    if (b.state === STATES.ON_HOLD && a.state !== STATES.ON_HOLD) return -1;
    return priority.toNumber(b.priority) - priority.toNumber(a.priority);
  });
}

// ─────────────────────────────────────────────────────
// Discord 用サマリーテキストを生成
// ─────────────────────────────────────────────────────
function formatTaskList(tasks, title = 'タスク一覧') {
  if (tasks.length === 0) {
    return `**${title}**\n\nタスクはありません。`;
  }

  const lines = tasks.slice(0, 15).map(t => {
    const stateEmoji = STATE_EMOJI[t.state] || '❓';
    const prioEmoji  = priority.toEmoji(t.priority);
    const short = t.prompt.slice(0, 40).replace(/[\r\n]+/g, ' ');
    return `${stateEmoji}${prioEmoji} \`${t.id}\` ${short}`;
  });

  let text = `**${title}** (${tasks.length}件)\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
  if (tasks.length > 15) text += `\n…他 ${tasks.length - 15} 件`;
  return text;
}

// ─────────────────────────────────────────────────────
// タスク詳細テキストを生成（Discord 用）
// ─────────────────────────────────────────────────────
function formatTaskDetail(task) {
  const stateEmoji = STATE_EMOJI[task.state] || '❓';
  const prioEmoji  = priority.toEmoji(task.priority);
  const created    = new Date(task.createdAt).toLocaleString('ja-JP');
  const updated    = new Date(task.updatedAt).toLocaleString('ja-JP');
  const history    = task.stateHistory.slice(-5).map(h =>
    `  ${new Date(h.at).toLocaleString('ja-JP')} → ${h.state}${h.note ? ` (${h.note})` : ''}`
  ).join('\n');

  return [
    `**タスク詳細: \`${task.id}\`**`,
    ``,
    `**状態:** ${stateEmoji} ${task.state}`,
    `**優先度:** ${prioEmoji} ${task.priority}（${task.priorityReason}）`,
    `**危険度:** ${task.dangerLevel}`,
    `**担当:** ${task.assignee}`,
    `**依頼内容:** ${task.prompt.slice(0, 200)}`,
    `**作成:** ${created}`,
    `**更新:** ${updated}`,
    task.prUrl ? `**PR:** ${task.prUrl}` : '',
    ``,
    `**状態履歴（最新5件）:**`,
    history,
  ].filter(l => l !== '').join('\n');
}

// ─────────────────────────────────────────────────────
// 統計情報を生成
// ─────────────────────────────────────────────────────
function getStats() {
  const tasks = loadTasks();
  const counts = {};
  for (const s of Object.values(STATES)) counts[s] = 0;
  tasks.forEach(t => { counts[t.state] = (counts[t.state] || 0) + 1; });

  return {
    total:  tasks.length,
    counts,
    highPriority: tasks.filter(t => t.priority === '高' && t.state !== STATES.DONE).length,
    awaiting:     tasks.filter(t => t.state === STATES.AWAITING).length,
  };
}

// ─────────────────────────────────────────────────────
// 孤立タスクを一括で保留に移動する（!task cleanup 用）
//
// 対象:
//   作業中(IN_PROGRESS)・レビュー待ち(REVIEWING) のタスクのうち
//   最終更新から thresholdHours 時間以上経過したもの
//
// 戻り値:
//   { inProgress: number, reviewing: number, total: number }
// ─────────────────────────────────────────────────────
function cleanupStaleTasks(thresholdHours = 24) {
  const tasks    = loadTasks();
  const now      = Date.now();
  const limitMs  = thresholdHours * 60 * 60 * 1000;
  const noteText = `孤立タスク整理（${thresholdHours}時間超過 → 保留）`;

  let countInProgress = 0;
  let countReviewing  = 0;

  tasks.forEach(task => {
    const isTarget =
      task.state === STATES.IN_PROGRESS ||
      task.state === STATES.REVIEWING;
    if (!isTarget) return;

    const elapsed = now - new Date(task.updatedAt).getTime();
    if (elapsed < limitMs) return;

    const prevState = task.state;
    task.state     = STATES.ON_HOLD;
    task.updatedAt = new Date().toISOString();
    task.stateHistory.push({ state: STATES.ON_HOLD, at: task.updatedAt, note: noteText });

    if (prevState === STATES.IN_PROGRESS) countInProgress++;
    if (prevState === STATES.REVIEWING)   countReviewing++;

    logger.info(`孤立タスク保留: ${task.id} (${prevState} → 保留)`);
  });

  if (countInProgress + countReviewing > 0) {
    saveTasks(tasks);
  }

  return {
    inProgress: countInProgress,
    reviewing:  countReviewing,
    total:      countInProgress + countReviewing,
  };
}

module.exports = {
  STATES,
  STATE_EMOJI,
  createTask,
  getTask,
  updateState,
  updateTask,
  listTasks,
  listTasksByPriority,
  formatTaskList,
  formatTaskDetail,
  getStats,
  cleanupStaleTasks,
};
