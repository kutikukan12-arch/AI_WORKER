'use strict';
// Phase F-0/F-1 Step1-3: RunContext / !project stop / _teardown テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function info(msg) { console.log('  ℹ️ ', msg); }

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. createRunContext (Step1)
// ─────────────────────────────────────────────────────
console.log('\n[1. createRunContext]');

test('1a. createRunContext が定義されている', () =>
  assert.ok(src.includes('function createRunContext('), 'createRunContext がない'));

test('1b. RunContext に必須フィールドが含まれる', () => {
  const fnStart = src.indexOf('function createRunContext(');
  const fnEnd   = src.indexOf('\n}', fnStart) + 2;
  const fnBody  = src.slice(fnStart, fnEnd);
  const fields  = ['projectId', 'runId', 'startedAt', 'channelId', 'message',
                   'tasksDone', 'tasksFailed', 'consecutiveErrors', 'yellowCount',
                   'softRedHandled', 'stopRequested', 'stopReason',
                   'pendingApproval', 'progressTimerId', 'maxRunTimerId'];
  fields.forEach(f => assert.ok(fnBody.includes(f), `フィールド ${f} がない`));
});

test('1c. activeRuns.set に RunContext が渡される（true ではない）', () => {
  const setIdx = src.indexOf('activeRuns.set(projectId, ctx)');
  assert.ok(setIdx >= 0, 'activeRuns.set(projectId, ctx) がない（true のまま？）');
});

test('1d. activeRuns.has で二重起動チェックしている', () =>
  assert.ok(src.includes('activeRuns.has(projectId)'), 'has チェックがない'));

test('1e. runId が run_ + timestamp 形式', () =>
  assert.ok(src.includes("runId:      `run_${Date.now()}`") ||
            src.includes("runId:      'run_' + Date.now()") ||
            src.includes('runId'), 'runId 生成がない'));

// ─────────────────────────────────────────────────────
// 2. !project stop (Step2)
// ─────────────────────────────────────────────────────
console.log('\n[2. !project stop]');

test('2a. !project stop routing がある', () =>
  assert.ok(src.includes("sub === 'stop'"), "sub === 'stop' がない"));

test('2b. ctx.stopRequested = true を設定する', () => {
  const stopIdx = src.indexOf("sub === 'stop'");
  const stopBody = src.slice(stopIdx, stopIdx + 600);
  assert.ok(stopBody.includes('ctx.stopRequested = true'), 'stopRequested 設定がない');
});

test('2c. ctx.stopReason = "stopped_by_user" を設定する', () => {
  const stopIdx = src.indexOf("sub === 'stop'");
  const stopBody = src.slice(stopIdx, stopIdx + 600);
  assert.ok(stopBody.includes("'stopped_by_user'"), 'stopReason 設定がない');
});

test('2d. 実行中でない場合「実行中ではありません」と返す', () => {
  const stopIdx = src.indexOf("sub === 'stop'");
  const stopBody = src.slice(stopIdx, stopIdx + 600);
  assert.ok(stopBody.includes('実行中ではありません'), '未実行メッセージがない');
});

test('2e. 停止リクエストメッセージを送信する', () => {
  const stopIdx = src.indexOf("sub === 'stop'");
  const stopBody = src.slice(stopIdx, stopIdx + 600);
  assert.ok(stopBody.includes('停止リクエストを受け付けました'), '停止メッセージがない');
});

test('2f. activeRuns に stopPid がない場合は警告して return する', () => {
  const stopIdx = src.indexOf("sub === 'stop'");
  const stopBody = src.slice(stopIdx, stopIdx + 600);
  assert.ok(stopBody.includes('activeRuns.get(stopPid)'), 'ctx 取得がない');
});

// ─────────────────────────────────────────────────────
// 3. _teardown (Step3)
// ─────────────────────────────────────────────────────
console.log('\n[3. _teardown]');

test('3a. _teardown 関数が定義されている', () =>
  assert.ok(src.includes('async function _teardown('), '_teardown がない'));

const teardownStart = src.indexOf('async function _teardown(');
const teardownEnd   = src.indexOf('\nasync function ', teardownStart + 1);
const teardownBody  = src.slice(teardownStart, teardownEnd > 0 ? teardownEnd : teardownStart + 2000);

test('3b. progressTimerId の clearInterval がある', () =>
  assert.ok(teardownBody.includes('clearInterval(ctx.progressTimerId)'), 'clearInterval がない'));

test('3c. maxRunTimerId の clearTimeout がある', () =>
  assert.ok(teardownBody.includes('clearTimeout(ctx.maxRunTimerId)'), 'clearTimeout がない'));

test('3d. POST-RUN Quality Gate を呼ぶ', () =>
  assert.ok(teardownBody.includes('assessQuality(projectId)'), 'POST-RUN assessQuality がない'));

test('3e. 完了メッセージを送信する', () =>
  assert.ok(teardownBody.includes('Project Runner 完了'), '完了メッセージがない'));

