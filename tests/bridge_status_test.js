'use strict';
// =====================================================
// bridge_status_test.js — !bridge status 統合テスト
//
// カバレッジ:
//   1. 安全設計確認 (read-only / redact / 出典表示)
//   2. 4分類コレクター単体テスト
//   3. getBridgeStatus() 統合テスト
//   4. L-20 Runtime Reachability (index.js に登録済みか)
// =====================================================

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try   { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const bs = require('../bot/utils/bridge-status');

// ─────────────────────────────────────────────────────
// 1. 安全設計確認
// ─────────────────────────────────────────────────────
console.log('\n[1. 安全設計確認]');

test('1a. bridge-status.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'bridge-status.js'), 'utf8'
  );
  assert.ok(!src.includes('eval('),  'eval が含まれている');
  assert.ok(!src.includes('exec('),  'exec が含まれている');
});

test('1b. 状態変更関数がない (saveState/writeFile/push/create)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'bridge-status.js'), 'utf8'
  );
  assert.ok(!src.includes('saveState('), 'saveState が含まれている');
  assert.ok(!src.includes('appendAudit('), 'appendAudit が含まれている');
  assert.ok(!src.includes('createTask('), 'createTask が含まれている');
  assert.ok(!src.includes('writeFile('),  'writeFile が含まれている');
});

test('1c. redact が import されている', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'bridge-status.js'), 'utf8'
  );
  assert.ok(src.includes("require('./redact')"), 'redact が import されていない');
  assert.ok(src.includes('redact('), 'redact() が呼ばれていない');
});

test('1d. 出典 (src フィールド) が全コレクターに存在する', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'bridge-status.js'), 'utf8'
  );
  assert.ok(src.includes('!task list'),          '!task list 出典がない');
  assert.ok(src.includes('!msg pending'),         '!msg pending 出典がない');
  assert.ok(src.includes('!workflow status'),     '!workflow status 出典がない');
  assert.ok(src.includes('!operator reliability'),'!operator reliability 出典がない');
  assert.ok(src.includes('!worker status'),       '!worker status 出典がない');
});

test('1e. 判断代理ロジックがない (READY / NEED_FIX 生成なし)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'bridge-status.js'), 'utf8'
  );
  assert.ok(!src.includes("'READY'"),    'READY 生成がある');
  assert.ok(!src.includes("'NEED_FIX'"), 'NEED_FIX 生成がある');
  assert.ok(!src.includes('approve('),   'approve() がある');
});

// ─────────────────────────────────────────────────────
// 2. コレクター単体テスト
// ─────────────────────────────────────────────────────
console.log('\n[2. コレクター単体テスト]');

test('2a. _collectCeoPending() が配列を返す', () => {
  const result = bs._collectCeoPending();
  assert.ok(Array.isArray(result), '配列でない');
  result.forEach(item => {
    assert.ok(item.label, 'label がない');
    assert.ok(item.src,   'src (出典) がない');
    assert.ok(item.type,  'type がない');
  });
});

test('2b. _collectStopped() が配列を返す', () => {
  const result = bs._collectStopped();
  assert.ok(Array.isArray(result), '配列でない');
  result.forEach(item => {
    assert.ok(item.label, 'label がない');
    assert.ok(item.src,   'src (出典) がない');
  });
});

test('2c. _collectInProgress() が配列を返す', () => {
  const result = bs._collectInProgress();
  assert.ok(Array.isArray(result), '配列でない');
  result.forEach(item => {
    assert.ok(item.label, 'label がない');
    assert.ok(item.src,   'src (出典) がない');
  });
});

test('2d. _collectRecentDone() が配列を返す', () => {
  const result = bs._collectRecentDone();
  assert.ok(Array.isArray(result), '配列でない');
  result.forEach(item => {
    assert.ok(item.label, 'label がない');
    assert.ok(item.src,   'src (出典) がない');
  });
});

test('2e. _ageLabel() が正しい時間ラベルを返す', () => {
  const now    = new Date().toISOString();
  const hour   = new Date(Date.now() - 2  * 60 * 60 * 1000).toISOString();
  const day    = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const minute = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  assert.ok(bs._ageLabel(minute).includes('分前'),   '30分前がおかしい');
  assert.ok(bs._ageLabel(hour).includes('時間前'),   '2時間前がおかしい');
  assert.ok(bs._ageLabel(day).includes('日前'),      '25時間前がおかしい');
  assert.strictEqual(bs._ageLabel(null), '',          'null は空文字を返す');
});

