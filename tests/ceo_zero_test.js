'use strict';
// =======================================================
// ceo_zero_test.js — CEO作業ゼロ化 テスト
//
// テスト条件（6項目）:
//   1. タスクTIMEOUT → 自動split → 再実行 → CEO通知なし
//   2. 調査タスク(RESEARCH) 変更0件 → CEO承認要求なし
//   3. テストタスク(TEST) 変更0件 → CEO承認要求なし
//   4. APIキー検出 → CEO停止（SAR判断）
//   5. 外部公開判断 → CEO停止（SAR判断）
//   6. 費用発生 → CEO停止（SAR判断）
//
// 禁止:
//   - 高危険操作の自動承認
//   - CEO承認の完全撤廃
//   - 外部公開判断の自動化
// =======================================================

const assert = require('assert');
const path   = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sar = require('../bot/utils/smart-approval-router');
const arm = require('../bot/utils/auto-recovery-manager');
const cv  = require('../bot/utils/completion-validator');
const tm  = require('../bot/utils/task-manager');
const tt  = require('../bot/utils/task-type');

let pass = 0, fail = 0;
const CLEANUP_IDS = [];
const _TS = Date.now();
const pid = 'ceo-zero-test';

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function cleanup() {
  try {
    const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
    const fs    = require('fs');
    const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    raw.tasks   = raw.tasks.filter(t => !CLEANUP_IDS.includes(t.id));
    fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// [1] タスクTIMEOUT → 自動split → CEO通知なし
// ─────────────────────────────────────────────────────
console.log('\n[1. タスクTIMEOUT → 自動split → CEO通知なし]');

const timeoutTask = tm.createTask(
  'YouTube診断β 外部配布準備\nPhase 1: 調査\nPhase 2: 実装\nPhase 3: テスト',
  'split-type-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(timeoutTask.id);
tm.updateState(timeoutTask.id, tm.STATES.IN_PROGRESS, 'timeout-test');

let splitResult;
test('1a. autoSplitOnTimeout 成功', () => {
  splitResult = tm.autoSplitOnTimeout(timeoutTask.id);
  assert.strictEqual(splitResult.ok, true, `reason: ${splitResult.reason}`);
  (splitResult.newTasks || []).forEach(t => CLEANUP_IDS.push(t.id));
});

test('1b. TIMEOUT後のARM分類 = AUTO_SPLIT（CEO不要）', () => {
  const action = arm.classifyRecovery(timeoutTask, { isTimeout: true, timeoutCount: 1 });
  assert.strictEqual(action, arm.RECOVERY_ACTIONS.AUTO_SPLIT,
    `expected AUTO_SPLIT, got: ${action}`);
});

test('1c. AUTO_SPLIT はCEO通知不要', () => {
  assert.strictEqual(arm.shouldNotifyCEO(arm.RECOVERY_ACTIONS.AUTO_SPLIT), false);
});

test('1d. AUTO_SPLIT はAI自動処理可能', () => {
  assert.strictEqual(arm.canAutoHandle(arm.RECOVERY_ACTIONS.AUTO_SPLIT), true);
});

test('1e. TIMEOUT reasonはSARでAI処理（CEO不要）', () => {
  const route = sar.routeApproval('タイムアウトにより自動分割', '', 'IMPLEMENT', {});
  assert.strictEqual(route.route, 'ai',
    `expected ai, got: ${route.route} | ${route.reason}`);
});

test('1f. 2回目TIMEOUTはESCALATE_MORIYAへ（CEOへはいかない）', () => {
  const action = arm.classifyRecovery(timeoutTask, { isTimeout: true, timeoutCount: 2 });
  assert.strictEqual(action, arm.RECOVERY_ACTIONS.ESCALATE_MORIYA,
    `expected ESCALATE_MORIYA, got: ${action}`);
  assert.strictEqual(arm.shouldNotifyCEO(action), false, 'ESCALATE_MORIYAはCEO不要');
});

// ─────────────────────────────────────────────────────
// [2] 調査タスク(RESEARCH) 変更0件 → CEO承認要求なし
// ─────────────────────────────────────────────────────
console.log('\n[2. RESEARCH 変更0件 → CEO承認不要]');

test('2a. RESEARCH は allowsNoCodeChange = true', () => {
  assert.strictEqual(cv.allowsNoCodeChange('RESEARCH', '調査してください'), true,
    'RESEARCH should allow no code changes');
});

test('2b. RESEARCH 0-diff → validation.ok = true', () => {
  const result = cv.validate(
    '調査完了。\n\n## 調査結果\n\n' + 'x'.repeat(300),
    path.join(__dirname, '..'),
    'ceo-zero-research-' + _TS,
    [],
    Date.now() - 1000,
    'RESEARCH',
    '調査してください'
  );
  assert.strictEqual(result.ok, true,
    `RESEARCH 0-diff should be OK, got: ${result.reason}`);
});

test('2c. RESEARCH reason → SAR = ai or cos（CEO不要）', () => {
  const route = sar.routeApproval('変更0件 RESEARCH完了', '', 'RESEARCH', {});
  assert.notStrictEqual(route.route, 'ceo',
    `RESEARCH completion should not go to CEO, got: ${route.route}`);
});

test('2d. ARM: REVIEWING + RESEARCH → RECLASSIFY（CEO不要）', () => {
  const researchTask = { state: 'レビュー待ち', type: 'RESEARCH', dangerLevel: '低' };
  const action = arm.classifyRecovery(researchTask, {});
  assert.strictEqual(action, arm.RECOVERY_ACTIONS.RECLASSIFY,
    `expected RECLASSIFY, got: ${action}`);
  assert.strictEqual(arm.shouldNotifyCEO(action), false);
});

// ─────────────────────────────────────────────────────
// [3] テストタスク(TEST) 変更0件 → CEO承認要求なし
// ─────────────────────────────────────────────────────
console.log('\n[3. TEST 変更0件 → CEO承認不要]');

test('3a. TEST は allowsNoCodeChange = true', () => {
  assert.strictEqual(cv.allowsNoCodeChange('TEST', 'テスト確認してください'), true,
    'TEST should allow no code changes');
});

test('3b. TEST 0-diff → validation.ok = true', () => {
  const result = cv.validate(
    'テスト結果: 全ケース正常\n\n' + 'x'.repeat(260),
    path.join(__dirname, '..'),
    'ceo-zero-test-' + _TS,
    [],
    Date.now() - 1000,
    'TEST',
    'テストを実行してください'
  );
  assert.strictEqual(result.ok, true,
    `TEST 0-diff should be OK, got: ${result.reason}`);
});

test('3c. TEST reason → SAR = ai or cos（CEO不要）', () => {
  const route = sar.routeApproval('テスト完了 変更なし', '', 'TEST', {});
  assert.notStrictEqual(route.route, 'ceo',
    `TEST completion should not go to CEO, got: ${route.route}`);
});

test('3d. ARM: REVIEWING + TEST → RECLASSIFY（CEO不要）', () => {
  const testTask = { state: 'レビュー待ち', type: 'TEST', dangerLevel: '低' };
  const action = arm.classifyRecovery(testTask, {});
  assert.strictEqual(action, arm.RECOVERY_ACTIONS.RECLASSIFY,
    `expected RECLASSIFY, got: ${action}`);
  assert.strictEqual(arm.shouldNotifyCEO(action), false);
});

// ─────────────────────────────────────────────────────
// [4] APIキー検出 → CEO停止（安全ゲート確認）
// ─────────────────────────────────────────────────────
console.log('\n[4. APIキー検出 → CEO停止]');

test('4a. "APIキー" reason → SAR = ceo', () => {
  const route = sar.routeApproval('APIキーが漏洩している可能性', '', 'IMPLEMENT', { danger: '高' });
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route} | ${route.reason}`);
});

test('4b. "秘密情報" reason → SAR = ceo', () => {
  const route = sar.routeApproval('秘密情報が含まれています', '', 'IMPLEMENT', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('4c. "credential" reason → SAR = ceo', () => {
  const route = sar.routeApproval('credential exposure detected', '', 'IMPLEMENT', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('4d. 高危険度 ARM = ESCALATE_CEO', () => {
  const highDangerTask = { state: '実行中', type: 'IMPLEMENT', dangerLevel: '高' };
  const action = arm.classifyRecovery(highDangerTask, { danger: '高' });
  assert.strictEqual(action, arm.RECOVERY_ACTIONS.ESCALATE_CEO,
    `expected ESCALATE_CEO for high danger, got: ${action}`);
  assert.strictEqual(arm.shouldNotifyCEO(action), true, 'ESCALATE_CEOはCEO通知必要');
});

// ─────────────────────────────────────────────────────
// [5] 外部公開判断 → CEO停止
// ─────────────────────────────────────────────────────
console.log('\n[5. 外部公開判断 → CEO停止]');

test('5a. "外部公開" → SAR = ceo', () => {
  const route = sar.routeApproval('外部公開の準備を開始してよいか', '', 'OPS', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('5b. "βリリース" → SAR = ceo', () => {
  const route = sar.routeApproval('βリリースを実施する', '', 'IMPLEMENT', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('5c. "本番デプロイ" → SAR = ceo', () => {
  const route = sar.routeApproval('本番デプロイ実行してよいか', '', 'OPS', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('5d. "外部配布" → SAR = ceo', () => {
  const route = sar.routeApproval('外部配布リンクを公開する', '', 'OPS', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

// ─────────────────────────────────────────────────────
// [6] 費用発生 → CEO停止
// ─────────────────────────────────────────────────────
console.log('\n[6. 費用発生 → CEO停止]');

test('6a. "課金" → SAR = ceo', () => {
  const route = sar.routeApproval('課金が発生するAPIを有効化する', '', 'OPS', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('6b. "費用発生" → SAR = ceo', () => {
  const route = sar.routeApproval('費用発生を伴うサービスを利用する', '', 'IMPLEMENT', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('6c. "billing" → SAR = ceo', () => {
  const route = sar.routeApproval('billing approval needed', '', 'OPS', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

test('6d. "有料" → SAR = ceo', () => {
  const route = sar.routeApproval('有料プランへのアップグレードが必要', '', 'OPS', {});
  assert.strictEqual(route.route, 'ceo',
    `expected ceo, got: ${route.route}`);
});

// ─────────────────────────────────────────────────────
// [7] AI内部処理パターン（CEO通知されないことを確認）
// ─────────────────────────────────────────────────────
console.log('\n[7. AI内部処理パターン（CEO通知なし確認）]');

test('7a. stale cleanup → SAR = ai', () => {
  const route = sar.routeApproval('stale approval cleanup', '', 'OPS', { isStale: true });
  assert.strictEqual(route.route, 'ai',
    `expected ai, got: ${route.route}`);
});

test('7b. routing error → SAR = ai', () => {
  const route = sar.routeApproval('routing error: 担当変更', '', 'OPS', {});
  assert.strictEqual(route.route, 'ai',
    `expected ai, got: ${route.route}`);
});

test('7c. split判断 context → SAR = ai', () => {
  const route = sar.routeApproval('タスク分割処理', '', 'IMPLEMENT', { isSplit: true });
  assert.strictEqual(route.route, 'ai',
    `expected ai, got: ${route.route}`);
});

test('7d. auto retry → SAR = ai', () => {
  const route = sar.routeApproval('auto retry attempt 1/3', '', 'IMPLEMENT', {});
  assert.strictEqual(route.route, 'ai',
    `expected ai, got: ${route.route}`);
});

// ─────────────────────────────────────────────────────
// [8] buildRecoveryMessage CEO不要メッセージ確認
// ─────────────────────────────────────────────────────
console.log('\n[8. buildRecoveryMessage CEO不要メッセージ確認]');

test('8a. AUTO_SPLIT メッセージに "CEO" "不要" が含まれる', () => {
  const msg = arm.buildRecoveryMessage(arm.RECOVERY_ACTIONS.AUTO_SPLIT,
    { id: 'T-001', type: 'IMPLEMENT', prompt: 'テストタスク' }, {});
  assert.ok(msg.includes('CEO') && msg.includes('不要'),
    `AUTO_SPLIT msg should mention CEO不要: ${msg.slice(0, 100)}`);
});

test('8b. STALE_CLEANUP メッセージに "CEO" "不要" が含まれる', () => {
  const msg = arm.buildRecoveryMessage(arm.RECOVERY_ACTIONS.STALE_CLEANUP,
    { id: 'T-002', type: 'OPS' }, { reason: 'テスト用' });
  assert.ok(msg.includes('CEO') && msg.includes('不要'),
    `STALE_CLEANUP msg should mention CEO不要: ${msg.slice(0, 100)}`);
});

test('8c. ESCALATE_CEO メッセージには "CEO" が含まれる', () => {
  const msg = arm.buildRecoveryMessage(arm.RECOVERY_ACTIONS.ESCALATE_CEO,
    { id: 'T-003', type: 'IMPLEMENT', prompt: '外部公開' }, { reason: '外部公開判断' });
  assert.ok(msg.includes('CEO'),
    `ESCALATE_CEO msg should mention CEO: ${msg.slice(0, 100)}`);
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
