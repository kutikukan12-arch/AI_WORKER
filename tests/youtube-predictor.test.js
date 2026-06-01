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
