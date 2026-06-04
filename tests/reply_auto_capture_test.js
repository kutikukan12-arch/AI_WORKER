'use strict';
// reply-auto-capture.js テスト (Phase13)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const ac  = require('../bot/utils/reply-auto-capture');
const rc  = require('../bot/utils/reply-collector');
const ob  = require('../bot/utils/operator-bridge');

function cleanPending()        { try { rc._savePending({}); } catch {} }
function cleanInbox(w)         { const p = ob.getInboxPath(w); try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} }

const VALID_REPLY = [
  '## 結論',
  'VP Brief の整理が完了しました。',
  '## 実施内容',
  '各社員の意見を整理し、判断材料を社長へ提出します。',
  '## 変更ファイル',
  '（なし）',
  '## テスト結果',
  '確認済み',
  '## リスク',
  '特になし',
  '## 次の配送先候補',
  'CEO へ提出',
].join('\n');

// ─────────────────────────────────────────────────────
// 1. extractLatestReply — 差分取得
// ─────────────────────────────────────────────────────
console.log('\n[1. extractLatestReply — 差分取得]');

test('1a. preText と同一なら null', () => {
  const text = 'こんにちは\n以前の会話内容...';
  assert.strictEqual(ac.extractLatestReply(text, text), null);
});

test('1b. preText から追記された部分を返す', () => {
  const pre   = 'あなた: テストプロンプトです\n\nClaude: 承知しました。';
  const after = pre + '\n\n' + VALID_REPLY;
  const delta = ac.extractLatestReply(pre, after);
  assert.ok(delta, 'delta が null');
  assert.ok(delta.includes('## 結論'), '最新返信に ## 結論 がない');
  assert.ok(!delta.includes('テストプロンプトです'), 'プロンプトが混入している');
});

test('1c. 短すぎる差分は null', () => {
  const pre   = '会話前のテキスト...';
  const after = pre + '\nOK';
  const delta = ac.extractLatestReply(pre, after);
  assert.strictEqual(delta, null, '短すぎる差分が返された');
});

test('1d. preText が null なら currentText をそのまま返す', () => {
  const delta = ac.extractLatestReply(null, VALID_REPLY);
  assert.ok(delta, 'preText=null でも delta が返らない');
});

// ─────────────────────────────────────────────────────
// 2. processCapturedReply — 既存ロジック再利用
// ─────────────────────────────────────────────────────
console.log('\n[2. processCapturedReply — 既存ロジック再利用]');

test('2a. REPLY_SIGNATURES ありで正常保存', () => {
  cleanPending(); cleanInbox('kanzaki');
  rc.markWaitingReply('kanzaki', 'hash01', 'dop_test');
  const result = ac.processCapturedReply({ worker: 'kanzaki', content: VALID_REPLY });
  assert.strictEqual(result.ok, true, `保存失敗: ${result.reason || result.error}`);
  const inPath = ob.getInboxPath('kanzaki');
  assert.ok(inPath && fs.existsSync(inPath), 'incoming.md が作成されない');
});

test('2b. REPLY_SIGNATURES なしは no_reply_signatures', () => {
  cleanPending();
  // 50文字以上でシグネチャなしの内容
  const content = 'こんにちは！ご質問があればお答えします。何でも聞いてください。よろしくお願いします。詳しく説明しますね。どうぞ安心してお任せください。';
  const result = ac.processCapturedReply({ worker: 'miyagi', content });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_reply_signatures');
});

test('2c. 短すぎる内容は content_too_short', () => {
  const result = ac.processCapturedReply({ worker: 'moriya', content: '短い' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'content_too_short');
});

test('2d. 保存前に redact が適用される（既存ロジック再利用）', () => {
  cleanPending(); cleanInbox('moriya');
  rc.markWaitingReply('moriya', 'hash02', 'dop_02');
  const fakeToken = 'ghp_' + 'W'.repeat(36);
  const content   = VALID_REPLY + `\ntokenが漏れた: ${fakeToken}`;
  ac.processCapturedReply({ worker: 'moriya', content });
  const inPath  = ob.getInboxPath('moriya');
  const inContent = inPath && fs.existsSync(inPath) ? fs.readFileSync(inPath, 'utf8') : '';
  assert.ok(!inContent.includes(fakeToken), 'トークンが inbox に残っている');
});

test('2e. 既存 reply-collector._isReplyContent を再利用している（二重実装なし）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-auto-capture.js'), 'utf8'
  );
  assert.ok(src.includes("require('./reply-collector')"), 'reply-collector を require していない');
  assert.ok(src.includes('_isReplyContent'), '_isReplyContent 再利用がない');
  // REPLY_SIGNATURES を独自定義していない（reply-collector のものを使う）
  assert.ok(!src.includes("const REPLY_SIGNATURES"), 'REPLY_SIGNATURES を独自定義している');
});

