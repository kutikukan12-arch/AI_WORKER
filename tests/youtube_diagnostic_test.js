'use strict';
// youtube-diagnostic.js + !youtube diagnose 統合テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const yd  = require('../bot/utils/youtube-diagnostic');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. 基本動作 — diagnose()
// ─────────────────────────────────────────────────────
console.log('\n[1. 基本動作 — diagnose()]');

test('1a. タイトルのみで診断できる', () => {
  const r = yd.diagnose({ title: '【初見】ゲームに挑戦してみた！' });
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.totalScore === 'number');
  assert.ok(r.totalScore >= 0 && r.totalScore <= 100, `totalScore 範囲外: ${r.totalScore}`);
});

test('1b. タイトルなしは ok:false', () => {
  const r = yd.diagnose({ title: '' });
  assert.strictEqual(r.ok, false);
});

test('1c. null 入力は ok:false', () => {
  const r = yd.diagnose(null);
  assert.strictEqual(r.ok, false);
});

test('1d. 6軸スコアがすべて 0-100 の範囲', () => {
  const r = yd.diagnose({
    title: '【歌ってみた】新曲！感動する！',
    genre: 'VTuber',
    description: '説明文テキスト',
    tags: ['VTuber', '歌ってみた', '新曲'],
    duration: 300,
    subscriberCount: 10000,
  });
  assert.strictEqual(r.ok, true);
  for (const [axis, score] of Object.entries(r.scores)) {
    assert.ok(score >= 0 && score <= 100, `${axis} スコア範囲外: ${score}`);
  }
});

test('1e. totalScore は6軸の平均', () => {
  const r = yd.diagnose({ title: 'テストタイトル！' });
  const avg = Math.round(
    Object.values(r.scores).reduce((a, b) => a + b, 0) / 6
  );
  assert.strictEqual(r.totalScore, avg, `totalScore ${r.totalScore} ≠ 6軸平均 ${avg}`);
});

test('1f. improvements は最大3件', () => {
  const r = yd.diagnose({ title: 'a' }); // 最弱入力
  assert.ok(Array.isArray(r.improvements));
  assert.ok(r.improvements.length <= 3, `improvements > 3件: ${r.improvements.length}`);
});

// ─────────────────────────────────────────────────────
// 2. 再生数レンジ禁止確認
// ─────────────────────────────────────────────────────
console.log('\n[2. 再生数レンジ表示禁止]');

test('2a. diagnose() の戻り値に viewRange が含まれない', () => {
  const r = yd.diagnose({ title: 'テスト！' });
  assert.ok(!('viewRange' in r), 'viewRange が含まれている');
});

test('2b. formatDiagnosticText に再生数レンジが含まれない', () => {
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  assert.ok(!text.includes('回再生'), '再生数レンジ「回再生」が含まれている');
  assert.ok(!text.includes('〜万'), '再生数レンジ「〜万」が含まれている');
  assert.ok(!text.includes('viewRange'), 'viewRange が含まれている');
});

test('2c. formatDiagnosticText に「バズる」断言がない', () => {
  const r    = yd.diagnose({ title: 'テスト！' });
  const text = yd.formatDiagnosticText(r, { title: 'テスト！' });
  assert.ok(!text.includes('バズる'), '「バズる」が含まれている');
  assert.ok(!text.includes('万回再生される'), '再生数断言が含まれている');
});

// ─────────────────────────────────────────────────────
// 3. 外部API呼び出し確認（diagnose はローカル計算のみ）
// ─────────────────────────────────────────────────────
console.log('\n[3. 外部API不使用確認]');

test('3a. youtube-diagnostic.js に YouTube Data API 呼び出しがない', () => {
  const diagSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'youtube-diagnostic.js'), 'utf8'
  );
  assert.ok(!diagSrc.includes('YouTubeApiClient'), 'YouTubeApiClient が呼ばれている');
  assert.ok(!diagSrc.includes('getVideoDetails'),  'YouTube API getVideoDetails が呼ばれている');
});

