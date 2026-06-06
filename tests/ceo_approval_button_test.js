'use strict';
// =======================================================
// ceo_approval_button_test.js — Approval Card ボタン権限テスト
//
// テスト条件:
//   CEO_USER_IDS未設定 → ボタン操作拒否（fail-closed）
//   CEO以外 → ボタン操作拒否
//   CEO → 承認可
//   「待機」ボタン → PENDING 維持（deny() を呼ばない）
//   詳細確認 → redact 適用パス確認
//   interactionCreate 権限チェックロジック確認
// =======================================================

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ─────────────────────────────────────────────────────
// [1] fail-closed 権限チェック（ceo-intent-router経由）
// ─────────────────────────────────────────────────────
console.log('\n[1. fail-closed 権限チェック]');

const cir = require('../bot/utils/ceo-intent-router');

test('1a. CEO_USER_IDS未設定 → getCEOUserIds()=[] → fail-closed で拒否', () => {
  const orig = process.env.CEO_USER_IDS;
  delete process.env.CEO_USER_IDS;

  const ceoids = cir.getCEOUserIds();
  // fail-closed条件: ceoids.length === 0 → 拒否
  const shouldReject = ceoids.length === 0 || !ceoids.includes('any-user');
  assert.strictEqual(shouldReject, true, 'CEO_USER_IDS未設定は全拒否（fail-closed）');

  process.env.CEO_USER_IDS = orig || '';
});

test('1b. CEO_USER_IDS空文字 → getCEOUserIds()=[] → 全拒否', () => {
  process.env.CEO_USER_IDS = '';
  const ceoids = cir.getCEOUserIds();
  const shouldReject = ceoids.length === 0 || !ceoids.includes('any-user');
  assert.strictEqual(shouldReject, true, '空文字は全拒否');
  delete process.env.CEO_USER_IDS;
});

test('1c. CEO以外のID → 拒否される', () => {
  process.env.CEO_USER_IDS = 'ceo-111,ceo-222';
  const ceoids = cir.getCEOUserIds();
  const userId = 'stranger-999';
  const shouldReject = ceoids.length === 0 || !ceoids.includes(userId);
  assert.strictEqual(shouldReject, true, 'CEO以外は拒否');
  delete process.env.CEO_USER_IDS;
});

test('1d. CEOのID → 通過する', () => {
  process.env.CEO_USER_IDS = 'ceo-111,ceo-222';
  const ceoids = cir.getCEOUserIds();
  const userId = 'ceo-111';
  const shouldReject = ceoids.length === 0 || !ceoids.includes(userId);
  assert.strictEqual(shouldReject, false, 'CEOは通過する');
  delete process.env.CEO_USER_IDS;
});

test('1e. fail-closed条件式が正しい（旧: fail-open条件式でないこと）', () => {
  // 旧の fail-open: ceoids.length > 0 && !ceoids.includes(userId)
  //   → CEO_USER_IDS未設定のとき length=0 → 条件false → 全員通過（danger!）
  // 新の fail-closed: ceoids.length === 0 || !ceoids.includes(userId)
  //   → CEO_USER_IDS未設定のとき length=0 → 条件true → 全員拒否（safe!）
  const orig = process.env.CEO_USER_IDS;
  delete process.env.CEO_USER_IDS;

  const ceoids = cir.getCEOUserIds();
  const anyUser = 'any-stranger';

  // 旧条件（fail-open）= false（誤って通過させる）
  const oldCondition = ceoids.length > 0 && !ceoids.includes(anyUser);
  // 新条件（fail-closed）= true（正しく拒否）
  const newCondition = ceoids.length === 0 || !ceoids.includes(anyUser);

  assert.strictEqual(oldCondition, false, '旧条件はfail-open（通過させてしまう）');
  assert.strictEqual(newCondition, true,  '新条件はfail-closed（正しく拒否）');

  process.env.CEO_USER_IDS = orig || '';
});

// ─────────────────────────────────────────────────────
// [2] 「待機」ボタン = PENDING 維持（deny() を呼ばない）
// ─────────────────────────────────────────────────────
console.log('\n[2. 待機ボタン = PENDING 維持]');

test('2a. bot/index.js の「待機」処理で approvalManager.deny が呼ばれていない', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  // interactionCreate ハンドラの deny ブロックを抽出
  const startIdx = content.indexOf("client.on('interactionCreate'");
  assert.ok(startIdx >= 0, 'interactionCreate ハンドラが見つかる');
  const endMarker = content.indexOf('\nclient.on(', startIdx + 10);
  const handlerCode = endMarker > 0 ? content.slice(startIdx, endMarker) : content.slice(startIdx, startIdx + 3000);

  // action === 'deny' のブロックに approvalManager.deny() の呼び出しがないこと
  const denyBlockMatch = handlerCode.match(/action === 'deny'[\s\S]+?(?=\} else if|catch)/);
  assert.ok(denyBlockMatch, 'deny ブロックが見つかる');

  const denyBlock = denyBlockMatch[0];
  assert.ok(!denyBlock.includes('approvalManager.deny('),
    `「待機」ブロックに approvalManager.deny() が残っている（DENIED に変更してしまう）:\n${denyBlock}`);
});

