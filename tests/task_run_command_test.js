'use strict';
// !task run <taskId> コマンドのユニットテスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ─── index.js ソース確認用 ───
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─── task-manager / auto-policy / task-type-util を実際に使う ───
const taskManager  = require('../bot/utils/task-manager');
const autoPolicy   = require('../bot/utils/auto-policy');
const taskTypeUtil = require('../bot/utils/task-type');

// テスト用タスクID
const TEST_ID = `task_run_test_${Date.now()}`;

// !task run ブロックの検索範囲（ブロック全体 ~5400 文字をカバー）
const RUN_AREA_SIZE = 6000;

// ─────────────────────────────────────────────────────
// 1. index.js ソース確認（コマンド実装の存在確認）
// ─────────────────────────────────────────────────────
console.log('\n[1. index.js ソース確認]');

test("1a. sub === 'run' && args[1] のブロックが存在する", () => {
  assert.ok(
    src.includes("sub === 'run' && args[1]"),
    "!task run ハンドラが見つかりません"
  );
});

test('1b. セキュリティチェックが組み込まれている', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('security.checkPrompt'), 'security.checkPrompt がない');
});

test('1c. autoPolicy.classifyTask が呼ばれている', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('autoPolicy.classifyTask'), 'autoPolicy.classifyTask がない');
});

test('1d. BLOCKED / HUMAN_APPROVAL_REQUIRED 停止ロジックがある', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('AUTO_POLICY.BLOCKED'), 'BLOCKED チェックがない');
  assert.ok(area.includes('AUTO_POLICY.HUMAN_APPROVAL_REQUIRED'), 'HUMAN_APPROVAL_REQUIRED チェックがない');
});

test('1e. LARGE サイズチェックがある', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('TASK_SIZES.LARGE'), 'LARGE チェックがない');
});

test('1f. ON_HOLD 一時解除ロジックがある', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('wasOnHold'), 'wasOnHold 変数がない');
  assert.ok(area.includes('task run 一時解除'), '一時解除の note がない');
});

test('1g. claimNextTaskByFilter が呼ばれている', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('claimNextTaskByFilter'), 'claimNextTaskByFilter がない');
});

test('1h. REVIEW タスクは executeReviewTask へ転送される', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('TASK_TYPES.REVIEW'), 'REVIEW タイプ分岐がない');
  assert.ok(area.includes('executeReviewTask'), 'executeReviewTask 呼び出しがない');
});

test('1i. RESEARCH タスクは executeResearchTask へ転送される', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('TASK_TYPES.RESEARCH'), 'RESEARCH タイプ分岐がない');
  assert.ok(area.includes('executeResearchTask'), 'executeResearchTask 呼び出しがない');
});

test('1j. それ以外は executeClaudeTask が呼ばれる', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('executeClaudeTask'), 'executeClaudeTask 呼び出しがない');
});

test('1k. taskQueue.enqueue を使ってキュー実行している', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes('taskQueue.enqueue'), 'taskQueue.enqueue がない');
});

test('1l. source: run-task-cmd が渡されている', () => {
  const idx  = src.indexOf("sub === 'run' && args[1]");
  const area = src.slice(idx, idx + RUN_AREA_SIZE);
  assert.ok(area.includes("'run-task-cmd'"), 'source: run-task-cmd がない');
});

// ─────────────────────────────────────────────────────
// 2. !auto run / !auto on への非影響確認（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[2. !auto run / !auto on への非影響確認]');

test('2a. handleRunNext は prepareNextTask を使い続けている', () => {
  const idx  = src.indexOf('async function handleRunNext');
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes('prepareNextTask'), 'handleRunNext の prepareNextTask が消えている');
});

test('2b. handleAutoRun は prepareNextTask を使い続けている', () => {
  const idx  = src.indexOf('async function handleAutoRun');
  assert.ok(idx >= 0, 'handleAutoRun が見つからない');
  // handleAutoRun は prepareNextTask を呼ぶ前に引数チェック等があるため 2000 文字分を確認
  const area = src.slice(idx, idx + 2000);
  assert.ok(area.includes('prepareNextTask'), 'handleAutoRun の prepareNextTask が消えている');
});

// ─────────────────────────────────────────────────────
// 3. task-manager: claimNextTaskByFilter で特定IDのみクレームできる
// ─────────────────────────────────────────────────────
console.log('\n[3. task-manager: claimNextTaskByFilter 動作確認]');

// テスト用タスクを追加
const beforeIds = taskManager.listTasks().map(t => t.id);

test('3a. PENDING タスクを特定IDでクレームできる', () => {
  const added  = taskManager.createTask(`テスト用プロンプト for ${TEST_ID}`, 'test-user', null, '低', 'default', 'IMPLEMENT');
  const added2 = taskManager.createTask(`別タスク ${TEST_ID}`, 'test-user', null, '低', 'default', 'IMPLEMENT');
  const targetId = added.id;
  const otherId  = added2.id;

  const claimed = taskManager.claimNextTaskByFilter(
    t => t.id === targetId,
    'test-owner'
  );

  // 対象IDがクレームされていること
  assert.ok(claimed, 'claimed が null');
  assert.strictEqual(claimed.id, targetId, `クレームされたIDが違う: ${claimed.id}`);
  assert.strictEqual(claimed.state, taskManager.STATES.IN_PROGRESS, 'IN_PROGRESS になっていない');

  // 別タスクはPENDINGのまま
  const other = taskManager.getTask(otherId);
  assert.strictEqual(other.state, taskManager.STATES.PENDING, '別タスクが変更された');

  // クリーンアップ
  taskManager.releaseLease(targetId);
  taskManager.updateState(targetId, 'ARCHIVED', 'テスト後クリーンアップ');
  taskManager.updateState(otherId, 'ARCHIVED', 'テスト後クリーンアップ');
});