// ─────────────────────────────────────────────────────
// 3. getBridgeStatus() 統合テスト
// ─────────────────────────────────────────────────────
console.log('\n[3. getBridgeStatus() 統合テスト]');

test('3a. getBridgeStatus() が ok:true を返す', () => {
  const r = bs.getBridgeStatus();
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.text === 'string', 'text が文字列でない');
  assert.ok(typeof r.summary === 'object', 'summary がない');
});

test('3b. summary に4分類カウントが含まれる', () => {
  const r = bs.getBridgeStatus();
  assert.ok('ceoPending'  in r.summary, 'ceoPending がない');
  assert.ok('stopped'     in r.summary, 'stopped がない');
  assert.ok('inProgress'  in r.summary, 'inProgress がない');
  assert.ok('recentDone'  in r.summary, 'recentDone がない');
  // 全て数値
  assert.ok(typeof r.summary.ceoPending === 'number');
  assert.ok(typeof r.summary.stopped    === 'number');
  assert.ok(typeof r.summary.inProgress === 'number');
  assert.ok(typeof r.summary.recentDone === 'number');
});

test('3c. text に4分類のセクションヘッダーが含まれる', () => {
  const r = bs.getBridgeStatus();
  assert.ok(r.text.includes('CEO判断待ち'),  '① CEO判断待ち がない');
  assert.ok(r.text.includes('停止中'),       '② 停止中 がない');
  assert.ok(r.text.includes('進行中'),       '③ 進行中 がない');
  assert.ok(r.text.includes('完了'),         '④ 完了 がない');
});

test('3d. text に出典コマンドが含まれる', () => {
  const r = bs.getBridgeStatus();
  assert.ok(r.text.includes('!msg pending'),     '!msg pending がない');
  assert.ok(r.text.includes('!task list'),        '!task list がない');
  assert.ok(r.text.includes('!workflow status'), '!workflow status がない');
});

test('3e. text が1950文字以内 (Discord 上限)', () => {
  const r = bs.getBridgeStatus();
  assert.ok(r.text.length <= 1950, `text が ${r.text.length} 文字 (上限1950超)`);
});

test('3f. text に「読み取り専用」の警告が含まれる', () => {
  const r = bs.getBridgeStatus();
  assert.ok(r.text.includes('読み取り専用'), '読み取り専用の警告がない');
});

test('3g. 「Bridge Status」見出しが含まれる', () => {
  const r = bs.getBridgeStatus();
  assert.ok(r.text.includes('Bridge Status'), '見出しがない');
});

// ─────────────────────────────────────────────────────
// 4. L-20 Runtime Reachability
// ─────────────────────────────────────────────────────
console.log('\n[4. L-20 Runtime Reachability]');

test('4a. bot/index.js に !bridge が登録されている', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
  );
  assert.ok(src.includes("startsWith('!bridge')"), '!bridge ハンドラがない');
  assert.ok(src.includes("getBridgeStatus"),        'getBridgeStatus() 呼び出しがない');
  assert.ok(src.includes("bridge-status"),          'bridge-status require がない');
});

test('4b. !bridge status サブコマンドが正しく分岐する', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
  );
  assert.ok(src.includes("brSub === 'status'"), "'status' サブコマンド分岐がない");
});

test('4c. getBridgeStatus() の実行経路が到達可能', () => {
  // 直接呼び出しで実際に動作することを確認
  let result;
  assert.doesNotThrow(() => { result = bs.getBridgeStatus(); }, 'getBridgeStatus() が例外を投げる');
  assert.ok(result.ok, 'ok が false');
  assert.ok(result.text.length > 0, 'text が空');
});

test('4d. bridge-status.js が新規状態ファイルを作成しない', () => {
  const beforeFiles = fs.readdirSync(path.join(__dirname, '..', 'data')).join(',');
  bs.getBridgeStatus();
  const afterFiles  = fs.readdirSync(path.join(__dirname, '..', 'data')).join(',');
  assert.strictEqual(beforeFiles, afterFiles, '新規ファイルが作成された');
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
