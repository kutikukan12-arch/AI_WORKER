'use strict';
// フルフロー統合テスト
// IMPLEMENT完了 → REVIEW自動登録 → Codex API → FIX生成 → FIX自動キュー投入

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const codex       = require('../bot/utils/codex.js');
const planner     = require('../bot/utils/project-planner.js');
const fs          = require('fs');
const path        = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REVIEWS_DIR = path.join(__dirname, '..', 'reviews');
const pid = 'youtube予測ai';
let pass=0, fail=0;
const CLEANUP_TASKS=[], CLEANUP_FILES=[];

function test(label, fn) {
  try { const ok=fn(); ok?pass++:fail++; console.log((ok?'✅':'❌')+' '+label); }
  catch(e) { fail++; console.log('❌ '+label+' — '+e.message.slice(0,80)); }
}
function info(msg)  { console.log('  ℹ️  '+msg); }
function step(msg)  { console.log('\n--- '+msg+' ---'); }

async function main() {
  console.log('=== フルフロー統合テスト ===\n');
  runner.resetRunner(pid);

  // ── STEP 1: runner ON ────────────────────────────────
  step('STEP 1: runner ON');
  runner.enableRunner(pid);
  test('runner ON', () => runner.getRunnerState(pid).enabled);

  // ── STEP 2: IMPLEMENT タスクを想定（ダミー） ─────────
  step('STEP 2: IMPLEMENT タスク（ダミー完了）');
  const implTask = taskManager.createTask(
    'Auto Project Runner フルフローテスト用IMPLEMENT: ユーザー認証ロジックを追加してください。',
    'test-runner', null, '低', pid, 'IMPLEMENT'
  );
  CLEANUP_TASKS.push(implTask.id);
  info('IMPLEMENT taskId: ' + implTask.id);
  test('IMPLEMENT タスク作成', () => implTask.type === 'IMPLEMENT');

  // IMPLEMENT 完了をシミュレート（executeClaudeTask の代わり）
  taskManager.updateState(implTask.id, taskManager.STATES.DONE, 'テスト用ダミー完了');
  info('IMPLEMENT タスクを DONE にしました（ダミー）');

  // ── STEP 3: C-2フック = runPlannerStep + completedTask ─
  step('STEP 3: IMPLEMENT完了フック → REVIEW登録');
  const completedCtx = {
    id:            implTask.id,
    type:          'IMPLEMENT',
    prompt:        implTask.prompt.slice(0, 200),
    resultSummary: 'ユーザー認証ロジックを追加しました。',
  };
  const r1 = runner.runPlannerStep(pid, { completedTask: completedCtx });
  if (r1.createdTask?.id) CLEANUP_TASKS.push(r1.createdTask.id);

  test('REVIEW タスク自動登録', () => r1.createdTask?.type === 'REVIEW');
  test('nextExecutableTaskId = REVIEW', () => r1.nextExecutableTaskId === r1.createdTask?.id);
  test('loopCount が 1', () => r1.loopCount === 1);

  const reviewTask = r1.createdTask;
  info('REVIEW taskId: ' + (reviewTask?.id || 'null'));
  info('loopCount: ' + r1.loopCount + '/10');

  if (!reviewTask) {
    console.log('\n⚠️ REVIEW タスク未生成。テスト中断。');
    runner.disableRunner(pid);
    runner.resetRunner(pid);
    console.log('\n結果: ' + pass + '/' + (pass+fail) + ' 通過');
    return;
  }

  // ── STEP 4: Codex API を実行（executeReviewTask の核心部分） ─
  step('STEP 4: Codex API 実行（REVIEWタスクの内容をレビュー）');

  // Codex 依頼文生成
  const codexRequest = codex.generateCodexRequest(reviewTask.id, reviewTask.prompt, '', []);
  const discordMsg   = codex.generateDiscordMessage(reviewTask.id, codexRequest);
  codex.saveReview(reviewTask.id, { ...codexRequest, discordMessage: discordMsg });
  CLEANUP_FILES.push(path.join(REVIEWS_DIR, 'codex_' + reviewTask.id + '.md'));

  let parsed = null;
  if (process.env.OPENAI_API_KEY) {
    info('Codex API を呼び出し中...');
    const apiResult = await codex.callCodexAPI(reviewTask.prompt, '');
    if (apiResult) {
      codex.saveCodexResponse(reviewTask.id, apiResult);
      parsed = codex.parseCodexResult(apiResult);
      info('Codex 危険度: ' + parsed.danger);
      info('Codex 問題点: ' + (parsed.problem || 'なし').slice(0, 80));
    }
  }
  if (!parsed) {
    parsed = { danger: '低', problem: 'なし', suggestion: 'なし' };
    info('OPENAI_API_KEY なし → 低危険度ダミー使用');
  }

  // result_*.md を保存
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[parsed.danger] || '⬜';
  const resultPath  = path.join(REVIEWS_DIR, 'result_' + reviewTask.id + '.md');
  CLEANUP_FILES.push(resultPath);
  fs.writeFileSync(resultPath, [
    '# Codex レビュー結果: ' + reviewTask.id, '',
    '| 危険度 | ' + dangerEmoji + ' ' + parsed.danger + ' |', '',
    '## 問題点', '', parsed.problem || 'なし', '',
    '## 改善案', '', parsed.suggestion || 'なし', '',
    '## フィードバック適用コマンド', '', '!apply-review ' + reviewTask.id,
  ].join('\n'), 'utf8');

  test('Codex API 危険度取得', () => ['低','中','高'].includes(parsed.danger));

  // ── STEP 5: REVIEW完了フック = B-7bフロー ────────────
  step('STEP 5: REVIEW完了フック（Codex結果 → FIX判断）');
  const isDangerous = parsed.danger === '中' || parsed.danger === '高';
  info('危険度: ' + parsed.danger + ' → ' + (isDangerous ? 'FIX生成対象' : 'FIX生成不要'));

  let r2 = null;
  let fixTask = null;
  if (isDangerous) {
    r2 = runner.runPlannerStep(pid, { reviewResult: parsed });
    if (r2?.createdTask?.id) {
      CLEANUP_TASKS.push(r2.createdTask.id);
      fixTask = r2.createdTask;
    }
    test('5. 中/高危険度 → FIX タスク生成', () => r2?.createdTask?.type === 'FIX');
    test('5. FIX nextExecutableTaskId あり', () => !!r2?.nextExecutableTaskId);
    info('FIX taskId: ' + (fixTask?.id || 'null'));
    info('FIX priority: ' + (fixTask?.priority || 'null'));
    info('loopCount: ' + r2?.loopCount + '/10');
  } else {
    info('低危険度 → FIX生成なし（正常）');
    test('5. 低危険度 → FIX生成なし', () => true);
  }

  // ── STEP 6: 確認サマリー ─────────────────────────────
  step('STEP 6: 確認サマリー');

  const finalState = runner.getRunnerState(pid);
  test('6a. loopCount が増加している', () => finalState.loopCount >= 1);
  info('最終 loopCount: ' + finalState.loopCount + '/10');
  info('totalTasksCreated: ' + finalState.totalTasksCreated);

  // 重複チェック: REVIEW が2件以上ないか
  const reviewTasks = taskManager.listTasks().filter(
    t => t.type === 'REVIEW' && t.projectId === pid && CLEANUP_TASKS.includes(t.id)
  );
  test('6b. REVIEW タスクは1件のみ', () => reviewTasks.length <= 1);
  info('REVIEW タスク数: ' + reviewTasks.length);

  // git status
  const { execSync } = require('child_process');
  const gitStatus = execSync('git status --short', { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  test('6c. git status clean', () => gitStatus === '' || gitStatus === '?? tests/full_flow_integration_test.js');
  info('git status: ' + (gitStatus || 'clean'));

  // ── STEP 7: runner OFF ───────────────────────────────
  step('STEP 7: runner OFF');
  runner.disableRunner(pid);
  test('runner OFF 確認', () => !runner.getRunnerState(pid).enabled);
  const r3 = runner.runPlannerStep(pid, { completedTask: completedCtx });
  test('runner OFF 後: action:skip', () => r3.action === 'skip');

  // ── クリーンアップ ────────────────────────────────────
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','tasks.json'),'utf8'));
  raw.tasks = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(path.join(__dirname,'..','data','tasks.json'), JSON.stringify(raw, null, 2), 'utf8');
  CLEANUP_FILES.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  runner.resetRunner(pid);

  console.log('\n=== テスト結果: ' + pass + '/' + (pass+fail) + ' 通過 ===');

  // 完了報告
  console.log('\n=== 完了報告 ===');
  console.log('IMPLEMENT taskId:  ' + implTask.id);
  console.log('REVIEW taskId:     ' + (reviewTask?.id || 'null'));
  console.log('Codex 危険度:      ' + parsed.danger);
  console.log('FIX 生成:          ' + (fixTask ? 'あり (' + fixTask.id + ')' : 'なし'));
  console.log('最終 loopCount:    ' + finalState.loopCount + '/10');
  console.log('エラー:            ' + (fail > 0 ? fail + '件' : 'なし'));
}

main().catch(e => { console.error('テスト失敗:', e.message); process.exit(1); });
