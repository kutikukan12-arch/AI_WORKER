'use strict';
// CEO Report テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const cr  = require('../bot/utils/ceo-report');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─── モック用ミニマル taskManager / projectManager ───────
const mockTm = {
  listTasks: () => [],
  STATES: {
    PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち',
    AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了',
  },
};
const mockPm = { filterTasksByProject: () => [] };

// ─────────────────────────────────────────────────────
// 1. boardStatusToExecStatus — ステータス変換
// ─────────────────────────────────────────────────────
console.log('\n[1. boardStatus → execStatus 変換]');

test('1a. BLOCKED → EXEC_STATUS.BLOCKED（失敗あり）', () => {
  const s = cr._boardStatusToExecStatus(
    'BLOCKED',
    { tasksFailed: 2, stopReason: 'consecutive_errors' },
    { awaiting: 0 }
  );
  assert.strictEqual(s, cr.EXEC_STATUS.BLOCKED);
});

test('1b. BLOCKED + awaiting>0 → NEED_HUMAN_DECISION', () => {
  const s = cr._boardStatusToExecStatus(
    'BLOCKED',
    { tasksFailed: 0, stopReason: 'awaiting_human' },
    { awaiting: 1 }
  );
  assert.strictEqual(s, cr.EXEC_STATUS.NEED_HUMAN_DECISION);
});

test('1c. NEEDS_REVIEW → NEED_HUMAN_DECISION', () => {
  const s = cr._boardStatusToExecStatus('NEEDS_REVIEW', { tasksFailed: 0, stopReason: '' }, { awaiting: 0 });
  assert.strictEqual(s, cr.EXEC_STATUS.NEED_HUMAN_DECISION);
});

test('1d. NEEDS_REFINEMENT → CONTINUE_DEVELOPMENT', () => {
  const s = cr._boardStatusToExecStatus('NEEDS_REFINEMENT', { tasksFailed: 0, stopReason: 'project_done' }, { awaiting: 0 });
  assert.strictEqual(s, cr.EXEC_STATUS.CONTINUE_DEVELOPMENT);
});

test('1e. RELEASE_READY → EXEC_STATUS.RELEASE_READY', () => {
  const s = cr._boardStatusToExecStatus('RELEASE_READY', { tasksFailed: 0, stopReason: 'project_done' }, { awaiting: 0 });
  assert.strictEqual(s, cr.EXEC_STATUS.RELEASE_READY);
});

// ─────────────────────────────────────────────────────
// 2. Runner 完了後 report 生成（正常系）
// ─────────────────────────────────────────────────────
console.log('\n[2. Runner 完了後レポート生成]');

