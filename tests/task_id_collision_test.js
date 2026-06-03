'use strict';
// Task ID 衝突修正テスト
// 優先1: ID生成改善 (timestamp+suffix+uniqueCheck) + 衝突検出・修正の検証

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const tm      = require('../bot/utils/task-manager');
const tmSrc   = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'utils', 'task-manager.js'), 'utf8'
);
const TASKS_FILE = path.join(__dirname, '..', 'data', 'tasks.json');

// ─────────────────────────────────────────────────────
// テスト前クリーンアップ: 過去の衝突テスト用エントリを除去
// ─────────────────────────────────────────────────────
(function setupClean() {
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    const arr = (raw.tasks || []).filter(t => !t.id.startsWith('task_test_collision_'));
    fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: arr }, null, 2));
  } catch { /* 初回起動時など */ }
})();

// テスト用ID記録
const createdIds = [];
function cleanup() {
  for (const id of createdIds) {
    try {
      const t = tm.getTask(id);
      if (t && t.state !== 'ARCHIVED') {
        tm.updateState(id, 'ARCHIVED', 'テスト後クリーンアップ');
      }
    } catch { /* ignore */ }
  }
  // tasks.json から衝突テスト用エントリを除去
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    const arr = (raw.tasks || []).filter(t => !t.id.startsWith('task_test_collision_'));
    fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: arr }, null, 2));
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// 1. 衝突検出: 同一IDが2件存在するシナリオの検証
// ─────────────────────────────────────────────────────
console.log('\n[1. 衝突検出シナリオ検証]');

test('1a. 重複 ID を直接注入すると listTasks で検出できる', () => {
  // 直接 JSON を操作して同一IDを持つ2エントリを作る
  const raw    = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  const arr    = raw.tasks || [];
  const dupId  = `task_test_collision_${Date.now()}`;
  const now    = new Date().toISOString();
  const mkEntry = (type, prompt) => ({
    id: dupId, type, state: '保留', prompt, createdAt: now, updatedAt: now,
    priority: '低', dangerLevel: '低', projectId: 'test',
    stateHistory: [{ state: '保留', at: now, note: 'テスト' }],
  });
  arr.push(mkEntry('DOCS', 'DOCS 衝突テスト'));
  arr.push(mkEntry('TEST', 'TEST 衝突テスト'));
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: arr }, null, 2));

  const all  = tm.listTasks();
  const dups = all.filter(t => t.id === dupId);
  assert.strictEqual(dups.length, 2, `重複が検出されない: ${dups.length}件`);

  // TEST 側を新IDで上書き（衝突修正シミュレーション）
  const newId  = `task_${Date.now()}fixed`;
  const rawFix = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  const arrFix = rawFix.tasks || [];
  let seenDup  = false;
  for (const t of arrFix) {
    if (t.id === dupId) {
      if (!seenDup) { seenDup = true; continue; }
      t.id = newId; // TEST 側再ID
      createdIds.push(newId);
    }
  }
  // DOCS 側もクリーンアップのためにマーク
  for (const t of arrFix) {
    if (t.id === dupId) { createdIds.push(t.id); break; }
  }
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: arrFix }, null, 2));

  const after = tm.listTasks();
  const afterDups = after.filter(t => t.id === dupId);
  assert.strictEqual(afterDups.length, 1, `修正後も重複: ${afterDups.length}件`);
});

test('1b. 現在の tasks.json に ID 重複がない', () => {
  const all = tm.listTasks();
  const ids = all.map(t => t.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual(dup, [], `重複ID: ${dup.join(', ')}`);
});

// ─────────────────────────────────────────────────────
// 2. _generateTaskId: 新しいID生成ロジック
// ─────────────────────────────────────────────────────
console.log('\n[2. _generateTaskId — 新しいID生成]');

test('2a. createTask で生成された ID は task_ プレフィックスを持つ', () => {
  const t = tm.createTask('テストタスク _generateTaskId 確認', 'test-user');
  createdIds.push(t.id);
  assert.ok(t.id.startsWith('task_'), `task_ で始まらない: ${t.id}`);
});

test('2b. 新IDは Date.now() 単体より長い（timestamp + suffix 形式）', () => {
  const t = tm.createTask('新ID形式確認', 'test-user');
  createdIds.push(t.id);
  // Date.now() = "task_" + 13桁 = 18文字
  // 新形式 = "task_" + 13桁 + 3文字以上 = 21文字以上
  assert.ok(t.id.length > 18, `ID 長が短すぎる (${t.id.length}): ${t.id}`);
});

test('2c. 連続 10件 createTask で全て異なる ID が生成される', () => {
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const t = tm.createTask(`連続生成テスト ${i}`, 'test-user');
    createdIds.push(t.id);
    ids.push(t.id);
  }
  const unique = new Set(ids);
  assert.strictEqual(unique.size, ids.length, `連続生成で衝突: ${ids.join(', ')}`);
});

