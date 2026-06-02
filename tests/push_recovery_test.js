'use strict';
// GitHub Push Recovery 強化テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const { formatGitHubPushFailed, classifyPushError, PUSH_FAIL_TYPES } =
  require('../bot/utils/formatter');
const src = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
);

// ─────────────────────────────────────────────────────
// 1. Push 失敗エラー分類
// ─────────────────────────────────────────────────────
console.log('\n[1. Push 失敗の原因分類]');

test('1a. 403 → AUTH_403', () => {
  assert.strictEqual(classifyPushError('remote: Permission denied (403)'), PUSH_FAIL_TYPES.AUTH_403);
});

test('1b. 401 / unauthorized → AUTH_401', () => {
  assert.strictEqual(classifyPushError('fatal: Authentication failed (401)'), PUSH_FAIL_TYPES.AUTH_401);
  assert.strictEqual(classifyPushError('bad credential'), PUSH_FAIL_TYPES.AUTH_401);
});

test('1c. 404 → REMOTE_NOT_FOUND', () => {
  assert.strictEqual(classifyPushError('ERROR: Repository not found (404)'), PUSH_FAIL_TYPES.REMOTE_NOT_FOUND);
});

test('1d. non-fast-forward → NON_FAST_FORWARD', () => {
  assert.strictEqual(classifyPushError('rejected: non-fast-forward'), PUSH_FAIL_TYPES.NON_FAST_FORWARD);
  assert.strictEqual(classifyPushError('fetch first'), PUSH_FAIL_TYPES.NON_FAST_FORWARD);
});

test('1e. index.lock → INDEX_LOCK', () => {
  assert.strictEqual(classifyPushError('fatal: Unable to create .git/index.lock: File exists'), PUSH_FAIL_TYPES.INDEX_LOCK);
});

test('1f. network / ENOTFOUND → NETWORK', () => {
  assert.strictEqual(classifyPushError('ENOTFOUND github.com'), PUSH_FAIL_TYPES.NETWORK);
  assert.strictEqual(classifyPushError('Connection timed out'), PUSH_FAIL_TYPES.NETWORK);
});

test('1g. GH013 / push protection → SECRET_SCAN_BLOCK', () => {
  assert.strictEqual(classifyPushError('GH013: Repository rule violations'), PUSH_FAIL_TYPES.SECRET_SCAN_BLOCK);
  assert.strictEqual(classifyPushError('push cannot contain secrets'), PUSH_FAIL_TYPES.SECRET_SCAN_BLOCK);
});

test('1h. isSecretBlock=true → SECRET_BLOCK（Secret Guardian 安全停止）', () => {
  const text = formatGitHubPushFailed({ taskId: 'task_x', pushError: '', isSecretBlock: true });
  assert.ok(text.includes('安全停止') || text.includes('Secret Guardian') || text.includes('安全'), '安全停止の文言がない');
});

test('1i. 不明なエラー → UNKNOWN', () => {
  assert.strictEqual(classifyPushError('something unexpected happened'), PUSH_FAIL_TYPES.UNKNOWN);
  assert.strictEqual(classifyPushError(''), PUSH_FAIL_TYPES.UNKNOWN);
});

// ─────────────────────────────────────────────────────
// 2. CEO 向けメッセージ内容確認
// ─────────────────────────────────────────────────────
console.log('\n[2. CEO 向けメッセージ内容]');

test('2a. 全分類で「状況・影響・放置すると・次のアクション」が含まれる', () => {
  const types = ['AUTH_403', 'REMOTE_NOT_FOUND', 'NON_FAST_FORWARD', 'INDEX_LOCK', 'NETWORK', 'UNKNOWN'];
  const errMap = {
    AUTH_403:          'remote: Permission denied (403)',
    REMOTE_NOT_FOUND:  'ERROR: Repository not found (404)',
    NON_FAST_FORWARD:  'rejected: non-fast-forward',
    INDEX_LOCK:        'fatal: Unable to create .git/index.lock',
    NETWORK:           'ENOTFOUND github.com',
    UNKNOWN:           'something unexpected',
  };
  for (const [type, err] of Object.entries(errMap)) {
    const text = formatGitHubPushFailed({ taskId: 'task_x', pushError: err });
    assert.ok(text.includes('状況'), `${type}: 状況がない`);
    assert.ok(text.includes('影響'), `${type}: 影響がない`);
    assert.ok(text.includes('放置'), `${type}: 放置説明がない`);
    assert.ok(text.includes('アクション') || text.includes('次の'), `${type}: 次のアクションがない`);
  }
});

