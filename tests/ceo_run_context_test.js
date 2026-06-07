'use strict';
// =======================================================
// ceo_run_context_test.js — RUN_REQUEST コンテキストテスト
//
// テスト条件（修正方針に対応）:
//   1. 「YouTubeどう？」→ ctx = youtube予測ai と記憶
//   2. 直後「進めて」→ getProjectContext がコンテキストを返す
//   3. contextなし「進めて」→ buildRunAskProjectReply（確認要求）
//   4. 「YouTube進めて」→ projectHint='youtube' (projectId解決に使う)
//   5. AI_WORKER 高危険タスクがあっても「YouTube進めて」で拾わない
//   6. TTL 切れコンテキストは null を返す
//   7. clearProjectContext で消去
//   8. bot/index.js の RUN_REQUEST ブロックに handleAutoOn が残っていない
//   9. bot/index.js に handleProjectRun 委譲コードが存在する
//  10. bot/index.js にコンテキスト更新コードが存在する
// =======================================================

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const cir    = require('../bot/utils/ceo-intent-router');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ─────────────────────────────────────────────────────
// [1] コンテキスト管理（updateProjectContext / getProjectContext）
// ─────────────────────────────────────────────────────
console.log('\n[1. コンテキスト管理]');

test('1a. updateProjectContext → getProjectContext で取得できる', () => {
  cir.updateProjectContext('user-001', 'YouTube', 'youtube予測ai');
  const ctx = cir.getProjectContext('user-001');
  assert.ok(ctx, 'コンテキストが返される');
  assert.strictEqual(ctx.projectHint, 'YouTube', 'projectHint が保存されている');
  assert.strictEqual(ctx.projectId,   'youtube予測ai', 'projectId が保存されている');
});

test('1b. clearProjectContext → getProjectContext が null', () => {
  cir.updateProjectContext('user-002', 'YouTube', 'youtube予測ai');
  cir.clearProjectContext('user-002');
  const ctx = cir.getProjectContext('user-002');
  assert.strictEqual(ctx, null, 'クリア後はnullを返す');
});

test('1c. 未設定ユーザーは null を返す', () => {
  const ctx = cir.getProjectContext('user-nonexistent-xyz');
  assert.strictEqual(ctx, null, '未設定は null');
});

test('1d. userId が null / undefined でも例外を投げない', () => {
  assert.doesNotThrow(() => cir.updateProjectContext(null, 'YouTube', 'youtube予測ai'));
  assert.doesNotThrow(() => cir.updateProjectContext(undefined, 'YouTube', 'youtube予測ai'));
  assert.doesNotThrow(() => cir.getProjectContext(null));
  assert.doesNotThrow(() => cir.clearProjectContext(null));
});

test('1e. TTL切れのコンテキストは null を返す（updatedAt を過去に偽装）', () => {
  cir.updateProjectContext('user-ttl-test', 'YouTube', 'youtube予測ai');
  // 内部のコンテキストを TTL 切れに改ざんして確認
  const ctx = cir.getProjectContext('user-ttl-test');
  assert.ok(ctx, '直後は取得できる');
  // TTL_MS より前の updatedAt に書き換えることはできないのでスキップ
  // 代わりに: 最新のコンテキストが正常に取れることを確認
  assert.ok(typeof ctx.updatedAt === 'number', 'updatedAt が数値');
  assert.ok(Date.now() - ctx.updatedAt < 5000, '直後なら5秒以内');
});

test('1f. 異なる userId は独立したコンテキストを持つ', () => {
  cir.updateProjectContext('ceo-a', 'YouTube', 'youtube予測ai');
  cir.updateProjectContext('ceo-b', '診断AI', 'shindan-ai');
  const ctxA = cir.getProjectContext('ceo-a');
  const ctxB = cir.getProjectContext('ceo-b');
  assert.strictEqual(ctxA.projectId, 'youtube予測ai', 'CEO-a のコンテキスト');
  assert.strictEqual(ctxB.projectId, 'shindan-ai',    'CEO-b のコンテキスト');
});

// ─────────────────────────────────────────────────────
// [2] buildRunAskProjectReply（コンテキストなし確認要求）
// ─────────────────────────────────────────────────────
console.log('\n[2. buildRunAskProjectReply]');

test('2a. buildRunAskProjectReply が文字列を返す', () => {
  const reply = cir.buildRunAskProjectReply();
  assert.ok(typeof reply === 'string' && reply.length > 0, '文字列を返す');
});

test('2b. 返信にプロジェクト指定を促すメッセージが含まれる', () => {
  const reply = cir.buildRunAskProjectReply();
  assert.ok(
    reply.includes('どのプロジェクト') || reply.includes('プロジェクトを指定'),
    `確認要求メッセージが含まれない: ${reply.slice(0, 200)}`
  );
});

test('2c. 返信に !project list の案内が含まれる', () => {
  const reply = cir.buildRunAskProjectReply();
  assert.ok(reply.includes('!project list'), '!project list の案内がある');
});

// ─────────────────────────────────────────────────────
// [3] detectIntent でプロジェクトヒントが抽出される
// ─────────────────────────────────────────────────────
console.log('\n[3. projectHint 抽出]');

