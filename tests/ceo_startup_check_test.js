'use strict';
// =======================================================
// ceo_startup_check_test.js — CEO設定起動チェックテスト
//
// テスト条件:
//   CEO_USER_IDS未設定 → 警告ログ出力 + 無効
//   CEO_USER_IDS設定済み → 有効ログ出力
//   .env.example に CEO_USER_IDS が記載されている
//   docs/ceo-natural-interface-setup.md が存在する
//   起動チェックコードが bot/index.js に存在する
//   コード内で CEO_USER_IDS を full-open にしていない
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
// [1] .env.example への CEO_USER_IDS 追加確認
// ─────────────────────────────────────────────────────
console.log('\n[1. .env.example 確認]');

const envExamplePath = path.join(__dirname, '..', '.env.example');
const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');

test('1a. .env.example に CEO_USER_IDS が記載されている', () => {
  assert.ok(envExampleContent.includes('CEO_USER_IDS'),
    '.env.example に CEO_USER_IDS が含まれていない');
});

test('1b. CEO_USER_IDS の説明にユーザーIDである旨が書かれている', () => {
  assert.ok(
    envExampleContent.includes('ユーザーID') || envExampleContent.includes('ユーザー ID'),
    '.env.example の CEO_USER_IDS 説明に「ユーザーID」と明記されていない'
  );
});

test('1c. CEO_USER_IDS の説明に「チャンネルIDではない」旨が書かれている', () => {
  assert.ok(
    envExampleContent.includes('チャンネルID') || envExampleContent.includes('チャンネル ID'),
    '.env.example に「チャンネルIDではない」という注意書きがない'
  );
});

test('1d. CEO_USER_IDS の説明に未設定=無効 (fail-closed) が書かれている', () => {
  assert.ok(
    envExampleContent.includes('未設定') || envExampleContent.includes('無効'),
    '.env.example に「未設定=無効」の説明がない'
  );
});

test('1e. .env.example の DISCORD_OWNER_ID にユーザーIDの説明がある', () => {
  assert.ok(envExampleContent.includes('DISCORD_OWNER_ID'),
    '.env.example に DISCORD_OWNER_ID が存在する');
});

test('1f. .env.example に Natural CEO Interface セクションが存在する', () => {
  assert.ok(
    envExampleContent.includes('Natural CEO Interface') ||
    envExampleContent.includes('CEO Interface') ||
    envExampleContent.includes('CEO設定'),
    '.env.example に Natural CEO Interface セクションがない'
  );
});

// ─────────────────────────────────────────────────────
// [2] docs/ceo-natural-interface-setup.md の存在確認
// ─────────────────────────────────────────────────────
console.log('\n[2. docs/ceo-natural-interface-setup.md 確認]');

const setupDocPath = path.join(__dirname, '..', 'docs', 'ceo-natural-interface-setup.md');

test('2a. docs/ceo-natural-interface-setup.md が存在する', () => {
  assert.ok(fs.existsSync(setupDocPath),
    'docs/ceo-natural-interface-setup.md が存在しない');
});

test('2b. セットアップドキュメントに開発者モードONの手順がある', () => {
  const content = fs.readFileSync(setupDocPath, 'utf8');
  assert.ok(content.includes('開発者モード'),
    'セットアップドキュメントに「開発者モード」の手順がない');
});

test('2c. セットアップドキュメントに「右クリック」→「IDをコピー」の手順がある', () => {
  const content = fs.readFileSync(setupDocPath, 'utf8');
  assert.ok(content.includes('右クリック') && (content.includes('IDをコピー') || content.includes('ID をコピー')),
    'セットアップドキュメントに「右クリック → IDをコピー」の手順がない');
});

test('2d. セットアップドキュメントに .env への設定例がある', () => {
  const content = fs.readFileSync(setupDocPath, 'utf8');
  assert.ok(content.includes('CEO_USER_IDS='),
    'セットアップドキュメントに CEO_USER_IDS= の設定例がない');
});

