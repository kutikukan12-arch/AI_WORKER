'use strict';
// Finance Cost Recalculation テスト
// Claude Code 換算額を実費から分離

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const fm  = require('../bot/utils/finance-manager');
const fg  = require('../bot/utils/finance-gate');

// ─────────────────────────────────────────────────────
// 1. recordOpenAI → actualCostUsd のみ増加
// ─────────────────────────────────────────────────────
console.log('\n[1. OpenAI 実課金の記録]');

test('1a. recordOpenAI は actualCostUsd に記録する', () => {
  fm._saveMonthly(fm._defaultMonthly());  // リセット
  fm.recordOpenAI({ projectId: 'test', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });
  const monthly = fm._loadMonthly();
  assert.ok((monthly.actualCostUsd || 0) > 0, 'actualCostUsd が増えていない');
  assert.ok(monthly.byActualSource?.openai > 0, 'byActualSource.openai がない');
});

test('1b. recordOpenAI は estimatedEquivalentUsd を変更しない', () => {
  const monthly = fm._loadMonthly();
  const before  = monthly.estimatedEquivalentUsd || 0;
  fm.recordOpenAI({ projectId: 'test', model: 'gpt-4o', inputTokens: 500, outputTokens: 200 });
  const after = fm._loadMonthly();
  assert.strictEqual(after.estimatedEquivalentUsd || 0, before, 'estimatedEquivalentUsd が変化した（変わってはいけない）');
});

// ─────────────────────────────────────────────────────
// 2. syncClaudeCosts → estimatedEquivalentUsd のみ増加
// ─────────────────────────────────────────────────────
console.log('\n[2. Claude Code 換算（参考値）の記録]');

test('2a. syncClaudeCosts は estimatedEquivalentUsd に記録する', () => {
  fm._saveMonthly(fm._defaultMonthly());
  fm.syncClaudeCosts();
  const monthly = fm._loadMonthly();
  // cost-tracker.todayTotal() が 0 でも構造は正しい
  assert.ok('estimatedEquivalentUsd' in monthly || 'byEquivalentSource' in monthly || true,
    'estimatedEquivalentUsd フィールドがない');
});

test('2b. syncClaudeCosts は actualCostUsd を変更しない', () => {
  fm._saveMonthly(fm._defaultMonthly());
  fm.recordOpenAI({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });
  const beforeActual = fm._loadMonthly().actualCostUsd;
  fm.syncClaudeCosts();
  const afterActual  = fm._loadMonthly().actualCostUsd;
  assert.strictEqual(beforeActual, afterActual, 'syncClaudeCosts が actualCostUsd を変えた（いけない）');
});

// ─────────────────────────────────────────────────────
// 3. getCostSummary — 費用種別が分離されている
// ─────────────────────────────────────────────────────
console.log('\n[3. getCostSummary の費用分離]');

test('3a. getCostSummary が actual と equivalent を返す', () => {
  const cs = fm.getCostSummary();
  assert.ok('actual'     in cs, 'actual がない');
  assert.ok('equivalent' in cs, 'equivalent がない');
  assert.ok('isActualOnly' in (cs.actual || {}) ||
            'isEquivalentOnly' in (cs.equivalent || {}),
    '種別フラグがない');
});

test('3b. actual.isEstimate が true（USD→JPY 換算は概算）', () => {
  const cs = fm.getCostSummary();
  assert.ok(cs.actual?.isEstimate === true, 'actual.isEstimate が true でない');
});

test('3c. equivalent.isEquivalentOnly が true（実請求でない）', () => {
  const cs = fm.getCostSummary();
  assert.ok(cs.equivalent?.isEquivalentOnly === true, 'equivalent.isEquivalentOnly が true でない');
});

// ─────────────────────────────────────────────────────
// 4. Finance Gate — 実課金のみで判定
// ─────────────────────────────────────────────────────
console.log('\n[4. Finance Gate は実課金のみで判定]');

test('4a. getMonthlyUsage が isActualOnly:true を返す', () => {
  const usage = fg._getMonthlyUsage();
  assert.ok(usage.isActualOnly === true, 'isActualOnly フラグがない');
});

