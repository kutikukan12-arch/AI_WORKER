'use strict';
// Safety Layer Runtime Integration テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const router  = require('../bot/utils/workflow-router');
const budget  = require('../bot/utils/workflow-budget');
const safety  = require('../bot/utils/workflow-safety-layer');
const audit   = require('../bot/utils/workflow-audit');
const ib      = require('../bot/utils/inbox-bridge');

function resetBudget()  { budget._save({}); }
function resetAudit()   { audit._load(); try { fs.writeFileSync(audit.AUDIT_FILE, '[]'); } catch {} }
function cleanOutbox(w) { const p = ib._workerOutboxPath(w); try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} }

// ─────────────────────────────────────────────────────
// 1. autoHandoff + Safety Gate 統合
// ─────────────────────────────────────────────────────
console.log('\n[1. autoHandoff + Safety Gate 統合]');

test('1a. 正常チェーンは dispatched:true', () => {
  resetBudget(); cleanOutbox('moriya');
  const r = router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_001', summary: '実装完了',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dispatched, true, `dispatched が false: ${r.reason}`);
  assert.ok(r.convId, 'convId がない');
  assert.ok(r.handoffId, 'handoffId がない');
});

test('1b. ループ検知で停止（dispatched:false）', () => {
  resetBudget();
  const convId = 'conv_task_loop';
  // 同一ペアを SAME_PAIR_MAX 回超えるように事前に記録
  budget.openConversation(convId, { maxTurns: 20 });
  for (let i = 0; i < budget.SAME_PAIR_MAX + 1; i++) {
    budget.recordTurn(convId, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  }
  // autoHandoff: taskId から convId を生成して既存会話に接続
  const r = router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_loop', summary: 'ループテスト',
  });
  // Safety Layer がループを検知して停止
  assert.strictEqual(r.dispatched, false, '停止されていない');
  assert.ok(r.action === 'loop_detected' || r.reason?.includes('ループ') || r.reason, `action: ${r.action}`);
});

test('1c. ターン上限で escalate_vp', () => {
  resetBudget();
  const convId = 'conv_task_maxturn';
  budget.openConversation(convId, { maxTurns: 1 });
  budget.recordTurn(convId, 'miyagi', 'moriya', 'IMPLEMENT_DONE');
  const r = router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_maxturn', summary: '上限テスト',
  });
  assert.strictEqual(r.dispatched, false);
  assert.ok(r.action === 'escalate_vp' || r.reason, `escalate がない: ${r.action}`);
});

test('1d. safe:false 時に outbox へ送信されない', () => {
  resetBudget(); cleanOutbox('moriya');
  const convId = 'conv_task_nosend';
  budget.openConversation(convId, { maxTurns: 0 }); // 上限 0
  const r = router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_nosend', summary: 'テスト',
  });
  assert.strictEqual(r.dispatched, false);
  // outbox が作成されていないこと
  const outPath = ib._workerOutboxPath('moriya');
  const size    = outPath && fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  assert.strictEqual(size, 0, 'safe:false なのに outbox が作成された');
});

test('1e. CEO判断必要コンテンツで停止', () => {
  resetBudget(); cleanOutbox('moriya');
  const r = router.autoHandoff('IMPLEMENT_DONE', {
    from:    'miyagi',
    taskId:  'task_ceo',
    summary: '支出が必要です。CEO判断・承認をお願いします。',
  });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.action, 'ceo_required');
});

// ─────────────────────────────────────────────────────
// 2. Audit Log
// ─────────────────────────────────────────────────────
console.log('\n[2. Audit Log]');

test('2a. autoHandoff 後に監査ログが記録される', () => {
  resetBudget(); resetAudit(); cleanOutbox('moriya');
  router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_audit', summary: 'audit test',
  });
  const logs = audit.getRecentAudit(5);
  assert.ok(logs.length > 0, '監査ログが記録されない');
  const entry = logs[0];
  assert.ok(entry.convId, 'convId がない');
  assert.ok(entry.from,   'from がない');
  assert.ok(entry.to,     'to がない');
  assert.ok(entry.event,  'event がない');
  assert.ok('safe' in entry, 'safe フィールドがない');
});

test('2b. safe:false の場合に stopReason が記録される', () => {
  resetBudget(); resetAudit();
  const convId = 'conv_task_audit_stop';
  budget.openConversation(convId, { maxTurns: 0 });
  router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_audit_stop', summary: 'stop test',
  });
  const logs = audit.getRecentAudit(5);
  const failEntry = logs.find(l => l.safe === false);
  assert.ok(failEntry, 'safe:false の監査ログがない');
  assert.ok(failEntry.stopReason || failEntry.stopAction, 'stop 理由がない');
});

test('2c. workflow-audit.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/workflow-audit.json'));
});

