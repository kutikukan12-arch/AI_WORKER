'use strict';
// CEO Command Layer Phase 1 & 2 テスト（ceo-commands.js）

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const cc  = require('../bot/utils/ceo-commands');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─── モック定義 ──────────────────────────────────────────
const STATES = {
  PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち',
  AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了',
};

function makeTm(tasks) {
  return {
    STATES,
    listTasks: () => tasks || [],
  };
}

const mockTmEmpty = makeTm([]);

const mockTmSample = makeTm([
  { state: STATES.DONE,       type: 'IMPLEMENT', prompt: 'ログイン機能実装',      projectId: 'proj-a' },
  { state: STATES.IN_PROGRESS,type: 'RESEARCH',  prompt: 'DB設計調査',            projectId: 'proj-a' },
  { state: STATES.PENDING,    type: 'IMPLEMENT', prompt: '管理画面実装',           projectId: 'proj-a' },
  { state: STATES.PENDING,    type: 'DOCS',      prompt: 'API仕様書作成',          projectId: 'proj-a' },
  { state: STATES.ON_HOLD,    type: 'IMPLEMENT', prompt: '認証バグ修正',           projectId: 'proj-a' },
  { state: STATES.AWAITING,   type: 'REVIEW',    prompt: 'セキュリティレビュー',   projectId: 'proj-b' },
]);

const mockQgGreen = {
  assessQuality: () => ({ level: 'GREEN', score: 90, redTriggers: [] }),
};
const mockQgYellow = {
  assessQuality: () => ({ level: 'YELLOW', score: 60, redTriggers: [] }),
};
const mockQgRed = {
  assessQuality: () => ({ level: 'RED', score: 25, redTriggers: ['連続エラー3回', 'ON_HOLD タスク過多'] }),
};

const mockAprEnabled = {
  getRunnerState: () => ({ enabled: true, loopCount: 3, maxLoop: 10 }),
};
const mockAprDisabled = {
  getRunnerState: () => ({ enabled: false }),
};

const mockPm = {
  listProjects:          () => [{ id: 'proj-a', name: 'proj-a' }, { id: 'proj-b', name: 'proj-b' }],
  filterTasksByProject:  (tasks) => tasks,
};

const mockAmWithItems = {
  formatPendingList: () => '承認待ちタスク:\n1. task_001 — 承認してください',
};
const mockAmEmpty = {
  formatPendingList: () => '承認待ちタスクはありません',
};
const mockAmError = {
  formatPendingList: () => { throw new Error('DB接続エラー'); },
};

// ─────────────────────────────────────────────────────
// 1. buildCeoHelp — ヘルプテキスト
// ─────────────────────────────────────────────────────
console.log('\n[1. buildCeoHelp — ヘルプテキスト]');

test('1a. 文字列を返す', () => {
  const text = cc.buildCeoHelp();
  assert.ok(typeof text === 'string' && text.length > 0, 'ヘルプが空');
});

test('1b. Phase 1 コマンド（status / investigate / design）が含まれる', () => {
  const text = cc.buildCeoHelp();
  assert.ok(text.includes('!ceo status'),      '!ceo status がない');
  assert.ok(text.includes('!ceo investigate'), '!ceo investigate がない');
  assert.ok(text.includes('!ceo design'),      '!ceo design がない');
});

test('1c. Phase 2 コマンド（report / approve）が含まれる', () => {
  const text = cc.buildCeoHelp();
  assert.ok(text.includes('!ceo report'),  '!ceo report がない');
  assert.ok(text.includes('!ceo approve'), '!ceo approve がない');
});

// ─────────────────────────────────────────────────────
// 2. buildCeoStatus — 全体状況サマリー
// ─────────────────────────────────────────────────────
console.log('\n[2. buildCeoStatus — 全体状況サマリー]');

test('2a. タスクなしでも文字列を返す', () => {
  const text = cc.buildCeoStatus(mockTmEmpty, mockQgGreen, mockAprDisabled, mockPm);
  assert.ok(typeof text === 'string' && text.length > 0, '空文字列');
});

test('2b. 品質 GREEN が反映される', () => {
  const text = cc.buildCeoStatus(mockTmEmpty, mockQgGreen, mockAprDisabled, mockPm);
  assert.ok(text.includes('GREEN') || text.includes('🟢'), '品質 GREEN が表示されていない');
});