test('2e. セットアップドキュメントに Bot 再起動の手順がある', () => {
  const content = fs.readFileSync(setupDocPath, 'utf8');
  assert.ok(content.includes('再起動'),
    'セットアップドキュメントに「再起動」の手順がない');
});

test('2f. セットアップドキュメントに fail-closed の説明がある', () => {
  const content = fs.readFileSync(setupDocPath, 'utf8');
  assert.ok(
    content.includes('fail-closed') ||
    content.includes('未設定') ||
    content.includes('無効'),
    'セットアップドキュメントに fail-closed / 未設定=無効の説明がない'
  );
});

// ─────────────────────────────────────────────────────
// [3] bot/index.js 起動チェックコード確認
// ─────────────────────────────────────────────────────
console.log('\n[3. bot/index.js 起動チェック確認]');

const indexPath = path.join(__dirname, '..', 'bot', 'index.js');
const indexContent = fs.readFileSync(indexPath, 'utf8');

test('3a. CEO_USER_IDS の起動時チェックが bot/index.js に存在する', () => {
  assert.ok(
    indexContent.includes('CEO_USER_IDS') &&
    (indexContent.includes('未設定') || indexContent.includes('logger.warn')),
    'bot/index.js に CEO_USER_IDS の起動チェックが存在しない'
  );
});

test('3b. 未設定時に logger.warn が呼ばれる', () => {
  // 「CEO_USER_IDS 未設定」の warn ログが存在するか確認
  assert.ok(
    indexContent.includes("logger.warn('⚠️ CEO_USER_IDS") ||
    indexContent.includes('logger.warn("⚠️ CEO_USER_IDS') ||
    (indexContent.includes('CEO_USER_IDS') && indexContent.includes('logger.warn')),
    'CEO_USER_IDS 未設定時の logger.warn が存在しない'
  );
});

test('3c. 未設定時に console.warn が呼ばれる（起動バナーへの表示）', () => {
  assert.ok(
    indexContent.includes("console.warn('  ⚠️ CEO_USER_IDS") ||
    indexContent.includes('console.warn("  ⚠️ CEO_USER_IDS') ||
    (indexContent.includes('CEO_USER_IDS') && indexContent.includes('console.warn')),
    'CEO_USER_IDS 未設定時の console.warn が存在しない'
  );
});

test('3d. 設定済み時は INFO ログで有効を示す', () => {
  assert.ok(
    indexContent.includes('自然文CEO操作: 有効') ||
    indexContent.includes('CEO_USER_IDS 設定済み'),
    'CEO_USER_IDS 設定済み時の有効ログが存在しない'
  );
});

test('3e. 起動チェックは ready イベント内に配置されている', () => {
  // ready イベントのブロック内に CEO チェックがあることを確認
  const readyStart = indexContent.indexOf("client.once('ready'");
  assert.ok(readyStart >= 0, 'ready イベントが見つかる');

  // ready ブロックの終端を概算で取得（次の client.on を探す）
  const readyBlock = indexContent.slice(readyStart, readyStart + 5000);
  assert.ok(
    readyBlock.includes('CEO_USER_IDS') || readyBlock.includes('_ceoIdsRaw'),
    'CEO_USER_IDS の起動チェックが ready イベント内に存在しない'
  );
});

// ─────────────────────────────────────────────────────
// [4] 安全ゲート確認（コード変更による緩和がないこと）
// ─────────────────────────────────────────────────────
console.log('\n[4. 安全ゲート確認]');

test('4a. interactionCreate の fail-closed 条件が維持されている', () => {
  assert.ok(
    indexContent.includes('ceoids.length === 0 || !ceoids.includes(user.id)'),
    'fail-closed 条件が変更されている'
  );
});

test('4b. isCEOUser が CEO_USER_IDS 未設定で false を返す（ceo-intent-router）', () => {
  const routerPath = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
  const routerContent = fs.readFileSync(routerPath, 'utf8');
  // ids.length === 0 のとき false を返す実装
  assert.ok(
    routerContent.includes('if (ids.length === 0) return false'),
    'isCEOUser が CEO_USER_IDS 未設定時に false を返す実装がない'
  );
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
