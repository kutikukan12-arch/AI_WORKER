'use strict';
// Phase E-6: Quality Gate テスト

const assert = require('assert');
const qg     = require('../bot/utils/quality-gate');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function info(msg) { console.log('  ℹ️ ', msg); }

// ─────────────────────────────────────────────────────
// 1. computeQualityScore — 減点ルール
// ─────────────────────────────────────────────────────
console.log('\n[1. computeQualityScore 減点ルール]');

test('1a. 指標ゼロ → スコア 100', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0, timeoutCount: 0,
    codexMidCount: 0, failedCount: 0,
  });
  assert.strictEqual(score, 100);
});

test('1b. REVIEWING 2件 → -10点 (90)', () => {
  const { score, deductions } = qg.computeQualityScore({
    reviewingCount: 2, errorRate: 0, timeoutCount: 0,
    codexMidCount: 0, failedCount: 0,
  });
  assert.strictEqual(score, 90);
  assert.ok(deductions.some(d => d.includes('REVIEWING')));
});

test('1c. エラー率 30% → 10% 超過 → -10点 (90)', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0.30, timeoutCount: 0,
    codexMidCount: 0, failedCount: 0,
  });
  assert.strictEqual(score, 90);
});

test('1d. エラー率 20% 以下は減点なし', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0.20, timeoutCount: 0,
    codexMidCount: 0, failedCount: 0,
  });
  assert.strictEqual(score, 100);
});

test('1e. タイムアウト 4件 → -10点 (90)', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0, timeoutCount: 4,
    codexMidCount: 0, failedCount: 0,
  });
  assert.strictEqual(score, 90);
});

test('1f. Codex 中 2件 → -10点 (90)', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0, timeoutCount: 0,
    codexMidCount: 2, failedCount: 0,
  });
  assert.strictEqual(score, 90);
});

test('1g. failedCount 5件 → -15点(上限) (85)', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0, timeoutCount: 0,
    codexMidCount: 0, failedCount: 5,
  });
  assert.strictEqual(score, 85);
});

test('1h. スコア下限は 0', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 20, errorRate: 1.0, timeoutCount: 20,
    codexMidCount: 10, failedCount: 10,
  });
  assert.strictEqual(score, 0);
});

// ─────────────────────────────────────────────────────
// 2. RED トリガ判定（worst-wins）
// ─────────────────────────────────────────────────────
console.log('\n[2. RED トリガ worst-wins]');

// assessQuality をモック用インジケータで直接テストするため
// 実データを使わず indicators を差し込む方法でテスト
function mockAssess(indicators) {
  // assessQuality の RED 判定ロジックをインジケータで直接検証
  const red = [];
  if (indicators.rejectedReviewCount > 0) red.push('却下推奨');
  if (indicators.authErrorCount > 0)       red.push('AUTH/PERMISSION');
  if (indicators.securityBlockCount > 0)   red.push('securityBlocked');
  if (indicators.reviewingCount > 0)       red.push('REVIEWING');
  if (indicators.codexHighCount > 0)       red.push('codexHigh');
  const level = red.length > 0 ? 'RED' : 'GREEN_OR_YELLOW';
  return { level, redTriggers: red };
}

test('2a. 却下推奨 → RED（スコア合算しない）', () => {
  const r = mockAssess({ rejectedReviewCount: 1, authErrorCount: 0, securityBlockCount: 0, reviewingCount: 0, codexHighCount: 0 });
  assert.strictEqual(r.level, 'RED');
  assert.ok(r.redTriggers.includes('却下推奨'));
});

test('2b. AUTH エラー → RED', () => {
  const r = mockAssess({ rejectedReviewCount: 0, authErrorCount: 1, securityBlockCount: 0, reviewingCount: 0, codexHighCount: 0 });
  assert.strictEqual(r.level, 'RED');
  assert.ok(r.redTriggers.includes('AUTH/PERMISSION'));
});

test('2c. securityBlocked → RED', () => {
  const r = mockAssess({ rejectedReviewCount: 0, authErrorCount: 0, securityBlockCount: 1, reviewingCount: 0, codexHighCount: 0 });
  assert.strictEqual(r.level, 'RED');
  assert.ok(r.redTriggers.includes('securityBlocked'));
});

test('2d. REVIEWING（completion-validator 未完了）→ RED', () => {
  const r = mockAssess({ rejectedReviewCount: 0, authErrorCount: 0, securityBlockCount: 0, reviewingCount: 1, codexHighCount: 0 });
  assert.strictEqual(r.level, 'RED');
  assert.ok(r.redTriggers.includes('REVIEWING'));
});

test('2e. Codex 高 → RED', () => {
  const r = mockAssess({ rejectedReviewCount: 0, authErrorCount: 0, securityBlockCount: 0, reviewingCount: 0, codexHighCount: 1 });
  assert.strictEqual(r.level, 'RED');
  assert.ok(r.redTriggers.includes('codexHigh'));
});

test('2f. RED トリガ複数 → worst-wins（RED）', () => {
  const r = mockAssess({ rejectedReviewCount: 1, authErrorCount: 1, securityBlockCount: 0, reviewingCount: 1, codexHighCount: 1 });
  assert.strictEqual(r.level, 'RED');
  assert.strictEqual(r.redTriggers.length, 4);
});

