'use strict';

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const codex       = require('../bot/utils/codex.js');
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
function info(msg) { console.log('  ℹ️  '+msg); }

async function main() {
  console.log('=== Auto Project Runner B-7b 実地テスト ===\n');
  runner.resetRunner(pid);

  // STEP 1: runner ON
  console.log('--- STEP 1: runner ON ---');
  runner.enableRunner(pid);
  const s1 = runner.getRunnerState(pid);
  test('runner ON 確認', () => s1.enabled === true);
  info('loop: ' + s1.loopCount + '/10');

  // STEP 2: runner status
  console.log('\n--- STEP 2: runner status ---');
  const status = runner.formatRunnerStatus(pid);
  test('status に ✅ 有効 含む', () => status.includes('✅ 有効'));

  // STEP 3: REVIEW タスク作成
  console.log('\n--- STEP 3: REVIEW タスク作成 ---');
  const reviewTask = taskManager.createTask(
    'Auto Project Runner B-7b のテスト用レビューです。軽微な改善点があれば中危険度として返してください。',
    'test-runner', null, '低', pid, 'REVIEW'
  );
  CLEANUP_TASKS.push(reviewTask.id);
  test('REVIEW タスク作成', () => reviewTask.type === 'REVIEW' && reviewTask.state === '未着手');
  info('REVIEW taskId: ' + reviewTask.id);

  // STEP 4: Codex 呼び出し (API or ダミー)
  console.log('\n--- STEP 4: Codex レビュー実行 ---');
  const codexRequest = codex.generateCodexRequest(reviewTask.id, reviewTask.prompt, '', []);
  const discordMsg   = codex.generateDiscordMessage(reviewTask.id, codexRequest);
  codex.saveReview(reviewTask.id, { ...codexRequest, discordMessage: discordMsg });
  CLEANUP_FILES.push(path.join(REVIEWS_DIR, 'codex_' + reviewTask.id + '.md'));

  let parsed = null;
  if (process.env.OPENAI_API_KEY) {
    const apiResult = await codex.callCodexAPI(reviewTask.prompt, '');
    if (apiResult) {
      codex.saveCodexResponse(reviewTask.id, apiResult);
      parsed = codex.parseCodexResult(apiResult);
    }
  }
  if (!parsed) {
    parsed = { danger: '中', problem: 'テスト用ダミー: エラーハンドリング改善の余地があります', suggestion: 'try-catch を追加' };
    info('API なし → 中危険度ダミー使用');
  }
  info('Codex 危険度: ' + parsed.danger);
  info('Codex 問題点: ' + (parsed.problem || '').slice(0, 60));

  // reviews/result_*.md に保存
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[parsed.danger] || '⬜';
  const resultPath = path.join(REVIEWS_DIR, 'result_' + reviewTask.id + '.md');
  CLEANUP_FILES.push(resultPath);
  fs.writeFileSync(resultPath, [
    '# Codex レビュー結果: ' + reviewTask.id, '',
    '| 危険度 | ' + dangerEmoji + ' ' + parsed.danger + ' |', '',
    '## 問題点', '', parsed.problem || 'なし', '',
    '## 改善案', '', parsed.suggestion || 'なし', '',
    '## フィードバック適用コマンド', '', '!apply-review ' + reviewTask.id,
  ].join('\n'), 'utf8');

  // STEP 5: B-7b フック
  console.log('\n--- STEP 5: B-7b フック（runPlannerStep + reviewResult）---');
  const runnerResult = runner.runPlannerStep(pid, { reviewResult: parsed });
  info('action: ' + runnerResult.action);
  info('plannerResult.action: ' + (runnerResult.plannerResult?.action || 'n/a'));
  info('loopCount: ' + runnerResult.loopCount);

  // STEP 6: 確認項目チェック
  console.log('\n--- STEP 6: 確認項目チェック ---');
  const isDangerous = parsed.danger === '中' || parsed.danger === '高';

  // 1. Codex 危険度
  test('1. Codex 中/高危険度を検出', () => isDangerous);

  // 2. FIX 生成
  test('2. FIX タスク生成 (create_task)', () => runnerResult.plannerResult?.action === 'create_task');

  if (runnerResult.createdTask?.id) {
    CLEANUP_TASKS.push(runnerResult.createdTask.id);
    info('FIX taskId: ' + runnerResult.createdTask.id);
    info('FIX priority: ' + runnerResult.createdTask.priority);
    info('FIX state: ' + runnerResult.createdTask.state);

    // 3. type=FIX
    test('3. 作成タスクの type=FIX', () => runnerResult.createdTask.type === 'FIX');

    // 4. IMPLEMENT等は作られない
    const allNew = taskManager.listTasks().filter(t => CLEANUP_TASKS.includes(t.id));
    const nonFix = allNew.filter(t => t.type !== 'FIX' && t.type !== 'REVIEW');
    test('4. IMPLEMENT/DOCS/RESEARCH は作られない', () => nonFix.length === 0);

    // 5. loopCount 増加
    const s3 = runner.getRunnerState(pid);
    test('5. loopCount 増加', () => s3.loopCount >= 1);
    info('loopCount: ' + s3.loopCount + '/10');

    // 6. 重複チェック
    const countBefore = taskManager.listTasks().filter(t => t.projectId === pid && t.type === 'FIX').length;
    runner.runPlannerStep(pid, { reviewResult: parsed });
    const countAfter = taskManager.listTasks().filter(t => t.projectId === pid && t.type === 'FIX').length;
    test('6. 重複登録なし（2回目はスキップ）', () => countBefore === countAfter);

    // 7. nextExecutableTaskId
    test('7. nextExecutableTaskId が FIX taskId と一致', () => runnerResult.nextExecutableTaskId === runnerResult.createdTask.id);
    info('nextExecutableTaskId: ' + runnerResult.nextExecutableTaskId);
    info('→ Discord 実行時は taskQueue.enqueue() でキュー投入されます');
  } else {
    info('FIX 登録なし（低危険度 or 重複）');
    test('FIX なし → nextExecutableTaskId:null', () => !runnerResult.nextExecutableTaskId);
  }

  // STEP 7: runner off
  console.log('\n--- STEP 7: !project runner off ---');
  runner.disableRunner(pid);
  const s4 = runner.getRunnerState(pid);
  test('runner OFF 確認', () => s4.enabled === false);
  const rOff = runner.runPlannerStep(pid, { reviewResult: parsed });
  test('runner OFF 後: action=skip', () => rOff.action === 'skip');
  test('runner OFF 後: FIX 登録なし', () => !rOff.createdTask);

  // クリーンアップ
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','tasks.json'),'utf8'));
  raw.tasks = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(path.join(__dirname,'..','data','tasks.json'), JSON.stringify(raw, null, 2), 'utf8');
  CLEANUP_FILES.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  runner.resetRunner(pid);

  console.log('\n=== テスト結果: ' + pass + '/' + (pass+fail) + ' 通過 ===');
}

main().catch(e => { console.error('テスト失敗:', e.message); process.exit(1); });
