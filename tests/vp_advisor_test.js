'use strict';
// 神崎 VP (vp-advisor.js) + !vp コマンド統合テスト
//
// 検証方針:
//   - 神崎は「提案」のみ。「決定」「承認」「READY/NEED_FIX」を生成しない
//   - CEO 最終判断の原則を侵さない
//   - secret 混入なし（redact 適用）/ eval・exec・自動実行なし
//   - 既存社員役割・既存コマンドを壊していない

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const vp  = require('../bot/utils/vp-advisor');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const vpSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'vp-advisor.js'), 'utf8');

// ─────────────────────────────────────────────────────
console.log('\n[1. !vp ask — 判断材料整理]');
// ─────────────────────────────────────────────────────

test('1a. ask は ok=true で構造化テキストを返す', () => {
  const r = vp.buildAskBrief('YouTube診断AIを有料化すべきか');
  assert.ok(r.ok);
  assert.ok(r.text.includes('状況整理'));
  assert.ok(r.text.includes('選択肢'));
  assert.ok(r.text.includes('メリット'));
  assert.ok(r.text.includes('リスク'));
  assert.ok(r.text.includes('推奨案'));
});

test('1b. ask 出力に相談テーマが含まれる', () => {
  const r = vp.buildAskBrief('課金方針の変更');
  assert.ok(r.text.includes('課金方針の変更'));
});

test('1c. ask は空入力で使い方を返す（ok=false）', () => {
  const r = vp.buildAskBrief('');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('!vp ask'));
});

test('1d. ask は「提案」であり「決定」ではない注記を必ず含む', () => {
  const r = vp.buildAskBrief('新規事業を始めるか');
  assert.ok(r.text.includes('提案'));
  assert.ok(r.text.includes('決定ではありません'));
  assert.ok(r.text.includes('社長（CEO）が行います'));
});

// ─────────────────────────────────────────────────────
console.log('\n[2. !vp summary — 経営状況整理]');
// ─────────────────────────────────────────────────────

test('2a. summary は空データでも ok=true', () => {
  const r = vp.buildSummary({});
  assert.ok(r.ok);
  assert.ok(r.text.includes('現在プロジェクト'));
  assert.ok(r.text.includes('重要Decision'));
  assert.ok(r.text.includes('リスク'));
  assert.ok(r.text.includes('次の判断候補'));
});

test('2b. summary はプロジェクト/Decision/Incident を反映する', () => {
  const r = vp.buildSummary({
    projects:  [{ id: 'p1', name: 'YouTube診断AI', description: 'Phase1' }],
    currentProjectId: 'p1',
    decisions: [{ id: 'dec_1', title: '有料化方針', createdAt: Date.now() }],
    incidents: [{ id: 'inc_1', title: 'API障害', severity: 'high', status: 'OPEN' }],
  });
  assert.ok(r.text.includes('YouTube診断AI'));
  assert.ok(r.text.includes('← 現在'));
  assert.ok(r.text.includes('有料化方針'));
  assert.ok(r.text.includes('API障害'));
});

test('2c. summary も「決定ではない」注記を含む', () => {
  const r = vp.buildSummary({});
  assert.ok(r.text.includes('決定ではありません'));
});

// ─────────────────────────────────────────────────────
console.log('\n[3. CEO 権限・専権侵害なし]');
// ─────────────────────────────────────────────────────

test('3a. vp-advisor は READY/NEED_FIX を生成しない', () => {
  const r1 = vp.buildAskBrief('リリースしてよいか');
  const r2 = vp.buildSummary({});
  assert.ok(!/READY|NEED_FIX/.test(r1.text), 'ask に READY/NEED_FIX が混入');
  assert.ok(!/READY|NEED_FIX/.test(r2.text), 'summary に READY/NEED_FIX が混入');
});

test('3b. vp-advisor は承認・決定の文言を断定しない', () => {
  const r = vp.buildAskBrief('支出を承認してよいか');
  // 「承認します」「決定します」のような代行断定が無いこと
  assert.ok(!/承認します|決定します|承認しました|決定しました/.test(r.text));
});

