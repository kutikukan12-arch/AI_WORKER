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

// ─── タスクタイプ ───
const TASK_TYPES = {
  IMPLEMENT: 'IMPLEMENT', // コード実装・機能追加
  FIX:       'FIX',       // バグ修正
  REFACTOR:  'REFACTOR',  // リファクタリング
  RESEARCH:  'RESEARCH',  // 調査・確認
  DOCS:      'DOCS',      // ドキュメント作成
  TEST:      'TEST',      // テスト追加・修正
  REVIEW:    'REVIEW',    // レビュー依頼
};

// ─── タスクタイプ絵文字 ───
const TYPE_EMOJI = {
  IMPLEMENT: '🔨',
  FIX:       '🐛',
  REFACTOR:  '♻️',
  RESEARCH:  '🔍',
  DOCS:      '📝',
  TEST:      '🧪',
  REVIEW:    '👀',
};

// ─── タスクタイプ正規化（大文字変換・バリデーション）───
// 有効な type 文字列なら正規化した値を返す。
// 無効 / 空 / null の場合は null を返す（バリデーション用途）。
// createTask() では null の場合に IMPLEMENT をデフォルトとして使う。
function normalizeTaskType(type) {
  if (!type || typeof type !== 'string' || !type.trim()) return null;
  const upper = type.trim().toUpperCase();
  return TASK_TYPES[upper] || null;
}

// ─── タスクサイズ ───
const TASK_SIZES = {
  SMALL:  'SMALL',  // 単一作業・30分以内
  MEDIUM: 'MEDIUM', // 複数作業・半日以内（デフォルト）
  LARGE:  'LARGE',  // 広範囲・複数日 → 分割推奨
};

// ─── タスクサイズ絵文字 ───
const SIZE_EMOJI = {
  SMALL:  '🟢',
  MEDIUM: '🟡',
  LARGE:  '🔴',
};

// ─── LARGE 判定キーワード ───
const LARGE_KEYWORDS = [
  '全部', '一括', 'システム全体', '完全自動化',
  '全機能', '全チャンネル', '全ての', 'すべて',
  '全体的', '全面的', 'フルリファクタ', '全面改修', '全面刷新',
  '全プロジェクト', '全タスク', '全自動', '完全移行',
];

