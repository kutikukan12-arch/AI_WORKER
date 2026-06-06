'use strict';
// =======================================================
// split_type_correction_test.js
//
// 今回パターンの再現テスト:
//   YouTube診断β 外部配布準備 timeout → split
//   Phase1 = RESEARCH / Phase2 = IMPLEMENT / Phase3 = TEST
//   Phase1/Phase3 が 0-diff で CEO高危険にならない
//   Phase2(IMPLEMENT) は 0-diff なら失敗
// =======================================================

const assert  = require('assert');
const path    = require('path');
const tm      = require('../bot/utils/task-manager');
const tt      = require('../bot/utils/task-type');
const cv      = require('../bot/utils/completion-validator');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
const CLEANUP_IDS = [];
const _TS = Date.now();
const pid = 'split-type-test';

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function cleanup() {
  try {
    const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
    const fs    = require('fs');
    const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    raw.tasks   = raw.tasks.filter(t => !CLEANUP_IDS.includes(t.id));
    fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// [R] inferSplitChildType 単体テスト
// ─────────────────────────────────────────────────────
console.log('\n[R. inferSplitChildType 単体テスト]');

test('Ra. Phase1 → RESEARCH', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 1] YouTube診断β の調査・設計', 'IMPLEMENT'),
    'RESEARCH'
  );
});
test('Rb. Phase2 → IMPLEMENT', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 2] YouTube診断β の実装', 'IMPLEMENT'),
    'IMPLEMENT'
  );
});
test('Rc. Phase3 → TEST', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 3] YouTube診断β のテスト・確認', 'IMPLEMENT'),
    'TEST'
  );
});
test('Rd. フェーズ1 → RESEARCH', () => {
  assert.strictEqual(
    tt.inferSplitChildType('フェーズ1: 調査・設計', 'IMPLEMENT'),
    'RESEARCH'
  );
});
test('Re. フェーズ3 → TEST', () => {
  assert.strictEqual(
    tt.inferSplitChildType('フェーズ3 テスト・確認', 'IMPLEMENT'),
    'TEST'
  );
});
test('Rf. docs → DOCS', () => {
  assert.strictEqual(
    tt.inferSplitChildType('docs セットアップ手順を書いて', 'IMPLEMENT'),
    'DOCS'
  );
});
test('Rg. README → DOCS', () => {
  assert.strictEqual(
    tt.inferSplitChildType('README を更新する', 'IMPLEMENT'),
    'DOCS'
  );
});
test('Rh. 判断不能 → 親タイプ継承 (IMPLEMENT)', () => {
  assert.strictEqual(
    tt.inferSplitChildType('なんとなくやって', 'IMPLEMENT'),
    'IMPLEMENT'
  );
});
test('Ri. 判断不能 → 親タイプ継承 (RESEARCH)', () => {
  assert.strictEqual(
    tt.inferSplitChildType('なんとなくやって', 'RESEARCH'),
    'RESEARCH'
  );
});

// ─ NEED_FIX 追加テスト: Phase番号 + 実装語 → IMPLEMENT ─
// 守谷CTOレビュー指摘: Phase番号だけで分類すると危険
test('Rj. Phase1 + 実装語 → IMPLEMENT（RESEARCH誤分類防止）', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 1] ログイン機能を実装', 'IMPLEMENT'),
    'IMPLEMENT'
  );
});
test('Rk. Phase3 + 実装語 → IMPLEMENT（TEST誤分類防止）', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 3] 残りのAPI連携を実装する', 'IMPLEMENT'),
    'IMPLEMENT'
  );
});
test('Rl. Phase3 + テスト語（実装語なし）→ TEST（維持）', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 3] 結合テストを実施', 'IMPLEMENT'),
    'TEST'
  );
});
test('Rm. Phase1 + 調査語（実装語なし）→ RESEARCH（維持）', () => {
  assert.strictEqual(
    tt.inferSplitChildType('[Phase 1] 調査・設計', 'IMPLEMENT'),
    'RESEARCH'
  );
});
test('Rn. フェーズ1 + 実装語 → IMPLEMENT（日本語パターン）', () => {
  assert.strictEqual(
    tt.inferSplitChildType('フェーズ1: 認証APIを作成して', 'IMPLEMENT'),
    'IMPLEMENT'
  );
});
test('Ro. フェーズ3 + 実装語 → IMPLEMENT（日本語パターン）', () => {
  assert.strictEqual(
    tt.inferSplitChildType('フェーズ3 残機能を追加して完成させる', 'IMPLEMENT'),
    'IMPLEMENT'
  );
});

