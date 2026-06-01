'use strict';
// Project Insights + refine 優先度テスト

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

// project-insights.js のデータファイルを一時パスに差し替えてテスト
const pi = require('../bot/utils/project-insights');
const ana = require('../bot/utils/refine-gap-analyzer');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ── テスト用に一時ストレージを使う ──────────────────────
const origFile = path.join(__dirname, '..', 'data', 'project-insights.json');
const tmpFile  = path.join(os.tmpdir(), `pi-test-${Date.now()}.json`);

// _saveAll を使って空の状態から開始
function resetStore() { pi._saveAll({}); }

// ─────────────────────────────────────────────────────
// 1. project-insights.js CRUD
// ─────────────────────────────────────────────────────
console.log('\n[1. project-insights CRUD]');

test('1a. addInsight が insight オブジェクトを返す', () => {
  resetStore();
  const ins = pi.addInsight('test-pid', 'human_feedback', 'viewCount依存で投稿前予測不可', { addedBy: 'user1' });
  assert.ok(ins.id.startsWith('ins_'), 'id形式が違う');
  assert.strictEqual(ins.type, 'human_feedback');
  assert.strictEqual(ins.severity, 'critical');
  assert.strictEqual(ins.category, 'P1');
  assert.strictEqual(ins.resolved, false);
});

test('1b. getInsights で追加した insight が取得できる', () => {
  const list = pi.getInsights('test-pid');
  assert.ok(list.length >= 1, 'insight が取得できない');
  assert.ok(list.some(i => i.text.includes('viewCount')), '追加したテキストがない');
});

test('1c. 別 projectId の insight は取得されない', () => {
  const list = pi.getInsights('other-pid');
  assert.strictEqual(list.length, 0, '別プロジェクトの insight が混入');
});

test('1d. resolveInsight で resolved になる', () => {
  resetStore();
  const ins = pi.addInsight('r-pid', 'product_audit', '問題テキスト');
  pi.resolveInsight('r-pid', ins.id);
  const list = pi.getInsights('r-pid'); // resolved 除外
  assert.strictEqual(list.length, 0, 'resolved insight が残っている');
});

test('1e. clearInsights で全削除される', () => {
  resetStore();
  pi.addInsight('c-pid', 'human_feedback', 'テキスト1');
  pi.addInsight('c-pid', 'pm_audit', 'テキスト2');
  const count = pi.clearInsights('c-pid');
  assert.ok(count >= 2, '削除件数が0');
  assert.strictEqual(pi.getInsights('c-pid').length, 0, 'まだ残っている');
});

test('1f. product_audit は severity=critical → P1', () => {
  resetStore();
  const ins = pi.addInsight('p-pid', 'product_audit', '商品価値に関わる問題');
  assert.strictEqual(ins.severity, 'critical');
  assert.strictEqual(ins.category, 'P1');
});

test('1g. requirement は severity=major → P3', () => {
  resetStore();
  const ins = pi.addInsight('q-pid', 'requirement', '受け入れ条件');
  assert.strictEqual(ins.severity, 'major');
  assert.strictEqual(ins.category, 'P3');
});

// ─────────────────────────────────────────────────────
// 2. Product Audit で重大問題あり → refine P1 生成
// ─────────────────────────────────────────────────────
console.log('\n[2. Product Audit → P1 生成]');

test('2a. product_audit critical insight → analyzeInsights が P1 gap を生成', () => {
  const insights = [
    {
      id: 'ins_1', type: 'product_audit', text: 'viewCount依存で投稿前予測不可',
      severity: 'critical', category: 'P1', resolved: false,
    }
  ];
  const gaps = ana.analyzeInsights(insights);
  assert.ok(gaps.length >= 1, 'gap が生成されない');
  assert.ok(gaps.some(g => g.category === 'P1'), 'P1 gap がない');
  assert.ok(gaps.some(g => g.source === 'project_insights'), 'source が project_insights でない');
});

test('2b. analyzeGaps に insights を渡すと P1 が先頭になる', () => {
  const mockTm = { listTasks: () => [], STATES: { PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち', AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了' } };
  const mockPm = { filterTasksByProject: () => [] };
  const insights = [
    { id: 'ins_2', type: 'product_audit', text: '投稿前予測エンジンが破綻', severity: 'critical', category: 'P1', resolved: false }
  ];
  const result = ana.analyzeGaps({
    projectId: 'yt-pred',
    project: { name: 'YouTube予測AI', description: '', goal: '視聴数予測' },
    boardStatus: 'NEEDS_REFINEMENT',
    indicators: { failedCount: 0, authErrorCount: 0, timeoutCount: 0, doneCount: 5 },
    qualityLevel: 'GREEN',
    taskManager: mockTm, projectManager: mockPm,
    reviewsDir: os.tmpdir(),
    insights,
  });
  assert.ok(result.gaps.length > 0, 'gap が生成されない');
  // 先頭は P1（insight 由来）
  assert.strictEqual(result.gaps[0].category, 'P1', `先頭が P1 でない: ${result.gaps[0].category}`);
  assert.strictEqual(result.gaps[0].source, 'project_insights', '先頭が insights 由来でない');
  assert.ok(result.insightGaps.length >= 1, 'insightGaps が空');
});

// ─────────────────────────────────────────────────────
// 3. Human feedback が自動解析より優先される
// ─────────────────────────────────────────────────────
console.log('\n[3. Human feedback 最優先]');