test('2c. 品質 RED が反映される', () => {
  const text = cc.buildCeoStatus(mockTmEmpty, mockQgRed, mockAprDisabled, mockPm);
  assert.ok(text.includes('RED') || text.includes('🔴'), '品質 RED が表示されていない');
});

test('2d. Runner 稼働中のプロジェクトが表示される', () => {
  const text = cc.buildCeoStatus(mockTmEmpty, mockQgGreen, mockAprEnabled, mockPm);
  assert.ok(text.includes('Runner') || text.includes('ループ'), 'Runner 状態が表示されていない');
});

// ─────────────────────────────────────────────────────
// 3. buildCeoInvestigate — 調査レポート
// ─────────────────────────────────────────────────────
console.log('\n[3. buildCeoInvestigate — 調査レポート]');

test('3a. ヘッダーに「CEO 調査レポート」が含まれる', () => {
  const text = cc.buildCeoInvestigate(null, mockTmEmpty, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('CEO 調査レポート'), 'ヘッダーがない');
});

test('3b. タスクなし → 問題検出なしメッセージ', () => {
  const text = cc.buildCeoInvestigate(null, mockTmEmpty, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('問題は検出されませんでした'), '問題なしメッセージがない');
});

test('3c. 承認待ちあり → 問題リストに✋が含まれる', () => {
  const text = cc.buildCeoInvestigate(null, mockTmSample, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('✋') || text.includes('承認待ち'), '承認待ちの検出がない');
});

test('3d. ON_HOLD あり → 保留タスクの警告が含まれる', () => {
  const text = cc.buildCeoInvestigate(null, mockTmSample, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('保留') || text.includes('⚠️'), '保留タスクの警告がない');
});

test('3e. 品質 RED → 品質 RED 検出セクションが含まれる', () => {
  const text = cc.buildCeoInvestigate(null, mockTmSample, mockQgRed, mockAprDisabled);
  assert.ok(text.includes('RED') || text.includes('🔴'), '品質 RED が表示されていない');
});

test('3f. projectId 指定 → レポートにプロジェクトIDが含まれる', () => {
  const text = cc.buildCeoInvestigate('proj-a', mockTmSample, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('proj-a'), 'projectId が表示されていない');
});

test('3g. 次ステップとして !ceo design が案内される', () => {
  const text = cc.buildCeoInvestigate(null, mockTmEmpty, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('!ceo design'), '次ステップ案内がない');
});

test('3h. 完了率が表示される', () => {
  const text = cc.buildCeoInvestigate(null, mockTmSample, mockQgGreen, mockAprDisabled);
  assert.ok(text.includes('完了率') || text.includes('%'), '完了率が表示されていない');
});

// ─────────────────────────────────────────────────────
// 4. buildCeoDesign — 設計提案
// ─────────────────────────────────────────────────────
console.log('\n[4. buildCeoDesign — 設計提案]');

test('4a. ヘッダーに「CEO 設計提案」が含まれる', () => {
  const text = cc.buildCeoDesign(null, mockTmEmpty, mockPm);
  assert.ok(text.includes('CEO 設計提案'), 'ヘッダーがない');
});

test('4b. タスクなし → 推奨アクションに !project refine が含まれる', () => {
  const text = cc.buildCeoDesign(null, mockTmEmpty, mockPm);
  assert.ok(text.includes('!project refine'), '!project refine がない');
});

test('4c. 未着手タスクあり → 実行候補タスクが表示される', () => {
  const text = cc.buildCeoDesign(null, mockTmSample, mockPm);
  assert.ok(text.includes('実行候補タスク'), '実行候補タスクがない');
});

test('4d. ON_HOLD タスクあり → 保留中セクションが含まれる', () => {
  const text = cc.buildCeoDesign(null, mockTmSample, mockPm);
  assert.ok(text.includes('保留中') || text.includes('再開 or 破棄'), '保留中タスクが表示されていない');
});

test('4e. projectId 指定 → 設計提案にプロジェクトIDが含まれる', () => {
  const text = cc.buildCeoDesign('proj-a', mockTmSample, mockPm);
  assert.ok(text.includes('proj-a'), 'projectId が表示されていない');
});

test('4f. 推奨アクションが常に含まれる', () => {
  const text = cc.buildCeoDesign(null, mockTmSample, mockPm);
  assert.ok(text.includes('推奨アクション'), '推奨アクションがない');
});

// ─────────────────────────────────────────────────────
// 5. buildCeoReport — CEO レポート配列
// ─────────────────────────────────────────────────────
console.log('\n[5. buildCeoReport — CEO レポート配列]');