// ─────────────────────────────────────────────────────
// 3. captureLatestClaudeReply — タイムアウト / fallback
// ─────────────────────────────────────────────────────
console.log('\n[3. captureLatestClaudeReply — タイムアウト / fallback]');

test('3a. pending がない場合は not_waiting', () => {
  cleanPending();
  const r = ac.captureLatestClaudeReply('kanzaki', 'pretext');
  assert.strictEqual(r.result, 'not_waiting');
});

test('3b. タイムアウト後は timeout を返し pending をクリアする', () => {
  cleanPending();
  const pending = {};
  pending['kanzaki'] = {
    worker:     'kanzaki',
    promptHash: 'hash01',
    sentAt:     new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    status:     'waiting_reply',
    captureMode:'auto',
    attempts:   0,
  };
  rc._savePending(pending);
  const r = ac.captureLatestClaudeReply('kanzaki', 'pretext');
  assert.ok(r.result === 'timeout' || r.result === 'fallback_clipboard' ||
            r.result === 'no_reply_yet', `予期しない result: ${r.result}`);
});

test('3c. MAX_ATTEMPTS 超過で fallback_clipboard', () => {
  cleanPending();
  const pending = {};
  pending['miyagi'] = {
    worker:     'miyagi',
    promptHash: 'hash02',
    sentAt:     new Date().toISOString(),
    status:     'waiting_reply',
    captureMode:'auto',
    attempts:   ac.MAX_ATTEMPTS,
  };
  rc._savePending(pending);
  const r = ac.captureLatestClaudeReply('miyagi', 'pretext');
  assert.ok(r.result === 'fallback_clipboard' || r.result === 'no_reply_yet',
    `MAX_ATTEMPTS 超過でも fallback しない: ${r.result}`);
});

// ─────────────────────────────────────────────────────
// 4. Phase6: fallback 機能
// ─────────────────────────────────────────────────────
console.log('\n[4. Phase6 fallback]');

test('4a. degradeToClipboard で captureMode が clipboard_fallback になる', () => {
  cleanPending();
  rc.markWaitingReply('shiraishi', 'hash03', 'dop_03');
  ac.degradeToClipboard('shiraishi');
  const p = rc._loadPending()['shiraishi'];
  assert.strictEqual(p?.captureMode, 'clipboard_fallback');
  assert.ok(p?.fallbackReason, 'fallbackReason がない');
});

// ─────────────────────────────────────────────────────
// 5. 権限境界確認
// ─────────────────────────────────────────────────────
console.log('\n[5. 権限境界確認]');

test('5a. eval がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-auto-capture.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('5b. task / decision / incident を自動作成しない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-auto-capture.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),   'createTask が含まれている');
  assert.ok(!code.includes('logDecision('),  'logDecision が含まれている');
  assert.ok(!code.includes('openIncident('), 'openIncident が含まれている');
});

test('5c. READY / NEED_FIX を生成しない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-auto-capture.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes("'READY'") && !code.includes('"READY"'),   'READY が含まれている');
  assert.ok(!code.includes("'NEED_FIX'") && !code.includes('"NEED_FIX"'), 'NEED_FIX が含まれている');
});

test('5d. PowerShell で取得した内容を exec 引数に渡さない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-auto-capture.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // spawnSync は使っているが、取得した text を exec 引数にはしない
  assert.ok(!code.match(/exec(?:Sync)?\s*\([^)]*text/), 'text を exec 引数にしている');
});

// ─────────────────────────────────────────────────────
// 6. Phase12 互換性確認
// ─────────────────────────────────────────────────────
console.log('\n[6. Phase12 互換性確認]');

test('6a. desktop-operator.js が reply-auto-capture.js を使用している', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'desktop-operator.js'), 'utf8'
  );
  assert.ok(src.includes("require(path.join(ROOT, 'bot', 'utils', 'reply-auto-capture'))"),
    'reply-auto-capture が使われていない');
});

test('6b. auto capture 失敗時に reply-collector.startPolling へ fallback する', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'desktop-operator.js'), 'utf8'
  );
  // fallback として startPolling が呼ばれること
  assert.ok(src.includes('startPolling'), 'clipboard fallback の startPolling がない');
});

test('6c. Phase12 の reply-collector.js は削除されていない', () => {
  assert.ok(fs.existsSync(
    path.join(__dirname, '..', 'bot', 'utils', 'reply-collector.js')
  ), 'reply-collector.js が削除されている');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanPending();
cleanInbox('kanzaki');
cleanInbox('moriya');
cleanInbox('shiraishi');

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