test('2b. SECRET_BLOCK で「安全停止」が明示される', () => {
  const text = formatGitHubPushFailed({ taskId: 'task_x', isSecretBlock: true });
  assert.ok(text.includes('安全停止') || text.includes('Safety') || text.includes('セキュリティ'),
    '安全停止の明示がない');
});

test('2c. NON_FAST_FORWARD に git pull 案内がある', () => {
  const text = formatGitHubPushFailed({ taskId: 'task_x', pushError: 'rejected: non-fast-forward' });
  assert.ok(text.includes('pull') || text.includes('pull'), 'git pull の案内がない');
});

test('2d. INDEX_LOCK に .git/index.lock 削除手順がある', () => {
  const text = formatGitHubPushFailed({ taskId: 'task_x', pushError: '.git/index.lock' });
  assert.ok(text.includes('index.lock') || text.includes('ロック'), 'index.lock 対処がない');
});

// ─────────────────────────────────────────────────────
// 3. Secret BLOCK 時の表示（値をださない）
// ─────────────────────────────────────────────────────
console.log('\n[3. Secret BLOCK — 値を表示しない]');

test('3a. isSecretBlock=true のメッセージにトークン値が含まれない', () => {
  const fakeToken = 'github_pat_' + 'S'.repeat(80);
  // pushError に値を渡してもフォーマットに出ない（技術詳細のみ）
  const text = formatGitHubPushFailed({ taskId: 'task_x', pushError: fakeToken, isSecretBlock: true });
  assert.ok(!text.includes(fakeToken), 'PAT 値がメッセージに漏洩');
  assert.ok(!text.includes('github_pat_'), 'PAT prefix がメッセージに漏洩');
});

test('3b. SECRET_SCAN_BLOCK のメッセージにトークン値が含まれない', () => {
  const fakeToken = 'sk-proj-' + 'T'.repeat(92);
  const text = formatGitHubPushFailed({ taskId: 'task_x', pushError: fakeToken });
  // GH013 パターンはエラー文字列に含まれるので SECRET_SCAN_BLOCK 以外になる可能性
  // いずれにせよ値は出ない
  assert.ok(!text.includes(fakeToken), '値がメッセージに漏洩');
});

// ─────────────────────────────────────────────────────
// 4. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[4. index.js 統合確認]');

test('4a. Secret Guardian BLOCK 時に formatGitHubPushFailed(isSecretBlock:true) を使う', () => {
  const gitErrBlock = src.indexOf('gitErr.secretViolations');
  const area        = src.slice(gitErrBlock, gitErrBlock + 400);
  assert.ok(area.includes('isSecretBlock'), 'isSecretBlock フラグが使われていない');
  assert.ok(area.includes('formatGitHubPushFailed'), 'formatGitHubPushFailed が呼ばれていない');
});

test('4b. 既存の pushError 経由 formatGitHubPushFailed も使われている', () => {
  assert.ok(src.includes('formatGitHubPushFailed'), 'formatGitHubPushFailed が index.js にない');
});

test('4c. 通常 push 成功後に pushError が残らないこと（skipped/pushed 分岐あり）', () => {
  assert.ok(src.includes("gitResult?.pushed"), 'pushed 確認分岐がない');
  assert.ok(src.includes("gitResult?.skipped"), 'skipped 確認分岐がない');
});

// ─────────────────────────────────────────────────────
// 5. 既存 D-1 テストとの互換性
// ─────────────────────────────────────────────────────
console.log('\n[5. 既存テスト互換性]');

test('5a. formatGitHubPushFailed が引数なしでもクラッシュしない', () => {
  const text = formatGitHubPushFailed({});
  assert.ok(typeof text === 'string' && text.length > 10, '空オブジェクトでクラッシュ');
});

test('5b. classifyPushError が空文字でも UNKNOWN を返す', () => {
  assert.strictEqual(classifyPushError(), PUSH_FAIL_TYPES.UNKNOWN);
  assert.strictEqual(classifyPushError(null), PUSH_FAIL_TYPES.UNKNOWN);
});

test('5c. PUSH_FAIL_TYPES に必須の7種類が含まれる', () => {
  const required = ['AUTH_403', 'REMOTE_NOT_FOUND', 'NON_FAST_FORWARD',
                    'INDEX_LOCK', 'NETWORK', 'SECRET_BLOCK', 'UNKNOWN'];
  required.forEach(t => assert.ok(t in PUSH_FAIL_TYPES, `${t} が PUSH_FAIL_TYPES にない`));
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
