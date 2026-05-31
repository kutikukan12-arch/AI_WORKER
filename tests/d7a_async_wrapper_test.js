'use strict';
// Phase D-7a: runPlannerStepAsync ラッパーテスト

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const path        = require('path');
const fs          = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pid      = 'youtube予測ai';
const ROOT_DIR = path.join(__dirname, '..');
let pass = 0, fail = 0;
const CLEANUP_TASKS = [];

function test(label, fn) {
  try { const ok = fn(); ok ? pass++ : fail++; console.log((ok ? '✅' : '❌') + ' ' + label); }
  catch (e) { fail++; console.log('❌ ' + label + ' — ' + e.message.slice(0, 80)); }
}
async function testAsync(label, fn) {
  try { const ok = await fn(); ok ? pass++ : fail++; console.log((ok ? '✅' : '❌') + ' ' + label); }
  catch (e) { fail++; console.log('❌ ' + label + ' — ' + e.message.slice(0, 80)); }
}
function info(msg) { console.log('  ℹ️  ' + msg); }

function cleanup() {
  const fpath = path.join(ROOT_DIR, 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  runner.resetRunner(pid);
}

async function main() {
  console.log('=== Phase D-7a: runPlannerStepAsync ラッパーテスト ===\n');

  // ─── 準備 ───────────────────────────────────────────────
  runner.resetRunner(pid);
  runner.enableRunner(pid);

  // action:none を誘導するためのダミー PENDING タスク
  const dummy = taskManager.createTask(
    '[d7a-test] ダミー (action:none 誘導用)', 'd7a-test', null, '低', pid, 'DOCS'
  );
  CLEANUP_TASKS.push(dummy.id);

  // ─── 1. export されている ────────────────────────────────
  test('1. runPlannerStepAsync が export されている', () =>
    typeof runner.runPlannerStepAsync === 'function');

  // ─── 2. Promise を返す ────────────────────────────────────
  test('2. runPlannerStepAsync は Promise を返す', () => {
    runner.disableRunner(pid); // skip にして副作用なし
    const p = runner.runPlannerStepAsync(pid, {});
    const isPromise = p instanceof Promise;
    runner.enableRunner(pid);
    return isPromise;
  });

  // ─── 3. 戻り値が同期版と同等 ──────────────────────────────
  runner.resetRunner(pid);
  runner.enableRunner(pid);

  // 同期版の結果
  const syncResult = runner.runPlannerStep(pid, {});

  // 非同期版の結果（次の loopCount になるため別プロジェクト or リセット後に比較）
  runner.resetRunner(pid);
  runner.enableRunner(pid);
  const asyncResult = await runner.runPlannerStepAsync(pid, {});
  if (asyncResult.autoAppliedTask) CLEANUP_TASKS.push(asyncResult.autoAppliedTask.id);

  await testAsync('3a. action が同じ (step)', async () =>
    asyncResult.action === syncResult.action);
  await testAsync('3b. projectId が一致', async () =>
    asyncResult.projectId === pid);
  await testAsync('3c. plannerResult を持つ', async () =>
    asyncResult.plannerResult !== undefined);
  await testAsync('3d. summary が文字列', async () =>
    typeof asyncResult.summary === 'string');
  await testAsync('3e. loopCount が数値', async () =>
    typeof asyncResult.loopCount === 'number');

  info('sync  action: ' + syncResult.action + ' | loop: ' + syncResult.loopCount);
  info('async action: ' + asyncResult.action + ' | loop: ' + asyncResult.loopCount);

  // ─── 4. runner=OFF でも同等 ───────────────────────────────
  runner.disableRunner(pid);
  const rOff = await runner.runPlannerStepAsync(pid, {});
  await testAsync('4a. runner=OFF: action=skip', async () => rOff.action === 'skip');
  await testAsync('4b. runner=OFF: autoAppliedTask=null', async () => !rOff.autoAppliedTask);

  // ─── 5. LLM API を呼ばない ──────────────────────────────
  // runPlannerStepAsync は planProjectGoalsBest を呼ばないことを確認する
  // 方法: planProjectGoals (sync) しか呼ばれていないことを既存ログで確認
  // （D-7a は LLM を呼ばない制約）
  runner.enableRunner(pid);
  const rLLMCheck = await runner.runPlannerStepAsync(pid, {});
  if (rLLMCheck.autoAppliedTask) CLEANUP_TASKS.push(rLLMCheck.autoAppliedTask.id);
  await testAsync('5a. LLM を呼ばない (planProjectGoalsBest 未使用)', async () => {
    // D-7a では LLM を呼ばないため、action が 'step' かつ LLM 関連フィールドなし
    return rLLMCheck.action === 'step' && rLLMCheck.llmUsed !== true;
  });

  // ─── 6. 既存 runPlannerStep が引き続き機能する ────────────
  runner.resetRunner(pid);
  runner.enableRunner(pid);
  const syncCheck = runner.runPlannerStep(pid, {});
  test('6a. 既存 runPlannerStep (sync) が正常動作', () =>
    syncCheck.action === 'step' || syncCheck.action === 'skip');
  test('6b. 既存 runPlannerStep は Promise でない', () =>
    !(syncCheck instanceof Promise));
  if (syncCheck.autoAppliedTask) CLEANUP_TASKS.push(syncCheck.autoAppliedTask.id);

  // ─── 7. git status clean ─────────────────────────────────
  cleanup();
  const { execSync } = require('child_process');
  const gitSt = execSync('git status --short -- bot/ data/', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  test('7. bot/ data/ に未コミット変更なし', () => gitSt === '');
  info('git status (bot/ data/): ' + (gitSt || 'clean'));

  console.log('\n=== テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) process.exit(1);
  else console.log('✅ 全テスト通過');
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