test('2d. 同一ミリ秒内でも衝突しない（高速連続生成）', () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const t = tm.createTask(`高速テスト ${i}`, 'test-user');
    createdIds.push(t.id);
    ids.push(t.id);
  }
  const unique = new Set(ids);
  assert.strictEqual(unique.size, ids.length, `衝突: ${ids.join(', ')}`);
});

// ─────────────────────────────────────────────────────
// 3. ソースコード確認: Date.now() 単体禁止
// ─────────────────────────────────────────────────────
console.log('\n[3. ソースコード確認]');

test('3a. createTask の id 生成に _generateTaskId を使っている', () => {
  const start = tmSrc.indexOf('function createTask(');
  const end   = tmSrc.indexOf('\nfunction ', start + 1);
  const body  = tmSrc.slice(start, end);
  assert.ok(body.includes('_generateTaskId'), 'createTask に _generateTaskId がない');
});

test('3b. _generateTaskId 関数が実装されている', () => {
  assert.ok(tmSrc.includes('function _generateTaskId'), '_generateTaskId 関数がない');
});

test('3c. _generateTaskId に既存IDとの重複チェックがある', () => {
  const start = tmSrc.indexOf('function _generateTaskId');
  const end   = tmSrc.indexOf('\nfunction ', start + 1);
  const body  = tmSrc.slice(start, end);
  assert.ok(body.includes('existingIds'), '既存ID集合チェックがない');
  assert.ok(body.includes('has(id)'),     '.has(id) による重複チェックがない');
});

test('3d. _generateTaskId が timestamp + 乱数suffix 方式', () => {
  const start = tmSrc.indexOf('function _generateTaskId');
  const end   = tmSrc.indexOf('\nfunction ', start + 1);
  const body  = tmSrc.slice(start, end);
  assert.ok(body.includes('Date.now()'),   'timestamp (Date.now()) がない');
  assert.ok(
    body.includes('Math.random()') || body.includes('toString(16)'),
    'suffix (乱数) がない'
  );
});

test('3e. mergeTasks も _generateTaskId を使っている', () => {
  const start = tmSrc.indexOf('function mergeTasks(');
  const end   = tmSrc.indexOf('\n// ', start + 200);
  const body  = end > start ? tmSrc.slice(start, end) : tmSrc.slice(start, start + 2000);
  assert.ok(body.includes('_generateTaskId'), 'mergeTasks に _generateTaskId がない');
  assert.ok(!body.includes('`task_${Date.now()}`'), 'mergeTasks に Date.now() 単体が残っている');
});

test('3f. createTask の body に Date.now() 単体のID生成がない', () => {
  const start = tmSrc.indexOf('function createTask(');
  const end   = tmSrc.indexOf('\nfunction ', start + 1);
  const body  = tmSrc.slice(start, end);
  assert.ok(!body.includes('`task_${Date.now()}`'), 'Date.now() 単体のID生成が残っている');
});

// ─────────────────────────────────────────────────────
// 4. 後方互換確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 後方互換確認]');

test('4a. taskId を明示指定した場合は指定IDが使われる', () => {
  const specifiedId = `task_${Date.now()}explicit`;
  const t = tm.createTask('明示ID指定テスト', 'test-user', specifiedId);
  createdIds.push(t.id);
  assert.strictEqual(t.id, specifiedId, `指定IDが使われていない: ${t.id}`);
});

test('4b. 新IDフォーマットでも getTask / updateState が正常動作する', () => {
  const t = tm.createTask('新ID互換性テスト', 'test-user');
  createdIds.push(t.id);
  // ID にサフィックスが含まれていても既存 API が壊れない
  assert.ok(t.id.length > 18);
  const retrieved = tm.getTask(t.id);
  assert.ok(retrieved, 'getTask で取得できない');
  tm.updateState(t.id, tm.STATES.ON_HOLD, '互換テスト');
  const updated = tm.getTask(t.id);
  assert.strictEqual(updated.state, tm.STATES.ON_HOLD);
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
