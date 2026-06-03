'use strict';
// decision-log.js + !decision コマンド統合テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const dl  = require('../bot/utils/decision-log');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// テスト前にクリーンアップ
const TEST_FILE = path.join(__dirname, '..', 'data', 'decisions.json');
function resetDecisions() { dl._save([]); }

// 実データ保護: テスト開始時にスナップショットし、終了時に必ず復元する。
// （このテストは中間で decisions.json を書き換えるため、本番データを消さないようにする）
const _ORIG_DECISIONS = fs.existsSync(TEST_FILE) ? fs.readFileSync(TEST_FILE, 'utf8') : null;
function restoreDecisions() {
  if (_ORIG_DECISIONS !== null) fs.writeFileSync(TEST_FILE, _ORIG_DECISIONS, 'utf8');
  else { try { fs.unlinkSync(TEST_FILE); } catch { /* ignore */ } }
}

// ─────────────────────────────────────────────────────
// 1. 共通エンベロープ仕様準拠確認
// ─────────────────────────────────────────────────────
console.log('\n[1. 共通エンベロープ仕様確認]');

test('1a. _buildEnvelope が必須フィールドをすべて持つ', () => {
  const env = dl._buildEnvelope({ title: 'テスト決定' });
  const required = ['id', 'type', 'createdAt', 'projectId', 'severity', 'title', 'summary', 'refs', 'tags', 'status', 'data'];
  for (const f of required) {
    assert.ok(f in env, `${f} が存在しない`);
  }
});

test('1b. type は DECISION', () => {
  const env = dl._buildEnvelope({ title: 'テスト' });
  assert.strictEqual(env.type, 'DECISION');
});

test('1c. id は dec_ プレフィックス', () => {
  const env = dl._buildEnvelope({ title: 'テスト' });
  assert.ok(env.id.startsWith('dec_'), `id が dec_ で始まらない: ${env.id}`);
});

test('1d. refs は配列', () => {
  const env = dl._buildEnvelope({ title: 'テスト', refs: ['task_xxx', 'commit:abc'] });
  assert.ok(Array.isArray(env.refs));
  assert.strictEqual(env.refs.length, 2);
});

test('1e. tags は配列', () => {
  const env = dl._buildEnvelope({ title: 'テスト', tags: ['security', 'bug'] });
  assert.ok(Array.isArray(env.tags));
  assert.strictEqual(env.tags.length, 2);
});

test('1f. severity デフォルトは MEDIUM', () => {
  const env = dl._buildEnvelope({ title: 'テスト' });
  assert.strictEqual(env.severity, 'MEDIUM');
});

test('1g. status デフォルトは active（Phase1変更: DECIDED → active）', () => {
  const env = dl._buildEnvelope({ title: 'テスト' });
  // Phase1 で DECIDED → active に変更。後方互換のため DECIDED も _isActive=true。
  assert.ok(env.status === 'active' || env.status === 'DECIDED', `status: ${env.status}`);
});

test('1h. data はオブジェクト', () => {
  const env = dl._buildEnvelope({ title: 'テスト', data: { key: 'val' } });
  assert.ok(typeof env.data === 'object');
  assert.strictEqual(env.data.key, 'val');
});

// ─────────────────────────────────────────────────────
// 2. parseLogArgs — コマンドライン解析
// ─────────────────────────────────────────────────────
console.log('\n[2. parseLogArgs — コマンドライン解析]');

test('2a. タイトルのみ', () => {
  const r = dl.parseLogArgs('Secret Guardian の修正方針');
  assert.strictEqual(r.title, 'Secret Guardian の修正方針');
  assert.strictEqual(r.summary, '');
  assert.deepStrictEqual(r.refs, []);
  assert.deepStrictEqual(r.tags, []);
});

test('2b. タイトル | サマリー で分割', () => {
  const r = dl.parseLogArgs('修正方針 | process.env を精密除外する');
  assert.strictEqual(r.title, '修正方針');
  assert.strictEqual(r.summary, 'process.env を精密除外する');
});

test('2c. refs: を抽出できる', () => {
  const r = dl.parseLogArgs('修正方針 refs:task_123,commit:abc123');
  assert.ok(r.refs.includes('task_123'), 'task_123 がない');
  assert.ok(r.refs.includes('commit:abc123'), 'commit:abc123 がない');
});

test('2d. tags: を抽出できる', () => {
  const r = dl.parseLogArgs('修正方針 tags:security,bug');
  assert.ok(r.tags.includes('security'));
  assert.ok(r.tags.includes('bug'));
});

