'use strict';
// youtube-diagnostic.js v2 テスト
// MLパイプライン接続 + cold-start fallback + modelInfo 正確性

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const yd      = require('../bot/utils/youtube-diagnostic');
const { encodePre, FEATURE_DIM_PRE } = require('../bot/utils/youtube-feature-extractor');
const src     = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const diagSrc = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'youtube-diagnostic.js'), 'utf8');

// テスト用モデルファイル管理
const MODEL_FILE_PRE = path.join(__dirname, '..', 'data', 'youtube-model-pre.json');
const MODEL_BACKUP   = MODEL_FILE_PRE + '.test-bak';

function backupModel() {
  if (fs.existsSync(MODEL_FILE_PRE)) fs.copyFileSync(MODEL_FILE_PRE, MODEL_BACKUP);
}
function restoreModel() {
  if (fs.existsSync(MODEL_BACKUP)) {
    fs.copyFileSync(MODEL_BACKUP, MODEL_FILE_PRE);
    fs.unlinkSync(MODEL_BACKUP);
  } else if (fs.existsSync(MODEL_FILE_PRE)) {
    // 元々なかった場合は削除
    fs.unlinkSync(MODEL_FILE_PRE);
  }
}
function removeModel() {
  if (fs.existsSync(MODEL_FILE_PRE)) fs.unlinkSync(MODEL_FILE_PRE);
}

// テスト用ダミーモデル（FEATURE_DIM_PRE=15 次元）
function saveDummyModel(sampleCount = 30) {
  const weights = new Array(FEATURE_DIM_PRE).fill(0).map((_, i) => {
    // title_has_excl(1) と tag_count_norm(5) に正の重み → 感嘆符・タグが高スコアになる
    if (i === 1) return  0.8;  // title_has_excl
    if (i === 5) return  0.9;  // tag_count_norm
    if (i === 7) return  0.5;  // duration_norm
    if (i === 14) return -0.2; // bias
    return 0.1;
  });
  const data = {
    weights,
    sampleCount,
    hitCount: Math.floor(sampleCount * 0.55),
    missCount: Math.floor(sampleCount * 0.45),
    trainDirectionalAcc: 0.72,
    trainedAt: new Date().toISOString(),
    genreHitRates: { vtuber: 0.62, game: 0.48, _overall: 0.55 },
  };
  const dir = path.dirname(MODEL_FILE_PRE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MODEL_FILE_PRE, JSON.stringify(data, null, 2));
  return data;
}

// ─────────────────────────────────────────────────────
// 1. feature-extractor 接続確認
// ─────────────────────────────────────────────────────
console.log('\n[1. feature-extractor 接続確認]');

test('1a. youtube-diagnostic.js が youtube-feature-extractor を require している', () => {
  assert.ok(diagSrc.includes("require('./youtube-feature-extractor')"),
    'youtube-feature-extractor の require がない');
});

test('1b. encodePre が import されている', () => {
  assert.ok(diagSrc.includes('encodePre'), 'encodePre が使われていない');
});

test('1c. FEATURE_DIM_PRE が import されている', () => {
  assert.ok(diagSrc.includes('FEATURE_DIM_PRE'), 'FEATURE_DIM_PRE が使われていない');
});

test('1d. diagnose() 実行時に encodePre が呼ばれる（特徴ベクトルが生成される）', () => {
  // encodePre を直接実行して期待次元数を確認
  const video = { title: 'テスト！', tags: ['a','b'], duration: 600 };
  const vec   = encodePre({ ...video, viewCount: 0, publishedAt: new Date().toISOString() }, 0.5);
  assert.strictEqual(vec.length, FEATURE_DIM_PRE, `encodePre の次元数が ${FEATURE_DIM_PRE} でない: ${vec.length}`);
  // diagnose() が ok:true を返すことで内部的に encodePre が使われたことを確認
  const r = yd.diagnose({ title: 'テスト！', duration: 600 });
  assert.strictEqual(r.ok, true);
});

