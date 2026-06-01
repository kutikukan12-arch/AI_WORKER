'use strict';
// task-state-watcher テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const { waitForStateChange } = require('../bot/utils/task-state-watcher');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

let pass = 0, fail = 0;
// 同期テスト用（ソース確認など）
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

async function main() {
async function atest(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ─── モック taskManager ─────────────────────────────
function makeMockTm(states) {
  // states: Map<taskId, string|null>  null = アーカイブ済み
  return {
    STATES: {
      IN_PROGRESS: '作業中', DONE: '完了', REVIEWING: 'レビュー待ち',
      AWAITING: '人間確認待ち', ON_HOLD: '保留', PENDING: '未着手',
    },
    getTask: (id) => {
      const state = states.get(id);
      if (state === null) return null; // アーカイブ済み
      if (state === undefined) return null;
      return { id, state };
    },
  };
}

// ─────────────────────────────────────────────────────
// 1. DONE（アーカイブ済み）は即解決
// ─────────────────────────────────────────────────────
console.log('\n[1. DONE は即終了]');

await atest('1a. getTask=null（アーカイブ済み）→ outcome:done を即返す', async () => {
  const tm = makeMockTm(new Map([['t1', null]]));
  const r  = await waitForStateChange('t1', tm, { pollIntervalMs: 50, maxWaitMs: 3000 });
  assert.strictEqual(r.outcome, 'done');
  assert.strictEqual(r.task, null);
});

await atest('1b. state=DONE → outcome:done', async () => {
  const tm = makeMockTm(new Map([['t2', '完了']]));
  const r  = await waitForStateChange('t2', tm, { pollIntervalMs: 50, maxWaitMs: 3000 });
  assert.strictEqual(r.outcome, 'done');
});

await atest('1c. IN_PROGRESS → DONE の遷移を検出する', async () => {
  let callCount = 0;
  const states = new Map([['t3', '作業中']]);
  const tm = {
    STATES: { IN_PROGRESS: '作業中', DONE: '完了', REVIEWING: 'レビュー待ち',
              AWAITING: '人間確認待ち', ON_HOLD: '保留', PENDING: '未着手' },
    getTask: (id) => {
      callCount++;
      if (callCount <= 2) return { id, state: '作業中' }; // 最初2回はIN_PROGRESS
      return null; // 3回目以降はアーカイブ済み（DONE）
    },
  };
  const r = await waitForStateChange('t3', tm, { pollIntervalMs: 50, maxWaitMs: 3000 });
  assert.strictEqual(r.outcome, 'done');
  assert.ok(callCount >= 3, `callCount=${callCount} < 3 (ポーリングが機能していない)`);
});

// ─────────────────────────────────────────────────────
// 2. timeout は今まで通り発火
// ─────────────────────────────────────────────────────
console.log('\n[2. timeout は今まで通り発火]');

await atest('2a. maxWaitMs 超過 → outcome:timeout', async () => {
  const tm = makeMockTm(new Map([['t4', '作業中']])); // ずっとIN_PROGRESS
  const start = Date.now();
  const r = await waitForStateChange('t4', tm, { pollIntervalMs: 50, maxWaitMs: 200 });
  const elapsed = Date.now() - start;
  assert.strictEqual(r.outcome, 'timeout');
  assert.ok(elapsed >= 200, `elapsed=${elapsed} < maxWaitMs`);
});

await atest('2b. timeout でも task オブジェクトを返す', async () => {
  const tm = makeMockTm(new Map([['t5', '作業中']]));
  const r  = await waitForStateChange('t5', tm, { pollIntervalMs: 50, maxWaitMs: 150 });
  assert.strictEqual(r.outcome, 'timeout');
  assert.ok(r.task !== undefined, 'timeout 時に task がない');
});

// ─────────────────────────────────────────────────────
// 3. HUMAN_CHECK（AWAITING）で停止
// ─────────────────────────────────────────────────────
console.log('\n[3. HUMAN_CHECK で停止]');

await atest('3a. state=AWAITING → outcome:awaiting', async () => {
  const tm = makeMockTm(new Map([['t6', '人間確認待ち']]));
  const r  = await waitForStateChange('t6', tm, { pollIntervalMs: 50, maxWaitMs: 3000 });
  assert.strictEqual(r.outcome, 'awaiting');
  assert.ok(r.task, 'task が返っていない');
  assert.strictEqual(r.task.state, '人間確認待ち');
});

await atest('3b. IN_PROGRESS → AWAITING への遷移を検出する', async () => {
  let callCount = 0;
  const tm = {
    STATES: { IN_PROGRESS: '作業中', DONE: '完了', REVIEWING: 'レビュー待ち',
              AWAITING: '人間確認待ち', ON_HOLD: '保留', PENDING: '未着手' },
    getTask: (id) => {
      callCount++;
      if (callCount <= 3) return { id, state: '作業中' };
      return { id, state: '人間確認待ち' };
    },
  };
  const r = await waitForStateChange('t7', tm, { pollIntervalMs: 50, maxWaitMs: 3000 });
  assert.strictEqual(r.outcome, 'awaiting');
});

// ─────────────────────────────────────────────────────
// 4. 長時間タスクは待つ（途中状態で止まらない）
// ─────────────────────────────────────────────────────
console.log('\n[4. 長時間タスクは待つ]');

await atest('4a. IN_PROGRESS が続く間はポーリングを継続する', async () => {
  let callCount = 0;
  const tm = {
    STATES: { IN_PROGRESS: '作業中', DONE: '完了', REVIEWING: 'レビュー待ち',
              AWAITING: '人間確認待ち', ON_HOLD: '保留', PENDING: '未着手' },
    getTask: (id) => {
      callCount++;
      if (callCount <= 5) return { id, state: '作業中' };
      return null; // 6回目で完了
    },
  };
  const r = await waitForStateChange('t8', tm, { pollIntervalMs: 50, maxWaitMs: 5000 });
  assert.strictEqual(r.outcome, 'done');
  assert.ok(callCount >= 6, `callCount=${callCount} < 6`);
});

// ─────────────────────────────────────────────────────
// 5. stopRequested で即停止
// ─────────────────────────────────────────────────────
console.log('\n[5. stopRequested で即停止]');

await atest('5a. checkStopFn が true を返す → outcome:stopped', async () => {
  const tm = makeMockTm(new Map([['t9', '作業中']]));
  let stopFlag = false;
  setTimeout(() => { stopFlag = true; }, 100);
  const r = await waitForStateChange('t9', tm, {
    pollIntervalMs: 50,
    maxWaitMs: 3000,
    checkStopFn: () => stopFlag,
  });
  assert.strictEqual(r.outcome, 'stopped');
});

// ─────────────────────────────────────────────────────
// 6. index.js への統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test('6a. waitForStateChange が require されている', () => {
  assert.ok(src.includes("require('./utils/task-state-watcher')"), 'task-state-watcher が import されていない');
  assert.ok(src.includes('waitForStateChange'), 'waitForStateChange が使われていない');
});

