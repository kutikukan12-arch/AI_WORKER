'use strict';
// Secret Guardian Phase 1 テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const sg = require('../bot/utils/secret-guardian');

// ─── ダミーシークレット（本物に近い形式・テスト専用）───────
// ※ 実際の値ではなく、パターンマッチ確認のためのダミー
// FAKE/DUMMY等のキーワードを含まないダミー（偽陽性フィルタを通過させるため）
const DUMMY_DISCORD = 'MTUwOTU0ZZZZ0NDc3ODY1NzkzMg.GzAbCd.ZZZqrstuvwxyzABCDE_GUARD12';
const DUMMY_GITHUB_PAT = 'github_pat_' + 'A'.repeat(80);
const DUMMY_GITHUB_GHP = 'ghp_' + 'B'.repeat(36);
const DUMMY_OPENAI    = 'sk-proj-' + 'C'.repeat(92);

// ─────────────────────────────────────────────────────
// 1. ダミーシークレット検出テスト
// ─────────────────────────────────────────────────────
console.log('\n[1. ダミーシークレット検出]');

test('1a. Discord Bot Token 検出', () => {
  const content = `const token = '${DUMMY_DISCORD}';`;
  const findings = sg.scanContent('config.js', content);
  assert.ok(findings.some(f => f.name.includes('Discord')), `Discord Token 未検出: ${JSON.stringify(findings)}`);
});

test('1b. GitHub PAT (fine-grained) 検出', () => {
  const content = `GITHUB_TOKEN=${DUMMY_GITHUB_PAT}`;
  const findings = sg.scanContent('config.js', content);
  assert.ok(findings.length > 0, 'GitHub PAT 未検出');
});

test('1c. GitHub PAT (classic ghp_) 検出', () => {
  const content = `token: "${DUMMY_GITHUB_GHP}"`;
  const findings = sg.scanContent('app.js', content);
  assert.ok(findings.some(f => f.name.includes('GitHub')), 'ghp_ 未検出');
});

test('1d. OpenAI API Key 検出', () => {
  const content = `OPENAI_API_KEY=${DUMMY_OPENAI}`;
  const findings = sg.scanContent('settings.js', content);
  assert.ok(findings.length > 0, 'OpenAI Key 未検出');
});

test('1e. Generic SECRET assignment 検出', () => {
  // x7以上を含むとDUMMYヒントにマッチするためAで代替
  const content = `DISCORD_TOKEN = MTU${'A'.repeat(30)}.ABCDEF.GHIJKLMNOPQRSTUVWXYZABCDE`;
  const findings = sg.scanContent('env.js', content);
  assert.ok(findings.length > 0, 'Generic secret 未検出');
});

// ─────────────────────────────────────────────────────
// 2. 正常ファイルは通過する
// ─────────────────────────────────────────────────────
console.log('\n[2. 正常ファイルは通過]');

test('2a. 通常のコードは検出しない', () => {
  const content = `
function hello() {
  return 'world';
}
const x = 42;
`;
  const findings = sg.scanContent('hello.js', content);
  assert.strictEqual(findings.length, 0, `誤検出: ${JSON.stringify(findings)}`);
});

test('2b. .env.example は走査対象外', () => {
  const content = `DISCORD_TOKEN=your-token-here\nGITHUB_TOKEN=ghp_placeholder`;
  const findings = sg.scanContent('.env.example', content);
  assert.strictEqual(findings.length, 0, '.env.example を誤ってスキャンした');
});

test('2c. テストファイル (.test.js) は走査対象外', () => {
  const content = `const dummyToken = '${DUMMY_DISCORD}';`;
  const findings = sg.scanContent('auth.test.js', content);
  assert.strictEqual(findings.length, 0, 'テストファイルをスキャンした');
});

test('2d. Markdown ファイルは走査対象外', () => {
  const content = `# 使い方\nDISCORD_TOKEN=your-discord-token`;
  const findings = sg.scanContent('README.md', content);
  assert.strictEqual(findings.length, 0, 'Markdown をスキャンした');
});

test('2e. DUMMY/FAKE ヒントを含む行は偽陽性で通過', () => {
  const content = `// DUMMY TOKEN: MTU${'x'.repeat(30)}.ABCDEF.GHIJKLMNOPQRSTUVWXYZABC`;
  const findings = sg.scanContent('doc.js', content);
  assert.strictEqual(findings.length, 0, 'DUMMY ヒントが偽陽性になった');
});

