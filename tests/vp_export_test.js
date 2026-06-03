'use strict';
// VP Export Bridge Phase12 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const vpx = require('../bot/utils/vp-export');
const src  = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function cleanup() {
  try { if (fs.existsSync(vpx.EXPORT_FILE)) fs.unlinkSync(vpx.EXPORT_FILE); } catch {}
}

// ─────────────────────────────────────────────────────
// 1. buildExport — ファイル生成
// ─────────────────────────────────────────────────────
console.log('\n[1. buildExport — ファイル生成]');

test('1a. buildExport が ok:true を返す', () => {
  cleanup();
  const r = vpx.buildExport();
  assert.strictEqual(r.ok, true);
  assert.ok(r.filePath, 'filePath がない');
  assert.ok(r.charCount > 0, 'charCount が 0');
});

test('1b. export ファイルが生成される', () => {
  cleanup();
  vpx.buildExport();
  assert.ok(fs.existsSync(vpx.EXPORT_FILE), 'context.md が生成されない');
});

test('1c. 相談テーマが出力に含まれる', () => {
  cleanup();
  const r = vpx.buildExport({ topic: 'YouTube診断AI商品化の判断' });
  assert.ok(r.text.includes('YouTube診断AI商品化'), 'テーマが含まれない');
});

test('1d. 全体サイズが MAX_TOTAL 以下', () => {
  cleanup();
  const r = vpx.buildExport();
  assert.ok(r.charCount <= vpx.MAX_TOTAL + 100,
    `サイズが MAX_TOTAL(${vpx.MAX_TOTAL})を大幅超過: ${r.charCount}`);
});

test('1e. atomic write — .tmp が残らない', () => {
  cleanup();
  vpx.buildExport();
  const tmp = vpx.EXPORT_FILE + '.tmp';
  assert.ok(!fs.existsSync(tmp), '.tmp が残っている');
});

// ─────────────────────────────────────────────────────
// 2. secret / token 除外確認
// ─────────────────────────────────────────────────────
console.log('\n[2. secret / token 除外確認]');

test('2a. 生成内容に Discord Token が含まれない', () => {
  const r = vpx.buildExport();
  assert.ok(!/MT[A-Za-z0-9]{18,32}\.[A-Za-z0-9_-]{4,8}\.[A-Za-z0-9_-]{20,}/.test(r.text),
    'Discord Token が含まれている');
});

test('2b. 生成内容に GitHub PAT が含まれない', () => {
  const r = vpx.buildExport();
  assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(r.text), 'GitHub PAT が含まれている');
  assert.ok(!/github_pat_[A-Za-z0-9_]{80,}/.test(r.text), 'GitHub fine-grained PAT が含まれている');
});

test('2c. 生成内容に OpenAI Key が含まれない', () => {
  const r = vpx.buildExport();
  assert.ok(!/sk-proj-[A-Za-z0-9_\-]{20,}/.test(r.text), 'OpenAI Key が含まれている');
});

test('2d. _safe() が ghp_ トークンをマスクする', () => {
  const fakeToken = 'ghp_' + 'T'.repeat(36);
  const result    = vpx._safe(`相談: token=${fakeToken}`);
  assert.ok(!result.includes(fakeToken), 'トークンがマスクされていない');
  assert.ok(result.includes('[MASKED]'), 'MASKED がない');
});

// ─────────────────────────────────────────────────────
// 3. サイズ制限 — 大量ログ制限
// ─────────────────────────────────────────────────────
console.log('\n[3. サイズ制限]');

test('3a. _safe() が MAX_SECTION を超えるテキストを切り詰める', () => {
  const longText = 'あ'.repeat(vpx.MAX_SECTION + 100);
  const result   = vpx._safe(longText);
  assert.ok(result.length <= vpx.MAX_SECTION + 20,
    `_safe の出力が長すぎる: ${result.length}`);
  assert.ok(result.includes('省略'), '省略マーカーがない');
});

