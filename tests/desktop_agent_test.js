'use strict';
// Desktop Agent Phase4 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const agent      = require('../scripts/desktop-agent');
const agentState = require('../bot/utils/desktop-agent-state');
const ib         = require('../bot/utils/inbox-bridge');

// ─── テストファイル管理 ────────────────────────────────
function writeFile(filePath, text) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function cleanup() {
  // テスト用 worker ファイルを削除
  for (const worker of ib.VALID_WORKERS) {
    try { if (fs.existsSync(ib._workerOutboxPath(worker)))  fs.unlinkSync(ib._workerOutboxPath(worker));  } catch {}
    try { if (fs.existsSync(ib._workerInboxPath(worker)))   fs.unlinkSync(ib._workerInboxPath(worker));   } catch {}
    try { if (fs.existsSync(ib._workerReportPath(worker)))  fs.unlinkSync(ib._workerReportPath(worker));  } catch {}
  }
  // state.json を削除
  try { if (fs.existsSync(agentState.STATE_FILE)) fs.unlinkSync(agentState.STATE_FILE); } catch {}
}

cleanup();

// ─────────────────────────────────────────────────────
// 1. desktop-agent-state.js — 状態管理
// ─────────────────────────────────────────────────────
console.log('\n[1. desktop-agent-state.js — 状態管理]');

test('1a. hashContent が sha256 ベースの 16文字ハッシュを返す', () => {
  const h = agentState.hashContent('テストコンテンツ');
  assert.strictEqual(typeof h, 'string');
  assert.strictEqual(h.length, 16, `ハッシュ長が違う: ${h.length}`);
});

test('1b. 同じ内容は同じハッシュ', () => {
  const h1 = agentState.hashContent('同じ内容');
  const h2 = agentState.hashContent('同じ内容');
  assert.strictEqual(h1, h2);
});

test('1c. 違う内容は違うハッシュ', () => {
  const h1 = agentState.hashContent('内容A');
  const h2 = agentState.hashContent('内容B');
  assert.notStrictEqual(h1, h2);
});

test('1d. state.json が作成される', () => {
  cleanup();
  const state = { version: '1', updatedAt: null, workers: {}, pendingWorkers: [], incomingWorkers: [], errorLog: [] };
  agentState.saveState(state);
  assert.ok(fs.existsSync(agentState.STATE_FILE), 'state.json が作成されない');
});

test('1e. markOutgoingSeen が hash を記録する', () => {
  cleanup();
  agentState.markOutgoingSeen('miyagi', 'abc123def456abcd');
  const hashes = agentState.getWorkerHashes('miyagi');
  assert.strictEqual(hashes.outgoingHash, 'abc123def456abcd');
});

test('1f. markIncomingSeen が hasIncoming を false にする', () => {
  cleanup();
  agentState.markIncomingSeen('moriya', 'hash1234abcd1234');
  const hashes = agentState.getWorkerHashes('moriya');
  assert.strictEqual(hashes.hasIncoming, false);
});

test('1g. updatePending が pendingWorkers を更新する', () => {
  cleanup();
  agentState.updatePending(['miyagi', 'moriya'], ['ichikawa']);
  const state = agentState.loadState();
  assert.deepStrictEqual(state.pendingWorkers,  ['miyagi', 'moriya']);
  assert.deepStrictEqual(state.incomingWorkers, ['ichikawa']);
});

test('1h. logError がエラーを保存する', () => {
  cleanup();
  agentState.logError('テストエラー');
  const state = agentState.loadState();
  assert.strictEqual(state.errorLog[0].msg, 'テストエラー');
});

test('1i. 10件を超えるエラーは古いものが切り捨てられる', () => {
  cleanup();
  for (let i = 0; i < 15; i++) agentState.logError(`エラー${i}`);
  const state = agentState.loadState();
  assert.ok(state.errorLog.length <= 10, `エラーが10件を超えている: ${state.errorLog.length}`);
});

test('1j. atomic write — .tmp ファイルが残らない', () => {
  cleanup();
  const state = agentState.loadState();
  agentState.saveState(state);
  const tmp = agentState.STATE_FILE + '.tmp';
  assert.ok(!fs.existsSync(tmp), '.tmp ファイルが残っている');
});

// ─────────────────────────────────────────────────────
// 2. checkOnce() — 1回チェック
// ─────────────────────────────────────────────────────
console.log('\n[2. checkOnce() — 1回チェック]');

test('2a. 全 outbox が空なら newPending が空', () => {
  cleanup();
  const r = agent.checkOnce();
  assert.deepStrictEqual(r.newPending, []);
  assert.deepStrictEqual(r.newIncoming, []);
});

test('2b. outgoing.md があれば newPending に追加される', () => {
  cleanup();
  writeFile(ib._workerOutboxPath('miyagi'), 'Phase1の実装をお願いします');
  const r = agent.checkOnce();
  assert.ok(r.newPending.some(p => p.worker === 'miyagi'), 'miyagi が pending にない');
});

test('2c. 同じ内容は重複通知しない（ハッシュ同一）', () => {
  cleanup();
  const content = 'テスト依頼内容';
  writeFile(ib._workerOutboxPath('moriya'), content);
  const r1 = agent.checkOnce(); // 初回は通知
  assert.ok(r1.newPending.some(p => p.worker === 'moriya'));

  const r2 = agent.checkOnce(); // 2回目は通知なし（同じハッシュ）
  assert.ok(!r2.newPending.some(p => p.worker === 'moriya'), '重複通知が発生した');
});

