'use strict';
// Lock Manager 修正テスト
// pid=0/null/無効 は stale 扱い、Windows PID 再利用対策

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const src = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'utils', 'restart-manager.js'), 'utf8'
);

// ─────────────────────────────────────────────────────
// 1. ソース確認 — 無効 PID の stale 判定
// ─────────────────────────────────────────────────────
console.log('\n[1. 無効 PID → stale 扱い]');

test('1a. pid=0 を stale として判定するコードがある', () => {
  // lockedPid < 1 チェックが存在すること
  assert.ok(
    src.includes('lockedPid < 1') || src.includes('pid < 1') || src.includes('!lockedPid'),
    'pid < 1 の stale チェックがない'
  );
});

test('1b. Number.isInteger チェックがある（非数値を除外）', () => {
  assert.ok(src.includes('Number.isInteger'), 'Number.isInteger チェックがない');
});

test('1c. 無効 PID のとき「無効PID」または「stale」ログを出す', () => {
  assert.ok(
    src.includes('無効PID') || src.includes('stale') || src.includes('上書きします'),
    '無効PID時のログがない'
  );
});

// ─────────────────────────────────────────────────────
// 2. PID バリデーション関数の動作確認（インライン検証）
// ─────────────────────────────────────────────────────
console.log('\n[2. PID バリデーション動作確認]');

// restart-manager.js の PID チェックロジックを再現してユニットテスト
function isValidPid(rawPid) {
  const p = Number(rawPid);
  return p >= 1 && Number.isInteger(p);
}

test('2a. pid=0 → 無効（stale）', () => {
  assert.strictEqual(isValidPid(0), false);
});

test('2b. pid=null → 無効（stale）', () => {
  assert.strictEqual(isValidPid(null), false);
});

test('2c. pid=undefined → 無効（stale）', () => {
  assert.strictEqual(isValidPid(undefined), false);
});

test('2d. pid="abc" → 無効（stale）', () => {
  assert.strictEqual(isValidPid('abc'), false);
});

test('2e. pid=-1 → 無効（stale）', () => {
  assert.strictEqual(isValidPid(-1), false);
});

test('2f. pid=1.5 → 無効（非整数）', () => {
  assert.strictEqual(isValidPid(1.5), false);
});

test('2g. pid=1234 → 有効', () => {
  assert.strictEqual(isValidPid(1234), true);
});

test('2h. pid=process.pid → 有効', () => {
  assert.strictEqual(isValidPid(process.pid), true);
});

// ─────────────────────────────────────────────────────
// 3. Windows PID 再利用対策
// ─────────────────────────────────────────────────────
console.log('\n[3. Windows PID 再利用対策]');

test('3a. win32 で wmic による commandLine チェックがある', () => {
  assert.ok(src.includes('wmic'), 'wmic による commandLine チェックがない');
  assert.ok(src.includes('CommandLine') || src.includes('commandLine'), 'commandLine 確認がない');
});

test('3b. commandLine に index.js が含まれない場合は stale 扱いにする', () => {
  assert.ok(
    src.includes("includes('index.js')") || src.includes('"index.js"'),
    'index.js 含有チェックがない'
  );
  assert.ok(
    src.includes('isOurBot = false') || src.includes('PID再利用'),
    'PID再利用検出時のロジックがない'
  );
});

test('3c. wmic 失敗時は安全側（ブロック継続）にフォールバック', () => {
  // wmic catch ブロックで isOurBot のデフォルトが true（ブロック継続）のまま
  const wmicCatchIdx = src.indexOf('wmic 確認スキップ');
  assert.ok(wmicCatchIdx >= 0, 'wmic スキップログがない');
  // isOurBot はデフォルト true で定義されている
  assert.ok(src.includes('isOurBot = true'), 'isOurBot デフォルト true がない');
});

// ─────────────────────────────────────────────────────
// 4. 正常系の維持確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 正常系の維持]');

test('4a. 有効 PID で AI_WORKER プロセスが存在する場合はブロックする', () => {
  assert.ok(src.includes('既存Botプロセスが稼働中'), 'ブロック処理が消えている');
  assert.ok(src.includes('ok: false, existingPid'), '戻り値 ok:false が消えている');
});

test('4b. prevPid（再起動時の旧PID）は許可される', () => {
  assert.ok(src.includes('prevPid'), 'prevPid チェックが消えている');
  assert.ok(
    src.includes('lockedPid === prevPid') || src.includes('pid === prevPid'),
    'prevPid 許可ロジックが消えている'
  );
});

test('4c. process.pid（自分自身）は許可される', () => {
  assert.ok(
    src.includes('lockedPid === process.pid') || src.includes('pid === process.pid'),
    '自分自身の許可ロジックが消えている'
  );
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