test('3b. buildExport の全体サイズが MAX_TOTAL 以内', () => {
  const r = vpx.buildExport({ topic: 'テスト'.repeat(100) }); // 長いトピック
  assert.ok(r.charCount <= vpx.MAX_TOTAL + 200,
    `全体サイズが MAX_TOTAL を超えた: ${r.charCount}`);
});

// ─────────────────────────────────────────────────────
// 4. 禁止事項の確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 禁止事項確認]');

test('4a. vp-export.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'vp-export.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('4b. vp-export.js に外部 API 呼び出しがない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'vp-export.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('https://'),      'HTTPS呼び出しがある');
  assert.ok(!code.includes('openai'),        'OpenAI APIが呼ばれている');
  assert.ok(!code.includes('anthropic'),     'Anthropic APIが呼ばれている');
  assert.ok(!code.includes('child_process'), 'child_processが使われている');
});

test('4c. export 内容に自動送信コードがない', () => {
  const r = vpx.buildExport();
  // 生成ファイルに fetch / axios / http などの呼び出しコードが含まれないこと
  assert.ok(!r.text.includes('fetch('),   'fetch が含まれている');
  assert.ok(!r.text.includes('axios'),    'axios が含まれている');
});

test('4d. 神崎 VP セクションは「整理テンプレート」のみ（判断文なし）', () => {
  const r = vpx.buildExport({ topic: '商品化判断' });
  assert.ok(r.text.includes('神崎VP'), '神崎VPセクションがない');
  assert.ok(r.text.includes('CEOが確認'), 'CEO確認の注意書きがない');
  // 神崎が判断文を生成していないこと
  assert.ok(!r.text.includes('承認します'), '神崎が承認している');
  assert.ok(!r.text.includes('実行します'), '神崎が実行決定している');
});

// ─────────────────────────────────────────────────────
// 5. セクション収集の動作確認
// ─────────────────────────────────────────────────────
console.log('\n[5. セクション収集]');

test('5a. _collectOverview が文字列を返す', () => {
  const r = vpx._collectOverview();
  assert.ok(typeof r === 'string', '文字列でない');
  assert.ok(r.length > 0, '空');
});

test('5b. _collectDecisions が文字列を返す', () => {
  const r = vpx._collectDecisions();
  assert.ok(typeof r === 'string', '文字列でない');
});

test('5c. _collectWorkerStatus が全社員を含む', () => {
  const r = vpx._collectWorkerStatus();
  // 神崎 VP も含まれていること（Phase12: 9名体制）
  assert.ok(r.includes('宮城') || r.includes('miyagi'), '宮城がない');
  assert.ok(r.includes('神崎') || r.includes('kanzaki'), '神崎がない');
});

test('5d. _collectWorkflowStatus が文字列を返す', () => {
  const r = vpx._collectWorkflowStatus();
  assert.ok(typeof r === 'string', '文字列でない');
});

test('5e. _collectIncidents が文字列を返す', () => {
  const r = vpx._collectIncidents();
  assert.ok(typeof r === 'string', '文字列でない');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. !vp export が実装されている", () => {
  assert.ok(src.includes("vpSub === 'export'"), '!vp export がない');
});

test('6b. vp-export.js を require している', () => {
  const idx  = src.indexOf("vpSub === 'export'");
  const area = src.slice(idx, idx + 400);
  assert.ok(area.includes("require('./utils/vp-export')"), 'require がない');
});

test('6c. 自動送信禁止の注意書きがある', () => {
  const idx  = src.indexOf("vpSub === 'export'");
  const area = src.slice(idx, idx + 800);
  assert.ok(area.includes('自動送信'), '自動送信禁止の注意書きがない');
});

// ─────────────────────────────────────────────────────
// 7. .gitignore 確認
// ─────────────────────────────────────────────────────
console.log('\n[7. .gitignore 確認]');

test('7a. data/outbox/ が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/outbox/'), 'data/outbox/ が gitignore にない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
