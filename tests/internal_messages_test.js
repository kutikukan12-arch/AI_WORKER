'use strict';
// internal-messages.js テスト + !msg コマンド統合確認

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const im  = require('../bot/utils/internal-messages');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function reset() { im._save([]); }

// ─────────────────────────────────────────────────────
// 1. 宛先エイリアス解決
// ─────────────────────────────────────────────────────
console.log('\n[1. 宛先エイリアス解決]');

test('1a. miyagi / 宮城 / A → miyagi', () => {
  assert.strictEqual(im.resolveAlias('miyagi'),  'miyagi');
  assert.strictEqual(im.resolveAlias('宮城'),    'miyagi');
  assert.strictEqual(im.resolveAlias('A'),       'miyagi');
  assert.strictEqual(im.resolveAlias('a'),       'miyagi');
});

test('1b. moriya / 守谷 / B → moriya', () => {
  assert.strictEqual(im.resolveAlias('moriya'),  'moriya');
  assert.strictEqual(im.resolveAlias('守谷'),    'moriya');
  assert.strictEqual(im.resolveAlias('B'),       'moriya');
});

test('1c. shiraishi / 白石 / C → shiraishi', () => {
  assert.strictEqual(im.resolveAlias('shiraishi'),'shiraishi');
  assert.strictEqual(im.resolveAlias('白石'),    'shiraishi');
  assert.strictEqual(im.resolveAlias('C'),       'shiraishi');
});

test('1d. ichikawa / 市川 / E → ichikawa', () => {
  assert.strictEqual(im.resolveAlias('ichikawa'),'ichikawa');
  assert.strictEqual(im.resolveAlias('市川'),    'ichikawa');
  assert.strictEqual(im.resolveAlias('E'),       'ichikawa');
});

test('1e. kurokawa / 黒川 / G → kurokawa', () => {
  assert.strictEqual(im.resolveAlias('kurokawa'),'kurokawa');
  assert.strictEqual(im.resolveAlias('黒川'),    'kurokawa');
  assert.strictEqual(im.resolveAlias('G'),       'kurokawa');
});

test('1f. ceo / CEO → ceo', () => {
  assert.strictEqual(im.resolveAlias('ceo'), 'ceo');
  assert.strictEqual(im.resolveAlias('CEO'), 'ceo');
});

test('1g. 不明エイリアスは null', () => {
  assert.strictEqual(im.resolveAlias('unknown'), null);
  assert.strictEqual(im.resolveAlias(''),        null);
  assert.strictEqual(im.resolveAlias(null),      null);
});

test('1h. 全メンバーがエイリアスを持つ', () => {
  const required = ['miyagi','moriya','shiraishi','aizawa','ichikawa','kanemori','kurokawa','ikuno','ceo'];
  for (const m of required) {
    assert.ok(im.resolveAlias(m) === m, `${m} が解決できない`);
  }
});

// ─────────────────────────────────────────────────────
// 2. sendMessage — 送信
// ─────────────────────────────────────────────────────
console.log('\n[2. sendMessage — 送信]');

test('2a. 正常に送信できる', () => {
  reset();
  const r = im.sendMessage({ from: 'ichikawa', to: 'miyagi', content: 'Phase1の確認をお願いします' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id.startsWith('msg_'), `id が msg_ で始まらない: ${r.id}`);
});

test('2b. 不明な送信者はエラー', () => {
  const r = im.sendMessage({ from: 'unknown', to: 'miyagi', content: 'テスト' });
  assert.strictEqual(r.ok, false);
});

test('2c. 不明な宛先はエラー', () => {
  const r = im.sendMessage({ from: 'ceo', to: 'unknown', content: 'テスト' });
  assert.strictEqual(r.ok, false);
});

test('2d. 内容なしはエラー', () => {
  const r = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '' });
  assert.strictEqual(r.ok, false);
});

test('2e. 初期ステータスは WAITING_REPLY', () => {
  reset();
  const r   = im.sendMessage({ from: 'ichikawa', to: 'moriya', content: 'CTOレビューをお願いします' });
  const msg = im._load()[0];
  assert.strictEqual(msg.status, im.STATUS.WAITING_REPLY);
});