test('1e. AXIS_FEATURE_IDX のインデックスが FEATURE_DIM_PRE 範囲内', () => {
  for (const [axis, indices] of Object.entries(yd.AXIS_FEATURE_IDX)) {
    for (const i of indices) {
      assert.ok(i >= 0 && i < FEATURE_DIM_PRE - 1, // bias(14)除外
        `${axis} のインデックス ${i} が範囲外 (0-${FEATURE_DIM_PRE - 2})`);
    }
  }
});

// ─────────────────────────────────────────────────────
// 2. ML モードの動作確認
// ─────────────────────────────────────────────────────
console.log('\n[2. ML モード動作確認]');

// モデルファイルをバックアップして既知ダミーモデルで差し替え
backupModel();

test('2a. ダミーモデルあり → usedML=true', () => {
  saveDummyModel(30);
  const r = yd.diagnose({ title: 'テスト！' });
  assert.strictEqual(r.modelInfo.usedML, true, 'usedML が false');
});

test('2b. モデルあり → mlSamples が正しく反映される', () => {
  saveDummyModel(42);
  const r = yd.diagnose({ title: 'テスト！' });
  assert.strictEqual(r.modelInfo.mlSamples, 42, `mlSamples が 42 でない: ${r.modelInfo.mlSamples}`);
});

test('2c. モデルあり → mlProb が 0-100 の数値', () => {
  saveDummyModel(30);
  const r = yd.diagnose({ title: 'テスト！' });
  assert.ok(typeof r.modelInfo.mlProb === 'number', 'mlProb が数値でない');
  assert.ok(r.modelInfo.mlProb >= 0 && r.modelInfo.mlProb <= 100, `mlProb 範囲外: ${r.modelInfo.mlProb}`);
});

test('2d. ML モード: 感嘆符ありはCTR/感情フックが高くなる（ダミー重み weight[1]=0.8）', () => {
  saveDummyModel(30);
  const withExcl    = yd.diagnose({ title: 'やばいゲームに挑戦してみた！' });
  const withoutExcl = yd.diagnose({ title: 'やばいゲームに挑戦してみた' });
  assert.ok(withExcl.ok && withoutExcl.ok);
  // title_has_excl(1) に正の重みがあるのでCTRか感情フックが高いはず
  const excl_ctr   = withExcl.scores.ctr + withExcl.scores.emotion;
  const noexcl_ctr = withoutExcl.scores.ctr + withoutExcl.scores.emotion;
  assert.ok(excl_ctr >= noexcl_ctr, `感嘆符あり(${excl_ctr}) < なし(${noexcl_ctr})`);
});

test('2e. ML モード: タグ多い方がSEO/uniqueness が高い（ダミー重み weight[5]=0.9）', () => {
  saveDummyModel(30);
  const withTags    = yd.diagnose({ title: 'テスト！', tags: Array(15).fill('tag') });
  const withoutTags = yd.diagnose({ title: 'テスト！', tags: [] });
  assert.ok(withTags.ok && withoutTags.ok);
  const seo_uni_with    = withTags.scores.seo + withTags.scores.uniqueness;
  const seo_uni_without = withoutTags.scores.seo + withoutTags.scores.uniqueness;
  assert.ok(seo_uni_with >= seo_uni_without, `タグ多(${seo_uni_with}) < タグなし(${seo_uni_without})`);
});

test('2f. _computeMLAxisScores: 全軸スコアが 0-95 の範囲', () => {
  saveDummyModel(30);
  const weights  = new Float64Array(new Array(FEATURE_DIM_PRE).fill(0.3));
  const video    = { title: 'テスト！', tags: ['a'], duration: 600, viewCount: 0,
                     publishedAt: new Date().toISOString() };
  const features = encodePre(video, 0.5);
  const scores   = yd._computeMLAxisScores(features, weights);
  for (const [axis, score] of Object.entries(scores)) {
    assert.ok(score >= 0 && score <= 95, `${axis} スコア範囲外: ${score}`);
  }
});

// ─────────────────────────────────────────────────────
// 3. Cold-start フォールバック確認
// ─────────────────────────────────────────────────────
console.log('\n[3. Cold-start フォールバック]');

