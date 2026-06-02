'use strict';
// コトノハ Phase 1 — client-ops テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const {
  analyzeRequest,
  buildProposal,
  checkScopeCreep,
  buildDeliveryChecklist,
  buildClosingSummary,
  SCOPE_LEVEL,
} = require('../bot/utils/client-ops');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. analyzeRequest — 要件整理
// ─────────────────────────────────────────────────────
console.log('\n[1. analyzeRequest]');

test('1a. 空入力でエラー返却', () => {
  const r = analyzeRequest('');
  assert.strictEqual(r.ok, false, 'ok が false でない');
});

test('1b. 通常の依頼で ok:true と質問が返る', () => {
  const r = analyzeRequest('毎月のCSVを自動でグラフ化するExcelマクロを作りたい');
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 50, 'テキストが短すぎる');
});

test('1c. 機能キーワードを検出する', () => {
  const r = analyzeRequest('CSVからExcelで集計グラフを自動生成するツール');
  assert.ok(r.features.length > 0, '機能が検出されない');
  assert.ok(r.features.some(f => f.includes('Excel') || f.includes('CSV')), 'Excel/CSV機能がない');
});

test('1d. 確認質問は最大4件', () => {
  const r = analyzeRequest('何か作って');
  assert.ok(r.questions.length <= 4, `質問が多すぎる: ${r.questions.length}`);
});

test('1e. リスクを検出する（個人情報）', () => {
  const r = analyzeRequest('顧客の氏名・住所・電話番号を管理するシステムを作りたい');
  assert.ok(r.risks.some(r => r.includes('個人情報')), '個人情報リスクが検出されない');
});

test('1f. リスクを検出する（決済）', () => {
  const r = analyzeRequest('StripeでECサイトに決済機能を実装したい');
  assert.ok(r.risks.some(r => r.includes('決済')), '決済リスクが検出されない');
});

test('1g. 「顧客への確認質問」セクションが表示される', () => {
  const r = analyzeRequest('業務システムを作りたい');
  assert.ok(r.text.includes('確認質問') || r.text.includes('Q1'), '確認質問がない');
});

test('1h. AI分析であることの注意書きがある', () => {
  const r = analyzeRequest('ツール作成');
  assert.ok(r.text.includes('AI') || r.text.includes('確認・編集'), 'AI注意書きがない');
});

// ─────────────────────────────────────────────────────
// 2. buildProposal — 返信案作成
// ─────────────────────────────────────────────────────
console.log('\n[2. buildProposal]');

test('2a. 空入力でエラー', () => {
  const r = buildProposal('');
  assert.strictEqual(r.ok, false);
});

test('2b. 通常入力で ok:true', () => {
  const r = buildProposal('Excel VBAマクロで月次売上集計を自動化してほしい');
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 100, 'テキストが短い');
});

test('2c. 価格・納期の断言が含まれない', () => {
  const r = buildProposal('Webアプリを作りたい');
  assert.ok(!r.text.includes('円で承ります'), '価格断言がある');
  assert.ok(!r.text.includes('日以内に完成'), '納期断言がある');
});

test('2d. 顧客への確認質問が含まれる', () => {
  const r = buildProposal('管理システムを作りたい');
  assert.ok(r.text.includes('確認') || r.text.includes('？'), '確認質問がない');
});

test('2e. CEO確認の注意書きがある', () => {
  const r = buildProposal('ツール作成');
  assert.ok(r.text.includes('CEO') || r.text.includes('確認後'), 'CEO確認注意書きがない');
});

// ─────────────────────────────────────────────────────
// 3. checkScopeCreep — スコープ肥大防止
// ─────────────────────────────────────────────────────
console.log('\n[3. checkScopeCreep]');

test('3a. 引数不足でエラー', () => {
  const r = checkScopeCreep('', '');
  assert.strictEqual(r.ok, false);
});

test('3b. 軽微な追加依頼 → LOW', () => {
  const r = checkScopeCreep('CSVを読み込むPythonスクリプト', '処理後にログファイルを出力してほしい');
  assert.ok(r.level === SCOPE_LEVEL.LOW || r.level === SCOPE_LEVEL.MEDIUM, `LOW/MEDIUMのはずが: ${r.level}`);
});

test('3c. 大きな追加依頼 → HIGH', () => {
  const r = checkScopeCreep(
    'CSVを読み込むスクリプト',
    '全部やり直してほしい。話が違う。新しい画面も追加して別のAPIにも連携して'
  );
  assert.strictEqual(r.level, SCOPE_LEVEL.HIGH);
});

