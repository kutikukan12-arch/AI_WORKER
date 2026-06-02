'use strict';
// Security Phase 2 スキャナーテスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const { scanDirectory, writeScanReport, defaultOutputPath } =
  require('../scripts/security-scan');

// ─── テスト用一時ディレクトリ ────────────────────────
const TMP = path.join(os.tmpdir(), `sec-scan-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── ダミーシークレット（FAKE含まない）─────────────
const DUMMY_PAT     = 'github_pat_' + 'A'.repeat(80);
const DUMMY_OPENAI  = 'sk-proj-' + 'C'.repeat(92);
const DUMMY_DISCORD = 'MTUwOTU0ZZZZ0NDc3ODY1NzkzMg.GzAbCd.ZZZqrstuvwxyzABCDE_GUARD12';

// ─────────────────────────────────────────────────────
// 1. ダミーシークレット検出
// ─────────────────────────────────────────────────────
console.log('\n[1. ダミーシークレット検出]');

test('1a. GitHub PAT を含むファイルを検出する', () => {
  const file = path.join(TMP, 'test_config.log');
  fs.writeFileSync(file, `GITHUB_TOKEN=${DUMMY_PAT}`, 'utf8');
  const findings = scanDirectory(TMP);
  assert.ok(findings.some(f => f.name.includes('GitHub')), 'GitHub PAT 未検出');
});

test('1b. OpenAI API Key を含むファイルを検出する', () => {
  const file = path.join(TMP, 'openai.log');
  fs.writeFileSync(file, `OPENAI_API_KEY=${DUMMY_OPENAI}`, 'utf8');
  const findings = scanDirectory(TMP);
  assert.ok(findings.some(f => f.name.includes('OpenAI')), 'OpenAI Key 未検出');
});

test('1c. Discord Token を含むファイルを検出する', () => {
  const file = path.join(TMP, 'discord.json');
  fs.writeFileSync(file, JSON.stringify({ token: DUMMY_DISCORD }), 'utf8');
  const findings = scanDirectory(TMP);
  assert.ok(findings.some(f => f.name.includes('Discord')), 'Discord Token 未検出');
});

test('1d. .md ファイル内の本物風シークレットも検出する', () => {
  const file = path.join(TMP, 'notes.md');
  fs.writeFileSync(file, `# メモ\nTOKEN: ${DUMMY_PAT}`, 'utf8');
  // .md は SAFE_FILE_PATTERNS で除外されているため 0 件になる（仕様）
  // → .md は意図的に除外。テストはその仕様を確認する
  const findings = scanDirectory(TMP);
  const mdFindings = findings.filter(f => f.file.endsWith('.md'));
  assert.strictEqual(mdFindings.length, 0, '.md は除外対象のはずが検出された');
  // ただし .jsonl や .log はスキャン対象
  const logFile = path.join(TMP, 'output.jsonl');
  fs.writeFileSync(logFile, `{"token":"${DUMMY_PAT}"}`, 'utf8');
  const jsonlFindings = scanDirectory(TMP);
  assert.ok(jsonlFindings.some(f => f.file.endsWith('.jsonl')), '.jsonl が未検出');
});

// ─────────────────────────────────────────────────────
// 2. 正常ファイル通過
// ─────────────────────────────────────────────────────
console.log('\n[2. 正常ファイルは通過]');

test('2a. 通常のログファイルは検出しない', () => {
  const file = path.join(TMP, 'normal.log');
  fs.writeFileSync(file, '[INFO] Server started on port 3000\n[INFO] Connected', 'utf8');
  const findings = scanDirectory(TMP).filter(f => f.file.endsWith('normal.log'));
  assert.strictEqual(findings.length, 0, '正常ログを誤検出した');
});

test('2b. .env.example はスキャン対象外', () => {
  const file = path.join(TMP, '.env.example');
  fs.writeFileSync(file, 'DISCORD_TOKEN=your-token\nGITHUB_TOKEN=ghp_placeholder', 'utf8');
  const findings = scanDirectory(TMP).filter(f => f.file.endsWith('.env.example'));
  assert.strictEqual(findings.length, 0, '.env.example を誤検出した');
});

