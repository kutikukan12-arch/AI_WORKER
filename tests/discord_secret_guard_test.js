'use strict';
// Discord Secret Guard テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const { guardDiscordContent, _extractText } =
  require('../bot/utils/secret-guardian');
const src = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
);

// ─── ダミー値 ─────────────────────────────────────────
const DUMMY_PAT     = 'github_pat_' + 'A'.repeat(80);
const DUMMY_OPENAI  = 'sk-proj-' + 'C'.repeat(92);
const DUMMY_DISCORD = 'MTUwOTU0ZZZZ0NDc3ODY1NzkzMg.GzAbCd.ZZZqrstuvwxyzABCDE_GUARD12';

// ─────────────────────────────────────────────────────
// 1. ダミーシークレット入り通知が BLOCK される
// ─────────────────────────────────────────────────────
console.log('\n[1. ダミーシークレット入り通知がBLOCKされる]');

test('1a. GitHub PAT を含む文字列 → allowed:false', () => {
  const result = guardDiscordContent(`エラー: ${DUMMY_PAT}`, { type: 'test' });
  assert.strictEqual(result.allowed, false);
  assert.ok(result.violations.length > 0, '違反が空');
});

test('1b. OpenAI Key を含む文字列 → allowed:false', () => {
  const result = guardDiscordContent(`key=${DUMMY_OPENAI}`, { type: 'test' });
  assert.strictEqual(result.allowed, false);
});

test('1c. Discord Token を含む文字列 → allowed:false', () => {
  const result = guardDiscordContent(`token: ${DUMMY_DISCORD}`, { type: 'test' });
  assert.strictEqual(result.allowed, false);
});

test('1d. Embed オブジェクト内にシークレットがある → blocked', () => {
  const embed = {
    embeds: [{
      title: 'エラー報告',
      description: `詳細: GITHUB_TOKEN=${DUMMY_PAT}`,
      fields: [{ name: '状態', value: '失敗' }],
    }],
  };
  const result = guardDiscordContent(embed, { type: 'embed' });
  assert.strictEqual(result.allowed, false);
});

test('1e. alertText は CEO向けアラートを含む（値なし）', () => {
  const result = guardDiscordContent(DUMMY_PAT, { type: 'ceoReport' });
  assert.ok(result.alertText, 'alertText がない');
  assert.ok(result.alertText.includes('差し止め') || result.alertText.includes('ブロック'), '差し止め説明がない');
  // 実際の値が含まれていないこと
  assert.ok(!result.alertText.includes('github_pat_'), 'PAT 値がアラートに漏洩');
  assert.ok(!result.alertText.includes(DUMMY_PAT.slice(20)), 'PAT 値の一部がアラートに漏洩');
});

// ─────────────────────────────────────────────────────
// 2. 通常通知は通過する
// ─────────────────────────────────────────────────────
console.log('\n[2. 通常通知は通過する]');

test('2a. 通常テキストは allowed:true', () => {
  const result = guardDiscordContent('タスクが完了しました。✅');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.violations.length, 0);
});

test('2b. 空文字は allowed:true', () => {
  const result = guardDiscordContent('');
  assert.strictEqual(result.allowed, true);
});

test('2c. null/undefined は allowed:true（クラッシュしない）', () => {
  assert.strictEqual(guardDiscordContent(null).allowed, true);
  assert.strictEqual(guardDiscordContent(undefined).allowed, true);
});

test('2d. Embed オブジェクト（秘密なし）は通過する', () => {
  const embed = {
    embeds: [{
      title: 'Project Runner 完了',
      description: 'タスク5件が完了しました。',
      fields: [{ name: '品質', value: '🟢 GREEN' }],
    }],
  };
  const result = guardDiscordContent(embed, { type: 'boardReport' });
  assert.strictEqual(result.allowed, true);
});

test('2e. ガード自体が例外を投げても allowed:true を返す（Bot を落とさない）', () => {
  // 壊れたオブジェクトを渡しても例外が上位に伝播しない
  const circular = {};
  circular.self = circular;
  const result = guardDiscordContent(circular, {});
  assert.strictEqual(result.allowed, true, 'ガード例外が上位に漏れた');
});

