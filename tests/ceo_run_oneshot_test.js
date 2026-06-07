'use strict';
// =======================================================
// ceo_run_oneshot_test.js — 「[project]進めて」一発形テスト
//
// テスト条件:
//   1. 「YouTube進めて」→ RUN_REQUEST + projectHint=youtube
//   2. 「youtube予測ai進めて」→ RUN_REQUEST + projectHint=youtube予測ai
//   3. 「AI_WORKER進めて」→ RUN_REQUEST + projectHint=AI_WORKER
//   4. 「進めて」単体 → RUN_REQUEST + projectHint=null（コンテキスト依存）
//   5. extractRunProjectPrefix — プレフィックス抽出テスト
//   6. OPERATOR_* は引き続き正しく分類される（回帰）
//   7. bot/index.js 複数一致確認要求コードが存在する
//   8. 不明project → not found パスが存在する
//   9. handleAutoOn 禁止確認（回帰）
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
// [1] 一発形インテント検出
// ─────────────────────────────────────────────────────
console.log('\n[1. 一発形インテント検出]');

test('1a. 「YouTube進めて」→ RUN_REQUEST', () => {
  const r = cir.detectIntent('YouTube進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST,
    `got: ${r.intent}`);
});

test('1b. 「YouTube進めて」→ projectHint に youtube が含まれる', () => {
  const r = cir.detectIntent('YouTube進めて');
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `projectHint に youtube が含まれない: "${r.projectHint}"`
  );
});

test('1c. 「youtube予測ai進めて」→ RUN_REQUEST', () => {
  const r = cir.detectIntent('youtube予測ai進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST,
    `got: ${r.intent}`);
});

test('1d. 「youtube予測ai進めて」→ projectHint に youtube が含まれる', () => {
  const r = cir.detectIntent('youtube予測ai進めて');
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `projectHint に youtube が含まれない: "${r.projectHint}"`
  );
});

test('1e. 「AI_WORKER進めて」→ RUN_REQUEST', () => {
  const r = cir.detectIntent('AI_WORKER進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST,
    `got: ${r.intent}`);
});

test('1f. 「AI_WORKER進めて」→ projectHint = "AI_WORKER"', () => {
  const r = cir.detectIntent('AI_WORKER進めて');
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('ai_worker'),
    `projectHint に AI_WORKER が含まれない: "${r.projectHint}"`
  );
});

test('1g. 「進めて」単体 → RUN_REQUEST + projectHint=null', () => {
  const r = cir.detectIntent('進めて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST, `got: ${r.intent}`);
  assert.strictEqual(r.projectHint, null, `「進めて」単体はhintなし: "${r.projectHint}"`);
});

test('1h. 「YouTube続けて」→ RUN_REQUEST + youtube ヒント', () => {
  const r = cir.detectIntent('YouTube続けて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST, `got: ${r.intent}`);
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `projectHint に youtube が含まれない: "${r.projectHint}"`
  );
});

test('1i. 「YouTube進めといて」→ RUN_REQUEST + youtube ヒント', () => {
  const r = cir.detectIntent('YouTube進めといて');
  assert.strictEqual(r.intent, cir.INTENTS.RUN_REQUEST, `got: ${r.intent}`);
  assert.ok(
    r.projectHint && r.projectHint.toLowerCase().includes('youtube'),
    `projectHint に youtube が含まれない: "${r.projectHint}"`
  );
});

// ─────────────────────────────────────────────────────
// [2] extractRunProjectPrefix — プレフィックス抽出
// ─────────────────────────────────────────────────────
console.log('\n[2. extractRunProjectPrefix]');

test('2a. 「YouTube進めて」→ "YouTube"', () => {
  const prefix = cir.extractRunProjectPrefix('YouTube進めて');
  assert.ok(prefix && prefix.toLowerCase().includes('youtube'),
    `prefix: "${prefix}"`);
});

test('2b. 「youtube予測ai進めて」→ "youtube予測ai"', () => {
  const prefix = cir.extractRunProjectPrefix('youtube予測ai進めて');
  assert.ok(prefix && prefix.toLowerCase().includes('youtube'),
    `prefix: "${prefix}"`);
  assert.ok(prefix.includes('予測'), `"予測" が含まれない: "${prefix}"`);
});

test('2c. 「AI_WORKER進めて」→ "AI_WORKER"', () => {
  const prefix = cir.extractRunProjectPrefix('AI_WORKER進めて');
  assert.ok(prefix && prefix.toLowerCase().includes('ai_worker'),
    `prefix: "${prefix}"`);
});

test('2d. 「進めて」単体 → null（プレフィックスなし）', () => {
  const prefix = cir.extractRunProjectPrefix('進めて');
  assert.strictEqual(prefix, null, `単体は null であるべき: "${prefix}"`);
});

test('2e. 「YouTube続けて」→ "YouTube"', () => {
  const prefix = cir.extractRunProjectPrefix('YouTube続けて');
  assert.ok(prefix && prefix.toLowerCase().includes('youtube'),
    `prefix: "${prefix}"`);
});

test('2f. 「YouTube続けといて」→ "YouTube"', () => {
  const prefix = cir.extractRunProjectPrefix('YouTube続けといて');
  assert.ok(prefix && prefix.toLowerCase().includes('youtube'),
    `prefix: "${prefix}"`);
});

// ─────────────────────────────────────────────────────
// [3] OPERATOR_* 回帰確認（一発形パターン追加で誤分類しない）
// ─────────────────────────────────────────────────────
console.log('\n[3. OPERATOR_* 回帰]');

test('3a. 「黒川動かして」→ OPERATOR_RESUME（RUN_REQUESTでない）', () => {
  const r = cir.detectIntent('黒川動かして');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_RESUME,
    `誤分類: got ${r.intent}`);
});

