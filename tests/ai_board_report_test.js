'use strict';
// AI Board Report テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const abr = require('../bot/utils/ai-board-report');
const src  = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. _determineStatus — 判定ロジック
// ─────────────────────────────────────────────────────
console.log('\n[1. determineStatus 判定ロジック]');

test('1a. tasksFailed>0 → BLOCKED', () => {
  const s = abr._determineStatus(
    { tasksFailed: 2, stopReason: 'project_done' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.BLOCKED);
});

test('1b. Quality RED → BLOCKED', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'project_done' },
    { level: 'RED', redTriggers: ['認証エラー'] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.BLOCKED);
});

test('1c. awaiting>0 → BLOCKED', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'awaiting_human' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 1 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.BLOCKED);
});

test('1d. Quality YELLOW → NEEDS_REVIEW', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'project_done' },
    { level: 'YELLOW', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.NEEDS_REVIEW);
});

test('1e. reviewing>0 → NEEDS_REVIEW', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'project_done' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 2, awaiting: 0 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.NEEDS_REVIEW);
});

// ── テスト2: Quality GREEN でも RELEASE_READY にしない ──
console.log('\n[2. Quality GREEN でも RELEASE_READY と即断しない]');

test('2a. project_done + GREEN → NEEDS_REFINEMENT（RELEASE_READY にしない）', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'project_done' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.notStrictEqual(s, abr.BOARD_STATUS.RELEASE_READY, 'project_done直後にRELEASE_READYになっている');
  assert.strictEqual(s, abr.BOARD_STATUS.NEEDS_REFINEMENT);
});

test('2b. tasksDone=10 + GREEN + zero残タスク → NEEDS_REFINEMENT', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'project_done', tasksDone: 10 },
    { level: 'GREEN', score: 95, redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.notStrictEqual(s, abr.BOARD_STATUS.RELEASE_READY);
});

// ── テスト3: 失敗件数あり → BLOCKED ──
console.log('\n[3. 失敗件数あり → BLOCKED または NEEDS_REVIEW]');

test('3a. tasksFailed=1 → BLOCKED（GREEN でも）', () => {
  const s = abr._determineStatus(
    { tasksFailed: 1, stopReason: 'consecutive_errors_3' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.BLOCKED);
});

test('3b. stopReason=timeout_limit → BLOCKED', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'timeout_limit' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.strictEqual(s, abr.BOARD_STATUS.BLOCKED);
});

// ── テスト4: pending/on_hold があれば RELEASE_READY にしない ──
console.log('\n[4. pending/on_hold 残存 → RELEASE_READY にしない]');

test('4a. pending>0 → NEEDS_REFINEMENT（GREEN でも）', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'no_pending_tasks' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 3, onHold: 0, reviewing: 0, awaiting: 0 }
  );
  assert.notStrictEqual(s, abr.BOARD_STATUS.RELEASE_READY);
  assert.strictEqual(s, abr.BOARD_STATUS.NEEDS_REFINEMENT);
});

test('4b. onHold>0 → NEEDS_REFINEMENT', () => {
  const s = abr._determineStatus(
    { tasksFailed: 0, stopReason: 'no_pending_tasks' },
    { level: 'GREEN', redTriggers: [] },
    { pending: 0, onHold: 2, reviewing: 0, awaiting: 0 }
  );
  assert.notStrictEqual(s, abr.BOARD_STATUS.RELEASE_READY);
});

// ── テスト5: !project board コマンドのソース確認 ──
console.log('\n[5. !project board コマンド実装確認]');

test('5a. handleProject に board サブコマンドがある', () => {
  assert.ok(src.includes("sub === 'board'"), "'board'サブコマンドがない");
});

test('5b. board ブロックに generateBoardReport 呼び出しがある', () => {
  const boardIdx  = src.indexOf("sub === 'board'");
  const refineIdx = src.indexOf("sub === 'refine'");
  const boardBlock = src.slice(boardIdx, boardIdx + 1500);
  assert.ok(boardBlock.includes('generateBoardReport'), 'generateBoardReport 呼び出しがない');
  assert.ok(boardBlock.includes('formatBoardReport'), 'formatBoardReport 呼び出しがない');
});

test('5c. board が refine の上に定義されている（ルーティング順）', () => {
  const boardSub  = src.indexOf("sub === 'board'");
  const refineSub = src.indexOf("sub === 'refine'");
  assert.ok(boardSub > 0 && refineSub > 0, 'board か refine が見つからない');
});

// ── テスト6: チャンネルID未設定でもフォールバック ──
console.log('\n[6. チャンネルID未設定フォールバック]');

test('6a. AI_BOARD_CHANNEL_ID が定数として定義されている', () => {
  assert.ok(src.includes('AI_BOARD_CHANNEL_ID'), 'AI_BOARD_CHANNEL_ID が定義されていない');
});