test('5a. 配列を返す', () => {
  const parts = cc.buildCeoReport(null, mockTmEmpty, mockQgGreen, mockPm);
  assert.ok(Array.isArray(parts), '配列でない');
  assert.ok(parts.length > 0, '空配列');
});

test('5b. 各要素が文字列である', () => {
  const parts = cc.buildCeoReport(null, mockTmSample, mockQgGreen, mockPm);
  for (const p of parts) {
    assert.ok(typeof p === 'string', `要素が文字列でない: ${typeof p}`);
  }
});

test('5c. 各要素が 1900 文字以内（Discord 上限対応）', () => {
  const parts = cc.buildCeoReport(null, mockTmSample, mockQgYellow, mockPm);
  for (const p of parts) {
    assert.ok(p.length <= 1900, `1900 文字超: ${p.length}`);
  }
});

test('5d. listTasks がエラーを投げても配列を返す（内部 catch で継続）', () => {
  // buildCeoReport は listTasks のエラーを内部で吸収して正常な配列を返す
  const brokenTm = { listTasks: () => { throw new Error('DB DOWN'); }, STATES };
  const parts = cc.buildCeoReport(null, brokenTm, mockQgGreen, mockPm);
  assert.ok(Array.isArray(parts) && parts.length > 0, 'フォールバック配列がない');
  assert.ok(parts.every(p => typeof p === 'string'), '配列要素が文字列でない');
});

// ─────────────────────────────────────────────────────
// 6. buildCeoApproveList — 承認待ち一覧
// ─────────────────────────────────────────────────────
console.log('\n[6. buildCeoApproveList — 承認待ち一覧]');

test('6a. 承認待ちあり → 文字列を返す', () => {
  const text = cc.buildCeoApproveList(mockAmWithItems);
  assert.ok(typeof text === 'string' && text.length > 0, '空文字列');
  assert.ok(text.includes('承認'), '承認関連テキストがない');
});

test('6b. 承認待ちなし → 空リストメッセージを返す', () => {
  const text = cc.buildCeoApproveList(mockAmEmpty);
  assert.ok(text.includes('ありません') || text.includes('なし'), '空リストメッセージがない');
});

test('6c. formatPendingList がエラー → エラーメッセージを返す', () => {
  const text = cc.buildCeoApproveList(mockAmError);
  assert.ok(text.includes('⚠️') || text.includes('エラー'), 'エラーフォールバックがない');
});

// ─────────────────────────────────────────────────────
// 7. index.js ソース確認 — handleCeo 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js — handleCeo 統合確認]');

test('7a. handleCeo 関数が定義されている', () => {
  assert.ok(src.includes('async function handleCeo'), 'handleCeo が定義されていない');
});

test('7b. !ceo コマンドが handleCeo に dispatch される', () => {
  assert.ok(src.includes("content.startsWith('!ceo')"), '!ceo の dispatch がない');
  assert.ok(src.includes('handleCeo'), 'handleCeo 呼び出しがない');
});

test('7c. status / investigate / design（Phase 1）のサブコマンド分岐がある', () => {
  const idx   = src.indexOf('async function handleCeo');
  const end   = src.indexOf('\nasync function handleHelp', idx);
  const body  = src.slice(idx, end > 0 ? end : idx + 3000);
  assert.ok(body.includes("'status'"),      'status 分岐がない');
  assert.ok(body.includes("'investigate'"), 'investigate 分岐がない');
  assert.ok(body.includes("'design'"),      'design 分岐がない');
});

test('7d. report / approve（Phase 2）のサブコマンド分岐がある', () => {
  const idx   = src.indexOf('async function handleCeo');
  const end   = src.indexOf('\nasync function handleHelp', idx);
  const body  = src.slice(idx, end > 0 ? end : idx + 3000);
  assert.ok(body.includes("'report'"),  'report 分岐がない');
  assert.ok(body.includes("'approve'"), 'approve 分岐がない');
});

test('7e. 未知のサブコマンド → buildCeoHelp が呼ばれる', () => {
  const idx   = src.indexOf('async function handleCeo');
  const end   = src.indexOf('\nasync function handleHelp', idx);
  const body  = src.slice(idx, end > 0 ? end : idx + 3000);
  assert.ok(body.includes('buildCeoHelp'), '未知コマンドのフォールバックがない');
});

test('7f. ceoCommands が require されている', () => {
  assert.ok(src.includes("require('./utils/ceo-commands')"), 'ceo-commands が require されていない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