test('2b. 「待機」ブロックに ephemeral reply が含まれる', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  const startIdx = content.indexOf("client.on('interactionCreate'");
  assert.ok(startIdx >= 0, 'interactionCreate ハンドラが見つかる');
  const endMarker = content.indexOf('\nclient.on(', startIdx + 10);
  const handlerCode = endMarker > 0 ? content.slice(startIdx, endMarker) : content.slice(startIdx, startIdx + 3000);
  const denyBlockMatch = handlerCode.match(/action === 'deny'[\s\S]+?(?=\} else if|catch)/);
  assert.ok(denyBlockMatch, 'deny ブロックが見つかる');

  const denyBlock = denyBlockMatch[0];
  assert.ok(denyBlock.includes('ephemeral: true'),
    '「待機」ボタンは ephemeral で返信する（状態変更なし）');
  assert.ok(denyBlock.includes('承認待ちを継続'),
    '「待機」ボタンは「承認待ちを継続します」と返信する');
});

test('2c. 「待機」ブロックに interaction.update() が呼ばれていない（PENDING維持）', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  const startIdx = content.indexOf("client.on('interactionCreate'");
  assert.ok(startIdx >= 0, 'interactionCreate ハンドラが見つかる');
  const endMarker = content.indexOf('\nclient.on(', startIdx + 10);
  const handlerCode = endMarker > 0 ? content.slice(startIdx, endMarker) : content.slice(startIdx, startIdx + 3000);
  const denyBlockMatch = handlerCode.match(/action === 'deny'[\s\S]+?(?=\} else if|catch)/);
  assert.ok(denyBlockMatch, 'deny ブロックが見つかる');

  const denyBlock = denyBlockMatch[0];
  // interaction.update() はボタンのメッセージを更新してしまう（状態が変わったように見える）
  // 待機はPENDING維持なので、update ではなく reply (ephemeral) を使う
  assert.ok(!denyBlock.includes('interaction.update('),
    '「待機」は interaction.update() を呼ばない（状態変更に見えるので禁止）');
});

// ─────────────────────────────────────────────────────
// [3] detail ブロックに redact 適用
// ─────────────────────────────────────────────────────
console.log('\n[3. detail ブロック: redact 適用]');

test('3a. detail ブロックに guardDiscordContent または safePrompt が含まれる', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  const startIdx = content.indexOf("client.on('interactionCreate'");
  assert.ok(startIdx >= 0, 'interactionCreate ハンドラが見つかる');
  const endMarker = content.indexOf('\nclient.on(', startIdx + 10);
  const handlerCode = endMarker > 0 ? content.slice(startIdx, endMarker) : content.slice(startIdx, startIdx + 3000);
  const detailBlockMatch = handlerCode.match(/action === 'detail'[\s\S]+?(?=\}(\s*\n\s*\}|\s*catch))/);
  assert.ok(detailBlockMatch, 'detail ブロックが見つかる');

  const detailBlock = detailBlockMatch[0];
  const hasRedact = detailBlock.includes('guardDiscordContent') ||
                    detailBlock.includes('safePrompt')          ||
                    detailBlock.includes('secret-guardian');
  assert.ok(hasRedact,
    `detail ブロックに redact/guardDiscordContent が含まれていない:\n${detailBlock}`);
});

test('3b. detail ブロックで prompt を直接 slice するだけの旧実装が残っていない', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  const startIdx = content.indexOf("client.on('interactionCreate'");
  assert.ok(startIdx >= 0, 'interactionCreate ハンドラが見つかる');
  const endMarker = content.indexOf('\nclient.on(', startIdx + 10);
  const handlerCode = endMarker > 0 ? content.slice(startIdx, endMarker) : content.slice(startIdx, startIdx + 3000);
  const detailBlockMatch = handlerCode.match(/action === 'detail'[\s\S]+?(?=\}(\s*\n\s*\}|\s*catch))/);
  assert.ok(detailBlockMatch, 'detail ブロックが見つかる');

  const detailBlock = detailBlockMatch[0];
  // 旧実装: task?.prompt || '詳細なし').slice(0, 300) の一行のみ（redactなし）
  // safePrompt か redact を経由していることを確認
  const hasRawSliceOnly =
    detailBlock.includes("const prompt = (task?.prompt || '詳細なし').slice(0, 300)");
  assert.ok(!hasRawSliceOnly,
    '旧実装（redactなし）が残っている: redact適用が必要');
});

// ─────────────────────────────────────────────────────
// [4] bot/index.js 安全コード確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 安全コード確認]');

test('4a. interactionCreate に fail-closed 条件式が含まれる', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  // fail-closed 条件: ceoids.length === 0 || !ceoids.includes(user.id)
  assert.ok(content.includes('ceoids.length === 0 || !ceoids.includes(user.id)'),
    'fail-closed 条件式が bot/index.js に存在する');
});

test('4b. fail-open 条件式が interactionCreate に残っていない', () => {
  const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
  const content   = fs.readFileSync(indexPath, 'utf8');

  // 旧 fail-open: ceoids.length > 0 && !ceoids.includes(user.id)
  assert.ok(!content.includes('ceoids.length > 0 && !ceoids.includes(user.id)'),
    'fail-open 条件式が残っている（要修正）');
});

test('4c. getCEOUserIds() コメントが「空=無効」になっている', () => {
  const routerPath = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
  const content    = fs.readFileSync(routerPath, 'utf8');

  assert.ok(content.includes('空 = 無効') || content.includes('空=無効') || content.includes('全拒否'),
    'getCEOUserIds コメントが「空=無効」に修正されていない');
  assert.ok(!content.includes('空 = 制限なし') && !content.includes('全ユーザーを対象'),
    '旧コメント（空=制限なし）が残っている');
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
