'use strict';
// vp-brain.js — 神崎 VP Brain Phase1 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const vpb = require('../bot/utils/vp-brain');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function reset() { vpb._save([]); }
function cleanup() {
  try { if (fs.existsSync(vpb.REVIEWS_FILE)) vpb._save([]); } catch {}
}

// ─────────────────────────────────────────────────────
// 1. buildReview — レビュー生成
// ─────────────────────────────────────────────────────
console.log('\n[1. buildReview — レビュー生成]');

test('1a. 正常にレビューが生成される', () => {
  reset();
  const r = vpb.buildReview('YouTube診断AIを有料プランにするか判断したい');
  assert.strictEqual(r.ok, true);
  assert.ok(r.id.startsWith('vpr_'), `id: ${r.id}`);
  assert.ok(r.text.length > 0);
});

test('1b. トピックなしはエラー', () => {
  const r = vpb.buildReview('');
  assert.strictEqual(r.ok, false);
});

test('1c. 出力に5つの必須セクションが含まれる', () => {
  reset();
  const r = vpb.buildReview('機能追加のタイミングを判断したい');
  assert.ok(r.text.includes('状況整理'),   '状況整理セクションがない');
  assert.ok(r.text.includes('社員意見'),   '社員意見セクションがない');
  assert.ok(r.text.includes('選択肢'),     '選択肢セクションがない');
  assert.ok(r.text.includes('神崎提案'),   '神崎提案セクションがない');
  assert.ok(r.text.includes('最終判断'),   '最終判断（CEO）の記載がない');
});

test('1d. 4名の社員視点が含まれる', () => {
  reset();
  const r = vpb.buildReview('コスト削減を検討中');
  assert.ok(r.text.includes('市川'),    '市川がない');
  assert.ok(r.text.includes('金森'),    '金森がない');
  assert.ok(r.text.includes('白石'),    '白石がない');
  assert.ok(r.text.includes('守谷'),    '守谷がない');
});

test('1e. A案 / B案 が含まれる', () => {
  reset();
  const r = vpb.buildReview('新機能実装の判断');
  assert.ok(r.text.includes('A案'), 'A案がない');
  assert.ok(r.text.includes('B案'), 'B案がない');
});

test('1f. 推奨に「提案」「決定ではない」の注意書きがある', () => {
  reset();
  const r = vpb.buildReview('方針変更の判断');
  assert.ok(r.text.includes('決定ではありません'), '決定ではない旨がない');
  assert.ok(r.text.includes('CEO') || r.text.includes('社長'), 'CEO最終判断の記載がない');
});

test('1g. vp-reviews.json に保存される', () => {
  reset();
  vpb.buildReview('保存テスト');
  const list = vpb._load();
  assert.strictEqual(list.length, 1);
  assert.ok(list[0].id.startsWith('vpr_'));
});

test('1h. topic に redact が適用される', () => {
  reset();
  const fakeToken = 'ghp_' + 'R'.repeat(36);
  const r = vpb.buildReview(`token: ${fakeToken} について判断`);
  assert.ok(!r.text.includes(fakeToken), 'トークンが含まれている');
});

// ─────────────────────────────────────────────────────
// 2. キーワード検出と視点生成
// ─────────────────────────────────────────────────────
console.log('\n[2. キーワード検出と視点生成]');

test('2a. 商品キーワードを検出できる', () => {
  const topics = vpb._detectTopics('ユーザー向け機能をMVPに含めるか判断');
  assert.ok(topics.includes('product'), 'product が検出されない');
});

test('2b. コストキーワードを検出できる', () => {
  const topics = vpb._detectTopics('外部APIのコスト削減を検討');
  assert.ok(topics.includes('cost'), 'cost が検出されない');
});

test('2c. 技術キーワードを検出できる', () => {
  const topics = vpb._detectTopics('セキュリティ設計の見直し');
  assert.ok(topics.includes('tech'), 'tech が検出されない');
});

test('2d. _buildOptions が A/B 案を返す', () => {
  const topics = ['product', 'cost'];
  const { aOption, bOption } = vpb._buildOptions('商品化判断', topics);
  assert.ok(aOption.merit.length > 0, 'A案 merit がない');
  assert.ok(bOption.risk.length > 0,  'B案 risk がない');
});

