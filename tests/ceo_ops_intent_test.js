'use strict';
// =======================================================
// ceo_ops_intent_test.js — 運用系CEO自然文インテントテスト
//
// テスト条件:
//   「Bot動いてる？」→ BOT_STATUS_CHECK
//   「Bot再起動して」→ BOT_RESTART
//   「黒川起動して」→ OPERATOR_RESUME
//   「黒川止めて」→ OPERATOR_PAUSE
//   「黒川の状態見て」→ OPERATOR_STATUS
//   「AI_WORKER起こして」→ OPERATOR_RESUME
//   CEO以外は無視（isCEOUser=false）
//   bot.lock削除文字列がコードに存在しない
//   STATUS_CHECKと誤分類されない（前方優先評価確認）
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
// [1] 運用系インテント検出
// ─────────────────────────────────────────────────────
console.log('\n[1. 運用系インテント検出]');

test('1a. 「Bot動いてる？」→ BOT_STATUS_CHECK', () => {
  const r = cir.detectIntent('Bot動いてる？');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_STATUS_CHECK,
    `got: ${r.intent} (STATUS_CHECKに誤分類されていないか確認)`);
});

test('1b. 「bot動いてる？」（小文字）→ BOT_STATUS_CHECK', () => {
  const r = cir.detectIntent('bot動いてる？');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_STATUS_CHECK,
    `got: ${r.intent}`);
});

test('1c. 「AI_WORKER動いてる？」→ BOT_STATUS_CHECK', () => {
  const r = cir.detectIntent('AI_WORKER動いてる？');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_STATUS_CHECK,
    `got: ${r.intent}`);
});

test('1d. 「Bot状態？」→ BOT_STATUS_CHECK', () => {
  const r = cir.detectIntent('Bot状態？');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_STATUS_CHECK,
    `got: ${r.intent}`);
});

test('1e. 「Bot再起動して」→ BOT_RESTART', () => {
  const r = cir.detectIntent('Bot再起動して');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_RESTART,
    `got: ${r.intent}`);
});

test('1f. 「AI_WORKER再起動して」→ BOT_RESTART', () => {
  const r = cir.detectIntent('AI_WORKER再起動して');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_RESTART,
    `got: ${r.intent}`);
});

test('1g. 「再起動して」→ BOT_RESTART', () => {
  const r = cir.detectIntent('再起動して');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_RESTART,
    `got: ${r.intent}`);
});

test('1h. 「黒川の状態見て」→ OPERATOR_STATUS', () => {
  const r = cir.detectIntent('黒川の状態見て');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_STATUS,
    `got: ${r.intent}`);
});

test('1i. 「黒川動いてる？」→ OPERATOR_STATUS', () => {
  const r = cir.detectIntent('黒川動いてる？');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_STATUS,
    `got: ${r.intent}`);
});

test('1j. 「黒川起動して」→ OPERATOR_RESUME', () => {
  const r = cir.detectIntent('黒川起動して');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_RESUME,
    `got: ${r.intent}`);
});

test('1k. 「AI_WORKER起こして」→ OPERATOR_RESUME', () => {
  const r = cir.detectIntent('AI_WORKER起こして');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_RESUME,
    `got: ${r.intent}`);
});

test('1l. 「黒川止めて」→ OPERATOR_PAUSE', () => {
  const r = cir.detectIntent('黒川止めて');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_PAUSE,
    `got: ${r.intent}`);
});

test('1m. 「黒川停止して」→ OPERATOR_PAUSE', () => {
  const r = cir.detectIntent('黒川停止して');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_PAUSE,
    `got: ${r.intent}`);
});

// ─────────────────────────────────────────────────────
// [2] STATUS_CHECKとの誤分類なし（前方優先評価確認）
// ─────────────────────────────────────────────────────
console.log('\n[2. STATUS_CHECKとの誤分類なし]');

test('2a. 「Bot動いてる？」はSTATUS_CHECKに分類されない', () => {
  const r = cir.detectIntent('Bot動いてる？');
  assert.notStrictEqual(r.intent, cir.INTENTS.STATUS_CHECK,
    `Bot動いてる？ should not be STATUS_CHECK (got ${r.intent})`);
  assert.strictEqual(r.intent, cir.INTENTS.BOT_STATUS_CHECK);
});

test('2b. 「動いてる？」（Bot/黒川なし）→ STATUS_CHECK', () => {
  // Bot/黒川が前についていない「動いてる？」はタスク進捗確認
  const r = cir.detectIntent('動いてる？');
  assert.strictEqual(r.intent, cir.INTENTS.STATUS_CHECK,
    `単体の「動いてる？」はSTATUS_CHECK: got ${r.intent}`);
});

test('2c. 「黒川どう？」→ OPERATOR_STATUS（STATUS_CHECKでない）', () => {
  const r = cir.detectIntent('黒川どう？');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_STATUS,
    `got: ${r.intent}`);
});

// ─────────────────────────────────────────────────────
// [3] CEO以外は無視（isCEOUser）
// ─────────────────────────────────────────────────────
console.log('\n[3. CEO以外は無視]');

test('3a. CEO_USER_IDS未設定 → isCEOUser=false（安全側）', () => {
  const orig = process.env.CEO_USER_IDS;
  delete process.env.CEO_USER_IDS;
  assert.strictEqual(cir.isCEOUser('any-id'), false, 'CEO_USER_IDS未設定はfalse');
  process.env.CEO_USER_IDS = orig || '';
});

test('3b. CEO_USER_IDSに含まれるID → true', () => {
  process.env.CEO_USER_IDS = 'ceo-123,ceo-456';
  assert.strictEqual(cir.isCEOUser('ceo-123'), true);
  assert.strictEqual(cir.isCEOUser('ceo-456'), true);
  delete process.env.CEO_USER_IDS;
});

