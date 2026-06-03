'use strict';
// Phase10: 黒川 Auto Handoff テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const router = require('../bot/utils/workflow-router');
const wstate = require('../bot/utils/workflow-state');
const ib     = require('../bot/utils/inbox-bridge');
const src    = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetWState() { wstate._save({ handoffs: [], dailyLog: [], updatedAt: null }); }
function clearOutbox(worker) {
  const p = ib._workerOutboxPath(worker);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}
function cleanup() {
  resetWState();
  ['miyagi','moriya','ichikawa','ikuno'].forEach(clearOutbox);
}

// ─────────────────────────────────────────────────────
// 1. FIXED_ROUTES allowlist 確認
// ─────────────────────────────────────────────────────
console.log('\n[1. FIXED_ROUTES allowlist]');

test('1a. FIXED_ROUTES に5種が定義されている', () => {
  const required = ['IMPLEMENT_DONE','NEED_FIX','REVIEW_READY','LESSON_CANDIDATE','INCIDENT_CANDIDATE'];
  for (const e of required) {
    assert.ok(e in router.FIXED_ROUTES, `${e} が FIXED_ROUTES にない`);
  }
});

test('1b. IMPLEMENT_DONE は miyagi からのみ', () => {
  assert.deepStrictEqual(router.FIXED_ROUTES.IMPLEMENT_DONE.allowedFrom, ['miyagi']);
  assert.strictEqual(router.FIXED_ROUTES.IMPLEMENT_DONE.to, 'moriya');
});

test('1c. NEED_FIX は moriya からのみ', () => {
  assert.deepStrictEqual(router.FIXED_ROUTES.NEED_FIX.allowedFrom, ['moriya']);
  assert.strictEqual(router.FIXED_ROUTES.NEED_FIX.to, 'miyagi');
});

test('1d. REVIEW_READY は moriya からのみ', () => {
  assert.deepStrictEqual(router.FIXED_ROUTES.REVIEW_READY.allowedFrom, ['moriya']);
  assert.strictEqual(router.FIXED_ROUTES.REVIEW_READY.to, 'ichikawa');
});

test('1e. LESSON/INCIDENT_CANDIDATE は from any (null)', () => {
  assert.strictEqual(router.FIXED_ROUTES.LESSON_CANDIDATE.allowedFrom,   null);
  assert.strictEqual(router.FIXED_ROUTES.INCIDENT_CANDIDATE.allowedFrom, null);
  assert.strictEqual(router.FIXED_ROUTES.LESSON_CANDIDATE.to,   'ikuno');
  assert.strictEqual(router.FIXED_ROUTES.INCIDENT_CANDIDATE.to, 'ikuno');
});

// ─────────────────────────────────────────────────────
// 2. autoHandoff — 固定ルート配送
// ─────────────────────────────────────────────────────
console.log('\n[2. autoHandoff — 固定ルート配送]');

test('2a. IMPLEMENT_DONE + from miyagi → moriya outbox 作成', () => {
  cleanup();
  const r = router.autoHandoff('IMPLEMENT_DONE', { from:'miyagi', taskId:'task_001', summary:'実装完了' });
  assert.strictEqual(r.ok,          true);
  assert.strictEqual(r.dispatched,  true);
  assert.strictEqual(r.to,          'moriya');
  assert.ok(fs.existsSync(ib._workerOutboxPath('moriya')), 'moriya outbox が作成されない');
});

test('2b. NEED_FIX + from moriya → miyagi outbox 作成', () => {
  cleanup();
  const r = router.autoHandoff('NEED_FIX', { from:'moriya', taskId:'task_001', summary:'テスト不足' });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.to,         'miyagi');
  assert.ok(fs.existsSync(ib._workerOutboxPath('miyagi')));
});

test('2c. REVIEW_READY + from moriya → ichikawa outbox 作成', () => {
  cleanup();
  const r = router.autoHandoff('REVIEW_READY', { from:'moriya', taskId:'task_001', summary:'READY判定' });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.to,         'ichikawa');
  assert.ok(fs.existsSync(ib._workerOutboxPath('ichikawa')));
});

