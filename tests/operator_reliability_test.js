'use strict';
// operator-reliability.js テスト — Phase11 安定化

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const rel      = require('../bot/utils/operator-reliability');
const opState  = require('../bot/utils/desktop-operator-state');
const operator = require('../scripts/desktop-operator');
const src      = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetState() {
  opState.saveState({ version:'1', updatedAt:null, workers:{}, processedIds:[], paused:false });
}

// ─────────────────────────────────────────────────────
// 1. AUTOSEND_ALLOWLIST
// ─────────────────────────────────────────────────────
console.log('\n[1. AUTOSEND_ALLOWLIST]');

test('1a. allowlist に moriya / miyagi / kanzaki が含まれる', () => {
  assert.ok(rel.AUTOSEND_ALLOWLIST.has('moriya'),   'moriya がない');
  assert.ok(rel.AUTOSEND_ALLOWLIST.has('miyagi'),   'miyagi がない');
  assert.ok(rel.AUTOSEND_ALLOWLIST.has('kanzaki'),  'kanzaki がない');
});

test('1b. allowlist 外の worker は shouldAutoSend = false', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  // 3回成功させても allowlist 外なら false
  rel.recordSuccess(opState, 'shiraishi');
  rel.recordSuccess(opState, 'shiraishi');
  rel.recordSuccess(opState, 'shiraishi');
  assert.strictEqual(rel.shouldAutoSend(opState, 'shiraishi'), false);
});

// ─────────────────────────────────────────────────────
// 2. 3回連続成功で auto-send 解禁
// ─────────────────────────────────────────────────────
console.log('\n[2. 3回連続成功で auto-send 解禁]');

test('2a. 2回成功では auto-send 解禁されない', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  rel.recordSuccess(opState, 'moriya');
  rel.recordSuccess(opState, 'moriya');
  assert.strictEqual(rel.shouldAutoSend(opState, 'moriya'), false);
});

test('2b. 3回連続成功で moriya が auto-send 解禁される', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  rel.recordSuccess(opState, 'moriya');
  rel.recordSuccess(opState, 'moriya');
  const { justUnlocked } = rel.recordSuccess(opState, 'moriya');
  assert.strictEqual(rel.shouldAutoSend(opState, 'moriya'), true);
  assert.strictEqual(justUnlocked, true, '解禁フラグが立っていない');
});

test('2c. 3回連続成功で miyagi が auto-send 解禁される', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'miyagi');
  assert.strictEqual(rel.shouldAutoSend(opState, 'miyagi'), true);
});

test('2d. 3回連続成功で kanzaki が auto-send 解禁される', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'kanzaki');
  assert.strictEqual(rel.shouldAutoSend(opState, 'kanzaki'), true);
});

// ─────────────────────────────────────────────────────
// 3. 失敗時に clipboard 降格
// ─────────────────────────────────────────────────────
console.log('\n[3. 失敗時に clipboard 降格]');

test('3a. 失敗で consecutiveSuccess がリセットされる', () => {
  resetState();
  rel.recordSuccess(opState, 'moriya');
  rel.recordSuccess(opState, 'moriya');
  rel.recordFailure(opState, 'moriya', 'テスト失敗');
  const r = rel.getWorkerReliability(opState, 'moriya');
  assert.strictEqual(r.consecutiveSuccess, 0, 'リセットされていない');
});

test('3b. 解禁後の失敗で auto-send が無効化される', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'moriya');
  assert.strictEqual(rel.shouldAutoSend(opState, 'moriya'), true);

  const { downgraded } = rel.recordFailure(opState, 'moriya', '送信失敗');
  assert.strictEqual(rel.shouldAutoSend(opState, 'moriya'), false, '失敗後も auto-send が有効');
  assert.strictEqual(downgraded, true, '降格フラグが立っていない');
});

test('3c. 失敗後に3回成功で再解禁できる', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'miyagi');
  rel.recordFailure(opState, 'miyagi', '一時障害');
  assert.strictEqual(rel.shouldAutoSend(opState, 'miyagi'), false);

  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'miyagi');
  assert.strictEqual(rel.shouldAutoSend(opState, 'miyagi'), true, '再解禁されない');
});

// ─────────────────────────────────────────────────────
// 4. Mode 管理
// ─────────────────────────────────────────────────────
console.log('\n[4. Mode 管理]');