test('2e. refs: / tags: 付きでもタイトルは正しく取れる', () => {
  const r = dl.parseLogArgs('修正方針 | サマリー refs:task_xxx tags:sec');
  assert.strictEqual(r.title, '修正方針');
  assert.strictEqual(r.summary, 'サマリー');
  assert.ok(r.refs.includes('task_xxx'));
  assert.ok(r.tags.includes('sec'));
});

// ─────────────────────────────────────────────────────
// 3. logDecision — 記録
// ─────────────────────────────────────────────────────
console.log('\n[3. logDecision — 記録]');

test('3a. 正常に記録できる', () => {
  resetDecisions();
  const r = dl.logDecision({ title: 'テスト意思決定', summary: 'テストサマリー' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id.startsWith('dec_'), 'id が dec_ で始まらない');
  assert.ok(r.text.includes('意思決定を記録しました'));
});

test('3b. タイトルなしはエラー', () => {
  const r = dl.logDecision({ title: '' });
  assert.strictEqual(r.ok, false);
});

test('3c. refs が保存される', () => {
  resetDecisions();
  dl.logDecision({ title: 'refs テスト', refs: ['task_999', 'commit:aabbcc'] });
  const list = dl._load();
  assert.strictEqual(list[0].refs[0], 'task_999');
  assert.strictEqual(list[0].refs[1], 'commit:aabbcc');
});

test('3d. タスク・レビュー内容をコピー保存しない（refs のみ）', () => {
  resetDecisions();
  dl.logDecision({ title: 'refs方式テスト', refs: ['task_abc', 'review_abc'], summary: '要約のみ' });
  const list = dl._load();
  const rec  = list[0];
  // refs に ID はあるが、task の prompt 等は data に存在しない
  assert.ok(rec.refs.includes('task_abc'));
  assert.ok(!JSON.stringify(rec.data).includes('prompt'), 'task.prompt がコピーされている');
});

test('3e. title / summary に redact が適用される', () => {
  resetDecisions();
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  dl.logDecision({ title: `token: ${fakeToken}`, summary: '秘密情報テスト' });
  const list = dl._load();
  assert.ok(!list[0].title.includes(fakeToken), 'トークンがタイトルに残っている');
  assert.ok(list[0].title.includes('[MASKED]'), 'MASKED がない');
});

test('3f. 複数件追記できる', () => {
  resetDecisions();
  dl.logDecision({ title: '決定A' });
  dl.logDecision({ title: '決定B' });
  dl.logDecision({ title: '決定C' });
  const list = dl._load();
  assert.strictEqual(list.length, 3);
});

// ─────────────────────────────────────────────────────
// 4. listDecisions — 一覧表示
// ─────────────────────────────────────────────────────
console.log('\n[4. listDecisions — 一覧表示]');

test('4a. 空のときは案内メッセージ', () => {
  resetDecisions();
  const r = dl.listDecisions();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('記録された意思決定はありません'));
});

test('4b. 記録後は一覧に表示される', () => {
  resetDecisions();
  dl.logDecision({ title: 'テスト決定X', tags: ['arch'] });
  const r = dl.listDecisions();
  assert.ok(r.text.includes('テスト決定X'), 'タイトルが表示されない');
});

test('4c. 新しい順に表示される', () => {
  resetDecisions();
  dl.logDecision({ title: '古い決定' });
  dl.logDecision({ title: '新しい決定' });
  const r = dl.listDecisions();
  const newIdx = r.text.indexOf('新しい決定');
  const oldIdx = r.text.indexOf('古い決定');
  assert.ok(newIdx < oldIdx, '新しい決定が先に表示されていない');
});

test('4d. limit が効く', () => {
  resetDecisions();
  for (let i = 0; i < 15; i++) dl.logDecision({ title: `決定${i}` });
  const r = dl.listDecisions(5);
  // 5件だけ表示 (各エントリは複数行なので件数カウントは文字列内のdec_数で)
  const decCount = (r.text.match(/dec_/g) || []).length;
  assert.ok(decCount <= 5, `表示件数が5を超えている: ${decCount}`);
});

// ─────────────────────────────────────────────────────
// 5. showDecision — 詳細表示
// ─────────────────────────────────────────────────────
console.log('\n[5. showDecision — 詳細表示]');