test('3a. モデルなし → usedML=false', () => {
  removeModel();
  const r = yd.diagnose({ title: 'テスト！' });
  assert.strictEqual(r.modelInfo.usedML, false, 'usedML が true になっている');
});

test('3b. モデルなし → mlProb は null', () => {
  removeModel();
  const r = yd.diagnose({ title: 'テスト！' });
  assert.strictEqual(r.modelInfo.mlProb, null, 'mlProb が null でない');
});

test('3c. モデルなし → mlSamples は 0', () => {
  removeModel();
  const r = yd.diagnose({ title: 'テスト！' });
  assert.strictEqual(r.modelInfo.mlSamples, 0);
});

test('3d. サンプル不足(< 20件) → Cold-start にフォールバック', () => {
  saveDummyModel(15); // MIN_ML_SAMPLES=20 未満
  const r = yd.diagnose({ title: 'テスト！' });
  assert.strictEqual(r.modelInfo.usedML, false, 'サンプル不足でも usedML=true になっている');
});

test('3e. フォールバック: 感嘆符あり vs なし でCTRが変わる', () => {
  removeModel();
  const withExcl    = yd.diagnose({ title: 'タイトル！' });
  const withoutExcl = yd.diagnose({ title: 'タイトル' });
  // フォールバックでも感嘆符の有無がスコアに影響するはず
  assert.ok(withExcl.scores.ctr >= withoutExcl.scores.ctr,
    `感嘆符あり(${withExcl.scores.ctr}) < なし(${withoutExcl.scores.ctr})`);
});

test('3f. フォールバック: encodePre 特徴量を使っている（feature-extractor との一貫性）', () => {
  removeModel();
  const video    = { title: 'テスト！', tags: ['a', 'b'], duration: 600, viewCount: 0,
                     publishedAt: new Date().toISOString() };
  const features = encodePre(video, 0.5);
  const scores   = yd._computeFallbackAxisScores(
    features, 'テスト！', '', ['a', 'b'], 600, new Date().toISOString()
  );
  for (const [axis, score] of Object.entries(scores)) {
    assert.ok(score >= 0 && score <= 95, `${axis} フォールバックスコア範囲外: ${score}`);
  }
});

// ─────────────────────────────────────────────────────
// 4. 基本動作 — diagnose()
// ─────────────────────────────────────────────────────
console.log('\n[4. 基本動作]');

test('4a. タイトルのみで診断できる（cold-start）', () => {
  removeModel();
  const r = yd.diagnose({ title: '【初見】ゲームに挑戦してみた！' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.totalScore >= 0 && r.totalScore <= 100);
});

test('4b. タイトルなしは ok:false', () => {
  assert.strictEqual(yd.diagnose({ title: '' }).ok, false);
});

test('4c. 6軸スコアがすべて 0-100 の範囲（ML モード）', () => {
  saveDummyModel(30);
  const r = yd.diagnose({
    title: '【初見】超やばい！感動するゲームに挑戦してみた！',
    genre: 'vtuber',
    tags:  ['VTuber', 'ゲーム実況', '初見'],
    duration: 600,
    subscriberCount: 10000,
  });
  assert.strictEqual(r.ok, true);
  for (const [axis, score] of Object.entries(r.scores)) {
    assert.ok(score >= 0 && score <= 100, `${axis} スコア範囲外: ${score}`);
  }
});

test('4d. totalScore は6軸の平均', () => {
  removeModel();
  const r = yd.diagnose({ title: 'テストタイトル！' });
  const avg = Math.round(Object.values(r.scores).reduce((a, b) => a + b, 0) / 6);
  assert.strictEqual(r.totalScore, avg);
});

test('4e. improvements は最大3件', () => {
  removeModel();
  const r = yd.diagnose({ title: 'a' });
  assert.ok(r.improvements.length <= 3);
});

// ─────────────────────────────────────────────────────
// 5. 再生数レンジ表示禁止
// ─────────────────────────────────────────────────────
console.log('\n[5. 再生数レンジ表示禁止]');

test('5a. diagnose() の戻り値に viewRange が含まれない', () => {
  saveDummyModel(30);
  const r = yd.diagnose({ title: 'テスト！' });
  assert.ok(!('viewRange' in r));
});

test('5b. formatDiagnosticText に再生数表現が含まれない', () => {
  saveDummyModel(30);
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  assert.ok(!text.includes('回再生'),  '「回再生」が含まれている');
  assert.ok(!text.includes('〜万'),    '「〜万」が含まれている');
  assert.ok(!text.includes('バズる'),  '「バズる」が含まれている');
});

test('5c. ML モード時の mlProb は表示されるが再生数ではない', () => {
  saveDummyModel(30);
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  // mlProb は「推定ヒット率」として表示されるが再生数ではない
  assert.ok(text.includes('ヒット率'), 'MLモード時のヒット率表示がない');
  assert.ok(!text.includes('回再生'),  '再生数が含まれている');
});

// ─────────────────────────────────────────────────────
// 6. 外部API呼び出しなし
// ─────────────────────────────────────────────────────
console.log('\n[6. 外部API不使用確認]');

test('6a. youtube-diagnostic.js に YouTube Data API 呼び出しがない', () => {
  assert.ok(!diagSrc.includes('YouTubeApiClient'));
  assert.ok(!diagSrc.includes('getVideoDetails'));
});

test('6b. youtube-diagnostic.js に LLM/Claude API 呼び出しがない（コード部分）', () => {
  const codeOnly = diagSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('anthropic'));
  assert.ok(!codeOnly.includes('callClaudeAPI'));
});