test('2d. LESSON_CANDIDATE (from any) → ikuno outbox 作成', () => {
  cleanup();
  const r = router.autoHandoff('LESSON_CANDIDATE', { from:'miyagi', summary:'テスト設計の教訓' });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.to,         'ikuno');
  assert.ok(fs.existsSync(ib._workerOutboxPath('ikuno')));
});

test('2e. INCIDENT_CANDIDATE (from any) → ikuno outbox 作成', () => {
  cleanup();
  const r = router.autoHandoff('INCIDENT_CANDIDATE', { from:'moriya', summary:'APIタイムアウト発生' });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.to,         'ikuno');
});

// ─────────────────────────────────────────────────────
// 3. CEO_CONFIRM_REQUIRED — 配送しない
// ─────────────────────────────────────────────────────
console.log('\n[3. CEO_CONFIRM_REQUIRED — 配送停止]');

test('3a. 不明イベントは CEO_CONFIRM_REQUIRED', () => {
  cleanup();
  const r = router.autoHandoff('UNKNOWN_EVENT', { from:'miyagi', summary:'テスト' });
  assert.strictEqual(r.ok,          true);
  assert.strictEqual(r.dispatched,  false);
  assert.strictEqual(r.reason,      'CEO_CONFIRM_REQUIRED');
});

test('3b. IMPLEMENT_DONE + from moriya (宮城以外) は CEO_CONFIRM_REQUIRED', () => {
  cleanup();
  const r = router.autoHandoff('IMPLEMENT_DONE', { from:'moriya', summary:'テスト' });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.reason,     'CEO_CONFIRM_REQUIRED');
  // outbox が作成されていないこと
  assert.ok(!fs.existsSync(ib._workerOutboxPath('moriya')), '不正配送が実行された');
});

test('3c. NEED_FIX + from miyagi (守谷以外) は CEO_CONFIRM_REQUIRED', () => {
  cleanup();
  const r = router.autoHandoff('NEED_FIX', { from:'miyagi', summary:'テスト' });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.reason,     'CEO_CONFIRM_REQUIRED');
});

test('3d. BLOCKED イベントは CEO_CONFIRM_REQUIRED（固定ルートに含まれない）', () => {
  cleanup();
  const r = router.autoHandoff('BLOCKED', { from:'miyagi', summary:'テスト' });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.reason,     'CEO_CONFIRM_REQUIRED');
});

// ─────────────────────────────────────────────────────
// 4. audit log 確認
// ─────────────────────────────────────────────────────
console.log('\n[4. audit log]');

test('4a. 自動配送後に handoff log が残る', () => {
  cleanup();
  const r = router.autoHandoff('IMPLEMENT_DONE', { from:'miyagi', taskId:'task_audit', summary:'audit test' });
  assert.ok(r.handoffId, 'handoffId がない');
  const state = wstate._load();
  const h     = state.handoffs.find(h => h.id === r.handoffId);
  assert.ok(h, 'handoff log が記録されない');
});

test('4b. autoExecuted:true が log に記録される', () => {
  cleanup();
  const r = router.autoHandoff('IMPLEMENT_DONE', { from:'miyagi', taskId:'task_audit', summary:'test' });
  const state = wstate._load();
  const h     = state.handoffs.find(h => h.id === r.handoffId);
  assert.strictEqual(h.autoExecuted, true, 'autoExecuted が true でない');
});

test('4c. reason:fixed_route が log に記録される', () => {
  cleanup();
  const r = router.autoHandoff('NEED_FIX', { from:'moriya', taskId:'task_fix', summary:'test' });
  const state = wstate._load();
  const h     = state.handoffs.find(h => h.id === r.handoffId);
  assert.strictEqual(h.reason, 'fixed_route', 'reason が fixed_route でない');
});

test('4d. CEO_CONFIRM_REQUIRED は log に記録されない', () => {
  cleanup();
  router.autoHandoff('UNKNOWN_EVENT', { from:'miyagi', summary:'test' });
  const state = wstate._load();
  assert.strictEqual(state.handoffs.length, 0, '不正ハンドオフが log に記録された');
});