// ─────────────────────────────────────────────────────
// 3. 値がマスクされる（アラートに値を含まない）
// ─────────────────────────────────────────────────────
console.log('\n[3. 値がアラート・ログに出ない]');

test('3a. CRITICAL 検出時の alertText に実際のトークン値が含まれない', () => {
  const result = guardDiscordContent(
    `error: token=${DUMMY_DISCORD}`, { type: 'humanMention' }
  );
  if (!result.allowed && result.alertText) {
    assert.ok(!result.alertText.includes('MTUwOTU0'), 'Discord Token 値が漏洩');
    assert.ok(!result.alertText.includes(DUMMY_DISCORD.slice(0, 15)), 'Token 先頭が漏洩');
  }
});

test('3b. security レポートに値が保存されていない', () => {
  // セキュリティレポートファイルを確認
  const logDir = path.join(__dirname, '..', 'logs');
  const reportFiles = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter(f => f.startsWith('security-') && f.endsWith('.json'))
    : [];
  for (const file of reportFiles) {
    const content = fs.readFileSync(path.join(logDir, file), 'utf8');
    assert.ok(!content.includes(DUMMY_PAT), `${file} に PAT 値が保存されている`);
    assert.ok(!content.includes(DUMMY_OPENAI), `${file} に OpenAI Key が保存されている`);
  }
});

// ─────────────────────────────────────────────────────
// 4. _extractText — テキスト抽出
// ─────────────────────────────────────────────────────
console.log('\n[4. テキスト抽出（Embed対応）]');

test('4a. 文字列をそのまま返す', () => {
  assert.strictEqual(_extractText('hello'), 'hello');
});

test('4b. embed の title/description/fields を抽出する', () => {
  const embed = {
    embeds: [{
      title: 'TITLE',
      description: 'DESC',
      fields: [{ name: 'KEY', value: 'VAL' }],
    }],
  };
  const text = _extractText(embed);
  assert.ok(text.includes('TITLE'), 'title が抽出されていない');
  assert.ok(text.includes('DESC'), 'description が抽出されていない');
  assert.ok(text.includes('KEY') && text.includes('VAL'), 'fields が抽出されていない');
});

test('4c. null/undefined → 空文字', () => {
  assert.strictEqual(_extractText(null), '');
  assert.strictEqual(_extractText(undefined), '');
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認（既存通知テストが壊れない）
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test('5a. sendNotification に guardDiscordContent が組み込まれている', () => {
  const fnIdx  = src.indexOf('async function sendNotification');
  const fnEnd  = src.indexOf('\nasync function ', fnIdx + 1);
  const fnBody = src.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 2000);
  assert.ok(fnBody.includes('guardDiscordContent'), 'sendNotification に guard がない');
});

test('5b. sendHumanMention に guardDiscordContent が組み込まれている', () => {
  const fnIdx  = src.indexOf('async function sendHumanMention');
  const fnEnd  = src.indexOf('\nasync function sendPRHumanConfirm', fnIdx);
  const fnBody = src.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 2000);
  assert.ok(fnBody.includes('guardDiscordContent'), 'sendHumanMention に guard がない');
});

test('5c. ガードエラー時は送信継続（Bot を落とさない）', () => {
  // try { ... } catch { /* ガードのエラーは無視 */ } パターンがある
  const fnIdx  = src.indexOf('async function sendNotification');
  const fnBody = src.slice(fnIdx, fnIdx + 1500);
  assert.ok(
    fnBody.includes('ガードのエラーは無視') || fnBody.includes('ガードのエラー') || fnBody.includes('catch { /* ガード'),
    'ガードエラー時の継続処理がない'
  );
});

test('5d. 既存の sendNotification ロジック（channelId/fallback）が維持されている', () => {
  const fnIdx  = src.indexOf('async function sendNotification');
  const fnBody = src.slice(fnIdx, fnIdx + 2000);
  assert.ok(fnBody.includes('channelId'), 'channelId が消えている');
  assert.ok(fnBody.includes('fallback.send'), 'fallback 送信が消えている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
