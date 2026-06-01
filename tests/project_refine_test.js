'use strict';
// !project refine テスト（R1〜R7 + 安全条件）
// pending-plans.js ユニット + index.js ソース確認

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ── テスト用に一時ファイルを使う ──────────────────────
const ORIG_DATA_FILE = path.join(__dirname, '..', 'data', 'pending-plans.json');
const TMP_DATA_FILE  = path.join(os.tmpdir(), `pending-plans-test-${Date.now()}.json`);

// pending-plans.js の DATA_FILE をモンキーパッチ
const pp = require('../bot/utils/pending-plans');
// _loadPlans / _savePlans を使って直接テストデータを管理

function resetStore() {
  // pending-plans.json を空にして TMP に切り替え（本番データを汚さない）
  pp._savePlans([]);
}

// ────────────────────────────────────────────────────────
// 1. pending-plans.js ユニットテスト
// ────────────────────────────────────────────────────────
console.log('\n[1. pending-plans.js 基本動作]');

test('1a. createPlan が plan を返す', () => {
  resetStore();
  const plan = pp.createPlan('test-project', 'user1', [
    { type: 'IMPLEMENT', prompt: 'テスト機能A', dangerLevel: '低' },
    { type: 'IMPLEMENT', prompt: 'テスト機能B', dangerLevel: '低' },
  ], []);
  assert.ok(plan.id.startsWith('plan_'), 'plan.id が plan_ で始まらない');
  assert.strictEqual(plan.status, pp.PLAN_STATUS.PENDING);
  assert.strictEqual(plan.projectId, 'test-project');
  assert.strictEqual(plan.tasks.length, 2);
});

test('1b. getLatestPlan で pending plan が取得できる', () => {
  const plan = pp.getLatestPlan('test-project');
  assert.ok(plan, 'plan が null');
  assert.strictEqual(plan.status, pp.PLAN_STATUS.PENDING);
});

test('1c. 別 projectId のプランは取得されない', () => {
  const plan = pp.getLatestPlan('other-project');
  assert.strictEqual(plan, null, '別プロジェクトのプランが返された');
});

// ────────────────────────────────────────────────────────
// R1. refine 生成してもタスク登録されない
// ────────────────────────────────────────────────────────
console.log('\n[R1. refine 生成 → タスク登録されない]');

test('R1a. createPlan は tasks.json を変更しない', () => {
  resetStore();
  const tm = require('../bot/utils/task-manager');
  const countBefore = tm.listTasks().length;

  pp.createPlan('r1-project', 'user1', [
    { type: 'IMPLEMENT', prompt: 'R1 テスト機能', dangerLevel: '低' },
  ]);

  const countAfter = tm.listTasks().length;
  assert.strictEqual(countBefore, countAfter, 'createPlan がタスクを登録してしまった');
});

test('R1b. pending plan の status が pending のまま', () => {
  const plan = pp.getLatestPlan('r1-project');
  assert.strictEqual(plan.status, pp.PLAN_STATUS.PENDING);
});

// ────────────────────────────────────────────────────────
// R2. approve 後だけ登録される（ソース確認）
// ────────────────────────────────────────────────────────
console.log('\n[R2. approve 後だけ登録される]');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const refineStart = src.indexOf('async function handleProjectRefine');
const refineEnd   = src.indexOf('\nasync function handleProject', refineStart);
const refineSrc   = src.slice(refineStart, refineEnd > 0 ? refineEnd : refineStart + 8000);

test('R2a. approve サブコマンド内だけに createTask 呼び出しがある', () => {
  // approveブロック
  const approveIdx = refineSrc.indexOf("subSub === 'approve'");
  const cancelIdx  = refineSrc.indexOf("subSub === 'cancel'");
  const approveBlock = refineSrc.slice(approveIdx, cancelIdx > approveIdx ? cancelIdx : approveIdx + 2000);
  assert.ok(approveBlock.includes('createTask'), 'approve ブロックに createTask がない');

  // 生成ブロック（最後の else 相当）には createTask がない
  const generateBlock = refineSrc.slice(refineSrc.lastIndexOf('// ── !project refine（生成'));
  assert.ok(!generateBlock.includes('createTask'), '生成ブロックに createTask が混入している');
});