// ─────────────────────────────────────────────────────
// 5. redact 確認
// ─────────────────────────────────────────────────────
console.log('\n[5. redact]');

test('5a. summary の ghp_ トークンが outbox にマスクされる', () => {
  cleanup();
  const fakeToken = 'ghp_' + 'R'.repeat(36);
  router.autoHandoff('LESSON_CANDIDATE', { from:'miyagi', summary: `token: ${fakeToken}` });
  const content = fs.existsSync(ib._workerOutboxPath('ikuno'))
    ? fs.readFileSync(ib._workerOutboxPath('ikuno'), 'utf8')
    : '';
  assert.ok(!content.includes(fakeToken), 'トークンが outbox に残っている');
  assert.ok(content.includes('[MASKED]'));
});

// ─────────────────────────────────────────────────────
// 6. 黒川が READY/NEED_FIX を生成していない確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 黒川 READY/NEED_FIX 生成禁止確認]');

test('6a. autoHandoff がREADY文言を生成しない', () => {
  cleanup();
  const r = router.autoHandoff('REVIEW_READY', { from:'moriya', summary:'テスト' });
  // READY という文言が配送文の「判定文」として含まれていないこと
  // （「READY 判定しました」の転送は OK、「黒川がREADYと判断した」はNG）
  assert.ok(!r.message.includes('黒川がREADY'), '黒川がREADYを判断している');
  assert.ok(!r.message.includes('黒川判定'),    '黒川が判定している');
});

test('6b. autoHandoff がNEED_FIX文言を自ら生成しない', () => {
  cleanup();
  const r = router.autoHandoff('NEED_FIX', { from:'moriya', summary:'テスト不足' });
  // 「黒川がNEED_FIXと判断した」という文言がないこと
  assert.ok(!r.message.includes('黒川がNEED_FIX'), '黒川がNEED_FIXを生成している');
  assert.ok(!r.message.includes('黒川判定'),       '黒川が判定している');
});

test('6c. ソースに eval / exec / child_process がない', () => {
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8'
  );
  const codeOnly = routerSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('eval('),          'eval が含まれている');
  assert.ok(!codeOnly.includes('execSync('),      'execSync が含まれている');
  assert.ok(!codeOnly.includes('child_process'),  'child_process が含まれている');
});

test('6d. autoHandoff がtask/decision/incidentを自動作成しない', () => {
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8'
  );
  const codeOnly = routerSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('createTask('),        'createTask が呼ばれている');
  assert.ok(!codeOnly.includes("require('./decision-log')"), 'decision-log が自動呼び出しされている');
  assert.ok(!codeOnly.includes("require('./incident-manager')"), 'incident-manager が自動呼び出し');
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. !workflow handoff が実装されている", () => {
  assert.ok(src.includes("wfSub === 'handoff'"), '!workflow handoff がない');
});

test('7b. autoHandoff を呼んでいる', () => {
  const idx  = src.indexOf("wfSub === 'handoff'");
  const area = src.slice(idx, idx + 1200); // handoff ブロックは 800 文字超
  assert.ok(area.includes('autoHandoff'), 'autoHandoff 呼び出しがない');
});

test('7c. !workflow route（既存の提案表示）が維持されている', () => {
  assert.ok(src.includes("wfSub === 'route'"), '!workflow route が消えている');
});

// ─────────────────────────────────────────────────────
// 8. docs 更新確認
// ─────────────────────────────────────────────────────
console.log('\n[8. docs 更新確認]');

test('8a. company-rules.md に固定ルート表が記載されている', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'docs', 'company-rules.md'), 'utf8');
  assert.ok(rules.includes('IMPLEMENT_DONE'), '固定ルート表がない');
  assert.ok(rules.includes('LESSON_CANDIDATE'), 'LESSON_CANDIDATE がない');
});

test('8b. COMPANY_CONTEXT.md に Phase10 が記載されている', () => {
  const ctx = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMPANY_CONTEXT.md'), 'utf8');
  assert.ok(ctx.includes('Phase10') || ctx.includes('固定ルート'), 'Phase10 の記載がない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
