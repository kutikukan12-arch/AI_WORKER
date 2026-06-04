'use strict';
// executive-review.js — 神崎 Executive Review テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const er  = require('../bot/utils/executive-review');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. buildExecutiveReview — 全体動作
// ─────────────────────────────────────────────────────
console.log('\n[1. buildExecutiveReview — 全体動作]');

test('1a. buildExecutiveReview が ok:true を返す', () => {
  const r = er.buildExecutiveReview();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 0);
});

test('1b. 4つのセクションが含まれる', () => {
  const r = er.buildExecutiveReview();
  assert.ok(r.text.includes('今良いところ'),        '1️⃣セクションがない');
  assert.ok(r.text.includes('問題'),                '2️⃣セクションがない');
  assert.ok(r.text.includes('放置すると危険'),      '3️⃣セクションがない');
  assert.ok(r.text.includes('CEO判断候補'),         '4️⃣セクションがない');
});

test('1c. 8部門の担当名が含まれる', () => {
  const r = er.buildExecutiveReview();
  const depts = ['宮城', '守谷', '白石', '市川', '金森', '相沢', '育野', '黒川'];
  for (const d of depts) {
    assert.ok(r.text.includes(d), `${d} 部門が含まれない`);
  }
});

test('1d. CEO判断代行の注意書きがある', () => {
  const r = er.buildExecutiveReview();
  assert.ok(r.text.includes('CEO判断の代行ではありません'), 'CEO代行禁止の注意書きがない');
  assert.ok(r.text.includes('社長（CEO）'), 'CEO最終判断の記載がない');
});

test('1e. 神崎の署名が含まれる', () => {
  const r = er.buildExecutiveReview();
  assert.ok(r.text.includes('神崎'), '神崎の署名がない');
});

// ─────────────────────────────────────────────────────
// 2. 各部門レビュー関数
// ─────────────────────────────────────────────────────
console.log('\n[2. 各部門レビュー関数]');

test('2a. _reviewDevelopment が正しい構造を返す', () => {
  const r = er._reviewDevelopment();
  assert.ok(Array.isArray(r.goods),     'goods が配列でない');
  assert.ok(Array.isArray(r.problems),  'problems が配列でない');
  assert.ok(Array.isArray(r.critical),  'critical が配列でない');
  assert.ok(Array.isArray(r.decisions), 'decisions が配列でない');
});

test('2b. _reviewQuality が正しい構造を返す', () => {
  const r = er._reviewQuality();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.problems));
});

test('2c. _reviewOperations が正しい構造を返す', () => {
  const r = er._reviewOperations();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.critical));
});

test('2d. _reviewProduct が正しい構造を返す', () => {
  const r = er._reviewProduct();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.decisions));
});

test('2e. _reviewFinance が正しい構造を返す', () => {
  const r = er._reviewFinance();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.problems));
});

test('2f. _reviewCustomer が正しい構造を返す', () => {
  const r = er._reviewCustomer();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.decisions));
});

test('2g. _reviewLearning が正しい構造を返す', () => {
  const r = er._reviewLearning();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.problems));
});

test('2h. _reviewProgress が正しい構造を返す', () => {
  const r = er._reviewProgress();
  assert.ok(Array.isArray(r.goods) && Array.isArray(r.problems));
});

// ─────────────────────────────────────────────────────
// 3. ブロック社員・インシデント検出
// ─────────────────────────────────────────────────────
console.log('\n[3. 問題検出]');

test('3a. ブロック社員がいれば critical に含まれる', () => {
  const wsm = require('../bot/utils/worker-status');
  wsm.updateStatus('miyagi', 'blocked', { note: 'テスト' });
  const r = er._reviewOperations();
  assert.ok(r.critical.some(c => c.includes('宮城')), 'ブロック宮城が critical に含まれない');
  wsm.updateStatus('miyagi', 'idle');
});

test('3b. CRITICAL インシデントがあれば critical に含まれる', () => {
  const im   = require('../bot/utils/incident-manager');
  const orig = im._load();
  im._save([...orig, {
    id: 'inc_test_exec', type: 'INCIDENT', createdAt: new Date().toISOString(),
    status: 'OPEN', severity: 'CRITICAL', title: 'テスト', summary: '',
    refs: [], tags: [], projectId: 'test',
    data: { detectedAt: null, resolvedAt: null, rootCause: '', mitigation: '',
            prevention: '', affectedArea: [] },
  }]);
  const r = er._reviewQuality();
  assert.ok(r.critical.some(c => c.includes('インシデント') || c.includes('CRITICAL') || c.includes('高重要度')),
    '高重要度インシデントが critical に含まれない');
  im._save(orig);
});

// ─────────────────────────────────────────────────────
// 4. 禁止事項確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 禁止事項確認]');

test('4a. executive-review.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'executive-review.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('),    'eval が含まれている');
  assert.ok(!code.includes('execSync('),'execSync が含まれている');
});

test('4b. 自動実行・承認・task変更がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'executive-review.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),   'createTask が呼ばれている');
  assert.ok(!code.includes('logDecision('),  'Decision を自動登録している');
  assert.ok(!code.includes('updateState('),  'updateState が呼ばれている');
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test("5a. topic === 'company' が実装されている", () => {
  const idx  = src.indexOf("vpSub === 'review'");
  const area = src.slice(idx, idx + 500);
  assert.ok(area.includes("topic === 'company'") || area.includes("'company'"), '!vp review company がない');
});

test('5b. executive-review.js を require している', () => {
  const idx  = src.indexOf("topic === 'company'");
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes("require('./utils/executive-review')"), 'require がない');
});

test('5c. !vp help に company が記載されている', () => {
  assert.ok(src.includes('!vp review company') || src.includes("'company'"), 'help に company がない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
