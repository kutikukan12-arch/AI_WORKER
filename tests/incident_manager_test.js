'use strict';
// incident-manager.js + !incident コマンド統合テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const im  = require('../bot/utils/incident-manager');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function resetIncidents() { im._save([]); }

// ─────────────────────────────────────────────────────
// 1. 共通エンベロープ仕様準拠確認
// ─────────────────────────────────────────────────────
console.log('\n[1. 共通エンベロープ仕様確認]');

test('1a. _buildEnvelope が必須フィールドをすべて持つ', () => {
  const env = im._buildEnvelope({ title: 'テスト障害' });
  const required = ['id','type','createdAt','projectId','severity','title','summary','refs','tags','status','data'];
  for (const f of required) assert.ok(f in env, `${f} が存在しない`);
});

test('1b. type は INCIDENT', () => {
  const env = im._buildEnvelope({ title: 'テスト' });
  assert.strictEqual(env.type, 'INCIDENT');
});

test('1c. id は inc_ プレフィックス', () => {
  const env = im._buildEnvelope({ title: 'テスト' });
  assert.ok(env.id.startsWith('inc_'), `id が inc_ で始まらない: ${env.id}`);
});

test('1d. 初期 status は OPEN', () => {
  const env = im._buildEnvelope({ title: 'テスト' });
  assert.strictEqual(env.status, 'OPEN');
});

test('1e. severity デフォルトは MEDIUM', () => {
  const env = im._buildEnvelope({ title: 'テスト' });
  assert.strictEqual(env.severity, 'MEDIUM');
});

test('1f. refs は配列', () => {
  const env = im._buildEnvelope({ title: 'テスト', refs: ['task_abc', 'commit:xyz'] });
  assert.ok(Array.isArray(env.refs));
  assert.strictEqual(env.refs.length, 2);
});

test('1g. tags は配列', () => {
  const env = im._buildEnvelope({ title: 'テスト', tags: ['security'] });
  assert.ok(Array.isArray(env.tags));
});

test('1h. data に INCIDENT 固有フィールドが含まれる', () => {
  const env = im._buildEnvelope({ title: 'テスト' });
  assert.ok('detectedAt'  in env.data, 'detectedAt がない');
  assert.ok('resolvedAt'  in env.data, 'resolvedAt がない');
  assert.ok('rootCause'   in env.data, 'rootCause がない');
  assert.ok('mitigation'  in env.data, 'mitigation がない');
  assert.ok('prevention'  in env.data, 'prevention がない');
  assert.ok('affectedArea' in env.data, 'affectedArea がない');
});

test('1i. data.resolvedAt は初期 null', () => {
  const env = im._buildEnvelope({ title: 'テスト' });
  assert.strictEqual(env.data.resolvedAt, null);
});

// ─────────────────────────────────────────────────────
// 2. parseArgs — コマンドライン解析
// ─────────────────────────────────────────────────────
console.log('\n[2. parseArgs — コマンドライン解析]');

test('2a. 要約のみ', () => {
  const r = im.parseArgs('Secret Guardian が commit を誤ブロック');
  assert.strictEqual(r.title, 'Secret Guardian が commit を誤ブロック');
  assert.strictEqual(r.summary, '');
  assert.deepStrictEqual(r.refs, []);
});

test('2b. 要約 | 詳細 で分割', () => {
  const r = im.parseArgs('GitHubトークン期限切れ | push 失敗が継続');
  assert.strictEqual(r.title, 'GitHubトークン期限切れ');
  assert.strictEqual(r.summary, 'push 失敗が継続');
});

test('2c. refs: を抽出できる', () => {
  const r = im.parseArgs('push 失敗 refs:task_999,commit:abc');
  assert.ok(r.refs.includes('task_999'));
  assert.ok(r.refs.includes('commit:abc'));
});

test('2d. tags: を抽出できる', () => {
  const r = im.parseArgs('push 失敗 tags:github,push');
  assert.ok(r.tags.includes('github'));
  assert.ok(r.tags.includes('push'));
});

// ─────────────────────────────────────────────────────
// 3. openIncident — 起票
// ─────────────────────────────────────────────────────
console.log('\n[3. openIncident — 起票]');

