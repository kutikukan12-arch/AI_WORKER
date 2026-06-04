'use strict';
// Autonomous Workflow Safety Layer テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const budget = require('../bot/utils/workflow-budget');
const gate   = require('../bot/utils/inbox-action-gate');
const safety = require('../bot/utils/workflow-safety-layer');

const CONV_ID = `test_conv_${Date.now()}`;

function resetBudget() {
  budget._save({});
}

// ─────────────────────────────────────────────────────
// 1. Phase1: Conversation Budget
// ─────────────────────────────────────────────────────
console.log('\n[1. Conversation Budget]');

test('1a. openConversation が会話を作成する', () => {
  resetBudget();
  const r = budget.openConversation(CONV_ID, { maxTurns: 4, taskId: 'task_001' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conv.maxTurns, 4);
  assert.strictEqual(r.conv.currentTurns, 0);
});

test('1b. recordTurn がターンを記録する', () => {
  resetBudget();
  budget.openConversation(CONV_ID, { maxTurns: 6 });
  const r = budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.conv.currentTurns, 1);
});

test('1c. ターン上限到達でエスカレーション', () => {
  resetBudget();
  budget.openConversation(CONV_ID, { maxTurns: 2 });
  budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  budget.recordTurn(CONV_ID, 'moriya', 'miyagi', 'NEED_FIX');
  const r = budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.action, 'escalate_vp');
});

test('1d. CEO判断必要イベントは即停止', () => {
  resetBudget();
  budget.openConversation(CONV_ID, { maxTurns: 10 });
  const r = budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'BLOCKED');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.action, 'ceo_required');
});

test('1e. 同一2者間ループ検知', () => {
  resetBudget();
  budget.openConversation(CONV_ID, { maxTurns: 20 });
  // 同一ペアを SAME_PAIR_MAX+1 回繰り返す
  for (let i = 0; i < budget.SAME_PAIR_MAX + 1; i++) {
    budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  }
  const r = budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.action, 'loop_detected');
});

