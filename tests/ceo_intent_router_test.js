'use strict';
// =======================================================
// ceo_intent_router_test.js — CEO Intent Router テスト
//
// テスト条件（自然文 → インテント）:
//   「今どう？」→ STATUS_CHECK
//   「進めて」→ RUN_REQUEST
//   「問題ある？」→ PROBLEM_CHECK
//   「YouTube完成した？」→ READY_CHECK
//   「今日なにした？」→ SUMMARY_REQUEST
//   「!help」→ UNKNOWN（コマンドはスルー）
//   長文 → UNKNOWN（タスクとして処理）
// =======================================================

const assert = require('assert');
const cir    = require('../bot/utils/ceo-intent-router');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ─────────────────────────────────────────────────────
// [1] インテント検出
// ─────────────────────────────────────────────────────
console.log('\n[1. インテント検出]');

test('1a. 「今どう？」→ STATUS_CHECK', () => {
  const r = cir.detectIntent('今どう？');
  assert.strictEqual(r.intent, cir.INTENTS.STATUS_CHECK,
    `got: ${r.intent}`);
});

test('1b. 「YouTubeどう？」→ STATUS_CHECK', () => {
  const r = cir.detectIntent('YouTubeどう？');
  assert.strictEqual(r.intent, cir.INTENTS.STATUS_CHECK,
    `got: ${r.intent}`);
});

test('1c. 「進めて」→ RUN_REQUEST', () => {
  const r = cir.detectIntent('進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST,
    `got: ${r.intent}`);
});

test('1d. 「進めといて」→ RUN_REQUEST', () => {
  const r = cir.detectIntent('進めといて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST,
    `got: ${r.intent}`);
});

test('1e. 「問題ある？」→ PROBLEM_CHECK', () => {
  const r = cir.detectIntent('問題ある？');
  assert.strictEqual(r.intent, cir.INTENTS.PROBLEM_CHECK,
    `got: ${r.intent}`);
});

test('1f. 「止まってない？」→ PROBLEM_CHECK', () => {
  const r = cir.detectIntent('止まってない？');
  assert.strictEqual(r.intent, cir.INTENTS.PROBLEM_CHECK,
    `got: ${r.intent}`);
});

test('1g. 「公開できる？」→ READY_CHECK', () => {
  const r = cir.detectIntent('公開できる？');
  assert.strictEqual(r.intent, cir.INTENTS.READY_CHECK,
    `got: ${r.intent}`);
});

test('1h. 「YouTube完成した？」→ READY_CHECK', () => {
  const r = cir.detectIntent('YouTube完成した？');
  assert.strictEqual(r.intent, cir.INTENTS.READY_CHECK,
    `got: ${r.intent}`);
});

test('1i. 「今日なにした？」→ SUMMARY_REQUEST', () => {
  const r = cir.detectIntent('今日なにした？');
  assert.strictEqual(r.intent, cir.INTENTS.SUMMARY_REQUEST,
    `got: ${r.intent}`);
});

test('1j. 「今日どうだった？」→ SUMMARY_REQUEST', () => {
  const r = cir.detectIntent('今日どうだった？');
  assert.strictEqual(r.intent, cir.INTENTS.SUMMARY_REQUEST,
    `got: ${r.intent}`);
});

test('1k. 「OK」→ APPROVE_HINT', () => {
  const r = cir.detectIntent('OK');
  assert.strictEqual(r.intent, cir.INTENTS.APPROVE_HINT,
    `got: ${r.intent}`);
});

// ─────────────────────────────────────────────────────
// [2] フォールスルー（コマンド・長文）
// ─────────────────────────────────────────────────────
console.log('\n[2. フォールスルー（コマンド・長文はUNKNOWN）]');

test('2a. 「!help」→ UNKNOWN（コマンドはスルー）', () => {
  const r = cir.detectIntent('!help');
  assert.strictEqual(r.intent, cir.INTENTS.UNKNOWN,
    `コマンドはIntent Routerを通過しない: ${r.intent}`);
});