test('5a. ID で詳細表示できる', () => {
  resetDecisions();
  const created = dl.logDecision({ title: '詳細テスト', summary: '詳細サマリー', tags: ['test'] });
  const r = dl.showDecision(created.id);
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('詳細テスト'), 'タイトルがない');
  assert.ok(r.text.includes('詳細サマリー'), 'サマリーがない');
  assert.ok(r.text.includes('test'), 'タグがない');
});

test('5b. 存在しない ID は ok:false', () => {
  resetDecisions();
  const r = dl.showDecision('dec_nonexistent');
  assert.strictEqual(r.ok, false);
});

test('5c. ID なしは使い方を返す', () => {
  const r = dl.showDecision('');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('使い方'));
});

test('5d. 末尾部分一致でも検索できる（短縮ID）', () => {
  resetDecisions();
  const created = dl.logDecision({ title: '短縮IDテスト' });
  // id は dec_1234567890 形式 → 末尾10桁で検索
  const shortId = created.id.split('_')[1]; // タイムスタンプ部分
  const r = dl.showDecision(shortId);
  assert.strictEqual(r.ok, true, `短縮ID ${shortId} で見つからない`);
});

test('5e. refs が詳細に表示される', () => {
  resetDecisions();
  const created = dl.logDecision({ title: 'refs確認', refs: ['task_abc', 'commit:xyz'] });
  const r = dl.showDecision(created.id);
  assert.ok(r.text.includes('task_abc'), 'refs が表示されない');
  assert.ok(r.text.includes('commit:xyz'));
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. startsWith('!decision') が実装されている", () => {
  assert.ok(src.includes("startsWith('!decision')"), '!decision ハンドラがない');
});

test('6b. !decision log が実装されている', () => {
  const idx  = src.indexOf("startsWith('!decision')");
  const area = src.slice(idx, idx + 2000);
  assert.ok(area.includes("decSub === 'log'"), '!decision log がない');
});

test('6c. !decision list が実装されている', () => {
  const idx  = src.indexOf("startsWith('!decision')");
  const area = src.slice(idx, idx + 2000);
  assert.ok(area.includes("decSub === 'list'"), '!decision list がない');
});

test('6d. !decision show が実装されている', () => {
  const idx  = src.indexOf("startsWith('!decision')");
  const area = src.slice(idx, idx + 2000);
  assert.ok(area.includes("decSub === 'show'"), '!decision show がない');
});

test('6e. decision-log.js を require している', () => {
  const idx  = src.indexOf("startsWith('!decision')");
  const area = src.slice(idx, idx + 2000);
  assert.ok(area.includes("require('./utils/decision-log')"), 'decision-log require がない');
});

test('6f. parseLogArgs を呼んでいる', () => {
  const idx  = src.indexOf("startsWith('!decision')");
  const area = src.slice(idx, idx + 2000);
  assert.ok(area.includes('parseLogArgs'), 'parseLogArgs 呼び出しがない');
});

// ─────────────────────────────────────────────────────
// 7. .gitignore / ファイル管理
// ─────────────────────────────────────────────────────
console.log('\n[7. .gitignore / データ管理]');

test('7a. decisions.json が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/decisions.json'), '.gitignore に decisions.json がない');
});

test('7b. incidents.json が .gitignore に追加されている（将来拡張分）', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/incidents.json'), '.gitignore に incidents.json がない');
});

test('7c. docs/envelope-spec.md が存在する', () => {
  const specPath = path.join(__dirname, '..', 'docs', 'envelope-spec.md');
  assert.ok(fs.existsSync(specPath), 'envelope-spec.md が存在しない');
});

test('7d. envelope-spec.md に必須フィールドが記載されている', () => {
  const spec = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'envelope-spec.md'), 'utf8'
  );
  const requiredFields = ['id', 'type', 'createdAt', 'projectId', 'severity', 'title', 'summary', 'refs', 'tags', 'status', 'data'];
  for (const f of requiredFields) {
    assert.ok(spec.includes(`\`${f}\``), `仕様書に ${f} フィールドがない`);
  }
});

// ─────────────────────────────────────────────────────
// 8. Decision Log 整理 API（archive / category / 重複検出）
// ─────────────────────────────────────────────────────
console.log('\n[8. Decision Log 整理 API]');

test('8a. findDuplicates が同一タイトルのクラスタを検出する', () => {
  resetDecisions();
  dl.logDecision({ title: '黒川の固定ルート自動配送を許可' });
  dl.logDecision({ title: '黒川の固定ルート自動配送を許可' });
  dl.logDecision({ title: '別の決定' });
  const clusters = dl.findDuplicates();
  assert.strictEqual(clusters.length, 1, 'クラスタ数が1でない');
  assert.strictEqual(clusters[0].decisions.length, 2);
  assert.ok(clusters[0].keep, 'keep がない');
  assert.strictEqual(clusters[0].archive.length, 1, 'archive候補が1件でない');
});

