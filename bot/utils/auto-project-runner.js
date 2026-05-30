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
    enabled:            false,
    projectId,
    currentPhase:       null,
    lastTaskId:         null,
    loopCount:          0,
    startedAt:          null,
    updatedAt:          null,
    plannerCallCount:   0,
    lastPlannerAt:      null,
    totalTasksCreated:  0,
    pausedAt:           null,
    pauseReason:        null,
    autoApplyPlanning:  false, // Phase D-4e: 自動プラン適用（初期値 false）
  };
}

// ─────────────────────────────────────────────────────
// setAutoApplyPlanning(projectId, enabled)
//
// autoApplyPlanning の ON/OFF を設定する。
// true の場合、runner step で nextCandidates 上位1件（安全typeのみ）を自動登録する。
// ─────────────────────────────────────────────────────
function setAutoApplyPlanning(projectId, enabled) {
  saveRunnerState(projectId, { autoApplyPlanning: !!enabled });
  logger.info(`[AutoRunner] autoApplyPlanning: ${projectId} → ${enabled}`);
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

  const autoApplyStr = state.autoApplyPlanning ? '✅ ON' : '⛔ OFF';

  const lines = [
    '📊 **Auto Runner Status**',
    '──────────────────────────────',
    `Project:      ${projectName}`,
    `Runner:       ${runnerFlag}`,
    `Auto Apply:   ${autoApplyStr}`,
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

// ─────────────────────────────────────────────────────
// planProjectGoalsQuick — nextCandidates の件数だけ返す軽量版
//
// Phase D-4d: runner step の通知に「次候補あり」を追加するために使用。
// 副作用なし。エラーは 0 として扱う。
// ─────────────────────────────────────────────────────
function planProjectGoalsQuick(projectId, description) {
  try {
    const plan = require('./project-planner').planProjectGoals(projectId, { description });
    return plan.nextCandidates.length;
  } catch {
    return 0;
  }
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

  // ⑤-pre Phase D-2: project_done 検出 → runner を安全停止
  if (plannerResult.action === 'project_done') {
    logger.info(`[AutoRunner] project_done 検出: ${projectId} → runner 停止`);
    saveRunnerState(projectId, {
      enabled:     false,
      pauseReason: 'project_done',
      pausedAt:    new Date().toISOString(),
    });
    syncProjectsEnabled(projectId, false);

    const doneMsg =
      `🎉 **Project Done**\n` +
      `Project: \`${projectId}\`\n` +
      `残作業: 0件\n` +
      `Runner: stopped\n\n` +
      `次:\n\`\`\`\n!project runner status\n\`\`\``;

    return {
      action:        'project_done',
      summary:       doneMsg,
      projectId,
      loopCount:     nextCount,
      plannerResult,
      createdTask:   null,
      nextExecutableTaskId: null,
    };
  }

  // ⑤ Phase B-6: create_task の場合に tasks.json へ登録
  let createdTask     = null;
  let autoAppliedTask = null; // Phase D-4e: none 時の安全type自動登録タスク
  let plannerSummaryLine;

  if (plannerResult.action === 'create_task' && plannerResult.suggestedTask) {
    const suggested = plannerResult.suggestedTask;

    // Phase C-3: REVIEW も登録対象に追加（FIX と同様の登録フロー）
    // 登録可能タイプ: FIX / REVIEW
    // それ以外は候補提示のみ
    const isRegistrable = suggested.type === 'FIX' || suggested.type === 'REVIEW';
    if (!isRegistrable) {
      plannerSummaryLine =
        `Planner: ${suggested.type} 候補あり（未登録）\n` +
        `type: ${suggested.type} | priority: ${suggested.priority}`;
    } else {
    // 重複ガード:
    //   FIX  → 同 prompt prefix でPENDING/作業中があればスキップ
    //   REVIEW → 同 sourceImplementId でPENDING/作業中があればスキップ
    const isDuplicate = (() => {
      try {
        const tm      = require('./task-manager');
        const allTasks = tm.listTasks();
        if (suggested.type === 'REVIEW') {
          const srcId = suggested.sourceImplementId || '';
          return srcId && allTasks.some(t =>
            t.type === 'REVIEW' &&
            t.projectId === projectId &&
            (t.state === tm.STATES.PENDING || t.state === tm.STATES.IN_PROGRESS) &&
            (t.prompt || '').includes(srcId)
          );
        }
        // FIX: 既存の prompt prefix チェック
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
      logger.info(`[AutoRunner] 重複ガード: 同内容の ${suggested.type} タスクが既に存在 (${projectId})`);
      plannerSummaryLine =
        `Planner: ${suggested.type} 候補あり (重複のためスキップ)\n` +
        (suggested.type === 'REVIEW'
          ? `元IMPLEMENT: ${suggested.sourceImplementId || '—'}`
          : `危険度: ${suggested.sourceReviewDanger || '—'}`);
    } else {
      // tasks.json に登録（自動実行はしない）
      try {
        const tm = require('./task-manager');
        // REVIEW タスクは重複ガードで検索できるよう sourceImplementId を prompt に含める
        const taskPrompt = (suggested.type === 'REVIEW' && suggested.sourceImplementId)
          ? suggested.prompt + `\n[対象IMPLEMENT: ${suggested.sourceImplementId}]`
          : suggested.prompt;
        createdTask = tm.createTask(
          taskPrompt,
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

        if (suggested.type === 'REVIEW') {
          plannerSummaryLine =
            `Planner: REVIEW タスクを登録しました ✅\n` +
            `ID: \`${createdTask.id}\`\n` +
            `元IMPLEMENT: ${suggested.sourceImplementId || '—'} | priority: ${createdTask.priority}\n` +
            `次に実行:\n\`\`\`\n!auto run 1\n\`\`\``;
        } else {
          plannerSummaryLine =
            `Planner: FIX タスクを登録しました ✅\n` +
            `ID: \`${createdTask.id}\`\n` +
            `危険度: ${suggested.sourceReviewDanger || '—'} | priority: ${createdTask.priority}\n` +
            `次に実行:\n\`\`\`\n!auto run 1\n\`\`\``;
        }
      } catch (createErr) {
        logger.error(`[AutoRunner] createTask エラー: ${createErr.message}`);
        plannerSummaryLine = `Planner: create_task 試みたが失敗 (${createErr.message.slice(0, 40)})`;
      }
    } // end FIX branch
    } // end suggested.type === 'FIX'
  } else {
    // Phase D-4d/D-4e: plannerResult.action === 'none' のとき追加処理
    let nextCandidatesHint = '';

    if (plannerResult.action === 'none') {
      try {
        const pm2         = require('./project-manager');
        const proj2       = pm2.getProject(projectId);
        const description = (proj2?.description || proj2?.name || '');
        const goalHint    = planProjectGoalsQuick(projectId, description);
        const currentState2 = getRunnerState(projectId);

        // Phase D-4e: autoApplyPlanning=true なら上位1件（安全typeのみ）を自動登録
        const SAFE_TYPES = new Set(['DOCS', 'RESEARCH', 'TEST']);
        if (currentState2.autoApplyPlanning && goalHint > 0) {
          try {
            const fullPlan  = require('./project-planner').planProjectGoals(projectId, { description });
            const safeCand  = fullPlan.nextCandidates.find(c => SAFE_TYPES.has(c.type));
            if (safeCand) {
              const tm = require('./task-manager');
              // 重複チェック
              const allT = tm.listTasks();
              const isDup = allT.some(t =>
                t.projectId === projectId &&
                t.type === safeCand.type &&
                (t.state === tm.STATES.PENDING || t.state === tm.STATES.IN_PROGRESS) &&
                (t.prompt || '').slice(0, 30) === (safeCand.prompt || '').slice(0, 30)
              );
              if (!isDup) {
                autoAppliedTask = tm.createTask(
                  safeCand.prompt, 'auto-runner', null,
                  safeCand.priority === '高' ? '高' : '低',
                  projectId, safeCand.type
                );
                const currentState3 = getRunnerState(projectId);
                saveRunnerState(projectId, {
                  lastTaskId:        autoAppliedTask.id,
                  totalTasksCreated: (currentState3.totalTasksCreated || 0) + 1,
                });
                logger.info(`[AutoRunner] D-4e auto-apply: ${autoAppliedTask.id} [${safeCand.type}] | ${projectId}`);
                nextCandidatesHint =
                  `\n📋 Auto Apply: [${safeCand.type}] タスクを登録\n` +
                  `\`${autoAppliedTask.id}\`\n` +
                  `次:\n\`\`\`\n!task list\n!auto run 1\n\`\`\``;
              } else {
                nextCandidatesHint =
                  `\n次候補があります (重複のためスキップ):\n` +
                  `\`\`\`\n!project plan apply\n\`\`\``;
              }
            }
          } catch (applyErr) {
            logger.warn(`[AutoRunner] D-4e auto-apply エラー: ${applyErr.message}`);
          }
        } else if (goalHint > 0) {
          // autoApplyPlanning=false: ヒントのみ表示
          nextCandidatesHint =
            `\n次候補があります (${goalHint}件):\n` +
            `\`\`\`\n!project plan\n!project plan apply\n\`\`\``;
        }
      } catch { /* ignore */ }
    }
    plannerSummaryLine = `Planner: ${plannerResult.action}` + nextCandidatesHint;
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
    autoAppliedTask,       // Phase D-4e: auto-apply で登録したタスク（null の場合が多い）
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
  setAutoApplyPlanning,
};