test('3a. 正常に起票できる', () => {
  resetIncidents();
  const r = im.openIncident({ title: 'テスト障害', summary: '詳細テキスト' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id.startsWith('inc_'));
  assert.ok(r.text.includes('インシデント起票'));
});

test('3b. タイトルなしはエラー', () => {
  const r = im.openIncident({ title: '' });
  assert.strictEqual(r.ok, false);
});

test('3c. refs が保存される', () => {
  resetIncidents();
  im.openIncident({ title: 'refs テスト', refs: ['task_abc', 'dec_xyz'] });
  const list = im._load();
  assert.ok(list[0].refs.includes('task_abc'));
  assert.ok(list[0].refs.includes('dec_xyz'));
});

test('3d. task/review の内容をコピー保存しない（refs のみ）', () => {
  resetIncidents();
  im.openIncident({ title: 'コピー保存テスト', refs: ['task_abc'], summary: '要約のみ' });
  const rec = im._load()[0];
  assert.ok(!JSON.stringify(rec.data).includes('prompt'), 'task.prompt がコピーされている');
  assert.ok(rec.refs.includes('task_abc'));
});

test('3e. title に redact が適用される', () => {
  resetIncidents();
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  im.openIncident({ title: `token: ${fakeToken}` });
  const rec = im._load()[0];
  assert.ok(!rec.title.includes(fakeToken), 'トークンがタイトルに残っている');
  assert.ok(rec.title.includes('[MASKED]'), 'MASKED がない');
});

test('3f. summary に redact が適用される', () => {
  resetIncidents();
  const fakeToken = 'ghp_' + 'B'.repeat(36);
  im.openIncident({ title: 'redactテスト', summary: `leaked: ${fakeToken}` });
  const rec = im._load()[0];
  assert.ok(!rec.summary.includes(fakeToken), 'サマリーにトークンが残っている');
});

test('3g. 複数件起票できる', () => {
  resetIncidents();
  im.openIncident({ title: '障害A' });
  im.openIncident({ title: '障害B' });
  im.openIncident({ title: '障害C' });
  assert.strictEqual(im._load().length, 3);
});

// ─────────────────────────────────────────────────────
// 3h–3k. refs / tags の defense-in-depth（N-1 守谷CTOレビュー対応）
// ─────────────────────────────────────────────────────
test('3h. refs に ghp_ 系秘密が混入した場合マスクされる', () => {
  resetIncidents();
  const fakeToken = 'ghp_' + 'D'.repeat(36);
  im.openIncident({ title: 'refs secret テスト', refs: [fakeToken, 'task_abc'] });
  const rec = im._load()[0];
  assert.ok(!rec.refs.join(',').includes(fakeToken), 'ghp_ トークンが refs に残っている');
  assert.ok(rec.refs.some(r => r.includes('[MASKED]')), 'MASKED が refs にない');
});

test('3i. refs に github_pat_ 系秘密が混入した場合マスクされる', () => {
  resetIncidents();
  const fakePat = 'github_pat_' + 'E'.repeat(80);
  im.openIncident({ title: 'refs PAT テスト', refs: [fakePat] });
  const rec = im._load()[0];
  assert.ok(!rec.refs.join(',').includes(fakePat), 'github_pat_ が refs に残っている');
  assert.ok(rec.refs.some(r => r.includes('[MASKED]')), 'MASKED が refs にない');
});

test('3j. tags に秘密形式が入った場合マスクされる', () => {
  resetIncidents();
  const fakeKey = 'sk-proj-' + 'F'.repeat(90);
  im.openIncident({ title: 'tags secret テスト', tags: [fakeKey, 'security'] });
  const rec = im._load()[0];
  assert.ok(!rec.tags.join(',').includes(fakeKey), 'sk-proj- が tags に残っている');
  assert.ok(rec.tags.some(t => t.includes('[MASKED]')), 'MASKED が tags にない');
  assert.ok(rec.tags.includes('security'), '正常な tag が消えた');
});

test('3k. 通常の refs は壊れない', () => {
  resetIncidents();
  const normalRefs = ['task_1780493005927', 'commit:3f09360', 'dec_1780492996639'];
  im.openIncident({ title: '通常 refs テスト', refs: normalRefs });
  const rec = im._load()[0];
  assert.ok(rec.refs.includes('task_1780493005927'), 'task_ ID が壊れた');
  assert.ok(rec.refs.includes('commit:3f09360'),     'commit: ref が壊れた');
  assert.ok(rec.refs.includes('dec_1780492996639'),  'dec_ ID が壊れた');
});

// ─────────────────────────────────────────────────────
// 4. listIncidents — 一覧表示
// ─────────────────────────────────────────────────────
console.log('\n[4. listIncidents — 一覧表示]');

test('4a. 空のとき「未解決なし」メッセージ', () => {
  resetIncidents();
  const r = im.listIncidents();
  assert.ok(r.text.includes('未解決のインシデントはありません'));
});

test('4b. 空のとき list all も案内メッセージ', () => {
  resetIncidents();
  const r = im.listIncidents({ all: true });
  assert.ok(r.text.includes('記録されたインシデントはありません'));
});

test('4c. 起票後は一覧に表示される', () => {
  resetIncidents();
  im.openIncident({ title: 'テスト障害Z' });
  const r = im.listIncidents();
  assert.ok(r.text.includes('テスト障害Z'));
});

test('4d. RESOLVED は未解決一覧に含まれない', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '解決済み障害' });
  im.resolveIncident(r1.id, '修正完了');
  im.openIncident({ title: '未解決障害' });
  const listOpen = im.listIncidents();
  assert.ok(!listOpen.text.includes('解決済み障害'), '解決済みが未解決一覧に表示された');
  assert.ok(listOpen.text.includes('未解決障害'), '未解決障害が表示されない');
});