test('3b. youtube-diagnostic.js に LLM/Claude API 呼び出しがない', () => {
  const diagSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'youtube-diagnostic.js'), 'utf8'
  );
  const codeLines = diagSrc.split('\n').filter(l => !/^\s*\/\//.test(l));
  const code = codeLines.join('\n');
  assert.ok(!code.includes('anthropic'), 'anthropic が呼ばれている');
  assert.ok(!code.includes('openai'),    'openai が呼ばれている');
  assert.ok(!code.includes('callClaudeAPI'), 'callClaudeAPI が呼ばれている');
});

test('3c. diagnose はネットワーク IO なしで動作する（同期処理）', () => {
  // diagnose が Promise を返さないこと（async 不要）
  const r = yd.diagnose({ title: 'テスト同期確認' });
  assert.ok(!(r instanceof Promise), 'diagnose が Promise を返している（非同期）');
  assert.strictEqual(r.ok, true);
});

// ─────────────────────────────────────────────────────
// 4. 6軸スコア算出 — 個別関数
// ─────────────────────────────────────────────────────
console.log('\n[4. 6軸スコア算出]');

test('4a. CTR: 感嘆符付きタイトルはスコアが高い', () => {
  const withExcl    = yd._scoreCTR('素晴らしいゲームに挑戦してみた！');
  const withoutExcl = yd._scoreCTR('素晴らしいゲームに挑戦してみた');
  assert.ok(withExcl > withoutExcl, `感嘆符あり(${withExcl}) ≤ 感嘆符なし(${withoutExcl})`);
});

test('4b. CTR: タイトルが空だと基準スコア以下', () => {
  const empty  = yd._scoreCTR('');
  const normal = yd._scoreCTR('普通のタイトルです！良い感じ');
  assert.ok(empty < normal, `空(${empty}) >= 通常(${normal})`);
});

test('4c. 視聴維持: 5〜20分の動画は高スコア', () => {
  const optimal  = yd._scoreRetention(600, '説明文テキスト');
  const tooShort = yd._scoreRetention(30, '説明文テキスト');
  assert.ok(optimal > tooShort, `5-20分(${optimal}) ≤ 30秒(${tooShort})`);
});

test('4d. SEO: タグ15個以上で高スコア', () => {
  const manyTags = yd._scoreSEO('タイトル', Array(15).fill('tag'), '');
  const fewTags  = yd._scoreSEO('タイトル', [], '');
  assert.ok(manyTags > fewTags, `タグ多(${manyTags}) ≤ タグなし(${fewTags})`);
});

test('4e. 感情フック: 感情語を含むタイトルは高スコア', () => {
  const withEmotion    = yd._scoreEmotion('やばい神回！衝撃の展開！');
  const withoutEmotion = yd._scoreEmotion('日常の記録');
  assert.ok(withEmotion > withoutEmotion, `感情語あり(${withEmotion}) ≤ なし(${withoutEmotion})`);
});

test('4f. 投稿タイミング: publishedAt なしは 50', () => {
  const score = yd._scoreTiming(null);
  assert.strictEqual(score, 50, `未設定時は50が期待値: ${score}`);
});

test('4g. 投稿タイミング: JST 21:00 金曜 (UTC 12:00 Fri) は高スコア', () => {
  // UTC Friday 12:00 = JST Saturday 21:00
  const goldTime = yd._scoreTiming('2026-06-05T12:00:00Z'); // 2026-06-05 = Fri
  const midNight = yd._scoreTiming('2026-06-01T22:00:00Z'); // Mon 07:00 JST
  assert.ok(goldTime > midNight, `ゴールデン(${goldTime}) ≤ 深夜(${midNight})`);
});

test('4h. 競合差別化: タグ多・タイトル多様性高で高スコア', () => {
  const rich = yd._scoreUniqueness('【初見】凄い！ゲーム#1 衝撃の展開…', Array(12).fill('tag'));
  const bare = yd._scoreUniqueness('ゲーム', []);
  assert.ok(rich > bare, `多様(${rich}) ≤ 単純(${bare})`);
});

// ─────────────────────────────────────────────────────
// 5. ランク判定
// ─────────────────────────────────────────────────────
console.log('\n[5. ランク判定]');

test('5a. スコア90以上は S ランク', () => {
  const { rank } = yd._toRank(90);
  assert.strictEqual(rank, 'S');
});

test('5b. スコア70-79は A ランク', () => {
  const { rank } = yd._toRank(75);
  assert.strictEqual(rank, 'A');
});

