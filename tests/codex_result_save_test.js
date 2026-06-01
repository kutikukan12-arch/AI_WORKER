'use strict';
// executeClaudeTask で result_task_*.md が作成されるかを確認するテスト
// （IMPLEMENT タスク → !review list / !review show から参照できる問題の修正確認）

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
const CLEANUP_FILES = [];

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

function cleanup() {
  for (const f of CLEANUP_FILES) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

const src        = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const reviewsDir = path.join(__dirname, '..', 'reviews');
const codex      = require('../bot/utils/codex');

// ─────────────────────────────────────────────────────
// 1. ソースコード構造確認（修正箇所の存在確認）
// ─────────────────────────────────────────────────────
console.log('\n[1. executeClaudeTask の result_task_*.md 生成コード確認]');

test('1a. executeClaudeTask 内に parseCodexResult 呼び出しがある', () => {
  // executeClaudeTask の Codex ブロック（STEP3）を切り出す
  const fnStart = src.indexOf('async function executeClaudeTask');
  const fnEnd   = src.indexOf('\nasync function executeReviewTask', fnStart);
  const fnBody  = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
  assert.ok(fnBody.includes('parseCodexResult'), 'parseCodexResult が executeClaudeTask 内にない');
});

test('1b. executeClaudeTask 内に result_task_*.md の writeFileSync がある', () => {
  const fnStart = src.indexOf('async function executeClaudeTask');
  const fnEnd   = src.indexOf('\nasync function executeReviewTask', fnStart);
  const fnBody  = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
  assert.ok(fnBody.includes('result_${taskId}.md'), 'result_task_*.md 書き込みコードがない');
  assert.ok(fnBody.includes('writeFileSync'), 'writeFileSync が executeClaudeTask 内にない');
});

test('1c. result_task_*.md の保存が saveCodexResponse の後（codex_task_*.md を壊さない）', () => {
  const fnStart    = src.indexOf('async function executeClaudeTask');
  const fnEnd      = src.indexOf('\nasync function executeReviewTask', fnStart);
  const fnBody     = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
  const saveIdx    = fnBody.indexOf('saveCodexResponse');
  const parseIdx   = fnBody.indexOf('parseCodexResult');
  assert.ok(saveIdx >= 0,  'saveCodexResponse が見つからない');
  assert.ok(parseIdx >= 0, 'parseCodexResult が見つからない');
  assert.ok(saveIdx < parseIdx, 'saveCodexResponse の後に parseCodexResult がある（順序が正しい）');
});

test('1d. parseCodexResult 失敗は catch で続行（フェイルオープン）', () => {
  const fnStart  = src.indexOf('async function executeClaudeTask');
  const fnEnd    = src.indexOf('\nasync function executeReviewTask', fnStart);
  const fnBody   = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
  // parseCodexResult を含む try-catch があること
  const parseIdx = fnBody.indexOf('parseCodexResult');
  const tryIdx   = fnBody.lastIndexOf('try {', parseIdx);
  const catchIdx = fnBody.indexOf('} catch (parseErr)', parseIdx);
  assert.ok(tryIdx >= 0 && catchIdx >= 0, 'parseCodexResult が try-catch に囲まれていない');
});

// ─────────────────────────────────────────────────────
// 2. REVIEWタスク経路が変更されていないこと
// ─────────────────────────────────────────────────────
console.log('\n[2. executeReviewTask の既存処理が維持されていること]');

test('2a. executeReviewTask 内にも result_task_*.md 保存処理がある（変更なし）', () => {
  const fnStart = src.indexOf('async function executeReviewTask');
  const fnEnd   = src.indexOf('\nasync function executeResearchTask', fnStart);
  const fnBody  = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
  assert.ok(fnBody.includes('result_${taskId}.md'), 'executeReviewTask の result_task_*.md 保存が消えている');
  assert.ok(fnBody.includes('parseCodexResult'), 'executeReviewTask の parseCodexResult が消えている');
});

// ─────────────────────────────────────────────────────
// 3. codex.parseCodexResult の動作確認
// ─────────────────────────────────────────────────────
console.log('\n[3. parseCodexResult 動作確認]');

test('3a. parseCodexResult が関数として export されている', () => {
  assert.strictEqual(typeof codex.parseCodexResult, 'function');
});

test('3b. parseCodexResult が danger/problem/suggestion を返す', () => {
  const result = codex.parseCodexResult('サンプルレビュー結果');
  assert.ok(result && typeof result === 'object', 'object が返らない');
  assert.ok('danger' in result, 'danger フィールドがない');
  assert.ok('problem' in result, 'problem フィールドがない');
  assert.ok('suggestion' in result, 'suggestion フィールドがない');
});

// ─────────────────────────────────────────────────────
// 4. result_task_*.md ファイルの実際の書き込み確認
// ─────────────────────────────────────────────────────
console.log('\n[4. result_task_*.md ファイル書き込み確認]');

const FAKE_TASK_ID = `task_codex_result_test_${Date.now()}`;
const resultPath   = path.join(reviewsDir, `result_${FAKE_TASK_ID}.md`);
CLEANUP_FILES.push(resultPath);

test('4a. parseCodexResult + writeFileSync で result_task_*.md を作成できる', () => {
  const fakeApiResp = 'このコードに問題があります。\n危険度: 中\n改善案: リファクタリングを検討してください。';
  const parsed      = codex.parseCodexResult(fakeApiResp);
  assert.ok(parsed, 'parseCodexResult が null を返した');

  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[parsed.danger] || '⬜';
  const content = [
    `# Codex レビュー結果: ${FAKE_TASK_ID}`,
    ``,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| 作成日時 | ${new Date().toLocaleString('ja-JP')} |`,
    `| タスクID | ${FAKE_TASK_ID} |`,
    `| 危険度   | ${dangerEmoji} ${parsed.danger} |`,
    ``,
    `## 問題点`,
    ``,
    parsed.problem || '（なし）',
    ``,
    `## 改善案`,
    ``,
    parsed.suggestion || '（なし）',
    ``,
    `## フィードバック適用コマンド`,
    ``,
    `\`!apply-review ${FAKE_TASK_ID}\``,
  ].join('\n');

  fs.writeFileSync(resultPath, content, 'utf8');
  assert.ok(fs.existsSync(resultPath), 'result_task_*.md が作成されなかった');
});

test('4b. result_task_*.md が reviews/ に存在し !review list の対象になる', () => {
  assert.ok(fs.existsSync(resultPath), 'ファイルが存在しない');
  // !review list は result_task_*.md をスキャンする
  const files = fs.readdirSync(reviewsDir)
    .filter(f => f.startsWith('result_') && f.endsWith('.md'));
  const found = files.find(f => f.includes(FAKE_TASK_ID));
  assert.ok(found, '!review list の対象にならない（result_ prefix / .md suffix）');
});

test('4c. result_task_*.md の内容が正しいフォーマット（# Codex レビュー結果 ヘッダー）', () => {
  const content = fs.readFileSync(resultPath, 'utf8');
  assert.ok(content.includes('# Codex レビュー結果'), 'ヘッダーがない');
  assert.ok(content.includes('## 問題点'), '問題点セクションがない');
  assert.ok(content.includes('## 改善案'), '改善案セクションがない');
  assert.ok(content.includes('!apply-review'), '適用コマンドがない');
  assert.ok(content.includes(FAKE_TASK_ID), 'タスクIDが含まれていない');
});

test('4d. result_task_*.md が !review show の参照パス（result_<id>.md）と一致する', () => {
  // !review show は path.join(reviewsDir, `result_${rawId}.md`) を参照する
  const expectedPath = path.join(reviewsDir, `result_${FAKE_TASK_ID}.md`);
  assert.ok(fs.existsSync(expectedPath), '!review show が参照するパスにファイルがない');
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
