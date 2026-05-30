'use strict';
// maskSecret 単体テスト
const { maskSecret } = require('../bot/utils/github');

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    ok ? pass++ : fail++;
    console.log((ok ? '✅' : '❌') + ' ' + label);
  } catch (e) {
    fail++;
    console.log('❌ ' + label + ' — ' + e.message.slice(0, 80));
  }
}

// ─── マスク対象テスト ───

test('Authorization: Basic をマスク', () => {
  const input = 'http.extraheader="Authorization: Basic Z2hwX1hYWFlZWVpaWlpaWlpaWlpaWlpaWlo="';
  const out = maskSecret(input);
  return !out.match(/Basic [A-Za-z0-9+/=]{8,}/) && out.includes('[MASKED]');
});

test('ghp_ トークンをマスク', () => {
  const input = 'remote: Invalid credentials. ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const out = maskSecret(input);
  return !out.includes('ghp_X') && out.includes('[MASKED]');
});

test('github_pat_ トークンをマスク', () => {
  const input = 'github_pat_11AAABBBCCC_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const out = maskSecret(input);
  return !out.includes('github_pat_') && out.includes('[MASKED]');
});

test('Authorization: Bearer をマスク', () => {
  const input = 'Authorization: Bearer ghp_abc123DEF456ghi789JKL012mno345PQR678stuVWX';
  const out = maskSecret(input);
  return !out.match(/Bearer [A-Za-z0-9]{8,}/) && out.includes('[MASKED]');
});

test('URL 埋め込みトークンをマスク', () => {
  const input = 'https://x-oauth-basic:ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX@github.com/user/repo.git';
  const out = maskSecret(input);
  return !out.includes('ghp_X') && out.includes('[MASKED]');
});

test('extraheader を含む行をマスク', () => {
  const input = '-c http.extraheader="Authorization: Basic dXNlcjpnaHBfWFhYWFhY"';
  const out = maskSecret(input);
  return out.includes('[MASKED]');
});

// ─── 非マスク対象テスト（正常メッセージを壊さない）───

test('通常エラーメッセージはマスクしない (repository not found)', () => {
  const input = 'fatal: repository not found';
  const out = maskSecret(input);
  return out === input;
});

test('通常エラーメッセージはマスクしない (failed to push)', () => {
  const input = 'error: failed to push some refs to origin';
  const out = maskSecret(input);
  return out === input;
});

test('null/undefined は安全に処理', () => {
  return maskSecret(null) === null && maskSecret(undefined) === undefined;
});

test('空文字は空文字のまま', () => {
  return maskSecret('') === '';
});

console.log('\n=== maskSecret テスト結果: ' + pass + '/' + (pass + fail) + ' 通過 ===');
if (fail > 0) process.exit(1);
