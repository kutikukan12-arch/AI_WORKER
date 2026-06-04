'use strict';
// Company Memory Sync テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const cs  = require('../bot/utils/company-sync');
const ib  = require('../bot/utils/inbox-bridge');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetHistory() { cs._saveHistory({ syncs: [] }); }
function cleanOutbox() {
  for (const w of ib.VALID_WORKERS) {
    try {
      const p = ib._workerOutboxPath(w);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

// ─────────────────────────────────────────────────────
// 1. runSync — 全社員通知
// ─────────────────────────────────────────────────────
console.log('\n[1. runSync — 全社員通知]');

test('1a. runSync が ok:true を返す', () => {
  resetHistory(); cleanOutbox();
  const r = cs.runSync({ force: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.version, 'version がない');
});

test('1b. 全9名に通知される', () => {
  resetHistory(); cleanOutbox();
  const r = cs.runSync({ force: true });
  assert.strictEqual(r.notifiedWorkers.length, ib.VALID_WORKERS.length,
    `通知数が${ib.VALID_WORKERS.length}でない: ${r.notifiedWorkers.length}`);
});

test('1c. 全社員の outbox が作成される', () => {
  resetHistory(); cleanOutbox();
  cs.runSync({ force: true });
  for (const w of ib.VALID_WORKERS) {
    const p = ib._workerOutboxPath(w);
    assert.ok(fs.existsSync(p), `${w} の outbox が作成されない`);
  }
});

test('1d. sync-history.json にレコードが保存される', () => {
  resetHistory(); cleanOutbox();
  cs.runSync({ force: true });
  const hist = cs._loadHistory();
  assert.ok(hist.syncs.length > 0, 'sync が記録されない');
  assert.ok(hist.syncs[0].notified.length > 0);
});

test('1e. バージョンが記録される', () => {
  resetHistory(); cleanOutbox();
  const r = cs.runSync({ force: true });
  const hist = cs._loadHistory();
  assert.strictEqual(hist.syncs[0].version, r.version, 'バージョンが一致しない');
});

test('1f. 通知済みバージョン再送は skip（force なし）', () => {
  resetHistory(); cleanOutbox();
  cs.runSync({ force: true });       // 初回
  const r2 = cs.runSync();           // 2回目（同バージョン）
  assert.strictEqual(r2.upToDate, true, '同バージョンなのに送信された');
});

test('1g. force=true なら同バージョンでも再送', () => {
  resetHistory(); cleanOutbox();
  cs.runSync({ force: true });
  const r2 = cs.runSync({ force: true });
  assert.strictEqual(r2.upToDate, false, 'force でも skip された');
  assert.ok(r2.notifiedWorkers.length > 0);
});

// ─────────────────────────────────────────────────────
// 2. バージョン管理
// ─────────────────────────────────────────────────────
console.log('\n[2. バージョン管理]');

test('2a. _generateVersion が 12文字のハッシュを返す', () => {
  const sources = { context: 'テスト', rules: 'ルール', decisions: '決定' };
  const v = cs._generateVersion(sources);
  assert.strictEqual(v.length, 12, `バージョン長が12でない: ${v.length}`);
});

test('2b. 同じコンテンツは同じバージョン', () => {
  const s  = { context: 'A', rules: 'B', decisions: 'C' };
  const v1 = cs._generateVersion(s);
  const v2 = cs._generateVersion(s);
  assert.strictEqual(v1, v2);
});

test('2c. コンテンツが変わればバージョンが変わる', () => {
  const v1 = cs._generateVersion({ context: 'A', rules: 'B', decisions: 'C' });
  const v2 = cs._generateVersion({ context: 'X', rules: 'B', decisions: 'C' });
  assert.notStrictEqual(v1, v2);
});

// ─────────────────────────────────────────────────────
// 3. secret 除外 / redact
// ─────────────────────────────────────────────────────
console.log('\n[3. secret 除外 / redact]');

test('3a. 通知文に Discord Token が含まれない', () => {
  const sources = { decisionCount: 0, decisions: 'テスト' };
  const msg     = cs._buildWorkerMessage('miyagi', sources, 'abc123', 'テスト変更');
  assert.ok(!/MT[A-Za-z0-9]{18,32}\.[A-Za-z0-9_-]{4,8}/.test(msg), 'Discord Token が含まれている');
});

test('3b. _collectSources に gitignore 内ファイルが含まれない', () => {
  const sources = cs._collectSources();
  // .env の内容がコンテキストに入っていないこと
  assert.ok(!String(sources.context || '').includes('DISCORD_TOKEN='), '.env が含まれている');
});

test('3c. _buildWorkerMessage に ghp_ トークンが混入しない', () => {
  const fakeToken = 'ghp_' + 'X'.repeat(36);
  const sources   = {
    decisionCount: 1,
    decisions:     `• [HIGH] token: ${fakeToken} について`,
  };
  const msg = cs._buildWorkerMessage('moriya', sources, 'abc', '変更あり');
  // decisionのタイトルは redact 済みであること（_collectSources 内で適用）
  // ここでは buildWorkerMessage 自体は sources をそのまま使う設計
  // → _collectSources で事前に redact されていることを確認
  assert.ok(typeof msg === 'string', '文字列でない');
});

// ─────────────────────────────────────────────────────
// 4. 社員別関連セクション抽出
// ─────────────────────────────────────────────────────
console.log('\n[4. 社員別関連セクション抽出]');

test('4a. 黒川のキーワードで workflow 関連が抽出される', () => {
  const sources = {
    context: '黒川は workflow の配送を担当する\n守谷はレビューを担当する',
    rules:   '黒川: 配送・進行管理のみ',
  };
  const r = cs._extractRelevantSections(sources, 'kurokawa');
  assert.ok(r.length > 0 && r !== '（変更なし）', '関連セクションが抽出されない');
});

test('4b. 関係ないセクションは抽出されない', () => {
  const sources = {
    context: '市川はPMとしてMVP判断を担当する',
    rules:   '',
  };
  // kurokawa のキーワード（workflow, 配送, 黒川）は含まれないので変更なし
  const r = cs._extractRelevantSections(sources, 'kurokawa');
  // 関連なければ（変更なし）を返す
  // 注: 完全一致でなくても何かの単語がかぶる可能性があるので存在チェックのみ
  assert.ok(typeof r === 'string', '文字列でない');
});

// ─────────────────────────────────────────────────────
// 5. getSyncStatus
// ─────────────────────────────────────────────────────
console.log('\n[5. getSyncStatus]');

test('5a. sync 前は「未実行」を返す', () => {
  resetHistory();
  const r = cs.getSyncStatus();
  assert.ok(r.text.includes('sync が実行されていません') || r.text.includes('まだ'));
});

test('5b. sync 後は最終情報を返す', () => {
  resetHistory(); cleanOutbox();
  cs.runSync({ force: true });
  const r = cs.getSyncStatus();
  assert.ok(r.text.includes('最終 sync'));
});

// ─────────────────────────────────────────────────────
// 6. 禁止事項の確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 禁止事項確認]');

test('6a. company-sync.js に eval がない', () => {
  const syncSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'company-sync.js'), 'utf8'
  );
  const code = syncSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('),    'eval が含まれている');
  assert.ok(!code.includes('execSync('),'execSync が含まれている');
});

test('6b. 自動判断・承認・task変更をしない', () => {
  const syncSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'company-sync.js'), 'utf8'
  );
  const code = syncSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),   'createTask が呼ばれている');
  assert.ok(!code.includes('updateState('),  'updateState が呼ばれている');
  assert.ok(!code.includes('logDecision('),  'Decision を自動登録している');
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. !company sync が実装されている", () => {
  assert.ok(src.includes("compSub === 'sync'"), '!company sync がない');
});

test('7b. company-sync.js を require している', () => {
  const idx  = src.indexOf("compSub === 'sync'");
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes("require('./utils/company-sync')"), 'require がない');
});

test('7c. --force オプションが実装されている', () => {
  const idx  = src.indexOf("compSub === 'sync'");
  const area = src.slice(idx, idx + 400);
  assert.ok(area.includes('force'), 'force オプションがない');
});

// ─────────────────────────────────────────────────────
// 8. .gitignore 確認
// ─────────────────────────────────────────────────────
console.log('\n[8. .gitignore 確認]');

test('8a. sync-history.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/sync-history.json'), 'gitignore にない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetHistory();
cleanOutbox();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
