'use strict';
// Runner 状態判定改善テスト（IN_PROGRESS ≠ no_pending_tasks）

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const abr = require('../bot/utils/ai-board-report');
const cr  = require('../bot/utils/ceo-report');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─── モック ──────────────────────────────────────────
const mockTm = {
  listTasks: () => [],
  STATES: { PENDING:'未着手', ON_HOLD:'保留', REVIEWING:'レビュー待ち',
            AWAITING:'人間確認待ち', IN_PROGRESS:'作業中', DONE:'完了' },
};
const mockPm = { filterTasksByProject: () => [] };

// ─────────────────────────────────────────────────────
// 1. 作業中タスクがある状態で no_pending_tasks が出ないこと
// ─────────────────────────────────────────────────────
console.log('\n[1. IN_PROGRESS あり → no_pending_tasks 禁止]');

test('1a. _runProjectLoop に IN_PROGRESS 待機ロジックがある', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  assert.ok(loopBody.includes('inProgressTasks'), 'IN_PROGRESS 待機チェックがない');
  assert.ok(loopBody.includes('waiting_for_in_progress') || loopBody.includes('IN_PROGRESS 完了待ち'), '待機ログがない');
});

test('1b. IN_PROGRESS タスクがある場合 waitForStateChange を呼ぶ', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  // inProgressTasks ブロック全体を広く検索（1000文字）
  const inProgIdx = loopBody.indexOf('inProgressTasks.length > 0');
  const area      = loopBody.slice(inProgIdx, inProgIdx + 1500); // 十分な範囲
  assert.ok(area.includes('waitForStateChange'), 'waitForStateChange が IN_PROGRESS ブロックにない');
  // continue は inProgressTasks ブロック内にある（auto-resume continue と混在するが両方存在確認）
  const wscIdx     = area.indexOf('waitForStateChange');
  const continueAfterWSC = area.indexOf('continue', wscIdx);
  assert.ok(continueAfterWSC >= 0, 'waitForStateChange の後に continue がない（ループ継続されない）');
});

test('1c. no_pending_tasks は IN_PROGRESS が 0 件のときだけ設定される', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  // inProgressTasks ブロック内に no_pending_tasks の最終設定がある
  // inProgressTasks ブロックの後に no_pending_tasks が来る構造を確認
  const inProgBlockIdx = loopBody.indexOf('inProgressTasks.length > 0');
  // inProgressTasks ブロックの後に no_pending_tasks がある（else 相当）
  const noPendAfterInProg = loopBody.indexOf("'no_pending_tasks'", inProgBlockIdx);
  assert.ok(inProgBlockIdx >= 0, 'inProgressTasks ブロックがない');
  assert.ok(noPendAfterInProg > inProgBlockIdx, 'no_pending_tasks が inProgressTasks ブロックの後にない');
});

// ─────────────────────────────────────────────────────
// 2. AI Board Report: IN_PROGRESS があるとき BLOCKED にならない
// ─────────────────────────────────────────────────────
console.log('\n[2. AI Board Report: IN_PROGRESS → BLOCKED でない]');

test('2a. inProgress>0 + stopReason=no_pending_tasks → BLOCKED にならない', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'no_pending_tasks' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 1 }
  );
  assert.notStrictEqual(s, 'BLOCKED', 'IN_PROGRESS あり + no_pending_tasks が BLOCKED になっている');
});

test('2b. inProgress>0 → NEEDS_REFINEMENT（作業継続中）', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'no_pending_tasks' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 2 }
  );
  assert.strictEqual(s, 'NEEDS_REFINEMENT', `NEEDS_REFINEMENT でない: ${s}`);
});

test('2c. inProgress=0 + tasksFailed>0 → BLOCKED（既存動作維持）', () => {
  const s = abr._determineStatus(
    { tasksFailed: 2, stopReason: 'consecutive_errors_3' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 0 }
  );
  assert.strictEqual(s, 'BLOCKED', 'エラーあり + IN_PROGRESS=0 が BLOCKED でない');
});

test('2d. waiting_for_in_progress stopReason → NEEDS_REFINEMENT', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'waiting_for_in_progress' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 0 }
  );
  assert.strictEqual(s, 'NEEDS_REFINEMENT');
});

// ─────────────────────────────────────────────────────
// 3. CEO Report: IN_PROGRESS → CONTINUE_DEVELOPMENT
// ─────────────────────────────────────────────────────
console.log('\n[3. CEO Report: IN_PROGRESS → CONTINUE_DEVELOPMENT]');

test('3a. inProgress>0 → CONTINUE_DEVELOPMENT（開発実行中）', () => {
  const s = cr._boardStatusToExecStatus(
    'NEEDS_REFINEMENT',
    { tasksFailed: 0, stopReason: 'no_pending_tasks' },
    { awaiting: 0, inProgress: 1 }
  );
  assert.strictEqual(s, cr.EXEC_STATUS.CONTINUE_DEVELOPMENT);
});

test('3b. waiting_for_in_progress stopReason → CONTINUE_DEVELOPMENT', () => {
  const s = cr._boardStatusToExecStatus(
    'BLOCKED',
    { tasksFailed: 0, stopReason: 'waiting_for_in_progress' },
    { awaiting: 0, inProgress: 0 }
  );
  assert.strictEqual(s, cr.EXEC_STATUS.CONTINUE_DEVELOPMENT);
});

test('3c. inProgress=0 + BLOCKED → BLOCKED（既存動作維持）', () => {
  const s = cr._boardStatusToExecStatus(
    'BLOCKED',
    { tasksFailed: 2, stopReason: 'consecutive_errors_3' },
    { awaiting: 0, inProgress: 0 }
  );
  assert.strictEqual(s, cr.EXEC_STATUS.BLOCKED);
});

// ─────────────────────────────────────────────────────
// 4. 完了表示テスト（タスク消化と商品完成の分離）
// ─────────────────────────────────────────────────────
console.log('\n[4. タスク消化と商品完成の分離]');

test('4a. project_done でも inProgress>0 なら NEEDS_REFINEMENT', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'project_done' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 1 }
  );
  assert.strictEqual(s, 'NEEDS_REFINEMENT');
});

test('4b. gatherRunnerPreview ロジック変更なし（_runProjectLoop の外で独立）', () => {
  assert.ok(src.includes('function gatherRunnerPreview'), 'gatherRunnerPreview が消えている');
  assert.ok(src.includes('function formatRunnerPreview'), 'formatRunnerPreview が消えている');
});

// ─────────────────────────────────────────────────────
// 5. 既存テストの保護
// ─────────────────────────────────────────────────────
console.log('\n[5. 既存機能保護]');

test('5a. _handleHumanCheck は変更なし', () => {
  assert.ok(src.includes("ctx.stopReason      = 'awaiting_human'"), 'awaiting_human が消えている');
});

test('5b. Auto Split（handleAutoTimeoutSplit）は変更なし', () => {
  assert.ok(src.includes('async function handleAutoTimeoutSplit'), 'handleAutoTimeoutSplit が消えている');
});

test('5c. Quality Gate は変更なし', () => {
  assert.ok(src.includes('_maybeRunMidQualityGate'), '_maybeRunMidQualityGate が消えている');
});

test('5d. generateBoardReport は変更なし', () => {
  const r = abr.generateBoardReport(
    'test', { tasksDone: 3, tasksFailed: 0, stopReason: 'no_pending_tasks', yellowCount: 0 },
    { level: 'GREEN', score: 90, redTriggers: [] },
    mockTm, mockPm
  );
  assert.ok(r.status, 'generateBoardReport が status を返さない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
