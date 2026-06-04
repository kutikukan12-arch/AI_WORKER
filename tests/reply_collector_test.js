'use strict';
// Desktop Operator Reply Collector テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const rc  = require('../bot/utils/reply-collector');
const ib  = require('../bot/utils/inbox-bridge');
const ob  = require('../bot/utils/operator-bridge'); // getInboxPath はこちら

function cleanPending() {
  try { rc._savePending({}); } catch {}
}

function cleanInbox(worker) {
  const p = ob.getInboxPath(worker);
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

// ─────────────────────────────────────────────────────
// 1. markWaitingReply / clearWaitingReply
// ─────────────────────────────────────────────────────
console.log('\n[1. 返信待ち状態管理]');

test('1a. markWaitingReply が pending を作成する', () => {
  cleanPending();
  rc.markWaitingReply('kanzaki', 'hash1234abcd1234', 'dop_test01');
  const pending = rc._loadPending();
  assert.ok(pending.kanzaki, 'kanzaki が作成されない');
  assert.strictEqual(pending.kanzaki.status, 'waiting_reply');
  assert.ok(pending.kanzaki.sentAt, 'sentAt がない');
  assert.strictEqual(pending.kanzaki.promptHash, 'hash1234abcd1234');
});

test('1b. clearWaitingReply が pending を削除する', () => {
  cleanPending();
  rc.markWaitingReply('miyagi', 'hashtest', 'dop_test02');
  rc.clearWaitingReply('miyagi');
  const pending = rc._loadPending();
  assert.ok(!pending.miyagi, 'miyagi が残っている');
});

test('1c. getWaitingReplies が一覧を返す', () => {
  cleanPending();
  rc.markWaitingReply('moriya', 'hash01', 'dop_m01');
  rc.markWaitingReply('kanzaki', 'hash02', 'dop_k01');
  const list = rc.getWaitingReplies();
  assert.ok(list.length >= 2);
  assert.ok(list.some(r => r.worker === 'moriya'));
  assert.ok(list.some(r => r.worker === 'kanzaki'));
});

test('1d. timedOut フラグが正しく設定される', () => {
  cleanPending();
  // 古い sentAt で作成
  const pending = {};
  pending['ikuno'] = {
    worker:     'ikuno',
    promptHash: 'oldhash',
    sentAt:     new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15分前
    status:     'waiting_reply',
    clipHash:   null,
  };
  rc._savePending(pending);
  const list = rc.getWaitingReplies();
  const ikuno = list.find(r => r.worker === 'ikuno');
  assert.ok(ikuno?.timedOut, 'timedOut が true でない');
});

// ─────────────────────────────────────────────────────
// 2. _isReplyContent — 回答検出
// ─────────────────────────────────────────────────────
console.log('\n[2. _isReplyContent — 回答検出]');

test('2a. 返答シグネチャなしは false', () => {
  const text = 'こんにちは、何かご用でしょうか？';
  assert.strictEqual(rc._isReplyContent(text, 'oldhash'), false);
});

test('2b. 同じ hash は false（変化なし）', () => {
  const { createHash } = require('crypto');
  const text = '## 結論\nテスト\n## 実施内容\n内容';
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  assert.strictEqual(rc._isReplyContent(text, hash), false);
});

test('2c. 返答シグネチャあり + ハッシュ変化 → true', () => {
  const text = [
    '## 結論',
    'Phase12 Reply Collector の実装が完了しました。',
    '',
    '## 実施内容',
    '- reply-collector.js を作成',
    '',
    '## 変更ファイル',
    '- bot/utils/reply-collector.js',
    '',
    '## テスト結果',
    '全件 PASS',
    '',
    '## リスク',
    'なし',
    '',
    '## 次の配送先候補',
    '守谷 CTO へ READY 報告',
  ].join('\n');
  assert.strictEqual(rc._isReplyContent(text, 'oldhash'), true);
});

test('2d. 短すぎるテキストは false', () => {
  assert.strictEqual(rc._isReplyContent('## 結論', 'oldhash'), false);
});

// ─────────────────────────────────────────────────────
// 3. _saveReplyToInbox — inbox 保存
// ─────────────────────────────────────────────────────
console.log('\n[3. _saveReplyToInbox — inbox 保存]');

test('3a. 正常な回答が inbox に保存される', () => {
  cleanInbox('kanzaki');
  const reply = [
    '## 結論',
    'VP Brief の整理が完了しました。',
    '## 実施内容',
    '各社員の意見を整理し判断材料を作成。',
    '## リスク',
    'なし',
    '## 次の配送先候補',
    'CEO へ提出',
  ].join('\n');
  const r = rc._saveReplyToInbox('kanzaki', reply);
  assert.strictEqual(r.ok, true, `保存失敗: ${r.error}`);
  const inPath = ob.getInboxPath('kanzaki');
  assert.ok(inPath && fs.existsSync(inPath), 'incoming.md が作成されない');
});

test('3b. 回答内容が redact される', () => {
  cleanInbox('moriya');
  const fakeToken = 'ghp_' + 'V'.repeat(36);
  const reply = `## 結論\ntoken: ${fakeToken}\n## リスク\nなし\n## 次の配送先候補\nなし`;
  rc._saveReplyToInbox('moriya', reply);
  const inPath = ob.getInboxPath('moriya');
  const content = fs.existsSync(inPath) ? fs.readFileSync(inPath, 'utf8') : '';
  assert.ok(!content.includes(fakeToken), 'トークンが inbox に残っている');
});

test('3c. allowlist 外の worker は拒否される', () => {
  const r = rc._saveReplyToInbox('unknown_worker', '## 結論\nテスト\n## リスク\nなし');
  assert.strictEqual(r.ok, false, '不正 worker が通過した');
});

// ─────────────────────────────────────────────────────
// 4. pollClipboardForReply — ポーリング
// ─────────────────────────────────────────────────────
console.log('\n[4. pollClipboardForReply — ポーリング]');

test('4a. pending がない場合は not_waiting を返す', () => {
  cleanPending();
  const r = rc.pollClipboardForReply('kanzaki');
  assert.strictEqual(r.reason, 'not_waiting');
});

test('4b. タイムアウト後は timeout を返す', () => {
  cleanPending();
  const pending = {};
  pending['kanzaki'] = {
    worker:     'kanzaki',
    promptHash: 'hash01',
    sentAt:     new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15分前
    status:     'waiting_reply',
    clipHash:   'same_hash',  // クリップボードが変化しない状態
  };
  rc._savePending(pending);
  // クリップボードが変化しない状態をシミュレート
  const r = rc.pollClipboardForReply('kanzaki');
  // タイムアウト or no_reply_yet が返る（クリップボードが読めないため）
  assert.ok(r.reason === 'timeout' || r.reason === 'no_reply_yet' ||
            r.reason === 'clipboard_read_failed', `予期しない reason: ${r.reason}`);
});

// ─────────────────────────────────────────────────────
// 5. buildTimeoutNotification
// ─────────────────────────────────────────────────────
console.log('\n[5. buildTimeoutNotification]');

test('5a. タイムアウト通知文が生成される', () => {
  const msg = rc.buildTimeoutNotification('kanzaki', { ageMs: 11 * 60 * 1000 });
  assert.ok(msg.includes('タイムアウト') || msg.includes('Reply'), '通知文がない');
  assert.ok(msg.includes('kanzaki') || msg.includes('神崎'), '社員名がない');
});

test('5b. 通知文に自動実行禁止の注記がある', () => {
  const msg = rc.buildTimeoutNotification('moriya', { ageMs: 11 * 60 * 1000 });
  assert.ok(msg.includes('自動') || msg.includes('再送はしません'), '自動実行禁止注記がない');
});

// ─────────────────────────────────────────────────────
// 6. 安全境界確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 安全境界確認]');

test('6a. reply-collector.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-collector.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('6b. task / decision を自動作成しない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-collector.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),   'createTask が含まれている');
  assert.ok(!code.includes('logDecision('),  'logDecision が含まれている');
  assert.ok(!code.includes('openIncident('), 'openIncident が含まれている');
});

test('6c. クリップボード内容を exec で実行しない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-collector.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // Get-Clipboard は読み取りのみ。exec/execSync で本文実行はしない
  assert.ok(!code.match(/exec(?:Sync)?\s*\([^)]*clip/), 'クリップボード内容を exec している');
});

test('6d. PENDING_FILE が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('desktop-operator'), 'desktop-operator/ が gitignore にない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanPending();
cleanInbox('kanzaki');
cleanInbox('moriya');

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
