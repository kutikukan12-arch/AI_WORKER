'use strict';
// =====================================================
// internal_router_test.js — Internal Router Phase2 テスト
//
// テスト要件:
//   T1: 宮城 IMPLEMENT_DONE → 守谷ch届く、CEOには来ない
//   T2: 守谷 REVIEW_READY → 市川ch / TECH_REVIEW_DONE → 黒川ch
//   T3: 全員READY(PM→CS→黒川) → 黒川まとめ後 KUROKAWA_SUMMARY → CEO
//   T4: COST_REQUIRED → 固定ルートなし → CEO_CONFIRM_REQUIRED 停止
//
// 追加テスト:
//   R1〜R5: role-channel-router.js 単体
//   P1〜P4: _hasProductImpact() ユニット
// =====================================================

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try   { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const wfRouter = require('../bot/utils/workflow-router');
const rcr      = require('../bot/utils/role-channel-router');

// タスクID: テスト実行ごとにユニーク（Safety Gate の turn 上限リセット）
const _TS = Date.now();
const TASK_A = 'ir-test-a-' + _TS;
const TASK_B = 'ir-test-b-' + _TS;
const TASK_C = 'ir-test-c-' + _TS;

// ─────────────────────────────────────────────────────
// [R] Role Channel Router 単体テスト
// ─────────────────────────────────────────────────────
console.log('\n[R. role-channel-router.js 単体テスト]');

test('Ra. getWorkerChannelId: 未設定は null', () => {
  // CI 環境では env 未設定が前提
  const orig = process.env.MORIYA_CHANNEL_ID;
  delete process.env.MORIYA_CHANNEL_ID;
  assert.strictEqual(rcr.getWorkerChannelId('moriya'), null);
  if (orig !== undefined) process.env.MORIYA_CHANNEL_ID = orig;
});

test('Rb. getWorkerChannelId: 設定済みは値を返す', () => {
  const orig = process.env.MORIYA_CHANNEL_ID;
  process.env.MORIYA_CHANNEL_ID = '1234567890';
  assert.strictEqual(rcr.getWorkerChannelId('moriya'), '1234567890');
  if (orig !== undefined) process.env.MORIYA_CHANNEL_ID = orig;
  else delete process.env.MORIYA_CHANNEL_ID;
});

test('Rc. getWorkerChannelId: 不明な worker は null', () => {
  assert.strictEqual(rcr.getWorkerChannelId('unknown_worker'), null);
  assert.strictEqual(rcr.getWorkerChannelId(''),   null);
  assert.strictEqual(rcr.getWorkerChannelId(null), null);
});

test('Rd. isChannelConfigured: 設定/未設定で boolean', () => {
  const orig = process.env.MIYAGI_CHANNEL_ID;
  delete process.env.MIYAGI_CHANNEL_ID;
  assert.strictEqual(rcr.isChannelConfigured('miyagi'), false);
  process.env.MIYAGI_CHANNEL_ID = 'ch_123';
  assert.strictEqual(rcr.isChannelConfigured('miyagi'), true);
  if (orig !== undefined) process.env.MIYAGI_CHANNEL_ID = orig;
  else delete process.env.MIYAGI_CHANNEL_ID;
});

test('Re. listConfiguredChannels: 10社員全員が含まれる', () => {
  const list = rcr.listConfiguredChannels();
  assert.ok(Array.isArray(list), '配列でない');
  assert.ok(list.length >= 10, '社員数が足りない');
  const workers = list.map(l => l.worker);
  for (const w of ['miyagi', 'moriya', 'aizawa', 'ichikawa', 'kurokawa', 'ceo']) {
    assert.ok(workers.includes(w), `${w} がリストにない`);
  }
  list.forEach(l => {
    assert.ok(l.display,  `${l.worker} の display がない`);
    assert.ok(l.envKey,   `${l.worker} の envKey がない`);
  });
});

test('Rf. buildChannelStatusText: テキストに設定状況が含まれる', () => {
  const text = rcr.buildChannelStatusText();
  assert.ok(text.includes('Role Channel Router'), 'ヘッダーがない');
  assert.ok(text.includes('設定済み'),             '設定済みカウントがない');
  assert.ok(text.includes('MORIYA_CHANNEL_ID'),   'env key がない');
  assert.ok(text.includes('!router status'),       'コマンド案内がない');
});

test('Rg. WORKER_CHANNEL_ENV に全必要 env キーがある', () => {
  const env = rcr.WORKER_CHANNEL_ENV;
  for (const w of ['miyagi', 'moriya', 'aizawa', 'ichikawa', 'kurokawa', 'ikuno', 'kanzaki', 'ceo']) {
    assert.ok(w in env, `${w} の env キーがない`);
    assert.ok(env[w].endsWith('_CHANNEL_ID'), `${w} の env キー名が不正: ${env[w]}`);
  }
});

// ─────────────────────────────────────────────────────
// [P] _hasProductImpact() ユニットテスト
// ─────────────────────────────────────────────────────
console.log('\n[P. _hasProductImpact() ユニットテスト]');

test('Pa. 商品キーワードで true', () => {
  assert.ok(wfRouter._hasProductImpact('YouTube診断β公開対応'));
  assert.ok(wfRouter._hasProductImpact('商品リリースの件'));
  assert.ok(wfRouter._hasProductImpact('課金機能追加'));
  assert.ok(wfRouter._hasProductImpact('ユーザー向けUIの変更'));
});

test('Pb. 技術のみキーワードで false', () => {
  assert.ok(!wfRouter._hasProductImpact('内部リファクタリング完了'));
  assert.ok(!wfRouter._hasProductImpact('テスト修正のみ'));
  assert.ok(!wfRouter._hasProductImpact('CI設定変更'));
});

test('Pc. 空文字/null は false', () => {
  assert.ok(!wfRouter._hasProductImpact(''));
  assert.ok(!wfRouter._hasProductImpact(null));
  assert.ok(!wfRouter._hasProductImpact(undefined));
});

test('Pd. 大文字小文字を無視する', () => {
  assert.ok(wfRouter._hasProductImpact('PRODUCT release'));
  assert.ok(wfRouter._hasProductImpact('Launch 2026'));
});

// ─────────────────────────────────────────────────────
// [T1] 宮城 IMPLEMENT_DONE → 守谷ch届く、CEOには来ない
// ─────────────────────────────────────────────────────
console.log('\n[T1. 宮城 IMPLEMENT_DONE → 守谷チャンネル]');

test('T1a. IMPLEMENT_DONE が FIXED_ROUTES に存在する', () => {
  assert.ok('IMPLEMENT_DONE' in wfRouter.FIXED_ROUTES, 'FIXED_ROUTESにない');
  assert.strictEqual(wfRouter.FIXED_ROUTES.IMPLEMENT_DONE.to, 'moriya');
});

test('T1b. 宮城からの autoHandoff → 守谷へ dispatched:true', () => {
  const r = wfRouter.autoHandoff('IMPLEMENT_DONE', {
    from:    'miyagi',
    taskId: TASK_A,
    summary: '内部リファクタリング完了。商品影響なし。',
  });
  assert.ok(r.ok,              `ok:false — ${JSON.stringify(r)}`);
  assert.ok(r.dispatched,      `dispatched:false — ${JSON.stringify(r)}`);
  assert.strictEqual(r.to, 'moriya', `to が moriya でない: ${r.to}`);
});

test('T1c. 宮城からのハンドオフメッセージに「守谷」が含まれる', () => {
  const rt = wfRouter.route('IMPLEMENT_DONE', { from: 'miyagi', taskId: 'T-001', summary: 'done' });
  assert.ok(rt.ok, `route失敗: ${JSON.stringify(rt)}`);
  // toLabel に守谷
  assert.ok(rt.toLabel.includes('守谷'), `toLabel に守谷がない: ${rt.toLabel}`);
});

test('T1d. CEO からの IMPLEMENT_DONE は CEO_CONFIRM_REQUIRED で停止', () => {
  const r = wfRouter.autoHandoff('IMPLEMENT_DONE', {
    from:    'ceo',
    taskId: TASK_A,
    summary: 'done',
  });
  assert.ok(r.ok);
  assert.ok(!r.dispatched, 'CEO送信でも dispatched:true になっている（停止すべき）');
});

test('T1e. IMPLEMENT_DONE label contains moriya info', () => {
  const rt = wfRouter.ROUTING_TABLE.IMPLEMENT_DONE;
  assert.strictEqual(rt.to, 'moriya');
  assert.ok(rt.label, 'label not defined');
});

// ─────────────────────────────────────────────────────
// [T2] 守谷 REVIEW_READY / TECH_REVIEW_DONE 分岐
// ─────────────────────────────────────────────────────
console.log('\n[T2. 守谷 REVIEW_READY/TECH_REVIEW_DONE 分岐]');

test('T2a. REVIEW_READY → 市川 (固定ルート)', () => {
  const r = wfRouter.autoHandoff('REVIEW_READY', {
    from:    'moriya',
    taskId: TASK_B,
    summary: 'YouTube診断β商品機能 READY',
  });
  assert.ok(r.ok && r.dispatched, `dispatched:false — ${JSON.stringify(r)}`);
  assert.strictEqual(r.to, 'ichikawa', `to が ichikawa でない: ${r.to}`);
});

test('T2b. TECH_REVIEW_DONE → 黒川 (固定ルート)', () => {
  const r = wfRouter.autoHandoff('TECH_REVIEW_DONE', {
    from:    'moriya',
    taskId: TASK_B,
    summary: '内部リファクタリング完了。PM確認不要。',
  });
  assert.ok(r.ok && r.dispatched, `dispatched:false — ${JSON.stringify(r)}`);
  assert.strictEqual(r.to, 'kurokawa', `to が kurokawa でない: ${r.to}`);
});

test('T2c. TECH_REVIEW_DONE の toLabel が黒川', () => {
  const rt = wfRouter.ROUTING_TABLE.TECH_REVIEW_DONE;
  assert.ok(rt.label.includes('黒川'), `label に黒川がない: ${rt.label}`);
});

test('T2d. 守谷以外の TECH_REVIEW_DONE は CEO_CONFIRM_REQUIRED', () => {
  const r = wfRouter.autoHandoff('TECH_REVIEW_DONE', {
    from:    'miyagi',
    taskId:  'T-X',
    summary: 'テスト',
  });
  assert.ok(r.ok && !r.dispatched, '宮城からでも dispatched:true になっている');
});

// ─────────────────────────────────────────────────────
// [T3] 全員READY 連鎖: 市川→相沢→黒川→CEO
// ─────────────────────────────────────────────────────
console.log('\n[T3. 全員READY連鎖 (PM_READY → CS_READY → KUROKAWA_SUMMARY)]');

test('T3a. PM_READY が FIXED_ROUTES にある', () => {
  assert.ok('PM_READY' in wfRouter.FIXED_ROUTES, 'PM_READY が FIXED_ROUTESにない');
  assert.strictEqual(wfRouter.FIXED_ROUTES.PM_READY.to, 'aizawa');
  assert.deepStrictEqual(wfRouter.FIXED_ROUTES.PM_READY.allowedFrom, ['ichikawa']);
});

test('T3b. 市川 PM_READY → 相沢 (dispatched)', () => {
  const r = wfRouter.autoHandoff('PM_READY', {
    from:    'ichikawa',
    taskId: TASK_C,
    summary: 'YouTube診断β UI READY、CSテスト依頼',
  });
  assert.ok(r.ok && r.dispatched, `dispatched:false — ${JSON.stringify(r)}`);
  assert.strictEqual(r.to, 'aizawa', `to が aizawa でない: ${r.to}`);
});

test('T3c. CS_READY が FIXED_ROUTES にある', () => {
  assert.ok('CS_READY' in wfRouter.FIXED_ROUTES, 'CS_READY が FIXED_ROUTESにない');
  assert.strictEqual(wfRouter.FIXED_ROUTES.CS_READY.to, 'kurokawa');
  assert.deepStrictEqual(wfRouter.FIXED_ROUTES.CS_READY.allowedFrom, ['aizawa']);
});

test('T3d. 相沢 CS_READY → 黒川 (dispatched)', () => {
  const r = wfRouter.autoHandoff('CS_READY', {
    from:    'aizawa',
    taskId: TASK_C,
    summary: 'CSテスト完了。初心者でも使いやすい。',
  });
  assert.ok(r.ok && r.dispatched, `dispatched:false — ${JSON.stringify(r)}`);
  assert.strictEqual(r.to, 'kurokawa', `to が kurokawa でない: ${r.to}`);
});

test('T3e. KUROKAWA_SUMMARY が FIXED_ROUTES にある', () => {
  assert.ok('KUROKAWA_SUMMARY' in wfRouter.FIXED_ROUTES, 'KUROKAWA_SUMMARYがない');
  assert.strictEqual(wfRouter.FIXED_ROUTES.KUROKAWA_SUMMARY.to, 'ceo');
  assert.deepStrictEqual(wfRouter.FIXED_ROUTES.KUROKAWA_SUMMARY.allowedFrom, ['kurokawa']);
});

test('T3f. 黒川 KUROKAWA_SUMMARY → CEO (dispatched)', () => {
  const r = wfRouter.autoHandoff('KUROKAWA_SUMMARY', {
    from:    'kurokawa',
    taskId: TASK_C,
    summary: 'YouTube診断β全工程 READY。公開可否の判断をお願いします。',
  });
  assert.ok(r.ok && r.dispatched, `dispatched:false — ${JSON.stringify(r)}`);
  assert.strictEqual(r.to, 'ceo', `to が ceo でない: ${r.to}`);
});

test('T3g. KUROKAWA_SUMMARY メッセージに CEO判断が含まれる', () => {
  const rt  = wfRouter.ROUTING_TABLE.KUROKAWA_SUMMARY;
  const msg = rt.message({ taskId: 'T-003', summary: '公開判断依頼' });
  assert.ok(msg.includes('CEO') || msg.includes('判断'), `CEO/判断がない: ${msg.slice(0, 100)}`);
});

test('T3h. 黒川以外の KUROKAWA_SUMMARY は CEO_CONFIRM_REQUIRED', () => {
  const r = wfRouter.autoHandoff('KUROKAWA_SUMMARY', {
    from:    'ichikawa',
    taskId:  'T-X',
    summary: 'テスト',
  });
  assert.ok(r.ok && !r.dispatched, '黒川以外でも dispatched:true');
});

// ─────────────────────────────────────────────────────
// [T4] 費用判断 → 必ず CEO 停止
// ─────────────────────────────────────────────────────
console.log('\n[T4. 費用判断 → CEO_CONFIRM_REQUIRED]');

test('T4a. COST_REQUIRED は固定ルートなし → CEO_CONFIRM_REQUIRED', () => {
  const r = wfRouter.autoHandoff('COST_REQUIRED', {
    from:    'miyagi',
    taskId:  'T-004',
    summary: '外部API利用費 ¥5,000/月 が必要',
  });
  assert.ok(r.ok, `ok:false — ${JSON.stringify(r)}`);
  assert.ok(!r.dispatched, 'COST_REQUIRED で dispatched:true になった（停止すべき）');
  assert.strictEqual(r.reason, 'CEO_CONFIRM_REQUIRED');
});

test('T4b. BLOCKED も固定ルートなし → CEO_CONFIRM_REQUIRED', () => {
  const r = wfRouter.autoHandoff('BLOCKED', {
    from:    'miyagi',
    taskId:  'T-004',
    summary: '外部API障害でブロック',
  });
  assert.ok(r.ok && !r.dispatched, 'BLOCKED で dispatched:true');
  assert.strictEqual(r.reason, 'CEO_CONFIRM_REQUIRED');
});

test('T4c. STRATEGY_REVIEW も固定ルートなし → CEO_CONFIRM_REQUIRED', () => {
  const r = wfRouter.autoHandoff('STRATEGY_REVIEW', {
    from:    'miyagi',
    taskId:  'T-004',
    summary: '大型方針変更の検討',
  });
  assert.ok(r.ok && !r.dispatched, 'STRATEGY_REVIEW で dispatched:true');
});

test('T4d. 不明イベントも CEO_CONFIRM_REQUIRED', () => {
  const r = wfRouter.autoHandoff('UNKNOWN_CUSTOM_EVENT', {
    from:    'miyagi',
    taskId:  'T-X',
    summary: 'テスト',
  });
  assert.ok(r.ok && !r.dispatched, '不明イベントで dispatched:true');
  assert.strictEqual(r.reason, 'CEO_CONFIRM_REQUIRED');
});

// ─────────────────────────────────────────────────────
// [S] 安全設計確認
// ─────────────────────────────────────────────────────
console.log('\n[S. 安全設計確認]');

test('Sa. role-channel-router.js に eval/exec がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'role-channel-router.js'), 'utf8'
  );
  assert.ok(!src.includes('eval('),  'eval が含まれている');
  assert.ok(!src.includes('exec('),  'exec が含まれている');
});