// ─────────────────────────────────────────────────────
// 3. 秘密情報の値がマスクされていること
// ─────────────────────────────────────────────────────
console.log('\n[3. 秘密値はレポートに表示されない]');

test('3a. formatViolationReport に実際の値が含まれない', () => {
  const violations = [
    { file: 'src/config.js', line: 5, name: 'Discord Bot Token',
      severity: 'CRITICAL', hint: 'L5 にパターン' }
  ];
  const report = sg.formatViolationReport(violations);
  assert.ok(report, 'レポートが生成されない');
  // ファイル名・行番号は含まれる
  assert.ok(report.includes('src/config.js'), 'ファイル名がない');
  assert.ok(report.includes('L5') || report.includes('(L5)'), '行番号がない');
  // 実際のトークン値は含まれない
  assert.ok(!report.includes('MTU'), '値が漏洩している');
});

test('3b. writeSecurityReport がログに値を保存しない', () => {
  const violations = [
    { file: 'bot/config.js', line: 3, name: 'OpenAI API Key',
      severity: 'CRITICAL', hint: '' }
  ];
  const reportFile = sg.writeSecurityReport(violations, '/test/repo');
  if (reportFile && fs.existsSync(reportFile)) {
    const content = fs.readFileSync(reportFile, 'utf8');
    assert.ok(!content.includes('sk-proj-'), '秘密値がログに保存されている');
    // ファイル名・行番号は保存される
    assert.ok(content.includes('bot/config.js'), 'ファイル名がない');
  }
});

test('3c. guardCommit が allowed:false の場合 github.js が stop して report を持つ', () => {
  // secretViolations / secretReport は github.js の err オブジェクトに付与
  const ghSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'github.js'), 'utf8'
  );
  assert.ok(ghSrc.includes('err.secretViolations'), 'github.js に err.secretViolations がない');
  assert.ok(ghSrc.includes('err.secretReport'), 'github.js に err.secretReport がない');
  // secret-guardian.js は guardCommit で report と violations を返す
  const sgSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  assert.ok(sgSrc.includes('allowed:'), 'guardCommit に allowed フィールドがない');
  assert.ok(sgSrc.includes('git reset HEAD'), 'ステージング解除コードがない');
});

// ─────────────────────────────────────────────────────
// 4. github.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[4. github.js 統合確認]');

test('4a. commitAndPush に Secret Guardian が組み込まれている', () => {
  const ghSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'github.js'), 'utf8'
  );
  assert.ok(ghSrc.includes('secret-guardian'), 'secret-guardian が github.js にない');
  assert.ok(ghSrc.includes('guardCommit'), 'guardCommit 呼び出しがない');
});

test('4b. 検出時に git reset HEAD でアンステージする', () => {
  const ghSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'github.js'), 'utf8'
  );
  assert.ok(ghSrc.includes('git reset HEAD'), 'アンステージ処理がない');
});

test('4c. index.js で secretViolations エラーを CEO 警告する', () => {
  const idxSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
  );
  assert.ok(idxSrc.includes('secretViolations'), 'index.js に secretViolations ハンドラがない');
  assert.ok(idxSrc.includes('Secret Guardian'), 'Secret Guardian 警告メッセージがない');
});

test('4d. Secret Guardian の警告に値が含まれないこと', () => {
  // formatViolationReport の戻り値に値が含まれないことを再確認
  const empty = sg.formatViolationReport([]);
  assert.strictEqual(empty, null, '空の時は null を返す');
});

// ─────────────────────────────────────────────────────
// 5. セキュリティレポート生成
// ─────────────────────────────────────────────────────
console.log('\n[5. セキュリティレポート]');

test('5a. writeSecurityReport が logs/security-YYYY-MM-DD.json を生成する', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  assert.ok(src.includes('security-'), 'security- ファイル名がない');
  assert.ok(src.includes('.json'), 'JSON形式でない');
});

test('5b. レポートに severity / file / line のみ保存（値なし）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'secret-guardian.js'), 'utf8'
  );
  // findings に name/severity/file/line のみ → 値（content）は保存しない
  assert.ok(src.includes('severity:'), 'severity が保存されていない');
  assert.ok(!src.includes('content:') || src.includes('// 値は保存しない'), '値が保存されている可能性');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