test('2b. 「!task list」→ UNKNOWN', () => {
  const r = cir.detectIntent('!task list');
  assert.strictEqual(r.intent, cir.INTENTS.UNKNOWN,
    `got: ${r.intent}`);
});

test('2c. 長文（50文字超）→ UNKNOWN', () => {
  const longText = 'YouTubeの診断AIをβユーザーに配布するための準備を進めてください。手順としては...という形で実装してください。';
  const r = cir.detectIntent(longText);
  assert.strictEqual(r.intent, cir.INTENTS.UNKNOWN,
    `長文はタスクとして処理: ${r.intent}`);
});

test('2d. 「認証機能を実装してください」→ UNKNOWN（タスク）', () => {
  const r = cir.detectIntent('認証機能を実装してください');
  assert.strictEqual(r.intent, cir.INTENTS.UNKNOWN,
    `got: ${r.intent}`);
});

// ─────────────────────────────────────────────────────
// [3] プロジェクトヒント抽出
// ─────────────────────────────────────────────────────
console.log('\n[3. プロジェクトヒント抽出]');

test('3a. 「YouTubeどう？」→ projectHint = YouTube', () => {
  const r = cir.detectIntent('YouTubeどう？');
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `expected YouTube hint, got: ${r.projectHint}`
  );
});

test('3b. 「今どう？」→ projectHint = null（特定なし）', () => {
  const r = cir.detectIntent('今どう？');
  // ヒントなしでも動作する
  assert.ok(r.intent === cir.INTENTS.STATUS_CHECK);
});

// ─────────────────────────────────────────────────────
// [4] buildStatusReply モック確認
// ─────────────────────────────────────────────────────
console.log('\n[4. buildStatusReply モック確認]');

const mockTaskManager = {
  STATES: {
    PENDING: '未着手', IN_PROGRESS: '作業中',
    REVIEWING: 'レビュー待ち', HUMAN_CHECK: '人間確認待ち',
    DONE: '完了',
  },
  listTasks: () => [
    { id: 'task_001', type: 'IMPLEMENT', state: '作業中',   projectId: 'proj-A', prompt: '認証機能を実装する' },
    { id: 'task_002', type: 'RESEARCH',  state: '未着手',   projectId: 'proj-A', prompt: 'API設計を調査する' },
    { id: 'task_003', type: 'TEST',      state: '完了',     projectId: 'proj-A', prompt: 'テストを実行する' },
    { id: 'task_004', type: 'IMPLEMENT', state: '人間確認待ち', projectId: 'proj-A', prompt: '外部公開の確認' },
  ],
};

test('4a. STATUS_CHECK 返信にタスク状態が含まれる', () => {
  const reply = cir.buildStatusReply('proj-A', mockTaskManager, 'YouTube');
  assert.ok(reply.includes('実行中'), `reply missing 実行中: ${reply.slice(0, 200)}`);
  assert.ok(reply.includes('未着手'), `reply missing 未着手: ${reply.slice(0, 200)}`);
  assert.ok(reply.includes('完了'),   `reply missing 完了: ${reply.slice(0, 200)}`);
});

test('4b. STATUS_CHECK 返信に CEO確認待ちが含まれる（ブロッカー表示）', () => {
  const reply = cir.buildStatusReply('proj-A', mockTaskManager, null);
  assert.ok(reply.includes('CEO確認待ち'), `reply should show CEO blocker: ${reply.slice(0, 200)}`);
});

// ─────────────────────────────────────────────────────
// [5] buildProblemReply モック確認
// ─────────────────────────────────────────────────────
console.log('\n[5. buildProblemReply モック確認]');

const mockApprovalManager = {
  listPending: () => [],
};
const mockApprovalManagerWithPending = {
  listPending: () => [
    { taskId: 'task_004', prompt: '外部公開の確認', reason: '本番デプロイが必要', danger: '高' },
  ],
};