test('2f. content に redact が適用される', () => {
  reset();
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  im.sendMessage({ from: 'ceo', to: 'miyagi', content: `token: ${fakeToken}` });
  const msg = im._load()[0];
  assert.ok(!msg.content.includes(fakeToken), 'トークンが保存されている');
  assert.ok(msg.content.includes('[MASKED]'));
});

test('2g. エイリアス経由でも送信できる', () => {
  reset();
  const r = im.sendMessage({ from: 'G', to: '守谷', content: '修正依頼を転送します' });
  assert.strictEqual(r.ok, true);
  const msg = im._load()[0];
  assert.strictEqual(msg.from, 'kurokawa');
  assert.strictEqual(msg.to,   'moriya');
});

test('2h. type は INTERNAL_MESSAGE', () => {
  reset();
  im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  assert.strictEqual(im._load()[0].type, 'INTERNAL_MESSAGE');
});

test('2i. 複数件送信できる', () => {
  reset();
  im.sendMessage({ from: 'ichikawa', to: 'miyagi',    content: 'A' });
  im.sendMessage({ from: 'moriya',   to: 'miyagi',    content: 'B' });
  im.sendMessage({ from: 'ceo',      to: 'shiraishi', content: 'C' });
  assert.strictEqual(im._load().length, 3);
});

// ─────────────────────────────────────────────────────
// 3. listMessages — 一覧
// ─────────────────────────────────────────────────────
console.log('\n[3. listMessages — 一覧]');

test('3a. 空なら案内メッセージ', () => {
  reset();
  const r = im.listMessages();
  assert.ok(r.text.includes('未返信の社内メッセージはありません'));
});

test('3b. 送信後は WAITING_REPLY が表示される', () => {
  reset();
  im.sendMessage({ from: 'ichikawa', to: 'miyagi', content: '確認依頼' });
  const r = im.listMessages();
  assert.ok(r.text.includes('miyagi') || r.text.includes('宮城'), '宛先が表示されない');
});

test('3c. REPLIED は未返信一覧に含まれない', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '確認A' });
  im.replyMessage(s.id, '了解です');
  im.sendMessage({ from: 'ceo', to: 'moriya', content: '確認B' });
  const listWaiting = im.listMessages({ all: false });
  // WAITING_REPLY のメッセージのみ表示
  assert.ok(!listWaiting.text.includes(s.id), '返信済みが未返信一覧に含まれている');
});

test('3d. list all は REPLIED / CLOSED も含む', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '確認A' });
  im.replyMessage(s.id, '了解');
  const r = im.listMessages({ all: true });
  assert.ok(r.text.includes(s.id), '返信済みが全件一覧に含まれない');
});

test('3e. member フィルタが効く', () => {
  reset();
  im.sendMessage({ from: 'ichikawa', to: 'miyagi',  content: 'miyagi宛' });
  im.sendMessage({ from: 'moriya',   to: 'shiraishi', content: 'shiraishi宛' });
  const r = im.listMessages({ all: true, member: 'miyagi' });
  assert.ok(!r.text.includes('shiraishi'), 'miyagi以外が含まれている');
});

// ─────────────────────────────────────────────────────
// 4. showMessage — 詳細
// ─────────────────────────────────────────────────────
console.log('\n[4. showMessage — 詳細]');

test('4a. IDで詳細表示できる', () => {
  reset();
  const s = im.sendMessage({ from: 'ichikawa', to: 'moriya', content: '守谷CTOへの確認' });
  const r = im.showMessage(s.id);
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('守谷CTOへの確認') || r.text.includes('守谷'));
});

test('4b. 存在しないIDは ok:false', () => {
  const r = im.showMessage('msg_nonexistent');
  assert.strictEqual(r.ok, false);
});

test('4c. IDなしは使い方を返す', () => {
  const r = im.showMessage('');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('使い方'));
});

