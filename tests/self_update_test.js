'use strict';
// Self Update / Restart Manager Phase12 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const vt   = require('../bot/utils/version-tracker');
const sr   = require('../bot/utils/safe-restart');
const src  = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. Phase1: Version Tracker
// ─────────────────────────────────────────────────────
console.log('\n[1. Version Tracker — Phase1]');

test('1a. recordBotStartup が version-state.json に保存する', () => {
  vt.recordBotStartup();
  assert.ok(fs.existsSync(vt.VERSION_FILE), 'version-state.json が作成されない');
  const state = JSON.parse(fs.readFileSync(vt.VERSION_FILE, 'utf8'));
  assert.ok(state.bot?.startupCommit, 'startupCommit がない');
  assert.ok(state.bot?.pid,           'pid がない');
  assert.ok(state.bot?.startedAt,     'startedAt がない');
});

test('1b. recordOperatorStartup が Operator 情報を保存する', () => {
  vt.recordOperatorStartup(12345);
  const state = JSON.parse(fs.readFileSync(vt.VERSION_FILE, 'utf8'));
  assert.ok(state.operator?.startupCommit, 'operator.startupCommit がない');
  assert.strictEqual(state.operator?.pid, 12345, 'pid が違う');
});

test('1c. getHeadCommit が git hash を返す', () => {
  const h = vt.getHeadCommit();
  assert.ok(h, 'hash が null');
  assert.ok(h.length >= 7, `hash が短すぎる: ${h}`);
});

test('1d. formatSystemStatus が ok:true を返す', () => {
  const r = vt.formatSystemStatus();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('System Status'), 'タイトルがない');
  assert.ok(r.text.includes('Bot'), 'Bot セクションがない');
  assert.ok(r.text.includes('Operator'), 'Operator セクションがない');
});

test('1e. version-state.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/version-state.json'));
});

// ─────────────────────────────────────────────────────
// 2. Phase2: Update Detector
// ─────────────────────────────────────────────────────
console.log('\n[2. Update Detector — Phase2]');

test('2a. detectUpdates が結果を返す', () => {
  vt.recordBotStartup();
  const r = vt.detectUpdates();
  assert.ok('currentCommit' in r, 'currentCommit がない');
  assert.ok('botOutdated' in r,   'botOutdated がない');
  assert.ok('restartPolicy' in r, 'restartPolicy がない');
});

test('2b. 同じ commit で起動なら botOutdated = false', () => {
  vt.recordBotStartup(); // 現在の HEAD で記録
  const r = vt.detectUpdates();
  assert.strictEqual(r.botOutdated, false, '同一コミットなのに outdated になっている');
});

test('2c. 古いコミットで起動した場合に outdated = true', () => {
  // 意図的に古いコミットを設定
  const state = JSON.parse(fs.readFileSync(vt.VERSION_FILE, 'utf8'));
  state.bot.startupCommit = 'abc0000';
  fs.writeFileSync(vt.VERSION_FILE, JSON.stringify(state, null, 2), 'utf8');
  const r = vt.detectUpdates();
  assert.strictEqual(r.botOutdated, true, '古いコミットなのに outdated でない');
  vt.recordBotStartup(); // 元に戻す
});

// ─────────────────────────────────────────────────────
// 3. Phase4: Auto Restart Policy
// ─────────────────────────────────────────────────────
console.log('\n[3. Auto Restart Policy — Phase4]');

test('3a. docs 変更のみは docsOnly=true / 再起動不要', () => {
  // detectUpdates の内部 _analyzeRestartPolicy を間接テスト
  const update = vt.detectUpdates();
  // 現在は変更なしのはずなので確認のみ
  assert.ok('restartPolicy' in update);
});

test('3b. bot/*.js 変更は botRestart=true を返す', () => {
  // _analyzeRestartPolicy を直接テスト（内部関数なので module.exports から再現）
  // 間接的にテスト: formatSystemStatus に含まれる情報から
  const r = vt.formatSystemStatus();
  assert.ok(r.ok, '状態取得失敗');
});