// ─── タスクサイズ推定 ───
//
// prompt の内容から簡易的にサイズを判定する。
// 判定基準:
//   LARGE  — LARGE_KEYWORDS を含む（広範囲・全体系）
//   SMALL  — 60文字未満・2行以内・箇条書きなし（単一作業）
//   MEDIUM — それ以外（デフォルト）
//
// 引数: prompt (string)
// 戻り値: 'SMALL' | 'MEDIUM' | 'LARGE'
// ─────────────────────────────────────────────────────
function estimateTaskSize(prompt) {
  if (!prompt) return TASK_SIZES.MEDIUM;
  const text    = prompt.toLowerCase();

  // LARGE 判定
  if (LARGE_KEYWORDS.some(kw => text.includes(kw))) {
    return TASK_SIZES.LARGE;
  }

  // SMALL 判定（短く単一作業）
  const lines   = prompt.split('\n').filter(l => l.trim());
  const bullets = prompt.split('\n').filter(l => /^[・\-\*]\s/.test(l.trim()));
  if (prompt.length < 60 && lines.length <= 2 && bullets.length === 0) {
    return TASK_SIZES.SMALL;
  }

  return TASK_SIZES.MEDIUM;
}

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
//   taskType      - タスクタイプ（IMPLEMENT/FIX/REFACTOR等。省略時: 'IMPLEMENT'）
//
// 戻り値: 作成されたタスクオブジェクト
// ─────────────────────────────────────────────────────
function createTask(prompt, discordUserId, taskId = null, dangerLevel = '低', projectId = 'default', taskType = null) {
  const tasks = loadTasks();
  const id    = taskId || `task_${Date.now()}`;
  const now   = new Date().toISOString();
  const { priority: p, reason: pReason } = priority.calculate(prompt, dangerLevel);
  const type  = normalizeTaskType(taskType) || TASK_TYPES.IMPLEMENT;
  const size  = estimateTaskSize(prompt);

  const task = {
    id,
    type,                 // タスクタイプ（IMPLEMENT/FIX/REFACTOR/RESEARCH/DOCS/TEST/REVIEW）
    size,                 // タスクサイズ（SMALL/MEDIUM/LARGE）
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
  logger.info(`タスク作成: ${id} | type: ${type} | size: ${size} | project: ${projectId} | 優先度: ${p}`);
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
    const typeLabel  = t.type || TASK_TYPES.IMPLEMENT;  // 後方互換
    const sizeLabel  = t.size || TASK_SIZES.MEDIUM;      // 後方互換
    const typeEmoji  = TYPE_EMOJI[typeLabel] || '📋';
    const sizeEmoji  = SIZE_EMOJI[sizeLabel] || '🟡';
    const short = t.prompt.slice(0, 30).replace(/[\r\n]+/g, ' ');
    return `${typeEmoji}${sizeEmoji}${stateEmoji}${prioEmoji} \`${t.id}\` [${typeLabel}/${sizeLabel}] ${short}`;
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
  const typeLabel  = task.type || TASK_TYPES.IMPLEMENT;  // 後方互換
  const sizeLabel  = task.size || TASK_SIZES.MEDIUM;      // 後方互換
  const typeEmoji  = TYPE_EMOJI[typeLabel] || '📋';
  const sizeEmoji  = SIZE_EMOJI[sizeLabel] || '🟡';
  const created    = new Date(task.createdAt).toLocaleString('ja-JP');
  const updated    = new Date(task.updatedAt).toLocaleString('ja-JP');
  const history    = task.stateHistory.slice(-5).map(h =>
    `  ${new Date(h.at).toLocaleString('ja-JP')} → ${h.state}${h.note ? ` (${h.note})` : ''}`
  ).join('\n');

  return [
    `**タスク詳細: \`${task.id}\`**`,
    ``,
    `**タイプ:** ${typeEmoji} ${typeLabel}`,
    `**サイズ:** ${sizeEmoji} ${sizeLabel}`,
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

// ─────────────────────────────────────────────────────
// 古い保留・レビュー待ちタスクを data/archive_tasks.json へ移動する
// （!task archive 用）
//
// 対象:
//   保留(ON_HOLD)・レビュー待ち(REVIEWING) のタスクのうち
//   最終更新から thresholdDays 日以上経過したもの
//
// 除外（変更しない）:
//   作業中(IN_PROGRESS)・未着手(PENDING)・人間確認待ち(AWAITING)
//
// 戻り値:
//   { onHold: number, reviewing: number, total: number }
// ─────────────────────────────────────────────────────
function archiveStaleTasks(thresholdDays = 30) {
  const tasks      = loadTasks();
  const now        = Date.now();
  const limitMs    = thresholdDays * 24 * 60 * 60 * 1000;
  const archivePath = path.join(DATA_DIR, 'archive_tasks.json');

  // 既存アーカイブを読み込む（なければ空配列）
  let archived = [];
  if (fs.existsSync(archivePath)) {
    try {
      const raw = fs.readFileSync(archivePath, 'utf8');
      archived = JSON.parse(raw).tasks || [];
    } catch { /* 破損時は空で上書き */ }
  }

  let countOnHold   = 0;
  let countReviewing = 0;
  const remaining   = [];

  tasks.forEach(task => {
    const isTarget =
      task.state === STATES.ON_HOLD ||
      task.state === STATES.REVIEWING;

    if (!isTarget) {
      remaining.push(task);
      return;
    }

    const elapsed = now - new Date(task.updatedAt).getTime();
    if (elapsed < limitMs) {
      remaining.push(task);
      return;
    }

    // アーカイブ対象
    const archivedAt = new Date().toISOString();
    archived.push({ ...task, archivedAt });

    if (task.state === STATES.ON_HOLD)   countOnHold++;
    if (task.state === STATES.REVIEWING) countReviewing++;

    logger.info(`タスクアーカイブ: ${task.id} (${task.state} / ${thresholdDays}日超過)`);
  });

  const total = countOnHold + countReviewing;
  if (total > 0) {
    saveTasks(remaining);
    fs.writeFileSync(archivePath, JSON.stringify({ tasks: archived }, null, 2), 'utf8');
    logger.info(`!task archive 完了 | 保留:${countOnHold} レビュー待ち:${countReviewing} 合計:${total}`);
  }

  return { onHold: countOnHold, reviewing: countReviewing, total };
}

// ─────────────────────────────────────────────────────
// タスクの type を変更する（!task edit <id> type <TYPE> 用）
//
// 戻り値:
//   { ok: true, task }       — 更新成功
//   { ok: false, reason }    — 無効な type / タスク未発見
// ─────────────────────────────────────────────────────
function updateTaskType(taskId, rawType) {
  const normalized = normalizeTaskType(rawType);
  if (!normalized) {
    return {
      ok: false,
      reason: `無効な task type です: **${rawType}**\n利用可能: ${Object.keys(TASK_TYPES).join(' / ')}`,
    };
  }

  const tasks = loadTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) {
    return { ok: false, reason: `\`${taskId}\` が見つかりません。` };
  }

  task.type      = normalized;
  task.updatedAt = new Date().toISOString();
  saveTasks(tasks);
  logger.info(`タスクタイプ変更: ${taskId} → ${normalized}`);
  return { ok: true, task };
}

// ─────────────────────────────────────────────────────
// 分割案を生成する（splitTask() の内部処理）
//
// 抽出優先順位:
//   1. 箇条書き・番号付きリスト行
//   2. 意味のある改行区切り
//   3. フォールバック: Phase1/2/3 の3分割
//
// 戻り値: string[] (3〜5件)
// ─────────────────────────────────────────────────────
function generateSplitProposals(prompt) {
  // 1. 箇条書き（・ - * ） または 番号付きリスト
  const bulletLines = prompt
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[・\-\*]\s*\S|^\d+[.\)]\s+\S/.test(l))  // 空白0個以上に対応
    .map(l => l.replace(/^[・\-\*]\s*|^\d+[.\)]\s+/, '').trim())
    .filter(l => l.length > 3);

  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 5);
  }

  // 2. 改行区切りの複数行（空行除く）
  const lines = prompt
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 8 && !/^[#\-=]{2,}/.test(l)); // 区切り線・見出しを除外

  if (lines.length >= 2) {
    return lines.slice(0, 5);
  }

  // 3. フォールバック: Phase 分割
  const base = prompt.slice(0, 40).replace(/\n/g, ' ').trim();
  return [
    `[Phase 1] ${base} の調査・設計`,
    `[Phase 2] ${base} の実装`,
    `[Phase 3] ${base} のテスト・確認`,
  ];
}