test('4d. 末尾部分一致で検索できる', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '短縮IDテスト' });
  const shortId = s.id.split('_').slice(1).join('_'); // msg_ を除いたタイムスタンプ部分
  const r = im.showMessage(shortId);
  assert.strictEqual(r.ok, true);
});

// ─────────────────────────────────────────────────────
// 5. replyMessage — 返信
// ─────────────────────────────────────────────────────
console.log('\n[5. replyMessage — 返信]');

test('5a. 正常に返信できる', () => {
  reset();
  const s = im.sendMessage({ from: 'ichikawa', to: 'miyagi', content: '確認依頼' });
  const r = im.replyMessage(s.id, '確認しました。問題ありません。');
  assert.strictEqual(r.ok, true);
});

test('5b. 返信後ステータスは REPLIED', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '確認' });
  im.replyMessage(s.id, '了解');
  const msg = im._load().find(m => m.id === s.id);
  assert.strictEqual(msg.status, im.STATUS.REPLIED);
});

test('5c. repliedAt がセットされる', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'moriya', content: 'CTOへ' });
  im.replyMessage(s.id, '確認完了');
  const msg = im._load().find(m => m.id === s.id);
  assert.ok(msg.repliedAt, 'repliedAt がない');
});

test('5d. 返信内容に redact が適用される', () => {
  reset();
  const s        = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  const fakeToken = 'ghp_' + 'B'.repeat(36);
  im.replyMessage(s.id, `token: ${fakeToken}`);
  const msg = im._load().find(m => m.id === s.id);
  assert.ok(!msg.reply.includes(fakeToken), '返信にトークンが残っている');
});

test('5e. 返信内容なしはエラー', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  const r = im.replyMessage(s.id, '');
  assert.strictEqual(r.ok, false);
});

test('5f. 存在しないIDへの返信はエラー', () => {
  const r = im.replyMessage('msg_nonexistent', '返信テスト');
  assert.strictEqual(r.ok, false);
});

test('5g. CLOSED メッセージへの返信はエラー', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  im.closeMessage(s.id);
  const r = im.replyMessage(s.id, '遅れて返信');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('CLOSED'));
});

// ─────────────────────────────────────────────────────
// 6. closeMessage — クローズ
// ─────────────────────────────────────────────────────
console.log('\n[6. closeMessage — クローズ]');

test('6a. 正常にクローズできる', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  const r = im.closeMessage(s.id);
  assert.strictEqual(r.ok, true);
});

test('6b. クローズ後ステータスは CLOSED', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  im.closeMessage(s.id);
  const msg = im._load().find(m => m.id === s.id);
  assert.strictEqual(msg.status, im.STATUS.CLOSED);
});

test('6c. 既に CLOSED のクローズはエラー', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  im.closeMessage(s.id);
  const r = im.closeMessage(s.id);
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('CLOSED'));
});

test('6d. WAITING_REPLY → CLOSED への直接遷移ができる', () => {
  reset();
  const s = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  const msg = im._load()[0];
  assert.strictEqual(msg.status, 'WAITING_REPLY');
  im.closeMessage(s.id);
  const updated = im._load().find(m => m.id === s.id);
  assert.strictEqual(updated.status, 'CLOSED');
});

// ─────────────────────────────────────────────────────
// 7. pendingReport — 黒川レポート
// ─────────────────────────────────────────────────────
console.log('\n[7. pendingReport — 黒川レポート]');

test('7a. 返信待ちなしの場合は案内', () => {
  reset();
  const r = im.pendingReport();
  assert.ok(r.text.includes('返信待ちメッセージなし'));
});

test('7b. 返信待ちがある場合は宛先別に表示', () => {
  reset();
  im.sendMessage({ from: 'ichikawa', to: 'miyagi',    content: '宮城Leadへ確認' });
  im.sendMessage({ from: 'moriya',   to: 'miyagi',    content: '宮城Leadへ修正依頼' });
  im.sendMessage({ from: 'ceo',      to: 'shiraishi', content: '白石COOへ確認' });
  const r = im.pendingReport();
  assert.ok(r.text.includes('宮城'), '宮城 Leadが表示されない');
  assert.ok(r.text.includes('白石'), '白石 COOが表示されない');
  assert.ok(r.text.includes('3 件'), '件数が合わない');
});