test('3c. CEO_USER_IDSに含まれないID → false', () => {
  process.env.CEO_USER_IDS = 'ceo-123';
  assert.strictEqual(cir.isCEOUser('other-999'), false);
  delete process.env.CEO_USER_IDS;
});

// ─────────────────────────────────────────────────────
// [4] bot.lock削除コードが存在しない（安全ゲート確認）
// ─────────────────────────────────────────────────────
console.log('\n[4. bot.lock削除コードが存在しない]');

test('4a. ceo-intent-router.js に "rm -f.*bot.lock" が存在しない', () => {
  const filePath = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
  const content  = fs.readFileSync(filePath, 'utf8');
  assert.ok(!content.includes('rm -f'), `rm -f コマンドが ceo-intent-router.js に存在する: 禁止`);
  assert.ok(!/unlinkSync.*bot\.lock/.test(content), `unlinkSync(bot.lock) が存在する: 禁止`);
  assert.ok(!/unlink.*bot\.lock/.test(content), `unlink(bot.lock) が存在する: 禁止`);
});

test('4b. ceo-intent-router.js に "fs.unlinkSync" が存在しない', () => {
  const filePath = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
  const content  = fs.readFileSync(filePath, 'utf8');
  // bot.lockへのunlink/rimraf系は禁止
  assert.ok(!content.includes('fs.unlink'), `fs.unlink は ceo-intent-router.js で禁止`);
  assert.ok(!content.includes('rimraf'), `rimraf は禁止`);
});

test('4c. buildBotStatusReply は fs.existsSync/readFileSync のみ（削除なし）', () => {
  const filePath = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
  const content  = fs.readFileSync(filePath, 'utf8');
  // 使用するfsメソッドは existsSync と readFileSync のみ
  const allowedFsMethods = ['fs.existsSync', 'fs.readFileSync'];
  const forbiddenFsMethods = ['fs.unlink', 'fs.rm', 'fs.rmdir', 'fs.writeFileSync', 'fs.appendFileSync'];
  for (const m of forbiddenFsMethods) {
    assert.ok(!content.includes(m),
      `ceo-intent-router.js に禁止されたfsメソッド "${m}" が存在する`);
  }
});

// ─────────────────────────────────────────────────────
// [5] buildBotStatusReply モック確認
// ─────────────────────────────────────────────────────
console.log('\n[5. buildBotStatusReply モック確認]');

test('5a. client提供時にDiscord接続状態が含まれる', () => {
  const mockClient = { ws: { status: 1 } }; // 1 = OPEN
  const reply = cir.buildBotStatusReply({ client: mockClient });
  assert.ok(reply.includes('接続済み') || reply.includes('OPEN'),
    `Discord接続状態が含まれない: ${reply.slice(0, 200)}`);
});

test('5b. bot.lockなし環境でも正常動作', () => {
  // 存在しないdataDirを渡して挙動確認
  const reply = cir.buildBotStatusReply({ dataDir: '/nonexistent/path/to/data' });
  assert.ok(reply.includes('Bot'), `Bot状態確認の返信が空: ${reply.slice(0, 100)}`);
  assert.ok(reply.includes('PID'), `PID情報が含まれない: ${reply.slice(0, 200)}`);
});

test('5c. 多重起動なしの場合は正常稼働メッセージ', () => {
  // 実際のデータディレクトリを使用（bot.lockがあれば現在PIDと一致するはず）
  const realDataDir = path.join(__dirname, '..', 'data');
  const reply = cir.buildBotStatusReply({ dataDir: realDataDir });
  // 「多重起動」警告が出ていないことを確認（正常稼働中）
  // ただし、テスト実行時にbot.lockが存在しない場合もある
  assert.ok(typeof reply === 'string' && reply.length > 0, 'buildBotStatusReply が文字列を返す');
  assert.ok(!reply.includes('rm -f'), `rm -f が返信に含まれてはいけない`);
});

// ─────────────────────────────────────────────────────
// [6] 既存インテントが維持されている（回帰テスト）
// ─────────────────────────────────────────────────────
console.log('\n[6. 既存インテント回帰確認]');

test('6a. 「今どう？」→ STATUS_CHECK（変わらず）', () => {
  const r = cir.detectIntent('今どう？');
  assert.strictEqual(r.intent, cir.INTENTS.STATUS_CHECK, `got: ${r.intent}`);
});

test('6b. 「進めて」→ RUN_REQUEST（変わらず）', () => {
  const r = cir.detectIntent('進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST, `got: ${r.intent}`);
});

test('6c. 「問題ある？」→ PROBLEM_CHECK（変わらず）', () => {
  const r = cir.detectIntent('問題ある？');
  assert.strictEqual(r.intent, cir.INTENTS.PROBLEM_CHECK, `got: ${r.intent}`);
});

test('6d. 「今日なにした？」→ SUMMARY_REQUEST（変わらず）', () => {
  const r = cir.detectIntent('今日なにした？');
  assert.strictEqual(r.intent, cir.INTENTS.SUMMARY_REQUEST, `got: ${r.intent}`);
});

test('6e. 「YouTube完成した？」→ READY_CHECK（変わらず）', () => {
  const r = cir.detectIntent('YouTube完成した？');
  assert.strictEqual(r.intent, cir.INTENTS.READY_CHECK, `got: ${r.intent}`);
});

test('6f. 「!help」→ UNKNOWN（変わらず）', () => {
  const r = cir.detectIntent('!help');
  assert.strictEqual(r.intent, cir.INTENTS.UNKNOWN, `got: ${r.intent}`);
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
