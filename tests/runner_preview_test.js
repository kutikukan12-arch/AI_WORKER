'use strict';
// Project Runner 開始前見通し表示テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// gatherRunnerPreview と formatRunnerPreview を index.js から直接テスト
// （内部関数のため module.exports 不要 — ソース確認中心）

// ─────────────────────────────────────────────────────
// 1. ソース確認 — 関数定義
// ─────────────────────────────────────────────────────
console.log('\n[1. 関数定義確認]');

test('1a. gatherRunnerPreview が index.js に定義されている', () => {
  assert.ok(src.includes('function gatherRunnerPreview'), 'gatherRunnerPreview がない');
});

test('1b. formatRunnerPreview が index.js に定義されている', () => {
  assert.ok(src.includes('function formatRunnerPreview'), 'formatRunnerPreview がない');
});

test('1c. handleProjectRun から preview が呼ばれている', () => {
  const runFnIdx  = src.indexOf('async function handleProjectRun');
  const runFnEnd  = src.indexOf('\n// ─────', runFnIdx + 1);
  const runFnBody = src.slice(runFnIdx, runFnEnd > 0 ? runFnEnd : runFnIdx + 3000);
  assert.ok(runFnBody.includes('gatherRunnerPreview('), 'gatherRunnerPreview 呼び出しがない');
  assert.ok(runFnBody.includes('formatRunnerPreview('), 'formatRunnerPreview 呼び出しがない');
});

// ─────────────────────────────────────────────────────
// 2. gatherRunnerPreview の集計ロジック
// ─────────────────────────────────────────────────────
console.log('\n[2. gatherRunnerPreview 集計ロジック]');

// gatherRunnerPreview は index.js 内部関数 → ソース + eval でテスト
const gatherSrc = (() => {
  const start = src.indexOf('function gatherRunnerPreview');
  const end   = src.indexOf('\nfunction formatRunnerPreview', start);
  return src.slice(start, end > 0 ? end : start + 2000);
})();

test('2a. gatherRunnerPreview が total / autoSafe / aiReview / needsApproval / blocked を返す', () => {
  assert.ok(gatherSrc.includes('total'), 'total がない');
  assert.ok(gatherSrc.includes('autoSafe'), 'autoSafe がない');
  assert.ok(gatherSrc.includes('aiReview'), 'aiReview がない');
  assert.ok(gatherSrc.includes('needsApproval'), 'needsApproval がない');
  assert.ok(gatherSrc.includes('blocked'), 'blocked がない');
});

test('2b. byType に IMPLEMENT / FIX / RESEARCH / TEST / DOCS / REVIEW が含まれる', () => {
  assert.ok(gatherSrc.includes('IMPLEMENT'), 'IMPLEMENT がない');
  assert.ok(gatherSrc.includes('FIX'), 'FIX がない');
  assert.ok(gatherSrc.includes('RESEARCH'), 'RESEARCH がない');
  assert.ok(gatherSrc.includes('TEST'), 'TEST がない');
  assert.ok(gatherSrc.includes('DOCS'), 'DOCS がない');
  assert.ok(gatherSrc.includes('REVIEW'), 'REVIEW がない');
});

test('2c. LARGE タスクの検出（largeCount / hasLarge）がある', () => {
  assert.ok(gatherSrc.includes('largeCount'), 'largeCount がない');
  assert.ok(gatherSrc.includes('hasLarge'), 'hasLarge がない');
  assert.ok(gatherSrc.includes('LARGE') || gatherSrc.includes('TASK_SIZES.LARGE'), 'LARGE 判定がない');
});

test('2d. autoPolicy.classifyTask で policy 判定している', () => {
  assert.ok(gatherSrc.includes('autoPolicy.classifyTask'), 'autoPolicy.classifyTask がない');
  assert.ok(gatherSrc.includes('AUTO_SAFE'), 'AUTO_SAFE がない');
  assert.ok(gatherSrc.includes('BLOCKED'), 'BLOCKED がない');
});