// ─────────────────────────────────────────────────────
// タスクを複数の小さいタスクに分割する（!task split 用）
//
// 動作:
//   1. 元タスクのプロンプトから分割案を生成
//   2. 各分割タスクを新規作成（type 引き継ぎ・size 再推定）
//   3. 元タスクを DONE（アーカイブ）にする
//
// 戻り値:
//   { ok: true, original, newTasks } — 成功
//   { ok: false, reason }            — タスク未発見
// ─────────────────────────────────────────────────────
function splitTask(taskId) {
  const tasks    = loadTasks();
  const original = tasks.find(t => t.id === taskId);
  if (!original) {
    return { ok: false, reason: `\`${taskId}\` が見つかりません。` };
  }

  // 分割案を生成
  const proposals    = generateSplitProposals(original.prompt);
  const inheritedType = original.type || TASK_TYPES.IMPLEMENT;
  const now          = new Date().toISOString();

  // 分割タスクを作成
  const newTasks = proposals.map((p, i) => ({
    id:           `${taskId}_s${i + 1}`,
    type:         inheritedType,
    size:         estimateTaskSize(p),
    projectId:    original.projectId || 'default',
    prompt:       p.slice(0, 500),
    state:        STATES.PENDING,
    priority:     original.priority     || '中',
    priorityReason: `分割タスク (${taskId} から)`,
    dangerLevel:  original.dangerLevel  || '低',
    assignee:     original.assignee     || 'Claude Code',
    requestedBy:  original.requestedBy  || '',
    createdAt:    now,
    updatedAt:    now,
    stateHistory: [{ state: STATES.PENDING, at: now, note: `${taskId} から分割` }],
    reviewResult: null,
    codexResult:  null,
    prUrl:        null,
    notes:        `元タスク: ${taskId}`,
  }));

  // 元タスクを DONE → アーカイブ
  original.state     = STATES.DONE;
  original.updatedAt = now;
  original.notes     = `分割完了 → ${newTasks.map(t => t.id).join(', ')}`;
  original.stateHistory.push({
    state: STATES.DONE, at: now, note: `分割完了 (${newTasks.length}件)`,
  });
  archiveTask(original);

  // tasks.json を更新（元タスクを除去・新タスクを追加）
  const remaining = tasks.filter(t => t.id !== taskId);
  saveTasks([...remaining, ...newTasks]);

  logger.info(`タスク分割: ${taskId} → ${newTasks.length}件 | type:${inheritedType}`);
  return { ok: true, original, newTasks };
}

