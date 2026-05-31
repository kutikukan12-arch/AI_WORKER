'use strict';

// completion-validator.js の OPS キーワード完了判定テスト
// 修正: IMPLEMENT type でも OPS キーワードが prompt に含まれれば完了扱い

const assert = require('assert');
const { validate, allowsNoCodeChange } = require('../bot/utils/completion-validator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ─── allowsNoCodeChange 単体テスト ───

console.log('\n[allowsNoCodeChange]');

test('RESEARCH type → true（無条件）', () => {
  assert.strictEqual(allowsNoCodeChange('RESEARCH', ''), true);
});

test('OPS type → true（無条件）', () => {
  assert.strictEqual(allowsNoCodeChange('OPS', ''), true);
});

test('IMPLEMENT type, prompt なし → false', () => {
  assert.strictEqual(allowsNoCodeChange('IMPLEMENT', ''), false);
});

test('IMPLEMENT type, prompt に "診断" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('IMPLEMENT', 'git statusを診断してください'), true);
});

test('IMPLEMENT type, prompt に "push" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('IMPLEMENT', 'git push してください'), true);
});

test('IMPLEMENT type, prompt に "status" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('IMPLEMENT', 'git status を確認して'), true);
});

test('IMPLEMENT type, prompt に "確認" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('IMPLEMENT', 'ブランチを確認してください'), true);
});

test('IMPLEMENT type, prompt に "調査" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('IMPLEMENT', 'エラーを調査してください'), true);
});

test('FIX type, prompt に "診断" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('FIX', '動作を診断してください'), true);
});

test('REFACTOR type, prompt に "push" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange('REFACTOR', 'push してから確認して'), true);
});

test('type 未設定（undefined）, prompt に "push" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange(undefined, 'git push してください'), true);
});

test('type 未設定（null）, prompt に "確認" → true（修正確認）', () => {
  assert.strictEqual(allowsNoCodeChange(null, 'ブランチを確認してください'), true);
});

test('FIX type, prompt なし → false（通常実装は差分必須）', () => {
  assert.strictEqual(allowsNoCodeChange('FIX', ''), false);
});

test('REFACTOR type, prompt なし → false（通常実装は差分必須）', () => {
  assert.strictEqual(allowsNoCodeChange('REFACTOR', ''), false);
});

// ─── validate 統合テスト（ファイル変更なし + OPS キーワード）───

console.log('\n[validate — OPS キーワードで変更0件でも完了扱い]');

const FAKE_REPO = __dirname; // tests/ ディレクトリ（git リポジトリ）

test('IMPLEMENT type, prompt に "診断", 出力あり → ok=true', () => {
  const result = validate(
    'git status を確認しました。クリーンな状態です。変更はありません。',
    FAKE_REPO,
    'task_test_001',
    [],          // passedFiles (空 = 変更なし)
    Date.now(),
    'IMPLEMENT',
    'git status を診断してください',
  );
  assert.strictEqual(result.ok, true, `ok が false: ${result.reason}`);
  assert.match(result.reason, /OPSタスク完了/);
});

test('IMPLEMENT type, prompt に "push", 出力あり → ok=true', () => {
  const result = validate(
    'push 完了しました。リモートブランチに反映されました。',
    FAKE_REPO,
    'task_test_002',
    [],
    Date.now(),
    'IMPLEMENT',
    'git push してください',
  );
  assert.strictEqual(result.ok, true, `ok が false: ${result.reason}`);
});

test('IMPLEMENT type, prompt に "push", 出力が短文（"OK" 2文字）→ ok=true', () => {
  const result = validate(
    'OK',
    FAKE_REPO,
    'task_test_003',
    [],
    Date.now(),
    'IMPLEMENT',
    'git push してください',
  );
  assert.strictEqual(result.ok, true, `ok が false: ${result.reason}`);
});

test('IMPLEMENT type, prompt に "push", 出力が空 → ok=true', () => {
  const result = validate(
    '',
    FAKE_REPO,
    'task_test_004',
    [],
    Date.now(),
    'IMPLEMENT',
    'git push してください',
  );
  assert.strictEqual(result.ok, true, `ok が false: ${result.reason}`);
});

test('IMPLEMENT type, OPS キーワードなし, 変更0件を明示（passedFiles=[], addedLines=0 相当）→ allowsNoCodeChange=false', () => {
  // allowsNoCodeChange の戻り値を直接検証（git 状態に依存しない）
  const result = allowsNoCodeChange('IMPLEMENT', 'バグを修正してください');
  assert.strictEqual(result, false, 'OPS キーワードなし IMPLEMENT は差分必須であるべき');
});

test('type 未設定, prompt に "確認", 変更0件 → ok=true', () => {
  const result = validate(
    'ブランチの状態を確認しました。master ブランチにいます。',
    FAKE_REPO,
    'task_test_006',
    [],
    Date.now(),
    undefined,
    'ブランチを確認してください',
  );
  assert.strictEqual(result.ok, true, `ok が false: ${result.reason}`);
});

// ─── 結果 ───

console.log(`\n結果: ${passed} passed / ${failed} failed\n`);
if (failed > 0) process.exit(1);