// ─────────────────────────────────────────────────────
console.log('\n[4. セキュリティ: redact / eval なし]');
// ─────────────────────────────────────────────────────

test('4a. ask は redact を通す', () => {
  assert.ok(vpSrc.includes('redact'), 'redact が使われていない');
});

test('4b. vp-advisor に eval / exec / execSync が無い', () => {
  assert.ok(!/\beval\s*\(/.test(vpSrc));
  assert.ok(!/\bexecSync\b/.test(vpSrc));
  assert.ok(!/child_process/.test(vpSrc));
});

// ─────────────────────────────────────────────────────
console.log('\n[5. !vp コマンド配線 / 既存コマンド維持]');
// ─────────────────────────────────────────────────────

test('5a. index.js に !vp ハンドラがある', () => {
  assert.ok(src.includes("startsWith('!vp')"), '!vp ハンドラが無い');
  assert.ok(src.includes("vpSub === 'ask'"));
  assert.ok(src.includes("vpSub === 'summary'"));
});

test('5b. 既存コマンドが維持されている', () => {
  assert.ok(src.includes("startsWith('!workflow')"));
  assert.ok(src.includes("startsWith('!worker')"));
  assert.ok(src.includes("startsWith('!inbox')"));
  assert.ok(src.includes("startsWith('!decision')"));
});

// ─────────────────────────────────────────────────────
console.log('\n[6. 社員登録 / inbox-outbox]');
// ─────────────────────────────────────────────────────

test('6a. 神崎(kanzaki) が worker 一覧に存在する', () => {
  const ws = require('../bot/utils/worker-status');
  // worker-status の WORKER_DISPLAY は内部だが内部に kanzaki を含むことを表示経由で確認
  const wsSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'worker-status.js'), 'utf8');
  assert.ok(wsSrc.includes('kanzaki'));
  assert.ok(wsSrc.includes('神崎 VP'));
});

test('6b. inbox-bridge が kanzaki を有効社員に含む', () => {
  const ibSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8');
  assert.ok(ibSrc.includes('kanzaki'));
});

test('6c. kanzaki の inbox/outbox ディレクトリが存在する', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'data', 'inbox', 'kanzaki')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'data', 'outbox', 'kanzaki')));
});

test('6d. workflow-router に VP_BRIEF_REQUEST 固定ルートがある', () => {
  const wr = require('../bot/utils/workflow-router');
  assert.ok(wr.FIXED_ROUTES.VP_BRIEF_REQUEST);
  assert.strictEqual(wr.FIXED_ROUTES.VP_BRIEF_REQUEST.to, 'kanzaki');
  // CEO のみがこのルートを起動できる（VP の判断代行防止）
  assert.deepStrictEqual(wr.FIXED_ROUTES.VP_BRIEF_REQUEST.allowedFrom, ['ceo']);
});

test('6e. workflow-router に STRATEGY_REVIEW があるが自動配送ではない', () => {
  const wr = require('../bot/utils/workflow-router');
  assert.ok(wr.WORKFLOW_EVENTS.STRATEGY_REVIEW, 'STRATEGY_REVIEW イベントが無い');
  const r = wr.route('STRATEGY_REVIEW', { from: 'ichikawa', summary: '新規事業の検討' });
  assert.strictEqual(r.to, 'kanzaki');
  // 神崎→直接実行を防ぐため固定ルート（自動配送）には含めない
  assert.ok(!wr.FIXED_ROUTES.STRATEGY_REVIEW, 'STRATEGY_REVIEW が自動配送に入っている（禁止）');
});

// ─────────────────────────────────────────────────────
console.log('\n[7. COMPANY_CONTEXT / company-rules 更新]');
// ─────────────────────────────────────────────────────

test('7a. COMPANY_CONTEXT.md に神崎VPが記載されている', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMPANY_CONTEXT.md'), 'utf8');
  assert.ok(doc.includes('神崎 VP'));
});

test('7b. company-rules.md に神崎ルールがある', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'company-rules.md'), 'utf8');
  assert.ok(doc.includes('神崎'));
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
