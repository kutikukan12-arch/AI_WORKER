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
    plannerStats: {            // Phase D-8: LLM 呼び出し統計
      llmCallCount:       0,  // LLM 呼び出し成功回数
      fallbackCount:      0,  // rule-based fallback 回数
      lastPlannerSource:  null, // 'llm' | 'rule-based' | null
      lastPlannerError:   null, // 最後のエラーメッセージ（あれば）
      totalEstimatedCost: 0,  // 推定コスト（USD, ~$0.005/LLM呼び出し）
    },
  };
}

// ─────────────────────────────────────────────────────
// Phase D-8: LLM 呼び出し頻度制御
// デフォルト: LLM_INTERVAL_STEPS ステップに1回のみ LLM を使用
// ─────────────────────────────────────────────────────
const LLM_INTERVAL_STEPS = 3; // 3ステップに1回

// ─────────────────────────────────────────────────────
// getProjectDoneTasks(projectId)
//
// data/history/*.json からプロジェクトの完了タスクを収集し
// "TYPE: prompt_snippet" 形式の文字列配列を返す。
// planProjectGoals の doneTasks 引数に渡して重複 RESEARCH を抑制する。
// ─────────────────────────────────────────────────────
function getProjectDoneTasks(projectId) {
  const doneTasks = [];
  try {
    const histDir = path.join(DATA_DIR, 'history');
    if (!fs.existsSync(histDir)) return doneTasks;
    const files = fs.readdirSync(histDir)
      .filter(f => f.endsWith('.json'))
      .slice(-3); // 直近3ヶ月分
    for (const f of files) {
      try {
        const hist = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
        (hist.tasks || [])
          .filter(t => (t.projectId || 'default') === projectId)
          .forEach(t => {
            doneTasks.push(`${t.type || 'UNKNOWN'}: ${(t.prompt || '').slice(0, 60)}`);
          });
      } catch { /* ファイル読み込み失敗は無視 */ }
    }
  } catch { /* ignore */ }
  return doneTasks;
}