test('8b. findDuplicates は最新を keep にする', () => {
  resetDecisions();
  const a = dl.logDecision({ title: '重複X' });
  const b = dl.logDecision({ title: '重複X' });
  const list = dl._load();
  // createdAt 同一の可能性に備え、2件目を後の時刻に補正
  list[1].createdAt = new Date(Date.now() + 1000).toISOString();
  dl._save(list);
  const clusters = dl.findDuplicates();
  assert.strictEqual(clusters[0].keep.id, list[1].id, '最新が keep になっていない');
});

test('8c. archiveDecision は削除せず status=ARCHIVED + supersededBy を設定', () => {
  resetDecisions();
  const keep = dl.logDecision({ title: '新しい決定' });
  const old  = dl.logDecision({ title: '古い決定' });
  const r = dl.archiveDecision(old.id, keep.id, '重複のため統合');
  assert.strictEqual(r.ok, true);
  const list = dl._load();
  assert.strictEqual(list.length, 2, 'レコードが削除されている（履歴消失）');
  const archived = list.find(d => d.id === old.id);
  assert.ok(archived.status === 'archived' || archived.status === 'ARCHIVED', `status: ${archived.status}`);
  assert.strictEqual(archived.supersededBy, keep.id);
  assert.ok(archived.archivedAt, 'archivedAt がない');
  assert.strictEqual(archived.title, '古い決定', '過去の判断理由（title）が消えている');
});

test('8d. archiveDecision は存在しないIDで ok:false', () => {
  resetDecisions();
  const r = dl.archiveDecision('dec_none', 'dec_x');
  assert.strictEqual(r.ok, false);
});

test('8e. setCategory が有効カテゴリを設定、無効はエラー', () => {
  resetDecisions();
  const d = dl.logDecision({ title: 'カテゴリテスト' });
  // Phase1: カテゴリは lowercase に変更 (security / workflow / core 等)
  assert.strictEqual(dl.setCategory(d.id, 'security').ok, true);
  assert.strictEqual(dl._load()[0].category, 'security');
  assert.strictEqual(dl.setCategory(d.id, '無効カテゴリ').ok, false);
});

test('8f. categorizeDecision がタグから妥当なカテゴリを推定', () => {
  // Phase1: カテゴリは lowercase に変更
  assert.strictEqual(dl.categorizeDecision({ title: 'L-16採用', tags: ['security', 'l-16'] }),       'security');
  assert.strictEqual(dl.categorizeDecision({ title: '黒川の自動配送', tags: ['workflow', 'kurokawa'] }), 'workflow');
  assert.strictEqual(dl.categorizeDecision({ title: 'COMPANY_CONTEXT参照', tags: ['context', 'handoff'] }), 'learning');
  assert.strictEqual(dl.categorizeDecision({ title: 'AI社員役割', tags: ['roles', 'company'] }),     'core');
});

test('8g. listDecisions は ARCHIVED を既定で非表示にする', () => {
  resetDecisions();
  const keep = dl.logDecision({ title: '有効な決定AAA' });
  const old  = dl.logDecision({ title: 'アーカイブ済決定BBB' });
  dl.archiveDecision(old.id, keep.id, 'test');
  const r = dl.listDecisions();
  assert.ok(r.text.includes('有効な決定AAA'), '有効な決定が表示されない');
  assert.ok(!r.text.includes('アーカイブ済決定BBB'), 'ARCHIVED が表示されている');
  // includeArchived=true なら表示
  const r2 = dl.listDecisions(10, true);
  assert.ok(r2.text.includes('アーカイブ済決定BBB'), 'includeArchived でも表示されない');
});

test('8h. _buildEnvelope に category フィールドがある', () => {
  // Phase1: lowercase カテゴリに変更
  const env = dl._buildEnvelope({ title: 'x', category: 'workflow' });
  assert.strictEqual(env.category, 'workflow');
  const env2 = dl._buildEnvelope({ title: 'x', category: '不正' });
  assert.strictEqual(env2.category, null, '不正カテゴリは null になるべき');
});

// ─────────────────────────────────────────────────────
// 後処理 — 実データを復元（テストで上書きしたものを元に戻す）
// ─────────────────────────────────────────────────────
restoreDecisions();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