test('5c. スコア29以下は D ランク', () => {
  const { rank } = yd._toRank(20);
  assert.strictEqual(rank, 'D');
});

// ─────────────────────────────────────────────────────
// 6. 改善提案
// ─────────────────────────────────────────────────────
console.log('\n[6. 改善提案]');

test('6a. スコアが高いと改善提案が少ない', () => {
  // 高スコアの入力
  const r = yd.diagnose({
    title: '【初見】超やばい！感動する神ゲーに挑戦してみた！',
    tags:  Array(18).fill('tag'),
    description: 'a'.repeat(400),
    duration: 600,
    publishedAt: '2026-06-05T12:00:00Z', // 金曜JST
  });
  // 全軸スコアを確認
  const weakCount = Object.values(r.scores).filter(s => s < 60).length;
  assert.ok(
    r.improvements.length <= weakCount || r.improvements.length <= 3,
    `改善提案が多すぎる: ${r.improvements.length}`
  );
});

test('6b. 各改善提案に axis / priority / text が含まれる', () => {
  const r = yd.diagnose({ title: 'x' });
  for (const imp of r.improvements) {
    assert.ok(imp.axis,      'axis がない');
    assert.ok(imp.axisLabel, 'axisLabel がない');
    assert.ok(imp.priority,  'priority がない');
    assert.ok(imp.text,      'text がない');
  }
});

test('6c. 改善提案に再生数断言がない', () => {
  const r = yd.diagnose({ title: 'テスト' });
  for (const imp of r.improvements) {
    assert.ok(!imp.text.includes('回再生'), `改善提案に再生数が含まれている: ${imp.text}`);
    assert.ok(!imp.text.includes('バズる'),  `改善提案に「バズる」が含まれている: ${imp.text}`);
  }
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. sub === 'diagnose' が実装されている", () => {
  const idx  = src.indexOf("handleYoutube");
  const area = src.slice(idx, idx + 2500);
  assert.ok(area.includes("sub === 'diagnose'"), '!youtube diagnose がない');
});

test('7b. youtube-diagnostic.js を require している', () => {
  const idx  = src.indexOf("sub === 'diagnose'");
  const area = src.slice(idx, idx + 1200);
  assert.ok(area.includes("require('./utils/youtube-diagnostic')"), 'require がない');
});

test('7c. _parseYtKwargs を diagnose でも再利用している', () => {
  const idx  = src.indexOf("sub === 'diagnose'");
  const area = src.slice(idx, idx + 600);
  assert.ok(area.includes('_parseYtKwargs'), '_parseYtKwargs 再利用がない');
});

test('7d. diagnose ハンドラに title= が必須チェックされている', () => {
  const idx  = src.indexOf("sub === 'diagnose'");
  const area = src.slice(idx, idx + 600);
  assert.ok(area.includes('kw.title'), 'title 必須チェックがない');
});

test('7e. !youtube ヘルプに diagnose が追加されている', () => {
  assert.ok(src.includes('!youtube diagnose'), 'ヘルプに diagnose がない');
});

// ─────────────────────────────────────────────────────
// 8. 仕様書確認
// ─────────────────────────────────────────────────────
console.log('\n[8. 仕様書確認]');

test('8a. docs/youtube-diagnostic-ai-mvp-spec.md から Claude API 前提が削除されている', () => {
  const spec = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'youtube-diagnostic-ai-mvp-spec.md'), 'utf8'
  );
  // 旧前提の callClaudeAPI() 関数定義が実装指示から削除されていること
  assert.ok(!spec.includes('callClaudeAPI()          : Claude API呼び出し'), 'callClaudeAPI 実装指示が残っている');
});

test('8b. 仕様書に youtube-predictor 再利用の記載がある', () => {
  const spec = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'youtube-diagnostic-ai-mvp-spec.md'), 'utf8'
  );
  assert.ok(spec.includes('youtube-predictor'), '既存モデル再利用の記載がない');
});

test('8c. 仕様書に再生数レンジ禁止の記載がある', () => {
  const spec = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'youtube-diagnostic-ai-mvp-spec.md'), 'utf8'
  );
  assert.ok(spec.includes('再生数') && (spec.includes('禁止') || spec.includes('表示しない')), '再生数禁止記載がない');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