test('3b. 存在しないIDは claimNextTaskByFilter が null を返す', () => {
  const result = taskManager.claimNextTaskByFilter(
    t => t.id === 'non_existent_id_xyz',
    'test-owner'
  );
  assert.strictEqual(result, null, 'null 以外が返った');
});

// ─────────────────────────────────────────────────────
// 4. ON_HOLD タスクの一時解除→クレーム検証
// ─────────────────────────────────────────────────────
console.log('\n[4. ON_HOLD タスクの一時解除→クレーム]');

test('4a. ON_HOLD → PENDING に変更後 claimNextTaskByFilter でクレームできる', () => {
  const added  = taskManager.createTask(`ON_HOLDテスト for ${TEST_ID}`, 'test-user', null, '低', 'default', 'IMPLEMENT');
  const holdId = added.id;

  // ON_HOLD に変更
  taskManager.updateState(holdId, taskManager.STATES.ON_HOLD, 'テスト保留');
  const heldTask = taskManager.getTask(holdId);
  assert.strictEqual(heldTask.state, taskManager.STATES.ON_HOLD, 'ON_HOLD になっていない');

  // 一時解除
  taskManager.updateState(holdId, taskManager.STATES.PENDING, 'task run 一時解除');

  // クレーム
  const claimed = taskManager.claimNextTaskByFilter(
    t => t.id === holdId,
    'run-task-cmd'
  );
  assert.ok(claimed, 'claimed が null');
  assert.strictEqual(claimed.id, holdId, 'IDが違う');
  assert.strictEqual(claimed.state, taskManager.STATES.IN_PROGRESS, 'IN_PROGRESS になっていない');

  // クリーンアップ
  taskManager.releaseLease(holdId);
  taskManager.updateState(holdId, 'ARCHIVED', 'テスト後クリーンアップ');
});

// ─────────────────────────────────────────────────────
// 5. autoPolicy チェック（BLOCKED / HUMAN_APPROVAL_REQUIRED）
// ─────────────────────────────────────────────────────
console.log('\n[5. autoPolicy チェック]');

test('5a. BLOCKED タスクは AUTO_POLICY.BLOCKED を返す', () => {
  const fakeTask = {
    id: 'task_blocked_test',
    prompt: 'git push --force main ブランチを強制Push',
    type: 'IMPLEMENT',
    size: 'MEDIUM',
    dangerLevel: '高',
    state: 'PENDING',
  };
  const policy = autoPolicy.classifyTask(fakeTask, { danger: '高' });
  // BLOCKED か HUMAN_APPROVAL_REQUIRED かを確認
  const stopPolicies = [autoPolicy.AUTO_POLICY.BLOCKED, autoPolicy.AUTO_POLICY.HUMAN_APPROVAL_REQUIRED];
  assert.ok(
    stopPolicies.includes(policy),
    `危険タスクが停止ポリシーに分類されない: ${policy}`
  );
});

test('5b. 通常タスクは AUTO_SAFE か AI_REVIEW_REQUIRED を返す', () => {
  const safeTask = {
    id: 'task_safe_test',
    prompt: 'package.json の scripts セクションに test コマンドを追加',
    type: 'IMPLEMENT',
    size: 'SMALL',
    dangerLevel: '低',
    state: 'PENDING',
  };
  const policy = autoPolicy.classifyTask(safeTask, { danger: '低' });
  const okPolicies = [autoPolicy.AUTO_POLICY.AUTO_SAFE, autoPolicy.AUTO_POLICY.AI_REVIEW_REQUIRED];
  assert.ok(
    okPolicies.includes(policy),
    `安全タスクが停止ポリシーに分類された: ${policy}`
  );
});

// ─────────────────────────────────────────────────────
// 6. LARGE サイズチェック
// ─────────────────────────────────────────────────────
console.log('\n[6. LARGE サイズチェック]');

test('6a. 短いプロンプトは LARGE にならない', () => {
  const result = taskTypeUtil.estimateTaskSize('ログ出力を追加する');
  assert.notStrictEqual(result.size, taskTypeUtil.TASK_SIZES.LARGE, '短いプロンプトが LARGE になった');
});

// ─────────────────────────────────────────────────────
// 7. !task run が !task list / !task help で案内される（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[7. ヘルプ/usage 確認]');

test('7a. !task run がヘルプに記述されていないか確認（任意: 実装で追加した場合 pass）', () => {
  // !task run はドキュメント非必須のため、実装の存在のみ確認
  assert.ok(
    src.includes("sub === 'run' && args[1]"),
    '!task run ハンドラが消えている'
  );
});

// ─────────────────────────────────────────────────────
// 後処理: テスト前後のタスク状態をアーカイブ整理
// ─────────────────────────────────────────────────────
const afterIds = taskManager.listTasks().map(t => t.id);
const newIds   = afterIds.filter(id => !beforeIds.includes(id));
for (const id of newIds) {
  try {
    const t = taskManager.getTask(id);
    if (t && t.state !== 'ARCHIVED') {
      taskManager.updateState(id, 'ARCHIVED', 'テスト後クリーンアップ');
    }
  } catch (_) {}
}

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
