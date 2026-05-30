'use strict';

// =====================================================
// auto-project-runner.js — Auto Project Runner 状態管理
//
// 役割:
//   data/runner-state.json の読み書きと Runner 有効化・
//   無効化・リセット・ステータス表示を提供する。
//   Phase B 以降の実行エンジン（runPlannerStep 等）は
//   このモジュールが export する状態 API を使う。
//
// 保存先:
//   data/runner-state.json  ← プロジェクト別の実行状態
//   data/projects.json      ← project.runner.enabled を同期
// =====================================================

const fs             = require('fs');
const path           = require('path');
const logger         = require('./logger');
const projectManager = require('./project-manager');

const DATA_DIR         = path.join(__dirname, '..', '..', 'data');
const RUNNER_STATE_FILE = path.join(DATA_DIR, 'runner-state.json');
const PROJECTS_FILE    = path.join(DATA_DIR, 'projects.json');

// ─── runner-state.json の初期値 ──────────────────────
function defaultState(projectId) {
  return {
    enabled:          false,
    projectId,
    currentPhase:     null,
    lastTaskId:       null,
    loopCount:        0,
    startedAt:        null,
    updatedAt:        null,
    plannerCallCount: 0,
    lastPlannerAt:    null,
    totalTasksCreated: 0,
    pausedAt:         null,
    pauseReason:      null,
  };
}

// ─────────────────────────────────────────────────────
// 内部: runner-state.json を読み込む（全プロジェクト分）
// ─────────────────────────────────────────────────────
function loadAllRunnerState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RUNNER_STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAllRunnerState(all) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RUNNER_STATE_FILE, JSON.stringify(all, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// 内部: projects.json の project.runner.enabled を更新する
// ─────────────────────────────────────────────────────
function syncProjectsEnabled(projectId, enabled) {
  if (!fs.existsSync(PROJECTS_FILE)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch {
    return;
  }
  const projects = data.projects || [];
  const project  = projects.find(p => p.id === projectId);
  if (!project) return;

  if (!project.runner) project.runner = {};
  project.runner.enabled = enabled;
  if (enabled) {
    project.runner.startedAt = project.runner.startedAt || new Date().toISOString();
  }
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// getRunnerState(projectId)
//
// runner-state.json から指定プロジェクトの状態を返す。
// 未登録の場合はデフォルト値を返す（ファイルは変更しない）。
// ─────────────────────────────────────────────────────
function getRunnerState(projectId) {
  const all = loadAllRunnerState();
  return all[projectId] ? { ...defaultState(projectId), ...all[projectId] } : defaultState(projectId);
}

// ─────────────────────────────────────────────────────
// saveRunnerState(projectId, state)
//
// 指定プロジェクトの状態を runner-state.json に保存する。
// updatedAt は自動で現在時刻に更新される。
// ─────────────────────────────────────────────────────
function saveRunnerState(projectId, state) {
  const all   = loadAllRunnerState();
  const current = all[projectId] ? { ...defaultState(projectId), ...all[projectId] } : defaultState(projectId);
  all[projectId] = { ...current, ...state, projectId, updatedAt: new Date().toISOString() };
  saveAllRunnerState(all);
  logger.info(`[AutoRunner] state saved: ${projectId}`);
}

// ─────────────────────────────────────────────────────
// enableRunner(projectId)
//
// Auto Runner を有効化する。
// runner-state.json と projects.json の両方を更新する。
// ─────────────────────────────────────────────────────
function enableRunner(projectId) {
  const current = getRunnerState(projectId);
  const now     = new Date().toISOString();
  saveRunnerState(projectId, {
    enabled:   true,
    startedAt: current.startedAt || now,
  });
  syncProjectsEnabled(projectId, true);
  logger.info(`[AutoRunner] enabled: ${projectId}`);
}

// ─────────────────────────────────────────────────────
// disableRunner(projectId)
//
// Auto Runner を無効化する。
// runner-state.json と projects.json の両方を更新する。
// ─────────────────────────────────────────────────────
function disableRunner(projectId) {
  saveRunnerState(projectId, { enabled: false });
  syncProjectsEnabled(projectId, false);
  logger.info(`[AutoRunner] disabled: ${projectId}`);
}

// ─────────────────────────────────────────────────────
// resetRunner(projectId)
//
// 指定プロジェクトの runner 状態をリセットする。
// ループカウンタ・完了数・フェーズ情報をすべて初期値に戻す。
// runner は無効状態になる。
// ─────────────────────────────────────────────────────
function resetRunner(projectId) {
  const all = loadAllRunnerState();
  all[projectId] = defaultState(projectId);
  all[projectId].updatedAt = new Date().toISOString();
  saveAllRunnerState(all);
  syncProjectsEnabled(projectId, false);
  logger.info(`[AutoRunner] reset: ${projectId}`);
}

// ─────────────────────────────────────────────────────
// formatRunnerStatus(projectId)
//
// !project runner status 用のテキストを生成する。
// ─────────────────────────────────────────────────────
function formatRunnerStatus(projectId) {
  const state   = getRunnerState(projectId);
  const project = projectManager.getProject(projectId);

  const projectName  = project?.name || projectId;
  const runnerFlag   = state.enabled ? '✅ 有効' : '⛔ 無効';
  const loopInfo     = `${state.plannerCallCount}/${project?.runner?.maxPlannerCalls ?? 10}回`;
  const lastTaskInfo = state.lastTaskId ? `\`${state.lastTaskId}\`` : 'なし';
  const phaseInfo    = state.currentPhase || '—';

  const startedStr = state.startedAt
    ? new Date(state.startedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '—';
  const updatedStr = state.updatedAt
    ? new Date(state.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '—';

  const lines = [
    '📊 **Auto Runner Status**',
    '──────────────────────────────',
    `Project:      ${projectName}`,
    `Runner:       ${runnerFlag}`,
    ``,
    `現在フェーズ:   ${phaseInfo}`,
    `最終タスク:     ${lastTaskInfo}`,
    `Plannerコール:  ${loopInfo}`,
    `生成タスク数:   ${state.totalTasksCreated}件`,
    ``,
    `開始時刻:     ${startedStr}`,
    `最終更新:     ${updatedStr}`,
  ];

  if (state.pauseReason) {
    lines.push('');
    lines.push(`⏸️ 一時停止中: ${state.pauseReason}`);
  }

  return lines.join('\n');
}

module.exports = {
  getRunnerState,
  saveRunnerState,
  enableRunner,
  disableRunner,
  resetRunner,
  formatRunnerStatus,
};
