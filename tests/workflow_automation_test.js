'use strict';
// Workflow Automation Phase5-9 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const router  = require('../bot/utils/workflow-router');
const wsm     = require('../bot/utils/worker-status');
const wstate  = require('../bot/utils/workflow-state');
const src     = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetWSM()    { wsm._save({}); }
function resetWState() { wstate._save({ handoffs: [], dailyLog: [], updatedAt: null }); }

// ─────────────────────────────────────────────────────
// 1. Phase5: Workflow Router — ルーティング
// ─────────────────────────────────────────────────────
console.log('\n[1. workflow-router — ルーティング]');

test('1a. IMPLEMENT_DONE → moriya (守谷 CTO)', () => {
  const r = router.route('IMPLEMENT_DONE', { from: 'miyagi', taskId: 'task_abc', summary: '実装完了' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.to, 'moriya');
  assert.ok(r.message.includes('実装完了') || r.message.includes('守谷'));
});

test('1b. NEED_FIX → miyagi (宮城)', () => {
  const r = router.route('NEED_FIX', { taskId: 'task_abc', summary: '修正が必要' });
  assert.strictEqual(r.to, 'miyagi');
});

test('1c. REVIEW_READY → ichikawa (市川 PM)', () => {
  const r = router.route('REVIEW_READY', { taskId: 'task_abc', summary: 'レビュー準備完了' });
  assert.strictEqual(r.to, 'ichikawa');
});

test('1d. USER_FEEDBACK → aizawa (相沢 CS)', () => {
  const r = router.route('USER_FEEDBACK', { summary: 'ユーザーから意見あり' });
  assert.strictEqual(r.to, 'aizawa');
});

test('1e. COST_REQUIRED → kanemori (金森 CFO)', () => {
  const r = router.route('COST_REQUIRED', { summary: 'コスト確認が必要' });
  assert.strictEqual(r.to, 'kanemori');
});

test('1f. INCIDENT_FOUND → ikuno (育野)', () => {
  const r = router.route('INCIDENT_FOUND', { summary: 'インシデント発生' });
  assert.strictEqual(r.to, 'ikuno');
});

test('1g. BLOCKED → ceo (黒川経由)', () => {
  const r = router.route('BLOCKED', { taskId: 'task_abc', summary: 'ブロック検出' });
  assert.strictEqual(r.to, 'ceo');
  assert.strictEqual(r.viaKurokawa, true);
});

test('1h. 不明イベントは ok:false', () => {
  const r = router.route('UNKNOWN_EVENT', {});
  assert.strictEqual(r.ok, false);
});

test('1i. summary に redact が適用される', () => {
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  const r = router.route('IMPLEMENT_DONE', { summary: `token: ${fakeToken}` });
  assert.ok(!r.message.includes(fakeToken), 'トークンが含まれている');
  assert.ok(r.message.includes('[MASKED]'));
});

// ─────────────────────────────────────────────────────
// 2. 黒川判断代理禁止確認
// ─────────────────────────────────────────────────────
console.log('\n[2. 黒川判断代理禁止]');

test('2a. 黒川は READY 判定しない（ルーティングテーブルに READY 生成なし）', () => {
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8'
  );
  const codeOnly = routerSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // READY を返す出力があってはならない（REVIEW_READY は受信イベント名としてのみ使用）
  assert.ok(!codeOnly.includes("status: 'READY'"),         'READY ステータスを返している');
  assert.ok(!codeOnly.includes("return 'READY'"),          'READY を return している');
  assert.ok(!codeOnly.includes("taskManager.updateState"), 'タスクを直接更新している');
});

test('2b. 黒川は修正不要判断をしない（NEED_FIX は受信のみ）', () => {
  const r = router.route('NEED_FIX', { summary: 'テスト' });
  // to が miyagi であること（修正者に転送する）
  assert.strictEqual(r.to, 'miyagi', '修正依頼が宮城に届かない');
  // message に「修正不要」が含まれないこと
  assert.ok(!r.message.includes('修正不要'), '黒川が修正不要と判断している');
});