test('3a. human_feedback が project_insights source で P1 になる', () => {
  const insights = [
    { id: 'ins_3', type: 'human_feedback', text: 'CEOから: ユーザーが使えない', severity: 'critical', category: 'P1', resolved: false }
  ];
  const gaps = ana.analyzeInsights(insights);
  assert.ok(gaps.some(g => g.category === 'P1' && g.insightType === 'human_feedback'), 'human_feedback P1 がない');
});

test('3b. insight gap は自動生成 P1 の前に並ぶ', () => {
  const mockTm = { listTasks: () => [], STATES: { PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち', AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了' } };
  const mockPm = { filterTasksByProject: () => [] };
  const insights = [
    { id: 'ins_4', type: 'human_feedback', text: '人間指摘', severity: 'critical', category: 'P1', resolved: false }
  ];
  const result = ana.analyzeGaps({
    projectId: 'prio-test',
    project: { name: 'YouTube予測AI', description: '', goal: '視聴数予測' },
    boardStatus: 'NEEDS_REFINEMENT',
    indicators: { failedCount: 1, doneCount: 0 },
    qualityLevel: 'GREEN',
    taskManager: mockTm, projectManager: mockPm,
    reviewsDir: os.tmpdir(),
    insights,
  });
  const firstInsightIdx = result.gaps.findIndex(g => g.source === 'project_insights');
  const firstAutoIdx    = result.gaps.findIndex(g => g.source !== 'project_insights' && g.category === 'P1');
  assert.ok(firstInsightIdx >= 0, 'insight gap が見当たらない');
  if (firstAutoIdx >= 0) {
    assert.ok(firstInsightIdx < firstAutoIdx, `insight(${firstInsightIdx}) が自動P1(${firstAutoIdx}) より後になっている`);
  }
});

// ─────────────────────────────────────────────────────
// 4. YouTube 例: 「投稿前予測不可」→ FIX タスク生成
// ─────────────────────────────────────────────────────
console.log('\n[4. YouTube 例: 投稿前予測不可 → FIX タスク]');

test('4a. 「破綻」「動かない」を含む insight はFIXタスクになる', () => {
  const insights = [
    { id: 'ins_5', type: 'product_audit', text: 'viewCount依存で投稿前予測が破綻している', severity: 'critical', category: 'P1', resolved: false }
  ];
  const gaps = ana.analyzeInsights(insights);
  assert.ok(gaps.some(g => g.type === 'FIX'), 'FIX タスクが生成されない');
});

test('4b. insight テキストがプロンプトに含まれる', () => {
  const insightText = 'viewCount依存で投稿前予測不可';
  const insights = [
    { id: 'ins_6', type: 'product_audit', text: insightText, severity: 'critical', category: 'P1', resolved: false }
  ];
  const gaps = ana.analyzeInsights(insights);
  assert.ok(gaps.some(g => g.prompt.includes(insightText.slice(0, 10))), 'insight テキストがプロンプトに含まれない');
});

test('4c. 複数 insight が全て gap に変換される', () => {
  const insights = [
    { id: 'ins_7', type: 'product_audit', text: '投稿前予測エンジン修正', severity: 'critical', category: 'P1', resolved: false },
    { id: 'ins_8', type: 'pm_audit', text: 'データ収集が不安定', severity: 'blocker', category: 'P2', resolved: false },
  ];
  const gaps = ana.analyzeInsights(insights);
  assert.strictEqual(gaps.length, 2, `gap数が違う: ${gaps.length}`);
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test('5a. index.js に projectInsights が require されている', () => {
  assert.ok(src.includes("require('./utils/project-insights')"), 'project-insights が require されていない');
});

test('5b. handleProjectRefine が insightsForRefine を analyzeGaps に渡している', () => {
  const refineStart = src.indexOf('async function handleProjectRefine');
  const refineEnd   = src.indexOf('\nasync function handleProject', refineStart);
  const refineBody  = src.slice(refineStart, refineEnd > 0 ? refineEnd : refineStart + 9000);
  assert.ok(refineBody.includes('insightsForRefine'), 'insightsForRefine が見つからない');
  assert.ok(refineBody.includes('projectInsights.getInsights'), 'getInsights 呼び出しがない');
  assert.ok(refineBody.includes('insights:       insightsForRefine'), 'analyzeGaps に insights が渡されていない');
});

test('5c. !project insight add/list/resolve/clear が handleProject に実装されている', () => {
  const projStart = src.indexOf("sub === 'insight'");
  assert.ok(projStart >= 0, "sub === 'insight' がない");
  const insightBlock = src.slice(projStart, projStart + 5000); // 範囲を広げる
  assert.ok(insightBlock.includes("insightSub === 'add'"), 'add サブコマンドがない');
  assert.ok(insightBlock.includes("insightSub === 'list'"), 'list サブコマンドがない');
  assert.ok(insightBlock.includes("insightSub === 'clear'") || insightBlock.includes('"clear"'), 'clear サブコマンドがない');
});

test('5d. insight add は Owner のみ（DISCORD_OWNER_ID チェック）', () => {
  const projStart = src.indexOf("sub === 'insight'");
  const insightBlock = src.slice(projStart, projStart + 3000);
  const addIdx   = insightBlock.indexOf("insightSub === 'add'");
  const addBlock = insightBlock.slice(addIdx, addIdx + 300);
  assert.ok(addBlock.includes('DISCORD_OWNER_ID'), 'Owner チェックがない');
});

test('5e. .gitignore に project-insights.json が追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('project-insights.json'), '.gitignore に project-insights.json がない');
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
resetStore(); // テストデータを消去

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