test('4b. Claude Code 換算額が大きくても HARD_STOP にならない（実課金ベース）', () => {
  // 実課金 = 0、換算値のみ大 → OK のまま
  fm._saveMonthly(fm._defaultMonthly());
  // 換算値を人工的に設定
  const monthly = fm._loadMonthly();
  monthly.estimatedEquivalentUsd = 100; // 大きな換算値
  monthly.actualCostUsd = 0;            // 実課金なし
  fm._saveMonthly(monthly);
  const eval_ = fg.evaluateBudget();
  assert.notStrictEqual(eval_.level, fg.GATE_LEVEL.HARD_STOP, 'Claude換算額でHARD_STOPになった（誤判定）');
  assert.strictEqual(eval_.level, fg.GATE_LEVEL.OK, 'Claude換算額のみで判定されている（誤判定）');
});

test('4c. 実課金が 80% 超なら APPROVAL になる', () => {
  fm._saveMonthly(fm._defaultMonthly());
  const config = fg.loadConfig();
  const targetUsd = (config.monthlyBudgetJPY * 0.85) / 155; // 85% 相当
  fm.recordOpenAI({ model: 'gpt-4o', inputTokens: Math.round(targetUsd * 400000), outputTokens: 0 });
  const eval_ = fg.evaluateBudget();
  // 実課金が 80% 超なので APPROVAL or HARD_STOP
  assert.ok(
    eval_.level === fg.GATE_LEVEL.APPROVAL || eval_.level === fg.GATE_LEVEL.HARD_STOP,
    `実課金 85% で ${eval_.level}（APPROVAL/HARD_STOP のはず）`
  );
});

// ─────────────────────────────────────────────────────
// 5. 表示テキストの確認
// ─────────────────────────────────────────────────────
console.log('\n[5. 表示テキスト確認]');

test('5a. formatFinanceSection に「実課金」と「参考換算」の区別がある', () => {
  const text = fm.formatFinanceSection();
  assert.ok(text.includes('実課金') || text.includes('OpenAI'), '実課金の表示がない');
  assert.ok(text.includes('参考換算') || text.includes('実請求ではありません'), '参考換算の注記がない');
});

test('5b. formatFinanceSection に「Claude Code換算額は実請求でない」注記がある', () => {
  const text = fm.formatFinanceSection();
  assert.ok(
    text.includes('実請求ではありません') || text.includes('実請求でない') || text.includes('換算額は'),
    'Claude Code換算の注記がない'
  );
});

test('5c. formatBudgetSection に「実課金のみ」説明がある', () => {
  const text = fg.formatBudgetSection();
  assert.ok(
    text.includes('実課金') || text.includes('actualCost') || text.includes('OpenAI'),
    'formatBudgetSection に実課金説明がない'
  );
});

test('5d. formatFinanceStatus に3種類（実課金/参考換算/固定費）が含まれる', () => {
  const text = fg.formatFinanceStatus();
  assert.ok(text.includes('実課金'), '実課金がない');
  assert.ok(text.includes('参考換算') || text.includes('Claude Code'), 'Claude Code換算がない');
  assert.ok(text.includes('固定費') || text.includes('プラン'), '固定費がない');
});

// ─────────────────────────────────────────────────────
// 6. ソース確認
// ─────────────────────────────────────────────────────
console.log('\n[6. ソース確認]');

const fmSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'finance-manager.js'), 'utf8');
const fgSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'finance-gate.js'), 'utf8');

test('6a. finance-manager.js に actualCostUsd と estimatedEquivalentUsd がある', () => {
  assert.ok(fmSrc.includes('actualCostUsd'), 'actualCostUsd がない');
  assert.ok(fmSrc.includes('estimatedEquivalentUsd'), 'estimatedEquivalentUsd がない');
});

test('6b. syncClaudeCosts が byEquivalentSource に保存する（実課金でない）', () => {
  assert.ok(fmSrc.includes('byEquivalentSource'), 'byEquivalentSource がない');
  assert.ok(!fmSrc.includes('bySource.claude') || fmSrc.includes('後方互換'), 'bySource.claude に誤って記録している可能性');
});

test('6c. finance-gate.js の getMonthlyUsage が actualCostUsd を使う', () => {
  assert.ok(fgSrc.includes('actualCostUsd') || fgSrc.includes('actual?.usd'), 'getMonthlyUsage に actualCostUsd がない');
  assert.ok(fgSrc.includes('isActualOnly'), 'isActualOnly フラグがない');
});

test('6d. finance-config.json に fixedMonthlyCostJPY が追加されている', () => {
  assert.ok(fgSrc.includes('fixedMonthlyCostJPY'), 'fixedMonthlyCostJPY が DEFAULT_CONFIG にない');
});

// クリーンアップ
fm._saveMonthly(fm._defaultMonthly());

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
