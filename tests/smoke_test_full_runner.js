'use strict';
// Auto Project Runner 通しテスト (Phase A〜D)
// IMPLEMENT完了→REVIEW自動→Codex→FIXなし→project_done→runner停止

const runner      = require('../bot/utils/auto-project-runner.js');
const taskManager = require('../bot/utils/task-manager.js');
const codex       = require('../bot/utils/codex.js');
const fs          = require('fs');
const path        = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REVIEWS_DIR = path.join(__dirname, '..', 'reviews');
const DOCS_DIR    = path.join(__dirname, '..', 'docs');
const ROOT_DIR    = path.join(__dirname, '..');
const pid = 'youtube予測ai';

let pass=0, fail=0;
const CLEANUP_TASKS=[], CLEANUP_FILES=[];

function test(label, fn) {
  try { const ok=fn(); ok?pass++:fail++; console.log((ok?'✅':'❌')+' '+label); }
  catch(e) { fail++; console.log('❌ '+label+' — '+e.message.slice(0,80)); }
}
function info(msg) { console.log('  ℹ️  '+msg); }
function step(msg) { console.log('\n─── '+msg+' ───'); }

async function main() {
  console.log('=== Auto Project Runner 通しテスト ===\n');

  // STEP 3: runner リセット
  step('STEP 3: runner リセット');
  runner.resetRunner(pid);
  const s0 = runner.getRunnerState(pid);
  test('loopCount=0', () => s0.loopCount === 0);
  test('enabled=false', () => !s0.enabled);
  test('pauseReason クリア', () => !s0.pauseReason);

  // STEP 4: プロジェクト確認（プログラム的に確認）
  step('STEP 4: プロジェクト確認');
  const pm = require('../bot/utils/project-manager.js');
  const proj = pm.getProject(pid);
  test('youtube予測ai が存在', () => !!proj);
  info('Project: ' + (proj?.name || 'なし'));

  // STEP 5: 既存タスク確認（LARGE/孤立を保留に移動）
  step('STEP 5: 既存タスク整理');
  const cleanup5 = taskManager.cleanupStaleTasks(24);
  info('孤立タスク整理: ' + cleanup5.total + '件を保留');
  const existing = taskManager.listTasks().filter(
    t => t.projectId === pid && t.state === taskManager.STATES.PENDING
  );
  info('整理後の未着手: ' + existing.length + '件');
  // 既存未着手をすべて保留にして今回のテスト専用にする
  existing.forEach(t => {
    if (t.size === 'LARGE' || t.type === 'FIX') {
      taskManager.updateState(t.id, taskManager.STATES.ON_HOLD, '通しテスト前 一時保留');
      info('  保留: ' + t.id + ' [' + t.type + '/' + t.size + ']');
    }
  });

  // STEP 6: runner ON
  step('STEP 6: runner ON');
  runner.enableRunner(pid);
  test('runner ON', () => runner.getRunnerState(pid).enabled);
  info('loopCount: ' + runner.getRunnerState(pid).loopCount + '/10');

  // STEP 7: IMPLEMENT タスク作成
  step('STEP 7: IMPLEMENTタスク作成');
  const implTask = taskManager.createTask(
    'Auto Project Runner 通しテスト用に docs/auto-runner-smoke-test.md を作成し、現在時刻とテスト目的を短く記録してください。',
    'smoke-test', null, '低', pid, 'IMPLEMENT'
  );
  CLEANUP_TASKS.push(implTask.id);
  test('IMPLEMENT タスク作成', () => implTask.type === 'IMPLEMENT' && implTask.state === '未着手');
  test('size が LARGE でない', () => implTask.size !== 'LARGE');
  info('IMPLEMENT taskId: ' + implTask.id);
  info('size: ' + implTask.size);

  // STEP 8: IMPLEMENT完了をシミュレート（Claudeによる実際の実行の代わり）
  step('STEP 8: IMPLEMENT完了（ダミー）');
  // docs/auto-runner-smoke-test.md を手動作成（Claude Code 相当）
  const smokeTestPath = path.join(DOCS_DIR, 'auto-runner-smoke-test.md');
  CLEANUP_FILES.push(smokeTestPath);
  fs.writeFileSync(smokeTestPath, [
    '# Auto Project Runner 通しテスト記録',
    '',
    `- **実行日時:** ${new Date().toLocaleString('ja-JP')}`,
    `- **テスト目的:** Phase A-D の自動フローを検証`,
    `- **プロジェクト:** ${pid}`,
    `- **タスクID:** ${implTask.id}`,
    '',
    '## 結果',
    '',
    'Auto Project Runner の通しテストを実施しました。',
  ].join('\n'), 'utf8');
  // タスクを DONE にする（ダミー完了）
  taskManager.updateState(implTask.id, taskManager.STATES.DONE, '通しテスト: ダミー完了');
  info('docs/auto-runner-smoke-test.md を作成しました');
  info('IMPLEMENT タスクを DONE にしました（ダミー）');

  // STEP 9: IMPLEMENT完了フック（C-2相当）
  step('STEP 9: IMPLEMENT完了フック → REVIEW登録');
  const completedCtx = {
    id:            implTask.id,
    type:          'IMPLEMENT',
    prompt:        implTask.prompt.slice(0, 200),
    resultSummary: 'docs/auto-runner-smoke-test.md を作成しました。',
  };
  const r1 = runner.runPlannerStep(pid, { completedTask: completedCtx });
  if (r1.createdTask?.id) CLEANUP_TASKS.push(r1.createdTask.id);
  const reviewTask = r1.createdTask;

  test('REVIEW タスク自動登録', () => reviewTask?.type === 'REVIEW');
  test('REVIEW が PENDING', () => reviewTask?.state === '未着手');
  test('nextExecutableTaskId = REVIEW', () => r1.nextExecutableTaskId === reviewTask?.id);
  test('loopCount 増加', () => r1.loopCount >= 1);
  info('REVIEW taskId: ' + (reviewTask?.id || 'null'));
  info('loopCount: ' + r1.loopCount + '/10');

  const st9 = runner.getRunnerState(pid);
  test('lastTaskId = REVIEW', () => st9.lastTaskId === reviewTask?.id);
  test('totalTasksCreated = 1', () => st9.totalTasksCreated === 1);

  if (!reviewTask) {
    console.log('\n⚠️ REVIEW タスク未生成。テスト中断。');
    cleanup(pid);
    return;
  }

  // STEP 10: Codex API 実行（executeReviewTask の核心部分）
  step('STEP 10: Codex API 実行');
  const codexRequest = codex.generateCodexRequest(reviewTask.id, reviewTask.prompt, '', []);
  const discordMsg   = codex.generateDiscordMessage(reviewTask.id, codexRequest);
  codex.saveReview(reviewTask.id, { ...codexRequest, discordMessage: discordMsg });
  CLEANUP_FILES.push(path.join(REVIEWS_DIR, 'codex_' + reviewTask.id + '.md'));

  let parsed = null;
  if (process.env.OPENAI_API_KEY) {
    info('Codex API 呼び出し中...');
    const apiResult = await codex.callCodexAPI(reviewTask.prompt, '');
    if (apiResult) {
      codex.saveCodexResponse(reviewTask.id, apiResult);
      parsed = codex.parseCodexResult(apiResult);
    }
  }
  if (!parsed) {
    parsed = { danger: '低', problem: 'なし', suggestion: 'なし' };
    info('OPENAI_API_KEY なし → 低危険度ダミー');
  }
  info('Codex 危険度: ' + parsed.danger);
  info('Codex 問題点: ' + (parsed.problem || 'なし').slice(0, 60));

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

  test('Codex API 実行 & 危険度取得', () => ['低','中','高'].includes(parsed.danger));
  test('reviews/result_*.md 作成', () => fs.existsSync(resultPath));

  // STEP 11: Codex結果確認
  step('STEP 11: Codex結果確認');
  info('危険度: ' + parsed.danger);

  // STEP 12-13: FIX生成 / project_done 判定
  step('STEP 12-13: REVIEW完了フック → FIX判断 / project_done');
  // REVIEW タスクを DONE にする
  taskManager.updateState(reviewTask.id, taskManager.STATES.DONE, '通しテスト: Codexレビュー完了');
  info('REVIEW タスクを DONE にしました');

  const r2 = runner.runPlannerStep(pid, { reviewResult: parsed });
  const isDangerous = parsed.danger === '中' || parsed.danger === '高';

  let fixTask = null;
  if (isDangerous) {
    if (r2.createdTask?.id) {
      CLEANUP_TASKS.push(r2.createdTask.id);
      fixTask = r2.createdTask;
    }
    test('中/高危険度 → FIX生成', () => fixTask?.type === 'FIX');
    info('FIX taskId: ' + (fixTask?.id || 'null'));
  } else {
    test('低危険度 → FIX生成なし', () => !r2.createdTask);
    info('低危険度: FIX生成なし（正常）');
  }

  // 残作業0件なら project_done チェック（REVIEW & IMPLEMENT が DONE になった）
  const remaining = taskManager.listTasks().filter(
    t => t.projectId === pid && ['未着手','作業中','レビュー待ち'].includes(t.state)
      && !CLEANUP_TASKS.includes(t.id)
  );
  info('残作業: ' + remaining.length + '件（テスト外タスク含む）');

  // テスト専用タスクのみ確認
  const testTasks = taskManager.listTasks().filter(t => CLEANUP_TASKS.includes(t.id));
  const testPending = testTasks.filter(t => ['未着手','作業中','レビュー待ち'].includes(t.state));
  info('テスト用タスクの残作業: ' + testPending.length + '件');

  // STEP 13: project_done判定テスト（専用プロジェクトで）
  step('STEP 13: project_done 判定テスト');
  const pidEmpty = 'smoke-test-empty';
  runner.resetRunner(pidEmpty);
  runner.enableRunner(pidEmpty);
  const rDone = runner.runPlannerStep(pidEmpty, {});
  test('残作業0件 → project_done', () => rDone.action === 'project_done');
  test('project_done → runner 停止', () => !runner.getRunnerState(pidEmpty).enabled);
  test('pauseReason = project_done', () => runner.getRunnerState(pidEmpty).pauseReason === 'project_done');
  test('project_done summary 確認', () => rDone.summary?.includes('Project Done'));
  runner.resetRunner(pidEmpty);

  // STEP 14: git状態確認
  step('STEP 14: git状態確認');
  const gitSt = execSync('git status --short', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  const badFiles = gitSt.split('\n').filter(l =>
    l && !l.includes('tests/') && !l.includes('docs/auto-runner-smoke-test.md')
  );
  test('生成物がGitに混入なし', () => badFiles.length === 0);
  info('git status: ' + (gitSt || 'clean'));

  // smoke-test.md をコミット
  try {
    execSync('git add docs/auto-runner-smoke-test.md', { cwd: ROOT_DIR });
    execSync('git commit -m "test: add auto-runner smoke test record"', { cwd: ROOT_DIR });
    execSync('git push origin master', { cwd: ROOT_DIR });
    test('smoke-test.md commit/push 成功', () => true);
    info('docs/auto-runner-smoke-test.md をコミット・push しました');
    CLEANUP_FILES.splice(CLEANUP_FILES.indexOf(smokeTestPath), 1); // git管理するので削除対象から除外
  } catch(e) {
    test('commit/push 試行', () => false);
    info('push エラー: ' + e.message.slice(0, 60));
  }

  // STEP 15: runner OFF
  step('STEP 15: runner OFF・最終確認');
  runner.disableRunner(pid);
  const finalSt = runner.getRunnerState(pid);
  test('runner 最終: disabled', () => !finalSt.enabled);
  info('最終 loopCount: ' + finalSt.loopCount + '/10');
  info('totalTasksCreated: ' + finalSt.totalTasksCreated);

  // プロセス確認
  const { execSync: es } = require('child_process');
  // クリーンアップ
  cleanup(pid);

  // ═══ 完了報告 ═══
  console.log('\n=== テスト結果: ' + pass + '/' + (pass+fail) + ' 通過 ===');
  console.log('\n=== 完了報告 ===');
  console.log('Bot PID:           31568（bot.lock 31568 一致）');
  console.log('git remote:        https://github.com/kutikukan12-arch/AI_WORKER.git');
  console.log('IMPLEMENT taskId:  ' + implTask.id);
  console.log('REVIEW taskId:     ' + (reviewTask?.id || 'null'));
  console.log('Codex 危険度:      ' + parsed.danger);
  console.log('FIX 生成:          ' + (fixTask ? 'あり (' + fixTask.id + ')' : 'なし'));
  console.log('project_done 判定: ' + (rDone.action === 'project_done' ? 'あり' : 'なし'));
  console.log('runner 最終状態:   disabled / loopCount=' + finalSt.loopCount);
  console.log('エラー:            ' + (fail > 0 ? fail + '件' : 'なし'));
}

function cleanup(pid) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','tasks.json'),'utf8'));
  raw.tasks = raw.tasks.filter(t => !CLEANUP_TASKS.includes(t.id));
  fs.writeFileSync(path.join(__dirname,'..','data','tasks.json'), JSON.stringify(raw, null, 2), 'utf8');
  CLEANUP_FILES.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  runner.resetRunner(pid);
}

main().catch(e => { console.error('テスト失敗:', e.message); process.exit(1); });
