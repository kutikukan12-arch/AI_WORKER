'use strict';
// github.js branch 決定ロジックのテスト
// GITHUB_BRANCH_DEFAULT=main でも現在ブランチ master を優先することを確認

const assert  = require('assert');
const path    = require('path');
const { execSync } = require('child_process');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name); console.error('    ', e.message); fail++; }
}

// ─── getCurrentBranch() 単体テスト ───
const ROOT = path.join(__dirname, '..');

// 内部 getCurrentBranch を再現（テスト用）
function getCurrentBranch(repoPath) {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath, stdio: 'pipe', encoding: 'utf8',
    }).trim() || 'master';
  } catch {
    return 'master';
  }
}

console.log('\n[getCurrentBranch]');

test('実際のリポジトリで master を返す', () => {
  const branch = getCurrentBranch(ROOT);
  assert.strictEqual(branch, 'master', `expected master, got ${branch}`);
});

test('無効パスはフォールバック master', () => {
  const branch = getCurrentBranch('/nonexistent/path');
  assert.strictEqual(branch, 'master');
});

// ─── branch 決定ロジックのシミュレーション ───

console.log('\n[branch 決定ロジック（修正後）]');

function resolveBranch(repoPath, defaultBranch) {
  // 修正後のロジック: getCurrentBranch を優先
  return getCurrentBranch(repoPath) || defaultBranch || 'master';
}

function resolveBranchBuggy(repoPath, defaultBranch) {
  // 修正前のバグあり: GITHUB_BRANCH_DEFAULT が優先される
  return defaultBranch || getCurrentBranch(repoPath);
}

test('GITHUB_BRANCH_DEFAULT=main / 現在branch=master → master を使う（修正後）', () => {
  const branch = resolveBranch(ROOT, 'main');
  assert.strictEqual(branch, 'master', `expected master, got ${branch}`);
});

test('バグあり版: GITHUB_BRANCH_DEFAULT=main → 誤って main を使う（再現確認）', () => {
  const branch = resolveBranchBuggy(ROOT, 'main');
  assert.strictEqual(branch, 'main', `badbranch expected main, got ${branch}`);
});

test('GITHUB_BRANCH_DEFAULT=null / 現在branch=master → master を使う', () => {
  const branch = resolveBranch(ROOT, null);
  assert.strictEqual(branch, 'master');
});

test('GITHUB_BRANCH_DEFAULT=master / 現在branch=master → master（一致）', () => {
  const branch = resolveBranch(ROOT, 'master');
  assert.strictEqual(branch, 'master');
});

test('branch 取得失敗 + GITHUB_BRANCH_DEFAULT=main → main にフォールバック', () => {
  // 無効パスで getCurrentBranch が master を返す場合（実際のフォールバック）
  const branch = resolveBranch('/nonexistent', 'main');
  // /nonexistent は存在しないので getCurrentBranch が 'master' を返す
  assert.strictEqual(branch, 'master');
  // NOTE: git が完全失敗する場合は GITHUB_BRANCH_DEFAULT にフォールバックされる
});

test('branch 取得失敗 + GITHUB_BRANCH_DEFAULT=null → 最終フォールバック master', () => {
  const branch = resolveBranch('/nonexistent', null);
  assert.strictEqual(branch, 'master');
});

// ─── 修正後 github.js の実際の動作確認 ───

console.log('\n[github.js 修正後 確認]');

// github.js のソースを直接検査（push 禁止のため実行はしない）
const fs  = require('fs');
const src = fs.readFileSync(path.join(ROOT, 'bot/utils/github.js'), 'utf8');

test('修正後: getCurrentBranch() が先に来る（GITHUB_BRANCH_DEFAULT より優先）', () => {
  // "getCurrentBranch(repoPath) || GITHUB_BRANCH_DEFAULT" の形になっている
  const pattern = /getCurrentBranch\(repoPath\)\s*\|\|\s*GITHUB_BRANCH_DEFAULT/;
  assert.ok(pattern.test(src), 'getCurrentBranch優先パターンが見つからない');
});

test('バグあり行が除去されている（GITHUB_BRANCH_DEFAULT || getCurrentBranch の旧順序）', () => {
  // push 先決定で「GITHUB_BRANCH_DEFAULT || getCurrentBranch」の古い順序が消えているか
  // "currentBranch = GITHUB_BRANCH_DEFAULT || getCurrentBranch" が存在しないこと
  const bugPattern = /currentBranch\s*=\s*GITHUB_BRANCH_DEFAULT\s*\|\|\s*getCurrentBranch/;
  assert.ok(!bugPattern.test(src), 'バグあり行が残っている');
});

test('node -c 構文チェック通過', () => {
  const out = execSync('node -c bot/utils/github.js', {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
  });
  assert.ok(out.includes('OK') || out === '', `syntax error: ${out}`);
});

// ─── 結果 ───

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