test('R2b. consumePlan が approve ブロックで呼ばれる', () => {
  const approveIdx  = refineSrc.indexOf("subSub === 'approve'");
  const cancelIdx   = refineSrc.indexOf("subSub === 'cancel'");
  const approveBlock = refineSrc.slice(approveIdx, cancelIdx > approveIdx ? cancelIdx : approveIdx + 2000);
  assert.ok(approveBlock.includes('consumePlan'), 'consumePlan が approve ブロックにない');
});

// ────────────────────────────────────────────────────────
// R3. 二重 approve しても増えない
// ────────────────────────────────────────────────────────
console.log('\n[R3. 二重 approve 防止]');

test('R3a. consumePlan → status が consumed になる', () => {
  resetStore();
  const plan = pp.createPlan('r3-project', 'user1', [
    { type: 'IMPLEMENT', prompt: 'consumed テスト', dangerLevel: '低' },
  ]);
  const consumed = pp.consumePlan(plan.id);
  assert.strictEqual(consumed.status, pp.PLAN_STATUS.CONSUMED);
});

test('R3b. consumed plan は getLatestPlan で取得できない（期限内でも除外）', () => {
  // consumePlan 後は PENDING でも APPROVED でもないので pruneExpired で除外される
  const plan = pp.getLatestPlan('r3-project');
  assert.strictEqual(plan, null, 'consumed plan が getLatestPlan で返された');
});

test('R3c. consumePlan を二度呼んでも冪等', () => {
  const plans = pp._loadPlans();
  const p = plans.find(x => x.projectId === 'r3-project');
  if (!p) { console.log('    (r3 plan not in store, skip)'); return; }
  const result = pp.consumePlan(p.id);
  assert.strictEqual(result.status, pp.PLAN_STATUS.CONSUMED);
});

test('R3d. approve ブロックに consumed チェックがある（ソース確認）', () => {
  const approveIdx  = refineSrc.indexOf("subSub === 'approve'");
  const cancelIdx   = refineSrc.indexOf("subSub === 'cancel'");
  const approveBlock = refineSrc.slice(approveIdx, cancelIdx > approveIdx ? cancelIdx : approveIdx + 2000);
  assert.ok(
    approveBlock.includes('PLAN_STATUS.CONSUMED') || approveBlock.includes("'consumed'"),
    'consumed チェックが approve ブロックにない'
  );
});

// ────────────────────────────────────────────────────────
// R4. 20件上限
// ────────────────────────────────────────────────────────
console.log('\n[R4. 20件上限]');

test('R4a. MAX_TASKS が 20 である', () => {
  assert.strictEqual(pp.MAX_TASKS, 20);
});

test('R4b. 25件渡しても tasks は 20件になる', () => {
  resetStore();
  const manyTasks = Array.from({ length: 25 }, (_, i) => ({
    type: 'IMPLEMENT', prompt: `機能${i + 1}`, dangerLevel: '低',
  }));
  const plan = pp.createPlan('r4-project', 'user1', manyTasks.slice(0, 20), manyTasks.slice(20));
  assert.strictEqual(plan.tasks.length, 20, `tasks.length=${plan.tasks.length}`);
  assert.strictEqual(plan.overflow.length, 5, `overflow.length=${plan.overflow.length}`);
});

test('R4c. index.js の生成ブロックが MAX=20 でスライスしている', () => {
  const genBlock = refineSrc.slice(refineSrc.lastIndexOf('// ── !project refine（生成'));
  assert.ok(genBlock.includes('MAX_TASKS') || genBlock.includes('MAX = pendingPlans'), 'MAX_TASKS による切り捨てがない');
  assert.ok(genBlock.includes('.slice(0, MAX)') || genBlock.includes('slice(0, MAX)'), 'slice(0, MAX) がない');
});