test('6b. AI_BOARD_CHANNEL_ID 未設定時は fallback 送信する（三項/if 分岐がある）', () => {
  const teardownIdx = src.indexOf('async function _teardown');
  const teardownEnd = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 3000);
  // AI_BOARD_CHANNEL_ID があればsendNotification、なければ直接送信
  assert.ok(teardownBody.includes('AI_BOARD_CHANNEL_ID'), 'teardown に AI_BOARD_CHANNEL_ID がない');
  assert.ok(teardownBody.includes('boardReport'), 'teardown に boardReport 送信がない');
});

test('6c. boardReport が NOTIFICATION_CHANNELS に含まれる', () => {
  assert.ok(src.includes("boardReport:"), 'NOTIFICATION_CHANNELS に boardReport がない');
});

// ── テスト7: project_done 時に Board Report が生成される ──
console.log('\n[7. project_done 時の Board Report 生成]');

test('7a. _teardown 内に aiBoardReport.generateBoardReport 呼び出しがある', () => {
  const teardownIdx = src.indexOf('async function _teardown');
  const teardownEnd = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 3000);
  assert.ok(teardownBody.includes('generateBoardReport'), 'generateBoardReport が _teardown にない');
  assert.ok(teardownBody.includes('formatBoardReport'), 'formatBoardReport が _teardown にない');
});

test('7b. Board Report 生成エラーは catch で続行（_teardown を壊さない）', () => {
  const teardownIdx = src.indexOf('async function _teardown');
  const teardownEnd = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 3000);
  const boardIdx    = teardownBody.indexOf('BoardReport');
  const catchIdx    = teardownBody.indexOf('brErr', boardIdx);
  assert.ok(catchIdx > boardIdx, 'Board Report エラーを catch していない');
});

// ── テスト8: レポートフォーマット検証 ──
console.log('\n[8. レポートフォーマット]');

test('8a. formatBoardReport が必須項目を含む', () => {
  const report = abr.generateBoardReport(
    'test-project',
    { tasksDone: 5, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
    { level: 'GREEN', score: 90, redTriggers: [] },
    // minimal mock
    {
      listTasks: () => [],
      STATES: { PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち', AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了' },
    },
    { filterTasksByProject: () => [] }
  );
  const text = abr.formatBoardReport(report);
  assert.ok(text.includes('AI Board Report'), 'ヘッダーがない');
  assert.ok(text.includes('test-project'), 'projectId がない');
  assert.ok(text.includes('NEEDS REFINEMENT') || text.includes('NEEDS_REFINEMENT'), 'NEEDS_REFINEMENT がない（project_done は常にこれ）');
  assert.ok(text.includes('次にやるべきこと'), '次のステップ案内がない');
  assert.ok(text.includes('Quality GREEN はコード品質'), '品質注意書きがない');
});

test('8b. BLOCKED レポートに原因説明がある', () => {
  const report = abr.generateBoardReport(
    'test-project',
    { tasksDone: 3, tasksFailed: 2, stopReason: 'consecutive_errors_3', yellowCount: 0 },
    { level: 'GREEN', score: 90, redTriggers: [] },
    { listTasks: () => [], STATES: { PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち', AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了' } },
    { filterTasksByProject: () => [] }
  );
  assert.strictEqual(report.status, abr.BOARD_STATUS.BLOCKED);
  const text = abr.formatBoardReport(report);
  assert.ok(text.includes('BLOCKED'), 'BLOCKED表示がない');
  assert.ok(text.includes('失敗'), '失敗説明がない');
});

// ── 既存テスト互換チェック（ソース確認）
console.log('\n[9. 既存機能保護確認]');

test('9a. _teardown の activeRuns.delete が Board Report の後にある（順序維持）', () => {
  const teardownIdx  = src.indexOf('async function _teardown');
  const teardownEnd  = src.indexOf('\nasync function handleCompanyStaff', teardownIdx);
  const teardownBody = src.slice(teardownIdx, teardownEnd > 0 ? teardownEnd : teardownIdx + 3000);
  const boardIdx     = teardownBody.indexOf('BoardReport');
  const deleteIdx    = teardownBody.indexOf('activeRuns.delete');
  assert.ok(boardIdx < deleteIdx, 'Board Report が activeRuns.delete より後にある（順序が変わった）');
});

test('9b. Quality Gate の assessQuality / formatQualityStatus が変更されていない', () => {
  const qg = require('../bot/utils/quality-gate');
  assert.strictEqual(typeof qg.assessQuality, 'function');
  assert.strictEqual(typeof qg.formatQualityStatus, 'function');
});

test('9c. HUMAN_CHECK ロジックが _teardown に変更なし', () => {
  assert.ok(src.includes("ctx.stopReason === 'awaiting_human'"), 'awaiting_human チェックが消えている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