test('7c. 判断の代理禁止の注釈が含まれる', () => {
  reset();
  im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  const r = im.pendingReport();
  assert.ok(r.text.includes('判断の代理禁止'), '禁止事項の注釈がない');
});

test('7d. REPLIED/CLOSED は pending に含まれない', () => {
  reset();
  const s1 = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '返信済み' });
  im.replyMessage(s1.id, '了解');
  const s2 = im.sendMessage({ from: 'ceo', to: 'miyagi', content: '未返信' });
  const r  = im.pendingReport();
  assert.ok(!r.text.includes(s1.id), '返信済みが pending に含まれている');
  assert.ok(r.text.includes(s2.id),  '未返信が pending に含まれない');
});

// ─────────────────────────────────────────────────────
// 8. ステータス遷移確認
// ─────────────────────────────────────────────────────
console.log('\n[8. ステータス遷移]');

test('8a. WAITING_REPLY → REPLIED → CLOSED の正常遷移', () => {
  reset();
  const s    = im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'テスト' });
  const msg1 = im._load().find(m => m.id === s.id);
  assert.strictEqual(msg1.status, 'WAITING_REPLY');

  im.replyMessage(s.id, '了解');
  const msg2 = im._load().find(m => m.id === s.id);
  assert.strictEqual(msg2.status, 'REPLIED');

  im.closeMessage(s.id);
  const msg3 = im._load().find(m => m.id === s.id);
  assert.strictEqual(msg3.status, 'CLOSED');
});

// ─────────────────────────────────────────────────────
// 9. Atomic write 確認
// ─────────────────────────────────────────────────────
console.log('\n[9. Atomic write]');

test('9a. .tmp ファイルが残っていない（atomicWrite は rename で完結）', () => {
  reset();
  im.sendMessage({ from: 'ceo', to: 'miyagi', content: 'atomicテスト' });
  const tmpFile = path.join(__dirname, '..', 'data', 'internal-messages.json.tmp');
  assert.ok(!fs.existsSync(tmpFile), '.tmp ファイルが残っている');
});

test('9b. _save → _load で内容が保持される', () => {
  reset();
  const dummy = [{ id: 'msg_test', type: 'INTERNAL_MESSAGE', content: 'test' }];
  im._save(dummy);
  const loaded = im._load();
  assert.deepStrictEqual(loaded, dummy);
});

// ─────────────────────────────────────────────────────
// 10. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[10. index.js 統合確認]');

function msgArea() {
  const idx = src.indexOf("startsWith('!msg')");
  return src.slice(idx, idx + 3000);
}

test("10a. startsWith('!msg') が実装されている", () => {
  assert.ok(src.includes("startsWith('!msg')"), '!msg ハンドラがない');
});

test("10b. send / list / show / reply / close / pending が実装されている", () => {
  const area = msgArea();
  assert.ok(area.includes("msgSub === 'send'"),    'send がない');
  assert.ok(area.includes("msgSub === 'list'"),    'list がない');
  assert.ok(area.includes("msgSub === 'show'"),    'show がない');
  assert.ok(area.includes("msgSub === 'reply'"),   'reply がない');
  assert.ok(area.includes("msgSub === 'close'"),   'close がない');
  assert.ok(area.includes("msgSub === 'pending'"), 'pending がない');
});

test('10c. internal-messages.js を require している', () => {
  const area = msgArea();
  assert.ok(area.includes("require('./utils/internal-messages')"), 'require がない');
});

test("10d. !workflow messages も実装されている", () => {
  assert.ok(src.includes("!workflow messages"), '!workflow messages がない');
});

// ─────────────────────────────────────────────────────
// 11. .gitignore 確認
// ─────────────────────────────────────────────────────
console.log('\n[11. .gitignore 確認]');

test('11a. internal-messages.json が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/internal-messages.json'), '.gitignore にない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
reset();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