test('3b. 「黒川起動して」→ OPERATOR_RESUME（RUN_REQUESTでない）', () => {
  const r = cir.detectIntent('黒川起動して');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_RESUME,
    `誤分類: got ${r.intent}`);
});

test('3c. 「黒川止めて」→ OPERATOR_PAUSE（RUN_REQUESTでない）', () => {
  const r = cir.detectIntent('黒川止めて');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_PAUSE,
    `誤分類: got ${r.intent}`);
});

test('3d. 「AI_WORKER起こして」→ OPERATOR_RESUME（RUN_REQUESTでない）', () => {
  const r = cir.detectIntent('AI_WORKER起こして');
  assert.strictEqual(r.intent, cir.INTENTS.OPERATOR_RESUME,
    `誤分類: got ${r.intent}`);
});

test('3e. 「Bot再起動して」→ BOT_RESTART（RUN_REQUESTでない）', () => {
  const r = cir.detectIntent('Bot再起動して');
  assert.strictEqual(r.intent, cir.INTENTS.BOT_RESTART,
    `誤分類: got ${r.intent}`);
});

// ─────────────────────────────────────────────────────
// [4] bot/index.js コード確認（複数一致・不明プロジェクト）
// ─────────────────────────────────────────────────────
console.log('\n[4. bot/index.js コード確認]');

const indexPath    = path.join(__dirname, '..', 'bot', 'index.js');
const indexContent = fs.readFileSync(indexPath, 'utf8');

// RUN_REQUEST ブロックを取得
const runBlockStart = indexContent.indexOf('// RUN_REQUEST → プロジェクトコンテキスト');
const runBlockEnd   = indexContent.indexOf('\n        // ── 運用系インテント', runBlockStart);
const runBlock = runBlockStart >= 0 && runBlockEnd > 0
  ? indexContent.slice(runBlockStart, runBlockEnd)
  : '';

test('4a. 複数一致時の確認要求コードが存在する', () => {
  assert.ok(runBlock.length > 0, 'RUN_REQUEST ブロックが見つかる');
  assert.ok(
    runBlock.includes('matches.length > 1') ||
    runBlock.includes('複数のプロジェクトに一致'),
    '複数一致時の確認要求コードがない'
  );
});

test('4b. 複数一致時に !project run の案内がある', () => {
  assert.ok(
    runBlock.includes('!project run') ||
    runBlock.includes('明示的に指定'),
    '複数一致時に !project run の案内がない'
  );
});

test('4c. 単一一致時は runPid = matches[0].id で設定される', () => {
  assert.ok(
    runBlock.includes('matches.length === 1') ||
    runBlock.includes('matches[0].id'),
    '単一一致時の処理コードがない'
  );
});

test('4d. 不明プロジェクト（matches.length === 0）のケースが処理される', () => {
  // runPid が null のまま → ③ のヒントあり not found パスへ
  assert.ok(
    runBlock.includes('一致するプロジェクトが見つかりません') ||
    (runBlock.includes('runHint') && runBlock.includes('!runPid')),
    '不明プロジェクト時の「見つかりません」メッセージがない'
  );
});

test('4e. handleAutoOn が直接呼ばれていない（禁止確認・回帰）', () => {
  assert.ok(!runBlock.includes('handleAutoOn(message)'),
    'handleAutoOn の直接呼び出しが残っている（禁止）');
});

// ─────────────────────────────────────────────────────
// [5] ceo-intent-router.js 安全確認（回帰）
// ─────────────────────────────────────────────────────
console.log('\n[5. 安全確認（回帰）]');

const routerPath    = path.join(__dirname, '..', 'bot', 'utils', 'ceo-intent-router.js');
const routerContent = fs.readFileSync(routerPath, 'utf8');

test('5a. ceo-intent-router.js に handleAutoOn がない', () => {
  assert.ok(!routerContent.includes('handleAutoOn'),
    'ceo-intent-router.js に handleAutoOn が存在する（禁止）');
});

test('5b. RUN_REQUEST に [project]進めて パターンが追加されている', () => {
  assert.ok(
    routerContent.includes('/^.+進めて[。\\.！!]?$/')  ||
    routerContent.includes('/^.+進めて/'),
    '一発形パターン /^.+進めて/ が ceo-intent-router.js に存在しない'
  );
});

test('5c. extractRunProjectPrefix が export されている', () => {
  assert.ok(
    routerContent.includes('extractRunProjectPrefix'),
    'extractRunProjectPrefix が export されていない'
  );
});

test('5d. _RUN_SUFFIX_RE が定義されている（正規表現）', () => {
  assert.ok(
    routerContent.includes('_RUN_SUFFIX_RE') || routerContent.includes('RUN_SUFFIX_RE'),
    '_RUN_SUFFIX_RE が定義されていない'
  );
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