// ─────────────────────────────────────────────────────
// [P] 今回パターン再現: IMPLEMENT timeout → Phase 3分割
// ─────────────────────────────────────────────────────
console.log('\n[P. 今回パターン再現: timeout → Phase 3分割]');

// 今回の実際のプロンプトパターン（YouTube診断β 外部配布準備）
const ORIGINAL_PROMPT =
  'YouTube診断β 外部配布準備\n' +
  '目的: 5〜8人のβユーザーへURLを渡し、フィードバックを得る\n' +
  'Phase 1: 調査・設計\n' +
  'Phase 2: 実装\n' +
  'Phase 3: テスト・確認';

const rootTask = tm.createTask(
  ORIGINAL_PROMPT, 'split-type-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(rootTask.id);
tm.updateState(rootTask.id, tm.STATES.IN_PROGRESS, 'テスト用 IN_PROGRESS');

let splitResult;
test('Pa. autoSplitOnTimeout 成功', () => {
  splitResult = tm.autoSplitOnTimeout(rootTask.id);
  assert.strictEqual(splitResult.ok, true, `reason: ${splitResult.reason}`);
  splitResult.newTasks.forEach(t => CLEANUP_IDS.push(t.id));
});

test('Pb. 子タスクが3件生成される', () => {
  assert.ok(splitResult && splitResult.newTasks.length >= 2,
    '子タスクが2件未満: ' + (splitResult?.newTasks?.length ?? 'N/A'));
});

test('Pc. Phase1子タスクのtype = RESEARCH', () => {
  const allTasks = tm.listTasks();
  const children = (splitResult?.newTasks || []).map(nt =>
    allTasks.find(t => t.id === nt.id)
  ).filter(Boolean);
  const phase1 = children.find(t =>
    t.prompt && /phase\s*1|フェーズ\s*1/i.test(t.prompt)
  );
  console.log('  ℹ️  Phase1 child:', phase1?.id, 'type:', phase1?.type);
  assert.ok(phase1, 'Phase1子タスクが見つからない');
  assert.strictEqual(phase1.type, 'RESEARCH',
    `Phase1 type=${phase1.type} (expected RESEARCH)`);
});

test('Pd. Phase2子タスクのtype = IMPLEMENT', () => {
  const allTasks = tm.listTasks();
  const children = (splitResult?.newTasks || []).map(nt =>
    allTasks.find(t => t.id === nt.id)
  ).filter(Boolean);
  const phase2 = children.find(t =>
    t.prompt && /phase\s*2|フェーズ\s*2/i.test(t.prompt)
  );
  console.log('  ℹ️  Phase2 child:', phase2?.id, 'type:', phase2?.type);
  assert.ok(phase2, 'Phase2子タスクが見つからない');
  assert.strictEqual(phase2.type, 'IMPLEMENT',
    `Phase2 type=${phase2.type} (expected IMPLEMENT)`);
});

test('Pe. Phase3子タスクのtype = TEST', () => {
  const allTasks = tm.listTasks();
  const children = (splitResult?.newTasks || []).map(nt =>
    allTasks.find(t => t.id === nt.id)
  ).filter(Boolean);
  const phase3 = children.find(t =>
    t.prompt && /phase\s*3|フェーズ\s*3/i.test(t.prompt)
  );
  console.log('  ℹ️  Phase3 child:', phase3?.id, 'type:', phase3?.type);
  assert.ok(phase3, 'Phase3子タスクが見つからない');
  assert.strictEqual(phase3.type, 'TEST',
    `Phase3 type=${phase3.type} (expected TEST)`);
});

// ─────────────────────────────────────────────────────
// [T] 0-diff判定: RESEARCH/TEST/DOCS は 0-diff でも OK
// ─────────────────────────────────────────────────────
console.log('\n[T. 0-diff判定: 非IMPLEMENT型は 0-diff でも完了扱い]');

const LONG_OUTPUT = '調査結果レポート\n\n' + 'x'.repeat(300);
const GIT_REPO = path.join(__dirname, '..');

test('Ta. RESEARCH + 0-diff → validation.ok = true', () => {
  const result = cv.validate(
    LONG_OUTPUT,   // 出力あり
    GIT_REPO,      // repoPath
    'test-task-research-' + _TS,
    [],            // changedFiles (0件)
    Date.now() - 1000,
    'RESEARCH',
    '調査してください'
  );
  assert.strictEqual(result.ok, true,
    `RESEARCH 0-diff should be OK, got: ${result.reason}`);
});

test('Tb. TEST + 0-diff → validation.ok = true', () => {
  const result = cv.validate(
    'テスト結果: 全パターン正常動作確認。\n\n' + 'x'.repeat(250),
    GIT_REPO,
    'test-task-test-' + _TS,
    [],
    Date.now() - 1000,
    'TEST',
    'テスト確認してください'
  );
  assert.strictEqual(result.ok, true,
    `TEST 0-diff should be OK, got: ${result.reason}`);
});

test('Tc. DOCS + 0-diff → validation.ok = true', () => {
  const result = cv.validate(
    'セットアップ手順\n\n## 手順1\n\n' + 'x'.repeat(250),
    GIT_REPO,
    'test-task-docs-' + _TS,
    [],
    Date.now() - 1000,
    'DOCS',
    'docs セットアップ手順を作成'
  );
  assert.strictEqual(result.ok, true,
    `DOCS 0-diff should be OK, got: ${result.reason}`);
});

test('Td. IMPLEMENT は allowsNoCodeChange = false（変更必須）', () => {
  // allowsNoCodeChange(type) が IMPLEMENT で false を返すことを直接検証する。
  // ※ 実際のgit diffはテスト環境の未コミット変更に依存するため、
  //   ロジック単体をテストする（统合テストは別途）。
  const result = cv.allowsNoCodeChange('IMPLEMENT', '実装してください');
  assert.strictEqual(result, false,
    'IMPLEMENT should require code changes (allowsNoCodeChange=false)');
});

test('Td2. TEST は allowsNoCodeChange = true（変更不要）', () => {
  const result = cv.allowsNoCodeChange('TEST', 'テスト確認してください');
  assert.strictEqual(result, true,
    'TEST should not require code changes (allowsNoCodeChange=true)');
});

test('Td3. RESEARCH は allowsNoCodeChange = true（変更不要）', () => {
  const result = cv.allowsNoCodeChange('RESEARCH', '調査してください');
  assert.strictEqual(result, true,
    'RESEARCH should not require code changes (allowsNoCodeChange=true)');
});

test('Te. IMPLEMENT + 変更あり → validation.ok = true', () => {
  // 変更ファイルが存在することをモック: changedFiles を渡す
  const result = cv.validate(
    '実装しました。bot/index.jsを変更しました。',
    GIT_REPO,
    'test-task-impl2-' + _TS,
    ['bot/index.js'],   // changedFiles に1件
    Date.now() - 1000,
    'IMPLEMENT',
    '実装してください'
  );
  assert.strictEqual(result.ok, true,
    `IMPLEMENT with changes should be OK, got: ${result.reason}`);
});

test('Tf. REVIEW + 0-diff → validation.ok = true', () => {
  const result = cv.validate(
    'レビュー結果: 問題点を確認しました。\n\n## 問題点\n\n' + 'x'.repeat(250),
    GIT_REPO,
    'test-task-review-' + _TS,
    [],
    Date.now() - 1000,
    'REVIEW',
    'レビューしてください'
  );
  assert.strictEqual(result.ok, true,
    `REVIEW 0-diff should be OK, got: ${result.reason}`);
});

// ─────────────────────────────────────────────────────
// [S] TASK_TYPES に TEST/DOCS が含まれる確認
// ─────────────────────────────────────────────────────
console.log('\n[S. TASK_TYPES 定数確認]');

test('Sa. TASK_TYPES.TEST が存在する', () => {
  assert.strictEqual(tt.TASK_TYPES.TEST, 'TEST');
});

test('Sb. TASK_TYPES.DOCS が存在する', () => {
  assert.strictEqual(tt.TASK_TYPES.DOCS, 'DOCS');
});

test('Sc. getCompletionCriteria(TEST) が変更不要を示す', () => {
  const crit = tt.getCompletionCriteria('TEST');
  assert.ok(crit.includes('変更不要') || crit.includes('不要'),
    `TEST criteria should mention no-change-required: ${crit}`);
});

test('Sd. getCompletionCriteria(DOCS) が変更不要を示す', () => {
  const crit = tt.getCompletionCriteria('DOCS');
  assert.ok(crit.includes('変更不要') || crit.includes('不要'),
    `DOCS criteria should mention no-change-required: ${crit}`);
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