// ─────────────────────────────────────────────────────
// 2つのタスクを1つに統合する（!task merge 用）
//
// 動作:
//   1. 両タスクの prompt を結合して新タスクを作成
//   2. type が同じ → 引き継ぐ。違う → IMPLEMENT を使用
//   3. size は統合後プロンプトで estimateTaskSize() を再推定
//   4. 元タスク2件を DONE（アーカイブ）にする
//
// 戻り値:
//   { ok: true, task1, task2, mergedTask, typeMerged }
//   { ok: false, reason }
// ─────────────────────────────────────────────────────
function mergeTasks(taskId1, taskId2) {
  if (taskId1 === taskId2) {
    return { ok: false, reason: '同じタスクIDは統合できません。' };
  }

  const tasks  = loadTasks();
  const task1  = tasks.find(t => t.id === taskId1);
  const task2  = tasks.find(t => t.id === taskId2);

  if (!task1) return { ok: false, reason: `\`${taskId1}\` が見つかりません。` };
  if (!task2) return { ok: false, reason: `\`${taskId2}\` が見つかりません。` };

  // type 統合ルール: 同じなら引き継ぐ、違う場合は IMPLEMENT
  const type1       = task1.type || TASK_TYPES.IMPLEMENT;
  const type2       = task2.type || TASK_TYPES.IMPLEMENT;
  const mergedType  = (type1 === type2) ? type1 : TASK_TYPES.IMPLEMENT;
  const typeMerged  = type1 !== type2; // 異なる type を統合したか

  // プロンプトを結合
  const mergedPrompt = [
    `[統合タスク: ${taskId1} + ${taskId2}]`,
    ``,
    task1.prompt,
    ``,
    `---`,
    ``,
    task2.prompt,
  ].join('\n').slice(0, 500);

  // 統合後の size を再推定
  const mergedSize = estimateTaskSize(mergedPrompt);

  const now       = new Date().toISOString();
  const mergedId  = `task_${Date.now()}`;
  const projectId = task1.projectId || task2.projectId || 'default';

  const mergedTask = {
    id:           mergedId,
    type:         mergedType,
    size:         mergedSize,
    projectId,
    prompt:       mergedPrompt,
    state:        STATES.PENDING,
    priority:     task1.priority === '高' || task2.priority === '高' ? '高' : task1.priority || '中',
    priorityReason: `統合タスク (${taskId1} + ${taskId2})`,
    dangerLevel:  task1.dangerLevel === '高' || task2.dangerLevel === '高' ? '高' : '低',
    assignee:     'Claude Code',
    requestedBy:  task1.requestedBy || task2.requestedBy || '',
    createdAt:    now,
    updatedAt:    now,
    stateHistory: [{ state: STATES.PENDING, at: now, note: `${taskId1} と ${taskId2} を統合` }],
    reviewResult: null,
    codexResult:  null,
    prUrl:        null,
    notes:        `統合元: ${taskId1}, ${taskId2}`,
  };

  // 元タスク2件を DONE → アーカイブ
  for (const t of [task1, task2]) {
    t.state     = STATES.DONE;
    t.updatedAt = now;
    t.notes     = (t.notes ? t.notes + ' / ' : '') + `統合済み → ${mergedId}`;
    t.stateHistory.push({ state: STATES.DONE, at: now, note: `統合完了 → ${mergedId}` });
    archiveTask(t);
  }

  // tasks.json を更新（元2件を除去・統合タスクを追加）
  const remaining = tasks.filter(t => t.id !== taskId1 && t.id !== taskId2);
  saveTasks([...remaining, mergedTask]);

  logger.info(`タスク統合: ${taskId1} + ${taskId2} → ${mergedId} | type:${mergedType} | size:${mergedSize}`);
  return { ok: true, task1, task2, mergedTask, typeMerged };
}

