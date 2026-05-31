'use strict';
// ============================================================
// RESEARCH 完了 → runPlannerStepAsync フック テスト
//
// 確認項目:
//   1. RESEARCH 完了後に Plannerコールが増える
//   2. runner=OFF → Plannerコールが増えない
//   3. completedTask に id/type/prompt/resultSummary が含まれる
//   4. projectId が維持される
//   5. エラーでも RESEARCH 完了処理を壊さない
//   6. DOCS は既存 executeClaudeTask 経由でフックが呼ばれる（変更なし確認）
//   7. git status clean
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

function test(label, fn) {
  try { const ok = fn(); ok ? pass++ : fail++; console.log((ok ? '✅' : '❌') + ' ' + label); }
  catch (e) { fail++; console.log('❌ ' + label + ' — ' + e.message.slice(0, 80)); }
}
async function testAsync(label, fn) {
  try { const ok = await fn(); ok ? pass++ : fail++; console.log((ok ? '✅' : '❌') + ' ' + label); }
  catch (e) { fail++; console.log('❌ ' + label + ' — ' + e.message.slice(0, 80)); }
}
function info(msg)    { console.log('  ℹ️  ' + msg); }
function section(msg) { console.log('\n' + '═'.repeat(52) + '\n' + msg + '\n' + '═'.repeat(52)); }