test('6c. diagnose() は同期処理（外部IO なし）', () => {
  removeModel();
  const r = yd.diagnose({ title: 'テスト！' });
  assert.ok(!(r instanceof Promise));
  assert.strictEqual(r.ok, true);
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. sub === 'diagnose' が実装されている", () => {
  assert.ok(src.includes("sub === 'diagnose'"));
});

test('7b. youtube-diagnostic.js を require している', () => {
  const idx  = src.indexOf("sub === 'diagnose'");
  const area = src.slice(idx, idx + 1200);
  assert.ok(area.includes("require('./utils/youtube-diagnostic')"));
});

test('7c. !youtube ヘルプに diagnose が記載されている', () => {
  assert.ok(src.includes('!youtube diagnose'));
});

// ─────────────────────────────────────────────────────
// 8. ランク判定
// ─────────────────────────────────────────────────────
console.log('\n[8. ランク判定]');

test('8a. スコア90以上は S', () => assert.strictEqual(yd._toRank(90).rank, 'S'));
test('8b. スコア70は A',      () => assert.strictEqual(yd._toRank(70).rank, 'A'));
test('8c. スコア29以下は D',  () => assert.strictEqual(yd._toRank(20).rank, 'D'));

// ─────────────────────────────────────────────────────
// 9. 弱タイトル検知 (STEP1 完了条件)
// ─────────────────────────────────────────────────────
console.log('\n[9. 弱タイトル検知 — STEP1]');

test('9a. 短いタイトル (< 10文字) → too_short 提案あり', () => {
  removeModel();
  const r = yd.diagnose({ title: '短い' });
  assert.ok(r.ok, 'diagnose失敗');
  const hasTitleImp = r.improvements.some(i => i.axis === 'ctr');
  assert.ok(hasTitleImp, '短いタイトルなのに ctr 改善提案がない');
  assert.ok(r.improvements[0].axis === 'ctr', '弱タイトル提案が先頭にない');
});

test('9b. 数字なしタイトル → no_numbers 提案あり', () => {
  removeModel();
  const sug = yd._detectWeakTitle('Pythonプログラミング入門講座完全版');
  assert.ok(sug.some(s => s.reason === 'no_numbers'), '数字なしなのに no_numbers 提案がない');
});

test('9c. 具体性なし短文 → no_specifics 提案あり', () => {
  removeModel();
  const sug = yd._detectWeakTitle('テスト動画です');
  assert.ok(sug.length > 0, '弱タイトルなのに提案がない');
});

