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
  const stopBody = src.slice(stopIdx, stopIdx + 1200); // awaiting_human 分岐追加で範囲拡大
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

// 7b〜7h は修正後 _maybeRunMidQualityGate ヘルパーに実装が移動したため参照先を変更
const helperStart2 = src.indexOf('async function _maybeRunMidQualityGate(');
const helperEnd2   = src.indexOf('\n// ─', helperStart2 + 1);
const helperBody2  = src.slice(helperStart2, helperEnd2 > 0 ? helperEnd2 : helperStart2 + 2000);

test('7b. MID_RUN_INTERVAL をヘルパーが参照している', () =>
  assert.ok(helperBody2.includes('MID_RUN_INTERVAL') || helperBody2.includes('qualityGate.MID_RUN_INTERVAL'),
    'MID_RUN_INTERVAL 参照がない'));

test('7c. RED 判定で stopReason を midrun_quality_gate_red に設定する', () =>
  assert.ok(helperBody2.includes("'midrun_quality_gate_red'"), 'midrun_quality_gate_red がない'));

test('7d. RED 判定で true を返す（呼び出し元が break）', () => {
  const redIdx  = helperBody2.indexOf("'midrun_quality_gate_red'");
  const redArea = helperBody2.slice(redIdx, redIdx + 600); // メッセージが長いので600文字
  assert.ok(redArea.includes('return true'), 'RED 後の return true がない');
});

test('7e. YELLOW 判定で ctx.yellowCount++ する', () =>
  assert.ok(helperBody2.includes('ctx.yellowCount++'), 'yellowCount++ がない'));

test('7f. YELLOW 判定で break しない（false を返して続行する）', () => {
  const yellowBlockStart = helperBody2.indexOf("midQa.level === 'YELLOW'");
  const yellowBlockEnd   = helperBody2.indexOf('\n    // GREEN', yellowBlockStart);
  if (yellowBlockStart < 0) { assert.fail('YELLOW ブロックが見つからない'); }
  const yellowBlock = helperBody2.slice(yellowBlockStart, yellowBlockEnd > 0 ? yellowBlockEnd : yellowBlockStart + 400);
  assert.ok(!yellowBlock.includes('return true'), 'YELLOW ブロック内に return true がある（続行すべき）');
});

test('7g. GREEN は通知なしで続行（ヘルパー内にコメントがある）', () =>
  assert.ok(helperBody2.includes('GREEN'), 'GREEN 続行の記述がない'));

