'use strict';
// Phase E-4: Failure Recovery テスト

const assert = require('assert');
const tm     = require('../bot/utils/task-manager');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
const CLEANUP_IDS = [];
const pid = 'youtube予測ai';

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function info(msg) { console.log('  ℹ️ ', msg); }

function cleanup() {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_IDS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// 1. classifyErrorType — 分類テスト
// ─────────────────────────────────────────────────────
console.log('\n[1. classifyErrorType 分類]');

test('1a. タイムアウトメッセージ → TIMEOUT', () => {
  assert.strictEqual(tm.classifyErrorType('⏱️ タイムアウト: 5分以内に完了しませんでした'), 'TIMEOUT');
});
test('1b. timeout英語 → TIMEOUT', () => {
  assert.strictEqual(tm.classifyErrorType('Operation timed out after 300s'), 'TIMEOUT');
});
test('1c. unauthorized → AUTH', () => {
  assert.strictEqual(tm.classifyErrorType('unauthorized access to API'), 'AUTH');
});
test('1d. API key invalid → AUTH', () => {
  assert.strictEqual(tm.classifyErrorType('Invalid api key provided'), 'AUTH');
});
test('1e. permission denied → PERMISSION', () => {
  assert.strictEqual(tm.classifyErrorType('permission denied: cannot write file'), 'PERMISSION');
});
test('1f. EACCES → PERMISSION', () => {
  assert.strictEqual(tm.classifyErrorType('Error: EACCES: permission denied, open /etc/passwd'), 'PERMISSION');
});
test('1g. SyntaxError → SYNTAX', () => {
  assert.strictEqual(tm.classifyErrorType('SyntaxError: Unexpected token < in JSON'), 'SYNTAX');
});
test('1h. parse error → SYNTAX', () => {
  assert.strictEqual(tm.classifyErrorType('parse error: invalid JSON'), 'SYNTAX');
});
test('1i. 不明なエラー → UNKNOWN', () => {
  assert.strictEqual(tm.classifyErrorType('Something went wrong unexpectedly'), 'UNKNOWN');
});
test('1j. null → UNKNOWN（クラッシュしない）', () => {
  assert.strictEqual(tm.classifyErrorType(null), 'UNKNOWN');
});
test('1k. 空文字 → UNKNOWN', () => {
  assert.strictEqual(tm.classifyErrorType(''), 'UNKNOWN');
});

// ─────────────────────────────────────────────────────
// 2. setTaskError — タスクへの保存テスト
// ─────────────────────────────────────────────────────
console.log('\n[2. setTaskError 保存]');

const t2 = tm.createTask('[E4-test] エラーテスト用', 'e4-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t2.id);

test('2a. タイムアウトエラーを保存 → errorType=TIMEOUT', () => {
  const result = tm.setTaskError(t2.id, '⏱️ タイムアウト: 5分以内に完了しませんでした');
  assert.strictEqual(result.errorType, 'TIMEOUT');
  assert.ok(result.lastError.includes('タイムアウト'));
});

test('2b. tasks.json から読み直しても errorType が保持される', () => {
  const reloaded = tm.listTasks().find(t => t.id === t2.id);
  assert.strictEqual(reloaded.errorType, 'TIMEOUT');
  assert.ok(reloaded.lastError.length > 0);
  info('lastError: ' + reloaded.lastError.slice(0, 50));
});

test('2c. lastError は 300 文字でスライスされる', () => {
  const longMsg = 'A'.repeat(500);
  tm.setTaskError(t2.id, longMsg);
  const reloaded = tm.listTasks().find(t => t.id === t2.id);
  assert.ok(reloaded.lastError.length <= 300, `length=${reloaded.lastError.length}`);
});

test('2d. PERMISSION エラーも正しく保存される', () => {
  tm.setTaskError(t2.id, 'Error: EACCES: permission denied, open /var/log/app.log');
  const reloaded = tm.listTasks().find(t => t.id === t2.id);
  assert.strictEqual(reloaded.errorType, 'PERMISSION');
});

// ─────────────────────────────────────────────────────
// 3. createTask で lastError/errorType が初期値 null
// ─────────────────────────────────────────────────────
console.log('\n[3. 新規タスクの初期値]');

const t3 = tm.createTask('[E4-test] 初期値確認', 'e4-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(t3.id);

test('3a. 新規タスクの lastError は null', () => {
  assert.strictEqual(t3.lastError, null);
});
test('3b. 新規タスクの errorType は null', () => {
  assert.strictEqual(t3.errorType, null);
});

// ─────────────────────────────────────────────────────
// 4. errorType 分類優先順位（複数パターン混在）
// ─────────────────────────────────────────────────────
console.log('\n[4. 分類優先順位]');

test('4a. "タイムアウト" + "permission" が混在 → TIMEOUT 優先', () => {
  // 先頭のパターンが優先される（TIMEOUT が最初）
  const et = tm.classifyErrorType('⏱️ タイムアウト: permission denied');
  assert.strictEqual(et, 'TIMEOUT');
});

// ─────────────────────────────────────────────────────
// 5. index.js に classifyErrorType / setTaskError 呼び出しがある
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

test('5a. index.js に classifyErrorType の呼び出しがある', () =>
  assert.ok(src.includes('classifyErrorType'), 'classifyErrorType 呼び出しなし'));
test('5b. index.js に setTaskError の呼び出しがある', () =>
  assert.ok(src.includes('setTaskError'), 'setTaskError 呼び出しなし'));
test('5c. index.js に errorType がembed表示されている', () =>
  assert.ok(src.includes('errorTypeEmoji') && src.includes('エラー種別'), 'embed表示なし'));

// ─────────────────────────────────────────────────────
// 6. C1 Secret Masking — トークン類がマスクされる
// ─────────────────────────────────────────────────────
console.log('\n[6. Secret Masking]');

const tSec = tm.createTask('[E4-test] Secret Masking確認', 'e4-test', null, '低', pid, 'IMPLEMENT');
CLEANUP_IDS.push(tSec.id);

test('6a. ghp_ トークンを含むエラーはマスクされて保存される', () => {
  const errMsg = 'Authorization: Bearer ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX failed';
  tm.setTaskError(tSec.id, errMsg);
  const reloaded = tm.listTasks().find(t => t.id === tSec.id);
  assert.ok(!reloaded.lastError.includes('ghp_X'), 'ghp_ トークンが漏洩している');
  assert.ok(reloaded.lastError.includes('[MASKED]'), 'マスク文字列がない');
  info('6a maskedError: ' + reloaded.lastError.slice(0, 80));
});

test('6b. Authorization: Basic を含むエラーはマスクされる', () => {
  const errMsg = 'http.extraheader="Authorization: Basic dXNlcjpnaHBfWFhY" push failed';
  tm.setTaskError(tSec.id, errMsg);
  const reloaded = tm.listTasks().find(t => t.id === tSec.id);
  assert.ok(!reloaded.lastError.match(/Basic [A-Za-z0-9+/=]{8,}/), 'Basic トークンが漏洩している');
  info('6b masked: ' + reloaded.lastError.slice(0, 80));
});

test('6c. 通常エラーメッセージはマスクされない（情報が消えない）', () => {
  tm.setTaskError(tSec.id, 'タイムアウト: 5分以内に完了しませんでした');
  const reloaded = tm.listTasks().find(t => t.id === tSec.id);
  assert.ok(reloaded.lastError.includes('タイムアウト'), '通常メッセージが消えた');
});

// ─────────────────────────────────────────────────────
// 7. C1 DONE ガード — DONEタスクは更新しない
// ─────────────────────────────────────────────────────
console.log('\n[7. DONE ガード]');

const tDone = tm.createTask('[E4-test] DONEガード確認', 'e4-test', null, '低', pid, 'IMPLEMENT');
// アーカイブされるので CLEANUP_IDS に追加しない（DONE後はtasks.jsonから消える）
tm.updateState(tDone.id, tm.STATES.DONE, 'テスト完了');

test('7a. DONEタスクに setTaskError を呼んでもクラッシュしない', () => {
  // DONEになったタスクはtasks.jsonから消えているため null が返る
  const result = tm.setTaskError(tDone.id, 'some error');
  // null（タスクが見つからない）か、変更なしのどちらでも OK
  assert.ok(result === null || typeof result === 'object', 'クラッシュした');
  info('7a: DONE task setTaskError result=' + (result === null ? 'null' : 'object'));
});

test('7b. 現在DONEタスクが setTaskError で更新されていない（archive 汚染なし）', () => {
  // DONE後はtasks.jsonから消えているので getTask が null を返す
  const found = tm.listTasks().find(t => t.id === tDone.id);
  assert.strictEqual(found, undefined, 'DONEタスクがまだtasks.jsonにある');
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