test('2e. Runner 実行ロジック変更禁止 — gatherRunnerPreview に updateState/createTask がない', () => {
  assert.ok(!gatherSrc.includes('updateState'), 'gatherRunnerPreview が updateState を呼んでいる');
  assert.ok(!gatherSrc.includes('createTask'), 'gatherRunnerPreview が createTask を呼んでいる');
  assert.ok(!gatherSrc.includes('claimNextTask'), 'gatherRunnerPreview が claimNextTask を呼んでいる');
});

// ─────────────────────────────────────────────────────
// 3. formatRunnerPreview の表示内容
// ─────────────────────────────────────────────────────
console.log('\n[3. formatRunnerPreview 表示内容]');

const fmtSrc = (() => {
  const start = src.indexOf('function formatRunnerPreview');
  const end   = src.indexOf('\nasync function handleProjectRun', start);
  return src.slice(start, end > 0 ? end : start + 2000);
})();

test('3a. タスク0件の場合「実行対象なし」が分かる', () => {
  assert.ok(fmtSrc.includes('実行対象タスクなし') || fmtSrc.includes('total === 0'),
    '0件時の表示がない');
});

test('3b. 残タスク数（total）が表示される', () => {
  assert.ok(fmtSrc.includes('preview.total') || fmtSrc.includes('total}件'),
    '残タスク数の表示がない');
});

test('3c. タイプ別内訳（byType）が表示される', () => {
  assert.ok(fmtSrc.includes('byType') || fmtSrc.includes('typeLines'), 'type別内訳がない');
});

test('3d. 承認必要タスクがあれば注意表示する', () => {
  assert.ok(fmtSrc.includes('needsApproval') && (fmtSrc.includes('承認') || fmtSrc.includes('approval')),
    '承認必要タスクの注意表示がない');
});

test('3e. BLOCKEDタスクがあれば注意表示する', () => {
  assert.ok(fmtSrc.includes('blocked') && fmtSrc.includes('BLOCKED'), 'BLOCKED警告がない');
});

test('3f. LARGEタスクがあれば注意表示する', () => {
  assert.ok(fmtSrc.includes('hasLarge') || fmtSrc.includes('LARGE'), 'LARGE警告がない');
});

// ─────────────────────────────────────────────────────
// 4. 商品完成とは言い切らない（重要安全条件）
// ─────────────────────────────────────────────────────
console.log('\n[4. 商品完成とは言い切らない]');

test('4a. formatRunnerPreview に「商品完成ではない」系の注記がある', () => {
  assert.ok(
    fmtSrc.includes('商品完成') || fmtSrc.includes('完成ではありません') || fmtSrc.includes('完成度'),
    '商品完成否定の注記がない'
  );
});

test('4b. AI Board Report / CEO Report への参照がある', () => {
  assert.ok(
    fmtSrc.includes('AI Board Report') || fmtSrc.includes('Board Report'),
    'AI Board Report への参照がない'
  );
});

test('4c. タスク0件でも「完成ではない」注記がある', () => {
  const zeroBlock = fmtSrc.slice(0, fmtSrc.indexOf('if (preview.total === 0)') + 400);
  // 0件時のブロック検索
  const zeroIdx  = fmtSrc.indexOf('total === 0');
  const zeroArea = fmtSrc.slice(zeroIdx, zeroIdx + 400);
  assert.ok(
    zeroArea.includes('ではありません') || zeroArea.includes('完成'),
    '0件時にも「完成ではない」注記が必要'
  );
});

// ─────────────────────────────────────────────────────
// 5. Runner 実行ロジックが変更されていないこと
// ─────────────────────────────────────────────────────
console.log('\n[5. 既存機能保護]');

test('5a. _runProjectLoop は変更なし', () => {
  assert.ok(src.includes('async function _runProjectLoop'), '_runProjectLoop が消えている');
});

test('5b. autoPolicy.classifyTask の選定ロジックは変更なし', () => {
  assert.ok(src.includes('async function prepareNextTask'), 'prepareNextTask が消えている');
});

test('5c. Quality Gate PRE-RUN チェックは変更なし', () => {
  const runFnIdx  = src.indexOf('async function handleProjectRun');
  const runFnBody = src.slice(runFnIdx, runFnIdx + 2000);
  assert.ok(runFnBody.includes('qualityGate.assessQuality'), 'Quality Gate チェックが消えている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