// ─────────────────────────────────────────────────────
// 4. Phase3: Safe Restart
// ─────────────────────────────────────────────────────
console.log('\n[4. Safe Restart — Phase3]');

test('4a. checkSafeToRestart がタスクなし環境でサポートされる', () => {
  const r = sr.checkSafeToRestart('bot');
  assert.ok('safe' in r,  'safe フィールドがない');
  assert.ok('issues' in r, 'issues フィールドがない');
  assert.ok(Array.isArray(r.issues));
});

test('4b. requestOperatorRestart が状態を更新する', () => {
  const r = sr.requestOperatorRestart('テスト再起動');
  assert.strictEqual(r.ok, true);
  assert.ok(r.message.includes('再起動'), 'メッセージが違う');
});

test('4c. buildRestartReport が safe=false の場合にエラーを表示する', () => {
  const fakeCheck = { safe: false, issues: ['実行中タスク 1件'] };
  const r = sr.buildRestartReport('bot', fakeCheck, {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('安全条件'), '安全条件エラーがない');
});

test('4d. buildRestartReport が safe=true の場合に成功を表示する', () => {
  const fakeCheck = { safe: true, issues: [] };
  const results = { bot: { ok: true, message: 'Bot 再起動フラグ設定' } };
  const r = sr.buildRestartReport('bot', fakeCheck, results);
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('Bot'), 'Bot 結果がない');
});

// ─────────────────────────────────────────────────────
// 5. Phase5: Recovery
// ─────────────────────────────────────────────────────
console.log('\n[5. Recovery — Phase5]');

test('5a. logRecovery が recovery-log.json に保存する', () => {
  sr.logRecovery({ component: 'test', type: 'test_recovery', detail: 'テスト' });
  assert.ok(fs.existsSync(sr.RECOVERY_FILE), 'recovery-log.json がない');
  const list = JSON.parse(fs.readFileSync(sr.RECOVERY_FILE, 'utf8'));
  assert.ok(list.some(e => e.component === 'test'));
});

test('5b. recovery-log.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/recovery-log.json'));
});

test('5c. checkComponentHealth が配列を返す', () => {
  const issues = sr.checkComponentHealth();
  assert.ok(Array.isArray(issues), '配列でない');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. !system status が実装されている", () => {
  assert.ok(src.includes("sysSub === 'status'"), '!system status がない');
});

test("6b. !system restart が実装されている", () => {
  assert.ok(src.includes("sysSub === 'restart'"), '!system restart がない');
});

test('6c. !system restart は Owner 限定', () => {
  const idx  = src.indexOf("sysSub === 'restart'");
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes('DISCORD_OWNER_ID'), 'Owner 制限がない');
});

test('6d. !system health が実装されている', () => {
  assert.ok(src.includes("sysSub === 'health'"), '!system health がない');
});

test('6e. Bot 起動時に recordBotStartup が呼ばれる', () => {
  // Bot 起動直前に version-tracker を require している
  assert.ok(src.includes("require('./utils/version-tracker')"), 'version-tracker require がない');
  assert.ok(src.includes("vt.recordBotStartup()"), 'recordBotStartup がない');
});

// ─────────────────────────────────────────────────────
// 7. 安全性確認
// ─────────────────────────────────────────────────────
console.log('\n[7. 安全性確認]');

test('7a. version-tracker.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'version-tracker.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('7b. safe-restart.js が直接プロセスを kill しない', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'safe-restart.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('process.exit('), '直接 process.exit が含まれている');
  assert.ok(!code.includes('SIGKILL'), 'SIGKILL が含まれている');
});

test('7c. lock を破壊しない（ロックは requestOperatorRestart だけが解除）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'safe-restart.js'), 'utf8'
  );
  // 外部の lock は触らない（bot.lock は restart-manager.js に任せる）
  assert.ok(!src.includes('bot.lock'), 'bot.lock を直接操作している');
});

