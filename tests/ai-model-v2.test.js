'use strict';

/**
 * ai-model-v2.js のユニットテスト
 *
 * テスト対象:
 *   LogisticRegression  — 二値分類（train / predict / toJSON / fromJSON）
 *   LinearRegression    — 回帰（train / predict / toJSON / fromJSON）
 *   SoftmaxClassifier   — 多クラス分類（train / predict / toJSON / fromJSON）
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { LogisticRegression, LinearRegression, SoftmaxClassifier } = require('../bot/utils/ai-model-v2');
const { FEATURE_DIM } = require('../bot/utils/ai-feature-extractor');

// ── テスト用ヘルパー ──────────────────────────────────

// 決定論的な疑似ベクトル（実際の特徴量に近い性質を持つ）
function makeVec(seed) {
  const v = new Float64Array(FEATURE_DIM);
  for (let i = 0; i < FEATURE_DIM - 1; i++) {
    v[i] = ((seed * 31 + i * 17 + 7) % 97) / 97.0;
  }
  v[FEATURE_DIM - 1] = 1.0; // bias
  return v;
}

// N 件の学習データを生成
function makeDataset(N, labelFn) {
  const X = Array.from({ length: N }, (_, i) => makeVec(i));
  const y = Array.from({ length: N }, (_, i) => labelFn(i));
  return { X, y };
}

// ── LogisticRegression ────────────────────────────────

describe('LogisticRegression', () => {

  describe('train() — 入力バリデーション', () => {
    test('空データでエラー', () => {
      const m = new LogisticRegression({ epochs: 5 });
      assert.throws(() => m.train([], []), /空/);
    });

    test('X と y の件数不一致でエラー', () => {
      const m = new LogisticRegression({ epochs: 5 });
      assert.throws(() => m.train([makeVec(0), makeVec(1)], [1]), /一致/);
    });
  });

  describe('train() — 学習後の状態', () => {
    test('weights が FEATURE_DIM 長の Float64Array', () => {
      const { X, y } = makeDataset(10, i => i % 2);
      const m = new LogisticRegression({ epochs: 5 });
      m.train(X, y);
      assert.ok(m.weights instanceof Float64Array);
      assert.equal(m.weights.length, FEATURE_DIM);
    });

    test('lossHistory の長さが epochs と一致', () => {
      const epochs = 15;
      const { X, y } = makeDataset(10, i => i % 2);
      const m = new LogisticRegression({ epochs });
      m.train(X, y);
      assert.equal(m.lossHistory.length, epochs);
    });

    test('trainedAt が ISO 文字列', () => {
      const { X, y } = makeDataset(10, i => i % 2);
      const m = new LogisticRegression({ epochs: 5 });
      m.train(X, y);
      assert.ok(typeof m.trainedAt === 'string');
      assert.doesNotThrow(() => new Date(m.trainedAt));
    });

    test('lossHistory の全要素が有限の正数', () => {
      const { X, y } = makeDataset(10, i => i % 2);
      const m = new LogisticRegression({ epochs: 10 });
      m.train(X, y);
      for (const l of m.lossHistory) {
        assert.ok(isFinite(l) && l >= 0, `loss=${l} が無効`);
      }
    });
  });

  describe('predict()', () => {
    test('[0, 1] の範囲内', () => {
      const { X, y } = makeDataset(20, i => i % 2);
      const m = new LogisticRegression({ epochs: 10 });
      m.train(X, y);
      for (let seed = 0; seed < 30; seed++) {
        const p = m.predict(makeVec(seed + 100));
        assert.ok(p >= 0.0 && p <= 1.0, `predict=${p} が範囲外`);
      }
    });
  });

  describe('収束テスト — 線形分離可能データ', () => {
    test('正例の確率 > 0.6、負例の確率 < 0.4', () => {
      // feature[0] が 1 なら正例、0 なら負例（完全分離）
      const N = 60;
      const X = [];
      const y = [];
      for (let i = 0; i < N; i++) {
        const v = new Float64Array(FEATURE_DIM);
        v[FEATURE_DIM - 1] = 1.0;
        v[0] = i < N / 2 ? 1.0 : 0.0;
        X.push(v);
        y.push(i < N / 2 ? 1 : 0);
      }
      const m = new LogisticRegression({ epochs: 300, lr: 0.1 });
      m.train(X, y);

      const posVec = new Float64Array(FEATURE_DIM);
      posVec[FEATURE_DIM - 1] = 1.0;
      posVec[0] = 1.0;
      assert.ok(m.predict(posVec) > 0.6, `正例確率 = ${m.predict(posVec)}`);

      const negVec = new Float64Array(FEATURE_DIM);
      negVec[FEATURE_DIM - 1] = 1.0;
      negVec[0] = 0.0;
      assert.ok(m.predict(negVec) < 0.4, `負例確率 = ${m.predict(negVec)}`);
    });
  });

  describe('toJSON() / fromJSON()', () => {
    test('同じ予測結果を返す（シリアライズ往復）', () => {
      const { X, y } = makeDataset(20, i => i % 2);
      const m = new LogisticRegression({ epochs: 20 });
      m.train(X, y);

      const json = m.toJSON();
      const restored = LogisticRegression.fromJSON(json);

      for (let seed = 0; seed < 10; seed++) {
        const v = makeVec(seed + 50);
        assert.ok(Math.abs(m.predict(v) - restored.predict(v)) < 1e-10);
      }
    });

    test('toJSON に type / weights / trainedAt が含まれる', () => {
      const { X, y } = makeDataset(10, i => i % 2);
      const m = new LogisticRegression({ epochs: 5 });
      m.train(X, y);
      const json = m.toJSON();

      assert.equal(json.type, 'LogisticRegression');
      assert.ok(Array.isArray(json.weights));
      assert.equal(json.weights.length, FEATURE_DIM);
      assert.ok(typeof json.trainedAt === 'string');
    });

    test('fromJSON で lr / lambda / epochs が復元される', () => {
      const { X, y } = makeDataset(10, i => i % 2);
      const m = new LogisticRegression({ lr: 0.02, lambda: 0.005, epochs: 7 });
      m.train(X, y);
      const r = LogisticRegression.fromJSON(m.toJSON());
      assert.equal(r.lr,     0.02);
      assert.equal(r.lambda, 0.005);
      assert.equal(r.epochs, 7);
    });
  });
});

// ── LinearRegression ──────────────────────────────────

describe('LinearRegression', () => {

  describe('train() — 入力バリデーション', () => {
    test('空データでエラー', () => {
      const m = new LinearRegression({ epochs: 5 });
      assert.throws(() => m.train([], []), /空/);
    });
  });

  describe('train() — 学習後の状態', () => {
    test('weights が FEATURE_DIM 長の Float64Array', () => {
      const { X, y } = makeDataset(10, i => i * 10);
      const m = new LinearRegression({ epochs: 5 });
      m.train(X, y);
      assert.ok(m.weights instanceof Float64Array);
      assert.equal(m.weights.length, FEATURE_DIM);
    });

    test('lossHistory の長さが epochs と一致', () => {
      const epochs = 12;
      const { X, y } = makeDataset(10, i => i * 5);
      const m = new LinearRegression({ epochs });
      m.train(X, y);
      assert.equal(m.lossHistory.length, epochs);
    });

    test('定数 y → yStd が 1.0（ゼロ除算防止）', () => {
      const X = Array.from({ length: 10 }, (_, i) => makeVec(i));
      const y = Array(10).fill(42);
      const m = new LinearRegression({ epochs: 5 });
      m.train(X, y);
      assert.equal(m.yStd, 1.0);
      assert.equal(m.yMean, 42);
    });

    test('yMean が y の平均と一致', () => {
      const y = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const X = y.map((_, i) => makeVec(i));
      const m = new LinearRegression({ epochs: 5 });
      m.train(X, y);
      const expected = y.reduce((a, b) => a + b, 0) / y.length;
      assert.ok(Math.abs(m.yMean - expected) < 1e-9);
    });
  });

  describe('predict()', () => {
    test('有限の数値を返す', () => {
      const { X, y } = makeDataset(20, i => i * 10);
      const m = new LinearRegression({ epochs: 10 });
      m.train(X, y);
      for (let seed = 0; seed < 20; seed++) {
        const p = m.predict(makeVec(seed + 100));
        assert.ok(isFinite(p), `predict=${p} が有限でない`);
      }
    });
  });

  describe('toJSON() / fromJSON()', () => {
    test('同じ予測結果を返す（シリアライズ往復）', () => {
      const { X, y } = makeDataset(20, i => i * 15);
      const m = new LinearRegression({ epochs: 20 });
      m.train(X, y);

      const json = m.toJSON();
      const restored = LinearRegression.fromJSON(json);

      for (let seed = 0; seed < 10; seed++) {
        const v = makeVec(seed + 50);
        assert.ok(Math.abs(m.predict(v) - restored.predict(v)) < 1e-10);
      }
    });

    test('toJSON に type / yMean / yStd / trainedAt が含まれる', () => {
      const { X, y } = makeDataset(10, i => i * 5);
      const m = new LinearRegression({ epochs: 5 });
      m.train(X, y);
      const json = m.toJSON();

      assert.equal(json.type, 'LinearRegression');
      assert.ok(typeof json.yMean === 'number');
      assert.ok(typeof json.yStd === 'number');
      assert.ok(typeof json.trainedAt === 'string');
      assert.equal(json.weights.length, FEATURE_DIM);
    });

    test('fromJSON で yMean / yStd が復元される', () => {
      const { X, y } = makeDataset(10, i => i * 8);
      const m = new LinearRegression({ epochs: 5 });
      m.train(X, y);
      const r = LinearRegression.fromJSON(m.toJSON());
      assert.ok(Math.abs(r.yMean - m.yMean) < 1e-10);
      assert.ok(Math.abs(r.yStd  - m.yStd)  < 1e-10);
    });
  });
});

// ── SoftmaxClassifier ─────────────────────────────────

describe('SoftmaxClassifier', () => {

  describe('train() — 入力バリデーション', () => {
    test('空データでエラー', () => {
      const m = new SoftmaxClassifier({ epochs: 5 });
      assert.throws(() => m.train([], []), /空/);
    });
  });

  describe('train() — 学習後の状態', () => {
    test('weights が [numClasses][FEATURE_DIM] の構造', () => {
      const { X } = makeDataset(15, () => 0);
      const y = Array.from({ length: 15 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ epochs: 5, numClasses: 3 });
      m.train(X, y);
      assert.equal(m.weights.length, 3);
      for (const w of m.weights) {
        assert.ok(w instanceof Float64Array);
        assert.equal(w.length, FEATURE_DIM);
      }
    });

    test('lossHistory の長さが epochs と一致', () => {
      const { X } = makeDataset(15, () => 0);
      const y = Array.from({ length: 15 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ epochs: 8 });
      m.train(X, y);
      assert.equal(m.lossHistory.length, 8);
    });
  });

  describe('predict()', () => {
    test('確率の和が ≈ 1.0', () => {
      const { X } = makeDataset(20, () => 0);
      const y = Array.from({ length: 20 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ epochs: 10, numClasses: 3 });
      m.train(X, y);

      for (let seed = 0; seed < 10; seed++) {
        const probs = m.predict(makeVec(seed + 100));
        assert.equal(probs.length, 3);
        const sum = probs.reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum=${sum}`);
      }
    });

    test('各確率が [0, 1]', () => {
      const { X } = makeDataset(20, () => 0);
      const y = Array.from({ length: 20 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ epochs: 10 });
      m.train(X, y);

      const probs = m.predict(makeVec(7));
      for (const p of probs) {
        assert.ok(p >= 0.0 && p <= 1.0, `prob=${p} が範囲外`);
      }
    });
  });

  describe('toJSON() / fromJSON()', () => {
    test('同じ予測結果を返す（シリアライズ往復）', () => {
      const { X } = makeDataset(20, () => 0);
      const y = Array.from({ length: 20 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ epochs: 15 });
      m.train(X, y);

      const json = m.toJSON();
      const restored = SoftmaxClassifier.fromJSON(json);

      for (let seed = 0; seed < 5; seed++) {
        const v = makeVec(seed + 50);
        const before = m.predict(v);
        const after  = restored.predict(v);
        for (let c = 0; c < 3; c++) {
          assert.ok(Math.abs(before[c] - after[c]) < 1e-10, `class${c}: ${before[c]} vs ${after[c]}`);
        }
      }
    });

    test('toJSON に type / numClasses / trainedAt が含まれる', () => {
      const { X } = makeDataset(15, () => 0);
      const y = Array.from({ length: 15 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ epochs: 5, numClasses: 3 });
      m.train(X, y);
      const json = m.toJSON();

      assert.equal(json.type, 'SoftmaxClassifier');
      assert.equal(json.numClasses, 3);
      assert.equal(json.weights.length, 3);
      assert.ok(typeof json.trainedAt === 'string');
    });

    test('fromJSON で numClasses が復元される', () => {
      const { X } = makeDataset(15, () => 0);
      const y = Array.from({ length: 15 }, (_, i) => i % 3);
      const m = new SoftmaxClassifier({ numClasses: 3, epochs: 5 });
      m.train(X, y);
      const r = SoftmaxClassifier.fromJSON(m.toJSON());
      assert.equal(r.numClasses, 3);
    });
  });
});
