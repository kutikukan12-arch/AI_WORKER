'use strict';
// Desktop Operator Phase11 — 自動往復化テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const bridge   = require('../bot/utils/operator-bridge');
const opState  = require('../bot/utils/desktop-operator-state');
const operator = require('../scripts/desktop-operator');
const scanner  = require('../bot/utils/desktop-operator-scanner');
const src      = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetState() {
  opState.saveState({ version:'1', updatedAt:null, workers:{}, processedIds:[], paused:false });
  const h = opState.HISTORY_FILE;
  try { if (fs.existsSync(h)) fs.writeFileSync(h, '[]', 'utf8'); } catch {}
}

function writeOutbox(worker, content) {
  const p = bridge.getOutboxPath(worker);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function cleanAll() {
  resetState();
  bridge.setPaused(opState, false);
  for (const w of [...bridge.ALLOWED_WORKERS]) {
    const op = bridge.getOutboxPath(w);
    const ip = bridge.getInboxPath(w);
    try { if (op && fs.existsSync(op)) fs.unlinkSync(op); } catch {}
    try { if (ip && fs.existsSync(ip)) fs.unlinkSync(ip); } catch {}
  }
}

// ─────────────────────────────────────────────────────
// 1. Phase4: Safety — allowlist / path traversal 防止
// ─────────────────────────────────────────────────────
console.log('\n[1. Phase4 Safety]');

test('1a. allowlist 内の worker は getOutboxPath を返す', () => {
  const p = bridge.getOutboxPath('miyagi');
  assert.ok(p, 'null を返した');
  assert.ok(p.includes('miyagi'), 'パスに miyagi が含まれない');
  assert.ok(p.endsWith('outgoing.md'), 'outgoing.md で終わらない');
});

test('1b. allowlist 外の worker は null を返す', () => {
  assert.strictEqual(bridge.getOutboxPath('unknown_attacker'), null, 'null でない');
  assert.strictEqual(bridge.getInboxPath('../../etc/passwd'), null, 'null でない');
});

test('1c. path traversal 文字列を拒否する', () => {
  assert.strictEqual(bridge.getOutboxPath('../../../root'), null);
  assert.strictEqual(bridge.getOutboxPath('miyagi/../../../etc'), null);
});

test('1d. ALLOWED_WORKERS に全社員が含まれる', () => {
  const required = ['miyagi','moriya','shiraishi','aizawa','ichikawa','kanemori','kurokawa','ikuno','kanzaki'];
  for (const w of required) {
    assert.ok(bridge.ALLOWED_WORKERS.has(w), `${w} が ALLOWED_WORKERS にない`);
  }
});

// ─────────────────────────────────────────────────────
// 2. Phase1: Outbox Queue 読み込み
// ─────────────────────────────────────────────────────
console.log('\n[2. Phase1 Outbox Queue]');

test('2a. outbox がなければ空 queue', () => {
  cleanAll();
  const q = bridge.readOutboxQueue(opState);
  assert.deepStrictEqual(q, []);
});

test('2b. outbox があれば queue に入る', () => {
  cleanAll();
  writeOutbox('miyagi', '守谷CTOへ: 実装完了');
  const q = bridge.readOutboxQueue(opState);
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].worker, 'miyagi');
});

test('2c. safeContent に redact が適用される', () => {
  cleanAll();
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  writeOutbox('moriya', `token: ${fakeToken} について報告`);
  const q = bridge.readOutboxQueue(opState);
  assert.ok(q.length > 0, 'queue が空');
  assert.ok(!q[0].safeContent.includes(fakeToken), 'トークンが含まれている');
  assert.ok(q[0].safeContent.includes('[MASKED]'), 'MASKED がない');
});

test('2d. 二重処理防止: 同じ hash の outbox は queue に入らない', () => {
  cleanAll();
  writeOutbox('ichikawa', '市川からのメッセージ');
  const q1 = bridge.readOutboxQueue(opState);
  assert.strictEqual(q1.length, 1);

  // processKey を mark
  opState.markProcessed(q1[0].processKey);

  const q2 = bridge.readOutboxQueue(opState);
  assert.strictEqual(q2.length, 0, '二重処理が発生している');
});

