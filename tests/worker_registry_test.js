'use strict';
// Phase E-5b: Worker Registry テスト

const assert = require('assert');
const wr     = require('../bot/utils/worker-registry');
const tm     = require('../bot/utils/task-manager');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
const CLEANUP_IDS = [];
const pid = 'e5b-worker-test';

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function info(msg) { console.log('  ℹ️ ', msg); }

// テスト開始前にクリーンアップ
function cleanup() {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => t.projectId !== pid && !CLEANUP_IDS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
}
cleanup();

// ─────────────────────────────────────────────────────
// 1. ROLE_TYPE_MAP / WORKER_STATUS 定数
// ─────────────────────────────────────────────────────
console.log('\n[1. 定数確認]');

test('1a. ROLE_TYPE_MAP に EXECUTOR が含まれる', () =>
  assert.strictEqual(wr.ROLE_TYPE_MAP.EXECUTOR, 'EXECUTOR'));
test('1b. ROLE_TYPE_MAP に REVIEWER が含まれる', () =>
  assert.strictEqual(wr.ROLE_TYPE_MAP.REVIEWER, 'REVIEWER'));
test('1c. ROLE_TYPE_MAP に RESEARCHER が含まれる', () =>
  assert.strictEqual(wr.ROLE_TYPE_MAP.RESEARCHER, 'RESEARCHER'));
test('1d. ROLE_TYPE_MAP に GENERAL が含まれる', () =>
  assert.strictEqual(wr.ROLE_TYPE_MAP.GENERAL, 'GENERAL'));
test('1e. WORKER_STATUS に IDLE / BUSY が含まれる', () => {
  assert.strictEqual(wr.WORKER_STATUS.IDLE, 'IDLE');
  assert.strictEqual(wr.WORKER_STATUS.BUSY, 'BUSY');
});

// ─────────────────────────────────────────────────────
// 2. addWorker / removeWorker / listWorkers
// ─────────────────────────────────────────────────────
console.log('\n[2. addWorker / removeWorker / listWorkers]');

test('2a. addWorker が workerId / role / status を持つオブジェクトを返す', () => {
  const w = wr.addWorker('worker-1', wr.ROLE_TYPE_MAP.EXECUTOR);
  assert.strictEqual(w.workerId, 'worker-1');
  assert.strictEqual(w.role, wr.ROLE_TYPE_MAP.EXECUTOR);
  assert.strictEqual(w.status, wr.WORKER_STATUS.IDLE);
  info('2a: ' + JSON.stringify(w));
});

test('2b. 不正な role は GENERAL にフォールバック', () => {
  const w = wr.addWorker('worker-bad-role', 'INVALID_ROLE');
  assert.strictEqual(w.role, wr.ROLE_TYPE_MAP.GENERAL);
});

test('2c. addWorker で重複 workerId は上書き', () => {
  wr.addWorker('worker-dup', wr.ROLE_TYPE_MAP.EXECUTOR);
  const w = wr.addWorker('worker-dup', wr.ROLE_TYPE_MAP.REVIEWER);
  assert.strictEqual(w.role, wr.ROLE_TYPE_MAP.REVIEWER);
});

test('2d. listWorkers が登録済みワーカーを返す', () => {
  const list = wr.listWorkers();
  assert.ok(Array.isArray(list));
  const ids = list.map(w => w.workerId);
  assert.ok(ids.includes('worker-1'), 'worker-1 が含まれない');
  info('2d workers: ' + ids.join(', '));
});

test('2e. removeWorker が true を返し登録から除外される', () => {
  wr.addWorker('worker-remove', wr.ROLE_TYPE_MAP.GENERAL);
  assert.strictEqual(wr.removeWorker('worker-remove'), true);
  const ids = wr.listWorkers().map(w => w.workerId);
  assert.ok(!ids.includes('worker-remove'));
});

test('2f. removeWorker: 未登録は false を返す', () =>
  assert.strictEqual(wr.removeWorker('nonexistent'), false));

test('2g. addWorker: workerId が空文字はエラー', () => {
  assert.throws(() => wr.addWorker('', wr.ROLE_TYPE_MAP.GENERAL), /workerId/);
});