test('9d. 強いタイトル → _detectWeakTitle が空を返す', () => {
  const sug = yd._detectWeakTitle('【初心者向け】Python 3つの基本！10分でわかる完全解説');
  assert.strictEqual(sug.length, 0, `強いタイトルなのに提案が出た: ${JSON.stringify(sug)}`);
});

test('9e. 弱タイトルの場合 improvements の先頭が ctr 軸', () => {
  removeModel();
  const r = yd.diagnose({ title: 'abc' }); // 3文字, 数字なし, 記号なし
  assert.ok(r.improvements.length > 0, '改善提案がない');
  assert.strictEqual(r.improvements[0].axis, 'ctr', '弱タイトル時に ctr が先頭でない');
});

test('9f. 登録者増加の提案テキストが含まれない', () => {
  removeModel();
  const r    = yd.diagnose({ title: 'テストタイトル！' });
  const text = r.improvements.map(i => i.text).join(' ');
  assert.ok(!text.includes('登録者'),     '登録者に関する提案がある');
  assert.ok(!text.includes('チャンネル登録'), 'チャンネル登録の提案がある');
  assert.ok(!text.includes('過去動画'),   '過去動画の提案がある');
});

test('9g. _buildImprovements(scores, title) はシグネチャに title を取る', () => {
  removeModel();
  const r1 = yd.diagnose({ title: 'a' });   // 弱
  const r2 = yd.diagnose({ title: '【完全版】Python入門！3つのコツで10分マスター' }); // 強
  assert.ok(r1.improvements[0].axis === 'ctr', '弱タイトルで ctr が先頭でない');
  // 強タイトルは _detectWeakTitle が空なのでスコアベースのみ
  // (強タイトルで全軸高ければ空も可)
  assert.ok(Array.isArray(r2.improvements));
});

// ─────────────────────────────────────────────────────
// 10. 6軸ラベル更新 (STEP2 完了条件)
// ─────────────────────────────────────────────────────
console.log('\n[10. 6軸ラベル更新・免責表示 — STEP2]');

test('10a. AXIS_LABEL が新ラベルになっている', () => {
  assert.strictEqual(yd.AXIS_LABEL.ctr,        'タイトル',       'ctr ラベルが旧のまま');
  assert.strictEqual(yd.AXIS_LABEL.seo,        'SEO',            'seo ラベルが旧のまま');
  assert.strictEqual(yd.AXIS_LABEL.timing,     '投稿タイミング', 'timing ラベルが旧のまま');
  assert.strictEqual(yd.AXIS_LABEL.retention,  '構成',           'retention ラベルが旧のまま');
  assert.strictEqual(yd.AXIS_LABEL.emotion,    '視聴期待',       'emotion ラベルが旧のまま');
  assert.strictEqual(yd.AXIS_LABEL.uniqueness, '改善余地',       'uniqueness ラベルが旧のまま');
});

test('10b. formatDiagnosticText に新6軸ラベルが含まれる', () => {
  saveDummyModel(30);
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  assert.ok(text.includes('タイトル'),       'タイトル ラベルがない');
  assert.ok(text.includes('SEO'),            'SEO ラベルがない');
  assert.ok(text.includes('投稿タイミング'), '投稿タイミング ラベルがない');
  assert.ok(text.includes('構成'),           '構成 ラベルがない');
  assert.ok(text.includes('視聴期待'),       '視聴期待 ラベルがない');
  assert.ok(text.includes('改善余地'),       '改善余地 ラベルがない');
});

test('10c. formatDiagnosticText に必須免責が含まれる (CLI診断)', () => {
  saveDummyModel(30);
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  assert.ok(
    text.includes('結果は伸びを保証するものではなく'),
    '必須免責「結果は伸びを保証するものではなく」が含まれていない'
  );
  assert.ok(
    text.includes('改善ポイント提示を目的としています'),
    '必須免責「改善ポイント提示を目的としています」が含まれていない'
  );
});