test('6b. _runProjectLoop で Promise.race が使われている', () => {
  const loopIdx   = src.indexOf('async function _runProjectLoop');
  const loopEnd   = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody  = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  assert.ok(loopBody.includes('Promise.race'), 'Promise.race がない');
  assert.ok(loopBody.includes('watchPromise'), 'watchPromise がない');
  assert.ok(loopBody.includes('execPromise'), 'execPromise がない');
});

test('6c. timeout 保護（maxWaitMs）が _runProjectLoop に設定されている', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  assert.ok(loopBody.includes('taskTimeoutMs') || loopBody.includes('TASK_TIMEOUT_SECONDS'), 'タイムアウト保護がない');
});

test('6d. execPromise.catch() で背後の実行を吸収している', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  assert.ok(loopBody.includes('execPromise.catch'), 'execPromise のエラー吸収がない');
});

test('6e. E-3 Auto Split（handleAutoTimeoutSplit）は変更なし', () => {
  assert.ok(src.includes('async function handleAutoTimeoutSplit'), 'handleAutoTimeoutSplit が消えている');
  assert.ok(src.includes('autoSplitOnTimeout'), 'autoSplitOnTimeout が消えている');
});

test('6f. HUMAN_CHECK 承認ロジックは変更なし', () => {
  assert.ok(src.includes('async function _handleHumanCheck'), '_handleHumanCheck が消えている');
  assert.ok(src.includes("ctx.stopReason      = 'awaiting_human'"), 'awaiting_human 設定が消えている');
});

test('6g. Quality Gate（_maybeRunMidQualityGate）は変更なし', () => {
  assert.ok(src.includes('_maybeRunMidQualityGate'), '_maybeRunMidQualityGate が消えている');
});

test('6h. stopRequested チェック（checkStopFn）が _runProjectLoop に渡される', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  assert.ok(loopBody.includes('checkStopFn') || loopBody.includes('stopRequested'), 'stopRequested チェックがない');
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);

} // end async function main

main().catch(e => { console.error(e); process.exit(1); });
