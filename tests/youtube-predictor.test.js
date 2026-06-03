'use strict';

/**
 * YouTube 予測 AI の精度テスト
 *
 * テスト対象:
 *   1. youtube-feature-extractor.js — encode() 特徴量エンコーダ (16次元)
 *   2. youtube-predictor.js         — predict() / train() / getModelStatus() / buildSummary()
 *
 * 注意: data/youtube-model.json が存在しない環境でも動作する。
 *       train() テストは data/youtube-model.json に書き込む（副作用あり）。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const { encode, FEATURE_NAMES, FEATURE_DIM } = require('../bot/utils/youtube-feature-extractor');
const { predict, train, getModelStatus, buildSummary } = require('../bot/utils/youtube-predictor');

// ── テスト用ファクトリ ─────────────────────────────────

function makeVideo(overrides = {}) {
  return {
    videoId:         'test_video_001',
    viewCount:       10000,
    likeCount:       800,
    commentCount:    50,
    title:           'テスト動画タイトル',
    description:     '説明文テストです',
    tags:            ['tag1', 'tag2', 'tag3'],
    duration:        600,
    publishedAt:     '2024-01-15T12:00:00Z',
    subscriberCount: 1000,
    ...overrides,
  };
}

function makeSample(label, overrides = {}) {
  return { ...makeVideo(overrides), label };
}

// ─────────────────────────────────────────────────────
// encode() — youtube-feature-extractor.js
// ─────────────────────────────────────────────────────

describe('encode()', () => {

  describe('戻り値の形状', () => {
    test('Float64Array を返す', () => {
      const vec = encode(makeVideo());
      assert.ok(vec instanceof Float64Array, `型が Float64Array ではない: ${vec.constructor.name}`);
    });

    test(`次元数が FEATURE_DIM(${FEATURE_DIM}) と一致する`, () => {
      const vec = encode(makeVideo());
      assert.equal(vec.length, FEATURE_DIM);
    });

    test('全要素が有限数（NaN / Inf なし）', () => {
      const vec = encode(makeVideo());
      for (let i = 0; i < vec.length; i++) {
        assert.ok(isFinite(vec[i]), `vec[${i}](${FEATURE_NAMES[i]}) が有限数でない: ${vec[i]}`);
      }
    });
  });

  describe('ゼロ除算耐性', () => {
    test('viewCount=0 → 全要素が有限数（views=max(viewCount,1) で保護）', () => {
      const vec = encode(makeVideo({ viewCount: 0 }));
      for (let i = 0; i < vec.length; i++) {
        assert.ok(isFinite(vec[i]), `vec[${i}](${FEATURE_NAMES[i]}) が有限数でない`);
      }
    });

    test('subscriberCount=0 → エラーにならない（subs=max(subscriberCount,1) で保護）', () => {
      assert.doesNotThrow(() => encode(makeVideo({ subscriberCount: 0 })));
    });

    test('全フィールド 0 → エラーにならない', () => {
      assert.doesNotThrow(() => encode({
        viewCount: 0, likeCount: 0, commentCount: 0,
        title: '', description: '', tags: [],
        duration: 0, publishedAt: null, subscriberCount: 0,
      }));
    });
  });

  describe('like_ratio / comment_ratio のクランプ [0, 1]', () => {
    test('likes > views → like_ratio = 1.0', () => {
      const vec = encode(makeVideo({ likeCount: 99999, viewCount: 1 }));
      assert.equal(vec[0], 1.0);
    });

    test('comments * 10 > views → comment_ratio = 1.0', () => {
      const vec = encode(makeVideo({ commentCount: 99999, viewCount: 1 }));
      assert.equal(vec[1], 1.0);
    });

    test('likes=0 → like_ratio = 0.0', () => {
      const vec = encode(makeVideo({ likeCount: 0, viewCount: 10000 }));
      assert.equal(vec[0], 0.0);
    });

    test('通常値 → like_ratio が (0, 1) の範囲内', () => {
      const vec = encode(makeVideo({ likeCount: 500, viewCount: 10000 }));
      assert.ok(vec[0] > 0 && vec[0] < 1, `like_ratio=${vec[0]}`);
    });
  });

  describe('タイトル特徴量', () => {
    test('タイトル長 >= 100 → title_len_norm = 1.0', () => {
      const vec = encode(makeVideo({ title: 'あ'.repeat(100) }));
      assert.equal(vec[2], 1.0);
    });

    test('タイトル長 50 → title_len_norm = 0.5', () => {
      const vec = encode(makeVideo({ title: 'a'.repeat(50) }));
      assert.ok(Math.abs(vec[2] - 0.5) < 0.001, `title_len_norm=${vec[2]}`);
    });

    test('"!" を含む → title_has_excl = 1.0', () => {
      const vec = encode(makeVideo({ title: '衝撃！大発表' }));
      assert.equal(vec[3], 1.0);
    });

    test('"?" を含む → title_has_quest = 1.0', () => {
      const vec = encode(makeVideo({ title: 'これは本当？' }));
      assert.equal(vec[4], 1.0);
    });

    test('感嘆符・疑問符なし → 両方 0.0', () => {
      const vec = encode(makeVideo({ title: 'ふつうのタイトル' }));
      assert.equal(vec[3], 0.0);
      assert.equal(vec[4], 0.0);
    });

    test('emoji 5個以上 → title_emoji_norm = 1.0', () => {
      const vec = encode(makeVideo({ title: '🎬🎬🎬🎬🎬' }));
      assert.equal(vec[5], 1.0);
    });

    test('emoji 0個 → title_emoji_norm = 0.0', () => {
      const vec = encode(makeVideo({ title: 'emoji なしタイトル' }));
      assert.equal(vec[5], 0.0);
    });

    test('大文字単語のみ → title_caps_ratio = 1.0', () => {
      const vec = encode(makeVideo({ title: 'HELLO WORLD TEST' }));
      assert.equal(vec[6], 1.0);
    });

    test('小文字のみ → title_caps_ratio = 0.0', () => {
      const vec = encode(makeVideo({ title: 'hello world test' }));
      assert.equal(vec[6], 0.0);
    });
  });

  describe('コンテンツ特徴量のクランプ', () => {
    test('tags 30個以上 → tag_count_norm = 1.0', () => {
      const vec = encode(makeVideo({ tags: Array(30).fill('tag') }));
      assert.equal(vec[7], 1.0);
    });

    test('tags 空配列 → tag_count_norm = 0.0', () => {
      const vec = encode(makeVideo({ tags: [] }));
      assert.equal(vec[7], 0.0);
    });

    test('description 2000文字以上 → desc_len_norm = 1.0', () => {
      const vec = encode(makeVideo({ description: 'a'.repeat(2000) }));
      assert.equal(vec[8], 1.0);
    });

    test('duration 3600秒以上 → duration_norm = 1.0', () => {
      const vec = encode(makeVideo({ duration: 3600 }));
      assert.equal(vec[9], 1.0);
    });

    test('duration 0 → duration_norm = 0.0', () => {
      const vec = encode(makeVideo({ duration: 0 }));
      assert.equal(vec[9], 0.0);
    });
  });

  describe('cyclic 時刻特徴量', () => {
    test('published_hour_sin / cos が [-1, 1] の範囲', () => {
      const vec = encode(makeVideo({ publishedAt: '2024-01-15T12:00:00Z' }));
      assert.ok(vec[10] >= -1 && vec[10] <= 1, `sin=${vec[10]}`);
      assert.ok(vec[11] >= -1 && vec[11] <= 1, `cos=${vec[11]}`);
    });

    test('published_dow_sin / cos が [-1, 1] の範囲', () => {
      const vec = encode(makeVideo({ publishedAt: '2024-01-15T00:00:00Z' }));
      assert.ok(vec[12] >= -1 && vec[12] <= 1, `sin=${vec[12]}`);
      assert.ok(vec[13] >= -1 && vec[13] <= 1, `cos=${vec[13]}`);
    });

    test('publishedAt = null → エラーにならない（現在時刻フォールバック）', () => {
      assert.doesNotThrow(() => encode(makeVideo({ publishedAt: null })));
    });

    test('正午(UTC 12h) の cos はほぼ -1', () => {
      const vec = encode(makeVideo({ publishedAt: '2024-01-01T12:00:00Z' }));
      assert.ok(vec[11] < -0.9, `hour=12 のとき cos=${vec[11]} (ほぼ -1 を期待)`);
    });

    test('深夜(UTC 0h) の cos はほぼ 1', () => {
      const vec = encode(makeVideo({ publishedAt: '2024-01-01T00:00:00Z' }));
      assert.ok(vec[11] > 0.9, `hour=0 のとき cos=${vec[11]} (ほぼ 1 を期待)`);
    });
  });

  describe('sub_magnitude_norm', () => {
    test('subscriberCount が 1億 (10^8) → norm = 1.0 にクランプ', () => {
      const vec = encode(makeVideo({ subscriberCount: 100_000_000 }));
      assert.equal(vec[14], 1.0);
    });

    test('subscriberCount=10 → (0, 1) の範囲', () => {
      const vec = encode(makeVideo({ subscriberCount: 10 }));
      assert.ok(vec[14] > 0 && vec[14] < 1, `sub_magnitude_norm=${vec[14]}`);
    });

    test('subscriberCount 大 → norm が subscriberCount 小 より高い', () => {
      const small = encode(makeVideo({ subscriberCount: 1000 }));
      const large = encode(makeVideo({ subscriberCount: 1_000_000 }));
      assert.ok(large[14] > small[14], `large(${large[14]}) > small(${small[14]})`);
    });
  });

  describe('bias 項', () => {
    test('最後の要素 (index 15) が常に 1.0', () => {
      assert.equal(encode(makeVideo())[FEATURE_DIM - 1], 1.0);
    });

    test('全フィールド 0 でも bias = 1.0', () => {
      const vec = encode({ viewCount: 0, likeCount: 0, commentCount: 0, title: '', description: '', tags: [], duration: 0, publishedAt: null, subscriberCount: 0 });
      assert.equal(vec[FEATURE_DIM - 1], 1.0);
    });
  });
});

// ─────────────────────────────────────────────────────
// predict() — youtube-predictor.js
// ─────────────────────────────────────────────────────

describe('predict()', () => {

  // ML モデルファイルが存在すると probability がルールベースと異なるため、
  // predict() テスト中はファイルを退避して純粋なルールベース状態を保証する
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  describe('戻り値の構造', () => {
    test('必須フィールドを全て持つ', () => {
      const r = predict(makeVideo());
      assert.ok('probability' in r, 'probability がない');
      assert.ok('label'       in r, 'label がない');
      assert.ok('confidence'  in r, 'confidence がない');
      assert.ok('buzzRatio'   in r, 'buzzRatio がない');
      assert.ok('usedML'      in r, 'usedML がない');
      assert.ok('mlSamples'   in r, 'mlSamples がない');
    });

    test('probability は 0〜100 の整数', () => {
      const { probability } = predict(makeVideo());
      assert.ok(Number.isInteger(probability), `整数でない: ${probability}`);
      assert.ok(probability >= 0 && probability <= 100, `範囲外: ${probability}`);
    });

    test('label は hit / miss / unknown のいずれか', () => {
      const { label } = predict(makeVideo());
      assert.ok(['hit', 'miss', 'unknown'].includes(label), `不正な label: ${label}`);
    });

    test('confidence は high / medium / low のいずれか', () => {
      const { confidence } = predict(makeVideo());
      assert.ok(['high', 'medium', 'low'].includes(confidence), `不正な confidence: ${confidence}`);
    });

    test('mlSamples が 0 以上の整数', () => {
      const { mlSamples } = predict(makeVideo());
      assert.ok(Number.isInteger(mlSamples) && mlSamples >= 0, `mlSamples=${mlSamples}`);
    });

    test('usedML が boolean', () => {
      const { usedML } = predict(makeVideo());
      assert.ok(typeof usedML === 'boolean');
    });
  });

  describe('ルールベース予測: buzz_ratio によるラベル分類', () => {
    const SUBS = 1000; // subscriberCount 固定

    test('buzz_ratio >> 5.0 (ヒット圏) → label=hit, probability >= 60', () => {
      // viewCount=10000, subs=1000 → ratio=10 >> 5.0
      const r = predict(makeVideo({ viewCount: 10000, subscriberCount: SUBS }));
      assert.equal(r.label, 'hit');
      assert.ok(r.probability >= 60, `probability=${r.probability}`);
    });

    test('buzz_ratio << 0.3 (ミス圏) → label=miss, probability <= 40', () => {
      // viewCount=100, subs=1000 → ratio=0.1 << 0.3
      const r = predict(makeVideo({ viewCount: 100, subscriberCount: SUBS }));
      assert.equal(r.label, 'miss');
      assert.ok(r.probability <= 40, `probability=${r.probability}`);
    });

    test('buzz_ratio が中間 (2.65 ≈ 中点) → label=unknown, 40 < p < 60', () => {
      // MISS_THRESHOLD=0.3, HIT_THRESHOLD=5.0 の中点 = 2.65
      // score = 0.1 + (2.65-0.3)/(5.0-0.3)*0.8 = 0.5 → probability=50
      const r = predict(makeVideo({ viewCount: 2650, subscriberCount: SUBS }));
      assert.equal(r.label, 'unknown');
      assert.ok(r.probability > 40 && r.probability < 60, `probability=${r.probability}`);
    });

    test('buzz_ratio = HIT_THRESHOLD (5.0) 境界値 → probability >= 60', () => {
      const r = predict(makeVideo({ viewCount: 5000, subscriberCount: SUBS }));
      assert.ok(r.probability >= 60, `probability=${r.probability}`);
    });

    test('buzz_ratio = MISS_THRESHOLD (0.3) 境界値 → probability <= 40', () => {
      const r = predict(makeVideo({ viewCount: 300, subscriberCount: SUBS }));
      assert.ok(r.probability <= 40, `probability=${r.probability}`);
    });

    test('buzzRatio フィールドが views/subs と一致する', () => {
      const r = predict(makeVideo({ viewCount: 5000, subscriberCount: SUBS }));
      assert.ok(Math.abs(r.buzzRatio - 5000 / SUBS) < 0.001, `buzzRatio=${r.buzzRatio}`);
    });

    test('buzz_ratio が高いほど probability が高い（単調性）', () => {
      const low  = predict(makeVideo({ viewCount: 100,   subscriberCount: SUBS }));
      const mid  = predict(makeVideo({ viewCount: 1000,  subscriberCount: SUBS }));
      const high = predict(makeVideo({ viewCount: 10000, subscriberCount: SUBS }));
      assert.ok(
        low.probability <= mid.probability && mid.probability <= high.probability,
        `low(${low.probability}) <= mid(${mid.probability}) <= high(${high.probability})`
      );
    });
  });

  describe('subscriberCount=0 の場合', () => {
    test('buzzRatio = null', () => {
      assert.equal(predict(makeVideo({ subscriberCount: 0 })).buzzRatio, null);
    });

    test('probability = 50 (ルールスコア 0.5 → round(50))', () => {
      assert.equal(predict(makeVideo({ subscriberCount: 0 })).probability, 50);
    });
  });

  describe('入力の欠損・境界値耐性', () => {
    test('空オブジェクト → エラーにならない', () => {
      assert.doesNotThrow(() => predict({}));
    });

    test('全フィールド 0 → エラーにならない', () => {
      assert.doesNotThrow(() => predict({
        viewCount: 0, likeCount: 0, commentCount: 0, subscriberCount: 0,
      }));
    });

    test('probability が常に 0〜100', () => {
      const cases = [
        makeVideo({ viewCount: 1,         subscriberCount: 1 }),
        makeVideo({ viewCount: 1_000_000, subscriberCount: 100 }),
        makeVideo({ viewCount: 0,         subscriberCount: 0 }),
        makeVideo({ viewCount: 999999,    subscriberCount: 1 }),
      ];
      for (const video of cases) {
        const { probability } = predict(video);
        assert.ok(
          probability >= 0 && probability <= 100,
          `viewCount=${video.viewCount} subs=${video.subscriberCount} → probability=${probability}`
        );
      }
    });
  });
});

// ─────────────────────────────────────────────────────
// train() — youtube-predictor.js
// ─────────────────────────────────────────────────────

describe('train()', () => {

  describe('サンプル不足時 → null を返す', () => {
    test('サンプル 0 件', () => {
      assert.equal(train([]), null);
    });

    test('サンプル 9 件（10件未満）', () => {
      const samples = Array(9).fill(null).map(() => makeSample('hit'));
      assert.equal(train(samples), null);
    });

    test('無効ラベル (unknown) のみ 15 件 → フィルタ後 0 件なので null', () => {
      const samples = Array(15).fill(null).map(() => makeSample('unknown'));
      assert.equal(train(samples), null);
    });

    test('null ラベルのみ 15 件 → null', () => {
      const samples = Array(15).fill(null).map(() => makeSample(null));
      assert.equal(train(samples), null);
    });
  });

  describe('訓練成功（10件以上の有効サンプル）', () => {
    const hitSamples  = Array(7).fill(null).map(() => makeSample('hit'));
    const missSamples = Array(5).fill(null).map(() => makeSample('miss'));
    const trainData   = [...hitSamples, ...missSamples]; // 12件

    test('modelData が null でない', () => {
      const result = train(trainData);
      assert.ok(result !== null, 'null が返された');
    });

    test('必須フィールドが全て揃っている', () => {
      const result = train(trainData);
      if (!result) return;
      assert.ok('weights'     in result, 'weights がない');
      assert.ok('sampleCount' in result, 'sampleCount がない');
      assert.ok('hitCount'    in result, 'hitCount がない');
      assert.ok('missCount'   in result, 'missCount がない');
      assert.ok('trainedAt'   in result, 'trainedAt がない');
    });

    test(`weights の長さが FEATURE_DIM(${FEATURE_DIM}) と一致`, () => {
      const result = train(trainData);
      if (!result) return;
      assert.equal(result.weights.length, FEATURE_DIM);
    });

    test('sampleCount / hitCount / missCount が正確に計算される', () => {
      const result = train(trainData);
      if (!result) return;
      assert.equal(result.sampleCount, 12);
      assert.equal(result.hitCount,    7);
      assert.equal(result.missCount,   5);
    });

    test('無効ラベルが含まれる場合は自動除外される', () => {
      const mixed = [
        ...hitSamples,
        ...missSamples,
        ...Array(5).fill(null).map(() => makeSample('unknown')),
      ];
      const result = train(mixed);
      if (!result) return;
      assert.equal(result.sampleCount, 12); // unknown 5件は除外
    });

    test('全て hit サンプル 10 件 → 訓練完了、missCount=0', () => {
      const allHit = Array(10).fill(null).map(() => makeSample('hit'));
      const result = train(allHit);
      assert.ok(result !== null);
      if (!result) return;
      assert.equal(result.missCount, 0);
      assert.equal(result.hitCount,  10);
    });

    test('trainedAt が ISO8601 形式の文字列', () => {
      const result = train(trainData);
      if (!result) return;
      assert.ok(typeof result.trainedAt === 'string');
      assert.ok(!isNaN(Date.parse(result.trainedAt)), `不正な日時: ${result.trainedAt}`);
    });

    test('weights の全要素が有限数', () => {
      const result = train(trainData);
      if (!result) return;
      for (let i = 0; i < result.weights.length; i++) {
        assert.ok(isFinite(result.weights[i]), `weights[${i}] が有限数でない: ${result.weights[i]}`);
      }
    });

    test('hitCount + missCount = sampleCount', () => {
      const result = train(trainData);
      if (!result) return;
      assert.equal(result.hitCount + result.missCount, result.sampleCount);
    });
  });

  describe('訓練後の predict() 整合性', () => {
    test('train() 後も predict() が 0〜100 の probability を返す', () => {
      const samples = [
        ...Array(10).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
        ...Array(10).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
      ];
      train(samples);
      const { probability } = predict(makeVideo());
      assert.ok(probability >= 0 && probability <= 100, `probability=${probability}`);
    });
  });
});

// ─────────────────────────────────────────────────────
// getModelStatus() — youtube-predictor.js
// ─────────────────────────────────────────────────────

describe('getModelStatus()', () => {

  test('オブジェクトを返す', () => {
    const status = getModelStatus();
    assert.ok(typeof status === 'object' && status !== null);
  });

  test('trained フィールドが boolean', () => {
    const { trained } = getModelStatus();
    assert.ok(typeof trained === 'boolean', `trained が boolean でない: ${typeof trained}`);
  });

  test('sampleCount が 0 以上の整数', () => {
    const { sampleCount } = getModelStatus();
    assert.ok(Number.isInteger(sampleCount) && sampleCount >= 0, `sampleCount=${sampleCount}`);
  });

  test('trained=true の場合 hitCount / missCount / trainedAt を持つ', () => {
    const status = getModelStatus();
    if (!status.trained) return;
    assert.ok('hitCount'  in status, 'hitCount がない');
    assert.ok('missCount' in status, 'missCount がない');
    assert.ok('trainedAt' in status, 'trainedAt がない');
  });

  test('trained=true の場合 hitCount + missCount = sampleCount', () => {
    const status = getModelStatus();
    if (!status.trained) return;
    assert.equal(
      status.hitCount + status.missCount,
      status.sampleCount,
      `hit(${status.hitCount}) + miss(${status.missCount}) != total(${status.sampleCount})`
    );
  });

  test('trained=false の場合 sampleCount = 0', () => {
    const status = getModelStatus();
    if (status.trained) return;
    assert.equal(status.sampleCount, 0);
  });

  test('trained=true の場合 sampleCount > 0', () => {
    const status = getModelStatus();
    if (!status.trained) return;
    assert.ok(status.sampleCount > 0, `trained=true なのに sampleCount=${status.sampleCount}`);
  });
});

// ─────────────────────────────────────────────────────
// buildSummary() — youtube-predictor.js
// ─────────────────────────────────────────────────────

describe('buildSummary()', () => {

  test('文字列を返す', () => {
    const video  = makeVideo();
    const result = predict(video);
    assert.ok(typeof buildSummary(video, result) === 'string');
  });

  test('"YouTube ヒット予測" の見出しを含む', () => {
    const video  = makeVideo();
    const result = predict(video);
    assert.ok(buildSummary(video, result).includes('YouTube ヒット予測'));
  });

  test('確率(%) を含む', () => {
    const video  = makeVideo();
    const result = predict(video);
    assert.ok(/\d+%/.test(buildSummary(video, result)), '確率(%)が見当たらない');
  });

  test('label が含まれる', () => {
    const video  = makeVideo();
    const result = predict(video);
    assert.ok(buildSummary(video, result).includes(result.label), `label "${result.label}" が含まれない`);
  });

  test('buzzRatio が null でない場合 buzz_ratio 行を含む', () => {
    const video  = makeVideo({ subscriberCount: 1000 });
    const result = predict(video);
    if (result.buzzRatio !== null) {
      assert.ok(buildSummary(video, result).includes('buzz_ratio'));
    }
  });

  test('buzzRatio が null の場合 buzz_ratio 行がない', () => {
    const video  = makeVideo({ subscriberCount: 0 });
    const result = predict(video);
    assert.equal(result.buzzRatio, null);
    assert.ok(!buildSummary(video, result).includes('buzz_ratio'));
  });

  test('usedML=false → "ルールベース" を含む', () => {
    const video  = makeVideo();
    const result = predict(video);
    if (!result.usedML) {
      assert.ok(buildSummary(video, result).includes('ルールベース'), 'ルールベースの文字がない');
    }
  });

  test('usedML=true → "ML" を含む', () => {
    const video  = makeVideo();
    const result = predict(video);
    if (result.usedML) {
      assert.ok(buildSummary(video, result).includes('ML'), 'ML の文字がない');
    }
  });

  test('probability >= 60 → 🟢 絵文字を含む', () => {
    // buzz_ratio=100 (10000/100) → 確実に hit
    const video  = makeVideo({ viewCount: 10000, subscriberCount: 100 });
    const result = predict(video);
    if (result.probability >= 60) {
      assert.ok(buildSummary(video, result).includes('🟢'), `probability=${result.probability} なのに 🟢 がない`);
    }
  });

  test('probability <= 40 → 🔴 絵文字を含む', () => {
    // buzz_ratio=0.001 (10/10000) → 確実に miss
    const video  = makeVideo({ viewCount: 10, subscriberCount: 10000 });
    const result = predict(video);
    if (result.probability <= 40) {
      assert.ok(buildSummary(video, result).includes('🔴'), `probability=${result.probability} なのに 🔴 がない`);
    }
  });

  test('40 < probability < 60 → 🟡 絵文字を含む', () => {
    // buzz_ratio=1.0 → unknown 圏
    const video  = makeVideo({ viewCount: 1000, subscriberCount: 1000 });
    const result = predict(video);
    if (result.probability > 40 && result.probability < 60) {
      assert.ok(buildSummary(video, result).includes('🟡'), `probability=${result.probability} なのに 🟡 がない`);
    }
  });

  test('confidence 情報が文字列内に含まれる', () => {
    const video   = makeVideo();
    const result  = predict(video);
    const summary = buildSummary(video, result);
    assert.ok(summary.includes(result.confidence), `confidence "${result.confidence}" が含まれない`);
  });
});

// ─────────────────────────────────────────────────────
// encode() — 追加精度テスト
// ─────────────────────────────────────────────────────

describe('encode() — 追加精度テスト', () => {

  test('half-width "!" → title_has_excl = 1.0', () => {
    const vec = encode(makeVideo({ title: 'Breaking News!' }));
    assert.equal(vec[3], 1.0);
  });

  test('half-width "?" → title_has_quest = 1.0', () => {
    const vec = encode(makeVideo({ title: 'Is this true?' }));
    assert.equal(vec[4], 1.0);
  });

  test('tags が null → エラーにならない（空配列フォールバック）', () => {
    assert.doesNotThrow(() => encode(makeVideo({ tags: null })));
  });

  test('description が null → エラーにならない', () => {
    assert.doesNotThrow(() => encode(makeVideo({ description: null })));
  });

  test('videoId が異なる同一動画 → encode 結果は同一（videoId は特徴量に含まれない）', () => {
    const e1 = encode(makeVideo({ videoId: 'aaa' }));
    const e2 = encode(makeVideo({ videoId: 'bbb' }));
    for (let i = 0; i < e1.length; i++) {
      assert.equal(e1[i], e2[i], `vec[${i}](${FEATURE_NAMES[i]}) が異なる`);
    }
  });

  test('emoji 2個 → title_emoji_norm = 0.4', () => {
    const vec = encode(makeVideo({ title: '🎬🎬 テスト' }));
    assert.ok(Math.abs(vec[5] - 0.4) < 0.001, `title_emoji_norm=${vec[5]} (期待: 0.4)`);
  });

  test('tags 15個 → tag_count_norm = 0.5', () => {
    const vec = encode(makeVideo({ tags: Array(15).fill('tag') }));
    assert.ok(Math.abs(vec[7] - 0.5) < 0.001, `tag_count_norm=${vec[7]} (期待: 0.5)`);
  });

  test('duration 1800秒 → duration_norm = 0.5', () => {
    const vec = encode(makeVideo({ duration: 1800 }));
    assert.ok(Math.abs(vec[9] - 0.5) < 0.001, `duration_norm=${vec[9]} (期待: 0.5)`);
  });
});

// ─────────────────────────────────────────────────────
// predict() — ルールベース確率の精密検証
// ─────────────────────────────────────────────────────

describe('predict() — ルールベース確率の精密検証', () => {
  // ML モデルなし状態を保証
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak3';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('buzz_ratio >= HIT_THRESHOLD(5.0) → probability = 90 (score=0.9)', () => {
    // viewCount=5000, subs=1000 → ratio=5.0 >= 5.0 → score=0.9
    const { probability } = predict(makeVideo({ viewCount: 5000, subscriberCount: 1000 }));
    assert.equal(probability, 90, `probability=${probability} (期待: 90)`);
  });

  test('buzz_ratio <= MISS_THRESHOLD(0.3) → probability = 10 (score=0.1)', () => {
    // viewCount=300, subs=1000 → ratio=0.3 <= 0.3 → score=0.1
    const { probability } = predict(makeVideo({ viewCount: 300, subscriberCount: 1000 }));
    assert.equal(probability, 10, `probability=${probability} (期待: 10)`);
  });

  test('buzz_ratio = 2.65 (線形補間中点) → probability = 50', () => {
    // score = 0.1 + (2.65-0.3)/(5.0-0.3)*0.8 = 0.1 + 2.35/4.7*0.8 = 0.1 + 0.4 = 0.5
    const { probability } = predict(makeVideo({ viewCount: 2650, subscriberCount: 1000 }));
    assert.equal(probability, 50, `probability=${probability} (期待: 50)`);
  });
});

// ─────────────────────────────────────────────────────
// predict() — ML 混合精度テスト
// ─────────────────────────────────────────────────────

describe('predict() — ML 混合精度', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak4';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('10件訓練済み (MIN_ML_SAMPLES=20 未満) → usedML=false', () => {
    // train() は 10件で成功するが predict() での ML 使用には 20件必要
    const samples = [
      ...Array(5).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(5).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    const model = train(samples);
    assert.ok(model !== null, 'train() が null を返した');
    const { usedML, mlSamples } = predict(makeVideo());
    assert.equal(usedML,    false, `sampleCount=10 で usedML=true になっている`);
    assert.equal(mlSamples, 10);
  });

  test('20件訓練済み (MIN_ML_SAMPLES=20 到達) → usedML=true', () => {
    const samples = [
      ...Array(10).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(10).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const { usedML, mlSamples } = predict(makeVideo());
    assert.equal(usedML,    true, `sampleCount=20 で usedML=false になっている`);
    assert.equal(mlSamples, 20);
  });

  test('ML使用時も probability が 0〜100 の整数', () => {
    const samples = [
      ...Array(10).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(10).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const cases = [
      makeVideo({ viewCount: 100000, subscriberCount: 1000 }),
      makeVideo({ viewCount: 10,     subscriberCount: 100000 }),
      makeVideo({ subscriberCount: 0 }),
    ];
    for (const v of cases) {
      const { probability } = predict(v);
      assert.ok(
        Number.isInteger(probability) && probability >= 0 && probability <= 100,
        `ML使用時 probability=${probability} が 0〜100 の整数でない`
      );
    }
  });

  test('confidence: mlSamples=0 → "low"', () => {
    // 直前テストが train() でモデルを書き込むため、このテスト専用に明示削除する
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    assert.equal(predict(makeVideo()).confidence, 'low');
  });

  test('confidence: mlSamples=20 → "medium"', () => {
    const samples = [
      ...Array(10).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(10).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    assert.equal(predict(makeVideo()).confidence, 'medium');
  });

  test('[改善候補] confidence が "high" に到達しない: 100件訓練でも "medium" 止まり', () => {
    // 現実装: confidence = mlSamples >= MIN_ML_SAMPLES ? 'medium' : 'low'
    // → サンプル数によらず 'high' は返せない
    // 改善案: mlSamples >= 100 などで 'high' を返すべき
    const samples = Array(100).fill(null).map((_, i) =>
      makeSample(i < 50 ? 'hit' : 'miss')
    );
    train(samples);
    const { confidence } = predict(makeVideo());
    assert.equal(confidence, 'medium',
      `100件でも confidence='medium' のまま (改善候補: 十分なサンプルで "high" を返すべき)`);
  });
});

// ─────────────────────────────────────────────────────
// encode() — title_caps_ratio の精密検証
// ─────────────────────────────────────────────────────

describe('encode() — title_caps_ratio の精密検証', () => {

  test('TitleCase ("Hello World") → title_caps_ratio = 0.0（先頭大文字のみはカウントしない）', () => {
    // "Hello" は /[A-Z]/ に一致するが 'Hello' !== 'HELLO' なので caps 単語ではない
    const vec = encode(makeVideo({ title: 'Hello World' }));
    assert.equal(vec[6], 0.0);
  });

  test('半数が全大文字 ("HELLO world") → title_caps_ratio = 0.5', () => {
    const vec = encode(makeVideo({ title: 'HELLO world' }));
    assert.ok(Math.abs(vec[6] - 0.5) < 0.001, `caps_ratio=${vec[6]} (期待: 0.5)`);
  });

  test('数字含む全大文字単語 ("ABC123") → caps として計上され title_caps_ratio = 1.0', () => {
    // /[A-Z]/.test("ABC123") = true かつ "ABC123" === "ABC123".toUpperCase() → caps
    const vec = encode(makeVideo({ title: 'ABC123' }));
    assert.equal(vec[6], 1.0);
  });
});

// ─────────────────────────────────────────────────────
// train() — all-miss 訓練
// ─────────────────────────────────────────────────────

describe('train() — all-miss 訓練', () => {

  test('miss のみ 10件 → 訓練成功、hitCount=0, missCount=10', () => {
    const samples = Array(10).fill(null).map(() => makeSample('miss'));
    const result = train(samples);
    assert.ok(result !== null, 'null が返された');
    if (!result) return;
    assert.equal(result.hitCount,    0);
    assert.equal(result.missCount,   10);
    assert.equal(result.sampleCount, 10);
  });

  test('all-miss 訓練後も weights の全要素が有限数', () => {
    const samples = Array(10).fill(null).map(() => makeSample('miss'));
    const result = train(samples);
    if (!result) return;
    for (let i = 0; i < result.weights.length; i++) {
      assert.ok(isFinite(result.weights[i]), `weights[${i}] が有限数でない: ${result.weights[i]}`);
    }
  });
});

// ─────────────────────────────────────────────────────
// predict() — ルールベース線形補間の精密点 (1/4 · 3/4)
// ─────────────────────────────────────────────────────

describe('predict() — ルールベース線形補間の精密点', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak6';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('buzz_ratio = 1.475 (補間 1/4 点) → probability = 30', () => {
    // score = 0.1 + (1.475-0.3)/(5.0-0.3)*0.8 = 0.1 + 1.175/4.7*0.8 = 0.1 + 0.25*0.8 = 0.30
    const { probability } = predict(makeVideo({ viewCount: 1475, subscriberCount: 1000 }));
    assert.equal(probability, 30, `probability=${probability} (期待: 30)`);
  });

  test('buzz_ratio = 3.825 (補間 3/4 点) → probability = 70', () => {
    // score = 0.1 + (3.825-0.3)/(5.0-0.3)*0.8 = 0.1 + 3.525/4.7*0.8 = 0.1 + 0.75*0.8 = 0.70
    const { probability } = predict(makeVideo({ viewCount: 3825, subscriberCount: 1000 }));
    assert.equal(probability, 70, `probability=${probability} (期待: 70)`);
  });

  test('1/4 点 (probability=30) → label=miss', () => {
    const { label } = predict(makeVideo({ viewCount: 1475, subscriberCount: 1000 }));
    assert.equal(label, 'miss');
  });

  test('3/4 点 (probability=70) → label=hit', () => {
    const { label } = predict(makeVideo({ viewCount: 3825, subscriberCount: 1000 }));
    assert.equal(label, 'hit');
  });
});

// ─────────────────────────────────────────────────────
// predict() — mlSamples の精密検証
// ─────────────────────────────────────────────────────

describe('predict() — mlSamples の精密検証', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak7';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('モデルなし → mlSamples = 0', () => {
    assert.equal(predict(makeVideo()).mlSamples, 0);
  });

  test('30件訓練後 → mlSamples = 30', () => {
    const samples = [
      ...Array(15).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(15).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    assert.equal(predict(makeVideo()).mlSamples, 30);
  });

  test('50件訓練後 → mlSamples = 50, usedML = true', () => {
    const samples = [
      ...Array(25).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(25).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const result = predict(makeVideo());
    assert.equal(result.mlSamples, 50);
    assert.equal(result.usedML,    true);
  });
});

// ─────────────────────────────────────────────────────
// getModelStatus() — train 直後の整合性
// ─────────────────────────────────────────────────────

describe('getModelStatus() — train 直後の整合性', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak8';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('train 前 → trained=false', () => {
    assert.equal(getModelStatus().trained, false);
  });

  test('train 後 → trained=true, hitCount/missCount が一致', () => {
    const samples = [
      ...Array(8).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(7).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const status = getModelStatus();
    assert.equal(status.trained,     true);
    assert.equal(status.sampleCount, 15);
    assert.equal(status.hitCount,    8);
    assert.equal(status.missCount,   7);
  });

  test('train 後の getModelStatus().sampleCount と predict().mlSamples が一致', () => {
    const samples = [
      ...Array(12).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(8).fill(null).map(()  => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const { sampleCount } = getModelStatus();
    const { mlSamples }   = predict(makeVideo());
    assert.equal(
      sampleCount, mlSamples,
      `getModelStatus.sampleCount(${sampleCount}) ≠ predict.mlSamples(${mlSamples})`
    );
  });
});

// ─────────────────────────────────────────────────────
// train() — 予測方向の整合性テスト
// ─────────────────────────────────────────────────────

describe('train() — 予測方向の整合性', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak5';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('hit/miss 分離学習後: hit動画の probability が miss動画より高い', () => {
    const samples = [
      ...Array(15).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(15).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const hitResult  = predict(makeVideo({ viewCount: 50000, subscriberCount: 1000 }));
    const missResult = predict(makeVideo({ viewCount: 100,   subscriberCount: 1000 }));
    assert.ok(
      hitResult.probability > missResult.probability,
      `hit動画(${hitResult.probability}%) が miss動画(${missResult.probability}%) より高くない`
    );
  });

  test('バランス訓練後: 明確 hit 動画→label=hit, 明確 miss 動画→label=miss', () => {
    const samples = [
      ...Array(15).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(15).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const hitResult  = predict(makeVideo({ viewCount: 50000, subscriberCount: 1000 }));
    const missResult = predict(makeVideo({ viewCount: 100,   subscriberCount: 1000 }));
    assert.equal(hitResult.label,  'hit',  `hit動画のlabel=${hitResult.label}`);
    assert.equal(missResult.label, 'miss', `miss動画のlabel=${missResult.label}`);
  });
});

// ─────────────────────────────────────────────────────
// train() — 最小有効サンプル数境界（ちょうど 10 件）
// ─────────────────────────────────────────────────────

describe('train() — 最小有効サンプル数境界（10件）', () => {

  test('ちょうど 10 件 (hit:5 miss:5) → 訓練成功', () => {
    const samples = [
      ...Array(5).fill(null).map(() => makeSample('hit')),
      ...Array(5).fill(null).map(() => makeSample('miss')),
    ];
    const result = train(samples);
    assert.ok(result !== null, '10件ちょうどで null が返された');
    assert.equal(result.sampleCount, 10);
    assert.equal(result.hitCount,    5);
    assert.equal(result.missCount,   5);
  });

  test('ちょうど 10 件 (hit のみ) → 訓練成功, hitCount=10', () => {
    const result = train(Array(10).fill(null).map(() => makeSample('hit')));
    assert.ok(result !== null, '10件(hit only)で null が返された');
    if (!result) return;
    assert.equal(result.hitCount,    10);
    assert.equal(result.missCount,   0);
    assert.equal(result.sampleCount, 10);
  });

  test('9件 + 無効ラベル 1件 = 有効 9件 → null (境界を超えない)', () => {
    const samples = [
      ...Array(9).fill(null).map(() => makeSample('hit')),
      makeSample('unknown'),
    ];
    assert.equal(train(samples), null);
  });
});

// ─────────────────────────────────────────────────────
// predict() — in-sample accuracy（精度検証）
// ─────────────────────────────────────────────────────

describe('predict() — in-sample accuracy（精度検証）', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak9';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('明確分離 30件学習後: in-sample accuracy >= 80%（モデル収束確認）', () => {
    const hitVids  = Array(15).fill(null).map(() => makeVideo({ viewCount: 50000, subscriberCount: 1000 }));
    const missVids = Array(15).fill(null).map(() => makeVideo({ viewCount: 100,   subscriberCount: 1000 }));

    train([
      ...hitVids.map(v  => ({ ...v, label: 'hit'  })),
      ...missVids.map(v => ({ ...v, label: 'miss' })),
    ]);

    let correct = 0;
    for (const v of hitVids)  { if (predict(v).label === 'hit')  correct++; }
    for (const v of missVids) { if (predict(v).label === 'miss') correct++; }

    const total    = hitVids.length + missVids.length;
    const accuracy = correct / total;
    assert.ok(
      accuracy >= 0.8,
      `in-sample accuracy = ${(accuracy * 100).toFixed(0)}% (${correct}/${total}) (期待: >= 80%)`
    );
  });

  test('明確分離 20件学習後: hit動画→label=hit, miss動画→label=miss が 90% 以上', () => {
    const hitVids  = Array(10).fill(null).map(() => makeVideo({ viewCount: 80000, subscriberCount: 1000 }));
    const missVids = Array(10).fill(null).map(() => makeVideo({ viewCount: 50,    subscriberCount: 1000 }));

    train([
      ...hitVids.map(v  => ({ ...v, label: 'hit'  })),
      ...missVids.map(v => ({ ...v, label: 'miss' })),
    ]);

    const hitCorrect  = hitVids.filter(v  => predict(v).label === 'hit').length;
    const missCorrect = missVids.filter(v => predict(v).label === 'miss').length;
    const accuracy    = (hitCorrect + missCorrect) / (hitVids.length + missVids.length);

    assert.ok(
      accuracy >= 0.9,
      `accuracy=${(accuracy*100).toFixed(0)}% hit(${hitCorrect}/10) miss(${missCorrect}/10) (期待: >= 90%)`
    );
  });
});

// ─────────────────────────────────────────────────────
// predict() — 投稿前メタデータ入力（viewCount=0・URL なし）
// ─────────────────────────────────────────────────────

describe('predict() — 投稿前メタデータ入力', () => {
  const MODEL_FILE     = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK      = MODEL_FILE + '.test-bak-pre';
  const PRE_MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model-pre.json');
  const PRE_MODEL_BAK  = PRE_MODEL_FILE + '.test-bak-pre';

  before(() => {
    if (fs.existsSync(MODEL_FILE))     fs.renameSync(MODEL_FILE,     MODEL_BAK);
    if (fs.existsSync(PRE_MODEL_FILE)) fs.renameSync(PRE_MODEL_FILE, PRE_MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE))     fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(PRE_MODEL_FILE)) fs.unlinkSync(PRE_MODEL_FILE);
    if (fs.existsSync(MODEL_BAK))      fs.renameSync(MODEL_BAK,      MODEL_FILE);
    if (fs.existsSync(PRE_MODEL_BAK))  fs.renameSync(PRE_MODEL_BAK,  PRE_MODEL_FILE);
  });

  test('viewCount=0 で predict() がエラーなく結果を返す', () => {
    const video = {
      videoId: null, viewCount: 0, likeCount: 0, commentCount: 0,
      title: '新曲歌ってみた！', description: '',
      tags: ['歌ってみた', 'vtuber'],
      duration: 300, publishedAt: null, subscriberCount: 10000,
    };
    assert.doesNotThrow(() => predict(video));
  });

  test('投稿前入力 → probability が 0〜100 の整数', () => {
    const video = {
      videoId: null, viewCount: 0, likeCount: 0, commentCount: 0,
      title: 'テスト動画タイトル！', description: '',
      tags: ['tag1', 'tag2'],
      duration: 600, publishedAt: null, subscriberCount: 5000,
    };
    const { probability } = predict(video);
    assert.ok(
      Number.isInteger(probability) && probability >= 0 && probability <= 100,
      `probability=${probability}`
    );
  });

  test('投稿前入力 → label が hit / miss / unknown のいずれか', () => {
    const video = {
      videoId: null, viewCount: 0, likeCount: 0, commentCount: 0,
      title: 'タイトル', tags: ['tag'], duration: 600, subscriberCount: 5000,
    };
    const { label } = predict(video);
    assert.ok(['hit', 'miss', 'unknown'].includes(label), `不正な label: ${label}`);
  });

  test('viewCount=0, subs=0 → 投稿前ルール: buzzRatio=null, probability=45（ベースライン0.45）', () => {
    // 投稿前モード (_ruleScorePrePub): base=0.45、subs=0/title短/tags無/duration=0 → ボーナス無し
    const video = {
      viewCount: 0, likeCount: 0, commentCount: 0,
      title: 'タイトル', tags: [], duration: 0, subscriberCount: 0,
    };
    const result = predict(video);
    assert.equal(result.buzzRatio, null);
    assert.equal(result.probability, 45);
  });

  test('viewCount=0, subs=1000 → 投稿前ルール: buzzRatio=null, probability=48, label=unknown', () => {
    // 投稿前モード (_ruleScorePrePub): base=0.45 + subs=1000(+0.03) = 0.48
    // title='タイトル'(4文字 < 8文字) → タイトルボーナス無し、tags=[]、duration=0 → ボーナス無し
    const video = {
      viewCount: 0, likeCount: 0, commentCount: 0,
      title: 'タイトル', tags: [], duration: 0, subscriberCount: 1000,
    };
    const result = predict(video);
    assert.equal(result.buzzRatio, null);
    assert.equal(result.probability, 48);
    assert.equal(result.label, 'unknown');
  });

  test('投稿前入力 → buildSummary() が文字列を返し "YouTube ヒット予測" を含む', () => {
    const video = {
      videoId: null, viewCount: 0, likeCount: 0, commentCount: 0,
      title: '新曲！', tags: ['vtuber'], duration: 300, subscriberCount: 5000,
    };
    const result  = predict(video);
    const summary = buildSummary(video, result);
    assert.ok(typeof summary === 'string' && summary.length > 0);
    assert.ok(summary.includes('YouTube ヒット予測'), 'ヘッダーが含まれない');
  });

  test('タグ多め・尺長め → encode() がエラーなく動作する', () => {
    const video = {
      videoId: null, viewCount: 0, likeCount: 0, commentCount: 0,
      title: '長い動画タイトル！？🎬🎬🎬🎬🎬',
      tags: Array(30).fill('tag'),
      duration: 3600, publishedAt: null, subscriberCount: 100000,
    };
    assert.doesNotThrow(() => predict(video));
    const { probability } = predict(video);
    assert.ok(probability >= 0 && probability <= 100);
  });
});

// ─────────────────────────────────────────────────────
// predict() / buildSummary() — 再生数レンジ表示 (AC確認)
// ─────────────────────────────────────────────────────

describe('predict() + buildSummary() — 再生数レンジ・ベンチマーク表示', () => {

  describe('predict() 戻り値: viewRange フィールド', () => {
    test('subscriberCount > 0 → viewRange が存在する', () => {
      const result = predict(makeVideo({ subscriberCount: 1000 }));
      assert.ok('viewRange' in result, 'viewRange フィールドがない');
      assert.ok(result.viewRange !== null, 'viewRange が null');
    });

    test('viewRange は low / median / high を持つ', () => {
      const { viewRange } = predict(makeVideo({ subscriberCount: 1000 }));
      assert.ok('low'    in viewRange, 'low がない');
      assert.ok('median' in viewRange, 'median がない');
      assert.ok('high'   in viewRange, 'high がない');
    });

    test('viewRange.low <= viewRange.median <= viewRange.high', () => {
      const { viewRange } = predict(makeVideo({ subscriberCount: 1000 }));
      const { low, median, high } = viewRange;
      assert.ok(low <= median, `low(${low}) > median(${median})`);
      assert.ok(median <= high, `median(${median}) > high(${high})`);
    });

    test('viewRange の各値が 0 以上の整数', () => {
      const { viewRange } = predict(makeVideo({ subscriberCount: 1000 }));
      for (const [k, v] of Object.entries(viewRange)) {
        assert.ok(Number.isInteger(v) && v >= 0, `viewRange.${k}=${v} が 0 以上の整数でない`);
      }
    });

    test('subscriberCount = 0 → viewRange = null（データ不足）', () => {
      const result = predict(makeVideo({ subscriberCount: 0 }));
      assert.equal(result.viewRange, null);
    });

    test('hit 圏 (probability 高) の median が miss 圏より大きい', () => {
      const hitResult  = predict(makeVideo({ viewCount: 10000, subscriberCount: 1000 }));
      const missResult = predict(makeVideo({ viewCount: 100,   subscriberCount: 1000 }));
      assert.ok(
        hitResult.viewRange.median > missResult.viewRange.median,
        `hit median(${hitResult.viewRange.median}) <= miss median(${missResult.viewRange.median})`
      );
    });
  });

  describe('predict() 戻り値: benchmark フィールド', () => {
    test('subscriberCount > 0 → benchmark が存在する', () => {
      const result = predict(makeVideo({ subscriberCount: 1000 }));
      assert.ok('benchmark' in result, 'benchmark フィールドがない');
      assert.ok(result.benchmark !== null, 'benchmark が null');
    });

    test('benchmark.genreMedian が 0 より大きい整数', () => {
      const { benchmark } = predict(makeVideo({ subscriberCount: 1000 }));
      assert.ok(Number.isInteger(benchmark.genreMedian) && benchmark.genreMedian > 0,
        `genreMedian=${benchmark.genreMedian}`);
    });

    test('subscriberCount = 0 → benchmark = null', () => {
      const result = predict(makeVideo({ subscriberCount: 0 }));
      assert.equal(result.benchmark, null);
    });

    test('subscriberCount が大きいほど genreMedian が大きい', () => {
      const small = predict(makeVideo({ subscriberCount: 1000 }));
      const large = predict(makeVideo({ subscriberCount: 100000 }));
      assert.ok(
        large.benchmark.genreMedian > small.benchmark.genreMedian,
        `large(${large.benchmark.genreMedian}) <= small(${small.benchmark.genreMedian})`
      );
    });
  });

  describe('buildSummary() — レンジ形式の出力確認', () => {
    test('subscriberCount > 0 → "予測再生数レンジ" を含む', () => {
      const video  = makeVideo({ subscriberCount: 1000 });
      const result = predict(video);
      assert.ok(buildSummary(video, result).includes('予測再生数レンジ'), '"予測再生数レンジ" がない');
    });

    test('subscriberCount > 0 → LOW / MEDIAN / HIGH のラベルを含む', () => {
      const video   = makeVideo({ subscriberCount: 1000 });
      const result  = predict(video);
      const summary = buildSummary(video, result);
      assert.ok(summary.includes('LOW'),    'LOW がない');
      assert.ok(summary.includes('MEDIAN'), 'MEDIAN がない');
      assert.ok(summary.includes('HIGH'),   'HIGH がない');
    });

    test('subscriberCount > 0 → "回" の単位を含む', () => {
      const video  = makeVideo({ subscriberCount: 1000 });
      const result = predict(video);
      assert.ok(buildSummary(video, result).includes('回'), '単位 "回" がない');
    });

    test('subscriberCount = 0 → "未確定" を含む（データ不足の明示）', () => {
      const video  = makeVideo({ subscriberCount: 0 });
      const result = predict(video);
      assert.ok(buildSummary(video, result).includes('未確定'), '"未確定" がない');
    });

    test('subscriberCount = 0 → LOW / MEDIAN / HIGH のラベルがない', () => {
      const video   = makeVideo({ subscriberCount: 0 });
      const result  = predict(video);
      const summary = buildSummary(video, result);
      assert.ok(!summary.includes('LOW'),    'subs=0 なのに LOW がある');
      assert.ok(!summary.includes('MEDIAN'), 'subs=0 なのに MEDIAN がある');
      assert.ok(!summary.includes('HIGH'),   'subs=0 なのに HIGH がある');
    });

    test('subscriberCount > 0 → "ベンチマーク" または "中央値" を含む', () => {
      const video  = makeVideo({ subscriberCount: 1000 });
      const result = predict(video);
      const summary = buildSummary(video, result);
      assert.ok(
        summary.includes('ベンチマーク') || summary.includes('中央値'),
        '"ベンチマーク" も "中央値" もない'
      );
    });

    test('確率レンジ表現を維持 — "確率" または "レンジ" を含む', () => {
      const video  = makeVideo({ subscriberCount: 1000 });
      const result = predict(video);
      const summary = buildSummary(video, result);
      assert.ok(
        summary.includes('確率') || summary.includes('レンジ'),
        '"確率" も "レンジ" も含まれない'
      );
    });

    test('断定表現ではなく確率レンジ表現 — "断定" という文字を含まない', () => {
      const video  = makeVideo({ subscriberCount: 1000 });
      const result = predict(video);
      assert.ok(!buildSummary(video, result).includes('断定'), '"断定" が含まれている');
    });

    test('10万超えのチャンネル → 万単位フォーマット ("万") を含む', () => {
      const video  = makeVideo({ viewCount: 500000, subscriberCount: 100000 });
      const result = predict(video);
      assert.ok(buildSummary(video, result).includes('万'), '"万" 単位が含まれない');
    });
  });
});

// ─────────────────────────────────────────────────────
// predict() — ML 混合比率: MAX_ML_WEIGHT 飽和の挙動確認
// ─────────────────────────────────────────────────────

describe('predict() — ML 混合比率: MAX_ML_WEIGHT 飽和', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak10';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('sampleCount=70 → usedML=true, mlSamples=70', () => {
    const samples = [
      ...Array(35).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(35).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    train(samples);
    const { usedML, mlSamples } = predict(makeVideo());
    assert.equal(usedML,    true, `sampleCount=70 で usedML=false`);
    assert.equal(mlSamples, 70);
    // mlWeight = min(70/100, 0.7) = 0.7 → MAX_ML_WEIGHT に到達済み
  });

  test('[改善候補] sampleCount >= 70 で mlWeight が MAX_ML_WEIGHT(0.7) に飽和: 追加サンプルの ML 比率への効果なし', () => {
    // mlWeight = min(sampleCount / 100, MAX_ML_WEIGHT=0.7)
    // → sampleCount=70 で 0.7 に到達し、それ以上サンプルを増やしても ML 混合比率は不変
    // 改善案: saturation_point を 200 前後に引き上げるか、MAX_ML_WEIGHT を 0.9 程度に拡大すべき
    const make70  = [
      ...Array(35).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(35).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];
    const make100 = [
      ...Array(50).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(50).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ];

    train(make70);
    const { mlSamples: s70 } = predict(makeVideo());
    train(make100);
    const { mlSamples: s100 } = predict(makeVideo());

    assert.equal(s70,  70);
    assert.equal(s100, 100);
    // mlWeight(70)=0.7 == mlWeight(100)=0.7 → 100件でも追加分の ML 比率貢献はゼロ
    // これはドキュメント目的のテスト: 現状動作を確認しつつ改善余地を記録する
  });
});

// ─────────────────────────────────────────────────────
// encode() — title_caps_ratio: 数字・記号を含む単語の挙動
// ─────────────────────────────────────────────────────

describe('encode() — title_caps_ratio: 数字・記号を含む単語の挙動', () => {

  test('数字のみ ("123") → title_caps_ratio = 0.0 (/[A-Z]/ に不一致)', () => {
    const vec = encode(makeVideo({ title: '123' }));
    assert.equal(vec[6], 0.0);
  });

  test('数字と大文字混在 ("123 ABC") → title_caps_ratio = 0.5 (ABC のみ caps)', () => {
    // "123" は /[A-Z]/ に不一致 → caps 扱いにならない
    // "ABC" は /[A-Z]/ に一致 かつ toUpperCase() と同一 → caps
    const vec = encode(makeVideo({ title: '123 ABC' }));
    assert.ok(Math.abs(vec[6] - 0.5) < 0.001, `caps_ratio=${vec[6]} (期待: 0.5)`);
  });

  test('空白のみのタイトル ("   ") → title_caps_ratio = 0.0 (words.length=0)', () => {
    const vec = encode(makeVideo({ title: '   ' }));
    assert.equal(vec[6], 0.0);
  });

  test('単一大文字単語 ("A") → title_caps_ratio = 1.0', () => {
    const vec = encode(makeVideo({ title: 'A' }));
    assert.equal(vec[6], 1.0);
  });
});

// ─────────────────────────────────────────────────────
// buildSummary() — usedML=true ブランチの確定テスト
// ─────────────────────────────────────────────────────

describe('buildSummary() — usedML=true ブランチ（20件学習後）', () => {
  const MODEL_FILE = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const MODEL_BAK  = MODEL_FILE + '.test-bak11';

  before(() => {
    if (fs.existsSync(MODEL_FILE)) fs.renameSync(MODEL_FILE, MODEL_BAK);
    // 20件学習で usedML=true を確定させる
    train([
      ...Array(10).fill(null).map(() => makeSample('hit',  { viewCount: 50000, subscriberCount: 1000 })),
      ...Array(10).fill(null).map(() => makeSample('miss', { viewCount: 100,   subscriberCount: 1000 })),
    ]);
  });
  after(() => {
    if (fs.existsSync(MODEL_FILE)) fs.unlinkSync(MODEL_FILE);
    if (fs.existsSync(MODEL_BAK)) fs.renameSync(MODEL_BAK, MODEL_FILE);
  });

  test('usedML=true → サマリーに "ML" が含まれる', () => {
    const video  = makeVideo({ viewCount: 10000, subscriberCount: 1000 });
    const result = predict(video);
    assert.equal(result.usedML, true, `20件学習後に usedML=false`);
    assert.ok(buildSummary(video, result).includes('ML'), 'ML の文字がサマリーにない');
  });

  test('usedML=true → "ML モデル使用" の行を含む', () => {
    const video   = makeVideo({ viewCount: 10000, subscriberCount: 1000 });
    const result  = predict(video);
    assert.equal(result.usedML, true);
    assert.ok(buildSummary(video, result).includes('ML モデル使用'), '"ML モデル使用" がサマリーにない');
  });

  test('usedML=true → 学習件数 (20) がサマリーに含まれる', () => {
    const video   = makeVideo({ viewCount: 10000, subscriberCount: 1000 });
    const result  = predict(video);
    assert.equal(result.mlSamples, 20);
    assert.ok(buildSummary(video, result).includes('20'), '学習数 20 がサマリーに含まれない');
  });
});

// ─────────────────────────────────────────────────────
// predict() — reasons フィールド（主要因上位3件）
// ─────────────────────────────────────────────────────

describe('predict() — reasons フィールド', () => {

  test('reasons フィールドが存在する', () => {
    const result = predict(makeVideo());
    assert.ok('reasons' in result, 'reasons フィールドがない');
  });

  test('reasons は配列', () => {
    const { reasons } = predict(makeVideo());
    assert.ok(Array.isArray(reasons), `reasons が配列でない: ${typeof reasons}`);
  });

  test('reasons の件数は 1〜3 件', () => {
    const { reasons } = predict(makeVideo());
    assert.ok(reasons.length >= 1 && reasons.length <= 3, `reasons.length=${reasons.length}`);
  });

  test('各 reason に factor / impact / detail がある', () => {
    const { reasons } = predict(makeVideo());
    for (const r of reasons) {
      assert.ok('factor' in r, `factor がない: ${JSON.stringify(r)}`);
      assert.ok('impact' in r, `impact がない: ${JSON.stringify(r)}`);
      assert.ok('detail' in r, `detail がない: ${JSON.stringify(r)}`);
    }
  });

  test('impact は "positive" または "negative"', () => {
    const { reasons } = predict(makeVideo());
    for (const r of reasons) {
      assert.ok(
        r.impact === 'positive' || r.impact === 'negative',
        `不正な impact: ${r.impact}`
      );
    }
  });

  test('factor / detail が空文字列でない', () => {
    const { reasons } = predict(makeVideo());
    for (const r of reasons) {
      assert.ok(r.factor.length > 0, `factor が空: ${JSON.stringify(r)}`);
      assert.ok(r.detail.length > 0, `detail が空: ${JSON.stringify(r)}`);
    }
  });

  test('投稿前モード (viewCount=0) でも reasons が返る', () => {
    const video = makeVideo({ viewCount: 0, likeCount: 0, commentCount: 0 });
    const { reasons } = predict(video);
    assert.ok(Array.isArray(reasons) && reasons.length >= 1, `reasons.length=${reasons.length}`);
  });

  test('subs=0 / 最小入力でも reasons が返る', () => {
    const { reasons } = predict({ viewCount: 0, subscriberCount: 0, title: '' });
    assert.ok(Array.isArray(reasons) && reasons.length >= 1);
  });

  test('hit 圏の動画 → 少なくとも1件 impact=positive', () => {
    // buzz_ratio=10 → 明確 hit → チャンネル規模ボーナスなどで positive が出るはず
    const { reasons } = predict(makeVideo({ viewCount: 10000, subscriberCount: 1000 }));
    assert.ok(
      reasons.some(r => r.impact === 'positive'),
      `hit 圏なのに positive な reason がない: ${JSON.stringify(reasons)}`
    );
  });
});

// ─────────────────────────────────────────────────────
// buildSummary() — 主要因セクション表示
// ─────────────────────────────────────────────────────

describe('buildSummary() — 主要因セクション', () => {

  test('"主要因" または "このスコア" の見出しを含む', () => {
    const video   = makeVideo();
    const result  = predict(video);
    const summary = buildSummary(video, result);
    assert.ok(
      summary.includes('主要因') || summary.includes('このスコア'),
      '主要因セクションの見出しがない'
    );
  });

  test('reasons の factor 名がサマリーに含まれる', () => {
    const video   = makeVideo();
    const result  = predict(video);
    const summary = buildSummary(video, result);
    for (const r of result.reasons) {
      assert.ok(summary.includes(r.factor), `factor "${r.factor}" がサマリーに含まれない`);
    }
  });

  test('reasons の detail がサマリーに含まれる', () => {
    const video   = makeVideo();
    const result  = predict(video);
    const summary = buildSummary(video, result);
    for (const r of result.reasons) {
      assert.ok(summary.includes(r.detail), `detail "${r.detail}" がサマリーに含まれない`);
    }
  });

  test('投稿前モードでも主要因セクションが含まれる', () => {
    const video   = makeVideo({ viewCount: 0, likeCount: 0, commentCount: 0, subscriberCount: 5000 });
    const result  = predict(video);
    const summary = buildSummary(video, result);
    assert.ok(summary.includes('主要因') || summary.includes('このスコア'), '投稿前モードで主要因がない');
  });
});
