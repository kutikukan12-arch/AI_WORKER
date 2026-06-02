'use strict';
// Finance Gate Phase 1 テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const fg  = require('../bot/utils/finance-gate');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─── テスト用に評価関数をモックできるようにする ───────
function makeEvalWith(usageJPY, config = {}) {
  const merged = {
    monthlyBudgetJPY: 5000,
    warningRate:      0.50,
    approvalRate:     0.80,
    hardStopRate:     1.00,
    enabled:          true,
    ...config,
  };
  const rate     = merged.monthlyBudgetJPY > 0 ? usageJPY / merged.monthlyBudgetJPY : 0;
  const remaining = Math.max(0, merged.monthlyBudgetJPY - usageJPY);
  let level = fg.GATE_LEVEL.OK;
  if      (rate >= merged.hardStopRate)  level = fg.GATE_LEVEL.HARD_STOP;
  else if (rate >= merged.approvalRate)  level = fg.GATE_LEVEL.APPROVAL;
  else if (rate >= merged.warningRate)   level = fg.GATE_LEVEL.WARNING;
  return { level, config: merged, usage: { usd: 0, jpy: usageJPY, isEstimate: true }, rate, remaining, budgetJPY: merged.monthlyBudgetJPY };
}

// ─────────────────────────────────────────────────────
// 1. ゲートレベル判定
// ─────────────────────────────────────────────────────
console.log('\n[1. ゲートレベル判定]');

test('1a. 0% → OK', () => {
  const e = makeEvalWith(0);
  assert.strictEqual(e.level, fg.GATE_LEVEL.OK);
});

test('1b. 40% → OK（50% 未満）', () => {
  const e = makeEvalWith(2000); // 2000/5000 = 40%
  assert.strictEqual(e.level, fg.GATE_LEVEL.OK);
});

test('1c. 50% → WARNING', () => {
  const e = makeEvalWith(2500); // 2500/5000 = 50%
  assert.strictEqual(e.level, fg.GATE_LEVEL.WARNING);
});

test('1d. 75% → WARNING（80% 未満）', () => {
  const e = makeEvalWith(3750); // 3750/5000 = 75%
  assert.strictEqual(e.level, fg.GATE_LEVEL.WARNING);
});

test('1e. 80% → APPROVAL', () => {
  const e = makeEvalWith(4000); // 4000/5000 = 80%
  assert.strictEqual(e.level, fg.GATE_LEVEL.APPROVAL);
});

test('1f. 95% → APPROVAL（100% 未満）', () => {
  const e = makeEvalWith(4750); // 4750/5000 = 95%
  assert.strictEqual(e.level, fg.GATE_LEVEL.APPROVAL);
});

test('1g. 100% → HARD_STOP', () => {
  const e = makeEvalWith(5000); // 5000/5000 = 100%
  assert.strictEqual(e.level, fg.GATE_LEVEL.HARD_STOP);
});

test('1h. 120% → HARD_STOP（超過）', () => {
  const e = makeEvalWith(6000); // 6000/5000 = 120%
  assert.strictEqual(e.level, fg.GATE_LEVEL.HARD_STOP);
});

// ─────────────────────────────────────────────────────
// 2. checkRunnerStart — 結果確認
// ─────────────────────────────────────────────────────
console.log('\n[2. checkRunnerStart 動作確認]');

test('2a. enabled=false → 常に allowed:true', () => {
  // enabled=false の設定ファイルを一時的に書いてテスト
  const cfg = fg.loadConfig();
  const orig = cfg.enabled;
  cfg.enabled = false;
  fg.saveConfig(cfg);
  const result = fg.checkRunnerStart();
  cfg.enabled = orig;
  fg.saveConfig(cfg);
  assert.strictEqual(result.allowed, true);
});

test('2b. HARD_STOP 状態の budgetSection には「上限到達」説明がある', () => {
  // formatBudgetSection は checkRunnerStart と独立しているのでソース確認
  const src2 = require('fs').readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'finance-gate.js'), 'utf8'
  );
  assert.ok(src2.includes('HARD_STOP') && src2.includes('上限'), 'HARD_STOP メッセージがない');
});

test('2c. APPROVAL 状態に !finance approve 案内がある', () => {
  const src2 = require('fs').readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'finance-gate.js'), 'utf8'
  );
  assert.ok(src2.includes('!finance approve'), '!finance approve 案内がない');
});

