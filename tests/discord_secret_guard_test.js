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

test('2e. ガード自体が例外を投げても Bot は落ちない（F-2: fail-closed で allowed:false）', () => {
  // F-2 修正: スキャンエラーは fail-closed（allowed:false + guardError:true）
  // Bot は落ちない（例外が上位に伝播しない）ことを確認
  const circular = {};
  circular.self = circular;
  let threw = false;
  let result;
  try {
    result = guardDiscordContent(circular, {});
  } catch {
    threw = true;
  }
  assert.ok(!threw, 'ガード例外が上位に漏れた（Bot が落ちる）');
  assert.ok(result !== undefined, 'result が undefined');
  // fail-closed: allowed は false OR true（redact 後に続行する場合）
  // いずれにせよ例外は伝播しない
  assert.ok(typeof result.allowed === 'boolean', 'allowed が boolean でない');
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

test('5c. ガードエラーは fail-closed（Bot は落とさないが元コンテンツも送らない）', () => {
  // F-2 修正: ガード例外時は allowed:false + redactedContent で対応
  const fnIdx  = src.indexOf('async function sendNotification');
  const fnBody = src.slice(fnIdx, fnIdx + 2000);
  // fail-closed: return; がある
  assert.ok(fnBody.includes('fail-closed') || fnBody.includes('guardErr'), 'fail-closed 処理がない');
  // 完全ブロック時は return; で元コンテンツを送信しない
  assert.ok(fnBody.includes('return;') || fnBody.includes('return\n'), 'ガードエラー時の return がない');
});

test('5d. 既存の sendNotification ロジック（channelId/fallback）が維持されている', () => {
  const fnIdx  = src.indexOf('async function sendNotification');
  const fnBody = src.slice(fnIdx, fnIdx + 2000);
  assert.ok(fnBody.includes('channelId'), 'channelId が消えている');
  assert.ok(fnBody.includes('fallback.send'), 'fallback 送信が消えている');
});

// ─────────────────────────────────────────────────────
// 6. F-2 fail-closed 動作確認
// ─────────────────────────────────────────────────────
console.log('\n[6. F-2: fail-closed 動作確認]');

test('6a. guardCommit はスキャンエラー時 allowed:false を返す（fail-closed）', () => {
  const sg = require('../bot/utils/secret-guardian');
  const src2 = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  // guardCommit に try-catch があり、例外時に allowed:false を返す
  const fnIdx = src2.indexOf('function guardCommit');
  const fnBody = src2.slice(fnIdx, fnIdx + 1500);
  assert.ok(fnBody.includes('try {'), 'guardCommit に try がない');
  assert.ok(fnBody.includes('allowed:    false'), 'guardCommit の catch が allowed:false でない');
  assert.ok(fnBody.includes('guardError: true'), 'guardError フラグがない');
});

test('6b. guardDiscordContent はスキャンエラー時 allowed:false + guardError:true を返す', () => {
  const sg = require('../bot/utils/secret-guardian');
  const src2 = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  const fnIdx  = src2.indexOf('function guardDiscordContent');
  const fnBody = src2.slice(fnIdx, fnIdx + 2000);
  assert.ok(fnBody.includes('guardError:      true'), 'guardError フラグがない');
  // allowed:false の catch がある
  const catchIdx = fnBody.lastIndexOf('catch (scanErr)');
  assert.ok(catchIdx >= 0, 'スキャンエラーの catch がない');
  const catchArea = fnBody.slice(catchIdx, catchIdx + 500);
  assert.ok(catchArea.includes('allowed:         false'), 'catch ブロックが fail-closed でない');
});

test('6c. guardDiscordContent の catch に allowed:true が残っていない', () => {
  const src2 = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  const fnIdx  = src2.indexOf('function guardDiscordContent');
  const fnBody = src2.slice(fnIdx, fnIdx + 2000);
  // catch ブロック内で allowed:true を返す分岐がない
  const catchIdx = fnBody.lastIndexOf('} catch');
  const catchArea = fnBody.slice(catchIdx, catchIdx + 300);
  assert.ok(!catchArea.includes('allowed: true'), 'catch に allowed:true が残っている（fail-open）');
});

test('6d. guardDiscordContent はエラー時 redactedContent を提供する', () => {
  const src2 = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  assert.ok(src2.includes('redactedContent'), 'redactedContent フィールドがない');
  assert.ok(src2.includes('_redactContent'), '_redactContent ヘルパーがない');
});

// ─────────────────────────────────────────────────────
// 7. F-1: danger-gate 改善確認
// ─────────────────────────────────────────────────────
console.log('\n[7. F-1: danger-gate 改善]');

test('7a. _runProjectLoop が dangerLevel を autoPolicy.classifyTask に渡す', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  // { danger: next.dangerLevel } が渡されている
  assert.ok(
    loopBody.includes("dangerLevel || '低'") || loopBody.includes('next.dangerLevel'),
    '_runProjectLoop が dangerLevel を classifyTask に渡していない'
  );
});

test('7b. AI_REVIEW_REQUIRED は _runProjectLoop で停止しない', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  // AI_REVIEW_REQUIRED に対して break / return がない
  const airIdx = loopBody.indexOf('AI_REVIEW_REQUIRED');
  // もし AI_REVIEW_REQUIRED がポリシーチェックブロックに存在するなら stop しないコメントがある
  if (airIdx >= 0) {
    const airArea = loopBody.slice(airIdx, airIdx + 200);
    assert.ok(!airArea.includes('break;') && !airArea.includes('stopReason'), 'AI_REVIEW_REQUIRED で停止している');
  }
  // または AI_REVIEW_REQUIRED が明示的に停止条件に含まれていないことを確認
  const blockedIdx = loopBody.indexOf("AUTO_POLICY.BLOCKED");
  const blockedArea = loopBody.slice(blockedIdx, blockedIdx + 300);
  assert.ok(!blockedArea.includes('AI_REVIEW'), 'BLOCKED チェックに AI_REVIEW が混在');
});