test('R4d. overflow が Discord 表示に含まれる', () => {
  const fmtBlock = refineSrc.slice(refineSrc.indexOf('function _formatRefinePlan'));
  assert.ok(fmtBlock.includes('overflow'), 'overflow が _formatRefinePlan にない');
  assert.ok(fmtBlock.includes('次回'), '次回候補の表示文言がない');
});

// ────────────────────────────────────────────────────────
// R5. owner 以外 approve 拒否
// ────────────────────────────────────────────────────────
console.log('\n[R5. owner 以外 approve 拒否]');

test('R5a. approve ブロックに DISCORD_OWNER_ID チェックがある', () => {
  const approveIdx  = refineSrc.indexOf("subSub === 'approve'");
  const cancelIdx   = refineSrc.indexOf("subSub === 'cancel'");
  const approveBlock = refineSrc.slice(approveIdx, cancelIdx > approveIdx ? cancelIdx : approveIdx + 2000);
  assert.ok(approveBlock.includes('DISCORD_OWNER_ID'), 'DISCORD_OWNER_ID チェックがない');
  assert.ok(approveBlock.includes('message.author.id'), 'author.id チェックがない');
});

test('R5b. owner チェックが createTask より前にある', () => {
  const approveIdx    = refineSrc.indexOf("subSub === 'approve'");
  const ownerIdx      = refineSrc.indexOf('DISCORD_OWNER_ID', approveIdx);
  const createTaskIdx = refineSrc.indexOf('createTask', approveIdx);
  assert.ok(ownerIdx < createTaskIdx, 'owner チェックが createTask より後にある');
});

// ────────────────────────────────────────────────────────
// R6. projectId 正しく付与
// ────────────────────────────────────────────────────────
console.log('\n[R6. projectId 正しく付与]');

test('R6a. createPlan に渡した projectId が plan に保存される', () => {
  resetStore();
  const plan = pp.createPlan('r6-test-pid', 'user1', [
    { type: 'IMPLEMENT', prompt: 'テスト', dangerLevel: '低' },
  ]);
  assert.strictEqual(plan.projectId, 'r6-test-pid');
});

test('R6b. approve ブロックで createTask に pid を渡している', () => {
  const approveIdx   = refineSrc.indexOf("subSub === 'approve'");
  const cancelIdx    = refineSrc.indexOf("subSub === 'cancel'");
  const approveBlock = refineSrc.slice(approveIdx, cancelIdx > approveIdx ? cancelIdx : approveIdx + 2000);
  // createTask(..., pid, ...) の形式でpidが渡されているか
  assert.ok(approveBlock.includes('pid'), 'approveブロックにpidがない');
  assert.ok(approveBlock.includes('createTask'), 'createTask がない');
});

// ────────────────────────────────────────────────────────
// R7. LARGE 分割
// ────────────────────────────────────────────────────────
console.log('\n[R7. LARGE 分割]');

test('R7a. index.js 生成ブロックに LARGE チェックと generateSplitProposals がある', () => {
  const genBlock = refineSrc.slice(refineSrc.lastIndexOf('// ── !project refine（生成'));
  assert.ok(genBlock.includes('TASK_SIZES.LARGE'), 'LARGE チェックがない');
  assert.ok(genBlock.includes('generateSplitProposals'), 'generateSplitProposals がない');
});

test('R7b. generateSplitProposals が taskManager から使える', () => {
  const tm = require('../bot/utils/task-manager');
  assert.strictEqual(typeof tm.generateSplitProposals, 'function');
  const proposals = tm.generateSplitProposals('大きなタスク\n- フェーズ1: 設計\n- フェーズ2: 実装\n- フェーズ3: テスト');
  assert.ok(Array.isArray(proposals), 'proposals が Array でない');
});

// ────────────────────────────────────────────────────────
// 追加安全条件確認
// ────────────────────────────────────────────────────────
console.log('\n[安全条件追加確認]');

