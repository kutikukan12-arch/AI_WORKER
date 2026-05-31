'use strict';
// Phase E-5b: Worker Registry テスト（新API対応版）

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

const WORKERS_FILE = path.join(__dirname, '..', 'data', 'workers.json');

function cleanupWorkers() {
  // workers.json から全テスト用ワーカーを削除
  if (!fs.existsSync(WORKERS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf8'));
    raw.workers = (raw.workers || []).filter(w => !w.workerId.startsWith('w-'));
    fs.writeFileSync(WORKERS_FILE, JSON.stringify(raw, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function cleanupTasks() {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => t.projectId !== pid && !CLEANUP_IDS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
}

// テスト開始前クリーンアップ
cleanupWorkers();
cleanupTasks();

// ─────────────────────────────────────────────────────
// 1. 定数確認
// ─────────────────────────────────────────────────────
console.log('\n[1. 定数確認]');

test('1a. ROLE_TYPE_MAP.IMPLEMENTER は IMPLEMENT/FIX/REFACTOR を含む', () => {
  assert.ok(wr.ROLE_TYPE_MAP.IMPLEMENTER instanceof Set);
  assert.ok(wr.ROLE_TYPE_MAP.IMPLEMENTER.has('IMPLEMENT'));
  assert.ok(wr.ROLE_TYPE_MAP.IMPLEMENTER.has('FIX'));
  assert.ok(wr.ROLE_TYPE_MAP.IMPLEMENTER.has('REFACTOR'));
});

test('1b. ROLE_TYPE_MAP.REVIEWER は REVIEW のみ', () => {
  assert.ok(wr.ROLE_TYPE_MAP.REVIEWER.has('REVIEW'));
  assert.strictEqual(wr.ROLE_TYPE_MAP.REVIEWER.size, 1);
});

test('1c. ROLE_TYPE_MAP.TESTER は TEST のみ', () => {
  assert.ok(wr.ROLE_TYPE_MAP.TESTER.has('TEST'));
  assert.strictEqual(wr.ROLE_TYPE_MAP.TESTER.size, 1);
});

test('1d. ROLE_TYPE_MAP.RESEARCHER は RESEARCH / DOCS', () => {
  assert.ok(wr.ROLE_TYPE_MAP.RESEARCHER.has('RESEARCH'));
  assert.ok(wr.ROLE_TYPE_MAP.RESEARCHER.has('DOCS'));
});

test('1e. WORKER_STATUS に idle / busy / offline が含まれる', () => {
  assert.strictEqual(wr.WORKER_STATUS.IDLE,    'idle');
  assert.strictEqual(wr.WORKER_STATUS.BUSY,    'busy');
  assert.strictEqual(wr.WORKER_STATUS.OFFLINE, 'offline');
});

test('1f. WORKER_ROLES に IMPLEMENTER / REVIEWER / TESTER / RESEARCHER が含まれる', () => {
  ['IMPLEMENTER','REVIEWER','TESTER','RESEARCHER'].forEach(r =>
    assert.ok(wr.WORKER_ROLES[r], `${r} がない`)
  );
});

// ─────────────────────────────────────────────────────
// 2. addWorker / removeWorker / listWorkers
// ─────────────────────────────────────────────────────
console.log('\n[2. addWorker / removeWorker / listWorkers]');

test('2a. addWorker(role) が { ok:true, worker } を返す', () => {
  const res = wr.addWorker('IMPLEMENTER', 'w-1');
  assert.strictEqual(res.ok, true);
  assert.ok(res.worker);
  assert.strictEqual(res.worker.workerId, 'w-1');
  assert.strictEqual(res.worker.role,     'IMPLEMENTER');
  assert.strictEqual(res.worker.status,   wr.WORKER_STATUS.IDLE);
  info('2a: ' + JSON.stringify({ workerId: res.worker.workerId, role: res.worker.role, status: res.worker.status }));
});

test('2b. 不正な role は { ok:false, reason } を返す', () => {
  const res = wr.addWorker('INVALID_ROLE', 'w-bad');
  assert.strictEqual(res.ok, false);
  assert.ok(res.reason);
});

test('2c. 重複 workerId は { ok:false } を返す（上書きしない）', () => {
  const res = wr.addWorker('REVIEWER', 'w-1');
  assert.strictEqual(res.ok, false);
});

test('2d. listWorkers が登録済みワーカーを含む', () => {
  const list = wr.listWorkers();
  assert.ok(Array.isArray(list));
  const ids = list.map(w => w.workerId);
  assert.ok(ids.includes('w-1'), 'w-1 が含まれない');
  info('2d workers: ' + ids.join(', '));
});

test('2e. removeWorker が { ok:true, worker, wasBusy } を返す', () => {
  wr.addWorker('RESEARCHER', 'w-remove'); // RESEARCHER は有効なロール
  const res = wr.removeWorker('w-remove');
  assert.strictEqual(res.ok, true);
  assert.ok(res.worker);
  assert.strictEqual(typeof res.wasBusy, 'boolean');
  const ids = wr.listWorkers().map(w => w.workerId);
  assert.ok(!ids.includes('w-remove'), 'w-remove が残っている');
});

test('2f. removeWorker: 未登録は { ok:false } を返す', () => {
  const res = wr.removeWorker('nonexistent');
  assert.strictEqual(res.ok, false);
});

test('2g. workerId 省略で自動生成される', () => {
  const res = wr.addWorker('TESTER');
  assert.strictEqual(res.ok, true);
  assert.ok(res.worker.workerId.startsWith('test-'), `auto id: ${res.worker.workerId}`);
  info('2g auto workerId: ' + res.worker.workerId);
  wr.removeWorker(res.worker.workerId);
});

// ─────────────────────────────────────────────────────
// 3. claimForWorker
// ─────────────────────────────────────────────────────
console.log('\n[3. claimForWorker]');

const t3 = tm.createTask('[E5b-test] IMPLEMENT task', 'e5b-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t3.id);

// w-1 は IMPLEMENTER → IMPLEMENT タスクを claim できる
// ただし worker.projectId = '*' なので全プロジェクト対象
wr.addWorker('IMPLEMENTER', 'w-impl', '*');

test('3a. IMPLEMENTER ワーカーが IMPLEMENT タスクを claim できる', () => {
  const task = wr.claimForWorker('w-impl');
  assert.ok(task, 'task is null');
  assert.ok(['IMPLEMENT','FIX','REFACTOR'].includes(task.type),
    `unexpected type: ${task.type}`);
  info('3a: claimed task=' + task.id + ' type=' + task.type);

  // workers.json で BUSY になっているか確認
  const w = wr.getWorker('w-impl');
  assert.strictEqual(w.status, wr.WORKER_STATUS.BUSY);
  assert.strictEqual(w.currentTaskId, task.id);
});

test('3b. BUSY ワーカーは再 claim できない（null）', () => {
  const task = wr.claimForWorker('w-impl');
  assert.strictEqual(task, null);
});

test('3c. 未登録ワーカーは null', () => {
  assert.strictEqual(wr.claimForWorker('nobody'), null);
});

// REVIEWER ワーカーは IMPLEMENT タスクを取れない
wr.addWorker('REVIEWER', 'w-rev', '*');
test('3d. REVIEWER ワーカーは IMPLEMENT タスクを claim できない', () => {
  // t3 は IMPLEMENT。REVIEWER は REVIEW のみ claim できる
  const task = wr.claimForWorker('w-rev');
  if (task) {
    assert.strictEqual(task.type, 'REVIEW', `REVIEWERがIMPLEMENTを取った: ${task.type}`);
  } else {
    info('3d: null（REVIEW タスクなし）');
  }
});

// ─────────────────────────────────────────────────────
// 4. releaseWorker
// ─────────────────────────────────────────────────────
console.log('\n[4. releaseWorker]');

test('4a. releaseWorker で BUSY → idle に戻る', () => {
  // w-impl は3aで BUSY になっている
  wr.releaseWorker('w-impl');
  const w = wr.getWorker('w-impl');
  assert.ok(w, 'worker not found');
  assert.strictEqual(w.status, wr.WORKER_STATUS.IDLE);
  assert.strictEqual(w.currentTaskId, null);
  info('4a: w-impl status=' + w.status);
});

test('4b. releaseWorker 後に IMPLEMENTER タイプのタスクを再 claim できる', () => {
  // w-impl は IMPLEMENTER → IMPLEMENT/FIX/REFACTOR を claim できる
  // t3 の他にも IMPLEMENT タスクがある可能性があるため type で確認
  tm.releaseLease(t3.id);
  const task = wr.claimForWorker('w-impl');
  assert.ok(task, '再 claim が null');
  assert.ok(wr.ROLE_TYPE_MAP.IMPLEMENTER.has(task.type),
    `IMPLEMENTER の対象外 type: ${task.type}`);
  info('4b: reclaimed task=' + task.id + ' type=' + task.type);
  wr.releaseWorker('w-impl');
  tm.releaseLease(task.id);
});

test('4c. 未登録ワーカーへの releaseWorker は null を返す（クラッシュしない）', () => {
  // releaseWorker は void だが updateWorkerStatus がエラーを握りつぶす
  try {
    wr.releaseWorker('nobody');
    // エラーにならない（null return or no-op）
    assert.ok(true, 'クラッシュしなかった');
  } catch (e) {
    assert.fail('例外が発生した: ' + e.message);
  }
});

// ─────────────────────────────────────────────────────
// 5. workers.json に永続化される
// ─────────────────────────────────────────────────────
console.log('\n[5. 永続化確認]');

test('5a. workers.json が存在する', () =>
  assert.ok(fs.existsSync(WORKERS_FILE), 'workers.json が存在しない'));

test('5b. workers.json に w-impl が含まれる', () => {
  const raw = JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf8'));
  const ids = (raw.workers || []).map(w => w.workerId);
  assert.ok(ids.includes('w-impl'), 'w-impl がない: ' + ids.join(', '));
});

test('5c. data/workers.json が .gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/workers.json'), '.gitignore に workers.json がない');
});

// ─────────────────────────────────────────────────────
// 6. フォーマット確認
// ─────────────────────────────────────────────────────
console.log('\n[6. フォーマット確認]');

test('6a. formatWorkerList が文字列を返す', () => {
  const s = wr.formatWorkerList();
  assert.ok(typeof s === 'string' && s.length > 0);
  info('6a: ' + s.slice(0, 60) + '...');
});

test('6b. formatWorkerStatus が文字列を返す', () => {
  const s = wr.formatWorkerStatus();
  assert.ok(typeof s === 'string' && s.length > 0);
  info('6b: ' + s);
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanupWorkers();
cleanupTasks();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
