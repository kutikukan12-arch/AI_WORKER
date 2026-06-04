'use strict';
// operator-status-check.js テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const check   = require('../bot/utils/operator-status-check');
const opState = require('../bot/utils/desktop-operator-state');
const operator = require('../scripts/desktop-operator');
const src     = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetState() {
  opState.saveState({ version:'1', updatedAt:null, workers:{}, processedIds:[], paused:false });
}

function setRunningState(extra = {}) {
  const state = opState.loadState();
  state.operatorStatus = {
    status:        'running',
    pid:           process.pid,
    startedAt:     new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    mode:          'live',
    cwd:           process.cwd(),
    ...extra,
  };
  opState.saveState(state);
}

// ─────────────────────────────────────────────────────
// 1. isPidAlive — EPERM/ESRCH 区別
// ─────────────────────────────────────────────────────
console.log('\n[1. isPidAlive — EPERM/ESRCH 区別]');

test('1a. 自プロセスの PID は alive', () => {
  assert.strictEqual(check.isPidAlive(process.pid), true);
});

test('1b. 存在しない PID は dead', () => {
  assert.strictEqual(check.isPidAlive(999999999), false);
});

test('1c. null / 0 は dead', () => {
  assert.strictEqual(check.isPidAlive(null), false);
  assert.strictEqual(check.isPidAlive(0),    false);
});

test('1d. ESRCH のみ死亡扱い（ソース確認）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operator-status-check.js'), 'utf8'
  );
  assert.ok(src.includes("e.code === 'ESRCH'"), 'ESRCH チェックがない');
  assert.ok(src.includes('return true'), 'EPERM 時の alive 返却がない');
});

// ─────────────────────────────────────────────────────
// 2. checkOperatorRunning — 判定ロジック
// ─────────────────────────────────────────────────────
console.log('\n[2. checkOperatorRunning — 判定ロジック]');

test('2a. heartbeat 0秒前 + PID 生存 → 🟢 勤務中', () => {
  resetState();
  setRunningState({ pid: process.pid });
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.isRunning,   true);
  assert.strictEqual(r.statusCode,  'running');
  assert.ok(r.statusLabel.includes('🟢'));
});

test('2b. heartbeat 60秒前 → 🔴 停止中', () => {
  resetState();
  setRunningState({
    pid:           process.pid,
    lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
  });
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.isRunning,   false);
  assert.strictEqual(r.statusCode,  'stopped');
  assert.ok(r.statusLabel.includes('🔴'));
});

test('2c. status=paused → ⏸️ 一時停止（heartbeat 新鮮でも）', () => {
  resetState();
  setRunningState({ status: 'paused', pid: process.pid });
  const state = opState.loadState();
  state.paused = true;
  opState.saveState(state);
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.statusCode,  'paused');
  assert.ok(r.statusLabel.includes('⏸️'));
});

test('2d. status=restart_requested → 🔄 再起動待ち', () => {
  resetState();
  setRunningState({ status: 'restart_requested', pid: process.pid });
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.statusCode,  'restart_requested');
  assert.ok(r.statusLabel.includes('🔄'));
});

test('2e. status=stopped → 🔴 停止中', () => {
  resetState();
  setRunningState({ status: 'stopped', pid: process.pid });
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.isRunning,  false);
  assert.strictEqual(r.statusCode, 'stopped');
});

test('2f. PID 死亡 → 🔴 停止中（heartbeat 新鮮でも）', () => {
  resetState();
  setRunningState({ pid: 999999999 }); // 存在しない PID
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.isRunning,  false);
  assert.strictEqual(r.statusCode, 'stopped');
});

// ─────────────────────────────────────────────────────
// 3. formatStatus — 表示テキスト
// ─────────────────────────────────────────────────────
console.log('\n[3. formatStatus — 表示テキスト]');

test('3a. 勤務中の場合は 🟢 が含まれる', () => {
  resetState();
  setRunningState({ pid: process.pid });
  const r = check.formatStatus(opState, []);
  assert.ok(r.text.includes('🟢'));
});

test('3b. 停止中の場合は 🔴 が含まれる', () => {
  resetState();
  const r = check.formatStatus(opState, []);
  assert.ok(r.text.includes('🔴') || r.text.includes('停止'));
});

test('3c. PID が表示される', () => {
  resetState();
  setRunningState({ pid: process.pid });
  const r = check.formatStatus(opState, []);
  assert.ok(r.text.includes(String(process.pid)), 'PID が表示されない');
});

test('3d. Heartbeat が秒前で表示される', () => {
  resetState();
  setRunningState({ pid: process.pid });
  const r = check.formatStatus(opState, []);
  assert.ok(r.text.includes('秒前'), 'heartbeat 秒前が表示されない');
});

// ─────────────────────────────────────────────────────
// 4. index.js 統合確認（共通ロジック使用）
// ─────────────────────────────────────────────────────
console.log('\n[4. index.js 統合確認]');

test('4a. !operator status が operator-status-check.js を使用', () => {
  const idx  = src.indexOf("opSub === 'status'");
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes("require('./utils/operator-status-check')"),
    'operator-status-check.js が使われていない');
});

test('4b. 旧実装の lockAlive / hbAge が残っていない', () => {
  const idx  = src.indexOf("opSub === 'status'");
  const area = src.slice(idx, idx + 300);
  assert.ok(!area.includes('lockAlive'), '旧実装の lockAlive が残っている');
  assert.ok(!area.includes('hbAge'),     '旧実装の hbAge が残っている');
});

// ─────────────────────────────────────────────────────
// 5. 実際のシナリオ: watchが動いている場合
// ─────────────────────────────────────────────────────
console.log('\n[5. 実際のシナリオ]');

test('5a. watch 起動後の状態は 勤務中と判定される', () => {
  resetState();
  operator.releaseOperatorLock();
  operator.acquireOperatorLock();
  operator.saveOperatorRunningState({ status: 'running' });
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.isRunning, true, `勤務中にならない: ${r.statusCode}`);
  operator.releaseOperatorLock();
});

test('5b. watch 停止後は 停止中になる', () => {
  resetState();
  operator.releaseOperatorLock();
  operator.saveOperatorStoppedState('test');
  const r = check.checkOperatorRunning(opState);
  assert.strictEqual(r.isRunning, false, '停止後も勤務中');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetState();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
