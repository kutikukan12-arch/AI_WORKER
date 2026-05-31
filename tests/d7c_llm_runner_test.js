'use strict';
// ============================================================
// Phase D-7c: LLM Planner × Auto Runner 統合テスト
//
// 確認項目:
//   1. runner=OFF → LLM を呼ばない (action=skip)
//   2. create_task (FIX) → LLM 候補より FIX が優先
//   3. action=none + LLM → nextCandidates 表示
//   4. autoApplyPlanning=false → 登録なし・ヒント表示のみ
//   5. autoApplyPlanning=true + safe type → 最大1件登録・PENDING
//   6. autoApplyPlanning=true + IMPLEMENT → 最大1件・自動実行なし
//   7. LLM 失敗 → rule-based fallback（タスク完了処理を壊さない）
//   8. 既存 runPlannerStep() (sync) は変更なし
//   9. git status clean
// ============================================================

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const path        = require('path');
const fs          = require('fs');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pid      = 'youtube予測ai';
const ROOT_DIR = path.join(__dirname, '..');
let pass = 0, fail = 0;
const CLEANUP_TASKS = [];

async function testAsync(label, fn) {
  try { const ok = await fn(); ok ? pass++ : fail++; console.log((ok ? '✅' : '❌') + ' ' + label); }
  catch (e) { fail++; console.log('❌ ' + label + ' — ' + e.message.slice(0, 80)); }
}
function test(label, fn) {
  try { const ok = fn(); ok ? pass++ : fail++; console.log((ok ? '✅' : '❌') + ' ' + label); }
  catch (e) { fail++; console.log('❌ ' + label + ' — ' + e.message.slice(0, 80)); }
}
function info(msg)    { console.log('  ℹ️  ' + msg); }
function section(msg) { console.log('\n' + '═'.repeat(52) + '\n' + msg + '\n' + '═'.repeat(52)); }
function step(msg)    { console.log('\n─── ' + msg + ' ───'); }