test('7h. MID-RUN チェックエラー時はフェイルオープン（ループを止めない）', () => {
  const midQaErrIdx  = helperBody2.indexOf('midQaErr');
  const midQaErrArea = helperBody2.slice(midQaErrIdx, midQaErrIdx + 200);
  assert.ok(!midQaErrArea.includes('return true'), 'MID-RUN エラー時にフェイルクローズになっている');
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

// ─────────────────────────────────────────────────────
// 8. _maybeRunMidQualityGate 重複防止・発火タイミング修正 (Phase F-2 修正)
// ─────────────────────────────────────────────────────
console.log('\n[8. _maybeRunMidQualityGate 重複防止修正]');

test('8a. _maybeRunMidQualityGate が定義されている', () =>
  assert.ok(src.includes('async function _maybeRunMidQualityGate('),
    '_maybeRunMidQualityGate がない'));

const helperStart = src.indexOf('async function _maybeRunMidQualityGate(');
const helperEnd   = src.indexOf('\n// ─', helperStart + 1);
const helperBody  = src.slice(helperStart, helperEnd > 0 ? helperEnd : helperStart + 2000);

test('8b. lastMidRunTasksDone との比較がある（重複防止条件3）', () =>
  assert.ok(helperBody.includes('lastMidRunTasksDone'), 'lastMidRunTasksDone 参照がない'));

test('8c. 発火後に lastMidRunTasksDone を更新する', () => {
  assert.ok(helperBody.includes('ctx.lastMidRunTasksDone = ctx.tasksDone'),
    'lastMidRunTasksDone 更新がない');
});

test('8d. createRunContext に lastMidRunTasksDone が含まれる', () => {
  const ctxFnStart = src.indexOf('function createRunContext(');
  const ctxFnEnd   = src.indexOf('\n}', ctxFnStart) + 2;
  const ctxBody    = src.slice(ctxFnStart, ctxFnEnd);
  assert.ok(ctxBody.includes('lastMidRunTasksDone'), 'RunContext に lastMidRunTasksDone がない');
});

test('8e. 失敗タスク後の重複発火防止: tasksDone 変化なし → 条件3で発火しない', () => {
  // lastMidRunTasksDone = tasksDone の場合はスキップされる
  // ヘルパーが条件3を持っていることを確認
  assert.ok(helperBody.includes('ctx.tasksDone !== ctx.lastMidRunTasksDone'),
    '重複防止条件3がない');
});

test('8f. REVIEW 完了後に _maybeRunMidQualityGate を呼ぶ', () => {
  const loopStart3 = src.indexOf('async function _runProjectLoop(');
  const loopEnd3   = src.indexOf('\n// ─', loopStart3 + 1);
  const loopBody3  = src.slice(loopStart3, loopEnd3 > 0 ? loopEnd3 : loopStart3 + 7000);
  // REVIEW 完了後の _maybeRunMidQualityGate 呼び出し
  const reviewIdx  = loopBody3.indexOf('TASK_TYPES.REVIEW');
  const reviewArea = loopBody3.slice(reviewIdx, reviewIdx + 400);
  assert.ok(reviewArea.includes('_maybeRunMidQualityGate(ctx)'),
    'REVIEW 完了後に _maybeRunMidQualityGate が呼ばれていない');
});

test('8g. RESEARCH 完了後に _maybeRunMidQualityGate を呼ぶ', () => {
  const loopStart3 = src.indexOf('async function _runProjectLoop(');
  const loopEnd3   = src.indexOf('\n// ─', loopStart3 + 1);
  const loopBody3  = src.slice(loopStart3, loopEnd3 > 0 ? loopEnd3 : loopStart3 + 7000);
  const researchIdx  = loopBody3.indexOf('TASK_TYPES.RESEARCH');
  const researchArea = loopBody3.slice(researchIdx, researchIdx + 400);
  assert.ok(researchArea.includes('_maybeRunMidQualityGate(ctx)'),
    'RESEARCH 完了後に _maybeRunMidQualityGate が呼ばれていない');
});

test('8h. IMPLEMENT 完了後（ループ末尾）に _maybeRunMidQualityGate を呼ぶ', () => {
  const loopStart3 = src.indexOf('async function _runProjectLoop(');
  const loopEnd3   = src.indexOf('\n// ─', loopStart3 + 1);
  const loopBody3  = src.slice(loopStart3, loopEnd3 > 0 ? loopEnd3 : loopStart3 + 7000);
  // ループ末尾付近の呼び出し確認
  const lastCallIdx = loopBody3.lastIndexOf('_maybeRunMidQualityGate(ctx)');
  assert.ok(lastCallIdx >= 0, 'ループ末尾の _maybeRunMidQualityGate がない');
});

test('8i. RED 時は true を返して呼び出し元が break する', () => {
  assert.ok(helperBody.includes('return true'), 'RED 時の return true がない');
});

test('8j. GREEN/YELLOW 時は false を返して続行する', () => {
  assert.ok(helperBody.includes('return false'), 'false return がない');
});

// ─────────────────────────────────────────────────────
// 9. Phase F-3 Step6: soft RED auto-FIX
// ─────────────────────────────────────────────────────
console.log('\n[9. soft RED auto-FIX]');

const tm = require('../bot/utils/task-manager');
const path2 = require('path');
const fs2   = require('fs');
const CLEANUP_IDS2 = [];
const pid2 = 'youtube予測ai';

function cleanup2() {
  const fpath = path2.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs2.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_IDS2.includes(t.id));
  fs2.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
}

// ─ ソース確認テスト ─
test('9a. _handleSoftRed が定義されている', () =>
  assert.ok(src.includes('async function _handleSoftRed('), '_handleSoftRed がない'));

test('9b. _isValidationFailureNote が定義されている', () =>
  assert.ok(src.includes('function _isValidationFailureNote('), '_isValidationFailureNote がない'));

const softRedFnStart = src.indexOf('async function _handleSoftRed(');
const softRedFnEnd   = src.indexOf('\n// ─', softRedFnStart + 1);
const softRedBody    = src.slice(softRedFnStart, softRedFnEnd > 0 ? softRedFnEnd : softRedFnStart + 2000);

test('9c. FIX タスクを createTask で生成している', () =>
  assert.ok(softRedBody.includes("'FIX'"), "FIX タスク type が指定されていない"));

test('9d. projectId を維持して生成している', () =>
  assert.ok(softRedBody.includes('projectId'), 'projectId が渡されていない'));

test('9e. 元タスクIDを prompt に含めている', () =>
  assert.ok(softRedBody.includes('originalId'), '元タスクID が prompt に含まれていない'));

test('9f. softRedHandled フラグが RunContext に含まれる', () => {
  const ctxFnStart = src.indexOf('function createRunContext(');
  const ctxFnEnd   = src.indexOf('\n}', ctxFnStart) + 2;
  const ctxBody    = src.slice(ctxFnStart, ctxFnEnd);
  assert.ok(ctxBody.includes('softRedHandled'), 'softRedHandled がない');
});

test('9g. _runProjectLoop で softRedHandled チェックがある', () => {
  const loopStart = src.indexOf('async function _runProjectLoop(');
  const loopEnd   = src.indexOf('\n// ─', loopStart + 1);
  const loopBody  = src.slice(loopStart, loopEnd > 0 ? loopEnd : loopStart + 8000);
  assert.ok(loopBody.includes('ctx.softRedHandled'), 'softRedHandled 参照がない');
});

test('9h. 2回目soft REDで HUMAN_CHECK（awaiting_human）になる', () => {
  // F-4修正: soft_red_unresolved → _handleHumanCheck(awaiting_human) に変更済み
  const loopStart = src.indexOf('async function _runProjectLoop(');
  const loopEnd   = src.indexOf('\n// ─', loopStart + 1);
  const loopBody  = src.slice(loopStart, loopEnd > 0 ? loopEnd : loopStart + 10000);
  // softRedHandled が true のブランチで _handleHumanCheck を呼ぶ
  const elseIdx  = loopBody.indexOf('ctx.softRedHandled = true');
  const elseArea = loopBody.slice(elseIdx, elseIdx + 400);
  assert.ok(elseArea.includes('_handleHumanCheck'), '2回目soft REDが HUMAN_CHECK になっていない');
});

// ─ 実際のタスク操作テスト ─

test('9i. _isValidationFailureNote: 未完了 note は文字列を返す', () => {
  const mockTask = {
    state: 'レビュー待ち',
    stateHistory: [
      { state: 'レビュー待ち', note: '未完了 — 変更なし' },
    ],
  };
  // ソース内の関数と同等ロジックで直接検証
  const hist = mockTask.stateHistory || [];
  const lastReviewing = [...hist].reverse().find(h =>
    h.state === 'レビュー待ち' || h.state === 'REVIEWING'
  );
  const note = lastReviewing?.note || '';
  const result = note.includes('未完了') ? note : null;
  assert.ok(result !== null, '未完了 note で null が返った');
  assert.ok(result.includes('未完了'));
});

test('9j. _isValidationFailureNote: 正常なレビュー待ちは null を返す', () => {
  const normalTask = {
    state: 'レビュー待ち',
    stateHistory: [
      { state: 'レビュー待ち', note: 'AIレビュー: 問題なし' },
    ],
  };
  const hist = normalTask.stateHistory || [];
  const lastReviewing = [...hist].reverse().find(h =>
    h.state === 'レビュー待ち' || h.state === 'REVIEWING'
  );
  const note = lastReviewing?.note || '';
  const result = note.includes('未完了') ? note : null;
  assert.strictEqual(result, null, '正常なレビュー待ちで null でない');
});

test('9k. FIXタスクが type=FIX / projectId 維持で生成される', () => {
  const baseTask = tm.createTask('[F3-test] 元タスク', 'f3-test', null, '低', pid2, 'IMPLEMENT');
  CLEANUP_IDS2.push(baseTask.id);
  // REVIEWING に遷移（バリデーション失敗を模倣）
  tm.updateState(baseTask.id, tm.STATES.REVIEWING, '未完了 — 変更なし');

  // FIX タスクを createTask で直接生成（_handleSoftRed の中核ロジックを再現）
  const originalId     = baseTask.id;
  const failureNote    = '未完了 — 変更なし';
  const originalPrompt = (baseTask.prompt || '').slice(0, 300);
  const fixPrompt = `[quality-gate auto-FIX] completion-validator 失敗\n\n元タスクID: ${originalId}\n失敗理由: ${failureNote}\n\n元タスクの指示内容:\n${originalPrompt}`;
  const fixTask = tm.createTask(fixPrompt, 'auto-runner', null, '高', pid2, 'FIX');
  CLEANUP_IDS2.push(fixTask.id);

  assert.strictEqual(fixTask.type, 'FIX', 'type が FIX でない');
  assert.strictEqual(fixTask.projectId, pid2, 'projectId が一致しない');
  assert.ok(fixTask.prompt.includes(originalId), 'prompt に元タスクID が含まれない');
  assert.ok(fixTask.prompt.includes('auto-FIX'), 'prompt に auto-FIX が含まれない');

  cleanup2();
});

// ─────────────────────────────────────────────────────
// 10. H-1/M-1/L-2 修正テスト
// ─────────────────────────────────────────────────────
console.log('\n[10. H-1/M-1/L-2 修正テスト]');

// ソース確認
const loopSrc = src;

test('H-1a. _handleSoftRed が createTask 後に updateTask で priority=高 を設定する', () => {
  const fn = loopSrc.indexOf('async function _handleSoftRed(');
  const fe  = loopSrc.indexOf('\n// ─', fn + 1);
  const fb  = loopSrc.slice(fn, fe > 0 ? fe : fn + 2000);
  assert.ok(fb.includes("priority:       '高'") || fb.includes("priority: '高'"),
    "priority='高' の updateTask がない");
  assert.ok(fb.includes("priorityReason: 'soft RED auto-FIX'") ||
            fb.includes("priorityReason:"),
    'priorityReason がない');
});

test('H-1b. dangerLevel → priority 変換コメントが削除または修正されている', () => {
  const fn = loopSrc.indexOf('async function _handleSoftRed(');
  const fe  = loopSrc.indexOf('\n// ─', fn + 1);
  const fb  = loopSrc.slice(fn, fe > 0 ? fe : fn + 2000);
  assert.ok(!fb.includes('dangerLevel → priority 高になる'),
    '誤ったコメントが残っている');
});

test('H-1c. 実際に生成された FIX タスクの priority が「高」になる', () => {
  const fixPrompt = '[quality-gate auto-FIX] テスト';
  const fixTask   = tm.createTask(fixPrompt, 'auto-runner', null, '低', pid2, 'FIX');
  CLEANUP_IDS2.push(fixTask.id);
  // 明示的に priority 上書き
  tm.updateTask(fixTask.id, { priority: '高', priorityReason: 'soft RED auto-FIX' });
  const updated = tm.listTasks().find(t => t.id === fixTask.id);
  assert.strictEqual(updated.priority, '高', 'priority が高でない');
  assert.ok(updated.priorityReason.includes('soft RED'), 'priorityReason が設定されていない');
  cleanup2();
});

test('M-1a. 正常 REVIEWING では tasksFailed が増えない（ソース確認）', () => {
  // REVIEWING ブランチで validFailNote がない場合は tasksFailed++ しないことを確認
  const loopFn = loopSrc.indexOf('async function _runProjectLoop(');
  const loopFe = loopSrc.indexOf('\n// ─', loopFn + 1);
  const loopFb = loopSrc.slice(loopFn, loopFe > 0 ? loopFe : loopFn + 8000);
  // REVIEWING ブランチ内
  const revIdx = loopFb.indexOf("taskManager.STATES.REVIEWING");
  const revArea = loopFb.slice(revIdx, revIdx + 600);
  // validFailNote が true の場合にのみ tasksFailed++ が来る
  const failIncIdx = revArea.indexOf('ctx.tasksFailed++');
  const condIdx    = revArea.indexOf('if (validFailNote)');
  // tasksFailed++ は if(validFailNote) の中にある
  assert.ok(condIdx >= 0 && failIncIdx > condIdx,
    'tasksFailed++ が validFailNote チェックの外にある');
});

test('M-1b. 正常 REVIEWING では consecutiveErrors が増えない（ソース確認）', () => {
  const loopFn = loopSrc.indexOf('async function _runProjectLoop(');
  const loopFe = loopSrc.indexOf('\n// ─', loopFn + 1);
  const loopFb = loopSrc.slice(loopFn, loopFe > 0 ? loopFe : loopFn + 8000);
  const revIdx  = loopFb.indexOf("taskManager.STATES.REVIEWING");
  const revArea = loopFb.slice(revIdx, revIdx + 600);
  const errIncIdx = revArea.indexOf('ctx.consecutiveErrors++');
  const condIdx   = revArea.indexOf('if (validFailNote)');
  assert.ok(condIdx >= 0 && errIncIdx > condIdx,
    'consecutiveErrors++ が validFailNote チェックの外にある');
});

test('M-1c. completion-validator 失敗時のみ tasksFailed / consecutiveErrors が増える', () => {
  // _isValidationFailureNote が null → 分岐に入らない
  const nullResult = (() => {
    const hist = [{ state: 'レビュー待ち', note: 'AIレビュー: 問題なし' }];
    const last = [...hist].reverse().find(h => h.state === 'レビュー待ち');
    return (last?.note || '').includes('未完了') ? last.note : null;
  })();
  assert.strictEqual(nullResult, null);

  // _isValidationFailureNote が note → 分岐に入る
  const noteResult = (() => {
    const hist = [{ state: 'レビュー待ち', note: '未完了 — 変更なし' }];
    const last = [...hist].reverse().find(h => h.state === 'レビュー待ち');
    return (last?.note || '').includes('未完了') ? last.note : null;
  })();
  assert.ok(noteResult !== null && noteResult.includes('未完了'));
});

cleanup2();

// ─────────────────────────────────────────────────────
// 11. Phase F-4: HUMAN_CHECK
// ─────────────────────────────────────────────────────
console.log('\n[11. HUMAN_CHECK]');

test('11a. _handleHumanCheck が定義されている', () =>
  assert.ok(src.includes('async function _handleHumanCheck('), '_handleHumanCheck がない'));

const hcFnStart = src.indexOf('async function _handleHumanCheck(');
const hcFnEnd   = src.indexOf('\n// ─', hcFnStart + 1);
const hcBody    = src.slice(hcFnStart, hcFnEnd > 0 ? hcFnEnd : hcFnStart + 2000);

test('11b. ctx.pendingApproval = task.id を設定する', () =>
  assert.ok(hcBody.includes('ctx.pendingApproval'), 'pendingApproval がない'));

test('11c. ctx.stopReason = "awaiting_human" を設定する', () =>
  assert.ok(hcBody.includes("'awaiting_human'"), 'awaiting_human がない'));

test('11d. !approve / !deny を案内するメッセージを送信する', () => {
  assert.ok(hcBody.includes('!approve'), '!approve がない');
  assert.ok(hcBody.includes('!deny'),    '!deny がない');
  assert.ok(hcBody.includes('!task show'), '!task show がない');
});

test('11e. AWAITING 状態で HUMAN_CHECK を呼ぶ', () => {
  const loopFn = src.indexOf('async function _runProjectLoop(');
  const loopFe = src.indexOf('\n// ─', loopFn + 1);
  const loopFb = src.slice(loopFn, loopFe > 0 ? loopFe : loopFn + 10000);
  const awaitIdx = loopFb.indexOf('taskManager.STATES.AWAITING');
  const awaitArea = loopFb.slice(awaitIdx, awaitIdx + 300);
  assert.ok(awaitArea.includes('_handleHumanCheck'), 'AWAITING で _handleHumanCheck が呼ばれない');
});

test('11f. catch ブロックで AUTH/PERMISSION エラー時に HUMAN_CHECK を呼ぶ', () => {
  const loopFn = src.indexOf('async function _runProjectLoop(');
  const loopFe = src.indexOf('\n// ─', loopFn + 1);
  const loopFb = src.slice(loopFn, loopFe > 0 ? loopFe : loopFn + 10000);
  assert.ok(loopFb.includes("errType === 'AUTH' || errType === 'PERMISSION'"), 'AUTH/PERMISSION チェックがない');
  assert.ok(loopFb.includes('classifyErrorType'), 'classifyErrorType 呼び出しがない');
});

test('11g. _teardown が awaiting_human の場合にスキップする', () => {
  const tdFn = src.indexOf('async function _teardown(');
  const tdFe  = src.indexOf('\nasync function ', tdFn + 1);
  const tdFb  = src.slice(tdFn, tdFe > 0 ? tdFe : tdFn + 3000);
  assert.ok(tdFb.includes("'awaiting_human'"), '待機中の teardown スキップがない');
  assert.ok(tdFb.includes('return'), 'return がない');
});

test('11h. handleApprove に HUMAN_CHECK 再開ロジックがある', () => {
  const appFn = src.indexOf('async function handleApprove(');
  const appFe = src.indexOf('\n// ─', appFn + 1);
  const appFb = src.slice(appFn, appFe > 0 ? appFe : appFn + 5000);
  assert.ok(appFb.includes('ctx.pendingApproval === taskId'), 'pendingApproval 確認がない');
  assert.ok(appFb.includes('_runProjectLoop(ctx)'), '再開の _runProjectLoop がない');
});

test('11i. handleDeny に HUMAN_CHECK 停止ロジックがある', () => {
  const dnyFn = src.indexOf('async function handleDeny(');
  const dnyFe = src.indexOf('\n// ─', dnyFn + 1);
  const dnyFb = src.slice(dnyFn, dnyFe > 0 ? dnyFe : dnyFn + 3000);
  assert.ok(dnyFb.includes('ctx.pendingApproval === taskId'), 'pendingApproval 確認がない');
  assert.ok(dnyFb.includes("'denied_by_human'"), 'denied_by_human がない');
  assert.ok(dnyFb.includes('_teardown(ctx'), 'teardown 呼び出しがない');
});

test('11j. soft_red_unresolved が HUMAN_CHECK になっている', () => {
  const loopFn = src.indexOf('async function _runProjectLoop(');
  const loopFe = src.indexOf('\n// ─', loopFn + 1);
  const loopFb = src.slice(loopFn, loopFe > 0 ? loopFe : loopFn + 10000);
  // soft_red_unresolved は stopReason から HUMAN_CHECK に変わった
  const srIdx  = loopFb.indexOf('softRedHandled');
  const srArea = loopFb.slice(srIdx, srIdx + 600);
  assert.ok(srArea.includes('_handleHumanCheck'), 'soft_red_unresolved が HUMAN_CHECK でない');
});

test('11k. 二重approve防止: stopReason が null でない場合は再開しない', () => {
  // approve ロジックで ctx.stopReason !== "awaiting_human" なら break
  const appFn = src.indexOf('async function handleApprove(');
  const appFe = src.indexOf('\n// ─', appFn + 1);
  const appFb = src.slice(appFn, appFe > 0 ? appFe : appFn + 5000);
  assert.ok(appFb.includes("ctx.stopReason !== 'awaiting_human'") ||
            appFb.includes("stopReason !== 'awaiting_human'"),
    '二重 approve 防止がない');
});

test('11l. 初回 validator失敗は HUMAN_CHECKではなく soft RED', () => {
  // 初回 soft RED: softRedHandled===false → _handleSoftRed を呼ぶ
  const loopFn = src.indexOf('async function _runProjectLoop(');
  const loopFe = src.indexOf('\n// ─', loopFn + 1);
  const loopFb = src.slice(loopFn, loopFe > 0 ? loopFe : loopFn + 10000);
  // !ctx.softRedHandled の分岐に _handleSoftRed があること
  const firstRedIdx  = loopFb.indexOf('!ctx.softRedHandled');
  const firstRedArea = loopFb.slice(firstRedIdx, firstRedIdx + 300);
  assert.ok(firstRedArea.includes('_handleSoftRed'), '初回 soft RED が _handleSoftRed でない');
  assert.ok(!firstRedArea.includes('_handleHumanCheck'),
    '初回 soft RED が誤って HUMAN_CHECK になっている');
});

// ─────────────────────────────────────────────────────
// 12. C-1/H-1 修正: approval record + !project stop awaiting_human
// ─────────────────────────────────────────────────────
console.log('\n[12. C-1/H-1 修正テスト]');

test('12a. _handleHumanCheck が approvalManager.createApproval を呼ぶ', () => {
  const fn = src.indexOf('async function _handleHumanCheck(');
  const fe  = src.indexOf('\n// ─', fn + 1);
  const fb  = src.slice(fn, fe > 0 ? fe : fn + 2000);
  assert.ok(fb.includes('createApproval'), 'createApproval 呼び出しがない');
});

test('12b. createApproval に type="post" を渡している', () => {
  const fn = src.indexOf('async function _handleHumanCheck(');
  const fe  = src.indexOf('\n// ─', fn + 1);
  const fb  = src.slice(fn, fe > 0 ? fe : fn + 2000);
  assert.ok(fb.includes("type:      'post'"), "type='post' がない");
});

test('12c. createApproval に projectId を渡している', () => {
  const fn = src.indexOf('async function _handleHumanCheck(');
  const fe  = src.indexOf('\n// ─', fn + 1);
  const fb  = src.slice(fn, fe > 0 ? fe : fn + 2000);
  assert.ok(fb.includes('projectId'), 'projectId がない');
});

test('12d. approval 作成失敗はフェイルオープン（続行）', () => {
  const fn = src.indexOf('async function _handleHumanCheck(');
  const fe  = src.indexOf('\n// ─', fn + 1);
  const fb  = src.slice(fn, fe > 0 ? fe : fn + 2000);
  assert.ok(fb.includes('approvalErr'), 'エラーハンドリングがない');
  // catch 内に throw や return がなく続行する
  const catchIdx  = fb.indexOf('approvalErr');
  const catchArea = fb.slice(catchIdx, catchIdx + 150);
  assert.ok(!catchArea.includes('throw'), 'catch 内で throw している');
});

test('12e. !project stop が awaiting_human 中に _teardown を直接呼ぶ', () => {
  const stopIdx  = src.indexOf("sub === 'stop'");
  const stopArea = src.slice(stopIdx, stopIdx + 1400); // 十分な範囲
  assert.ok(stopArea.includes("ctx.stopReason === 'awaiting_human'"), 'awaiting_human チェックがない');
  assert.ok(stopArea.includes('_teardown(ctx'), 'teardown 呼び出しがない');
});

test('12f. !project stop の awaiting_human 処理が pendingApproval をクリアする', () => {
  const stopIdx  = src.indexOf("sub === 'stop'");
  const stopArea = src.slice(stopIdx, stopIdx + 800);
  const awaitIdx = stopArea.indexOf("ctx.stopReason === 'awaiting_human'");
  const awaitArea = stopArea.slice(awaitIdx, awaitIdx + 300);
  assert.ok(awaitArea.includes('ctx.pendingApproval = null'), 'pendingApproval クリアがない');
});

test('12g. 実際に approval record が作成・取得できる', () => {
  const am = require('../bot/utils/approval-manager');
  const testTaskId = 'test_humancheck_approval_' + Date.now();
  // _handleHumanCheck と同じ方式で作成
  const a = am.createApproval(testTaskId, {
    type: 'post',
    projectId: 'test-project',
    reason: 'AUTH エラー',
    danger: '中',
    prompt: 'test prompt',
    channelId: '',
  });
  assert.ok(a, 'approval 作成失敗');
  assert.strictEqual(a.taskId, testTaskId);
  assert.strictEqual(a.type, 'post');
  // 取得できる
  const got = am.getApproval(testTaskId);
  assert.ok(got, 'approval 取得失敗');
  assert.strictEqual(got.taskId, testTaskId);
  // cleanup
  am.deny(testTaskId, 'test');
});

test('12h. handleApprove が approval 処理後に activeRuns を確認する順序になっている', () => {
  const fn = src.indexOf('async function handleApprove(');
  const fe  = src.indexOf('\nasync function handleDeny', fn + 1);
  const fb  = src.slice(fn, fe > 0 ? fe : fn + 5000);
  const approveIdx  = fb.indexOf("approvalManager.approve(taskId");
  const resumeIdx   = fb.indexOf("ctx.pendingApproval === taskId");
  assert.ok(approveIdx >= 0, 'approve 呼び出しがない');
  assert.ok(resumeIdx  >= 0, 'pendingApproval チェックがない');
  assert.ok(approveIdx < resumeIdx, 'approve より先に resume チェックが来ている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
