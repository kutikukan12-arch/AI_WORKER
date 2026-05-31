'use strict';
// セキュリティ: redact.js（単一サニタイズ層）テスト

const assert  = require('assert');
const { redact, MASK } = require('../bot/utils/redact');
const github  = require('../bot/utils/github');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function masked(s)   { return s.includes(MASK); }
function leaks(s, v) { return s.includes(v); }

// ─────────────────────────────────────────────────────
// 1. トークン種別ごとのマスク
// ─────────────────────────────────────────────────────
console.log('\n[1. 秘密情報のマスク]');

test('1a. GitHub PAT (ghp_)', () => {
  const out = redact('push failed: token ghp_ABCDEF1234567890abcdef used');
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, 'ghp_ABCDEF1234567890abcdef'), 'ghp_ が漏洩');
});

test('1b. GitHub fine-grained PAT (github_pat_)', () => {
  const out = redact('github_pat_11ABCDE0123456789_abcdefGHIJKL');
  assert.ok(masked(out) && !leaks(out, 'github_pat_11ABCDE0123456789_abcdefGHIJKL'));
});

test('1c. Bearer token', () => {
  const out = redact('Authorization: Bearer abcDEF123456ghiJKL789');
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, 'abcDEF123456ghiJKL789'), 'Bearer 値が漏洩');
  assert.ok(out.includes('Bearer'), 'Bearer ラベルまで消えた');
});

test('1d. 単独 Bearer（Authorization なし）', () => {
  const out = redact('header set to Bearer eyAbc123Def456Ghi789Jkl');
  assert.ok(masked(out) && !leaks(out, 'eyAbc123Def456Ghi789Jkl'));
});

test('1e. API key (api_key=)', () => {
  const out = redact('config: api_key=sk-live-9f8e7d6c5b4a3210');
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, 'sk-live-9f8e7d6c5b4a3210'), 'api_key 値が漏洩');
});

test('1f. *_TOKEN（DISCORD_TOKEN=）', () => {
  const out = redact('DISCORD_TOKEN=MTIzNDU2Nzg5.GhIjKl.mnopqrstuvwxyz');
  assert.ok(masked(out) && !leaks(out, 'MTIzNDU2Nzg5.GhIjKl.mnopqrstuvwxyz'));
});

test('1g. *_KEY（OPENAI_API_KEY:）', () => {
  const out = redact('OPENAI_API_KEY: sk-proj-abc123def456ghi789');
  assert.ok(masked(out) && !leaks(out, 'sk-proj-abc123def456ghi789'));
});

test('1h. *_SECRET（CLIENT_SECRET=）', () => {
  const out = redact('CLIENT_SECRET="s3cr3t-Value-0987654321"');
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, 's3cr3t-Value-0987654321'), 'secret 値が漏洩');
});

test('1i. PASSWORD（PASSWORD=）', () => {
  const out = redact('db PASSWORD=Hunter2!very-long-pass');
  assert.ok(masked(out) && !leaks(out, 'Hunter2!very-long-pass'));
});

test('1j. JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  const out = redact('token=' + jwt);
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, jwt), 'JWT が漏洩');
});

test('1k. PEM 秘密鍵ブロック', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\nabcdEFGHijkl\n-----END RSA PRIVATE KEY-----';
  const out = redact('key loaded:\n' + pem);
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, 'MIIEpAIBAAKCAQEA1234567890'), '秘密鍵本体が漏洩');
});

test('1l. URL 埋め込み資格情報', () => {
  const out = redact('remote: https://user:ghp_secret123456789@github.com/x/y.git');
  assert.ok(masked(out), 'マスクなし');
  assert.ok(!leaks(out, 'ghp_secret123456789'), 'URL 埋め込みトークンが漏洩');
});

test('1m. 汎用 40文字以上の英数字列', () => {
  const out = redact('hash=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef');
  assert.ok(masked(out) && !leaks(out, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'));
});

// ─────────────────────────────────────────────────────
// 2. 誤マスク抑制（通常文・分類キーワードを壊さない）
// ─────────────────────────────────────────────────────
console.log('\n[2. 誤マスク抑制]');

test('2a. 通常のエラー文はそのまま', () => {
  const msg = '⏱️ タイムアウト: 5分以内に完了しませんでした';
  assert.strictEqual(redact(msg), msg);
});

test('2b. "permission denied" を壊さない', () => {
  const msg = 'Error: EACCES: permission denied, open /var/log/app.log';
  assert.strictEqual(redact(msg), msg);
});

test('2c. 代入形でない "api key" 文言は残す（分類キーワード保護）', () => {
  const msg = 'Invalid api key provided';
  // '=' や ':' を伴わないため値マスク対象外。文言は保持される。
  assert.ok(redact(msg).includes('api key'), 'api key 文言が消えた');
});

test('2d. 短い通常単語を潰さない', () => {
  const msg = 'syntax error near token <';
  assert.strictEqual(redact(msg), msg);
});

// ─────────────────────────────────────────────────────
// 3. 入力堅牢性
// ─────────────────────────────────────────────────────
console.log('\n[3. 入力堅牢性]');

test('3a. null はそのまま返す', () => assert.strictEqual(redact(null), null));
test('3b. undefined はそのまま返す', () => assert.strictEqual(redact(undefined), undefined));
test('3c. 数値はそのまま返す', () => assert.strictEqual(redact(12345), 12345));
test('3d. 空文字は空文字', () => assert.strictEqual(redact(''), ''));

// ─────────────────────────────────────────────────────
// 4. github.maskSecret 後方互換（redact へ委譲）
// ─────────────────────────────────────────────────────
console.log('\n[4. github.maskSecret 後方互換]');

test('4a. maskSecret が export されている', () =>
  assert.strictEqual(typeof github.maskSecret, 'function'));

test('4b. maskSecret も ghp_ をマスク（既存挙動維持）', () => {
  const out = github.maskSecret('token ghp_ABCDEF1234567890abcdef');
  assert.ok(out.includes('[MASKED]') && !out.includes('ghp_ABCDEF1234567890abcdef'));
});

test('4c. maskSecret が JWT もマスク（redact 委譲で強化）', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1IjoxfQ.SflKxwRJSMeKKF2QT4fwpMeJf36';
  const out = github.maskSecret('jwt=' + jwt);
  assert.ok(out.includes('[MASKED]') && !out.includes(jwt));
});

test('4d. maskSecret 非文字列はそのまま', () =>
  assert.strictEqual(github.maskSecret(null), null));

// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
