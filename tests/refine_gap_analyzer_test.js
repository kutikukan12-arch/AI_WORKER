'use strict';
// !project refine Gap 分析テスト

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

const analyzer = require('../bot/utils/refine-gap-analyzer');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ── モック ──────────────────────────────────────────
const mockTm = {
  listTasks: () => [],
  STATES: { PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち',
            AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了' },
};
const mockPm = { filterTasksByProject: () => [] };
const tmpReviewsDir = path.join(os.tmpdir(), `reviews-test-${Date.now()}`);
fs.mkdirSync(tmpReviewsDir, { recursive: true });

// ── テスト用 REVIEW 結果ファイルを作成 ───────────────
const HIGH_REVIEW_FILE = path.join(tmpReviewsDir, 'result_task_test001.md');
fs.writeFileSync(HIGH_REVIEW_FILE, `# Codex レビュー結果: task_test001
| 項目 | 内容 |
|------|------|
| 危険度   | 🔴 高 |
## 問題点
セキュリティ上の問題があります。SQLインジェクションの可能性。
## 改善案
パラメータ化クエリを使用してください。`);

const LOW_REVIEW_FILE = path.join(tmpReviewsDir, 'result_task_test002.md');
fs.writeFileSync(LOW_REVIEW_FILE, `# Codex レビュー結果: task_test002
| 項目 | 内容 |
|------|------|
| 危険度   | 🟢 低 |
## 問題点
（なし）`);

// ─────────────────────────────────────────────────────
// 1. P1 コア価値未達の検出
// ─────────────────────────────────────────────────────
console.log('\n[1. P1 コア価値未達の検出]');

test('1a. 予測AI プロジェクトで投稿前予測が未実装なら P1 が生成される', () => {
  const gaps = analyzer._analyzeP1CoreValue(
    'youtube予測ai',
    { name: 'YouTube予測AI', description: '', goal: '視聴数予測' },
    new Set(['IMPLEMENT']),
    ['APIから動画データ収集する'], // 投稿前予測の記述なし
    'NEEDS_REFINEMENT',
    { doneCount: 5, failedCount: 0 }
  );
  assert.ok(gaps.length > 0, 'P1 gap が生成されない');
  assert.ok(gaps.some(g => g.category === 'P1'), 'カテゴリが P1 でない');
  assert.ok(gaps.some(g => /投稿前|予測/.test(g.prompt)), '投稿前予測タスクが含まれない');
});

test('1b. 完了0件 + BLOCKED なら MVP タスクが P1 で生成される', () => {
  const gaps = analyzer._analyzeP1CoreValue(
    'test-project',
    { name: 'テストプロジェクト', description: '', goal: '' },
    new Set([]),
    [],
    'BLOCKED',
    { doneCount: 0, failedCount: 0 }
  );
  assert.ok(gaps.some(g => g.category === 'P1' && /MVP/.test(g.prompt)), 'MVP タスクが生成されない');
});

// ─────────────────────────────────────────────────────
// 2. P2 致命的不具合の検出
// ─────────────────────────────────────────────────────
console.log('\n[2. P2 致命的不具合の検出]');

test('2a. failedCount>0 なら P2 FIX タスクが生成される', () => {
  const gaps = analyzer._analyzeP2Blockers(
    { failedCount: 3, authErrorCount: 0, timeoutCount: 0 },
    [],
    'GREEN'
  );
  assert.ok(gaps.some(g => g.category === 'P2' && g.type === 'FIX'), 'P2 FIX タスクがない');
});

test('2b. Quality RED なら P2 FIX タスクが生成される', () => {
  const gaps = analyzer._analyzeP2Blockers(
    { failedCount: 0, authErrorCount: 0, timeoutCount: 0 },
    [],
    'RED'
  );
  assert.ok(gaps.some(g => g.category === 'P2'), 'P2 タスクが生成されない');
});

test('2c. REVIEW 高危険度問題 → P2 FIX タスクが生成される', () => {
  const issues = [{ taskId: 'task_001', danger: '高', problem: 'SQLインジェクション' }];
  const gaps   = analyzer._analyzeP2Blockers(
    { failedCount: 0, authErrorCount: 0, timeoutCount: 0 },
    issues,
    'GREEN'
  );
  assert.ok(gaps.some(g => g.category === 'P2' && g.source === 'review_result'), 'REVIEW由来のP2タスクがない');
});

// ─────────────────────────────────────────────────────
// 3. P3 受け入れ条件不足
// ─────────────────────────────────────────────────────
console.log('\n[3. P3 受け入れ条件不足]');

test('3a. TEST タスクが未完了なら P3 TEST タスクが生成される', () => {
  const gaps = analyzer._analyzeP3AcceptanceCriteria(
    new Set(['IMPLEMENT']), // TEST がない
    ['何かを実装した']
  );
  assert.ok(gaps.some(g => g.category === 'P3' && g.type === 'TEST'), 'P3 TEST タスクがない');
});

test('3b. REVIEW が未完了なら P3 REVIEW タスクが生成される', () => {
  const gaps = analyzer._analyzeP3AcceptanceCriteria(
    new Set(['IMPLEMENT']), // REVIEW がない
    []
  );
  assert.ok(gaps.some(g => g.category === 'P3' && g.type === 'REVIEW'), 'P3 REVIEW タスクがない');
});

test('3c. DOCS が未完了なら README タスクが生成される', () => {
  const gaps = analyzer._analyzeP3AcceptanceCriteria(
    new Set(['IMPLEMENT']),
    [] // readme の記述なし
  );
  assert.ok(gaps.some(g => g.category === 'P3' && g.type === 'DOCS'), 'P3 DOCS タスクがない');
});

test('3d. 全て揃っている場合は P3 が生成されない', () => {
  const gaps = analyzer._analyzeP3AcceptanceCriteria(
    new Set(['IMPLEMENT', 'TEST', 'REVIEW', 'DOCS']),
    ['readme セットアップ手順', 'test ユニットテスト', 'review codex']
  );
  assert.strictEqual(gaps.length, 0, 'P3 タスクが不要なのに生成された');
});

// ─────────────────────────────────────────────────────
// 4. 優先順位ソート
// ─────────────────────────────────────────────────────
console.log('\n[4. 優先順位ソート確認]');

test('4a. analyzeGaps の結果が P1→P2→P3 順にソートされる', () => {
  const result = analyzer.analyzeGaps({
    projectId:      'sort-test',
    project:        { name: 'YouTube予測AI', description: '', goal: '視聴数予測' },
    boardStatus:    'BLOCKED',
    indicators:     { failedCount: 2, authErrorCount: 0, timeoutCount: 0, doneCount: 3 },
    qualityLevel:   'RED',
    taskManager:    mockTm,
    projectManager: mockPm,
    reviewsDir:     tmpReviewsDir,
  });
  const { gaps } = result;
  assert.ok(gaps.length > 0, 'gap が生成されない');
  // 先頭が P1 または P2 でなければならない
  const firstRank = gaps[0].categoryRank;
  assert.ok(firstRank <= 2, `先頭の gap が P3以下（rank=${firstRank}）`);
  // ソート順の確認（後ろのものが前より rank が大きいか等しい）
  for (let i = 0; i < gaps.length - 1; i++) {
    assert.ok(
      gaps[i].categoryRank <= gaps[i + 1].categoryRank,
      `ソート崩れ: ${gaps[i].categoryRank} > ${gaps[i+1].categoryRank}`
    );
  }
});

test('4b. タスク0件プロジェクトでも gap が生成される（完成≠0件）', () => {
  const result = analyzer.analyzeGaps({
    projectId:      'empty-project',
    project:        { name: 'Empty Project', description: '何かを作る', goal: '' },
    boardStatus:    'NEEDS_REFINEMENT',
    indicators:     { failedCount: 0, authErrorCount: 0, timeoutCount: 0, doneCount: 0 },
    qualityLevel:   'GREEN',
    taskManager:    { listTasks: () => [], STATES: mockTm.STATES },
    projectManager: mockPm,
    reviewsDir:     tmpReviewsDir,
  });
  assert.ok(result.gaps.length > 0, 'タスク0件なのに gap が生成されない（目的差分から生成すべき）');
});

// ─────────────────────────────────────────────────────
// 5. REVIEW 結果ファイルの走査
// ─────────────────────────────────────────────────────
console.log('\n[5. REVIEW 結果ファイル走査]');

test('5a. 高危険度 REVIEW 結果ファイルが検出される', () => {
  const issues = analyzer._collectReviewIssues(tmpReviewsDir, 'any', mockTm, mockPm);
  assert.ok(issues.length >= 1, '高危険度 REVIEW が検出されない');
  assert.ok(issues.some(i => i.danger === '高'), '高危険度が含まれない');
});

test('5b. 低危険度 REVIEW は除外される', () => {
  const issues = analyzer._collectReviewIssues(tmpReviewsDir, 'any', mockTm, mockPm);
  assert.ok(!issues.some(i => i.danger === '低'), '低危険度が混入している');
});

// ─────────────────────────────────────────────────────
// 6. index.js のソース確認（統合確認）
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test('6a. handleProjectRefine が refineGapAnalyzer.analyzeGaps を呼ぶ', () => {
  const refineStart = src.indexOf('async function handleProjectRefine');
  const refineEnd   = src.indexOf('\nasync function handleProject', refineStart);
  const refineBody  = src.slice(refineStart, refineEnd > 0 ? refineEnd : refineStart + 8000);
  assert.ok(refineBody.includes('refineGapAnalyzer.analyzeGaps'), 'analyzeGaps が呼ばれていない');
});

test('6b. gap 結果が planProjectGoalsBest と合流している', () => {
  const refineStart = src.indexOf('async function handleProjectRefine');
  const refineEnd   = src.indexOf('\nasync function handleProject', refineStart);
  const refineBody  = src.slice(refineStart, refineEnd > 0 ? refineEnd : refineStart + 8000);
  assert.ok(refineBody.includes('planProjectGoalsBest'), 'planner との合流がない');
  assert.ok(refineBody.includes('merged'), 'マージ処理がない');
});

test('6c. _formatRefinePlan が categoryLabel を表示する', () => {
  const fmtIdx  = src.indexOf('function _formatRefinePlan');
  const fmtEnd  = src.indexOf('\n// ─', fmtIdx + 1);
  const fmtBody = src.slice(fmtIdx, fmtEnd > 0 ? fmtEnd : fmtIdx + 1500);
  assert.ok(fmtBody.includes('categoryLabel') || fmtBody.includes('CAT_EMOJI'), 'カテゴリ表示がない');
  assert.ok(fmtBody.includes('優先度高'), '優先度ヘッダーがない');
});

test('6d. 安全条件（pendingPlans / security.checkPrompt）は変更なし', () => {
  const refineStart = src.indexOf('async function handleProjectRefine');
  const refineEnd   = src.indexOf('\nasync function handleProject', refineStart);
  const refineBody  = src.slice(refineStart, refineEnd > 0 ? refineEnd : refineStart + 8000);
  assert.ok(refineBody.includes('security.checkPrompt'), 'セキュリティチェックがない');
  assert.ok(refineBody.includes('createPlan'), 'pendingPlans.createPlan がない');
  assert.ok(refineBody.includes('MAX_TASKS') || refineBody.includes('MAX = pendingPlans'), '20件上限がない');
});

// クリーンアップ
try {
  fs.unlinkSync(HIGH_REVIEW_FILE);
  fs.unlinkSync(LOW_REVIEW_FILE);
  fs.rmdirSync(tmpReviewsDir);
} catch { /* ignore */ }

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