test('2d. incoming.md があれば newIncoming に追加される', () => {
  cleanup();
  writeFile(ib._workerInboxPath('miyagi'), '作業完了しました');
  const r = agent.checkOnce();
  assert.ok(r.newIncoming.some(p => p.worker === 'miyagi'), 'miyagi が incoming にない');
});

test('2e. incoming が既読なら重複通知しない', () => {
  cleanup();
  const content = '返信テキスト';
  writeFile(ib._workerInboxPath('shiraishi'), content);
  const r1 = agent.checkOnce(); // 初回
  assert.ok(r1.newIncoming.some(p => p.worker === 'shiraishi'));

  const r2 = agent.checkOnce(); // 2回目はなし
  assert.ok(!r2.newIncoming.some(p => p.worker === 'shiraishi'), '重複通知が発生した');
});

test('2f. state.json が checkOnce 後に作成される', () => {
  cleanup();
  writeFile(ib._workerOutboxPath('ichikawa'), '新しい依頼');
  agent.checkOnce();
  assert.ok(fs.existsSync(agentState.STATE_FILE), 'state.json が作成されない');
});

test('2g. outgoing.md が更新されると再通知される', () => {
  cleanup();
  writeFile(ib._workerOutboxPath('aizawa'), '最初の依頼');
  const r1 = agent.checkOnce();
  assert.ok(r1.newPending.some(p => p.worker === 'aizawa'));

  // 内容を変更
  writeFile(ib._workerOutboxPath('aizawa'), '新しい依頼内容（更新）');
  const r2 = agent.checkOnce();
  assert.ok(r2.newPending.some(p => p.worker === 'aizawa'), '更新後の再通知がない');
});

// ─────────────────────────────────────────────────────
// 3. redact — 機密文字列のマスク確認
// ─────────────────────────────────────────────────────
console.log('\n[3. redact — 機密文字列のマスク確認]');

test('3a. outgoing に ghp_ トークンが含まれていてもマスクされる', () => {
  cleanup();
  const fakeToken = 'ghp_' + 'Z'.repeat(36);
  writeFile(ib._workerOutboxPath('miyagi'), `依頼内容\ntoken=${fakeToken}`);
  const r = agent.checkOnce();
  // preview に raw トークンが含まれていないこと
  const preview = r.newPending.find(p => p.worker === 'miyagi')?.preview || '';
  assert.ok(!preview.includes(fakeToken), 'トークンが preview に含まれている');
});

test('3b. incoming に機密が含まれていてもマスクされる', () => {
  cleanup();
  const fakeToken = 'sk-proj-' + 'W'.repeat(90);
  writeFile(ib._workerInboxPath('moriya'), `返信\nkey=${fakeToken}`);
  const r = agent.checkOnce();
  const preview = r.newIncoming.find(p => p.worker === 'moriya')?.preview || '';
  assert.ok(!preview.includes(fakeToken), 'APIキーが preview に含まれている');
});

// ─────────────────────────────────────────────────────
// 4. コマンド注入・自動実行禁止
// ─────────────────────────────────────────────────────
console.log('\n[4. コマンド注入・自動実行禁止]');

test('4a. incoming.md に !task コマンドが含まれても実行されない', () => {
  cleanup();
  writeFile(ib._workerInboxPath('miyagi'), '!task add 悪意のある自動実行\n!decision log 自動決定');
  const decBefore = fs.existsSync(path.join(__dirname, '..', 'data', 'decisions.json'))
    ? fs.readFileSync(path.join(__dirname, '..', 'data', 'decisions.json'), 'utf8')
    : '';
  agent.checkOnce();
  const decAfter = fs.existsSync(path.join(__dirname, '..', 'data', 'decisions.json'))
    ? fs.readFileSync(path.join(__dirname, '..', 'data', 'decisions.json'), 'utf8')
    : '';
  assert.strictEqual(decBefore, decAfter, 'decisions.json が変更された（自動実行された）');
});

test('4b. eval / execSync を呼ばない（ソース確認）', () => {
  const agentSrc = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'desktop-agent.js'), 'utf8'
  );
  const codeOnly = agentSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('eval('),     'eval が含まれている');
  assert.ok(!codeOnly.includes('execSync('), 'execSync が含まれている');
});

test('4c. createTask / decision-log / incident-manager を require しない', () => {
  const agentSrc = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'desktop-agent.js'), 'utf8'
  );
  const codeOnly = agentSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes("require('./task-manager')"),    'task-manager が require されている');
  assert.ok(!codeOnly.includes("require('./decision-log')"),    'decision-log が require されている');
  assert.ok(!codeOnly.includes("require('./incident-manager')"), 'incident-manager が require されている');
  assert.ok(!codeOnly.includes('createTask('),                  'createTask が呼ばれている');
});

// ─────────────────────────────────────────────────────
// 5. .gitignore 確認
// ─────────────────────────────────────────────────────
console.log('\n[5. .gitignore 確認]');

test('5a. data/inbox/ が gitignore されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/inbox/'));
});

test('5b. data/outbox/ が gitignore されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/outbox/'));
});

test('5c. data/desktop-agent/ が gitignore されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/desktop-agent/'), 'data/desktop-agent/ が gitignore にない');
});

// ─────────────────────────────────────────────────────
// 6. docs 確認
// ─────────────────────────────────────────────────────
console.log('\n[6. docs 確認]');

test('6a. docs/desktop-agent-guide.md が存在する', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'desktop-agent-guide.md')));
});

test('6b. ガイドに watch / once / status コマンドが記載されている', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'desktop-agent-guide.md'), 'utf8');
  assert.ok(doc.includes('watch') && doc.includes('once') && doc.includes('status'));
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