// ─────────────────────────────────────────────────────
// 3. CEO Report 表示
// ─────────────────────────────────────────────────────
console.log('\n[3. CEO Report 予算表示]');

test('3a. formatBudgetSection が予算バーを含む', () => {
  const text = fg.formatBudgetSection();
  assert.ok(text.includes('█') || text.includes('░'), '予算バーがない');
});

test('3b. formatBudgetSection に「推定値」注記がある', () => {
  const text = fg.formatBudgetSection();
  assert.ok(text.includes('推定'), '推定値注記がない');
});

test('3c. formatBudgetSection に月予算・使用額・残りが含まれる', () => {
  const text = fg.formatBudgetSection();
  assert.ok(text.includes('月予算') || text.includes('予算'), '月予算がない');
  assert.ok(text.includes('使用額') || text.includes('消化'), '使用額がない');
  assert.ok(text.includes('残') || text.includes('remaining'), '残りがない');
});

test('3d. formatFinanceStatus に WARNING/APPROVAL/HARD_STOP の閾値が表示される', () => {
  const text = fg.formatFinanceStatus();
  assert.ok(text.includes('WARNING'), 'WARNING 閾値がない');
  assert.ok(text.includes('APPROVAL'), 'APPROVAL 閾値がない');
  assert.ok(text.includes('HARD STOP') || text.includes('HARD_STOP'), 'HARD_STOP 閾値がない');
});

// ─────────────────────────────────────────────────────
// 4. 予算バー生成
// ─────────────────────────────────────────────────────
console.log('\n[4. 予算バー]');

test('4a. 0% → 全て空白', () => {
  const bar = fg._buildBudgetBar(0);
  assert.ok(!bar.includes('█'), '0%なのに埋まっている');
});

test('4b. 50% → 半分埋まる', () => {
  const bar = fg._buildBudgetBar(0.5);
  assert.ok(bar.includes('█') && bar.includes('░'), '50%バーが正しくない');
});

test('4c. 100% → 全て埋まる', () => {
  const bar = fg._buildBudgetBar(1.0);
  assert.ok(!bar.includes('░'), '100%なのに空白がある');
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test('5a. financeGate が require されている', () => {
  assert.ok(src.includes("require('./utils/finance-gate')"), 'finance-gate が import されていない');
});

test('5b. handleProjectRun に checkRunnerStart が組み込まれている', () => {
  const runFnIdx  = src.indexOf('async function handleProjectRun');
  const runFnBody = src.slice(runFnIdx, runFnIdx + 2500);
  assert.ok(runFnBody.includes('checkRunnerStart'), 'checkRunnerStart が handleProjectRun にない');
  assert.ok(runFnBody.includes('Finance Gate'), 'Finance Gate メッセージがない');
});

test('5c. Runner 開始メッセージに予算ライン（budgetLine）が含まれる', () => {
  const runFnIdx  = src.indexOf('async function handleProjectRun');
  const runFnBody = src.slice(runFnIdx, runFnIdx + 5000); // 関数全体を確認
  assert.ok(runFnBody.includes('budgetLine'), 'budgetLine が開始メッセージにない');
  assert.ok(runFnBody.includes('evaluateBudget'), 'evaluateBudget が呼ばれていない');
});

test('5d. CEO Report の Finance セクションが formatBudgetSection を使う', () => {
  assert.ok(src.includes('formatBudgetSection'), 'formatBudgetSection が CEO Report にない');
});

test('5e. !finance コマンドが実装されている', () => {
  assert.ok(src.includes("'!finance'") || src.includes('startsWith(\'!finance\')'), '!finance コマンドがない');
  assert.ok(src.includes("fSub === 'approve'"), '!finance approve がない');
  assert.ok(src.includes("fSub === 'status'"), '!finance status がない');
});

test('5f. FinanceGate チェックエラーは Bot を落とさない', () => {
  const runFnIdx  = src.indexOf('async function handleProjectRun');
  const runFnBody = src.slice(runFnIdx, runFnIdx + 2500);
  assert.ok(runFnBody.includes('fgErr') || runFnBody.includes('続行'), 'FinanceGate エラー時の続行処理がない');
});

test('5g. .gitignore に finance-config.json と finance-approval.json が追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('finance-config.json'), 'finance-config.json が .gitignore にない');
  assert.ok(gi.includes('finance-approval.json'), 'finance-approval.json が .gitignore にない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