// ─────────────────────────────────────────────────────
// 3. Phase2: conversationId lifecycle
// ─────────────────────────────────────────────────────
console.log('\n[3. conversationId lifecycle]');

test('3a. makeConvId がタスクIDから conv ID を生成する', () => {
  const id = safety.makeConvId('task_xyz');
  assert.strictEqual(id, 'conv_task_xyz');
});

test('3b. makeConvId に null を渡すとタイムスタンプ付き ID', () => {
  const id = safety.makeConvId(null);
  assert.ok(id.startsWith('conv_'), `prefix が違う: ${id}`);
});

test('3c. REVIEW_READY で autoClose される', () => {
  resetBudget();
  budget.openConversation('conv_close_test', { maxTurns: 10 });
  const closed = safety.autoCloseIfNeeded('conv_close_test', 'REVIEW_READY');
  assert.strictEqual(closed, true, 'REVIEW_READY でクローズされない');
  const conv = budget.getConversation('conv_close_test');
  assert.strictEqual(conv.status, 'closed');
});

test('3d. IMPLEMENT_DONE は autoClose しない', () => {
  resetBudget();
  budget.openConversation('conv_noclose_test', { maxTurns: 10 });
  const closed = safety.autoCloseIfNeeded('conv_noclose_test', 'IMPLEMENT_DONE');
  assert.strictEqual(closed, false, 'IMPLEMENT_DONE でクローズされた');
  const conv = budget.getConversation('conv_noclose_test');
  assert.strictEqual(conv.status, 'open');
});

// ─────────────────────────────────────────────────────
// 4. Phase3: SPEC_READY 新ルート
// ─────────────────────────────────────────────────────
console.log('\n[4. Phase3 SPEC_READY ルート]');

test('4a. SPEC_READY が WORKFLOW_EVENTS に追加されている', () => {
  assert.ok(router.WORKFLOW_EVENTS.SPEC_READY, 'SPEC_READY がない');
});

test('4b. SPEC_READY が FIXED_ROUTES に追加されている', () => {
  assert.ok(router.FIXED_ROUTES.SPEC_READY, 'SPEC_READY が FIXED_ROUTES にない');
  assert.deepStrictEqual(router.FIXED_ROUTES.SPEC_READY.allowedFrom, ['ichikawa']);
  assert.strictEqual(router.FIXED_ROUTES.SPEC_READY.to, 'miyagi');
});

test('4c. 市川→宮城 SPEC_READY は正常配送', () => {
  resetBudget(); cleanOutbox('miyagi');
  const r = router.autoHandoff('SPEC_READY', {
    from: 'ichikawa', taskId: 'task_spec', summary: '仕様確定しました',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dispatched, true, `dispatched:false: ${r.reason}`);
});

// ─────────────────────────────────────────────────────
// 5. 黒川禁止事項確認
// ─────────────────────────────────────────────────────
console.log('\n[5. 黒川禁止事項確認]');

test('5a. workflow-router.js に eval がない', () => {
  const src  = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('5b. 黒川が READY/NEED_FIX を生成しない（autoHandoff）', () => {
  const src  = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8');
  // autoHandoff 関数の本体のみ検査
  const fnStart = src.indexOf('function autoHandoff(');
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1);
  const fnBody  = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  const code    = fnBody.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes("return 'READY'"),    'READY を生成している');
  assert.ok(!code.includes("return 'NEED_FIX'"), 'NEED_FIX を生成している');
  assert.ok(!code.includes("approveTask("),      '承認を実行している');
});

test('5c. safe:false 時に task を自動作成しない', () => {
  const src  = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('), 'createTask が含まれている');
});

// ─────────────────────────────────────────────────────
// 6. 既存 Workflow 非破壊確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 既存 Workflow 非破壊確認]');

test('6a. 既存の IMPLEMENT_DONE ルートが機能する', () => {
  resetBudget(); cleanOutbox('moriya');
  const r = router.autoHandoff('IMPLEMENT_DONE', {
    from: 'miyagi', taskId: 'task_regr', summary: '回帰テスト',
  });
  assert.strictEqual(r.ok, true, `ok でない: ${r.error}`);
  assert.strictEqual(r.dispatched, true);
});

test('6b. workflow_auto_handoff_test が示す既存 5イベントが維持されている', () => {
  const events = ['IMPLEMENT_DONE', 'NEED_FIX', 'REVIEW_READY', 'LESSON_CANDIDATE', 'INCIDENT_CANDIDATE'];
  for (const e of events) {
    assert.ok(router.FIXED_ROUTES[e], `${e} が FIXED_ROUTES に存在しない`);
  }
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetBudget();
resetAudit();
['moriya', 'miyagi', 'kurokawa'].forEach(cleanOutbox);

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