test('2e. _buildRecommendation が推奨を返す', () => {
  const r = vpb._buildRecommendation('緊急対応が必要', ['product'], {});
  assert.ok(r.recommend, '推奨テキストがない');
  assert.ok(r.reason, '理由がない');
});

// ─────────────────────────────────────────────────────
// 3. recordLearning — CEO選択の学習記録
// ─────────────────────────────────────────────────────
console.log('\n[3. recordLearning — 学習記録]');

test('3a. A案を学習記録できる', () => {
  reset();
  const r1 = vpb.buildReview('学習テスト');
  const r2 = vpb.recordLearning(r1.id, 'A', 'ユーザー価値が高いため');
  assert.strictEqual(r2.ok, true);
  const list = vpb._load();
  assert.strictEqual(list[0].learning.chosen, 'A');
  assert.ok(list[0].learning.reason.includes('ユーザー価値'));
});

test('3b. B案 / none も記録できる', () => {
  reset();
  const r1 = vpb.buildReview('学習テスト2');
  vpb.recordLearning(r1.id, 'B', 'リスク回避');
  const list = vpb._load();
  assert.strictEqual(list[0].learning.chosen, 'B');
});

test('3c. 不正な chosen はエラー', () => {
  reset();
  const r1 = vpb.buildReview('テスト');
  const r2 = vpb.recordLearning(r1.id, 'X');
  assert.strictEqual(r2.ok, false);
});

test('3d. 存在しない ID はエラー', () => {
  const r = vpb.recordLearning('vpr_nonexistent', 'A');
  assert.strictEqual(r.ok, false);
});

test('3e. reason に redact が適用される', () => {
  reset();
  const r1        = vpb.buildReview('テスト');
  const fakeToken = 'ghp_' + 'S'.repeat(36);
  vpb.recordLearning(r1.id, 'A', `token: ${fakeToken}`);
  const list = vpb._load();
  assert.ok(!list[0].learning.reason.includes(fakeToken), 'トークンが残っている');
});

test('3f. 学習は自動実行・承認・Decision確定をしない（ソース確認）', () => {
  const brainSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'vp-brain.js'), 'utf8'
  );
  const codeOnly = brainSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('createTask('),     'createTask が呼ばれている');
  assert.ok(!codeOnly.includes('logDecision('),    'Decision を自動登録している');
  assert.ok(!codeOnly.includes('eval('),           'eval が含まれている');
  assert.ok(!codeOnly.includes("require('./task-manager')"), 'task-manager が自動呼出し');
  // decision-log は 育野視点(読み取り専用)で使用: OK。logDecision() の呼出しがないことを確認済み。
});

// ─────────────────────────────────────────────────────
// 4. listReviews — 一覧表示
// ─────────────────────────────────────────────────────
console.log('\n[4. listReviews — 一覧表示]');

test('4a. 空のとき案内メッセージ', () => {
  reset();
  const r = vpb.listReviews();
  assert.ok(r.text.includes('VP Review はまだありません'));
});

test('4b. レビュー後は一覧に表示される', () => {
  reset();
  vpb.buildReview('一覧テスト');
  const r = vpb.listReviews();
  assert.ok(r.text.includes('一覧テスト'));
});

test('4c. 学習済みは ✅ 表示', () => {
  reset();
  const r1 = vpb.buildReview('学習済みテスト');
  vpb.recordLearning(r1.id, 'A');
  const list = vpb.listReviews();
  assert.ok(list.text.includes('✅'), '✅ が表示されない');
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test("5a. !vp review が実装されている", () => {
  assert.ok(src.includes("vpSub === 'review'"), '!vp review がない');
});

test("5b. !vp learn が実装されている", () => {
  assert.ok(src.includes("vpSub === 'learn'"), '!vp learn がない');
});

test("5c. !vp list が実装されている", () => {
  assert.ok(src.includes("vpSub === 'list'"), '!vp list がない');
});

test('5d. vp-brain.js を require している', () => {
  const idx  = src.indexOf("vpSub === 'review'");
  const area = src.slice(idx, idx + 700);
  assert.ok(area.includes("require('./utils/vp-brain')"), 'vp-brain require がない');
});

// ─────────────────────────────────────────────────────
// 6. .gitignore 確認
// ─────────────────────────────────────────────────────
console.log('\n[6. .gitignore 確認]');

test('6a. vp-reviews.json が .gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/vp-reviews.json'), 'vp-reviews.json が gitignore にない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