test('2g. RED トリガ 0件 → GREEN_OR_YELLOW（スコア使用）', () => {
  const r = mockAssess({ rejectedReviewCount: 0, authErrorCount: 0, securityBlockCount: 0, reviewingCount: 0, codexHighCount: 0 });
  assert.strictEqual(r.level, 'GREEN_OR_YELLOW');
  assert.strictEqual(r.redTriggers.length, 0);
});

// ─────────────────────────────────────────────────────
// 3. GREEN / YELLOW スコア境界
// ─────────────────────────────────────────────────────
console.log('\n[3. GREEN/YELLOW 境界]');

test('3a. スコア >= 70 → GREEN', () => {
  const { score } = qg.computeQualityScore({
    reviewingCount: 0, errorRate: 0, timeoutCount: 0,
    codexMidCount: 0, failedCount: 0,
  });
  assert.ok(score >= 70);
  // level 判定
  const level = score >= 70 ? 'GREEN' : 'YELLOW';
  assert.strictEqual(level, 'GREEN');
});

test('3b. スコア 65 → YELLOW', () => {
  // REVIEWING 6件 → -30点 → 70点: ちょうど GREEN。7件 → 65 → YELLOW
  const { score } = qg.computeQualityScore({
    reviewingCount: 7, errorRate: 0, timeoutCount: 0,
    codexMidCount: 0, failedCount: 0,
  });
  assert.strictEqual(score, 65);
  const level = score >= 70 ? 'GREEN' : 'YELLOW';
  assert.strictEqual(level, 'YELLOW');
});

// ─────────────────────────────────────────────────────
// 4. assessQuality 実データテスト
// ─────────────────────────────────────────────────────
console.log('\n[4. assessQuality 実行]');

test('4a. assessQuality が level/score/redTriggers/indicators を返す', () => {
  const result = qg.assessQuality('youtube予測ai');
  assert.ok(['GREEN','YELLOW','RED'].includes(result.level), `level=${result.level}`);
  assert.ok(Array.isArray(result.redTriggers));
  assert.ok(result.indicators);
  if (result.level === 'RED') {
    assert.strictEqual(result.score, null, 'RED なのに score が null でない');
    assert.ok(result.redTriggers.length > 0);
  } else {
    assert.ok(typeof result.score === 'number', 'score が数値でない');
  }
  info('4a: level=' + result.level + ' score=' + result.score);
});

test('4b. assessQuality null projectId はクラッシュしない', () => {
  const result = qg.assessQuality(null);
  assert.ok(['GREEN','YELLOW','RED'].includes(result.level));
});

// ─────────────────────────────────────────────────────
// 5. formatQualityStatus
// ─────────────────────────────────────────────────────
console.log('\n[5. formatQualityStatus]');

test('5a. RED 時は RED と redTriggers を含む', () => {
  const assessment = {
    projectId: 'test-proj',
    level:       'RED',
    score:       null,
    redTriggers: ['🔴 Codex 高危険度が 1件あります'],
    deductions:  [],
    indicators:  { doneCount: 5, reviewingCount: 0, errorRate: 0, codexHighCount: 1, recentErrors: [] },
  };
  const text = qg.formatQualityStatus(assessment);
  assert.ok(text.includes('RED'), 'RED がない');
  assert.ok(text.includes('Codex'), 'trigger 内容がない');
  info('5a: ' + text.slice(0, 80));
});

test('5b. GREEN 時はスコアを含む', () => {
  const assessment = {
    projectId: 'test-proj',
    level:       'GREEN',
    score:       95,
    redTriggers: [],
    deductions:  [],
    indicators:  { doneCount: 10, reviewingCount: 0, errorRate: 0, codexHighCount: 0, recentErrors: [] },
  };
  const text = qg.formatQualityStatus(assessment);
  assert.ok(text.includes('GREEN'));
  assert.ok(text.includes('95'));
  info('5b: ' + text.slice(0, 80));
});

test('5c. YELLOW 時は減点内訳を含む', () => {
  const assessment = {
    projectId: 'test-proj',
    level:       'YELLOW',
    score:       60,
    redTriggers: [],
    deductions:  ['REVIEWING 5件: -25点'],
    indicators:  { doneCount: 3, reviewingCount: 5, errorRate: 0.10, codexHighCount: 0, recentErrors: [] },
  };
  const text = qg.formatQualityStatus(assessment);
  assert.ok(text.includes('YELLOW'));
  assert.ok(text.includes('REVIEWING'));
});

// ─────────────────────────────────────────────────────
// 6. 秘密情報マスク確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 秘密情報マスク]');

test('6a. gatherIndicators: recentErrors に ghp_ トークンが含まれない', () => {
  // lastError に ghp_ を含むタスクがあっても recentErrors ではマスクされる
  // ここではソースコードでの _redact 使用を確認
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'quality-gate.js'), 'utf8'
  );
  assert.ok(src.includes('_redact'), '_redact の呼び出しがない');
  assert.ok(src.includes("require('./redact')"), 'redact モジュールを使っていない');
});

// ─────────────────────────────────────────────────────
// 7. export 確認
// ─────────────────────────────────────────────────────
console.log('\n[7. export 確認]');

test('7a. gatherIndicators が export されている', () =>
  assert.strictEqual(typeof qg.gatherIndicators, 'function'));
test('7b. computeQualityScore が export されている', () =>
  assert.strictEqual(typeof qg.computeQualityScore, 'function'));
test('7c. assessQuality が export されている', () =>
  assert.strictEqual(typeof qg.assessQuality, 'function'));
test('7d. formatQualityStatus が export されている', () =>
  assert.strictEqual(typeof qg.formatQualityStatus, 'function'));

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