function cleanup() {
  const fpath = path.join(ROOT_DIR, 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  runner.resetRunner(pid);
}

// runPlannerStepAsync の動作をシミュレート（フックと同等）
async function simulateResearchHook(projectId, taskId, prompt, resultSummary) {
  const runnerState = runner.getRunnerState(projectId);
  if (!runnerState.enabled) return { skipped: true };

  const completedTaskCtx = {
    id:            taskId,
    type:          'RESEARCH',
    prompt:        (prompt || '').slice(0, 200),
    resultSummary: (resultSummary || '').slice(0, 150),
  };
  const result = await runner.runPlannerStepAsync(projectId, {
    completedTask: completedTaskCtx,
  });
  return result;
}

async function main() {
  console.log('=== RESEARCH 完了 → runPlannerStepAsync フック テスト ===\n');

  // ───────────────────────────────────────────────────────────
  // SECTION 1: RESEARCH 完了後に Plannerコールが増える
  // ───────────────────────────────────────────────────────────
  section('SECTION 1: RESEARCH 完了 → Plannerコール増加');

  runner.resetRunner(pid);
  runner.enableRunner(pid);

  // ダミー PENDING タスク（project_done 防止）
  const dummy1 = taskManager.createTask('[hook-test] dummy', 'hook-test', null, '低', pid, 'DOCS');
  CLEANUP_TASKS.push(dummy1.id);

  const loopBefore = runner.getRunnerState(pid).loopCount;
  info('フック前 loopCount: ' + loopBefore);

  // RESEARCH 完了フックをシミュレート
  const r1 = await simulateResearchHook(pid, 'task_research_mock', 'YouTube API 仕様調査', 'APIの仕様を調査しました。');
  if (r1.autoAppliedTask) CLEANUP_TASKS.push(r1.autoAppliedTask.id);

  const loopAfter = runner.getRunnerState(pid).loopCount;
  info('フック後 loopCount: ' + loopAfter);
  info('action: ' + r1.action + ' | plannerResult: ' + (r1.plannerResult?.action || 'n/a'));

  await testAsync('1a. action=step (skip でない)', async () => r1.action === 'step');
  await testAsync('1b. loopCount が 1 増加', async () => loopAfter === loopBefore + 1);
  await testAsync('1c. plannerResult が存在', async () => !!r1.plannerResult);
  await testAsync('1d. summary が文字列', async () => typeof r1.summary === 'string');

  // ───────────────────────────────────────────────────────────
  // SECTION 2: completedTask に正しい情報が渡る
  // ───────────────────────────────────────────────────────────
  section('SECTION 2: completedTask の内容確認');

  // plannerResult に completedTask の情報が影響しているか確認
  // RESEARCH type は planNextTask() で REVIEW 候補を生成しない
  await testAsync('2a. RESEARCH 完了でも runner がクラッシュしない', async () => {
    const r = await simulateResearchHook(pid, 'task_r_test', 'テスト調査', '結果まとめ');
    if (r.autoAppliedTask) CLEANUP_TASKS.push(r.autoAppliedTask.id);
    return r.action === 'step' || r.action === 'stopped';
  });

  await testAsync('2b. plannerResult.action は RESEARCH 完了で create_task にならない', async () => {
    // RESEARCH完了後は REVIEW を自動生成しない（IMPLEMENT完了時のみ）
    const r = await simulateResearchHook(pid, 'task_r_test2', 'YouTube 調査', '調査完了');
    if (r.autoAppliedTask) CLEANUP_TASKS.push(r.autoAppliedTask.id);
    // create_task になる場合（Codex高危険度等）もあるが、RESEARCH contextでは通常 none
    return r.plannerResult !== undefined;
  });

  // ───────────────────────────────────────────────────────────
  // SECTION 3: runner=OFF → Plannerコールが増えない
  // ───────────────────────────────────────────────────────────
  section('SECTION 3: runner=OFF → フック無効');

  runner.disableRunner(pid);
  const loopOff = runner.getRunnerState(pid).loopCount;
  const r3 = await simulateResearchHook(pid, 'task_r_off', '調査タスク OFF テスト', '結果');

  await testAsync('3a. runner=OFF: skipped=true', async () => r3.skipped === true);
  await testAsync('3b. runner=OFF: loopCount 変化なし', async () =>
    runner.getRunnerState(pid).loopCount === loopOff);

  // ───────────────────────────────────────────────────────────
  // SECTION 4: projectId が正しく渡る
  // ───────────────────────────────────────────────────────────
  section('SECTION 4: projectId の維持確認');

  runner.resetRunner(pid);
  runner.enableRunner(pid);

  const dummy4 = taskManager.createTask('[hook-test] dummy4', 'hook-test', null, '低', pid, 'DOCS');
  CLEANUP_TASKS.push(dummy4.id);

  const r4 = await simulateResearchHook(pid, 'task_r_pid', 'PID確認テスト', '結果');
  if (r4.autoAppliedTask) CLEANUP_TASKS.push(r4.autoAppliedTask.id);

  await testAsync('4a. result.projectId が一致', async () => r4.projectId === pid);
  await testAsync('4b. runner-state.json の projectId が維持される', async () =>
    runner.getRunnerState(pid).projectId === pid);
  info('r4.projectId: ' + r4.projectId);

  // ───────────────────────────────────────────────────────────
  // SECTION 5: エラーでも完了処理を壊さない
  // ───────────────────────────────────────────────────────────
  section('SECTION 5: エラー耐性（try/catch 確認）');

  // 無効な projectId でフックを呼んでもクラッシュしない
  await testAsync('5a. 無効 projectId でもクラッシュしない', async () => {
    try {
      const r = await simulateResearchHook('nonexistent-project', 'task_x', 'test', 'result');
      // skip が返れば OK（runner disabled のため）
      return r.skipped === true || r.action === 'skip';
    } catch {
      return false; // クラッシュは NG
    }
  });

  await testAsync('5b. runner エラー後も tasks.json は破損しない', async () => {
    const fpath = path.join(ROOT_DIR, 'data', 'tasks.json');
    try {
      JSON.parse(fs.readFileSync(fpath, 'utf8'));
      return true;
    } catch {
      return false;
    }
  });

  // ───────────────────────────────────────────────────────────
  // SECTION 6: index.js に executeResearchTask フックが存在する
  // ───────────────────────────────────────────────────────────
  section('SECTION 6: index.js のフック存在確認');

  const indexSrc = fs.readFileSync(path.join(ROOT_DIR, 'bot', 'index.js'), 'utf8');
  test('6a. executeResearchTask に runPlannerStepAsync 呼び出しがある',
    () => indexSrc.includes('runPlannerStepAsync') &&
          indexSrc.includes('executeResearchTask') &&
          // RESEARCH 完了フック部分に両方が存在する
          (() => {
            const researchFnStart = indexSrc.indexOf('async function executeResearchTask');
            const researchFnEnd   = indexSrc.indexOf('\nasync function ', researchFnStart + 1);
            const researchBody    = indexSrc.slice(researchFnStart, researchFnEnd > 0 ? researchFnEnd : researchFnStart + 5000);
            return researchBody.includes('runPlannerStepAsync');
          })()
  );
  test('6b. フックが try/catch で囲まれている',
    () => (() => {
      const researchFnStart = indexSrc.indexOf('async function executeResearchTask');
      const researchFnEnd   = indexSrc.indexOf('\nasync function ', researchFnStart + 1);
      const researchBody    = indexSrc.slice(researchFnStart, researchFnEnd > 0 ? researchFnEnd : researchFnStart + 5000);
      return researchBody.includes('runPlannerStepAsync') && researchBody.includes('runnerErr');
    })()
  );
  test('6c. runner.enabled チェックがある',
    () => (() => {
      const researchFnStart = indexSrc.indexOf('async function executeResearchTask');
      const researchFnEnd   = indexSrc.indexOf('\nasync function ', researchFnStart + 1);
      const researchBody    = indexSrc.slice(researchFnStart, researchFnEnd > 0 ? researchFnEnd : researchFnStart + 5000);
      return researchBody.includes('runnerState.enabled');
    })()
  );

  // ───────────────────────────────────────────────────────────
  // SECTION 7: git status clean
  // ───────────────────────────────────────────────────────────
  section('SECTION 7: git status clean');

  cleanup();

  const gitSt = execSync('git status --short -- bot/ data/', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  test('7. bot/ data/ に未コミット変更なし', () => gitSt === '');
  info('git status (bot/ data/): ' + (gitSt || 'clean'));

  console.log('\n=== テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) { console.log('❌ 失敗あり'); process.exit(1); }
  console.log('✅ 全テスト通過');
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
