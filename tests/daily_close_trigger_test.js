'use strict';
// Daily Closing Manager 自然文トリガーテスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const { buildClosingSummary } = require('../bot/utils/client-ops');

// ─────────────────────────────────────────────────────
// 1. 自然文トリガーのソース確認
// ─────────────────────────────────────────────────────
console.log('\n[1. 自然文トリガー定義]');

test('1a. DAILY_CLOSE_TRIGGERS 定数が定義されている', () => {
  assert.ok(src.includes('DAILY_CLOSE_TRIGGERS'), 'DAILY_CLOSE_TRIGGERS がない');
});

test('1b. 「作業終了」がトリガーに含まれる', () => {
  assert.ok(src.includes("'作業終了'"), '作業終了 がない');
});

test('1c. 「退勤」がトリガーに含まれる', () => {
  assert.ok(src.includes("'退勤'"), '退勤 がない');
});

test('1d. 「今日はここまで」がトリガーに含まれる', () => {
  assert.ok(src.includes("'今日はここまで'"), '今日はここまで がない');
});

test('1e. 「作業終わり」「終了します」「今日終わり」が含まれる', () => {
  assert.ok(src.includes("'作業終わり'"), '作業終わり がない');
  assert.ok(src.includes("'終了します'"), '終了します がない');
  assert.ok(src.includes("'今日終わり'"), '今日終わり がない');
});

// ─────────────────────────────────────────────────────
// 2. トリガー検知ロジック
// ─────────────────────────────────────────────────────
console.log('\n[2. トリガー検知ロジック]');