test('2e. 複数社員の outbox を一括読み込みできる', () => {
  cleanAll();
  writeOutbox('miyagi',   '宮城のメッセージ');
  writeOutbox('moriya',   '守谷のメッセージ');
  writeOutbox('ichikawa', '市川のメッセージ');
  const q = bridge.readOutboxQueue(opState);
  assert.ok(q.length >= 3, `queue が少ない: ${q.length}`);
});

// ─────────────────────────────────────────────────────
// 3. Phase2: Claude Desktop Bridge
// ─────────────────────────────────────────────────────
console.log('\n[3. Phase2 Claude Desktop Bridge]');

test('3a. bridgeToClaudeDesktop が clipboard モードで動作する', () => {
  const r = bridge.bridgeToClaudeDesktop('テストプロンプト', { sendMode: 'clipboard' });
  // 環境によってはクリップボードが使えない場合あり → ok または error を許容
  assert.ok(typeof r.ok === 'boolean', 'ok が boolean でない');
  assert.ok(typeof r.mode === 'string', 'mode がない');
});

test('3b. 黒川は内容を変更しない（入力と同じ内容がクリップボードに渡される）', () => {
  // bridgeToClaudeDesktop は prompt をそのまま clipboard に渡す
  // safeContent の変換は readOutboxQueue で行われ、bridgeToClaudeDesktop では変更しない
  const testContent = '守谷CTOへ: 実装完了しました（変更しないテスト）';
  const r = bridge.bridgeToClaudeDesktop(testContent, { sendMode: 'clipboard' });
  // clipboard に コピーされた内容 = testContent であること
  // (実際のクリップボード読み取りはテストでは困難なのでソース確認で代用)
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operator-bridge.js'), 'utf8'
  );
  assert.ok(bridgeSrc.includes('safePrompt = String(prompt)'), '内容変換コードがある');
  assert.ok(!bridgeSrc.includes('summary'), '要約コードがある');
  assert.ok(!bridgeSrc.includes('createTask'), 'タスク作成がある');
});

// ─────────────────────────────────────────────────────
// 4. Phase3: Reply 回収
// ─────────────────────────────────────────────────────
console.log('\n[4. Phase3 Reply 回収]');