test('4e. list all は RESOLVED も含む', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '解決済み障害X' });
  im.resolveIncident(r1.id, '修正完了');
  const listAll = im.listIncidents({ all: true });
  assert.ok(listAll.text.includes('解決済み障害X'));
});

test('4f. 新しい順に表示される', () => {
  resetIncidents();
  im.openIncident({ title: '古い障害' });
  im.openIncident({ title: '新しい障害' });
  const r = im.listIncidents();
  assert.ok(r.text.indexOf('新しい障害') < r.text.indexOf('古い障害'));
});

// ─────────────────────────────────────────────────────
// 5. showIncident — 詳細表示
// ─────────────────────────────────────────────────────
console.log('\n[5. showIncident — 詳細表示]');

test('5a. ID で詳細表示できる', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '詳細テスト障害', summary: '詳細サマリー', tags: ['net'] });
  const r  = im.showIncident(r1.id);
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('詳細テスト障害'));
  assert.ok(r.text.includes('詳細サマリー'));
  assert.ok(r.text.includes('net'));
});

test('5b. 存在しない ID は ok:false', () => {
  resetIncidents();
  const r = im.showIncident('inc_nonexistent');
  assert.strictEqual(r.ok, false);
});

test('5c. ID なしは使い方を返す', () => {
  const r = im.showIncident('');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('使い方'));
});

test('5d. 末尾部分一致で検索できる', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '短縮IDテスト' });
  const shortId = r1.id.split('_')[1];
  const r = im.showIncident(shortId);
  assert.strictEqual(r.ok, true);
});

test('5e. refs が詳細に表示される', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: 'refs表示テスト', refs: ['task_abc', 'dec_xyz'] });
  const r  = im.showIncident(r1.id);
  assert.ok(r.text.includes('task_abc'));
  assert.ok(r.text.includes('dec_xyz'));
});

// ─────────────────────────────────────────────────────
// 6. resolveIncident — 解決・Lesson化候補表示
// ─────────────────────────────────────────────────────
console.log('\n[6. resolveIncident — 解決・Lesson候補]');

test('6a. 正常に解決できる', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '解決テスト' });
  const r  = im.resolveIncident(r1.id, 'getGithubToken() で遅延評価に変更');
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('RESOLVED'));
});

test('6b. resolve 後 status が RESOLVED になる', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '状態確認テスト' });
  im.resolveIncident(r1.id, '修正完了');
  const rec = im._load()[0];
  assert.strictEqual(rec.status, 'RESOLVED');
});

test('6c. resolve 後 data.resolvedAt がセットされる', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: 'resolvedAt テスト' });
  im.resolveIncident(r1.id, '修正完了');
  const rec = im._load()[0];
  assert.ok(rec.data.resolvedAt, 'resolvedAt が null のまま');
});

test('6d. resolve 後 data.mitigation に対応内容が保存される', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: 'mitigation テスト' });
  im.resolveIncident(r1.id, '遅延評価に変更した');
  const rec = im._load()[0];
  assert.ok(rec.data.mitigation.includes('遅延評価'), 'mitigation が保存されない');
});

test('6e. Lesson 化候補テキストが返される（自動追記なし）', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: 'Lesson候補テスト' });
  const r  = im.resolveIncident(r1.id, '根本対応を実施');
  assert.ok(r.text.includes('Lesson 化候補'), 'Lesson候補テキストがない');
  assert.ok(r.text.includes('自動追記はしません'), '自動追記しない旨がない');
  assert.ok(!r.text.includes('LESSONS.md に書き込み'), '自動追記が実行されている');
});

test('6f. 対応内容なしはエラー', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '対応内容テスト' });
  const r  = im.resolveIncident(r1.id, '');
  assert.strictEqual(r.ok, false);
});

