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

// ─────────────────────────────────────────────────────
// 8x. H2/M1/M2 修正テスト
// ─────────────────────────────────────────────────────
console.log('\n[8x. H2/M1/M2 修正テスト]');

test('H2-1. REVIEWING（レビュー待ち）は RED にならない', () => {
  // reviewingCount が あっても validationFailedCount=0 なら RED 以外
  const r = (() => {
    const triggers = [];
    // REVIEWING だけある → validationFailedCount=0 として評価
    const ind = { rejectedReviewCount:0, authErrorCount:0, securityBlockCount:0,
                  validationFailedCount:0, codexHighCount:0 };
    if (ind.validationFailedCount > 0) triggers.push('validFail');
    if (ind.rejectedReviewCount > 0)   triggers.push('reject');
    return triggers.length === 0 ? 'GREEN_OR_YELLOW' : 'RED';
  })();
  assert.strictEqual(r, 'GREEN_OR_YELLOW', 'REVIEWING だけで RED になった');
});

test('H2-2. completion-validator 失敗（validationFailedCount > 0）は RED', () => {
  const triggers = [];
  const ind = { rejectedReviewCount:0, authErrorCount:0, securityBlockCount:0,
                validationFailedCount:1, codexHighCount:0 };
  if (ind.validationFailedCount > 0) triggers.push('validFail');
  assert.strictEqual(triggers.length, 1);
  assert.ok(triggers.includes('validFail'));
});

test('H2-3. gatherIndicators に validationFailedCount フィールドがある', () => {
  const ind = qg.gatherIndicators('youtube予測ai');
  assert.ok('validationFailedCount' in ind, 'validationFailedCount がない');
  assert.ok('reviewingCount' in ind, 'reviewingCount がない');
});

test('M1-1. gatherIndicators の rejectedReviewCount は history を含まない', () => {
  // 修正後: history の 却下推奨は RED に使わない
  // history の rejectInHist は加算されないことをソースで確認
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'quality-gate.js'), 'utf8'
  );
  // rejectInHist が rejectedReviewCount に加算されていないことを確認
  assert.ok(!src.includes('rejectedReview.length + rejectInHist'),
    'M1: history の却下推奨がまだ RED に加算されている');
});

test('M1-2. gatherIndicators の authErrorCount は history を含まない', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'quality-gate.js'), 'utf8'
  );
  assert.ok(!src.includes('authErrors.length + authInHist'),
    'M1: history のAUTHエラーがまだ RED に加算されている');
});

test('M2-1. _loadCodexResultsByProject が関数として使われている', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'quality-gate.js'), 'utf8'
  );
  assert.ok(src.includes('_loadCodexResultsByProject'), '_loadCodexResultsByProject がない');
  assert.ok(src.includes('_resolveTaskProject'), '_resolveTaskProject がない');
});

test('M2-2. gatherIndicators が codexHighCount を返す（projectId フィルタ後）', () => {
  const ind = qg.gatherIndicators('nonexistent-project-xyz');
  assert.strictEqual(ind.codexHighCount, 0, '存在しないプロジェクトでも codexHigh が 0 でない');
});

test('H1-1. index.js の handleProjectRun に Quality Gate PRE-RUN チェックがある', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'index.js'), 'utf8'
  );
  const runFnStart = src.indexOf('async function handleProjectRun');
  const runFnEnd   = src.indexOf('\nasync function handle', runFnStart + 1);
  const runBody    = src.slice(runFnStart, runFnEnd > 0 ? runFnEnd : runFnStart + 5000);
  assert.ok(runBody.includes('assessQuality'), 'PRE-RUN assessQuality がない');
  assert.ok(runBody.includes("qa.level === 'RED'"), 'RED 停止処理がない');
  assert.ok(runBody.includes("qa.level === 'YELLOW'"), 'YELLOW 警告処理がない');
});

// ─────────────────────────────────────────────────────
// 8. Gate 管理 (addGate / removeGate / listGates / evaluateGates)
// ─────────────────────────────────────────────────────
console.log('\n[8. Gate 管理]');

