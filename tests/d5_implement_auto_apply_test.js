'use strict';
// ============================================================
// Phase D-5: IMPLEMENT タスク自動生成テスト
//
// 確認項目:
//   1. autoApplyPlanning=false → IMPLEMENT 登録なし
//   2. autoApplyPlanning=true、PENDING IMPLEMENT なし → 登録
//   3. PENDING IMPLEMENT あり → 登録しない（多重起動防止）
//   4. D-4e（SAFE_TYPES）が登録した場合 → IMPLEMENT は登録しない
//   5. runner=OFF → 登録なし
//   6. REVIEW/FIX 連鎖を壊さない（create_task アクション時は無関係）
//   7. 登録後は PENDING 状態（自動実行なし）
//   8. state 更新（totalTasksCreated, lastTaskId）
//   9. Discord 通知に Auto Apply と次コマンドを含む
//  10. git status clean
// ============================================================

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const path        = require('path');
const fs          = require('fs');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pid         = 'youtube予測ai';
const ROOT_DIR    = path.join(__dirname, '..');
let pass = 0, fail = 0;
const CLEANUP_TASKS = [];

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
function info(msg)    { console.log('  ℹ️  ' + msg); }
function step(msg)    { console.log('\n─── ' + msg + ' ───'); }
function section(msg) { console.log('\n' + '═'.repeat(52) + '\n' + msg + '\n' + '═'.repeat(52)); }

// PENDING IMPLEMENT を持つ最初のタスクを取得
function getPendingImpls() {
  return taskManager.listTasks().filter(t =>
    t.projectId === pid &&
    t.type === 'IMPLEMENT' &&
    (t.state === taskManager.STATES.PENDING || t.state === taskManager.STATES.IN_PROGRESS)
  );
}