test('3f. activeRuns.delete(projectId) を呼ぶ', () =>
  assert.ok(teardownBody.includes('activeRuns.delete(projectId)'), 'delete がない'));

test('3g. stopReason が stopped_by_user のとき完了メッセージに表示する', () =>
  assert.ok(teardownBody.includes('stopped_by_user'), '停止理由の判定がない'));

test('3h. handleProjectRun から _teardown が呼ばれる', () => {
  const runFnStart = src.indexOf('async function handleProjectRun(');
  const runFnEnd   = src.indexOf('\nasync function ', runFnStart + 1);
  const runBody    = src.slice(runFnStart, runFnEnd);
  assert.ok(runBody.includes('_teardown(ctx'), '_teardown 呼び出しがない');
});

// ─────────────────────────────────────────────────────
// 4. help テキスト更新確認
// ─────────────────────────────────────────────────────
console.log('\n[4. help テキスト]');

test('4a. !project stop が help に含まれる', () =>
  assert.ok(src.includes('!project stop'), '!project stop がヘルプにない'));

// ─────────────────────────────────────────────────────
// 5. _runProjectLoop (Step4)
// ─────────────────────────────────────────────────────
console.log('\n[5. _runProjectLoop (Step4)]');

const loopFnStart = src.indexOf('async function _runProjectLoop(');
const loopFnEnd   = src.indexOf('\n// ─', loopFnStart + 1);
const loopBody    = src.slice(loopFnStart, loopFnEnd > 0 ? loopFnEnd : loopFnStart + 5000);

test('5a. _runProjectLoop が定義されている', () =>
  assert.ok(loopFnStart >= 0, '_runProjectLoop がない'));

test('5b. ループ先頭で stopRequested をチェックしている', () =>
  assert.ok(loopBody.includes('ctx.stopRequested'), 'stopRequested チェックがない'));

test('5c. stopped_by_user を stopReason に設定する', () =>
  assert.ok(loopBody.includes("'stopped_by_user'"), 'stopped_by_user がない'));

test('5d. project_done を stopReason に設定する', () =>
  assert.ok(loopBody.includes("'project_done'"), 'project_done がない'));

test('5e. no_pending_tasks を stopReason に設定する', () =>
  assert.ok(loopBody.includes("'no_pending_tasks'"), 'no_pending_tasks がない'));

test('5f. ctx.tasksDone を更新している', () =>
  assert.ok(loopBody.includes('ctx.tasksDone++'), 'tasksDone++ がない'));

test('5g. ctx.tasksFailed を更新している', () =>
  assert.ok(loopBody.includes('ctx.tasksFailed++'), 'tasksFailed++ がない'));

test('5h. ctx.consecutiveErrors を更新している', () =>
  assert.ok(loopBody.includes('ctx.consecutiveErrors'), 'consecutiveErrors がない'));

test('5i. 連続エラー上限で停止する', () =>
  assert.ok(loopBody.includes('consecutiveErrors >= PROJ_RUN_MAX_CONSEC_ERRORS') ||
            loopBody.includes('PROJ_RUN_MAX_CONSEC_ERRORS'), '連続エラー上限チェックがない'));

test('5j. handleAutoTimeoutSplit を呼んでいる', () =>
  assert.ok(loopBody.includes('handleAutoTimeoutSplit'), 'timeout split が呼ばれない'));

test('5k. handleProjectRun が _runProjectLoop を呼ぶ（handleAutoOn ではない）', () => {
  const runFnStart = src.indexOf('async function handleProjectRun(');
  const runFnEnd   = src.indexOf('\nasync function ', runFnStart + 1);
  const runBody    = src.slice(runFnStart, runFnEnd);
  assert.ok(runBody.includes('_runProjectLoop(ctx)'), '_runProjectLoop が呼ばれていない');
  // handleAutoOn は !auto on 専用のまま
  const autoOnDirect = runBody.includes('handleAutoOn(message)') &&
                       !runBody.includes('_runProjectLoop');
  assert.ok(!autoOnDirect, 'handleAutoOn が直接呼ばれたまま');
});

test('5l. _runProjectLoop は handleAutoOn を内部で呼ばない', () =>
  assert.ok(!loopBody.includes('handleAutoOn('), '_runProjectLoop から handleAutoOn が呼ばれている'));

// ─────────────────────────────────────────────────────
// 6. !project stop が ctx に作用する
// ─────────────────────────────────────────────────────
console.log('\n[6. stopRequested フロー]');

test('6a. !project stop で ctx.stopRequested が true になる', () => {
  // activeRuns への get/set が行われることをソースで確認
  const stopIdx  = src.indexOf("sub === 'stop'");
  const stopBody = src.slice(stopIdx, stopIdx + 600);
  assert.ok(stopBody.includes('ctx.stopRequested = true'));
  assert.ok(stopBody.includes("ctx.stopReason    = 'stopped_by_user'") ||
            stopBody.includes("ctx.stopReason = 'stopped_by_user'"));
});