test('2c. 黒川はリリース判断をしない（REVIEW_READY は市川へ転送のみ）', () => {
  const r = router.route('REVIEW_READY', { summary: 'テスト' });
  assert.ok(r.to !== 'kurokawa', '黒川がリリース先になっている');
  assert.ok(!r.message.includes('リリースOK'), '黒川がリリース判断している');
});

test('2d. buildHandoffText に自動実行コードがない', () => {
  const r    = router.route('IMPLEMENT_DONE', { taskId: 'task_abc', summary: '完了' });
  const text = router.buildHandoffText(r);
  // 提案のみ → 実際のコマンド実行なし
  assert.ok(text.includes('手動'), '手動確認の案内がない');
  assert.ok(!text.includes('taskManager.createTask'), '自動実行が含まれている');
});

test('2e. eval / exec が workflow-router.js にない', () => {
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'workflow-router.js'), 'utf8'
  );
  const codeOnly = routerSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('eval('),     'eval が含まれている');
  assert.ok(!codeOnly.includes('execSync('), 'execSync が含まれている');
});

// ─────────────────────────────────────────────────────
// 3. Phase6: Worker Status Manager
// ─────────────────────────────────────────────────────
console.log('\n[3. worker-status — ステータス管理]');

test('3a. updateStatus で状態を更新できる', () => {
  resetWSM();
  const r = wsm.updateStatus('miyagi', 'working', { taskId: 'task_abc', note: '実装中' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'working');
});

test('3b. getStatus で最新状態を取得できる', () => {
  resetWSM();
  wsm.updateStatus('moriya', 'waiting_review');
  const s = wsm.getStatus('moriya');
  assert.strictEqual(s.status, 'waiting_review');
});

test('3c. 不明な worker はエラー', () => {
  const r = wsm.updateStatus('unknown_person', 'working');
  assert.strictEqual(r.ok, false);
});

test('3d. 不明なステータスはエラー', () => {
  const r = wsm.updateStatus('miyagi', 'invalid_status');
  assert.strictEqual(r.ok, false);
});

test('3e. formatStatusReport が全社員を表示', () => {
  resetWSM();
  const r = wsm.formatStatusReport();
  assert.ok(r.text.includes('宮城'), '宮城が表示されない');
  assert.ok(r.text.includes('守谷'), '守谷が表示されない');
  assert.ok(r.text.includes('黒川'), '黒川が表示されない');
});

test('3f. BLOCKED 社員がいれば警告が表示される', () => {
  resetWSM();
  wsm.updateStatus('miyagi', 'blocked', { note: 'テストブロック' });
  const r = wsm.formatStatusReport();
  assert.ok(r.text.includes('ブロック') || r.text.includes('blocked'), 'ブロック警告がない');
});

test('3g. worker-status.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/worker-status.json'), 'gitignore にない');
});

// ─────────────────────────────────────────────────────
// 4. Phase8: Waiting Detection
// ─────────────────────────────────────────────────────
console.log('\n[4. workflow-state — 待機検出]');

test('4a. recordHandoff でハンドオフを記録できる', () => {
  resetWState();
  const r = router.route('IMPLEMENT_DONE', { taskId: 'task_abc', summary: 'テスト' });
  const id = wstate.recordHandoff(r, 'task_abc');
  assert.ok(id && id.startsWith('hoff_'), `handoff id: ${id}`);
});

test('4b. 閾値未満のハンドオフは detectWaiting で検出されない', () => {
  resetWState();
  const r = router.route('IMPLEMENT_DONE', { taskId: 'task_abc', summary: 'テスト' });
  wstate.recordHandoff(r, 'task_abc');
  const waiting = wstate.detectWaiting(10 * 60 * 60 * 1000); // 10時間閾値
  assert.strictEqual(waiting.length, 0, '閾値未満なのに検出された');
});

test('4c. 閾値ゼロなら即検出', () => {
  resetWState();
  const r = router.route('NEED_FIX', { taskId: 'task_fix', summary: 'テスト' });
  wstate.recordHandoff(r, 'task_fix');
  const waiting = wstate.detectWaiting(0);
  assert.strictEqual(waiting.length, 1, '検出されない');
  assert.strictEqual(waiting[0].event, 'NEED_FIX');
});