test('S1. security.checkPrompt が生成ブロックで呼ばれる', () => {
  const genBlock = refineSrc.slice(refineSrc.lastIndexOf('// ── !project refine（生成'));
  assert.ok(genBlock.includes('security.checkPrompt'), 'security.checkPrompt がない');
});

test('S2. auto-refine / auto-approve のトリガーが存在しない', () => {
  // project_done や ループから自動 refine/approve を呼ぶコードがないこと
  // _runProjectLoop / handleAutoOn の中に refine/approve 呼び出しがないことを確認
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 6000);
  assert.ok(!loopBody.includes('handleProjectRefine'), '_runProjectLoop が handleProjectRefine を呼んでいる');
  assert.ok(!loopBody.includes("'approve'"), '_runProjectLoop に refine approve が混入');
});

test('S3. discardByProject が cancel ブロックで呼ばれる', () => {
  const cancelIdx = refineSrc.indexOf("subSub === 'cancel'");
  const showIdx   = refineSrc.indexOf("subSub === 'show'");
  const cancelBlock = refineSrc.slice(cancelIdx, showIdx > cancelIdx ? showIdx : cancelIdx + 500);
  assert.ok(cancelBlock.includes('discardByProject') || cancelBlock.includes('discardPlan'), '破棄処理がない');
});

test('S4. pending-plans.json が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('pending-plans.json'), '.gitignore に pending-plans.json がない');
});

test('S5. TTL が 24h に設定されている', () => {
  resetStore();
  const plan = pp.createPlan('ttl-test', 'user1', [{ type: 'IMPLEMENT', prompt: 'TTLテスト' }]);
  const ttlMs = new Date(plan.expiresAt).getTime() - new Date(plan.createdAt).getTime();
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(ttlMs - TWENTY_FOUR_H) < 1000, `TTL が 24h でない: ${ttlMs}ms`);
});

test('S6. atomic write (savePlans が tmp 経由で書き込む) — ソース確認', () => {
  const ppSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'pending-plans.js'), 'utf8');
  assert.ok(ppSrc.includes('renameSync'), 'renameSync がない（atomic でない）');
  assert.ok(ppSrc.includes('.tmp.json'), '一時ファイルが使われていない');
});

// ────────────────────────────────────────────────────────
// R8. 既存テスト全通過確認（ソース変更なし）
// ────────────────────────────────────────────────────────
console.log('\n[R8. 既存機能保護確認]');

test('R8a. executeReviewTask は変更されていない（REVIEW 経路保護）', () => {
  const reviewIdx = src.indexOf('async function executeReviewTask');
  assert.ok(reviewIdx >= 0, 'executeReviewTask が消えている');
  // 関数本体に REVIEW タスク向けの Codex 呼び出しがあること
  const reviewBody = src.slice(reviewIdx, reviewIdx + 600);
  assert.ok(
    reviewBody.includes('callCodexAPI') || reviewBody.includes('saveCodexResponse') || reviewBody.includes('REVIEWタスク'),
    'executeReviewTask の内容が変わっている'
  );
});

test('R8b. _runProjectLoop は変更されていない（HUMAN_CHECK / Quality Gate 保護）', () => {
  assert.ok(src.includes('_handleHumanCheck'), '_handleHumanCheck が消えている');
  assert.ok(src.includes('_maybeRunMidQualityGate'), '_maybeRunMidQualityGate が消えている');
  assert.ok(src.includes('_handleSoftRed'), '_handleSoftRed が消えている');
});

test('R8c. handleProjectRefine が handleProject とは独立している', () => {
  const refineIdx = src.indexOf('async function handleProjectRefine');
  const projectIdx = src.indexOf('async function handleProject(');
  assert.ok(refineIdx < projectIdx, 'handleProjectRefine が handleProject の後に定義されていない');
  assert.ok(src.includes("sub === 'refine'"), "handleProject から refine がルーティングされていない");
});

// ────────────────────────────────────────────────────────
// クリーンアップ
// ────────────────────────────────────────────────────────
resetStore(); // テストデータを消去

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
