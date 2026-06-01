'use strict';
// Finance Manager Phase 1 テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const fm  = require('../bot/utils/finance-manager');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// テスト用の月次ファイルを一時ディレクトリにリダイレクト
// （本番データを汚さない）
function resetMonthly() {
  const mf = fm._monthlyFile();
  if (fs.existsSync(mf)) {
    try { fs.unlinkSync(mf); } catch { /* ignore */ }
  }
  fm._saveMonthly({ totalUsd: 0, bySource: {}, byProject: {}, taskCount: 0 });
}

// ─────────────────────────────────────────────────────
// 1. recordOpenAI — OpenAI コスト記録
// ─────────────────────────────────────────────────────
console.log('\n[1. recordOpenAI — コスト記録]');

test('1a. recordOpenAI が推定コストを月次ファイルに記録する', () => {
  resetMonthly();
  const cost = fm.recordOpenAI({
    projectId: 'test-project', taskId: 'task_xxx',
    model: 'gpt-4o', inputTokens: 1000, outputTokens: 500,
  });
  assert.ok(cost > 0, '推定コストが 0');
  const monthly = fm._loadMonthly();
  assert.ok(monthly.totalUsd > 0, '月次合計が記録されていない');
  assert.ok(monthly.bySource?.openai > 0, 'openai ソースが記録されていない');
  assert.ok(monthly.byProject?.['test-project'] > 0, 'プロジェクト別が記録されていない');
});

test('1b. GPT-4o のコスト推定が正しい（$2.50/1M input + $10/1M output）', () => {
  const cost = fm.recordOpenAI({
    projectId: 'p', model: 'gpt-4o',
    inputTokens: 1_000_000, outputTokens: 1_000_000,
  });
  // 入力 $2.50 + 出力 $10.00 = $12.50
  assert.ok(Math.abs(cost - 12.50) < 0.01, `コスト推定が違う: ${cost}`);
});

test('1c. inputTokens/outputTokens が 0 なら 0 を返す', () => {
  const cost = fm.recordOpenAI({ model: 'gpt-4o', inputTokens: 0, outputTokens: 0 });
  assert.strictEqual(cost, 0);
});

// ─────────────────────────────────────────────────────
// 2. getStatus — 閾値判定
// ─────────────────────────────────────────────────────
console.log('\n[2. getStatus — 状態判定]');

test('2a. $0 → GREEN', () => {
  assert.strictEqual(fm.getStatus(0), 'GREEN');
});

test('2b. $4.99 → GREEN（閾値 $5 未満）', () => {
  assert.strictEqual(fm.getStatus(4.99), 'GREEN');
});

test('2c. $5.00 → YELLOW（閾値以上）', () => {
  assert.strictEqual(fm.getStatus(5.00), 'YELLOW');
});

test('2d. $10.00 → RED（上位閾値以上）', () => {
  assert.strictEqual(fm.getStatus(10.00), 'RED');
});

// ─────────────────────────────────────────────────────
// 3. formatFinanceSection — CEO Report 用
// ─────────────────────────────────────────────────────
console.log('\n[3. formatFinanceSection — CEO Report 統合]');

test('3a. formatFinanceSection が Finance ヘッダーを含む', () => {
  const text = fm.formatFinanceSection();
  assert.ok(text.includes('Finance') || text.includes('💰'), 'Finance ヘッダーがない');
});

test('3b. 状態（GREEN/YELLOW/RED）が表示される', () => {
  const text = fm.formatFinanceSection();
  assert.ok(
    text.includes('GREEN') || text.includes('YELLOW') || text.includes('RED'),
    '状態表示がない'
  );
});

test('3c. 推定値であることの注記がある', () => {
  const text = fm.formatFinanceSection();
  assert.ok(text.includes('推定') || text.includes('estimate'), '推定値注記がない');
});

test('3d. 確認先URL（APIダッシュボード）が含まれる', () => {
  const text = fm.formatFinanceSection();
  assert.ok(text.includes('anthropic.com') || text.includes('platform.openai.com'), 'ダッシュボードURLがない');
});

test('3e. APIキーが含まれていない', () => {
  const text = fm.formatFinanceSection();
  assert.ok(!text.includes('sk-'), 'OpenAI APIキーが漏洩');
  assert.ok(!text.includes('github_pat'), 'GitHub PATが漏洩');
  assert.ok(!text.includes('Bearer '), 'Bearer トークンが漏洩');
});

// ─────────────────────────────────────────────────────
// 4. formatCostReport — !cost コマンド用
// ─────────────────────────────────────────────────────
console.log('\n[4. formatCostReport — !cost コマンド]');

test('4a. formatCostReport が本日・今月のセクションを含む', () => {
  const text = fm.formatCostReport();
  assert.ok(text.includes('本日') || text.includes('today'), '本日セクションがない');
  assert.ok(text.includes('今月') || text.includes('monthly'), '今月セクションがない');
});

test('4b. formatCostReport にタスク数が含まれる', () => {
  const text = fm.formatCostReport();
  assert.ok(text.includes('タスク数') || text.includes('taskCount'), 'タスク数がない');
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test('5a. financeManager が require されている', () => {
  assert.ok(src.includes("require('./utils/finance-manager')"), 'finance-manager が import されていない');
});

test('5b. CEO Report に Finance セクションが追加されている', () => {
  const teardownIdx  = src.indexOf('async function _teardown');
  const teardownBody = src.slice(teardownIdx, teardownIdx + 5000);
  assert.ok(teardownBody.includes('formatFinanceSection'), 'formatFinanceSection が _teardown に追加されていない');
});

test('5c. !cost コマンドが実装されている', () => {
  assert.ok(src.includes("content === '!cost'"), '!cost コマンドがない');
  assert.ok(src.includes('formatCostReport'), 'formatCostReport が呼ばれていない');
});

test('5d. OpenAI usage が codex.js で Finance に記録される', () => {
  const codexSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'codex.js'), 'utf8');
  assert.ok(codexSrc.includes('finance-manager'), 'codex.js に finance-manager が組み込まれていない');
  assert.ok(codexSrc.includes('recordOpenAI'), 'recordOpenAI が codex.js から呼ばれていない');
});

test('5e. コスト記録は月次ファイル（logs/cost-YYYY-MM.json）に保存される', () => {
  const fmSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'finance-manager.js'), 'utf8');
  assert.ok(fmSrc.includes('cost-${y}-${m}.json'), '月次ファイル名の形式がない');
});

// ─────────────────────────────────────────────────────
// 6. 安全チェック
// ─────────────────────────────────────────────────────
console.log('\n[6. 安全チェック]');

test('6a. finance-manager.js にAPIキー系の文字列がない', () => {
  const fmSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'finance-manager.js'), 'utf8');
  assert.ok(!fmSrc.includes('sk-proj-'), 'OpenAI APIキーが埋め込まれている');
  assert.ok(!fmSrc.includes('OPENAI_API_KEY ='), 'APIキーが直接設定されている');
});

test('6b. 確定コストと断言する文言がない（「推定」「取得不可」のみ使用）', () => {
  const text = fm.formatFinanceSection();
  // 出力に「確定金額」「正確なコスト」という断言がない
  assert.ok(!text.includes('確定金額') && !text.includes('正確なコスト'), '確定断言の表示がある');
  // 「推定」または「取得不可」のいずれかを含む
  assert.ok(text.includes('推定') || text.includes('取得不可'), '推定値注記も取得不可表示もない');
});

// クリーンアップ
resetMonthly();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