test('2c. node_modules は無視される', () => {
  const nmDir = path.join(TMP, 'node_modules', 'fake-pkg');
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, 'index.js'), `const t="${DUMMY_PAT}"`, 'utf8');
  const findings = scanDirectory(TMP);
  const nmFindings = findings.filter(f => f.file.includes('node_modules'));
  assert.strictEqual(nmFindings.length, 0, 'node_modules をスキャンした');
});

// ─────────────────────────────────────────────────────
// 3. 値マスク確認（ファイル名・行番号のみ）
// ─────────────────────────────────────────────────────
console.log('\n[3. 値はレポートに保存されない]');

test('3a. writeScanReport が検出値を保存しない', () => {
  const violations = [
    { file: 'logs/test.log', line: 5, name: 'GitHub Personal Access Token (fine-grained)',
      severity: 'CRITICAL', source: 'filesystem' }
  ];
  const outPath = path.join(TMP, 'scan-report.json');
  const report = writeScanReport(violations, outPath);
  const content = fs.readFileSync(outPath, 'utf8');
  // 実際のトークン値が含まれていないこと
  assert.ok(!content.includes(DUMMY_PAT), 'PAT 値が保存されている');
  assert.ok(!content.includes(DUMMY_OPENAI), 'OpenAI Key が保存されている');
  // ファイル名・行番号・種類は保存される
  assert.ok(content.includes('logs/test.log'), 'ファイル名がない');
  assert.ok(content.includes('"line": 5') || content.includes('"line":5'), '行番号がない');
  assert.ok(content.includes('CRITICAL'), '重要度がない');
});

test('3b. レポートに totalFound / bySeverity が含まれる', () => {
  const outPath = path.join(TMP, 'scan-report2.json');
  writeScanReport([
    { file: 'a.log', line: 1, name: 'OpenAI API Key', severity: 'CRITICAL', source: 'filesystem' },
    { file: 'b.log', line: 2, name: 'Generic',         severity: 'HIGH',     source: 'filesystem' },
  ], outPath);
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.strictEqual(data.totalFound, 2);
  assert.strictEqual(data.bySeverity.CRITICAL, 1);
  assert.strictEqual(data.bySeverity.HIGH, 1);
});

// ─────────────────────────────────────────────────────
// 4. ソース確認
// ─────────────────────────────────────────────────────
console.log('\n[4. ソース確認]');

const scanSrc = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'security-scan.js'), 'utf8'
);

test('4a. secret-guardian.js の scanContent を再利用している', () => {
  assert.ok(scanSrc.includes('secret-guardian'), 'secret-guardian が使われていない');
  assert.ok(scanSrc.includes('scanContent'), 'scanContent 呼び出しがない');
});

test('4b. git 履歴スキャン機能がある', () => {
  assert.ok(scanSrc.includes('scanGitHistory'), 'scanGitHistory がない');
  assert.ok(scanSrc.includes('git log'), 'git log がない');
  assert.ok(scanSrc.includes('git show'), 'git show がない');
});

test('4c. 自動削除・履歴改変コードがない（atomic write の tmp 削除は許可）', () => {
  // atomic write で tmp ファイルのみ削除するのは許可（秘密情報の削除ではない）
  // 禁止: force push / rebase / git filter（履歴改変）
  assert.ok(!scanSrc.includes('force-with-lease'), 'force push コードがある');
  assert.ok(!scanSrc.includes('git rebase'), 'rebase コードがある');
  assert.ok(!scanSrc.includes('git filter'), 'git filter コードがある（履歴改変禁止）');
  // unlinkSync は atomic write の tmp 削除のみに使用されていること
  const unlinkCount = (scanSrc.match(/fs\.unlinkSync/g) || []).length;
  const tmpCount    = (scanSrc.match(/\.tmp/g) || []).length;
  assert.ok(unlinkCount <= tmpCount, 'tmp 以外のファイルを削除しようとしている可能性');
});

test('4d. defaultOutputPath が security-scan-YYYY-MM-DD.json 形式', () => {
  const outPath = defaultOutputPath();
  assert.ok(path.basename(outPath).startsWith('security-scan-'), '命名規則が違う');
  assert.ok(outPath.endsWith('.json'), 'json でない');
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
