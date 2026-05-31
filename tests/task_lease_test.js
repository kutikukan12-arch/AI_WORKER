'use strict';
// Phase E-5a: Task Lease テスト

const assert = require('assert');
const tm     = require('../bot/utils/task-manager');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
const CLEANUP_IDS = [];
// 他タスクとの競合を避けるために専用プロジェクトIDを使用
const pid = 'e5a-lease-test';

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function info(msg) { console.log('  ℹ️ ', msg); }

function cleanup() {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  // テスト専用 PID のタスクを全て削除（前回実行のゴミも含む）
  raw.tasks   = raw.tasks.filter(t => t.projectId !== pid && !CLEANUP_IDS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
}

// テスト開始前に専用プロジェクトの残タスクをクリーンアップ
cleanup();

// ─────────────────────────────────────────────────────
// 1. 新規タスクの初期値
// ─────────────────────────────────────────────────────
console.log('\n[1. 新規タスクの初期値]');

const t1 = tm.createTask('[E5a-test] 初期値確認', 'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t1.id);

test('1a. leaseOwner が null', () => assert.strictEqual(t1.leaseOwner, null));
test('1b. leaseExpiresAt が null', () => assert.strictEqual(t1.leaseExpiresAt, null));

// ─────────────────────────────────────────────────────
// 2. claimNextTask: 原子的 claim と二重 claim 防止
// ─────────────────────────────────────────────────────
console.log('\n[2. claimNextTask]');

const t2a = tm.createTask('[E5a-test] claim テスト A', 'e5a-test', null, '低', pid, 'IMPLEMENT');
const t2b = tm.createTask('[E5a-test] claim テスト B', 'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t2a.id, t2b.id);

test('2a. claimNextTask がこのプロジェクトの PENDING タスクを返す', () => {
  const claimed = tm.claimNextTask(pid, 'test-owner-1');
  // このテスト専用プロジェクトのタスク（t1/t2a/t2b のいずれか）が返る
  assert.ok(claimed, 'claimed is null');
  assert.ok(CLEANUP_IDS.includes(claimed.id), `unexpected id: ${claimed.id}`);
  info('claimed: ' + claimed.id);
});

test('2b. claim 後 state が IN_PROGRESS になる', () => {
  const all = tm.listTasks();
  const inProgress = all.filter(t => CLEANUP_IDS.includes(t.id) && t.state === tm.STATES.IN_PROGRESS);
  assert.ok(inProgress.length >= 1, 'IN_PROGRESS タスクが見つからない');
});

test('2c. leaseOwner と leaseExpiresAt が設定される', () => {
  const claimed = tm.listTasks().find(t => CLEANUP_IDS.includes(t.id) && t.state === tm.STATES.IN_PROGRESS);
  assert.ok(claimed, 'IN_PROGRESS タスクなし');
  assert.strictEqual(claimed.leaseOwner, 'test-owner-1');
  assert.ok(claimed.leaseExpiresAt, 'leaseExpiresAt が未設定');
  assert.ok(new Date(claimed.leaseExpiresAt) > new Date(), 'leaseExpiresAt が過去になっている');
  info('leaseOwner: ' + claimed.leaseOwner + ' | expires: ' + claimed.leaseExpiresAt);
});

test('2d. 二重 claim 防止: IN_PROGRESS になったタスクは再 claim されない', () => {
  // 同じオーナーで再度 claim → 別のタスクが返るか null
  const second = tm.claimNextTask(pid, 'test-owner-2');
  if (second) {
    // 2件目のタスクが返った場合は t2a/t2b の別のほう
    assert.ok(CLEANUP_IDS.includes(second.id));
    const first = tm.listTasks().find(t => CLEANUP_IDS.includes(t.id) && t.state === tm.STATES.IN_PROGRESS && t.leaseOwner === 'test-owner-1');
    assert.ok(second.id !== first?.id, '同じタスクを二重 claim している');
    info('2件目 claimed: ' + second.id);
  } else {
    info('2件目: null（1件しか PENDING でなかった）');
  }
});

// ─────────────────────────────────────────────────────
// 3. releaseLease: release 往復
// ─────────────────────────────────────────────────────
console.log('\n[3. releaseLease]');

const t3 = tm.createTask('[E5a-test] release テスト', 'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t3.id);

test('3a. claim → release で PENDING に戻る', () => {
  const claimed  = tm.claimNextTask(pid, 'test-release');
  assert.ok(claimed, 'claim failed');
  const released = tm.releaseLease(claimed.id);
  assert.ok(released, 'release returned null');
  assert.strictEqual(released.state, tm.STATES.PENDING);
  assert.strictEqual(released.leaseOwner, null);
  assert.strictEqual(released.leaseExpiresAt, null);
  info('release: ' + claimed.id + ' → ' + released.state);
});

test('3b. release 後に再 claim できる', () => {
  const reclaimed = tm.claimNextTask(pid, 'test-reclaim');
  assert.ok(reclaimed, '再 claim が null');
  info('reclaimed: ' + reclaimed.id);
  tm.releaseLease(reclaimed.id); // 後処理
});

// ─────────────────────────────────────────────────────
// 4. DONE / ON_HOLD 遷移で lease が解除される
// ─────────────────────────────────────────────────────
console.log('\n[4. 状態遷移時の lease 解除]');

const t4a = tm.createTask('[E5a-test] DONE解除', 'e5a-test', null, '低', pid, 'IMPLEMENT');
const t4b = tm.createTask('[E5a-test] HOLD解除', 'e5a-test', null, '低', pid, 'IMPLEMENT');
// DONEはアーカイブされるので CLEANUP_IDS には追加しない
CLEANUP_IDS.push(t4b.id);

test('4a. DONE 遷移で lease が解除される（アーカイブ後は null）', () => {
  const claimed = tm.claimNextTask(pid, 'test-done');
  assert.ok(claimed, 'claim failed');
  tm.updateState(claimed.id, tm.STATES.DONE, 'test done');
  // DONE 後はアーカイブされてタスクは消える
  const found = tm.listTasks().find(t => t.id === claimed.id);
  assert.strictEqual(found, undefined, 'DONE後もtasks.jsonに残っている');
});

test('4b. ON_HOLD 遷移で lease が解除される', () => {
  const claimed = tm.claimNextTask(pid, 'test-hold');
  assert.ok(claimed, 'claim failed');
  tm.updateState(claimed.id, tm.STATES.ON_HOLD, 'test hold');
  const held = tm.listTasks().find(t => t.id === claimed.id);
  assert.ok(held, 'ON_HOLD後タスクが消えている');
  assert.strictEqual(held.state, tm.STATES.ON_HOLD);
  assert.strictEqual(held.leaseOwner, null, 'leaseOwner が残っている');
  assert.strictEqual(held.leaseExpiresAt, null, 'leaseExpiresAt が残っている');
});

// ─────────────────────────────────────────────────────
// 5. 後方互換: leaseOwner 未設定の既存タスクも動作
// ─────────────────────────────────────────────────────
console.log('\n[5. 後方互換]');

test('5a. leaseOwner がない既存タスクも claimNextTask で取得できる', () => {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  const legacyId = 'task_legacy_e5a_test';
  // leaseOwner フィールドなし（旧タスク形式）
  raw.tasks.push({
    id: legacyId, type: 'IMPLEMENT', size: 'SMALL',
    projectId: pid, prompt: '[E5a-legacy] 後方互換テスト',
    state: tm.STATES.PENDING, priority: '低', priorityReason: 'test',
    dangerLevel: '低', assignee: 'test', requestedBy: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stateHistory: [{ state: tm.STATES.PENDING, at: new Date().toISOString(), note: '作成' }],
    reviewResult: null, codexResult: null, prUrl: null, notes: '',
    // leaseOwner / leaseExpiresAt フィールドなし（旧形式）
  });
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  CLEANUP_IDS.push(legacyId);

  const claimed = tm.claimNextTask(pid, 'legacy-test');
  assert.ok(claimed, '旧タスクが claim できなかった');
  assert.ok(claimed.id, 'id が未設定');
  info('5a legacy claimed: ' + claimed.id);
  tm.releaseLease(claimed.id); // 後処理
});

test('5b. releaseLease を leaseOwner なしのタスクに呼んでもクラッシュしない', () => {
  const t5b = tm.createTask('[E5a-test] no-lease release', 'e5a-test', null, '低', pid, 'IMPLEMENT');
  CLEANUP_IDS.push(t5b.id);
  // claim せずに直接 release
  const result = tm.releaseLease(t5b.id);
  assert.ok(result !== undefined, 'クラッシュした');
});

// ─────────────────────────────────────────────────────
// 6. index.js ソース確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const prepStart = src.indexOf('async function prepareNextTask');
const prepEnd   = src.indexOf('\nasync function ', prepStart + 1);
const prepBody  = src.slice(prepStart, prepEnd);

test('6a. prepareNextTask が claimNextTask を使っている', () =>
  assert.ok(prepBody.includes('claimNextTask'), 'claimNextTask が見つからない'));

test('6b. security blocked で releaseLease が呼ばれる', () => {
  const secIdx     = prepBody.indexOf('sec.safe');
  const releaseIdx = prepBody.indexOf('releaseLease', secIdx);
  assert.ok(releaseIdx > secIdx && releaseIdx < secIdx + 500, 'securityブロック後のreleaseLease が見つからない');
});

test('6c. danger blocked で releaseLease が呼ばれる', () => {
  const dangerIdx  = prepBody.indexOf('preDanger');
  const releaseIdx = prepBody.indexOf('releaseLease', dangerIdx);
  assert.ok(releaseIdx > dangerIdx && releaseIdx < dangerIdx + 600, 'dangerブロック後のreleaseLease が見つからない');
});

test('6d. LARGE blocked で releaseLease が呼ばれる', () => {
  const largeIdx   = prepBody.indexOf('TASK_SIZES.LARGE');
  const releaseIdx = prepBody.indexOf('releaseLease', largeIdx);
  assert.ok(releaseIdx > largeIdx && releaseIdx < largeIdx + 400, 'LARGEブロック後のreleaseLease が見つからない');
});

// ─────────────────────────────────────────────────────
// 7. 優先度順 claim
// ─────────────────────────────────────────────────────
console.log('\n[7. 優先度順 claim]');

// cleanup して専用プロジェクトを空にしてからテスト
cleanup();

// 明示的に priority を設定したタスクを作成
const tHighBase = tm.createTask('[E5a-test] high-priority', 'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(tHighBase.id);
tm.updateTask(tHighBase.id, { priority: '高' }); // priority を強制設定

const tLowBase = tm.createTask('[E5a-test] low-priority', 'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(tLowBase.id);
// tLowBase は 低 のまま

test('7a. high > low: 高優先度タスクが先に claim される', () => {
  const claimed = tm.claimNextTask(pid, 'priority-test');
  assert.ok(claimed, 'claimed is null');
  assert.strictEqual(claimed.id, tHighBase.id,
    `高優先度 (${tHighBase.id}) が先のはず。実際: ${claimed.id}`);
  info('7a: claimed=' + claimed.id + ' priority=' + claimed.priority);
  tm.releaseLease(claimed.id);
});

const tSameA = tm.createTask('[E5a-test] same-priority-A', 'e5a-test', null, '低', pid, 'IMPLEMENT');
const tSameB = tm.createTask('[E5a-test] same-priority-B', 'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(tSameA.id, tSameB.id);
tm.updateTask(tSameA.id, { priority: '中' });
tm.updateTask(tSameB.id, { priority: '中' });

test('7b. 同優先度: どちらか一方が claim される（クラッシュしない）', () => {
  // 7a で tHighBase をリリース済み。tHighBase(高) / tSameA(中) / tSameB(中) / tLowBase(低) がある
  const claimed = tm.claimNextTask(pid, 'same-priority-test');
  assert.ok(claimed, 'claimed is null');
  // tHighBase(高) が返るはず
  assert.strictEqual(claimed.id, tHighBase.id);
  info('7b: claimed=' + claimed.id + ' priority=' + claimed.priority);
  tm.releaseLease(claimed.id);
});

// ─────────────────────────────────────────────────────
// 8. leaseOwner あり（有効期限内）はスキップ
// ─────────────────────────────────────────────────────
console.log('\n[8. leaseOwner ありタスクのスキップ]');

// 残タスクを全部解放してクリーンにする
cleanup();
CLEANUP_IDS.length = 0; // CLEANUP_IDS をリセット

const tLeased = tm.createTask('[E5a-test] leased-first', 'e5a-test', null, '低', pid, 'IMPLEMENT');
const tFree   = tm.createTask('[E5a-test] free-second',  'e5a-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(tLeased.id, tFree.id);
// tLeased を高優先度にして claim 順を確定
tm.updateTask(tLeased.id, { priority: '高' });

test('8a. lease 済みタスクは別オーナーに claim されない（有効期限内）', () => {
  // owner-first が tLeased を claim
  const first = tm.claimNextTask(pid, 'owner-first');
  assert.ok(first, 'first claim failed');
  assert.strictEqual(first.id, tLeased.id, `高優先度 tLeased が先のはず。実際: ${first.id}`);

  // tLeased は IN_PROGRESS（有効期限内）→ second claim では tFree が返る
  const second = tm.claimNextTask(pid, 'owner-second');
  assert.ok(second, 'second claim failed (tFree should be available)');
  assert.strictEqual(second.id, tFree.id, `tFree が返るはず。実際: ${second.id}`);
  assert.notStrictEqual(second.id, tLeased.id, 'lease済みタスクが二重 claim されている');
  info('8a: first=' + first.id + ' second=' + second.id);

  tm.releaseLease(first.id);
  tm.releaseLease(second.id);
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