test('4d. resolveHandoff で解決済みにできる', () => {
  resetWState();
  const r  = router.route('COST_REQUIRED', { summary: 'テスト' });
  const id = wstate.recordHandoff(r);
  wstate.resolveHandoff(id);
  const waiting = wstate.detectWaiting(0);
  assert.strictEqual(waiting.length, 0, '解決後も検出される');
});

test('4e. formatWorkflowStatus が状態を表示する', () => {
  resetWState();
  const r = wstate.formatWorkflowStatus();
  assert.ok(r.text.includes('Workflow'), 'Workflow 状態表示がない');
  assert.ok(r.text.includes('黒川'), '黒川の注記がない');
});

test('4f. workflow-state.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/workflow-state.json'), 'gitignore にない');
});

// ─────────────────────────────────────────────────────
// 5. Phase9: Daily Closing データ保存
// ─────────────────────────────────────────────────────
console.log('\n[5. Phase9 — Daily Closing データ保存]');

test('5a. saveDailySnapshot でスナップショットを保存できる', () => {
  resetWState();
  const snap = wstate.saveDailySnapshot({
    completed:  ['task_aaa', 'task_bbb'],
    incomplete: ['task_ccc'],
    blocked:    [],
    memo:       '明日は task_ccc から開始',
  });
  assert.ok(snap.date, 'date がない');
  assert.strictEqual(snap.completed.length,  2);
  assert.strictEqual(snap.incomplete.length, 1);
});

test('5b. getLatestDailySnapshot で最新を取得できる', () => {
  resetWState();
  wstate.saveDailySnapshot({ completed: ['task_xyz'], incomplete: [], blocked: [] });
  const snap = wstate.getLatestDailySnapshot();
  assert.ok(snap, 'スナップショットが取得できない');
  assert.strictEqual(snap.completed[0], 'task_xyz');
});

test('5c. 同じ日に再保存すると上書きされる', () => {
  resetWState();
  wstate.saveDailySnapshot({ completed: ['a'], incomplete: [], blocked: [] });
  wstate.saveDailySnapshot({ completed: ['a', 'b'], incomplete: [], blocked: [] });
  const snap = wstate.getLatestDailySnapshot();
  assert.strictEqual(snap.completed.length, 2, '上書きされない');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. !workflow status が実装されている", () => {
  assert.ok(src.includes("wfSub === 'status'"), '!workflow status がない');
});

test("6b. !workflow route が実装されている", () => {
  assert.ok(src.includes("wfSub === 'route'"), '!workflow route がない');
});

test("6c. !worker status が実装されている", () => {
  assert.ok(src.includes("wkArgs[0] === 'status'"), '!worker status がない');
});

test("6d. !worker update が実装されている", () => {
  assert.ok(src.includes("wkArgs[0] === 'update'"), '!worker update がない');
});

test('6e. workflow-router.js を require している', () => {
  assert.ok(src.includes("require('./utils/workflow-router')"), 'require がない');
});

test('6f. worker-status.js を require している', () => {
  assert.ok(src.includes("require('./utils/worker-status')"), 'require がない');
});

test('6g. workflow-state.js を require している', () => {
  assert.ok(src.includes("require('./utils/workflow-state')"), 'require がない');
});

// ─────────────────────────────────────────────────────
// 7. detectEventFromTaskState
// ─────────────────────────────────────────────────────
console.log('\n[7. detectEventFromTaskState]');

test('7a. REVIEWING 状態のタスクは IMPLEMENT_DONE を検出', () => {
  const fakeTask = { state: 'REVIEWING', type: 'IMPLEMENT' };
  assert.strictEqual(router.detectEventFromTaskState(fakeTask), router.WORKFLOW_EVENTS.IMPLEMENT_DONE);
});

test('7b. ON_HOLD + errorType は BLOCKED を検出', () => {
  const fakeTask = { state: 'ON_HOLD', type: 'IMPLEMENT', errorType: 'TIMEOUT' };
  assert.strictEqual(router.detectEventFromTaskState(fakeTask), router.WORKFLOW_EVENTS.BLOCKED);
});

test('7c. null は null を返す', () => {
  assert.strictEqual(router.detectEventFromTaskState(null), null);
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetWSM();
resetWState();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
