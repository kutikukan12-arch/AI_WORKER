'use strict';
// Phase D-4e: autoApplyPlanning 単体テスト
// - autoApplyPlanning の ON/OFF
// - DOCS/RESEARCH/TEST のみ自動登録
// - IMPLEMENT/FIX/REVIEW は自動登録しない
// - 最大1件のみ登録
// - 重複登録防止
// - 自動実行しない（PENDING のまま）

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const path        = require('path');
const fs          = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pid = 'youtube予測ai';
let pass = 0, fail = 0;
const CLEANUP_TASKS = [];

const SAFE_TYPES = new Set(['DOCS', 'RESEARCH', 'TEST']);

function test(label, fn) {
  try {
    const ok = fn();
    ok ? pass++ : fail++;
    console.log((ok ? '✅' : '❌') + ' ' + label);
  } catch (e) {
    fail++;
    console.log('❌ ' + label + ' — ' + e.message.slice(0, 80));
  }
}
function info(msg) { console.log('  ℹ️  ' + msg); }
function step(msg) { console.log('\n─── ' + msg + ' ───'); }

function cleanup() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tasks.json'), 'utf8'));
  raw.tasks = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'tasks.json'), JSON.stringify(raw, null, 2), 'utf8');
  runner.resetRunner(pid);
}