test('3d. 中程度の追加 → MEDIUM', () => {
  const r = checkScopeCreep(
    'CSVグラフ化Excelマクロ',
    'メール送信機能も追加してほしい。あと検索機能も'
  );
  assert.ok(r.level === SCOPE_LEVEL.MEDIUM || r.level === SCOPE_LEVEL.HIGH, `MEDIUMのはずが: ${r.level}`);
});

test('3e. 判定根拠が含まれる', () => {
  const r = checkScopeCreep('CSV処理', '全部やり直して、話が違う');
  assert.ok(r.reasons.length > 0, '判定根拠がない');
});

test('3f. CEO最終判断の注意書きがある', () => {
  const r = checkScopeCreep('元の仕様', '追加依頼');
  assert.ok(r.text.includes('社長') || r.text.includes('最終判断'), 'CEO判断の注意書きがない');
});

// ─────────────────────────────────────────────────────
// 4. buildDeliveryChecklist — 納品チェック
// ─────────────────────────────────────────────────────
console.log('\n[4. buildDeliveryChecklist]');

test('4a. ok:true を返す', () => {
  assert.strictEqual(buildDeliveryChecklist('テストプロジェクト').ok, true);
});

test('4b. README / 起動方法の確認項目がある', () => {
  const r = buildDeliveryChecklist('CSV集計ツール');
  assert.ok(r.text.includes('README'), 'READMEチェックがない');
  assert.ok(r.text.includes('起動'), '起動方法チェックがない');
});

test('4c. セキュリティ確認（APIキー・Secret Guardian）がある', () => {
  const r = buildDeliveryChecklist('Webアプリ');
  assert.ok(r.text.includes('APIキー') || r.text.includes('Secret Guardian'), 'セキュリティチェックがない');
  assert.ok(r.text.includes('.env'), '.envチェックがない');
});

test('4d. 自動納品しない旨の注意書きがある', () => {
  const r = buildDeliveryChecklist();
  assert.ok(r.text.includes('自動納品') || r.text.includes('助言'), '自動納品禁止の注意書きがない');
});

// ─────────────────────────────────────────────────────
// 5. buildClosingSummary — 日次クロージング
// ─────────────────────────────────────────────────────
console.log('\n[5. buildClosingSummary]');

test('5a. taskManager なしでも ok:true を返す', () => {
  const r = buildClosingSummary({});
  assert.strictEqual(r.ok, true);
});

test('5b. Claude A/B/C の分担案が含まれる', () => {
  const r = buildClosingSummary({});
  assert.ok(r.text.includes('Claude A') || r.text.includes('🅰️'), 'Claude A分担がない');
  assert.ok(r.text.includes('Claude B') || r.text.includes('🅱️'), 'Claude B分担がない');
});

test('5c. 明日のおすすめ順が含まれる', () => {
  const r = buildClosingSummary({});
  assert.ok(r.text.includes('明日') || r.text.includes('Top'), '明日のおすすめがない');
});

test('5d. コトノハ案件への言及がある', () => {
  const r = buildClosingSummary({});
  assert.ok(r.text.includes('コトノハ') || r.text.includes('!job'), 'コトノハ案件への言及がない');
});

// ─────────────────────────────────────────────────────
// 6. index.js コマンド統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js コマンド統合]');

test('6a. !request コマンドが実装されている', () => {
  assert.ok(src.includes("startsWith('!request')"), '!request がない');
  assert.ok(src.includes('analyzeRequest'), 'analyzeRequest 呼び出しがない');
});

test('6b. !proposal コマンドが実装されている', () => {
  assert.ok(src.includes("startsWith('!proposal')"), '!proposal がない');
  assert.ok(src.includes('buildProposal'), 'buildProposal 呼び出しがない');
});

test('6c. !scope コマンドが実装されている', () => {
  assert.ok(src.includes("startsWith('!scope')"), '!scope がない');
  assert.ok(src.includes('checkScopeCreep'), 'checkScopeCreep 呼び出しがない');
});

test('6d. !delivery check コマンドが実装されている', () => {
  assert.ok(src.includes("startsWith('!delivery')"), '!delivery がない');
  assert.ok(src.includes('buildDeliveryChecklist'), 'buildDeliveryChecklist 呼び出しがない');
});

test('6e. !close コマンドが実装されている', () => {
  assert.ok(src.includes("'!close'") || src.includes('"!close"'), '!close がない');
  assert.ok(src.includes('buildClosingSummary'), 'buildClosingSummary 呼び出しがない');
});

test('6f. 全コマンドが client-ops から require している', () => {
  const clientOpsIdx = src.indexOf("require('./utils/client-ops')");
  assert.ok(clientOpsIdx >= 0, 'client-ops が require されていない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