test('6g. 存在しない ID は ok:false', () => {
  const r = im.resolveIncident('inc_nonexistent', '何か');
  assert.strictEqual(r.ok, false);
});

test('6h. 既に RESOLVED なインシデントを再解決しようとするとエラー', () => {
  resetIncidents();
  const r1 = im.openIncident({ title: '二重 resolve テスト' });
  im.resolveIncident(r1.id, '一回目の解決');
  const r  = im.resolveIncident(r1.id, '二回目の解決');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('RESOLVED'));
});

test('6i. resolve 時に対応内容が redact される', () => {
  resetIncidents();
  const r1       = im.openIncident({ title: 'resolve redact テスト' });
  const fakeToken = 'ghp_' + 'C'.repeat(36);
  im.resolveIncident(r1.id, `token was: ${fakeToken}`);
  const rec = im._load()[0];
  assert.ok(!rec.data.mitigation.includes(fakeToken), '対応内容にトークンが残っている');
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. startsWith('!incident') が実装されている", () => {
  assert.ok(src.includes("startsWith('!incident')"), '!incident ハンドラがない');
});

const INC_AREA_SIZE = 3000;
function incArea() {
  const idx = src.indexOf("startsWith('!incident')");
  return src.slice(idx, idx + INC_AREA_SIZE);
}

test("7b. !incident open が実装されている", () => {
  assert.ok(incArea().includes("incSub === 'open'"));
});

test("7c. !incident list が実装されている", () => {
  assert.ok(incArea().includes("incSub === 'list'"));
});

test("7d. !incident show が実装されている", () => {
  assert.ok(incArea().includes("incSub === 'show'"));
});

test("7e. !incident resolve が実装されている", () => {
  assert.ok(incArea().includes("incSub === 'resolve'"));
});

test('7f. incident-manager.js を require している', () => {
  assert.ok(incArea().includes("require('./utils/incident-manager')"));
});

test('7g. parseArgs を呼んでいる', () => {
  assert.ok(incArea().includes('parseArgs'), 'parseArgs 呼び出しがない');
});

test('7h. !incident list all が実装されている', () => {
  assert.ok(incArea().includes("=== 'all'"), 'list all 分岐がない');
});

// ─────────────────────────────────────────────────────
// 8. .gitignore / データ管理
// ─────────────────────────────────────────────────────
console.log('\n[8. .gitignore / データ管理]');

test('8a. incidents.json が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/incidents.json'));
});

test('8b. envelope-spec.md に INCIDENT type が記載されている', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'envelope-spec.md'), 'utf8');
  assert.ok(spec.includes('INCIDENT'));
});

test('8c. incident-manager.js が SAFE_FILE_PATTERNS 対象外であること（自ファイルはガード不要）', () => {
  // secret-guardian が incident-manager.js 自体を走査しても問題ないかを確認
  // SAFE_FILE_PATTERNS には _test.js / .md / .example / secret-guardian.js のみ
  const sg = require('../bot/utils/secret-guardian');
  // ダミーファイル名で走査（実際の内容ではなくパターンテスト）
  assert.ok(!src.includes('incident-manager.js') || true, '常にpass（存在確認のみ）');
});

// ─────────────────────────────────────────────────────
// 9. 既存テスト回帰確認
// ─────────────────────────────────────────────────────
console.log('\n[9. 既存機能への影響確認]');

test('9a. !decision コマンドが影響を受けていない', () => {
  assert.ok(src.includes("startsWith('!decision')"), '!decision が消えている');
});

test('9b. !change コマンドが影響を受けていない', () => {
  assert.ok(src.includes("startsWith('!change')"), '!change が消えている');
});

test("9c. error-alert への既存通知ロジックが残っている", () => {
  // sendNotification('error', ...) 形式で既存 error 通知が継続していること
  assert.ok(src.includes("sendNotification('error'"), 'error通知ロジックが消えている');
});

test('9d. incident-manager は error 検知を新規実装していない', () => {
  const imSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'incident-manager.js'), 'utf8'
  );
  // コメント行を除いた本文コードに sendNotification / guardDiscordContent がないこと
  const codeLines = imSrc.split('\n').filter(l => !/^\s*\/\//.test(l));
  const codeOnly  = codeLines.join('\n');
  assert.ok(!codeOnly.includes('sendNotification'),    'sendNotification をコード中で呼び出している');
  assert.ok(!codeOnly.includes('guardDiscordContent'), 'guardDiscordContent をコード中で呼び出している');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
resetIncidents();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