test('Sb. role-channel-router.js が Discord client を保持しない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'role-channel-router.js'), 'utf8'
  );
  assert.ok(!src.includes('require(\'discord.js\')'), 'discord.js をインポートしている');
  assert.ok(!src.includes('require("discord.js")'), 'discord.js をインポートしている');
  assert.ok(!src.includes('new Client('),             'Discord Client を生成している');
});

test('Sc. 新ルート FIXED_ROUTES に allowedFrom が設定されている', () => {
  const newRoutes = ['PM_READY', 'CS_READY', 'KUROKAWA_SUMMARY', 'TECH_REVIEW_DONE'];
  for (const ev of newRoutes) {
    const route = wfRouter.FIXED_ROUTES[ev];
    assert.ok(route, `${ev} が FIXED_ROUTES にない`);
    assert.ok(Array.isArray(route.allowedFrom), `${ev} の allowedFrom が配列でない`);
    assert.ok(route.allowedFrom.length > 0, `${ev} の allowedFrom が空`);
  }
});

test('Sd. !router コマンドが index.js に登録されている', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
  );
  assert.ok(src.includes("startsWith('!router')"),   '!router ハンドラがない');
  assert.ok(src.includes('role-channel-router'),      'role-channel-router require がない');
  assert.ok(src.includes('buildChannelStatusText'),   'buildChannelStatusText がない');
});

test('Se. handoff 後の Role Channel Router 分岐が index.js にある', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
  );
  assert.ok(src.includes('getWorkerChannelId'), 'getWorkerChannelId 呼び出しがない');
  assert.ok(src.includes('sendToChannel(workerChId'), 'workerChId への sendToChannel がない');
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