test('2a. generateCeoReport が report オブジェクトを返す', () => {
  const report = cr.generateCeoReport(
    'test-project',
    { tasksDone: 5, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
    { level: 'GREEN', score: 90, redTriggers: [] },
    'NEEDS_REFINEMENT',
    mockTm, mockPm
  );
  assert.ok(report.projectId === 'test-project');
  assert.ok(report.execStatus);
  assert.ok(report.roles);
  assert.ok(report.nextActions);
  assert.ok(report.gptCopy);
  assert.ok(report.generatedAt);
});

test('2b. project_done は CONTINUE_DEVELOPMENT になる', () => {
  const report = cr.generateCeoReport(
    'test-project',
    { tasksDone: 5, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
    { level: 'GREEN', score: 90, redTriggers: [] },
    'NEEDS_REFINEMENT',
    mockTm, mockPm
  );
  assert.strictEqual(report.execStatus, cr.EXEC_STATUS.CONTINUE_DEVELOPMENT);
});

test('2c. 全パート（Part1 / Part2 / Part3）が文字列を返す', () => {
  const report = cr.generateCeoReport(
    'test-project',
    { tasksDone: 3, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
    { level: 'GREEN', score: 88, redTriggers: [] },
    'NEEDS_REFINEMENT',
    mockTm, mockPm
  );
  const p1 = cr.formatCeoReportPart1(report);
  const p2 = cr.formatCeoReportPart2(report);
  const p3 = cr.formatCeoReportPart3(report);
  assert.ok(typeof p1 === 'string' && p1.length > 10, 'Part1 が空');
  assert.ok(typeof p2 === 'string' && p2.length > 10, 'Part2 が空');
  assert.ok(typeof p3 === 'string' && p3.length > 10, 'Part3 が空');
});

// ─────────────────────────────────────────────────────
// 3. エラー時も生成される（BLOCKED ケース）
// ─────────────────────────────────────────────────────
console.log('\n[3. エラー時（BLOCKED）でもレポート生成]');

test('3a. tasksFailed>0 の report が BLOCKED になる', () => {
  const report = cr.generateCeoReport(
    'test-project',
    { tasksDone: 2, tasksFailed: 3, stopReason: 'consecutive_errors_3', yellowCount: 0 },
    { level: 'GREEN', score: 70, redTriggers: [] },
    'BLOCKED',
    mockTm, mockPm
  );
  assert.strictEqual(report.execStatus, cr.EXEC_STATUS.BLOCKED);
});

test('3b. BLOCKED レポートの Part1 に "BLOCKED" が含まれる', () => {
  const report = cr.generateCeoReport(
    'test-project',
    { tasksDone: 1, tasksFailed: 2, stopReason: 'consecutive_errors_3', yellowCount: 0 },
    { level: 'RED', score: 30, redTriggers: ['認証エラー'] },
    'BLOCKED',
    mockTm, mockPm
  );
  const text = cr.formatCeoReportPart1(report);
  assert.ok(text.includes('BLOCKED'), 'BLOCKED が Part1 にない');
});

test('3c. Quality RED + BLOCKED → 品質問題の説明がある', () => {
  const report = cr.generateCeoReport(
    'test-project',
    { tasksDone: 0, tasksFailed: 1, stopReason: 'midrun_quality_gate_red', yellowCount: 0 },
    { level: 'RED', score: 20, redTriggers: [] },
    'BLOCKED',
    mockTm, mockPm
  );
  assert.ok(report.roles.qa.includes('RED') || report.roles.qa.includes('問題'), 'QA評価に問題説明がない');
});

// ─────────────────────────────────────────────────────
// 4. 必須項目のフォーマット確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 必須項目の存在確認]');

const sampleReport = cr.generateCeoReport(
  'sample-project',
  { tasksDone: 4, tasksFailed: 0, stopReason: 'project_done', yellowCount: 1 },
  { level: 'YELLOW', score: 65, redTriggers: [] },
  'NEEDS_REVIEW',
  mockTm, mockPm
);

test('4a. Part1 に プロジェクト名・判定・実行結果・Developer・QA・PM が含まれる', () => {
  const text = cr.formatCeoReportPart1(sampleReport);
  assert.ok(text.includes('CEO Report'), 'ヘッダーがない');
  assert.ok(text.includes('sample-project'), 'projectId がない');
  assert.ok(text.includes('Developer'), 'Developer 評価がない');
  assert.ok(text.includes('QA'), 'QA 評価がない');
  assert.ok(text.includes('PM'), 'PM 評価がない');
});

test('4b. Part2 に Product・Learning・次のアクションが含まれる', () => {
  const text = cr.formatCeoReportPart2(sampleReport);
  assert.ok(text.includes('Product'), 'Product 評価がない');
  assert.ok(text.includes('Learning'), 'Learning がない');
  assert.ok(text.includes('推奨アクション'), '次のアクションがない');
});

test('4c. Part3 に GPT相談用コピー文が含まれる', () => {
  const text = cr.formatCeoReportPart3(sampleReport);
  assert.ok(text.includes('GPT'), 'GPT相談文がない');
  assert.ok(text.includes('```'), 'コードブロックがない（コピーしやすい形式）');
});

test('4d. GPT コピー文にプロジェクト名・完了件数・品質が含まれる', () => {
  const gpt = sampleReport.gptCopy;
  assert.ok(gpt.includes('sample-project'), 'GPT文にprojectIdがない');
  assert.ok(gpt.includes('4件'), 'GPT文に完了件数がない');
  assert.ok(gpt.includes('YELLOW'), 'GPT文に品質情報がない');
});

// ─────────────────────────────────────────────────────
// 5. チャンネルID 未設定でも動く（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[5. チャンネルID未設定フォールバック]');

test('5a. CEO_REPORT_CHANNEL_ID が定数として定義されている', () => {
  assert.ok(src.includes('CEO_REPORT_CHANNEL_ID'), 'CEO_REPORT_CHANNEL_ID がない');
});

test('5b. ceoReport が NOTIFICATION_CHANNELS に含まれる', () => {
  assert.ok(src.includes("ceoReport:"), 'NOTIFICATION_CHANNELS に ceoReport がない');
});

test('5c. CEO_REPORT_CHANNEL_ID 未設定時は fallback 送信（if 分岐がある）', () => {
  const teardownIdx  = src.indexOf('async function _teardown');
  const teardownEnd  = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 4000);
  assert.ok(teardownBody.includes('CEO_REPORT_CHANNEL_ID'), '_teardown に CEO_REPORT_CHANNEL_ID がない');
  assert.ok(teardownBody.includes('CeoReport'), '_teardown に CeoReport 送信がない');
});

// ─────────────────────────────────────────────────────
// 6. 既存機能保護確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 既存機能保護]');

test('6a. _teardown に CEO Report 送信が追加されている（activeRuns.delete より前）', () => {
  const teardownIdx  = src.indexOf('async function _teardown');
  const teardownEnd  = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 4000);
  const ceoIdx       = teardownBody.indexOf('CeoReport');
  const deleteIdx    = teardownBody.indexOf('activeRuns.delete');
  assert.ok(ceoIdx >= 0, 'CeoReport が _teardown にない');
  assert.ok(ceoIdx < deleteIdx, 'CeoReport が activeRuns.delete より後にある');
});

test('6b. CEO Report エラーは catch で続行（_teardown を壊さない）', () => {
  const teardownIdx  = src.indexOf('async function _teardown');
  const teardownEnd  = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 4000);
  assert.ok(teardownBody.includes('ceoErr'), 'ceoErr catch がない');
});

test('6c. Board Report ロジックは変更なし（generateBoardReport が残っている）', () => {
  const abr = require('../bot/utils/ai-board-report');
  assert.strictEqual(typeof abr.generateBoardReport, 'function');
  assert.strictEqual(typeof abr.formatBoardReport, 'function');
});

test('6d. HUMAN_CHECK / activeRuns 既存ロジックは変更なし', () => {
  assert.ok(src.includes("ctx.stopReason === 'awaiting_human'"), 'awaiting_human チェックが消えている');
  assert.ok(src.includes('activeRuns.delete'), 'activeRuns.delete がない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