test('4a. setMode clipboard → getMode clipboard', () => {
  resetState();
  rel.setMode(opState, rel.MODES.CLIPBOARD);
  assert.strictEqual(rel.getMode(opState), rel.MODES.CLIPBOARD);
});

test('4b. setMode autosend-limited → getMode autosend-limited', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  assert.strictEqual(rel.getMode(opState), rel.MODES.AUTOSEND_LIMITED);
});

test('4c. setMode paused → getMode paused + isPaused = true', () => {
  resetState();
  rel.setMode(opState, rel.MODES.PAUSED);
  assert.strictEqual(rel.getMode(opState), rel.MODES.PAUSED);
  // paused フラグも確認
  const state = opState.loadState();
  assert.strictEqual(state.paused, true);
});

test('4d. 不正なモードは ok:false', () => {
  const r = rel.setMode(opState, 'invalid_mode');
  assert.strictEqual(r.ok, false);
});

test('4e. clipboard モードでは 3回成功しても auto-send しない', () => {
  resetState();
  rel.setMode(opState, rel.MODES.CLIPBOARD);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'moriya');
  assert.strictEqual(rel.shouldAutoSend(opState, 'moriya'), false,
    'clipboard モードで auto-send が許可された');
});

// ─────────────────────────────────────────────────────
// 5. formatReliabilityReport
// ─────────────────────────────────────────────────────
console.log('\n[5. formatReliabilityReport]');

test('5a. レポートに allowlist 3名が含まれる', () => {
  resetState();
  const r = rel.formatReliabilityReport(opState);
  assert.ok(r.text.includes('moriya')   || r.text.includes('守谷'));
  assert.ok(r.text.includes('miyagi')   || r.text.includes('宮城'));
  assert.ok(r.text.includes('kanzaki')  || r.text.includes('神崎'));
});

test('5b. レポートに成功/失敗数が含まれる', () => {
  resetState();
  rel.recordSuccess(opState, 'moriya');
  rel.recordFailure(opState, 'moriya', 'テスト');
  const r = rel.formatReliabilityReport(opState);
  assert.ok(r.text.includes('成功'), '成功カウントがない');
  assert.ok(r.text.includes('失敗'), '失敗カウントがない');
});

test('5c. auto-send 解禁状態が表示される', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'moriya');
  const r = rel.formatReliabilityReport(opState);
  assert.ok(r.text.includes('auto-send OK') || r.text.includes('✅'));
});

// ─────────────────────────────────────────────────────
// 6. Emergency Stop（pause 最優先）
// ─────────────────────────────────────────────────────
console.log('\n[6. Emergency Stop]');

test('6a. pause 中は mode=autosend-limited でも shouldAutoSend = false', () => {
  resetState();
  rel.setMode(opState, rel.MODES.AUTOSEND_LIMITED);
  for (let i = 0; i < 3; i++) rel.recordSuccess(opState, 'moriya');
  // paused フラグを立てる
  const state = opState.loadState();
  state.paused = true;
  opState.saveState(state);
  // getMode は paused を最優先で返す
  assert.strictEqual(rel.getMode(opState), rel.MODES.PAUSED);
  assert.strictEqual(rel.shouldAutoSend(opState, 'moriya'), false);
});

test('6b. checkOnce は pause 中に auto-send しない', () => {
  resetState();
  rel.setMode(opState, rel.MODES.PAUSED);
  const r = operator.checkOnce();
  assert.strictEqual(r.newCount, 0, 'pause 中に送信された');
  resetState();
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. !operator mode が実装されている", () => {
  assert.ok(src.includes("opSub === 'mode'"), '!operator mode がない');
});

test("7b. !operator reliability が実装されている", () => {
  assert.ok(src.includes("opSub === 'reliability'"), '!operator reliability がない');
});

test('7c. !operator pause が緊急停止として最優先に位置する', () => {
  const pauseIdx = src.indexOf("opSub === 'pause'");
  const modeIdx  = src.indexOf("opSub === 'mode'");
  const relIdx   = src.indexOf("opSub === 'reliability'");
  assert.ok(pauseIdx < modeIdx,  'pause が mode より後にある');
  assert.ok(pauseIdx < relIdx,   'pause が reliability より後にある');
});

test('7d. operator-reliability.js を require している', () => {
  const idx  = src.indexOf("opSub === 'mode'");
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes("require('./utils/operator-reliability')"), 'require がない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetState();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