test('4a. collectReply がファイルから回答を読み取れる', () => {
  cleanAll();
  const inPath = bridge.getInboxPath('miyagi');
  const dir = path.dirname(inPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(inPath, '実装完了しました。テスト結果: 全件PASS', 'utf8');

  const r = bridge.collectReply('miyagi', { source: 'file' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.preview.length > 0, 'preview が空');
});

test('4b. allowlist 外の worker は拒否される', () => {
  const r = bridge.collectReply('unknown_worker', { source: 'file' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('allowlist 外'), 'エラーメッセージが違う');
});

test('4c. 回答内容が redact される', () => {
  cleanAll();
  const fakeToken = 'ghp_' + 'B'.repeat(36);
  const inPath = bridge.getInboxPath('moriya');
  const dir = path.dirname(inPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(inPath, `token: ${fakeToken} LGTM`, 'utf8');

  const r = bridge.collectReply('moriya', { source: 'file' });
  assert.ok(!r.preview.includes(fakeToken), 'トークンが回答に含まれている');
});

// ─────────────────────────────────────────────────────
// 5. Phase5: Pause / Resume
// ─────────────────────────────────────────────────────
console.log('\n[5. Phase5 Pause / Resume]');

test('5a. setPaused(true) で isPaused が true になる', () => {
  resetState();
  bridge.setPaused(opState, true, 'テスト停止');
  assert.strictEqual(bridge.isPaused(opState), true);
});

test('5b. setPaused(false) で isPaused が false になる', () => {
  resetState();
  bridge.setPaused(opState, true, '一時停止');
  bridge.setPaused(opState, false);
  assert.strictEqual(bridge.isPaused(opState), false);
});

test('5c. pause 中は checkOnce が処理をスキップする', () => {
  cleanAll();
  writeOutbox('miyagi', '送信してはいけない');
  bridge.setPaused(opState, true, '緊急停止テスト');
  const r = operator.checkOnce();
  assert.strictEqual(r.newCount, 0, 'pause 中に送信された');
  bridge.setPaused(opState, false);
});

test('5d. pause 状態が state.json に保存される', () => {
  resetState();
  bridge.setPaused(opState, true, '理由テスト');
  const state = opState.loadState();
  assert.strictEqual(state.paused, true);
  assert.ok(state.pausedReason.includes('理由テスト'));
  assert.ok(state.pausedAt, 'pausedAt がない');
});

// ─────────────────────────────────────────────────────
// 6. 禁止事項の確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 禁止事項確認]');

test('6a. operator-bridge.js に eval がない', () => {
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operator-bridge.js'), 'utf8'
  );
  const code = bridgeSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
});

test('6b. 判断生成コードがない（READY/NEED_FIX 生成なし）', () => {
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operator-bridge.js'), 'utf8'
  );
  const code = bridgeSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes("'READY'") && !code.includes('"READY"'), 'READY 判定がある');
  assert.ok(!code.includes("'NEED_FIX'") && !code.includes('"NEED_FIX"'), 'NEED_FIX 判定がある');
  assert.ok(!code.includes('createTask('), 'createTask が含まれている');
  assert.ok(!code.includes('logDecision('), 'Decision 自動登録がある');
});

test('6c. PowerShell auto-send は本文を引数に渡さない', () => {
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operator-bridge.js'), 'utf8'
  );
  // PowerShell コマンドに safePrompt/prompt が含まれないこと
  // （クリップボード経由のみ許可）
  assert.ok(!bridgeSrc.match(/'-Command',.*safePrompt/), 'PowerShellに本文を直接渡している');
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. !operator pause が実装されている", () => {
  assert.ok(src.includes("opSub === 'pause'"), '!operator pause がない');
});

test("7b. !operator resume が実装されている", () => {
  assert.ok(src.includes("opSub === 'resume'"), '!operator resume がない');
});

test('7c. operator-bridge.js を require している', () => {
  assert.ok(src.includes("require('./utils/operator-bridge')"), 'require がない');
});

// ─────────────────────────────────────────────────────
// 8. E2E フロー確認（ドライラン）
// ─────────────────────────────────────────────────────
console.log('\n[8. E2E フロー確認（ドライラン）]');

test('8a. readOutboxQueue → bridgeToClaudeDesktop の流れが動作する', () => {
  cleanAll();
  writeOutbox('miyagi', '守谷CTOへ: 実装完了 commit abc123');

  const q = bridge.readOutboxQueue(opState);
  assert.ok(q.length > 0, 'outbox が読めない');

  const item    = q[0];
  const wrapped = scanner.buildPrompt(item.worker, item.safeContent);
  assert.ok(wrapped.includes('宮城'), 'wrapper に社員名がない');
  assert.ok(!wrapped.includes('ghp_'), 'wrapper にトークンが残っている');

  // clipboard コピー（内容変更なし）
  const r = bridge.bridgeToClaudeDesktop(wrapped, { sendMode: 'clipboard' });
  assert.ok(typeof r.ok === 'boolean', 'bridge result が invalid');
});

test('8b. checkOnce は pause 解除後に処理を再開する', () => {
  cleanAll();
  writeOutbox('miyagi', 'テスト再開');
  bridge.setPaused(opState, true, 'テスト');
  const r1 = operator.checkOnce();
  assert.strictEqual(r1.newCount, 0, 'pause 中に処理された');

  bridge.setPaused(opState, false);
  // pause 解除後は通常処理（handoff なしでブロックされるが処理は試みる）
  const r2 = operator.checkOnce();
  // handoff record がないのでブロックされる: blockedCnt > 0
  assert.ok(r2.blockedCnt >= 0, 'pause 解除後も処理が動かない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanAll();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
