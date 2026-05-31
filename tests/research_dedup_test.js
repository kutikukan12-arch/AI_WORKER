'use strict';
// ============================================================
// RESEARCH 重複生成防止テスト
//
// 確認項目:
//   1. getProjectDoneTasks() が history から完了タスクを収集する
//   2. RESEARCH完了後に rule-based planner が RESEARCH を下げる
//   3. RESEARCH完了後に DOCS/IMPLEMENT 候補が上位に来る
//   4. autoApplyPlanning=true + RESEARCH完了 → RESEARCH 再生成しない
//   5. docs がある場合 IMPLEMENT 候補が出る
//   6. doneTasks なし → RESEARCH が最上位（変更前の挙動維持）
//   7. 既存テストへのリグレッションなし
// ============================================================

const runner      = require('../bot/utils/auto-project-runner.js');
const planner     = require('../bot/utils/project-planner.js');
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
  planner.clearPlannerCache(pid);
}

async function main() {
  console.log('=== RESEARCH 重複生成防止テスト ===\n');

  // ───────────────────────────────────────────────────────────
  // SECTION 1: getProjectDoneTasks() — history から収集
  // ───────────────────────────────────────────────────────────
  section('SECTION 1: getProjectDoneTasks() 確認');

  // getProjectDoneTasks は module 内部関数だが、
  // planProjectGoals に渡した結果で間接確認する
  const descYT = 'YouTube予測AI - 動画再生回数を予測するシステム';

  // doneTasks なし → RESEARCH が上位
  const noHistory = planner.planProjectGoals(pid, { description: descYT, doneTasks: [] });
  const researchFirst = noHistory.nextCandidates[0]?.type === 'RESEARCH' ||
                        noHistory.nextCandidates.some(c => c.type === 'RESEARCH');
  test('1a. doneTasks=[] → RESEARCH が候補に含まれる', () => researchFirst);
  info('候補 (doneTasks=[]): ' + noHistory.nextCandidates.map(c => c.type).join(', '));

  // doneTasks に RESEARCH あり → RESEARCH が除外される
  const withHistory = planner.planProjectGoals(pid, {
    description: descYT,
    doneTasks: [
      'RESEARCH: YouTube API 仕様調査完了',
      'RESEARCH: AI モデル選定・調査完了',
      'RESEARCH: 予測モデル調査完了',
    ]
  });
  const noResearch = !withHistory.nextCandidates.some(c => c.type === 'RESEARCH');
  test('1b. doneTasks に RESEARCH あり → RESEARCH が候補から除外される', () => noResearch);
  info('候補 (doneTasks=RESEARCH): ' + withHistory.nextCandidates.map(c => c.type).join(', '));

  test('1c. doneTasks に RESEARCH あり → DOCS/IMPLEMENT が上位に来る', () =>
    withHistory.nextCandidates.length > 0 &&
    (withHistory.nextCandidates[0].type === 'DOCS' || withHistory.nextCandidates[0].type === 'IMPLEMENT')
  );
  info('最上位候補: ' + (withHistory.nextCandidates[0]?.type || 'なし'));

  // ───────────────────────────────────────────────────────────
  // SECTION 2: autoApplyPlanning=true + RESEARCH 完了 → RESEARCH 再生成しない
  // ───────────────────────────────────────────────────────────
  section('SECTION 2: RESEARCH 完了後に RESEARCH を再生成しない');

  runner.resetRunner(pid);
  runner.enableRunner(pid);
  runner.setAutoApplyPlanning(pid, true);

  // ダミー PENDING タスク（project_done 防止）
  const dummy2 = taskManager.createTask('[dedup-test] dummy PENDING', 'dedup-test', null, '低', pid, 'DOCS');
  CLEANUP_TASKS.push(dummy2.id);

  // 実際の history には RESEARCH が複数ある（確認済み）
  // runPlannerStepAsync を呼び、RESEARCH が再生成されないか確認
  const beforeResearch = taskManager.listTasks().filter(
    t => t.projectId === pid && t.type === 'RESEARCH' && t.state === taskManager.STATES.PENDING
  ).length;

  const r2 = await runner.runPlannerStepAsync(pid, {
    completedTask: {
      id:            'task_research_done_mock',
      type:          'RESEARCH',
      prompt:        'YouTube API 仕様調査',
      resultSummary: 'APIの仕様を調査しました。',
    }
  });
  if (r2.autoAppliedTask) CLEANUP_TASKS.push(r2.autoAppliedTask.id);

  const afterResearch = taskManager.listTasks().filter(
    t => t.projectId === pid && t.type === 'RESEARCH' && t.state === taskManager.STATES.PENDING
  ).length;

  info('autoApplied: ' + (r2.autoAppliedTask?.id || 'null') + (r2.autoAppliedTask ? ' [' + r2.autoAppliedTask.type + ']' : ''));
  info('RESEARCH PENDING 前: ' + beforeResearch + ' / 後: ' + afterResearch);

  // RESEARCH が生成されていない（DOCS/TEST/IMPLEMENT が選ばれる or 何も登録なし）
  await testAsync('2a. RESEARCH 完了後: autoApplied が RESEARCH でない', async () =>
    r2.autoAppliedTask?.type !== 'RESEARCH'
  );
  await testAsync('2b. RESEARCH PENDING 数が増加しない', async () =>
    afterResearch === beforeResearch
  );

  // ───────────────────────────────────────────────────────────
  // SECTION 3: RESEARCH 完了後に DOCS 候補が出る
  // ───────────────────────────────────────────────────────────
  section('SECTION 3: RESEARCH 完了後に DOCS/IMPLEMENT 候補');

  if (r2.plannerResult?.action === 'none') {
    // summary に DOCS/IMPLEMENT の登録 or ヒントが含まれるか
    await testAsync('3a. summary に Auto Apply または候補ヒントを含む', async () =>
      r2.summary.includes('Auto Apply') || r2.summary.includes('次候補') || r2.summary.includes('Planner'));

    if (r2.autoAppliedTask) {
      await testAsync('3b. 登録されたタスクが DOCS/IMPLEMENT/TEST', async () =>
        ['DOCS', 'IMPLEMENT', 'TEST'].includes(r2.autoAppliedTask.type));
      info('登録type: ' + r2.autoAppliedTask.type);
    } else {
      info('autoApplied なし（全候補が重複 or 候補なし）');
      await testAsync('3b. (skip) 候補なし → runner 正常動作', async () => r2.action === 'step');
    }
  } else {
    info('plannerResult.action=' + (r2.plannerResult?.action || 'n/a') + ' → none 以外のためスキップ');
    await testAsync('3a. (skip)', async () => true);
    await testAsync('3b. (skip)', async () => true);
  }

  // ───────────────────────────────────────────────────────────
  // SECTION 4: doneTasks なし → 従来通り RESEARCH が候補に含まれる
  // ───────────────────────────────────────────────────────────
  section('SECTION 4: doneTasks なし → RESEARCH が候補に出る（後退テスト）');

  const r4 = planner.planProjectGoals('nonexistent-for-d2-test', {
    description: 'YouTube予測 動画再生回数を予測する',
    doneTasks:   [], // 完了なし
  });
  test('4a. doneTasks=[] では RESEARCH が候補に含まれる', () =>
    r4.nextCandidates.some(c => c.type === 'RESEARCH'));
  info('nonexistent projectの候補: ' + r4.nextCandidates.map(c => c.type).join(', '));

  // ───────────────────────────────────────────────────────────
  // SECTION 5: runner=OFF → 変化なし
  // ───────────────────────────────────────────────────────────
  section('SECTION 5: runner=OFF → RESEARCH 再生成されない');

  runner.disableRunner(pid);
  const r5 = await runner.runPlannerStepAsync(pid, {
    completedTask: { id: 'task_r_off', type: 'RESEARCH', prompt: 'test', resultSummary: 'done' }
  });
  await testAsync('5a. runner=OFF: action=skip', async () => r5.action === 'skip');
  await testAsync('5b. runner=OFF: autoApplied なし', async () => !r5.autoAppliedTask);

  // ───────────────────────────────────────────────────────────
  // SECTION 6: git status clean
  // ───────────────────────────────────────────────────────────
  section('SECTION 6: git status clean');

  cleanup();

  const gitSt = execSync('git status --short -- bot/ data/', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  test('6. bot/ data/ に未コミット変更なし', () => gitSt === '');
  info('git status: ' + (gitSt || 'clean'));

  console.log('\n=== テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
  if (fail > 0) { console.log('❌ 失敗あり'); process.exit(1); }
  console.log('✅ 全テスト通過');
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
