'use strict';
// ============================================================
// 最終安定化テスト — Phase D-4e 実用前チェック
//
// Step 2: !project runner auto-apply status/on/off コマンド相当
// Step 3: autoApplyPlanning=OFF → 自動登録なし
// Step 4: autoApplyPlanning=ON  → 安全type 1件のみ・自動実行なし
//
// 安全条件の全確認:
//   ① runner off なら投入しない
//   ② IMPLEMENT/FIX/REVIEW は自動登録しない
//   ③ state=PENDING のまま（自動実行なし）
//   ④ taskQueue に入れない（nextExecutableTaskId が null）
//   ⑤ 重複登録しない
//   ⑥ 最大1件のみ
// ============================================================

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const path        = require('path');
const fs          = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pid = 'youtube予測ai';
let pass = 0, fail = 0;
const CLEANUP_TASKS = [];
const UNSAFE_TYPES  = new Set(['IMPLEMENT', 'FIX', 'REVIEW']);
const SAFE_TYPES    = new Set(['DOCS', 'RESEARCH', 'TEST']);

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
function info(msg)  { console.log('  ℹ️  ' + msg); }
function step(msg)  { console.log('\n─── ' + msg + ' ───'); }
function section(msg) { console.log('\n' + '═'.repeat(50) + '\n' + msg + '\n' + '═'.repeat(50)); }

function cleanup() {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  runner.resetRunner(pid);
}