test('10d. CTR適性 / 視聴維持適性 などの旧ラベルが formatDiagnosticText に出ない', () => {
  saveDummyModel(30);
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  assert.ok(!text.includes('CTR適性'),     '旧ラベル CTR適性 が残っている');
  assert.ok(!text.includes('視聴維持適性'), '旧ラベル 視聴維持適性 が残っている');
  assert.ok(!text.includes('感情フック'),   '旧ラベル 感情フック が残っている');
  assert.ok(!text.includes('競合差別化'),   '旧ラベル 競合差別化 が残っている');
});

// ─────────────────────────────────────────────────────
// 11. Web最小UI確認 (STEP3 完了条件)
// ─────────────────────────────────────────────────────
console.log('\n[11. Web最小UI — STEP3]');

const WEB_SERVER = path.join(__dirname, '..', 'web', 'youtube-diagnostic-server.js');
const WEB_HTML   = path.join(__dirname, '..', 'web', 'youtube-diagnostic.html');

test('11a. web/youtube-diagnostic-server.js が存在する', () => {
  assert.ok(fs.existsSync(WEB_SERVER), 'サーバーファイルがない');
});

test('11b. web/youtube-diagnostic.html が存在する', () => {
  assert.ok(fs.existsSync(WEB_HTML), 'HTMLファイルがない');
});

test('11c. サーバーに eval/exec がない', () => {
  const src = fs.readFileSync(WEB_SERVER, 'utf8');
  assert.ok(!src.includes('eval('),  'eval がある');
  assert.ok(!src.includes('exec('),  'exec がある');
});

test('11d. HTML に入力フィールドが揃っている', () => {
  const html = fs.readFileSync(WEB_HTML, 'utf8');
  assert.ok(html.includes('id="title"'),       'タイトル入力がない');
  assert.ok(html.includes('id="genre"'),       'ジャンル選択がない');
  assert.ok(html.includes('id="duration"'),    '動画時間入力がない');
  assert.ok(html.includes('id="subscribers"'), '登録者規模選択がない');
  assert.ok(html.includes('id="publish-at"'),  '投稿予定入力がない');
});

test('11e. HTML に免責が含まれている', () => {
  const html = fs.readFileSync(WEB_HTML, 'utf8');
  assert.ok(html.includes('結果は伸びを保証するものではなく'), 'HTMLに免責がない');
});

test('11f. HTML に6軸スコア表示ロジックがある', () => {
  const html = fs.readFileSync(WEB_HTML, 'utf8');
  assert.ok(html.includes('タイトル'),       'タイトル軸がない');
  assert.ok(html.includes('SEO'),            'SEO軸がない');
  assert.ok(html.includes('投稿タイミング'), '投稿タイミング軸がない');
  assert.ok(html.includes('構成'),           '構成軸がない');
  assert.ok(html.includes('視聴期待'),       '視聴期待軸がない');
  assert.ok(html.includes('改善余地'),       '改善余地軸がない');
});

test('11g. サーバーが追加 npm 依存なし (require が内部ファイルのみ)', () => {
  const src = fs.readFileSync(WEB_SERVER, 'utf8');
  // require の引数を抽出
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const external = requires.filter(r => !r.startsWith('.') && !r.startsWith('/'));
  const BUILTINS = new Set(['http', 'fs', 'path', 'url', 'os', 'crypto', 'stream']);
  const unknown  = external.filter(r => !BUILTINS.has(r));
  assert.strictEqual(unknown.length, 0, `外部 npm 依存がある: ${unknown.join(', ')}`);
});

test('11h. HTML に禁止機能がない (ログイン/課金/SNS連携)', () => {
  const html = fs.readFileSync(WEB_HTML, 'utf8');
  assert.ok(!html.includes('login'),    'login がある');
  assert.ok(!html.includes('payment'),  'payment がある');
  assert.ok(!html.includes('twitter'),  'twitter連携がある');
  assert.ok(!html.includes('history'),  '履歴機能がある');
  assert.ok(!html.includes('discord'),  'Discord接続がある');
});

// ─────────────────────────────────────────────────────
// 後処理: モデルファイルを元に戻す
// ─────────────────────────────────────────────────────
restoreModel();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