// ─────────────────────────────────────────────────────
// buildTypeGuard — task.type に応じた実行制約テキストを返す
//
// Auto Task Runner がプロンプトに付与して Claude の作業範囲を制限する。
// type なし → IMPLEMENT 扱い（後方互換）
//
// 引数: taskType ('IMPLEMENT'|'FIX'|...|null)
// 戻り値: プロンプト末尾に追記する文字列
// ─────────────────────────────────────────────────────
function buildTypeGuard(taskType) {
  const type = taskType || TASK_TYPES.IMPLEMENT;

  const GUARDS = {
    [TASK_TYPES.IMPLEMENT]: [
      '【Type Guard: IMPLEMENT】',
      '・実装してよい',
      '・必要ならテストも追加してよい',
    ],
    [TASK_TYPES.FIX]: [
      '【Type Guard: FIX】',
      '・原因を特定して最小限の修正のみ行うこと',
      '・関係ないリファクタリングは禁止',
      '・修正範囲を必要最小限に留めること',
    ],
    [TASK_TYPES.REFACTOR]: [
      '【Type Guard: REFACTOR】',
      '・挙動を変えずにコードを整理すること',
      '・仕様変更は禁止',
      '・外部インターフェースは維持すること',
    ],
    [TASK_TYPES.RESEARCH]: [
      '【Type Guard: RESEARCH】',
      '・調査・分析のみ行うこと',
      '・ファイルへの変更は禁止',
      '・実装案の提示のみ。実際の実装は禁止',
    ],
    [TASK_TYPES.DOCS]: [
      '【Type Guard: DOCS】',
      '・ドキュメントファイルの更新のみ行うこと',
      '・実装コードの変更は禁止',
    ],
    [TASK_TYPES.TEST]: [
      '【Type Guard: TEST】',
      '・テストファイルの追加・修正のみ行うこと',
      '・本体実装の変更は最小限に留めること',
    ],
    [TASK_TYPES.REVIEW]: [
      '【Type Guard: REVIEW】',
      '・レビューのみ行うこと',
      '・ファイルへの変更は禁止',
      '・問題点と修正案を提示するだけ',
    ],
  };

  const lines = GUARDS[type] || GUARDS[TASK_TYPES.IMPLEMENT];
  return '\n---\n' + lines.join('\n');
}

module.exports = {
  STATES,
  STATE_EMOJI,
  TASK_TYPES,
  TYPE_EMOJI,
  TASK_SIZES,
  SIZE_EMOJI,
  normalizeTaskType,
  estimateTaskSize,
  createTask,
  getTask,
  updateState,
  updateTask,
  updateTaskType,
  buildTypeGuard,
  generateSplitProposals,
  splitTask,
  mergeTasks,
  listTasks,
  listTasksByPriority,
  formatTaskList,
  formatTaskDetail,
  getStats,
  cleanupStaleTasks,
  archiveStaleTasks,
};
