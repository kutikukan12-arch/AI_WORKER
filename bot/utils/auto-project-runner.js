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
  try {
    fs.writeFileSync(RUNNER_STATE_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    logger.error(`[AutoRunner] runner-state.json 書き込み失敗: ${e.message}`);
    // 書き込み失敗はログのみ。呼び出し元の処理は継続させる。
  }
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

// ─────────────────────────────────────────────────────
// runPlannerStep(projectId, context = {}) — Phase B-5
//
// Auto Project Runner の1ステップを実行する。
// Phase B-5 では planNextTask() を呼び出し結果を戻り値に含める。
// ただし tasks.json への書き込みはまだしない。
//
// 動作:
//   1. runner 状態を読み込む
//   2. enabled=false なら何もせず { action: 'skip' } を返す
//   3. loopCount を確認し上限超えなら停止状態にする
//   4. loopCount / updatedAt を更新して保存
//   5. planNextTask(projectId, context) を呼び出す（副作用なし）
//   6. 結果オブジェクトと Discord 通知用 summary を返す
//
// 引数:
//   projectId - プロジェクトID
//   context   - Planner に渡す情報 { reviewResult, ... }
//               runner off 時は渡さない
//
// 戻り値:
//   {
//     action:       'skip' | 'stopped' | 'step',
//     summary:      string,         // Discord 通知用の短文
//     projectId:    string,
//     loopCount:    number,
//     plannerResult: object | null, // planNextTask の戻り値
//   }
// ─────────────────────────────────────────────────────
const MAX_LOOP_COUNT_DEFAULT = 10;

// project-planner.js を遅延ロード（循環参照を防ぐ）
function getPlanner() {
  return require('./project-planner');
}

function runPlannerStep(projectId, context = {}) {
  const state   = getRunnerState(projectId);
  const project = (() => {
    try {
      const fs2    = require('fs');
      const path2  = require('path');
      const pfile  = path2.join(DATA_DIR, 'projects.json');
      if (!fs2.existsSync(pfile)) return null;
      const data   = JSON.parse(fs2.readFileSync(pfile, 'utf8'));
      return (data.projects || []).find(p => p.id === projectId) || null;
    } catch { return null; }
  })();
  const maxLoop = project?.runner?.maxPlannerCalls ?? MAX_LOOP_COUNT_DEFAULT;

  // ① enabled=false → スキップ
  if (!state.enabled) {
    logger.debug(`[AutoRunner] runPlannerStep skip: ${projectId} (disabled)`);
    return {
      action:    'skip',
      summary:   `⛔ Runner は無効です (\`${projectId}\`)`,
      projectId,
      loopCount: state.loopCount,
    };
  }

  // ② loopCount 上限チェック
  if (state.loopCount >= maxLoop) {
    logger.warn(`[AutoRunner] loopCount 上限到達: ${projectId} (${state.loopCount}/${maxLoop})`);
    saveRunnerState(projectId, {
      enabled:     false,
      pauseReason: `loopCount 上限到達 (${state.loopCount}/${maxLoop})`,
      pausedAt:    new Date().toISOString(),
    });
    // projects.json も同期
    syncProjectsEnabled(projectId, false);
    return {
      action:    'stopped',
      summary:   `🛑 **Auto Runner 停止** | \`${projectId}\`\nloopCount 上限 (${state.loopCount}/${maxLoop}) に達しました。\n\`!project runner reset\` でリセット後に再開できます。`,
      projectId,
      loopCount: state.loopCount,
    };
  }

  // ③ loopCount / updatedAt を更新
  const nextCount = state.loopCount + 1;
  saveRunnerState(projectId, {
    loopCount:    nextCount,
    lastPlannerAt: new Date().toISOString(),
  });

  logger.info(`[AutoRunner] runPlannerStep: ${projectId} | loop ${nextCount}/${maxLoop}`);

  // ④ planNextTask() を呼び出し判断結果を取得（副作用なし）
  let plannerResult = null;
  try {
    plannerResult = getPlanner().planNextTask(projectId, context);
    logger.info(`[AutoRunner] Planner結果: ${projectId} | action:${plannerResult.action}`);
  } catch (plannerErr) {
    // Planner エラーは警告のみ。runner step 自体は継続。
    logger.warn(`[AutoRunner] planNextTask エラー: ${plannerErr.message}`);
    plannerResult = { action: 'error', reason: plannerErr.message, suggestedTask: null, summary: 'Planner エラー' };
  }

  // ⑤ Phase B-6: create_task の場合に tasks.json へ登録
  let createdTask     = null;
  let plannerSummaryLine;

  if (plannerResult.action === 'create_task' && plannerResult.suggestedTask) {
    const suggested = plannerResult.suggestedTask;

    // Phase C-2: REVIEW は候補提示のみ（登録は Phase C-3 以降）
    // FIX のみ登録を許可する
    if (suggested.type !== 'FIX') {
      plannerSummaryLine =
        `Planner: ${suggested.type} 候補あり（未登録 — Phase C-3 以降で自動登録）\n` +
        `type: ${suggested.type} | priority: ${suggested.priority}`;
    } else {
    // 重複ガード: 同プロジェクト内に同じ prompt prefix の FIX タスクが PENDING/作業中 で残っていないか確認
    const isDuplicate = (() => {
      try {
        const tm      = require('./task-manager');
        const allTasks = tm.listTasks();
        const promptPrefix = (suggested.prompt || '').slice(0, 60);
        return allTasks.some(t =>
          t.type === 'FIX' &&
          t.projectId === projectId &&
          (t.state === tm.STATES.PENDING || t.state === tm.STATES.IN_PROGRESS) &&
          (t.prompt || '').slice(0, 60) === promptPrefix
        );
      } catch { return false; }
    })();

    if (isDuplicate) {
      logger.info(`[AutoRunner] 重複ガード: 同内容の FIX タスクが既に存在 (${projectId})`);
      plannerSummaryLine =
        `Planner: FIX 候補あり (重複のためスキップ)\n` +
        `危険度: ${suggested.sourceReviewDanger || '—'}`;
    } else {
      // tasks.json に登録（自動実行はしない）
      try {
        const tm = require('./task-manager');
        createdTask = tm.createTask(
          suggested.prompt,
          'auto-runner',
          null,
          suggested.priority === '高' ? '高' : '低',
          projectId,
          suggested.type || 'FIX'
        );
        // priority は priority.calculate() で算出されるため、
        // suggestedTask の値で上書きする
        if (suggested.priority && createdTask.priority !== suggested.priority) {
          tm.updateTask(createdTask.id, {
            priority:       suggested.priority,
            priorityReason: `Auto Planner 指定 (危険度: ${suggested.sourceReviewDanger || '—'})`,
          });
          createdTask.priority = suggested.priority;
        }

        // runner state の lastTaskId / totalTasksCreated を更新
        const currentState = getRunnerState(projectId);
        saveRunnerState(projectId, {
          lastTaskId:         createdTask.id,
          totalTasksCreated:  (currentState.totalTasksCreated || 0) + 1,
        });

        logger.info(`[AutoRunner] FIX タスク登録: ${createdTask.id} | ${projectId} | priority:${createdTask.priority}`);

        plannerSummaryLine =
          `Planner: FIX タスクを登録しました ✅\n` +
          `ID: \`${createdTask.id}\`\n` +
          `危険度: ${suggested.sourceReviewDanger || '—'} | priority: ${createdTask.priority}\n` +
          `次に実行:\n\`\`\`\n!auto run 1\n\`\`\``;
      } catch (createErr) {
        logger.error(`[AutoRunner] createTask エラー: ${createErr.message}`);
        plannerSummaryLine = `Planner: create_task 試みたが失敗 (${createErr.message.slice(0, 40)})`;
      }
    } // end FIX branch
    } // end suggested.type === 'FIX'
  } else {
    plannerSummaryLine = `Planner: ${plannerResult.action}`;
  }

  // nextExecutableTaskId: FIX登録時のみ設定（まだ自動実行はしない）
  const nextExecutableTaskId = createdTask ? createdTask.id : null;

  return {
    action:    'step',
    summary:
      `📋 **[AutoRunner] ステップ ${nextCount}/${maxLoop}** | \`${projectId}\`\n` +
      plannerSummaryLine,
    projectId,
    loopCount:            nextCount,
    plannerResult,
    createdTask,
    nextExecutableTaskId,
  };
}

module.exports = {
  getRunnerState,
  saveRunnerState,
  enableRunner,
  disableRunner,
  resetRunner,
  formatRunnerStatus,
  runPlannerStep,
};