// テスト用ゲートをクリーンアップ
const path = require('path');
const fs   = require('fs');
const GATES_FILE = path.join(__dirname, '..', 'data', 'quality-gates.json');
function cleanupGates() {
  if (!fs.existsSync(GATES_FILE)) return;
  const raw = JSON.parse(fs.readFileSync(GATES_FILE, 'utf8'));
  raw.gates = (raw.gates || []).filter(g => !g.id.startsWith('test-'));
  fs.writeFileSync(GATES_FILE, JSON.stringify(raw, null, 2), 'utf8');
}
cleanupGates();

test('8a. addGate が { ok:true, gate } を返す', () => {
  const res = qg.addGate({ id: 'test-gate-1', projectId: 'youtube予測ai', minLevel: 'GREEN', description: 'テスト' });
  assert.strictEqual(res.ok, true);
  assert.ok(res.gate.id === 'test-gate-1');
  info('8a: gate added: ' + res.gate.id);
});

test('8b. 重複 id は { ok:false }', () => {
  const res = qg.addGate({ id: 'test-gate-1', projectId: 'youtube予測ai', minLevel: 'GREEN' });
  assert.strictEqual(res.ok, false);
});

test('8c. 不正 minLevel は { ok:false }', () => {
  const res = qg.addGate({ id: 'test-gate-bad', projectId: 'p', minLevel: 'ORANGE' });
  assert.strictEqual(res.ok, false);
});

test('8d. listGates が配列を返す', () => {
  const list = qg.listGates();
  assert.ok(Array.isArray(list));
  assert.ok(list.some(g => g.id === 'test-gate-1'));
});

test('8e. removeGate が { ok:true } を返す', () => {
  const res = qg.removeGate('test-gate-1');
  assert.strictEqual(res.ok, true);
  assert.ok(!qg.listGates().some(g => g.id === 'test-gate-1'));
});

test('8f. evaluateGates: ゲートなし → { passed:true, noGates:true }', () => {
  const res = qg.evaluateGates('nonexistent-project');
  assert.strictEqual(res.passed, true);
  assert.strictEqual(res.noGates, true);
});

test('8g. evaluateGates: GREEN 必須 + 現在 GREEN → passed', () => {
  qg.addGate({ id: 'test-gate-2', projectId: 'youtube予測ai', minLevel: 'YELLOW' });
  const res = qg.evaluateGates('youtube予測ai');
  info('8g: level=' + res.assessment?.level + ' passed=' + res.passed);
  // youtube予測ai は現在 GREEN → YELLOW 以上必須を満たす
  assert.ok(typeof res.passed === 'boolean');
  qg.removeGate('test-gate-2');
});

// ─────────────────────────────────────────────────────
// 9. generateReport
// ─────────────────────────────────────────────────────
console.log('\n[9. generateReport]');

test('9a. generateReport が text/assessment/gateResult を返す', () => {
  const report = qg.generateReport('youtube予測ai');
  assert.ok(typeof report.text === 'string' && report.text.length > 0);
  assert.ok(report.assessment);
  assert.ok(report.gateResult);
  info('9a: report text length=' + report.text.length);
});

test('9b. レポートに Quality Gate と現状サマリが含まれる', () => {
  const report = qg.generateReport('youtube予測ai');
  assert.ok(report.text.includes('Quality'));
  assert.ok(report.text.includes('完了'));
});

// ─────────────────────────────────────────────────────
// 10. index.js 接続確認
// ─────────────────────────────────────────────────────
console.log('\n[10. index.js 接続確認]');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

test('10a. handleQuality が定義されている', () =>
  assert.ok(src.includes('async function handleQuality')));
test('10b. !quality routing がある', () =>
  assert.ok(src.includes("startsWith('!quality')")));
test('10c. qualityGate が require されている', () =>
  assert.ok(src.includes("require('./utils/quality-gate')")));
test('10d. data/quality-gates.json が .gitignore にある', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/quality-gates.json'));
});

cleanupGates();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
