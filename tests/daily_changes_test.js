'use strict';
// Daily Changes + Daily Closing 強化テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const dc  = require('../bot/utils/daily-changes');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetChanges() { dc._saveAll({}); }

// ─────────────────────────────────────────────────────
// 1. addChange — !change command/rule/ops/category/channel
// ─────────────────────────────────────────────────────
console.log('\n[1. addChange — 各タイプの記録]');

test('1a. !change command で記録できる', () => {
  resetChanges();
  const r = dc.addChange('command', '!store audit 出品文監査を追加');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'command');
});

test('1b. !change rule で記録できる', () => {
  resetChanges();
  const r = dc.addChange('rule', '初期3件はLOW案件中心');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'rule');
});

test('1c. !change ops で記録できる', () => {
  resetChanges();
  const r = dc.addChange('ops', '納品前は !delivery check 必須');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'ops');
});

test('1d. !change category で記録できる', () => {
  resetChanges();
  const r = dc.addChange('category', '🏢経営 カテゴリを追加');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'category');
});

test('1e. !change channel で記録できる', () => {
  resetChanges();
  const r = dc.addChange('channel', '#進捗報告 チャンネルを追加');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'channel');
});

test('1f. 無効な type でエラー', () => {
  const r = dc.addChange('invalid', 'テスト');
  assert.strictEqual(r.ok, false);
});

test('1g. 空の内容でエラー', () => {
  const r = dc.addChange('command', '');
  assert.strictEqual(r.ok, false);
});

// ─────────────────────────────────────────────────────
// 2. listChanges — 分類表示
// ─────────────────────────────────────────────────────
console.log('\n[2. listChanges — 分類表示]');

test('2a. !change list で全分類が表示される', () => {
  resetChanges();
  dc.addChange('command', 'コマンド1');
  dc.addChange('rule', 'ルール1');
  const r = dc.listChanges();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('コマンド'), 'コマンド分類がない');
  assert.ok(r.text.includes('ルール'), 'ルール分類がない');
  assert.ok(r.text.includes('運用'), '運用分類がない');
});

test('2b. 空の分類は「更新なし」と表示される', () => {
  resetChanges();
  dc.addChange('command', 'コマンドのみ追加');
  const r = dc.listChanges();
  assert.ok(r.text.includes('更新なし'), '更新なし表示がない');
});

test('2c. 何もない場合も ok:true を返す', () => {
  resetChanges();
  const r = dc.listChanges();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hasAny, false);
});

// ─────────────────────────────────────────────────────
// 3. 各分類最大5件制限
// ─────────────────────────────────────────────────────
console.log('\n[3. 最大5件制限]');

test('3a. 同じ type で6件目はエラー', () => {
  resetChanges();
  for (let i = 0; i < 5; i++) dc.addChange('command', `コマンド${i + 1}`);
  const r = dc.addChange('command', '6件目');
  assert.strictEqual(r.ok, false, '6件目が成功してしまった');
});

test('3b. listChanges は各分類最大5件を表示する', () => {
  resetChanges();
  for (let i = 0; i < 5; i++) dc.addChange('rule', `ルール${i + 1}`);
  const r = dc.listChanges();
  // ルール5件が含まれること
  assert.ok(r.text.includes('ルール5'), 'ルール5が表示されない');
});

// ─────────────────────────────────────────────────────
// 4. PII・秘密情報が redact される
// ─────────────────────────────────────────────────────
console.log('\n[4. PII/秘密情報の redact]');

test('4a. ghp_ トークンが保存前にマスクされる', () => {
  resetChanges();
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  dc.addChange('command', `token: ${fakeToken}`);
  const all  = dc._loadAll();
  const day  = all[dc._today()];
  const item = day?.command?.[0];
  assert.ok(item, '保存されていない');
  assert.ok(!item.text.includes(fakeToken), 'トークンが raw 保存された');
  assert.ok(item.text.includes('[MASKED]'), 'MASKED がない');
});

test('4b. メールアドレスが保存前にマスクされる', () => {
  resetChanges();
  dc.addChange('ops', '担当: admin@example.com に連絡');
  const all  = dc._loadAll();
  const day  = all[dc._today()];
  const item = day?.ops?.[0];
  assert.ok(!item.text.includes('admin@example.com'), 'メールが raw 保存された');
  assert.ok(item.text.includes('[PII]') || item.text.includes('[MASKED]'), 'マスクがない');
});

// ─────────────────────────────────────────────────────
// 5. !close に「今日更新されたもの」が出る
// ─────────────────────────────────────────────────────
console.log('\n[5. !close / 自然文トリガーへの統合]');

test('5a. buildChangesSection が今日の更新を含むテキストを返す', () => {
  resetChanges();
  dc.addChange('command', 'テストコマンド追加');
  dc.addChange('rule', 'テストルール変更');
  const section = dc.buildChangesSection();
  assert.ok(section.includes('テストコマンド追加'), 'command が含まれない');
  assert.ok(section.includes('テストルール変更'), 'rule が含まれない');
});

test('5b. !close に buildChangesSection が統合されている（ソース確認）', () => {
  const closeIdx  = src.indexOf("content === '!close'");
  const closeArea = src.slice(closeIdx, closeIdx + 600);
  assert.ok(closeArea.includes('buildChangesSection'), '!close に buildChangesSection がない');
  assert.ok(closeArea.includes('Daily Closing Report'), 'Daily Closing Report タイトルがない');
});

test('5c. 自然文トリガーにも buildChangesSection が統合されている', () => {
  const triggerIdx  = src.indexOf('DAILY_CLOSE_TRIGGERS.some');
  const triggerArea = src.slice(triggerIdx, triggerIdx + 1200);
  assert.ok(triggerArea.includes('buildChangesSection'), '自然文トリガーに buildChangesSection がない');
});

test('5d. 「今日更新されたもの」の絵文字マーカーが含まれる（分類表示）', () => {
  resetChanges();
  dc.addChange('channel', '#テストチャンネル');
  const section = dc.buildChangesSection();
  assert.ok(section.includes('💬') || section.includes('チャンネル'), 'チャンネル絵文字がない');
});

// ─────────────────────────────────────────────────────
// 6. clearChanges
// ─────────────────────────────────────────────────────
console.log('\n[6. clearChanges]');

test('6a. clearChanges で今日の記録が消える', () => {
  resetChanges();
  dc.addChange('command', '削除されるはず');
  dc.clearChanges();
  const r = dc.listChanges();
  assert.strictEqual(r.hasAny, false, 'クリア後もデータが残っている');
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test('7a. !change コマンドが実装されている', () => {
  assert.ok(src.includes("startsWith('!change')"), '!change がない');
  assert.ok(src.includes('addChange'), 'addChange 呼び出しがない');
});

test('7b. !change list が実装されている', () => {
  const idx  = src.indexOf("startsWith('!change')");
  const area = src.slice(idx, idx + 500);
  assert.ok(area.includes("sub === 'list'"), '!change list がない');
});

test('7c. !change clear は Owner 限定', () => {
  const idx  = src.indexOf("startsWith('!change')");
  const area = src.slice(idx, idx + 800);
  assert.ok(area.includes("sub === 'clear'") && area.includes('DISCORD_OWNER_ID'), 'Owner 制限がない');
});

test('7d. daily-changes.json が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('daily-changes.json'), '.gitignore に daily-changes.json がない');
});

test('7e. 30分以内の自然文重複防止が維持されている', () => {
  assert.ok(src.includes('DAILY_CLOSE_COOLDOWN_MS'), '30分クールダウンが消えている');
});

// クリーンアップ
resetChanges();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
