'use strict';
// !job コマンド + job-risk-classifier 簡素化テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const { classifyJob, formatJobRiskReport, RISK_LEVEL } = require('../bot/utils/job-risk-classifier');

// ─────────────────────────────────────────────────────
// 1. !job コマンド実装確認
// ─────────────────────────────────────────────────────
console.log('\n[1. !job コマンド実装確認]');

test('1a. !job コマンドが index.js に実装されている', () => {
  assert.ok(src.includes("startsWith('!job')"), '!job コマンドがない');
});

test('1b. | セパレータでタイトルと説明を分割する', () => {
  const jobIdx   = src.indexOf("startsWith('!job')");
  const jobArea  = src.slice(jobIdx, jobIdx + 1500); // | 分割は ヘルプブロックの後にある
  assert.ok(jobArea.includes("indexOf('|')") || jobArea.includes('sepIdx'), '| セパレータ分割がない');
});

test('1c. ヘルプ表示（引数なし）が実装されている', () => {
  const jobIdx  = src.indexOf("startsWith('!job')");
  const jobArea = src.slice(jobIdx, jobIdx + 800);
  assert.ok(jobArea.includes('help') || jobArea.includes('使い方'), 'ヘルプ表示がない');
  assert.ok(jobArea.includes('!job <'), '使い方の例がない');
});

test('1d. 入力不足時のエラーメッセージがある', () => {
  const jobIdx  = src.indexOf("startsWith('!job')");
  const jobArea = src.slice(jobIdx, jobIdx + 1200);
  assert.ok(jobArea.includes('タイトルを入力') || jobArea.includes('入力してください') || jobArea.includes('❌'), 'エラーメッセージがない');
});

test('1e. classifyJob と formatJobRiskReport を呼び出している', () => {
  const jobIdx  = src.indexOf("startsWith('!job')");
  const jobArea = src.slice(jobIdx, jobIdx + 1000);
  assert.ok(jobArea.includes('classifyJob'), 'classifyJob 呼び出しがない');
  assert.ok(jobArea.includes('formatJobRiskReport'), 'formatJobRiskReport 呼び出しがない');
});

test('1f. 実行をブロックしない（return; でハンドラが完了する）', () => {
  const jobIdx  = src.indexOf("startsWith('!job')");
  const jobArea = src.slice(jobIdx, jobIdx + 1200);
  assert.ok(jobArea.includes('return;'), 'return; がない（ハンドラが終了しない可能性）');
});

test('1g. job-risk-classifier を require している', () => {
  const jobIdx  = src.indexOf("startsWith('!job')");
  const jobArea = src.slice(jobIdx, jobIdx + 200);
  assert.ok(jobArea.includes('job-risk-classifier'), 'job-risk-classifier が require されていない');
});

// ─────────────────────────────────────────────────────
// 2. | セパレータ分割の動作
// ─────────────────────────────────────────────────────
console.log('\n[2. 入力パース]');

test('2a. タイトルのみ（説明なし）でも動作する', () => {
  const r = classifyJob('ExcelマクロでCSV集計', '');
  assert.ok(r.level, 'タイトルのみで level が取得できない');
});

test('2b. タイトル + 説明の組み合わせで詳細判定される', () => {
  const rWithDesc    = classifyJob('決済システム', 'Stripe でクレジットカード決済を実装');
  const rWithoutDesc = classifyJob('決済システム', '');
  // 説明があればより詳細な判定（同一または HIGH ）
  assert.ok(rWithDesc.level === RISK_LEVEL.HIGH || rWithDesc.highReasons.length > 0, '説明付きで HIGH にならない');
});

// ─────────────────────────────────────────────────────
// 3. 判定分岐の簡素化確認
// ─────────────────────────────────────────────────────
console.log('\n[3. 判定ロジック簡素化確認]');

const classifierSrc = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'utils', 'job-risk-classifier.js'), 'utf8'
);

test('3a. dead branch（highReasons.length === 0 かつ highScore >= 1）が削除されている', () => {
  // 旧 dead branch: "highScore >= 1 && lowLabels.length === 0 && highReasons.length === 0"
  assert.ok(
    !classifierSrc.includes('highReasons.length === 0'),
    'dead branch（highReasons.length === 0）が残っている'
  );
});

test('3b. HIGH/MEDIUM 分岐が1つの if-else に統合されている', () => {
  // 旧: if A / else if B / else if C / else if D / else E → 5分岐
  // 新: if hasHeavyHigh / else → 2分岐
  const branchIdx = classifierSrc.indexOf('hasHeavyHigh');
  assert.ok(branchIdx >= 0, 'hasHeavyHigh 判定がない');
  // hasHeavyHigh の次の else に複数の if-else が続かないことを確認
  const branchArea = classifierSrc.slice(branchIdx, branchIdx + 300);
  // 旧パターン "else if (highScore >= 1 && lowLabels.length > 0)" が消えている
  assert.ok(!branchArea.includes('lowLabels.length > 0'), '旧分岐（lowLabels.length > 0）が残っている');
});

test('3c. MEDIUM シグナル + LOW シグナルで LOW に下げる分岐が残っている', () => {
  // この分岐は有効 → 残っているべき
  assert.ok(classifierSrc.includes('mediumScore === 1'), 'LOW 引き下げ分岐が消えている');
});

// ─────────────────────────────────────────────────────
// 4. 回帰テスト（簡素化後も同じ結果）
// ─────────────────────────────────────────────────────
console.log('\n[4. 回帰テスト]');

const REGRESSION = [
  { title: 'ExcelのVBAマクロで集計自動化',    desc: '売上集計マクロ',              expect: RISK_LEVEL.LOW },
  { title: 'Discord通知Bot作成',              desc: 'Webhookを使ったアラートBot', expect: RISK_LEVEL.LOW },
  { title: '価格スクレイピングツール',          desc: '競合価格を毎日自動収集',      expect: RISK_LEVEL.MEDIUM },
  { title: 'AWS Webアプリデプロイ',           desc: 'EC2/RDS使用。本番移行あり',   expect: RISK_LEVEL.MEDIUM },
  { title: 'クレジットカード決済実装',          desc: 'Stripe決済。カード情報処理',  expect: RISK_LEVEL.HIGH },
  { title: '電子カルテと連携した予約管理',      desc: '患者情報・診療記録を管理',    expect: RISK_LEVEL.HIGH },
  { title: '競合サイトのコピーサイト作成',      desc: '著作権は気にしない',          expect: RISK_LEVEL.REJECT },
  { title: '自動いいね・フォロワー増Bot',      desc: 'SNS規約に違反するかもしれない', expect: RISK_LEVEL.REJECT },
];

REGRESSION.forEach((c, i) => {
  test(`4${String.fromCharCode(97 + i)}. ${c.title.slice(0, 30)} → ${c.expect}`, () => {
    const r = classifyJob(c.title, c.desc);
    assert.strictEqual(r.level, c.expect, `期待:${c.expect} 実際:${r.level}`);
  });
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