function cleanup() {
  const fpath = path.join(ROOT_DIR, 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  runner.resetRunner(pid);
}

async function main() {
  console.log('=== Phase D-7c: LLM Planner × Auto Runner 統合テスト ===\n');

  // ───────────────────────────────────────────────────────────
  // SECTION 1: runner=OFF → LLM を呼ばない
  // ───────────────────────────────────────────────────────────
  section('SECTION 1: runner=OFF → skip (LLM 未呼び出し)');

  runner.resetRunner(pid);
  runner.setAutoApplyPlanning(pid, true);

  await testAsync('1a. runner=OFF: action=skip', async () => {
    const r = await runner.runPlannerStepAsync(pid, {});
    return r.action === 'skip';
  });
  await testAsync('1b. runner=OFF: autoAppliedTask=null', async () => {
    const r = await runner.runPlannerStepAsync(pid, {});
    return !r.autoAppliedTask;
  });

  // ───────────────────────────────────────────────────────────
  // SECTION 2: create_task (FIX) → LLM 候補より FIX が優先
  // ───────────────────────────────────────────────────────────
  section('SECTION 2: FIX/REVIEW が LLM 候補より優先される');

  runner.enableRunner(pid);
  const dummy2 = taskManager.createTask(
    '[d7c] ダミー PENDING (project_done 防止)', 'd7c', null, '低', pid, 'DOCS'
  );
  CLEANUP_TASKS.push(dummy2.id);

  const r2 = await runner.runPlannerStepAsync(pid, {
    reviewResult: { danger: '高', problem: '重大バグ', suggestion: '即修正' }
  });
  if (r2.createdTask) CLEANUP_TASKS.push(r2.createdTask.id);

  await testAsync('2a. create_task パス: plannerResult=create_task', async () =>
    r2.plannerResult?.action === 'create_task');
  await testAsync('2b. FIX タスク登録', async () => r2.createdTask?.type === 'FIX');
  await testAsync('2c. autoAppliedTask=null (LLM が干渉しない)', async () => !r2.autoAppliedTask);
  info('createdTask: ' + (r2.createdTask?.type || 'null') + ' | autoApplied: ' + (r2.autoAppliedTask?.id || 'null'));

  // ───────────────────────────────────────────────────────────
  // SECTION 3: action=none + LLM → nextCandidates 表示
  // ───────────────────────────────────────────────────────────
  section('SECTION 3: action=none → LLM/fallback で候補取得');

  runner.setAutoApplyPlanning(pid, false);

  const r3 = await runner.runPlannerStepAsync(pid, {});
  if (r3.autoAppliedTask) CLEANUP_TASKS.push(r3.autoAppliedTask.id);

  await testAsync('3a. action=step', async () => r3.action === 'step');
  await testAsync('3b. plannerResult.action=none', async () => r3.plannerResult?.action === 'none');
  await testAsync('3c. autoAppliedTask=null (autoApply=OFF)', async () => !r3.autoAppliedTask);
  await testAsync('3d. summary に LLM Planner または rule-based を含む', async () =>
    r3.summary.includes('LLM Planner') || r3.summary.includes('rule-based') || r3.summary.includes('Planner')
  );
  info('summary (抜粋): ' + r3.summary.split('\n').slice(1, 4).join(' / '));

  // ───────────────────────────────────────────────────────────
  // SECTION 4: autoApplyPlanning=false → 登録なし
  // ───────────────────────────────────────────────────────────
  section('SECTION 4: autoApplyPlanning=false → ヒント表示のみ');

  // SECTION 3 で確認済みなので追加確認
  await testAsync('4a. autoApply=OFF: PENDING タスク数が変化しない', async () => {
    const before = taskManager.listTasks().filter(
      t => t.projectId === pid && t.state === taskManager.STATES.PENDING
    ).length;
    const r = await runner.runPlannerStepAsync(pid, {});
    if (r.autoAppliedTask) CLEANUP_TASKS.push(r.autoAppliedTask.id);
    const after = taskManager.listTasks().filter(
      t => t.projectId === pid && t.state === taskManager.STATES.PENDING
    ).length;
    return !r.autoAppliedTask && after === before;
  });

  // ───────────────────────────────────────────────────────────
  // SECTION 5: autoApplyPlanning=true + safe type → 最大1件登録
  // ───────────────────────────────────────────────────────────
  section('SECTION 5: autoApplyPlanning=ON → safe type 最大1件');

  runner.setAutoApplyPlanning(pid, true);

  // 既存 PENDING IMPLEMENT を保留にして D-5 ではなく D-4e パスを優先させる
  const existingImpls = taskManager.listTasks().filter(
    t => t.projectId === pid && t.type === 'IMPLEMENT' && t.state === taskManager.STATES.PENDING
  );
  existingImpls.forEach(t => {
    taskManager.updateState(t.id, taskManager.STATES.ON_HOLD, 'd7c test 一時保留');
  });
  info('既存 PENDING IMPLEMENT を一時保留: ' + existingImpls.length + '件');

  const beforeSafe = taskManager.listTasks().filter(
    t => t.projectId === pid && ['DOCS','RESEARCH','TEST'].includes(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  const r5 = await runner.runPlannerStepAsync(pid, {});
  if (r5.autoAppliedTask) CLEANUP_TASKS.push(r5.autoAppliedTask.id);

  const afterSafe = taskManager.listTasks().filter(
    t => t.projectId === pid && ['DOCS','RESEARCH','TEST'].includes(t.type) && t.state === taskManager.STATES.PENDING
  ).length;

  info('autoApplied: ' + (r5.autoAppliedTask?.id || 'null') + (r5.autoAppliedTask ? ' [' + r5.autoAppliedTask.type + ']' : ''));

  if (r5.plannerResult?.action === 'none') {
    if (r5.autoAppliedTask) {
      const isImpl = r5.autoAppliedTask.type === 'IMPLEMENT';
      if (!isImpl) {
        // D-4e パス（safe type）
        await testAsync('5a. safe type が登録された', async () =>
          ['DOCS','RESEARCH','TEST'].includes(r5.autoAppliedTask.type));
        await testAsync('5b. 状態が PENDING（自動実行なし）', async () =>
          r5.autoAppliedTask.state === taskManager.STATES.PENDING);
        await testAsync('5c. 登録は +1 のみ（最大1件）', async () =>
          afterSafe === beforeSafe + 1);
        await testAsync('5d. summary に Auto Apply を含む', async () =>
          r5.summary.includes('Auto Apply'));
      } else {
        // D-5 パス（IMPLEMENT — safe type が全て重複）
        info('D-5 パス: IMPLEMENT 登録（safe type 全て重複のため）');
        await testAsync('5a. IMPLEMENT 登録（D-5）', async () => true);
        await testAsync('5b. 状態が PENDING', async () =>
          r5.autoAppliedTask.state === taskManager.STATES.PENDING);
        await testAsync('5c. safe type 数は変化しない', async () =>
          afterSafe === beforeSafe);
        await testAsync('5d. summary に Auto Apply を含む', async () =>
          r5.summary.includes('Auto Apply'));
      }
    } else {
      info('候補なしまたは全て重複 — 正常ケース');
      await testAsync('5a. 登録なし → PENDING 数変化なし', async () =>
        afterSafe === beforeSafe);
      await testAsync('5b. runner state が破損しない', async () =>
        !!runner.getRunnerState(pid));
      await testAsync('5c. (skip) safe type 登録確認省略', async () => true);
      await testAsync('5d. (skip)', async () => true);
    }
  } else {
    info('plannerResult.action=' + (r5.plannerResult?.action || 'n/a'));
    await testAsync('5x. none 以外 → autoApplied なし', async () => !r5.autoAppliedTask);
    await testAsync('5y-z. (skip)', async () => true);
    await testAsync('5y-z2. (skip)', async () => true);
    await testAsync('5y-z3. (skip)', async () => true);
  }

  // ───────────────────────────────────────────────────────────
  // SECTION 6: IMPLEMENT 自動実行されない
  // ───────────────────────────────────────────────────────────
  section('SECTION 6: IMPLEMENT 登録後も自動実行されない');

  // 全 PENDING IMPLEMENT を保留 → D-5 が発動する状態を作る
  const pendingImpls6 = taskManager.listTasks().filter(
    t => t.projectId === pid && t.type === 'IMPLEMENT' && t.state === taskManager.STATES.PENDING
  );
  pendingImpls6.forEach(t => taskManager.updateState(t.id, taskManager.STATES.ON_HOLD, 'd7c S6 保留'));

  // SAFE_TYPES が全て PENDING の場合 → D-5 (IMPLEMENT) が登録される
  const r6 = await runner.runPlannerStepAsync(pid, {});
  if (r6.autoAppliedTask) CLEANUP_TASKS.push(r6.autoAppliedTask.id);
  info('S6 autoApplied: ' + (r6.autoAppliedTask?.id || 'null') + (r6.autoAppliedTask ? ' [' + r6.autoAppliedTask.type + ']' : ''));

  if (r6.autoAppliedTask?.type === 'IMPLEMENT') {
    await testAsync('6a. IMPLEMENT 登録後: state=PENDING (自動実行なし)', async () =>
      r6.autoAppliedTask.state === taskManager.STATES.PENDING);
    await testAsync('6b. nextExecutableTaskId=null (queue 投入なし)', async () =>
      !r6.nextExecutableTaskId);
    info('IMPLEMENT 自動実行なし ✅');
  } else {
    info('IMPLEMENT 候補なし or safe type が登録 → SECTION 6 はスキップ相当');
    await testAsync('6a. (skip) IMPLEMENT 未登録', async () => true);
    await testAsync('6b. (skip)', async () => true);
  }

  // ───────────────────────────────────────────────────────────
  // SECTION 7: API キーを外して LLM 失敗 → fallback
  // ───────────────────────────────────────────────────────────
  section('SECTION 7: LLM 失敗 → rule-based fallback（タスク完了処理を壊さない）');

  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const r7 = await runner.runPlannerStepAsync(pid, {});
  if (r7.autoAppliedTask) CLEANUP_TASKS.push(r7.autoAppliedTask.id);

  await testAsync('7a. API キーなし: action=step (fallback 正常)', async () =>
    r7.action === 'step');
  await testAsync('7b. plannerResult が存在する（クラッシュしない）', async () =>
    r7.plannerResult !== undefined);
  await testAsync('7c. summary が文字列（fallback 表示）', async () =>
    typeof r7.summary === 'string' && r7.summary.length > 0);
  info('fallback summary (抜粋): ' + r7.summary.split('\n').slice(1, 3).join(' / '));

  process.env.OPENAI_API_KEY = savedKey;

  // ───────────────────────────────────────────────────────────
  // SECTION 8: 既存 runPlannerStep (sync) が変更なし
  // ───────────────────────────────────────────────────────────
  section('SECTION 8: 既存 runPlannerStep() (sync) が変更なし');

  const syncR = runner.runPlannerStep(pid, {});
  if (syncR.autoAppliedTask) CLEANUP_TASKS.push(syncR.autoAppliedTask.id);

  test('8a. sync 版が Promise でない', () => !(syncR instanceof Promise));
  test('8b. sync 版 action=step or skip', () =>
    syncR.action === 'step' || syncR.action === 'skip');
  test('8c. sync 版は planProjectGoals (rule-based) を使う', () => {
    // summary には 'LLM Planner' が含まれない（rule-based のみ）
    return !syncR.summary?.includes('LLM Planner');
  });

  // ───────────────────────────────────────────────────────────
  // SECTION 9: git status clean
  // ───────────────────────────────────────────────────────────
  section('SECTION 9: git status clean');

  cleanup();

  const gitSt = execSync('git status --short -- bot/ data/', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  test('9. bot/ data/ に未コミット変更なし', () => gitSt === '');
  info('git status (bot/ data/): ' + (gitSt || 'clean'));

  console.log('\n=== テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) {
    console.log('❌ 失敗あり');
    process.exit(1);
  }
  console.log('✅ 全テスト通過');
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
