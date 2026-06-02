'use strict';
// Job Risk Classifier テスト

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const { classifyJob, formatJobRiskReport, RISK_LEVEL } = require('../bot/utils/job-risk-classifier');

// ─────────────────────────────────────────────────────
// 1. LOW 案件（受けてOK）
// ─────────────────────────────────────────────────────
console.log('\n[1. LOW 案件]');
test('1a. Excel VBAマクロ → LOW', () => {
  assert.strictEqual(classifyJob('ExcelのVBAマクロで集計自動化', '月次売上をマクロで自動化').level, RISK_LEVEL.LOW);
});
test('1b. CSV整形スクリプト → LOW', () => {
  assert.strictEqual(classifyJob('CSVクレンジングスクリプト作成', 'CSVの形式を統一するPythonスクリプト').level, RISK_LEVEL.LOW);
});
test('1c. Discord通知Bot（小規模）→ LOW', () => {
  assert.strictEqual(classifyJob('Discord通知Bot作成', 'Webhookを使った社内アラートBot').level, RISK_LEVEL.LOW);
});
test('1d. 静的LP制作 → LOW', () => {
  assert.strictEqual(classifyJob('ランディングページ制作', 'HTML/CSSで静的LP。Googleフォームを埋め込む').level, RISK_LEVEL.LOW);
});
test('1e. Slack日報Bot → LOW', () => {
  assert.strictEqual(classifyJob('Slack日報集計Bot', '日報をSlackに投稿すると自動集計してスプレッドシートに記録').level, RISK_LEVEL.LOW);
});

// ─────────────────────────────────────────────────────
// 2. MEDIUM 案件（質問してから判断）
// ─────────────────────────────────────────────────────
console.log('\n[2. MEDIUM 案件]');
test('2a. スクレイピング → MEDIUM', () => {
  assert.strictEqual(classifyJob('価格スクレイピングツール', '競合価格を毎日自動収集したい').level, RISK_LEVEL.MEDIUM);
});
test('2b. 要件不明 → MEDIUM', () => {
  assert.strictEqual(classifyJob('業務システム改修', '詳細は後日。仕様が変わることもある。追加仕様発生あり').level, RISK_LEVEL.MEDIUM);
});
test('2c. 既存システム改修 → MEDIUM', () => {
  assert.strictEqual(classifyJob('既存業務システムに機能追加', '10年前のシステム。データ移行が必要').level, RISK_LEVEL.MEDIUM);
});

// ─────────────────────────────────────────────────────
// 3. HIGH 案件（慎重に検討）
// ─────────────────────────────────────────────────────
console.log('\n[3. HIGH 案件]');
test('3a. 決済システム → HIGH', () => {
  const r = classifyJob('クレジットカード決済実装', 'ECサイトにStripe決済。顧客カード情報を処理する');
  assert.strictEqual(r.level, RISK_LEVEL.HIGH);
});
test('3b. 医療システム → HIGH', () => {
  const r = classifyJob('病院向け予約管理システム', '患者情報・診療記録を管理。電子カルテと連携');
  assert.strictEqual(r.level, RISK_LEVEL.HIGH);
});
test('3c. 個人情報大量移行 → HIGH', () => {
  const r = classifyJob('会員DB移行', '会員DB50万件移行。住所・氏名・電話番号・メールアドレス含む');
  assert.strictEqual(r.level, RISK_LEVEL.HIGH);
});
test('3d. FX自動売買 → HIGH', () => {
  const r = classifyJob('FX自動売買システム開発', 'リアルマネーでFXを自動取引。証券会社APIと連携');
  assert.strictEqual(r.level, RISK_LEVEL.HIGH);
});

// ─────────────────────────────────────────────────────
// 4. REJECT 案件（断ることを推奨）
// ─────────────────────────────────────────────────────
console.log('\n[4. REJECT 案件]');
test('4a. コピーサイト・著作権侵害 → REJECT', () => {
  assert.strictEqual(classifyJob('競合サイトのコピーサイト作成', '有名ECサイトと同じデザイン・機能。著作権は気にしない').level, RISK_LEVEL.REJECT);
});
test('4b. SNS規約違反Bot → REJECT', () => {
  assert.strictEqual(classifyJob('自動いいね・フォロワー増Bot', 'SNSフォロワーを自動増。規約に違反するかもしれないが大丈夫').level, RISK_LEVEL.REJECT);
});
test('4c. 不正ログイン → REJECT', () => {
  assert.strictEqual(classifyJob('パスワードクラッキングツール', 'ブルートフォース攻撃でアカウントにアクセスするツール').level, RISK_LEVEL.REJECT);
});

// ─────────────────────────────────────────────────────
// 5. 過剰 REJECT しないこと
// ─────────────────────────────────────────────────────
console.log('\n[5. 過剰 REJECT しない]');
test('5a. AWS デプロイ支援は REJECT/HIGH しない', () => {
  const r = classifyJob('AWS上にWebアプリをデプロイしたい', '社内向け管理画面。EC2とRDS使用');
  assert.ok(r.level !== RISK_LEVEL.REJECT, 'AWSデプロイが REJECT になった（過剰）');
  // HIGH か MEDIUM が適切（障害リスクあるが拒否は不要）
});
test('5b. 機械学習・AIは単独で REJECT にならない', () => {
  const r = classifyJob('売上予測AIモデル作成', '機械学習でExcelデータから売上を予測するモデル');
  assert.ok(r.level !== RISK_LEVEL.REJECT, 'AI/ML単独でREJECTになった（過剰）');
});
test('5c. データ分析は単独で HIGH にならない', () => {
  const r = classifyJob('Pythonデータ分析ツール', 'Pandas/MatplotlibでCSVデータを分析・可視化する');
  assert.ok(r.level !== RISK_LEVEL.HIGH && r.level !== RISK_LEVEL.REJECT, 'データ分析が HIGH/REJECT になった（過剰）');
});

// ─────────────────────────────────────────────────────
// 6. 表示フォーマット確認
// ─────────────────────────────────────────────────────
console.log('\n[6. CEO向け表示]');
test('6a. LOW の表示に「受けてOK」がある', () => {
  const r = classifyJob('Excel VBA', 'マクロで集計自動化');
  const txt = formatJobRiskReport('Excel VBA', 'マクロで集計自動化', r);
  assert.ok(txt.includes('受けてOK'), '受けてOK の表示がない');
});
test('6b. MEDIUM の表示に「質問してから」がある', () => {
  const r = classifyJob('スクレイピング', '競合価格を毎日自動収集');
  const txt = formatJobRiskReport('スクレイピング', '競合価格を毎日自動収集', r);
  assert.ok(txt.includes('質問') || txt.includes('確認'), '質問/確認の表示がない');
});
test('6c. REJECT の表示に「断ること」がある', () => {
  const r = classifyJob('コピーサイト', '著作権は気にしない');
  const txt = formatJobRiskReport('コピーサイト', '著作権は気にしない', r);
  assert.ok(txt.includes('断る') || txt.includes('REJECT'), '断ることの表示がない');
});
test('6d. HIGH の表示に確認事項が含まれる', () => {
  const r = classifyJob('Stripe決済実装', 'クレジットカード決済。カード情報処理');
  const txt = formatJobRiskReport('Stripe決済実装', 'クレジットカード決済', r);
  assert.ok(txt.includes('確認'), '確認事項がない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