// ─────────────────────────────────────────────────────
// 3. claimForWorker
// ─────────────────────────────────────────────────────
console.log('\n[3. claimForWorker]');

const t3 = tm.createTask('[E5b-test] claim target', 'e5b-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t3.id);

test('3a. IDLE ワーカーが task を claim できる', () => {
  wr.addWorker('worker-claimer', wr.ROLE_TYPE_MAP.EXECUTOR);
  const result = wr.claimForWorker('worker-claimer', pid);
  assert.ok(result, 'result is null');
  assert.ok(result.task, 'task is null');
  assert.ok(result.worker, 'worker is null');
  assert.strictEqual(result.task.id, t3.id);
  assert.strictEqual(result.worker.status, wr.WORKER_STATUS.BUSY);
  info('3a: claimed task=' + result.task.id + ' worker=' + result.worker.workerId);
});

test('3b. BUSY ワーカーは再 claim できない', () => {
  // 3a で worker-claimer は BUSY になっている
  const result = wr.claimForWorker('worker-claimer', pid);
  assert.strictEqual(result, null, 'BUSY なのに claim できた');
});

test('3c. 未登録ワーカーの claim は null', () => {
  const result = wr.claimForWorker('unregistered-worker', pid);
  assert.strictEqual(result, null);
});

test('3d. タスクなし → null', () => {
  wr.addWorker('worker-empty', wr.ROLE_TYPE_MAP.GENERAL);
  // pid のタスクは t3 のみで既に IN_PROGRESS
  const result = wr.claimForWorker('worker-empty', pid);
  assert.strictEqual(result, null, '空のはずが claim できた');
});

// ─────────────────────────────────────────────────────
// 4. releaseWorker
// ─────────────────────────────────────────────────────
console.log('\n[4. releaseWorker]');

test('4a. releaseWorker で BUSY → IDLE に戻る', () => {
  // worker-claimer は 3a で BUSY
  const result = wr.releaseWorker('worker-claimer', t3.id);
  assert.ok(result, 'result is null');
  assert.strictEqual(result.worker.status, wr.WORKER_STATUS.IDLE);
  info('4a: worker status=' + result.worker.status);
});

test('4b. release 後に task が PENDING に戻る', () => {
  const task = tm.listTasks().find(t => t.id === t3.id);
  assert.ok(task, 'task が見つからない');
  assert.strictEqual(task.state, tm.STATES.PENDING);
});

test('4c. release 後に再 claim できる', () => {
  const result = wr.claimForWorker('worker-claimer', pid);
  assert.ok(result, '再 claim が null');
  assert.strictEqual(result.task.id, t3.id);
  wr.releaseWorker('worker-claimer', t3.id); // 後処理
});

test('4d. 未登録ワーカーの release は null', () => {
  const result = wr.releaseWorker('nobody', 'task_xxx');
  assert.strictEqual(result, null);
});

test('4e. taskId なしの release でもクラッシュしない', () => {
  wr.addWorker('worker-no-task', wr.ROLE_TYPE_MAP.GENERAL);
  const result = wr.releaseWorker('worker-no-task');
  assert.ok(result !== undefined);
  assert.strictEqual(result.worker.status, wr.WORKER_STATUS.IDLE);
});

// ─────────────────────────────────────────────────────
// 5. 最小フィールド確認（heartbeat等が含まれないこと）
// ─────────────────────────────────────────────────────
console.log('\n[5. 最小フィールド]');

const wMin = wr.addWorker('worker-min', wr.ROLE_TYPE_MAP.GENERAL);
test('5a. workerId / role / status の3フィールドのみ', () => {
  const keys = Object.keys(wMin).sort();
  assert.deepStrictEqual(keys, ['role', 'status', 'workerId']);
});
test('5b. heartbeat フィールドがない', () =>
  assert.strictEqual(wMin.heartbeat, undefined));
test('5c. maxConcurrent フィールドがない', () =>
  assert.strictEqual(wMin.maxConcurrent, undefined));
test('5d. projectId フィールドがない', () =>
  assert.strictEqual(wMin.projectId, undefined));

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