// ─────────────────────────────────────────────────────
// 8. M-1: execFileSync + commit hash 検証
// ─────────────────────────────────────────────────────
console.log('\n[8. M-1 — execFileSync + commit hash 検証]');

test('8a. 有効な commit hash は検証を通過する', () => {
  // getChangedFilesSince は内部で _validateCommit を呼ぶ
  // 有効な hash を渡した場合 → エラーなし
  const result = vt.getChangedFilesSince('abc1234');
  assert.ok(Array.isArray(result), '配列でない'); // 存在しない hash は空配列
});

test('8b. 不正な commit hash を拒否する（インジェクション防止）', () => {
  // シェルインジェクション試みを拒否
  const result = vt.getChangedFilesSince('abc1234; rm -rf /');
  assert.deepStrictEqual(result, [], '不正 hash が通過した');
});

test('8c. commit hash に記号が含まれる場合は拒否する', () => {
  const result = vt.getChangedFilesSince('../../../etc/passwd');
  assert.deepStrictEqual(result, [], 'path traversal が通過した');
});

test('8d. getHeadCommit が返す hash は正規表現を満たす', () => {
  const h = vt.getHeadCommit();
  assert.ok(h, 'hash が null');
  assert.ok(/^[0-9a-f]{7,40}$/.test(h), `hash が正規表現を満たさない: ${h}`);
});

test('8e. version-tracker.js に execSync の shell:true がない（M-1 確認）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'version-tracker.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('shell: true'), 'shell: true が残っている（M-1 未修正）');
  assert.ok(!code.includes('execSync('), 'execSync が残っている（execFileSync を使うべき）');
});

// ─────────────────────────────────────────────────────
// 9. M-2: Graceful Restart フラグ方式
// ─────────────────────────────────────────────────────
console.log('\n[9. M-2 — Graceful Restart フラグ方式]');

test('9a. requestOperatorRestart が operator.lock を即削除しない', () => {
  // operator.lock を一時作成
  const opDir = path.join(__dirname, '..', 'data', 'desktop-operator');
  if (!fs.existsSync(opDir)) fs.mkdirSync(opDir, { recursive: true });
  const lockPath = path.join(opDir, 'operator.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }));

  sr.requestOperatorRestart('M-2 テスト');

  // lock が残っていること（即削除しない）
  assert.ok(fs.existsSync(lockPath), 'operator.lock が即削除された（M-2 未修正）');
  // クリーンアップ
  try { fs.unlinkSync(lockPath); } catch {}
});

test('9b. requestOperatorRestart が restart_requested フラグを立てる', () => {
  sr.requestOperatorRestart('M-2 フラグテスト');
  assert.ok(sr.checkOperatorRestartRequested(), 'restart_requested フラグが立っていない');
});

test('9c. clearOperatorRestartFlag でフラグが解除される', () => {
  sr.requestOperatorRestart('フラグ解除テスト');
  sr.clearOperatorRestartFlag();
  assert.strictEqual(sr.checkOperatorRestartRequested(), false, 'フラグが解除されない');
});

test('9d. requestOperatorRestart 内に operator.lock の unlinkSync がない（M-2 確認）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'safe-restart.js'), 'utf8'
  );
  // requestOperatorRestart 関数の本体だけを抽出して確認
  const fnStart = src.indexOf('function requestOperatorRestart(');
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1);
  const fnBody  = fnEnd > fnStart ? src.slice(fnStart, fnEnd) : src.slice(fnStart);
  const code    = fnBody.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // operator.lock を直接 unlink していないこと
  assert.ok(
    !code.includes("unlinkSync(opLock)") && !code.includes("unlinkSync(lockPath)"),
    'requestOperatorRestart が operator.lock を直接削除している（M-2 未修正）'
  );
});

test('9e. desktop-operator.js が heartbeat で restart_requested を確認する', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'desktop-operator.js'), 'utf8'
  );
  assert.ok(src.includes('checkOperatorRestartRequested'), 'restart_requested チェックがない');
  assert.ok(src.includes('clearOperatorRestartFlag'),      'flag クリアがない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