// src から DAILY_CLOSE_TRIGGERS の定義を読み取ってユニットテスト
const triggerMatch = src.match(/const DAILY_CLOSE_TRIGGERS\s*=\s*\[([\s\S]*?)\];/);
const triggers = triggerMatch
  ? triggerMatch[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || []
  : [];

test('2a. 「作業終了」がトリガーリストにある（直接検査）', () => {
  assert.ok(triggers.includes('作業終了'), `triggers: [${triggers.join(', ')}]`);
});

test('2b. 「退勤」がトリガーリストにある（直接検査）', () => {
  assert.ok(triggers.includes('退勤'), `triggers: [${triggers.join(', ')}]`);
});

test('2c. トリガーが includes で判定される（部分一致）', () => {
  // 「今日はここまでにします」のような文章でも検知できること
  const testMsg = '今日はここまでにします、お疲れ様でした';
  const matched = triggers.some(t => testMsg.includes(t));
  assert.ok(matched, 'includes 判定でトリガーが検知されない');
});

test('2d. 無関係な文章はトリガーしない', () => {
  const testMsg = '明日の予定を確認してください';
  const matched = triggers.some(t => testMsg.includes(t));
  assert.ok(!matched, '無関係な文章がトリガーされた');
});

// ─────────────────────────────────────────────────────
// 3. Bot 自身の投稿への非反応
// ─────────────────────────────────────────────────────
console.log('\n[3. Bot 自身の投稿への非反応]');

test('3a. message.author.bot チェックがハンドラの先頭にある', () => {
  const handlerIdx = src.indexOf("client.on('messageCreate'");
  const handlerArea = src.slice(handlerIdx, handlerIdx + 200);
  assert.ok(handlerArea.includes('message.author.bot'), 'bot チェックがない');
  // bot チェックがトリガーより前にある
  const botCheckIdx     = src.indexOf('message.author.bot', handlerIdx);
  const triggerCheckIdx = src.indexOf('DAILY_CLOSE_TRIGGERS', handlerIdx);
  assert.ok(botCheckIdx < triggerCheckIdx, 'bot チェックがトリガーより後にある');
});

// ─────────────────────────────────────────────────────
// 4. 連投防止ロジック
// ─────────────────────────────────────────────────────
console.log('\n[4. 連投防止ロジック]');

test('4a. _dailyCloseLastSent Map が定義されている', () => {
  assert.ok(src.includes('_dailyCloseLastSent'), '_dailyCloseLastSent がない');
  assert.ok(src.includes('new Map()'), 'Map が使われていない');
});

test('4b. DAILY_CLOSE_COOLDOWN_MS が 30 分に設定されている', () => {
  assert.ok(src.includes('DAILY_CLOSE_COOLDOWN_MS'), 'クールダウン定数がない');
  // 30 分 = 30 * 60 * 1000
  assert.ok(
    src.includes('30 * 60 * 1000') || src.includes('1800000'),
    '30分のクールダウンが設定されていない'
  );
});

test('4c. 同日同チャンネルのキーが channelId + 日付で生成される', () => {
  // トリガーブロック全体（2000文字）を検索
  const triggerArea = src.slice(
    src.indexOf('DAILY_CLOSE_TRIGGERS.some'),
    src.indexOf('DAILY_CLOSE_TRIGGERS.some') + 2000
  );
  assert.ok(triggerArea.includes('channelId'), 'channelId がキーに含まれない');
  assert.ok(triggerArea.includes('today') || triggerArea.includes('Date.now'), '日付がキーに含まれない');
});

test('4d. クールダウン中はスキップして送信しない', () => {
  // トリガーブロック内の elapsed チェックを確認
  const triggerArea = src.slice(
    src.indexOf('DAILY_CLOSE_TRIGGERS.some'),
    src.indexOf('DAILY_CLOSE_TRIGGERS.some') + 2000
  );
  assert.ok(triggerArea.includes('elapsed') || triggerArea.includes('残り'), 'クールダウン判定がない');
});

// ─────────────────────────────────────────────────────
// 5. buildClosingSummary の再利用
// ─────────────────────────────────────────────────────
console.log('\n[5. buildClosingSummary 再利用]');

test('5a. 自然文トリガーブロックが buildClosingSummary を呼ぶ', () => {
  const triggerBlock = src.slice(
    src.indexOf('DAILY_CLOSE_TRIGGERS.some'),
    src.indexOf('DAILY_CLOSE_TRIGGERS.some') + 800
  );
  assert.ok(triggerBlock.includes('buildClosingSummary'), 'buildClosingSummary が呼ばれない');
});

test('5b. Daily Closing Report タイトルが付く', () => {
  const triggerBlock = src.slice(
    src.indexOf('DAILY_CLOSE_TRIGGERS.some'),
    src.indexOf('DAILY_CLOSE_TRIGGERS.some') + 1500
  );
  assert.ok(triggerBlock.includes('Daily Closing Report'), 'Daily Closing Report タイトルがない');
});

test('5c. buildClosingSummary の戻り値が ok:true を返す', () => {
  const r = buildClosingSummary({});
  assert.strictEqual(r.ok, true);
});

test('5d. Claude A/B/C 分担・明日Top3 が含まれる', () => {
  const r = buildClosingSummary({});
  assert.ok(r.text.includes('Claude A') || r.text.includes('🅰️'), 'Claude A 分担がない');
  assert.ok(r.text.includes('明日'), '明日のおすすめがない');
});

// ─────────────────────────────────────────────────────
// 6. !close コマンドとの共存
// ─────────────────────────────────────────────────────
console.log('\n[6. !close コマンドとの共存]');

test('6a. !close コマンドが引き続き実装されている', () => {
  assert.ok(
    src.includes("content === '!close'") || src.includes("'!close'"),
    '!close コマンドが消えている'
  );
});

test('6b. 自然文トリガーが !close コマンドより前に処理される', () => {
  // 自然文トリガーはコマンドルーティングの前に配置
  const triggerIdx = src.indexOf('DAILY_CLOSE_TRIGGERS.some');
  const closeIdx   = src.indexOf("content === '!close'");
  assert.ok(triggerIdx < closeIdx, '自然文トリガーが !close より後にある');
});

test('6c. 自然文トリガー後に return; して !close と重複しない', () => {
  const triggerBlock = src.slice(
    src.indexOf('DAILY_CLOSE_TRIGGERS.some'),
    src.indexOf('DAILY_CLOSE_TRIGGERS.some') + 1900
  );
  // ブロックの最後に return がある（コメントに続いて return;）
  assert.ok(triggerBlock.includes('return;'), 'return がなく !close と重複する可能性');
});

// ─────────────────────────────────────────────────────
// 7. 既存テストとの互換性確認（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[7. 既存機能との互換性]');

test('7a. Security 機能（message.author.bot チェック）が変更されていない', () => {
  const handlerIdx = src.indexOf("client.on('messageCreate'");
  const first300   = src.slice(handlerIdx, handlerIdx + 300);
  assert.ok(first300.includes('if (message.author.bot) return'), 'bot チェックが変わっている');
});

test('7b. ALLOWED_CHANNEL_IDS フィルタが変更されていない', () => {
  assert.ok(src.includes('ALLOWED_CHANNEL_IDS.includes(message.channelId)'), 'チャンネルフィルタが変わっている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