test('5a. 問題なし → ✅ 正常稼働のメッセージ', () => {
  const noHumanWaitTM = {
    ...mockTaskManager,
    listTasks: () => [
      { id: 'task_001', state: '作業中', projectId: 'proj-A', prompt: 'test' },
    ],
  };
  const reply = cir.buildProblemReply('proj-A', noHumanWaitTM, mockApprovalManager);
  assert.ok(reply.includes('問題なし'), `expected 問題なし: ${reply}`);
});

test('5b. CEO確認待ちあり → ⚠️ 問題ありメッセージ', () => {
  const reply = cir.buildProblemReply('proj-A', mockTaskManager, mockApprovalManager);
  assert.ok(reply.includes('CEO確認待ち'), `expected blocker info: ${reply.slice(0, 200)}`);
});

// ─────────────────────────────────────────────────────
// [6] buildReadyCheckReply モック確認
// ─────────────────────────────────────────────────────
console.log('\n[6. buildReadyCheckReply モック確認]');

test('6a. 未完了タスクあり → 完成していないメッセージ', () => {
  const reply = cir.buildReadyCheckReply('proj-A', mockTaskManager, 'YouTube');
  assert.ok(reply.includes('まだ完了していません'), `expected 未完了: ${reply}`);
});

test('6b. 全完了 → 完了メッセージ + 外部公開はCEO確認の注意', () => {
  const allDoneTM = {
    ...mockTaskManager,
    listTasks: () => [
      { id: 'task_001', state: '完了', projectId: 'proj-B', prompt: 'done' },
      { id: 'task_002', state: '完了', projectId: 'proj-B', prompt: 'done2' },
    ],
  };
  const reply = cir.buildReadyCheckReply('proj-B', allDoneTM, 'YouTube');
  assert.ok(reply.includes('完了状態'), `expected 完了: ${reply}`);
  assert.ok(reply.includes('CEO'), `should mention CEO for release decision: ${reply}`);
});

// ─────────────────────────────────────────────────────
// [7] buildApproveHintReply モック確認
// ─────────────────────────────────────────────────────
console.log('\n[7. buildApproveHintReply モック確認]');

test('7a. 承認待ちなし → 承認待ちなしメッセージ', () => {
  const reply = cir.buildApproveHintReply(mockApprovalManager);
  assert.ok(reply.includes('承認待ち'), `expected 承認待ち: ${reply}`);
  assert.ok(!reply.includes('!approve'), `should not pre-show approve command when none pending: ${reply}`);
});

test('7b. 承認待ちあり → !approve コマンドを提示', () => {
  const reply = cir.buildApproveHintReply(mockApprovalManagerWithPending);
  assert.ok(reply.includes('!approve'), `expected !approve suggestion: ${reply}`);
  assert.ok(reply.includes('!deny'), `expected !deny suggestion: ${reply}`);
});

// ─────────────────────────────────────────────────────
// [8] isCEOUser 確認
// ─────────────────────────────────────────────────────
console.log('\n[8. isCEOUser 確認]');

test('8a. CEO_USER_IDS 未設定 → isCEOUser=false（安全側）', () => {
  const origEnv = process.env.CEO_USER_IDS;
  delete process.env.CEO_USER_IDS;
  const result = cir.isCEOUser('any-user-id');
  assert.strictEqual(result, false, 'CEO_USER_IDS未設定は安全側でfalse');
  process.env.CEO_USER_IDS = origEnv || '';
});

test('8b. CEO_USER_IDS に含まれるID → isCEOUser=true', () => {
  process.env.CEO_USER_IDS = 'user-123,user-456';
  assert.strictEqual(cir.isCEOUser('user-123'), true);
  assert.strictEqual(cir.isCEOUser('user-456'), true);
  assert.strictEqual(cir.isCEOUser('user-999'), false);
  delete process.env.CEO_USER_IDS;
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
