'use strict';

// =====================================================
// project-manager.js — プロジェクト管理
//
// 役割:
//   プロジェクトの CRUD と「現在選択中プロジェクト」の管理。
//   タスクのプロジェクト別フィルタリングを提供する。
//
// データ保存先:
//   data/projects.json       — プロジェクト一覧
//   data/current-project.json — チャンネルごとの現在プロジェクト
//
// 後方互換ルール:
//   projectId が null/undefined/'default' のタスクは
//   'ai_worker' または 'default' プロジェクトとして扱う。
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR        = path.join(__dirname, '..', '..', 'data');
const PROJECTS_FILE   = path.join(DATA_DIR, 'projects.json');
const CURRENT_FILE    = path.join(DATA_DIR, 'current-project.json');

// デフォルトプロジェクト（既存タスクの後方互換用）
const DEFAULT_PROJECT_ID = 'ai_worker';

// ─────────────────────────────────────────────────────
// 内部: projects.json を読み込む
// ─────────────────────────────────────────────────────
function loadProjects() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_FILE)) {
    // 初回: デフォルトプロジェクトを作成
    const defaults = {
      projects: [
        {
          id:          DEFAULT_PROJECT_ID,
          name:        'AI_WORKER',
          description: 'デフォルトプロジェクト（既存タスク用）',
          createdAt:   new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults.projects;
  }
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects || [];
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// 内部: current-project.json を読み込む
// ─────────────────────────────────────────────────────
function loadCurrent() {
  if (!fs.existsSync(CURRENT_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCurrent(data) {
  fs.writeFileSync(CURRENT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// プロジェクト名 → ID 変換（小文字・スペース→アンダースコア）
// ─────────────────────────────────────────────────────
function nameToId(name) {
  // スペース・ハイフン → アンダースコア。日本語は維持。記号のみ除去。
  return name.trim().toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/[^\w　-鿿゠-ヿ぀-ゟ一-鿿]/g, '');
}

// ─────────────────────────────────────────────────────
// プロジェクト一覧を取得
// ─────────────────────────────────────────────────────
function listProjects() {
  return loadProjects();
}

// ─────────────────────────────────────────────────────
// IDでプロジェクトを取得
// ─────────────────────────────────────────────────────
function getProject(id) {
  return loadProjects().find(p => p.id === id) || null;
}

// ─────────────────────────────────────────────────────
// プロジェクトを新規作成
//
// 戻り値:
//   { ok: true, project }
//   { ok: false, reason }
// ─────────────────────────────────────────────────────
function createProject(name, description = '') {
  const id = nameToId(name);
  if (!id) {
    return { ok: false, reason: 'プロジェクト名が無効です。半角英数字・日本語を使用してください。' };
  }

  const projects = loadProjects();
  if (projects.find(p => p.id === id)) {
    return { ok: false, reason: `プロジェクト \`${name}\` (id: ${id}) は既に存在します。` };
  }

  const project = {
    id,
    name:        name.trim(),
    description: description.trim(),
    createdAt:   new Date().toISOString(),
  };
  projects.push(project);
  saveProjects(projects);
  logger.info(`プロジェクト作成: ${id} (${name})`);
  return { ok: true, project };
}

// ─────────────────────────────────────────────────────
// チャンネルの現在プロジェクトを取得
//
// 優先順位:
//   1. current-project.json のチャンネル設定
//   2. DEFAULT_PROJECT_ID（ai_worker）
// ─────────────────────────────────────────────────────
function getCurrentProject(channelId) {
  const data = loadCurrent();
  return data[channelId] || DEFAULT_PROJECT_ID;
}

// ─────────────────────────────────────────────────────
// チャンネルの現在プロジェクトを設定
//
// 戻り値:
//   { ok: true, projectId, projectName }
//   { ok: false, reason }
// ─────────────────────────────────────────────────────
function setCurrentProject(channelId, nameOrId) {
  const id = nameToId(nameOrId);
  const project = getProject(id) ||
    // 名前での検索（大文字小文字を無視）
    loadProjects().find(p => p.name.toLowerCase() === nameOrId.toLowerCase());

  if (!project) {
    const list = listProjects().map(p => `\`${p.name}\``).join(', ');
    return { ok: false, reason: `プロジェクト \`${nameOrId}\` が見つかりません。\n利用可能: ${list}` };
  }

  const data = loadCurrent();
  data[channelId] = project.id;
  saveCurrent(data);
  logger.info(`プロジェクト切り替え: ch=${channelId} → ${project.id} (${project.name})`);
  return { ok: true, projectId: project.id, projectName: project.name };
}

// ─────────────────────────────────────────────────────
// タスクが指定プロジェクトに属するか判定
//
// 後方互換ルール:
//   task.projectId が null/'default' の場合は
//   DEFAULT_PROJECT_ID（ai_worker）として扱う。
// ─────────────────────────────────────────────────────
function taskBelongsToProject(task, projectId) {
  const taskPid = task.projectId || DEFAULT_PROJECT_ID;
  // default も ai_worker と同じ扱い
  const normalizedTask    = (taskPid === 'default') ? DEFAULT_PROJECT_ID : taskPid;
  const normalizedProject = (projectId === 'default') ? DEFAULT_PROJECT_ID : projectId;
  return normalizedTask === normalizedProject;
}

// ─────────────────────────────────────────────────────
// タスクリストをプロジェクトでフィルタリング
// ─────────────────────────────────────────────────────
function filterTasksByProject(tasks, projectId) {
  return tasks.filter(t => taskBelongsToProject(t, projectId));
}

// ─────────────────────────────────────────────────────
// Discord 用プロジェクト一覧テキストを生成
// ─────────────────────────────────────────────────────
function formatProjectList(projects, currentProjectId) {
  if (projects.length === 0) {
    return 'プロジェクトがありません。`!project create <名前>` で作成してください。';
  }
  const lines = projects.map(p => {
    const current = p.id === currentProjectId ? ' ← **現在**' : '';
    return `• \`${p.id}\` **${p.name}**${current}${p.description ? ` — ${p.description}` : ''}`;
  });
  return lines.join('\n');
}

module.exports = {
  DEFAULT_PROJECT_ID,
  nameToId,
  listProjects,
  getProject,
  createProject,
  getCurrentProject,
  setCurrentProject,
  filterTasksByProject,
  taskBelongsToProject,
  formatProjectList,
};