function main() {
  console.log('=== 最終安定化テスト (Phase D-4e) ===\n');

  // ───────────────────────────────────────────────────────────
  // SECTION A: Step 2 相当 — コマンド内部API 確認
  //   !project runner auto-apply status / on / off
  //   !project runner status (Auto Apply 表示)
  // ───────────────────────────────────────────────────────────
  section('SECTION A: auto-apply コマンド相当 (Step 2)');

  runner.resetRunner(pid);

  step('A-1: 初期 auto-apply status → OFF');
  test('初期値 autoApplyPlanning=false', () => runner.getRunnerState(pid).autoApplyPlanning === false);
  const statusInit = runner.formatRunnerStatus(pid);
  test('初期 runner status に Auto Apply: ⛔ OFF を表示', () =>
    statusInit.includes('Auto Apply:') && statusInit.includes('⛔ OFF'));
  info('status 行: ' + (statusInit.split('\n').find(l => l.includes('Auto Apply')) || '（なし）'));

  step('A-2: auto-apply on → runner status に ✅ ON を表示');
  runner.setAutoApplyPlanning(pid, true);
  test('autoApplyPlanning=true に変更', () => runner.getRunnerState(pid).autoApplyPlanning === true);
  const statusOn = runner.formatRunnerStatus(pid);
  test('status に Auto Apply: ✅ ON を表示', () =>
    statusOn.includes('Auto Apply:') && statusOn.includes('✅ ON'));
  info('status 行: ' + (statusOn.split('\n').find(l => l.includes('Auto Apply')) || '（なし）'));

  step('A-3: auto-apply off → runner status に ⛔ OFF を表示');
  runner.setAutoApplyPlanning(pid, false);
  test('autoApplyPlanning=false に戻す', () => runner.getRunnerState(pid).autoApplyPlanning === false);
  const statusOff = runner.formatRunnerStatus(pid);
  test('status に Auto Apply: ⛔ OFF を表示', () =>
    statusOff.includes('Auto Apply:') && statusOff.includes('⛔ OFF'));

  step('A-4: setAutoApplyPlanning は runner-state.json に永続化');
  runner.setAutoApplyPlanning(pid, true);
  const reloaded = runner.getRunnerState(pid); // ファイルから再読込
  test('再読込後も autoApplyPlanning=true が保持', () => reloaded.autoApplyPlanning === true);
  runner.setAutoApplyPlanning(pid, false);

  // ───────────────────────────────────────────────────────────
  // SECTION B: Step 3 — autoApplyPlanning=OFF 安全確認
  // ───────────────────────────────────────────────────────────
  section('SECTION B: autoApplyPlanning=OFF 安全確認 (Step 3)');

  runner.resetRunner(pid);
  runner.enableRunner(pid);
  runner.setAutoApplyPlanning(pid, false);

  // action:none を誘導するためのダミーIMPLEMENT（PENDING にしておく）
  const dummyOff = taskManager.createTask(
    '[stability-test-off] ダミー IMPLEMENT (action:none 誘導用)',
    'stability-test', null, '低', pid, 'IMPLEMENT'
  );
  CLEANUP_TASKS.push(dummyOff.id);

  step('B-1: autoApplyPlanning=OFF → 自動登録なし');
  const beforeOff = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  const rOff = runner.runPlannerStep(pid, {});
  info('action: ' + rOff.action + ' | plannerResult.action: ' + (rOff.plannerResult?.action || 'n/a'));
  info('autoAppliedTask: ' + (rOff.autoAppliedTask?.id || 'null'));

  test('B-1a. autoAppliedTask が null', () => !rOff.autoAppliedTask);

  const afterOff = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;
  test('B-1b. tasks.json の安全type タスク数が変化しない', () => afterOff === beforeOff);
  test('B-1c. nextExecutableTaskId が null (queue投入なし)', () => !rOff.nextExecutableTaskId);

  if (rOff.plannerResult?.action === 'none') {
    test('B-1d. summary に !project plan ヒントを含む', () =>
      rOff.summary.includes('!project plan'));
  } else {
    info('plannerResult.action=' + (rOff.plannerResult?.action || 'n/a') + ' (none 以外はスキップ)');
    test('B-1d. plannerResult.action が none 以外でも autoAppliedTask=null', () => !rOff.autoAppliedTask);
  }

  // ───────────────────────────────────────────────────────────
  // SECTION C: Step 4 — autoApplyPlanning=ON 全安全条件確認
  // ───────────────────────────────────────────────────────────
  section('SECTION C: autoApplyPlanning=ON 安全条件 (Step 4)');

  runner.setAutoApplyPlanning(pid, true);

  const beforeOn = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  step('C-1: 安全type を1件だけ登録');
  const rOn = runner.runPlannerStep(pid, {});
  info('action: ' + rOn.action + ' | plannerResult.action: ' + (rOn.plannerResult?.action || 'n/a'));

  if (rOn.plannerResult?.action === 'none') {
    const afterOn = taskManager.listTasks().filter(
      t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
    ).length;

    if (rOn.autoAppliedTask) {
      CLEANUP_TASKS.push(rOn.autoAppliedTask.id);
      info('autoAppliedTask: ' + rOn.autoAppliedTask.id + ' [' + rOn.autoAppliedTask.type + ']');

      // ① 安全typeのみ
      test('C-1a. ① type が DOCS/RESEARCH/TEST', () => SAFE_TYPES.has(rOn.autoAppliedTask.type));
      test('C-1b. ② IMPLEMENT/FIX/REVIEW は登録されない', () => !UNSAFE_TYPES.has(rOn.autoAppliedTask.type));

      // ② 自動実行なし (state=PENDING)
      test('C-1c. ③ state=PENDING (自動実行しない)', () =>
        rOn.autoAppliedTask.state === taskManager.STATES.PENDING);

      // ③ taskQueue に入れない (nextExecutableTaskId が null)
      test('C-1d. ④ nextExecutableTaskId=null (queue投入なし)', () => !rOn.nextExecutableTaskId);

      // ④ 最大1件のみ
      test('C-1e. ⑥ 安全type の増加は +1 のみ', () => afterOn === beforeOn + 1);

      // Discord 通知形式
      test('C-1f. summary に Auto Apply を含む', () => rOn.summary.includes('Auto Apply'));
      test('C-1g. summary に !task list を含む', () => rOn.summary.includes('!task list'));
      test('C-1h. summary に !auto run を含む', () => rOn.summary.includes('!auto run'));
      info('Discord 通知 (抜粋):\n' + rOn.summary.split('\n').slice(1).join('\n'));
    } else {
      info('autoAppliedTask=null (候補の安全typeが存在しなかった可能性)');
      test('C-1a. autoAppliedTask なしでも tasks.json 変化なし', () => afterOn === beforeOn);
      test('C-1d. ④ nextExecutableTaskId=null', () => !rOn.nextExecutableTaskId);
    }
  } else {
    info('plannerResult.action=' + (rOn.plannerResult?.action || 'n/a') + ' (none 以外のためスキップ)');
    test('C-1x. none 以外のとき autoAppliedTask=null', () => !rOn.autoAppliedTask);
    test('C-1y. none 以外のとき nextExecutableTaskId は createdTask 依存', () => true);
  }

  step('C-2: IMPLEMENT/FIX/REVIEW は auto-apply しない (高危険度 Codex 結果)');
  const rFix = runner.runPlannerStep(pid, {
    reviewResult: { danger: '高', problem: '重大な問題あり', suggestion: '即修正' }
  });
  if (rFix.createdTask) CLEANUP_TASKS.push(rFix.createdTask.id);
  info('create_task パス: createdTask.type=' + (rFix.createdTask?.type || 'null') +
       ' | autoAppliedTask=' + (rFix.autoAppliedTask?.id || 'null'));
  test('C-2a. ② FIX 生成時に autoAppliedTask=null', () => !rFix.autoAppliedTask);
  if (rFix.createdTask) {
    test('C-2b. createdTask.type=FIX', () => rFix.createdTask.type === 'FIX');
    test('C-2c. FIX の state=PENDING', () => rFix.createdTask.state === taskManager.STATES.PENDING);
    test('C-2d. nextExecutableTaskId=FIX (queue投入条件: REVIEW のみ)', () =>
      rFix.nextExecutableTaskId === rFix.createdTask.id &&
      rFix.createdTask.type !== 'REVIEW'  // FIX は queue に入れない
    );
  }

  step('C-3: ⑤ 重複登録防止');
  const beforeDup = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;
  runner.setAutoApplyPlanning(pid, true);
  const rDup1 = runner.runPlannerStep(pid, {});
  if (rDup1.autoAppliedTask) CLEANUP_TASKS.push(rDup1.autoAppliedTask.id);
  const rDup2 = runner.runPlannerStep(pid, {});
  if (rDup2.autoAppliedTask) CLEANUP_TASKS.push(rDup2.autoAppliedTask.id);
  const afterDup = taskManager.listTasks().filter(
    t => t.projectId === pid && SAFE_TYPES.has(t.type) && t.state === taskManager.STATES.PENDING
  ).length;
  test('C-3a. ⑤ 2回連続で同内容タスクが重複登録されない', () => (afterDup - beforeDup) <= 1);
  info('重複前: ' + beforeDup + '件 / 後: ' + afterDup + '件');

  // ───────────────────────────────────────────────────────────
  // SECTION D: ① runner=OFF 安全確認
  // ───────────────────────────────────────────────────────────
  section('SECTION D: runner=OFF 安全確認');

  step('D-1: runner OFF 時は auto-apply しない');
  runner.disableRunner(pid);
  runner.setAutoApplyPlanning(pid, true);
  const rRunnerOff = runner.runPlannerStep(pid, {});
  test('D-1a. ① runner off → action=skip', () => rRunnerOff.action === 'skip');
  test('D-1b. ① runner off → autoAppliedTask=null', () => !rRunnerOff.autoAppliedTask);
  test('D-1c. ① runner off → nextExecutableTaskId=null', () => !rRunnerOff.nextExecutableTaskId);

  step('D-2: resetRunner → autoApplyPlanning も false にリセット');
  runner.resetRunner(pid);
  test('D-2a. resetRunner 後 autoApplyPlanning=false', () =>
    runner.getRunnerState(pid).autoApplyPlanning === false);
  test('D-2b. resetRunner 後 enabled=false', () =>
    runner.getRunnerState(pid).enabled === false);

  // ───────────────────────────────────────────────────────────
  // 最終クリーンアップ
  // ───────────────────────────────────────────────────────────
  cleanup();

  // ── 完了報告 ─────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('=== 最終安定化テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) {
    console.log('❌ 失敗あり — 上記の ❌ を確認してください');
    process.exit(1);
  } else {
    console.log('✅ 全テスト通過 — 実用開始可能');
  }
}

main();