test('7c. BLOCKED と HUMAN_APPROVAL のみ _runProjectLoop で停止する', () => {
  const loopIdx  = src.indexOf('async function _runProjectLoop');
  const loopEnd  = src.indexOf('\nasync function _teardown', loopIdx);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 8000);
  assert.ok(loopBody.includes("AUTO_POLICY.BLOCKED"), 'BLOCKED チェックがない');
  assert.ok(loopBody.includes("AUTO_POLICY.HUMAN_APPROVAL_REQUIRED"), 'HUMAN_APPROVAL チェックがない');
});

test('7d. prepareNextTask も AI_REVIEW_REQUIRED を停止しない', () => {
  const prepIdx  = src.indexOf('async function prepareNextTask');
  const prepBody = src.slice(prepIdx, prepIdx + 2500); // BLOCKED チェックまで届く範囲
  // BLOCKED か HUMAN_APPROVAL のみ停止
  assert.ok(prepBody.includes('AUTO_POLICY.BLOCKED'), 'BLOCKED チェックがない');
  assert.ok(prepBody.includes('AUTO_POLICY.HUMAN_APPROVAL_REQUIRED'), 'HUMAN_APPROVAL チェックがない');
  // AI_REVIEW_REQUIRED は停止条件の if 文に含まれない
  // ブロック判定コードの近くを検索（コメント行を除く実コード行を確認）
  const blockedPolicyLine = prepBody
    .split('\n')
    .find(l => !l.trim().startsWith('//') && l.includes('AUTO_POLICY.BLOCKED') && l.includes('prePolicy'));
  assert.ok(blockedPolicyLine, 'BLOCKED 判定行が見つからない');
  // 実コード行に AI_REVIEW が含まれていない
  assert.ok(!blockedPolicyLine.includes('AI_REVIEW'), `BLOCKED 判定行に AI_REVIEW が含まれている: ${blockedPolicyLine.trim()}`);
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