// ─────────────────────────────────────────────────────
// updatePlannerStats(projectId, source, errorMsg)
//
// LLM/fallback 呼び出し後に plannerStats を更新する。
// source: 'llm' | 'rule-based'
// ─────────────────────────────────────────────────────
function updatePlannerStats(projectId, source, errorMsg) {
  try {
    const state  = getRunnerState(projectId);
    const stats  = { ...(state.plannerStats || {}) };
    // 欠落フィールドを補完
    if (!stats.llmCallCount)       stats.llmCallCount       = 0;
    if (!stats.fallbackCount)      stats.fallbackCount      = 0;
    if (!stats.totalEstimatedCost) stats.totalEstimatedCost = 0;

    if (source === 'llm') {
      stats.llmCallCount++;
      // GPT-4o ~$0.005/call (300 input + 200 output tokens 想定)
      stats.totalEstimatedCost = Math.round((stats.totalEstimatedCost + 0.005) * 1000) / 1000;
    } else {
      stats.fallbackCount++;
    }
    stats.lastPlannerSource = source;
    stats.lastPlannerError  = errorMsg || null;

    saveRunnerState(projectId, { plannerStats: stats });
  } catch (e) {
    logger.warn(`[AutoRunner] updatePlannerStats エラー: ${e.message}`);
  }
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
  const loopInfo     = `${state.loopCount}/${project?.runner?.maxPlannerCalls ?? 10}回`;
  const lastTaskInfo = state.lastTaskId ? `\`${state.lastTaskId}\`` : 'なし';
  const phaseInfo    = state.currentPhase || '—';

  const startedStr = state.startedAt
    ? new Date(state.startedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '—';
  const updatedStr = state.updatedAt
    ? new Date(state.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '—';

  const autoApplyStr = state.autoApplyPlanning ? '✅ ON' : '⛔ OFF';

  // Phase D-8: plannerStats
  const stats        = state.plannerStats || {};
  const srcLabel     = stats.lastPlannerSource === 'llm' ? '🤖 LLM' : stats.lastPlannerSource === 'rule-based' ? '📋 rule-based' : '—';
  const costLabel    = stats.totalEstimatedCost ? `$${stats.totalEstimatedCost.toFixed(3)}` : '$0.000';
  const errLabel     = stats.lastPlannerError ? stats.lastPlannerError.slice(0, 40) + '…' : 'なし';

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
    `LLM呼出:       ${stats.llmCallCount || 0}回`,
    `Fallback:      ${stats.fallbackCount || 0}回`,
    `最終Planner:   ${srcLabel}`,
    `推定コスト:     ${costLabel}`,
    `最終エラー:     ${errLabel}`,
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
    // Phase D-4d/D-4e/D-5: plannerResult.action === 'none' のとき追加処理
    let nextCandidatesHint = '';

    if (plannerResult.action === 'none') {
      try {
        const pm2           = require('./project-manager');
        const proj2         = pm2.getProject(projectId);
        const description   = (proj2?.description || proj2?.name || '');
        // 完了済みタスクを収集（RESEARCH 重複防止に使用）
        const doneTasks     = getProjectDoneTasks(projectId);
        const goalHint      = planProjectGoalsQuick(projectId, description);
        const currentState2 = getRunnerState(projectId);

        const SAFE_TYPES = new Set(['DOCS', 'RESEARCH', 'TEST']);

        if (currentState2.autoApplyPlanning && goalHint > 0) {
          try {
            const fullPlan = require('./project-planner').planProjectGoals(projectId, { description, doneTasks });
            const tm       = require('./task-manager');
            const allT     = tm.listTasks();
            const ACTIVE   = new Set([tm.STATES.PENDING, tm.STATES.IN_PROGRESS]);

            // ── Phase D-4e: DOCS/RESEARCH/TEST を優先登録 ─────────
            // 完了済み RESEARCH がある場合は DOCS/TEST を優先（RESEARCH 連続生成防止）
            const hasCompletedResearch = doneTasks.some(d => d.toUpperCase().startsWith('RESEARCH:'));
            const safeCand = hasCompletedResearch
              ? fullPlan.nextCandidates.find(c => SAFE_TYPES.has(c.type) && c.type !== 'RESEARCH')
              : fullPlan.nextCandidates.find(c => SAFE_TYPES.has(c.type));
            if (safeCand) {
              const isDup = allT.some(t =>
                t.projectId === projectId &&
                t.type === safeCand.type &&
                ACTIVE.has(t.state) &&
                (t.prompt || '').slice(0, 30) === (safeCand.prompt || '').slice(0, 30)
              );
              if (!isDup) {
                autoAppliedTask = tm.createTask(
                  safeCand.prompt, 'auto-runner', null,
                  safeCand.priority === '高' ? '高' : '低',
                  projectId, safeCand.type
                );
                const st3 = getRunnerState(projectId);
                saveRunnerState(projectId, {
                  lastTaskId:        autoAppliedTask.id,
                  totalTasksCreated: (st3.totalTasksCreated || 0) + 1,
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

            // ── Phase D-5: IMPLEMENT 候補の自動登録 ───────────────
            // D-4e が登録済みの場合はスキップ（1ステップ最大1件）
            // 同一プロジェクトに PENDING/IN_PROGRESS の IMPLEMENT が
            // 既に存在する場合もスキップ（多重起動防止）
            if (!autoAppliedTask) {
              const hasPendingImpl = allT.some(t =>
                t.projectId === projectId &&
                t.type === 'IMPLEMENT' &&
                ACTIVE.has(t.state)
              );
              if (!hasPendingImpl) {
                const implCand = fullPlan.nextCandidates.find(c => c.type === 'IMPLEMENT');
                if (implCand) {
                  autoAppliedTask = tm.createTask(
                    implCand.prompt, 'auto-runner', null,
                    implCand.priority === '高' ? '高' : '低',
                    projectId, 'IMPLEMENT'
                  );
                  const st5 = getRunnerState(projectId);
                  saveRunnerState(projectId, {
                    lastTaskId:        autoAppliedTask.id,
                    totalTasksCreated: (st5.totalTasksCreated || 0) + 1,
                  });
                  logger.info(`[AutoRunner] D-5 auto-apply IMPLEMENT: ${autoAppliedTask.id} | ${projectId}`);
                  nextCandidatesHint =
                    `\n🔨 Auto Apply: [IMPLEMENT] タスクを登録\n` +
                    `\`${autoAppliedTask.id}\`\n` +
                    `次:\n\`\`\`\n!task list\n!auto run 1\n\`\`\``;
                }
              }
            }
          } catch (applyErr) {
            logger.warn(`[AutoRunner] D-4e/D-5 auto-apply エラー: ${applyErr.message}`);
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

// ─────────────────────────────────────────────────────
// runPlannerStepAsync(projectId, context = {}) — Phase D-7c
//
// runPlannerStep() の async 版。
// plannerResult.action === 'none' の場合のみ、
// planProjectGoalsBest()（LLM 優先 → rule-based fallback）を使用し
// D-4e/D-5 の自動登録候補を決定する。
//
// FIX / REVIEW / project_done の判定は同期版と同じロジックを使う。
// autoApplyPlanning の各ガード（最大1件・重複防止・自動実行なし）も維持。
//
// 安全条件:
//   - LLM 結果を直接実行しない
//   - autoApplyPlanning=false なら候補表示のみ
//   - runner off / ループ上限超過なら LLM を呼ばない
//   - try/catch で API エラーを吸収し、タスク完了処理を壊さない
//   - 既存 runPlannerStep() は変更しない
// ─────────────────────────────────────────────────────
async function runPlannerStepAsync(projectId, context = {}) {
  const state   = getRunnerState(projectId);
  const project = (() => {
    try {
      const fs2   = require('fs');
      const path2 = require('path');
      const pfile = path2.join(DATA_DIR, 'projects.json');
      if (!fs2.existsSync(pfile)) return null;
      const data  = JSON.parse(fs2.readFileSync(pfile, 'utf8'));
      return (data.projects || []).find(p => p.id === projectId) || null;
    } catch { return null; }
  })();
  const maxLoop = project?.runner?.maxPlannerCalls ?? MAX_LOOP_COUNT_DEFAULT;

  // ① enabled=false → LLM を呼ばずスキップ
  if (!state.enabled) {
    logger.debug(`[AutoRunner] runPlannerStepAsync skip: ${projectId} (disabled)`);
    return {
      action:    'skip',
      summary:   `⛔ Runner は無効です (\`${projectId}\`)`,
      projectId,
      loopCount: state.loopCount,
    };
  }

  // ② loopCount 上限 → LLM を呼ばず停止
  if (state.loopCount >= maxLoop) {
    logger.warn(`[AutoRunner] loopCount 上限到達 (async): ${projectId} (${state.loopCount}/${maxLoop})`);
    saveRunnerState(projectId, {
      enabled:     false,
      pauseReason: `loopCount 上限到達 (${state.loopCount}/${maxLoop})`,
      pausedAt:    new Date().toISOString(),
    });
    syncProjectsEnabled(projectId, false);
    return {
      action:    'stopped',
      summary:   `🛑 **Auto Runner 停止** | \`${projectId}\`\nloopCount 上限 (${state.loopCount}/${maxLoop}) に達しました。\n\`!project runner reset\` でリセット後に再開できます。`,
      projectId,
      loopCount: state.loopCount,
    };
  }

  // ③ loopCount インクリメント
  const nextCount = state.loopCount + 1;
  saveRunnerState(projectId, {
    loopCount:     nextCount,
    lastPlannerAt: new Date().toISOString(),
  });
  logger.info(`[AutoRunner] runPlannerStepAsync: ${projectId} | loop ${nextCount}/${maxLoop}`);

  // ④ planNextTask（FIX/REVIEW/project_done の判定 — 同期版と同じ）
  let plannerResult = null;
  try {
    plannerResult = getPlanner().planNextTask(projectId, context);
    logger.info(`[AutoRunner] Planner結果 (async): ${projectId} | action:${plannerResult.action}`);
  } catch (plannerErr) {
    logger.warn(`[AutoRunner] planNextTask エラー (async): ${plannerErr.message}`);
    plannerResult = { action: 'error', reason: plannerErr.message, suggestedTask: null, summary: 'Planner エラー' };
  }

  // ⑤-pre project_done → runner 停止（FIX/REVIEW より優先）
  if (plannerResult.action === 'project_done') {
    logger.info(`[AutoRunner] project_done 検出 (async): ${projectId} → runner 停止`);
    saveRunnerState(projectId, {
      enabled:     false,
      pauseReason: 'project_done',
      pausedAt:    new Date().toISOString(),
    });
    syncProjectsEnabled(projectId, false);
    return {
      action:        'project_done',
      summary:
        `🎉 **Project Done**\n` +
        `Project: \`${projectId}\`\n` +
        `残作業: 0件\n` +
        `Runner: stopped\n\n` +
        `次:\n\`\`\`\n!project runner status\n\`\`\``,
      projectId,
      loopCount:            nextCount,
      plannerResult,
      createdTask:          null,
      nextExecutableTaskId: null,
    };
  }

  // ⑤ create_task（FIX / REVIEW）— 同期版と同じロジック
  let createdTask     = null;
  let autoAppliedTask = null;
  let plannerSummaryLine;

  if (plannerResult.action === 'create_task' && plannerResult.suggestedTask) {
    const suggested     = plannerResult.suggestedTask;
    const isRegistrable = suggested.type === 'FIX' || suggested.type === 'REVIEW';
    if (!isRegistrable) {
      plannerSummaryLine =
        `Planner: ${suggested.type} 候補あり（未登録）\n` +
        `type: ${suggested.type} | priority: ${suggested.priority}`;
    } else {
      const isDuplicate = (() => {
        try {
          const tm       = require('./task-manager');
          const allTasks = tm.listTasks();
          if (suggested.type === 'REVIEW') {
            const srcId = suggested.sourceImplementId || '';
            return srcId && allTasks.some(t =>
              t.type === 'REVIEW' && t.projectId === projectId &&
              (t.state === tm.STATES.PENDING || t.state === tm.STATES.IN_PROGRESS) &&
              (t.prompt || '').includes(srcId)
            );
          }
          const promptPrefix = (suggested.prompt || '').slice(0, 60);
          return allTasks.some(t =>
            t.type === 'FIX' && t.projectId === projectId &&
            (t.state === tm.STATES.PENDING || t.state === tm.STATES.IN_PROGRESS) &&
            (t.prompt || '').slice(0, 60) === promptPrefix
          );
        } catch { return false; }
      })();

      if (isDuplicate) {
        logger.info(`[AutoRunner] 重複ガード (async): 同内容の ${suggested.type} が既に存在 (${projectId})`);
        plannerSummaryLine =
          `Planner: ${suggested.type} 候補あり (重複のためスキップ)\n` +
          (suggested.type === 'REVIEW'
            ? `元IMPLEMENT: ${suggested.sourceImplementId || '—'}`
            : `危険度: ${suggested.sourceReviewDanger || '—'}`);
      } else {
        try {
          const tm         = require('./task-manager');
          const taskPrompt = (suggested.type === 'REVIEW' && suggested.sourceImplementId)
            ? suggested.prompt + `\n[対象IMPLEMENT: ${suggested.sourceImplementId}]`
            : suggested.prompt;
          createdTask = tm.createTask(
            taskPrompt, 'auto-runner', null,
            suggested.priority === '高' ? '高' : '低',
            projectId, suggested.type || 'FIX'
          );
          if (suggested.priority && createdTask.priority !== suggested.priority) {
            tm.updateTask(createdTask.id, {
              priority:       suggested.priority,
              priorityReason: `Auto Planner 指定 (危険度: ${suggested.sourceReviewDanger || '—'})`,
            });
            createdTask.priority = suggested.priority;
          }
          const currentState = getRunnerState(projectId);
          saveRunnerState(projectId, {
            lastTaskId:        createdTask.id,
            totalTasksCreated: (currentState.totalTasksCreated || 0) + 1,
          });
          logger.info(`[AutoRunner] タスク登録 (async): ${createdTask.id} [${suggested.type}] | ${projectId}`);
          plannerSummaryLine = suggested.type === 'REVIEW'
            ? `Planner: REVIEW タスクを登録しました ✅\nID: \`${createdTask.id}\`\n元IMPLEMENT: ${suggested.sourceImplementId || '—'} | priority: ${createdTask.priority}\n次に実行:\n\`\`\`\n!auto run 1\n\`\`\``
            : `Planner: FIX タスクを登録しました ✅\nID: \`${createdTask.id}\`\n危険度: ${suggested.sourceReviewDanger || '—'} | priority: ${createdTask.priority}\n次に実行:\n\`\`\`\n!auto run 1\n\`\`\``;
        } catch (createErr) {
          logger.error(`[AutoRunner] createTask エラー (async): ${createErr.message}`);
          plannerSummaryLine = `Planner: create_task 試みたが失敗 (${createErr.message.slice(0, 40)})`;
        }
      }
    }

  } else {
    // ── Phase D-7c/D-8: action=none のとき LLM Planner で候補取得 ──
    let nextCandidatesHint = '';

    if (plannerResult.action === 'none') {
      try {
        const pm2           = require('./project-manager');
        const proj2         = pm2.getProject(projectId);
        const description   = (proj2?.description || proj2?.name || '');
        // 完了済みタスクを収集（RESEARCH 重複防止・LLM プロンプトに渡す）
        const doneTasks     = getProjectDoneTasks(projectId);
        const currentState2 = getRunnerState(projectId);
        const SAFE_TYPES    = new Set(['DOCS', 'RESEARCH', 'TEST']);

        // Phase D-8: 頻度制御 — LLM_INTERVAL_STEPS ステップに1回のみ LLM を使用
        // それ以外のステップは rule-based（コスト削減・高速化）
        const shouldUseLLM = (nextCount % LLM_INTERVAL_STEPS === 1);
        let fullPlan;
        let plannerErr = null;
        try {
          if (shouldUseLLM) {
            // doneTasks を渡すことで LLM/rule-based 両方が完了済み RESEARCH を考慮する
            fullPlan = await require('./project-planner').planProjectGoalsBest(
              projectId, { description, doneTasks }
            );
          } else {
            // 頻度制御: rule-based を直接使用（LLM 呼び出しなし）
            const ruleResult = require('./project-planner').planProjectGoals(projectId, { description, doneTasks });
            fullPlan = { ...ruleResult, source: 'rule-based' };
            logger.debug(`[AutoRunner] D-8 頻度制御: step ${nextCount} → rule-based (LLM は ${LLM_INTERVAL_STEPS}ステップに1回)`);
          }
        } catch (plannerApiErr) {
          // LLM/rule-based どちらが失敗しても runner を止めない
          plannerErr = plannerApiErr.message.slice(0, 80);
          logger.warn(`[AutoRunner] D-8 planner エラー → rule-based fallback: ${plannerErr}`);
          const ruleResult = require('./project-planner').planProjectGoals(projectId, { description, doneTasks });
          fullPlan = { ...ruleResult, source: 'rule-based' };
        }

        // Phase D-8: 統計更新
        updatePlannerStats(projectId, fullPlan.source, plannerErr);

        const plannerLabel = fullPlan.source === 'llm' ? '🤖 LLM Planner' : '📋 rule-based';
        const cacheLabel   = fullPlan.fromCache ? ' (cached)' : '';
        logger.info(`[AutoRunner] D-8 plan source: ${plannerLabel}${cacheLabel} | candidates:${fullPlan.nextCandidates.length} | ${projectId}`);

        if (currentState2.autoApplyPlanning && fullPlan.nextCandidates.length > 0) {
          try {
            const tm     = require('./task-manager');
            const allT   = tm.listTasks();
            const ACTIVE = new Set([tm.STATES.PENDING, tm.STATES.IN_PROGRESS]);

            // D-4e: DOCS/RESEARCH/TEST を優先登録
            // 完了済み RESEARCH がある場合は DOCS/TEST を優先（RESEARCH 連続生成防止）
            const hasCompletedResearch = doneTasks.some(d => d.toUpperCase().startsWith('RESEARCH:'));
            const safeCand = hasCompletedResearch
              ? fullPlan.nextCandidates.find(c => SAFE_TYPES.has(c.type) && c.type !== 'RESEARCH')
              : fullPlan.nextCandidates.find(c => SAFE_TYPES.has(c.type));
            if (safeCand) {
              const isDup = allT.some(t =>
                t.projectId === projectId && t.type === safeCand.type && ACTIVE.has(t.state) &&
                (t.prompt || '').slice(0, 30) === (safeCand.prompt || '').slice(0, 30)
              );
              if (!isDup) {
                autoAppliedTask = tm.createTask(
                  safeCand.prompt, 'auto-runner', null,
                  safeCand.priority === '高' ? '高' : '低',
                  projectId, safeCand.type
                );
                const st3 = getRunnerState(projectId);
                saveRunnerState(projectId, {
                  lastTaskId:        autoAppliedTask.id,
                  totalTasksCreated: (st3.totalTasksCreated || 0) + 1,
                });
                logger.info(`[AutoRunner] D-4e auto-apply (${plannerLabel}): ${autoAppliedTask.id} [${safeCand.type}] | ${projectId}`);
                nextCandidatesHint =
                  `\n${plannerLabel} 📋 Auto Apply: [${safeCand.type}] タスクを登録\n` +
                  `\`${autoAppliedTask.id}\`\n` +
                  `次:\n\`\`\`\n!task list\n!auto run 1\n\`\`\``;
              } else {
                nextCandidatesHint =
                  `\n${plannerLabel} 次候補があります (重複のためスキップ):\n` +
                  `\`\`\`\n!project plan apply\n\`\`\``;
              }
            }

            // D-5: IMPLEMENT（D-4e が登録しなかった場合 + PENDING IMPLEMENT なし）
            if (!autoAppliedTask) {
              const hasPendingImpl = allT.some(t =>
                t.projectId === projectId && t.type === 'IMPLEMENT' && ACTIVE.has(t.state)
              );
              if (!hasPendingImpl) {
                const implCand = fullPlan.nextCandidates.find(c => c.type === 'IMPLEMENT');
                if (implCand) {
                  autoAppliedTask = tm.createTask(
                    implCand.prompt, 'auto-runner', null,
                    implCand.priority === '高' ? '高' : '低',
                    projectId, 'IMPLEMENT'
                  );
                  const st5 = getRunnerState(projectId);
                  saveRunnerState(projectId, {
                    lastTaskId:        autoAppliedTask.id,
                    totalTasksCreated: (st5.totalTasksCreated || 0) + 1,
                  });
                  logger.info(`[AutoRunner] D-5 auto-apply IMPLEMENT (${plannerLabel}): ${autoAppliedTask.id} | ${projectId}`);
                  nextCandidatesHint =
                    `\n${plannerLabel} 🔨 Auto Apply: [IMPLEMENT] タスクを登録\n` +
                    `\`${autoAppliedTask.id}\`\n` +
                    `次:\n\`\`\`\n!task list\n!auto run 1\n\`\`\``;
                }
              }
            }
          } catch (applyErr) {
            logger.warn(`[AutoRunner] D-7c auto-apply エラー: ${applyErr.message}`);
          }
        } else if (fullPlan.nextCandidates.length > 0) {
          // autoApplyPlanning=false: ヒントのみ表示
          nextCandidatesHint =
            `\n${plannerLabel} 次候補があります (${fullPlan.nextCandidates.length}件):\n` +
            `\`\`\`\n!project plan\n!project plan apply\n\`\`\``;
        }
      } catch (llmErr) {
        logger.warn(`[AutoRunner] D-7c LLM/fallback エラー（無視）: ${llmErr.message}`);
      }
    }
    plannerSummaryLine = `Planner: ${plannerResult.action}` + nextCandidatesHint;
  }

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
    autoAppliedTask,
  };
}

// ─────────────────────────────────────────────────────
// getResumeCandidates(projectId, options) — Phase E-2
//
// PENDING=0 の場合に Auto Resume できる保留タスクを返す。
//
// 変更点（設計修正）:
//   Auto Resume は「実行許可」ではなく「保留解除」。
//   実行時の安全判定は既存の Auto Policy / danger判定で行うため、
//   Resume 段階では AUTO_SAFE と AI_REVIEW_REQUIRED を両方対象にする。
//   BLOCKED / HUMAN_APPROVAL_REQUIRED のみ除外。
//
// 優先順位: IMPLEMENT > FIX > REFACTOR > DOCS > TEST > REVIEW > RESEARCH
//
// 禁止条件:
//   - policy = BLOCKED or HUMAN_APPROVAL_REQUIRED
//   - size = LARGE
//   - 保留理由/promptにテスト・ダミー系キーワード含む（classifyHoldNote参照）
//   - 同テーマの RESEARCH が DONE 履歴に存在する（RESEARCH のみ）
//   - 同じタスクの resume 試行が 2 回以上ある（stateHistory 確認）
//
// 引数:
//   projectId - プロジェクトID
//   options   - { maxCount: 1 }  返す最大件数
//
// 戻り値: タスクオブジェクトの配列（優先度順）
// ─────────────────────────────────────────────────────
const RESUME_TYPE_PRIORITY = {
  IMPLEMENT: 0,
  FIX:       1,
  REFACTOR:  2,
  DOCS:      3,
  TEST:      4,
  REVIEW:    5,
  RESEARCH:  6,
};

function getResumeCandidates(projectId, options = {}) {
  const { maxCount = 1 } = options;

  try {
    const autoPolicy = require('./auto-policy');
    const tm         = require('./task-manager');
    const { AUTO_POLICY, classifyTask, classifyHoldNote } = autoPolicy;
    const RESUMABLE  = new Set([AUTO_POLICY.AUTO_SAFE, AUTO_POLICY.AI_REVIEW_REQUIRED]);

    // DONE 履歴（RESEARCH 重複チェック用）
    const doneTasks  = getProjectDoneTasks(projectId);

    const allTasks   = tm.listTasks();
    const candidates = allTasks
      .filter(t => {
        if (t.projectId !== projectId)      return false;
        if (t.state !== tm.STATES.ON_HOLD)  return false;
        if ((t.size || '').toUpperCase() === 'LARGE') return false;
        // Phase E-3: split由来タスク（rootTaskId あり）は Auto Resume 対象外
        // 分割タスクは prepareNextTask() が PENDING から自動的に拾う
        if (t.rootTaskId) return false;

        // policy チェック（BLOCKED / HUMAN_APPROVAL_REQUIRED は除外）
        const policy = classifyTask(t, {});
        if (!RESUMABLE.has(policy))         return false;

        // 保留理由・prompt がテスト/ダミー由来なら除外
        const lastNote = _getLastHoldNote(t);
        if (classifyHoldNote(lastNote, t.prompt) === 'UNSAFE') return false;

        // RESEARCH: 同テーマが DONE 履歴にあれば除外（重複防止）
        if ((t.type || '').toUpperCase() === 'RESEARCH') {
          const promptHead = (t.prompt || '').slice(0, 30).toLowerCase();
          const isDoneAlready = doneTasks.some(d =>
            d.toUpperCase().startsWith('RESEARCH:') &&
            d.toLowerCase().includes(promptHead.slice(0, 15))
          );
          if (isDoneAlready) return false;
        }

        // resume 試行 2 回以上は除外
        if (_getResumeAttempts(t) >= 2) return false;

        return true;
      })
      .sort((a, b) => {
        const pa = RESUME_TYPE_PRIORITY[String(a.type).toUpperCase()] ?? 99;
        const pb = RESUME_TYPE_PRIORITY[String(b.type).toUpperCase()] ?? 99;
        return pa - pb;
      });

    return candidates.slice(0, maxCount);
  } catch (e) {
    logger.warn(`[AutoRunner] getResumeCandidates エラー: ${e.message}`);
    return [];
  }
}

// ─── 内部ヘルパー ─────────────────────────────────────

// タスクの最後の保留理由ノートを取得
function _getLastHoldNote(task) {
  const history = task.stateHistory || [];
  const holdEntries = history.filter(h => h.state === '保留');
  return holdEntries.length > 0 ? (holdEntries[holdEntries.length - 1].note || '') : '';
}

// タスクの auto-resume 試行回数を stateHistory から取得
function _getResumeAttempts(task) {
  const history = task.stateHistory || [];
  return history.filter(h =>
    h.state === '未着手' && (h.note || '').includes('auto-resume')
  ).length;
}

module.exports = {
  getRunnerState,
  saveRunnerState,
  enableRunner,
  disableRunner,
  resetRunner,
  formatRunnerStatus,
  runPlannerStep,
  runPlannerStepAsync,
  setAutoApplyPlanning,
  getResumeCandidates,
};