function main() {
  console.log('=== Phase D-4e: autoApplyPlanning テスト ===\n');

  // ── STEP 1: 初期状態確認 ─────────────────────────────
  step('STEP 1: 初期状態確認');
  runner.resetRunner(pid);
  const s0 = runner.getRunnerState(pid);
  test('初期値 autoApplyPlanning=false', () => s0.autoApplyPlanning === false);
  test('初期値 enabled=false', () => s0.enabled === false);
  info('autoApplyPlanning: ' + s0.autoApplyPlanning);

  // ── STEP 2: setAutoApplyPlanning ON/OFF ──────────────
  step('STEP 2: setAutoApplyPlanning ON/OFF');
  runner.setAutoApplyPlanning(pid, true);
  test('ON: autoApplyPlanning=true', () => runner.getRunnerState(pid).autoApplyPlanning === true);
  runner.setAutoApplyPlanning(pid, false);
  test('OFF: autoApplyPlanning=false', () => runner.getRunnerState(pid).autoApplyPlanning === false);
  runner.setAutoApplyPlanning(pid, true);
  test('再ON: autoApplyPlanning=true', () => runner.getRunnerState(pid).autoApplyPlanning === true);

  // ── STEP 3: formatRunnerStatus に autoApplyPlanning 表示 ─
  step('STEP 3: formatRunnerStatus に Auto Apply 表示');
  const status = runner.formatRunnerStatus(pid);
  test('status に Auto Apply: ✅ ON を含む', () => status.includes('Auto Apply:') && status.includes('✅ ON'));
  info('status 抜粋: ' + status.split('\n').find(l => l.includes('Auto Apply')) || '（なし）');

  runner.setAutoApplyPlanning(pid, false);
  const statusOff = runner.formatRunnerStatus(pid);
  test('status に Auto Apply: ⛔ OFF を含む', () => statusOff.includes('Auto Apply:') && statusOff.includes('⛔ OFF'));

  // ── STEP 4: autoApplyPlanning=false のとき自動登録しない ─
  step('STEP 4: autoApplyPlanning=OFF → 自動登録なし');
  runner.resetRunner(pid);
  runner.enableRunner(pid);
  runner.setAutoApplyPlanning(pid, false);

  // 残作業ゼロだと project_done になるので PENDING タスクを1件用意
  const dummyTask = taskManager.createTask(
    '[D4e-test] ダミータスク（action:none を誘導するための保留）',
    'test-d4e', null, '低', pid, 'IMPLEMENT'
  );
  CLEANUP_TASKS.push(dummyTask.id);
  info('ダミーIMPLEMENT タスク: ' + dummyTask.id);

  const r_off = runner.runPlannerStep(pid, {});
  test('autoApplyPlanning=OFF: autoAppliedTask なし', () => !r_off.autoAppliedTask);
  test('autoApplyPlanning=OFF: action=step', () => r_off.action === 'step');
  // ヒントテキストが含まれているか（!project plan が提案される）
  if (r_off.plannerResult?.action === 'none') {
    test('OFF: summary に !project plan ヒントを含む', () => r_off.summary.includes('!project plan'));
  } else {
    info('plannerResult.action=' + (r_off.plannerResult?.action || 'n/a') + '（none 以外は skip）');
    test('OFF: autoAppliedTask なし（none 以外でも）', () => !r_off.autoAppliedTask);
  }

  // ── STEP 5: autoApplyPlanning=ON → 安全type を1件登録 ─
  step('STEP 5: autoApplyPlanning=ON → DOCS/RESEARCH/TEST を1件だけ登録');
  runner.setAutoApplyPlanning(pid, true);

  const beforeCount = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  const r_on = runner.runPlannerStep(pid, {});
  info('action: ' + r_on.action);
  info('plannerResult.action: ' + (r_on.plannerResult?.action || 'n/a'));
  info('autoAppliedTask: ' + (r_on.autoAppliedTask?.id || 'null'));

  if (r_on.plannerResult?.action === 'none') {
    // nextCandidates が存在すれば1件登録されるはず
    const afterCount = taskManager.listTasks().filter(
      t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
    ).length;

    if (r_on.autoAppliedTask) {
      CLEANUP_TASKS.push(r_on.autoAppliedTask.id);
      test('5a. autoAppliedTask が生成された', () => !!r_on.autoAppliedTask);
      test('5b. type が安全系 (DOCS/RESEARCH/TEST)', () => SAFE_TYPES.has(r_on.autoAppliedTask.type));
      test('5c. 状態が PENDING (自動実行しない)', () => r_on.autoAppliedTask.state === taskManager.STATES.PENDING);
      test('5d. projectId が一致', () => r_on.autoAppliedTask.projectId === pid);
      test('5e. 登録数は +1 のみ（最大1件）', () => afterCount === beforeCount + 1);
      test('5f. summary に Auto Apply を含む', () => r_on.summary.includes('Auto Apply'));
      test('5g. summary に次コマンドを含む', () => r_on.summary.includes('!task list') || r_on.summary.includes('!auto run'));
      info('登録タスク type: ' + r_on.autoAppliedTask.type);
      info('登録タスク id: ' + r_on.autoAppliedTask.id);
    } else {
      // nextCandidates に安全typeがない場合もある（設定依存）
      info('安全type候補なし → autoAppliedTask=null は正常');
      test('5a. autoAppliedTask=null でも登録数は変化なし', () => afterCount === beforeCount);
    }
  } else {
    info('plannerResult.action=' + (r_on.plannerResult?.action || 'n/a') + ' → none 以外のためスキップ');
    test('5x. action=none 以外のとき autoAppliedTask なし', () => !r_on.autoAppliedTask);
  }

  // ── STEP 6: IMPLEMENT/FIX/REVIEW は自動登録しない ────
  step('STEP 6: IMPLEMENT/FIX/REVIEW は autoApply しない');
  // runPlannerStep が create_task (FIX/REVIEW) を返すケースでは autoAppliedTask は生成しない
  // Codex 高危険度をシミュレート
  const dangerCtx = { reviewResult: { danger: '高', problem: 'テスト用高危険度', suggestion: '修正してください' } };
  const r_fix = runner.runPlannerStep(pid, dangerCtx);
  if (r_fix.createdTask) CLEANUP_TASKS.push(r_fix.createdTask.id);
  info('FIX ケース: plannerResult.action=' + (r_fix.plannerResult?.action || 'n/a'));
  info('createdTask type: ' + (r_fix.createdTask?.type || 'null'));
  info('autoAppliedTask: ' + (r_fix.autoAppliedTask?.id || 'null'));
  test('FIX 生成時に autoAppliedTask は null', () => !r_fix.autoAppliedTask);
  if (r_fix.createdTask) {
    test('FIX タスクの type=FIX', () => r_fix.createdTask.type === 'FIX');
  }

  // ── STEP 7: 重複登録防止 ─────────────────────────────
  step('STEP 7: 重複登録防止');
  runner.setAutoApplyPlanning(pid, true);

  const countBefore7 = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  // 2回連続で runPlannerStep を呼ぶ
  const r_dup1 = runner.runPlannerStep(pid, {});
  if (r_dup1.autoAppliedTask) CLEANUP_TASKS.push(r_dup1.autoAppliedTask.id);

  const r_dup2 = runner.runPlannerStep(pid, {});
  if (r_dup2.autoAppliedTask) CLEANUP_TASKS.push(r_dup2.autoAppliedTask.id);

  const countAfter7 = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  info('2回呼び出し前: ' + countBefore7 + '件 / 後: ' + countAfter7 + '件');
  test('重複防止: 同内容タスクが2件以上登録されない', () => (countAfter7 - countBefore7) <= 1);

  // ── STEP 8: runner OFF 時は auto-apply しない ─────────
  step('STEP 8: runner OFF 時は auto-apply しない');
  runner.disableRunner(pid);
  runner.setAutoApplyPlanning(pid, true);
  const r_roff = runner.runPlannerStep(pid, {});
  test('runner OFF: action=skip', () => r_roff.action === 'skip');
  test('runner OFF: autoAppliedTask なし', () => !r_roff.autoAppliedTask);

  // ── STEP 9: 最終状態確認 ─────────────────────────────
  step('STEP 9: 最終 runner state 確認');
  const finalState = runner.getRunnerState(pid);
  info('autoApplyPlanning: ' + finalState.autoApplyPlanning);
  info('enabled: ' + finalState.enabled);
  info('loopCount: ' + finalState.loopCount);
  info('totalTasksCreated: ' + finalState.totalTasksCreated);
  // resetRunner は autoApplyPlanning を false にリセットする
  runner.resetRunner(pid);
  test('resetRunner 後 autoApplyPlanning=false', () => runner.getRunnerState(pid).autoApplyPlanning === false);

  // クリーンアップ
  cleanup();

  // ── 完了報告 ─────────────────────────────────────────
  console.log('\n=== テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) process.exit(1);
}

main();