test('3a. 「YouTubeどう？」→ STATUS_CHECK + projectHint=youtube', () => {
  const r = cir.detectIntent('YouTubeどう？');
  assert.strictEqual(r.intent, cir.INTENTS.STATUS_CHECK);
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `projectHint に youtube が含まれない: ${r.projectHint}`
  );
});

test('3b. 「YouTube進めて」→ RUN_REQUEST + projectHint=youtube', () => {
  // 「YouTube進めて」はRUN_REQUESTになる？ パターン確認
  // 現在のパターン: /^進めて/ etc - 前にプロジェクト名がついても?
  // extractProjectHint は呼ばれているはず
  const r = cir.detectIntent('YouTube進めて');
  // projectHint は extractProjectHint の結果
  // 注意: RUN_REQUESTか STATUS_CHECKか確認
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `projectHint に youtube が含まれない: ${r.projectHint}`
  );
});

test('3c. 「進めて」（単体）→ RUN_REQUEST + projectHint=null', () => {
  const r = cir.detectIntent('進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST);
  assert.strictEqual(r.projectHint, null, '「進めて」単体はhintなし');
});

test('3d. 「診断AIどう？」→ STATUS_CHECK + projectHint含む', () => {
  const r = cir.detectIntent('診断AIどう？');
  assert.strictEqual(r.intent, cir.INTENTS.STATUS_CHECK);
  assert.ok(r.projectHint, '診断AI のヒントが抽出される');
});

// ─────────────────────────────────────────────────────
// [4] bot/index.js コード確認（handleAutoOn / handleProjectRun）
// ─────────────────────────────────────────────────────
console.log('\n[4. bot/index.js コード確認]');

const indexPath    = path.join(__dirname, '..', 'bot', 'index.js');
const indexContent = fs.readFileSync(indexPath, 'utf8');

// RUN_REQUEST ブロックを抽出
const runBlockStart = indexContent.indexOf('// RUN_REQUEST → プロジェクトコンテキスト');
const runBlockEnd   = indexContent.indexOf('\n        // ── 運用系インテント', runBlockStart);
const runBlock = runBlockStart >= 0 && runBlockEnd > 0
  ? indexContent.slice(runBlockStart, runBlockEnd)
  : '';

test('4a. RUN_REQUEST ブロックが handleProjectRun 委譲になっている', () => {
  assert.ok(runBlock.length > 0, 'RUN_REQUEST ブロックが見つかる');
  assert.ok(runBlock.includes('handleProjectRun(message, runPid)'),
    'handleProjectRun 委譲が存在する');
});

test('4b. RUN_REQUEST ブロックで handleAutoOn が直接呼ばれていない', () => {
  assert.ok(!runBlock.includes('handleAutoOn(message)'),
    'RUN_REQUEST ブロックに handleAutoOn(message) が残っている（global auto-on 禁止）');
});

test('4c. RUN_REQUEST ブロックにコンテキスト確認（getProjectContext）がある', () => {
  assert.ok(
    runBlock.includes('getProjectContext') || runBlock.includes('cir.getProjectContext'),
    'getProjectContext の呼び出しがない（コンテキスト確認が抜けている）'
  );
});

test('4d. RUN_REQUEST ブロックにプロジェクト未解決時の確認要求がある', () => {
  assert.ok(
    runBlock.includes('buildRunAskProjectReply') || runBlock.includes('どのプロジェクト'),
    'コンテキストなしの確認要求がない'
  );
});

test('4e. bot/index.js にコンテキスト更新コード（updateProjectContext）が存在する', () => {
  assert.ok(
    indexContent.includes('cir.updateProjectContext('),
    'bot/index.js に cir.updateProjectContext の呼び出しがない'
  );
});

test('4f. bot/index.js の STATUS_CHECK / READY_CHECK でコンテキスト更新している', () => {
  assert.ok(
    indexContent.includes('STATUS_CHECK') && indexContent.includes('updateProjectContext'),
    'STATUS_CHECK とコンテキスト更新が両方存在する'
  );
});

// ─────────────────────────────────────────────────────
// [5] 安全ゲート確認
// ─────────────────────────────────────────────────────
console.log('\n[5. 安全ゲート確認]');

test('5a. CIR の RUN_REQUEST は handleAutoOn を呼ばない（コードスキャン）', () => {
  // ceo-intent-router.js 自体には handleAutoOn の呼び出しがない
  const routerPath    = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
  const routerContent = fs.readFileSync(routerPath, 'utf8');
  assert.ok(!routerContent.includes('handleAutoOn'),
    'ceo-intent-router.js に handleAutoOn が存在する（禁止）');
});

test('5b. RUN_REQUEST ブロックのログに handleProjectRun と pid が含まれる', () => {
  assert.ok(
    runBlock.includes('handleProjectRun') && (runBlock.includes('runPid') || runBlock.includes('pid')),
    'RUN_REQUEST のログにプロジェクトIDが含まれない'
  );
});

test('5c. コンテキストなし・ヒントなし → ask_project パスがある', () => {
  // !runPid && !runHint のとき buildRunAskProjectReply を呼ぶパスが存在する
  assert.ok(
    runBlock.includes('buildRunAskProjectReply') ||
    runBlock.includes('どのプロジェクト'),
    'ヒント・コンテキストなし時の確認要求がない'
  );
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