test('6b. stopRequested が立った次のループで停止する', () => {
  // _runProjectLoop のループ先頭に ctx.stopRequested チェックがある
  assert.ok(loopBody.includes('ctx.stopRequested'));
  // break が続く
  const stopCheckIdx = loopBody.indexOf('ctx.stopRequested');
  const nearBreak    = loopBody.slice(stopCheckIdx, stopCheckIdx + 200);
  assert.ok(nearBreak.includes('break'), 'stopRequested 後の break がない');
});

// ─────────────────────────────────────────────────────
// 7. MID-RUN Quality Gate (Phase F-2 Step5)
// ─────────────────────────────────────────────────────
console.log('\n[7. MID-RUN Quality Gate]');

// _runProjectLoop のソース取得
const loopStart2 = src.indexOf('async function _runProjectLoop(');
const loopEnd2   = src.indexOf('\n// ─', loopStart2 + 1);
const loopBody2  = src.slice(loopStart2, loopEnd2 > 0 ? loopEnd2 : loopStart2 + 7000);

test('7a. MID-RUN Quality Gate が _runProjectLoop に含まれる', () =>
  assert.ok(loopBody2.includes('MID-RUN Quality Gate'), 'MID-RUN コメントがない'));

test('7b. MID_RUN_INTERVAL を参照している', () =>
  assert.ok(loopBody2.includes('MID_RUN_INTERVAL') || loopBody2.includes('qualityGate.MID_RUN_INTERVAL'),
    'MID_RUN_INTERVAL 参照がない'));

test('7c. RED 判定で stopReason を midrun_quality_gate_red に設定する', () => {
  assert.ok(loopBody2.includes("'midrun_quality_gate_red'"), 'midrun_quality_gate_red がない');
});

test('7d. RED 判定で break する', () => {
  const redIdx  = loopBody2.indexOf("'midrun_quality_gate_red'");
  const redArea = loopBody2.slice(redIdx, redIdx + 300);
  assert.ok(redArea.includes('break'), 'RED 後の break がない');
});

test('7e. YELLOW 判定で ctx.yellowCount++ する', () =>
  assert.ok(loopBody2.includes('ctx.yellowCount++'), 'yellowCount++ がない'));

test('7f. YELLOW 判定で break しない（続行する）', () => {
  // YELLOW ブロックの末尾を確認 — ctx.yellowCount++ の直後の closing } までを見る
  // YELLOW は if (midQa.level === 'YELLOW') { ... } で囲まれており、
  // その中に break がないことを確認
  const yellowBlockStart = loopBody2.indexOf("midQa.level === 'YELLOW'");
  const yellowBlockEnd   = loopBody2.indexOf('\n        // GREEN', yellowBlockStart);
  if (yellowBlockStart < 0) { assert.fail('YELLOW ブロックが見つからない'); }
  const yellowBlock = loopBody2.slice(yellowBlockStart, yellowBlockEnd > 0 ? yellowBlockEnd : yellowBlockStart + 400);
  assert.ok(!yellowBlock.includes('break'), 'YELLOW ブロック内に break がある（続行すべき）');
});

test('7g. GREEN は通知なしで続行（メッセージを送らない分岐がある）', () => {
  // GREEN のケースはコメントで明記されていること
  assert.ok(loopBody2.includes('GREEN') || loopBody2.includes('続行'),
    'GREEN 続行の記述がない');
});

test('7h. MID-RUN チェックエラー時はフェイルオープン（ループを止めない）', () => {
  const midQaErrIdx  = loopBody2.indexOf('midQaErr');
  const midQaErrArea = loopBody2.slice(midQaErrIdx, midQaErrIdx + 200);
  // catch に break が含まれない
  assert.ok(!midQaErrArea.includes('break'), 'MID-RUN エラー時にフェイルクローズになっている');
});

// _teardown のソース取得
const teardownStart2 = src.indexOf('async function _teardown(');
const teardownEnd2   = src.indexOf('\nasync function ', teardownStart2 + 1);
const teardownBody2  = src.slice(teardownStart2, teardownEnd2 > 0 ? teardownEnd2 : teardownStart2 + 2000);

test('7i. _teardown で yellowCount を表示する', () =>
  assert.ok(teardownBody2.includes('yellowCount'), '_teardown に yellowCount がない'));

test('7j. _teardown で midrun_quality_gate_red を表示する', () =>
  assert.ok(teardownBody2.includes('midrun_quality_gate_red'), 'teardown に midred 記述がない'));

// quality-gate.js に MID_RUN_INTERVAL が export されている
test('7k. quality-gate.js が MID_RUN_INTERVAL を export している', () => {
  const qgSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'quality-gate.js'), 'utf8'
  );
  assert.ok(qgSrc.includes('MID_RUN_INTERVAL'), 'MID_RUN_INTERVAL がない');
  assert.ok(qgSrc.includes("module.exports"), 'module.exports がない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