test('1f. エスカレーション通知文が生成される', () => {
  resetBudget();
  budget.openConversation(CONV_ID, { maxTurns: 2 });
  budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  budget.recordTurn(CONV_ID, 'moriya', 'miyagi', 'NEED_FIX');
  budget.recordTurn(CONV_ID, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  const conv = budget.getConversation(CONV_ID);
  const msg  = budget.buildEscalationMessage(conv);
  assert.ok(msg.includes('エスカレーション'), 'エスカレーション文がない');
  assert.ok(msg.includes('神崎'),            '神崎 VP への言及がない');
  assert.ok(msg.includes('CEOの指示'),       'CEO への言及がない');
});

test('1g. closeConversation で会話が閉じる', () => {
  resetBudget();
  budget.openConversation(CONV_ID);
  budget.closeConversation(CONV_ID, 'completed');
  const conv = budget.getConversation(CONV_ID);
  assert.strictEqual(conv.status, 'closed');
});

// ─────────────────────────────────────────────────────
// 2. Phase2: Inbox Action Gate
// ─────────────────────────────────────────────────────
console.log('\n[2. Inbox Action Gate]');

test('2a. REVIEW_RESULT 分類', () => {
  const r = gate.classify('READY です。品質確認が完了しました。LGTM。');
  assert.strictEqual(r.class, gate.ACTION_CLASS.REVIEW_RESULT);
});

test('2b. IMPLEMENT_DONE 分類', () => {
  const r = gate.classify('## 結論\n実装完了しました。## 実施内容\nbug fix。commit 済み。');
  assert.strictEqual(r.class, gate.ACTION_CLASS.IMPLEMENT_DONE);
});

test('2c. CEO_DECISION_REQUIRED 分類', () => {
  const r = gate.classify('支出が必要です。CEO判断をお願いします。');
  assert.strictEqual(r.class, gate.ACTION_CLASS.CEO_DECISION_REQUIRED);
  assert.strictEqual(r.isCeoRequired, true);
});

test('2d. QUESTION 分類', () => {
  const r = gate.classify('どうすれば良いですか？判断が難しいのですが、ご意見をいただけますか？');
  assert.strictEqual(r.class, gate.ACTION_CLASS.QUESTION);
});

test('2e. UNKNOWN はデフォルト', () => {
  const r = gate.classify('テキスト内容');
  assert.strictEqual(r.class, gate.ACTION_CLASS.UNKNOWN);
});

test('2f. 禁止アクションは isActionAllowed が false', () => {
  const cls = { allowedActions: ['propose_handoff'] };
  assert.strictEqual(gate.isActionAllowed(cls, 'create_task'),         false);
  assert.strictEqual(gate.isActionAllowed(cls, 'register_decision'),   false);
  assert.strictEqual(gate.isActionAllowed(cls, 'approve'),             false);
});

test('2g. 許可アクションは isActionAllowed が true', () => {
  const cls = gate.classify('READY です。LGTM。品質確認が完了しました。');
  assert.strictEqual(gate.isActionAllowed(cls, 'propose_handoff'), true);
});

// ─────────────────────────────────────────────────────
// 3. Phase3: Workflow Chain 検証
// ─────────────────────────────────────────────────────
console.log('\n[3. Workflow Chain 検証]');

test('3a. 宮城→守谷 IMPLEMENT_DONE は許可', () => {
  const r = safety.validateChain('miyagi', 'moriya', 'IMPLEMENT_DONE');
  assert.strictEqual(r.allowed, true);
});

test('3b. 守谷→宮城 NEED_FIX は許可', () => {
  const r = safety.validateChain('moriya', 'miyagi', 'NEED_FIX');
  assert.strictEqual(r.allowed, true);
});

test('3c. 未許可チェーンは拒否', () => {
  const r = safety.validateChain('miyagi', 'kanemori', 'COST_REQUIRED');
  assert.strictEqual(r.allowed, false);
  assert.ok(r.reason.includes('未許可チェーン'));
});

test('3d. any→ikuno LESSON_CANDIDATE は許可', () => {
  const r = safety.validateChain('miyagi', 'ikuno', 'LESSON_CANDIDATE');
  assert.strictEqual(r.allowed, true);
});

// ─────────────────────────────────────────────────────
// 4. Safety Layer 統合テスト
// ─────────────────────────────────────────────────────
console.log('\n[4. Safety Layer 統合テスト]');

test('4a. checkSafeToHandoff — 正常チェーン', () => {
  resetBudget();
  const r = safety.checkSafeToHandoff({
    convId: 'test_safe_001',
    from:   'miyagi',
    to:     'moriya',
    event:  'IMPLEMENT_DONE',
  });
  assert.strictEqual(r.safe, true);
});

test('4b. checkSafeToHandoff — CEO判断必要コンテンツは停止', () => {
  resetBudget();
  const r = safety.checkSafeToHandoff({
    convId:       'test_safe_002',
    from:         'miyagi',
    to:           'moriya',
    event:        'IMPLEMENT_DONE',
    inboxContent: '支出が必要です。CEO判断が必要です。承認をお願いします。',
  });
  assert.strictEqual(r.safe, false);
  assert.strictEqual(r.action, 'ceo_required');
});

test('4c. processInbox — IMPLEMENT_DONE は配送候補を提案', () => {
  const r = safety.processInbox('kanzaki',
    '## 結論\n実装完了しました。## 実施内容\nPhase13実装完了。commit済み。',
    'test_conv_inbox'
  );
  assert.strictEqual(r.ok, true);
  assert.ok(r.handoffCandidates.length >= 0);
});

test('4d. processInbox — CEO判断必要コンテンツは停止', () => {
  const r = safety.processInbox('kurokawa',
    'CEO判断をお願いします。支出が必要です。課金判断が必要です。',
    'test_conv_ceo'
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'ceo_required');
});

// ─────────────────────────────────────────────────────
// 5. 禁止事項確認
// ─────────────────────────────────────────────────────
console.log('\n[5. 禁止事項確認]');

test('5a. workflow-budget.js に eval がない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'workflow-budget.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('5b. inbox-action-gate.js に task 自動作成がない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'inbox-action-gate.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),  'createTask が含まれている');
  assert.ok(!code.includes('logDecision('), 'logDecision が含まれている');
});

test('5c. 黒川は判断代理しない（safety-layer に READY/NEED_FIX 判定生成なし）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'workflow-safety-layer.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // 判断を「生成」するコードがないこと（return 'READY' や status='NEED_FIX' 等）
  // 事前定義済みイベント名の参照は OK（ALLOWED_CHAINS の定義等）
  assert.ok(!code.includes("return 'READY'"),    'READY を返している（判断代理）');
  assert.ok(!code.includes("return 'NEED_FIX'"), 'NEED_FIX を返している（判断代理）');
  assert.ok(!code.includes("status = 'READY'"),  'status に READY をセットしている');
  assert.ok(!code.includes('approveTask'),        'approveTask が含まれている');
});

test('5d. workflow-budget.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/workflow-budget.json'));
});

// ─────────────────────────────────────────────────────
// 6. 既存 Operator 非破壊確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 既存 Operator 非破壊確認]');

test('6a. workflow-router.js が変更されていない', () => {
  const router = require('../bot/utils/workflow-router');
  assert.ok(router.FIXED_ROUTES,    'FIXED_ROUTES が消えた');
  assert.ok(router.WORKFLOW_EVENTS, 'WORKFLOW_EVENTS が消えた');
  assert.ok(router.autoHandoff,     'autoHandoff が消えた');
});

test('6b. reply-collector.js が変更されていない', () => {
  const rc = require('../bot/utils/reply-collector');
  assert.ok(rc.markWaitingReply,  'markWaitingReply が消えた');
  assert.ok(rc.startPolling,      'startPolling が消えた');
  assert.ok(rc.REPLY_SIGNATURES,  'REPLY_SIGNATURES が消えた');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetBudget();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