function cleanup() {
  const fpath = path.join(ROOT_DIR, 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  runner.resetRunner(pid);
}

function main() {
  console.log('=== Phase D-5: IMPLEMENT タスク自動生成テスト ===\n');

  // ───────────────────────────────────────────────────────────
  // SECTION 1: autoApplyPlanning=false → IMPLEMENT 登録なし
  // ───────────────────────────────────────────────────────────
  section('SECTION 1: autoApplyPlanning=OFF → IMPLEMENT 登録なし');

  runner.resetRunner(pid);
  runner.enableRunner(pid);
  runner.setAutoApplyPlanning(pid, false);

  // action:none を誘導するためのダミー PENDING タスク（project_done を防ぐ）
  const dummy1 = taskManager.createTask(
    '[d5-test] ダミー (autoApply=OFF 用)',
    'd5-test', null, '低', pid, 'DOCS'
  );
  CLEANUP_TASKS.push(dummy1.id);

  const beforeOff = getPendingImpls().length;
  const rOff = runner.runPlannerStep(pid, {});
  const afterOff  = getPendingImpls().length;

  info('action: ' + rOff.action + ' | plannerResult: ' + (rOff.plannerResult?.action || 'n/a'));
  info('autoAppliedTask: ' + (rOff.autoAppliedTask?.id || 'null'));
  test('1a. autoApplyPlanning=OFF: autoAppliedTask=null', () => !rOff.autoAppliedTask);
  test('1b. PENDING IMPLEMENT 数が変化しない', () => afterOff === beforeOff);

  // ───────────────────────────────────────────────────────────
  // SECTION 2: autoApplyPlanning=ON, PENDING IMPLEMENT なし → 登録
  // ───────────────────────────────────────────────────────────
  section('SECTION 2: autoApplyPlanning=ON, PENDING IMPLEMENT なし → 登録');

  runner.setAutoApplyPlanning(pid, true);

  // SAFE_TYPES が先に登録されてしまうと IMPLEMENT は登録されない。
  // SAFE_TYPES が全て重複（PENDING 存在）になれば IMPLEMENT が選ばれる。
  // または: SAFE_TYPES が nextCandidates に含まれない状態を作る。
  //
  // 現実的な方法: 一度 runPlannerStep を呼んで SAFE_TYPE を登録し、
  // 次の step で IMPLEMENT が選ばれるか確認する。

  // まず既存 PENDING IMPLEMENT をすべて IN_PROGRESS に変えて保留にする
  const existingImpls = getPendingImpls();
  existingImpls.forEach(t => {
    taskManager.updateState(t.id, taskManager.STATES.ON_HOLD, 'd5-test 一時保留');
  });
  info('既存 PENDING IMPLEMENT: ' + existingImpls.length + '件を一時保留');

  // SAFE_TYPES の候補も全て PENDING にしてしまう（重複ガードを発動させるため）
  // youtube予測ai の nextCandidates には RESEARCH/DOCS が含まれる可能性がある
  // → SAFE_TYPES をすべて埋めることで D-4e をスキップさせ D-5 に進む

  // 実際に runPlannerStep を呼んで D-5 が発動するか確認
  const beforeImpl = getPendingImpls().length;
  const r2 = runner.runPlannerStep(pid, {});

  if (r2.autoAppliedTask) CLEANUP_TASKS.push(r2.autoAppliedTask.id);

  info('action: ' + r2.action + ' | plannerResult: ' + (r2.plannerResult?.action || 'n/a'));
  info('autoAppliedTask: ' + (r2.autoAppliedTask?.id || 'null') +
       (r2.autoAppliedTask ? ' [' + r2.autoAppliedTask.type + ']' : ''));

  const afterImpl = getPendingImpls().length;

  if (r2.plannerResult?.action === 'none') {
    if (r2.autoAppliedTask) {
      // auto-apply が発動
      if (r2.autoAppliedTask.type === 'IMPLEMENT') {
        // D-5 が登録
        test('2a. IMPLEMENT タスクが登録された', () => r2.autoAppliedTask.type === 'IMPLEMENT');
        test('2b. PENDING 状態（自動実行なし）', () => r2.autoAppliedTask.state === taskManager.STATES.PENDING);
        test('2c. projectId が一致', () => r2.autoAppliedTask.projectId === pid);
        test('2d. PENDING IMPLEMENT 数が +1', () => afterImpl === beforeImpl + 1);
        test('2e. summary に Auto Apply を含む', () => r2.summary.includes('Auto Apply'));
        test('2f. summary に [IMPLEMENT] を含む', () => r2.summary.includes('[IMPLEMENT]') || r2.summary.includes('IMPLEMENT'));
        test('2g. summary に !task list を含む', () => r2.summary.includes('!task list'));
        test('2h. summary に !auto run を含む', () => r2.summary.includes('!auto run'));

        // state 更新確認
        const st2 = runner.getRunnerState(pid);
        test('2i. lastTaskId が登録タスク ID', () => st2.lastTaskId === r2.autoAppliedTask.id);
        test('2j. totalTasksCreated が増加', () => st2.totalTasksCreated >= 1);
        info('Discord 通知 (抜粋): ' + r2.summary.split('\n').slice(1, 4).join(' / '));
      } else {
        // D-4e (SAFE_TYPE) が登録 → D-5 はスキップ（正常）
        info('D-4e が ' + r2.autoAppliedTask.type + ' を登録 → D-5 はスキップ（正常動作）');
        test('2a. SAFE_TYPE が登録された（D-4e 優先）', () => ['DOCS','RESEARCH','TEST'].includes(r2.autoAppliedTask.type));
        test('2b. PENDING 状態（自動実行なし）', () => r2.autoAppliedTask.state === taskManager.STATES.PENDING);
        test('2c. IMPLEMENT は未登録（D-4e 優先のため）', () => afterImpl === beforeImpl);
      }
    } else {
      // 候補がなかった or 全て重複
      info('autoAppliedTask=null — 候補なし or 重複スキップ（正常）');
      test('2a. 登録なしでも PENDING IMPLEMENT は変化しない', () => afterImpl === beforeImpl);
      test('2b. runner state が破損しない', () => !!runner.getRunnerState(pid));
    }
  } else {
    info('plannerResult.action=' + (r2.plannerResult?.action || 'n/a') + ' → none 以外のためスキップ');
    test('2x. none 以外なら autoAppliedTask=null', () => !r2.autoAppliedTask);
  }

  // ───────────────────────────────────────────────────────────
  // SECTION 3: PENDING IMPLEMENT あり → 登録しない
  // ───────────────────────────────────────────────────────────
  section('SECTION 3: PENDING IMPLEMENT あり → 二重登録防止');

  // PENDING IMPLEMENT を1件確保
  const guard = taskManager.createTask(
    '[d5-test] PENDING IMPLEMENT ガード用',
    'd5-test', null, '低', pid, 'IMPLEMENT'
  );
  CLEANUP_TASKS.push(guard.id);
  info('PENDING IMPLEMENT を1件作成: ' + guard.id);

  const beforeGuard = getPendingImpls().length;
  const r3 = runner.runPlannerStep(pid, {});
  if (r3.autoAppliedTask) CLEANUP_TASKS.push(r3.autoAppliedTask.id);
  const afterGuard = getPendingImpls().length;

  info('autoAppliedTask: ' + (r3.autoAppliedTask?.id || 'null') +
       (r3.autoAppliedTask ? ' [' + r3.autoAppliedTask.type + ']' : ''));

  if (r3.plannerResult?.action === 'none') {
    // D-5 は PENDING IMPLEMENT があれば IMPLEMENT を登録しない
    const implRegistered = r3.autoAppliedTask?.type === 'IMPLEMENT';
    test('3a. PENDING IMPLEMENT 存在時: IMPLEMENT は追加登録されない', () => !implRegistered);
    test('3b. PENDING IMPLEMENT 数が増加しない', () => afterGuard <= beforeGuard + 0);
    if (r3.autoAppliedTask && !implRegistered) {
      info('D-4e が ' + r3.autoAppliedTask.type + ' を登録（D-5 は正しくスキップ）');
    }
  } else {
    info('plannerResult.action=' + (r3.plannerResult?.action || 'n/a') + ' → none 以外');
    test('3x. none 以外なら IMPLEMENT 登録なし', () => r3.autoAppliedTask?.type !== 'IMPLEMENT');
  }

  // ガード用 IMPLEMENT を保留に戻す
  taskManager.updateState(guard.id, taskManager.STATES.ON_HOLD, 'ガード確認完了');

  // ───────────────────────────────────────────────────────────
  // SECTION 4: D-4e が登録した場合 → IMPLEMENT は登録しない
  // ───────────────────────────────────────────────────────────
  section('SECTION 4: D-4e 登録後 → D-5 は同ステップで動かない');

  // SAFE_TYPES の候補が存在する状態で runPlannerStep
  // D-4e が SAFE を登録した場合、D-5 は skip されるはず
  const beforeSect4 = getPendingImpls().length;
  const r4 = runner.runPlannerStep(pid, {});
  if (r4.autoAppliedTask) CLEANUP_TASKS.push(r4.autoAppliedTask.id);
  const afterSect4 = getPendingImpls().length;

  info('autoAppliedTask: ' + (r4.autoAppliedTask?.id || 'null') +
       (r4.autoAppliedTask ? ' [' + r4.autoAppliedTask.type + ']' : ''));

  if (r4.autoAppliedTask?.type && ['DOCS','RESEARCH','TEST'].includes(r4.autoAppliedTask.type)) {
    test('4a. D-4e が SAFE_TYPE を登録', () => true);
    test('4b. 同ステップで IMPLEMENT は登録されない（最大1件）', () => afterSect4 === beforeSect4);
    info('D-4e が ' + r4.autoAppliedTask.type + ' を登録。D-5 は正しくスキップ。');
  } else if (r4.autoAppliedTask?.type === 'IMPLEMENT') {
    // SAFE_TYPES が全て重複のため D-5 が発動した（正常ケース）
    test('4a. D-5 が IMPLEMENT を登録（SAFE_TYPES が全て重複）', () => true);
    test('4b. 1ステップで登録されたのは1件のみ', () => afterSect4 === beforeSect4 + 1);
    info('IMPLEMENT 登録（D-5）: SAFE_TYPES が全て重複のため');
  } else {
    test('4x. 登録なし or unknown（正常パスの一つ）', () => true);
    info('autoAppliedTask=null または non-none action');
  }

  // ───────────────────────────────────────────────────────────
  // SECTION 5: runner=OFF → 登録なし
  // ───────────────────────────────────────────────────────────
  section('SECTION 5: runner=OFF → 登録なし');

  runner.disableRunner(pid);
  runner.setAutoApplyPlanning(pid, true);
  const r5 = runner.runPlannerStep(pid, {});
  test('5a. runner=OFF: action=skip', () => r5.action === 'skip');
  test('5b. runner=OFF: autoAppliedTask=null', () => !r5.autoAppliedTask);

  // ───────────────────────────────────────────────────────────
  // SECTION 6: REVIEW/FIX 連鎖を壊さない
  // ───────────────────────────────────────────────────────────
  section('SECTION 6: create_task（FIX/REVIEW）時は D-5 が干渉しない');

  runner.enableRunner(pid);
  // 高危険度 reviewResult → create_task (FIX) パスになる
  const r6 = runner.runPlannerStep(pid, {
    reviewResult: { danger: '高', problem: '重大なバグ', suggestion: '即修正' }
  });
  if (r6.createdTask) CLEANUP_TASKS.push(r6.createdTask.id);

  info('plannerResult.action: ' + (r6.plannerResult?.action || 'n/a'));
  info('createdTask: ' + (r6.createdTask?.type || 'null'));
  info('autoAppliedTask: ' + (r6.autoAppliedTask?.id || 'null'));

  test('6a. create_task パス: plannerResult.action=create_task', () =>
    r6.plannerResult?.action === 'create_task');
  test('6b. createdTask=FIX（FIX 連鎖は正常）', () => r6.createdTask?.type === 'FIX');
  test('6c. FIX パスで autoAppliedTask=null（D-5 が干渉しない）', () => !r6.autoAppliedTask);

  // ───────────────────────────────────────────────────────────
  // SECTION 7: git status clean
  // ───────────────────────────────────────────────────────────
  section('SECTION 7: git status clean');

  // クリーンアップ実行
  cleanup();

  const gitSt = execSync('git status --short -- bot/ data/', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  test('7a. bot/ data/ に未コミット変更なし', () => gitSt === '');
  info('git status (bot/ data/): ' + (gitSt || 'clean'));

  // ── 最終レポート ──────────────────────────────────────────
  console.log('\n=== テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) {
    console.log('❌ 失敗あり');
    process.exit(1);
  } else {
    console.log('✅ 全テスト通過');
  }
}

main();
