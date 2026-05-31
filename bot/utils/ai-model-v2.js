'use strict';

// =====================================================
// ai-model-v2.js — AI 予測 ML モデル群
//
// 実装モデル:
//   LogisticRegression  — タスク成功確率（二値分類）
//   LinearRegression    — 完了時間推定（回帰）
//   SoftmaxClassifier   — AI ルーティング（3クラス分類）
//
// 学習アルゴリズム:
//   ミニバッチ SGD + L2 正規化
//   収束は epochs 数で制御（早期停止なし）
//
// 依存: ai-feature-extractor.js（FEATURE_DIM のみ）
// =====================================================

const { FEATURE_DIM } = require('./ai-feature-extractor');

// ── 数値計算ヘルパー ──────────────────────────────────

function _sigmoid(x) {
  return 1.0 / (1.0 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function _softmax(logits) {
  const maxL = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxL));
  const sum  = exps.reduce((a, b) => a + b, 0.0);
  return exps.map(e => e / sum);
}

function _dot(a, b) {
  let s = 0.0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// インデックスをシャッフルして配列を返す（Fisher-Yates）
function _shuffle(n, rng = Math.random) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

// ─────────────────────────────────────────────────────
// LogisticRegression — 二値分類（タスク成功確率）
//
// 学習: Binary Cross-Entropy + L2 ミニバッチ SGD
// 予測: P(success) ∈ [0, 1]
// ─────────────────────────────────────────────────────
class LogisticRegression {
  constructor({ lr = 0.05, lambda = 0.001, epochs = 200, batchSize = 16 } = {}) {
    this.lr        = lr;
    this.lambda    = lambda;
    this.epochs    = epochs;
    this.batchSize = batchSize;
    this.weights   = null;
    this.trainedAt = null;
    this.lossHistory = [];
  }

  train(X, y) {
    if (!X || X.length === 0) throw new Error('学習データが空です');
    if (X.length !== y.length) throw new Error('X と y の件数が一致しません');

    const N = X.length;
    this.weights = new Float64Array(FEATURE_DIM); // ゼロ初期化
    this.lossHistory = [];

    for (let epoch = 0; epoch < this.epochs; epoch++) {
      const order = _shuffle(N);
      let epochLoss = 0.0;

      for (let bStart = 0; bStart < N; bStart += this.batchSize) {
        const batch = order.slice(bStart, bStart + this.batchSize);
        const grad  = new Float64Array(FEATURE_DIM);

        for (const i of batch) {
          const p   = _sigmoid(_dot(this.weights, X[i]));
          const err = p - y[i];
          epochLoss += -(y[i] * Math.log(p + 1e-10) + (1 - y[i]) * Math.log(1 - p + 1e-10));
          for (let j = 0; j < FEATURE_DIM; j++) {
            grad[j] += err * X[i][j];
          }
        }

        const bs = batch.length;
        for (let j = 0; j < FEATURE_DIM; j++) {
          this.weights[j] -= this.lr * (grad[j] / bs + this.lambda * this.weights[j]);
        }
      }

      this.lossHistory.push(epochLoss / N);
    }

    this.trainedAt = new Date().toISOString();
    return this;
  }

  predict(x) {
    return _sigmoid(_dot(this.weights, x));
  }

  toJSON() {
    return {
      type: 'LogisticRegression',
      weights: Array.from(this.weights),
      lr: this.lr, lambda: this.lambda,
      epochs: this.epochs, batchSize: this.batchSize,
      trainedAt: this.trainedAt,
    };
  }

  static fromJSON(obj) {
    const m = new LogisticRegression({
      lr: obj.lr, lambda: obj.lambda, epochs: obj.epochs, batchSize: obj.batchSize,
    });
    m.weights    = new Float64Array(obj.weights);
    m.trainedAt  = obj.trainedAt;
    return m;
  }
}

// ─────────────────────────────────────────────────────
// LinearRegression — 回帰（タスク完了時間推定）
//
// 学習: MSE + L2 ミニバッチ SGD、y を標準化して学習
// 予測: 推定時間（分）
// ─────────────────────────────────────────────────────
class LinearRegression {
  constructor({ lr = 0.005, lambda = 0.001, epochs = 200, batchSize = 16 } = {}) {
    this.lr        = lr;
    this.lambda    = lambda;
    this.epochs    = epochs;
    this.batchSize = batchSize;
    this.weights   = null;
    this.yMean     = 0;
    this.yStd      = 1;
    this.trainedAt = null;
    this.lossHistory = [];
  }

  train(X, y) {
    if (!X || X.length === 0) throw new Error('学習データが空です');

    const N = X.length;

    // y を標準化（μ=0, σ=1）して学習安定化
    this.yMean = y.reduce((a, b) => a + b, 0) / N;
    const variance = y.reduce((a, b) => a + (b - this.yMean) ** 2, 0) / N;
    this.yStd  = Math.sqrt(variance) || 1.0;
    const yNorm = y.map(v => (v - this.yMean) / this.yStd);

    this.weights = new Float64Array(FEATURE_DIM);
    this.lossHistory = [];

    for (let epoch = 0; epoch < this.epochs; epoch++) {
      const order = _shuffle(N);
      let epochLoss = 0.0;

      for (let bStart = 0; bStart < N; bStart += this.batchSize) {
        const batch = order.slice(bStart, bStart + this.batchSize);
        const grad  = new Float64Array(FEATURE_DIM);

        for (const i of batch) {
          const pred = _dot(this.weights, X[i]);
          const err  = pred - yNorm[i];
          epochLoss += err * err;
          for (let j = 0; j < FEATURE_DIM; j++) {
            grad[j] += 2 * err * X[i][j];
          }
        }

        const bs = batch.length;
        for (let j = 0; j < FEATURE_DIM; j++) {
          this.weights[j] -= this.lr * (grad[j] / bs + this.lambda * this.weights[j]);
        }
      }

      this.lossHistory.push(epochLoss / N);
    }

    this.trainedAt = new Date().toISOString();
    return this;
  }

  predict(x) {
    return _dot(this.weights, x) * this.yStd + this.yMean;
  }

  toJSON() {
    return {
      type: 'LinearRegression',
      weights: Array.from(this.weights),
      lr: this.lr, lambda: this.lambda,
      epochs: this.epochs, batchSize: this.batchSize,
      yMean: this.yMean, yStd: this.yStd,
      trainedAt: this.trainedAt,
    };
  }

  static fromJSON(obj) {
    const m = new LinearRegression({
      lr: obj.lr, lambda: obj.lambda, epochs: obj.epochs, batchSize: obj.batchSize,
    });
    m.weights   = new Float64Array(obj.weights);
    m.yMean     = obj.yMean;
    m.yStd      = obj.yStd;
    m.trainedAt = obj.trainedAt;
    return m;
  }
}

// ─────────────────────────────────────────────────────
// SoftmaxClassifier — 多クラス分類（AI ルーティング）
//
// 学習: Softmax Cross-Entropy + L2 ミニバッチ SGD
// 予測: クラスごとの確率ベクトル
// ─────────────────────────────────────────────────────
class SoftmaxClassifier {
  constructor({ lr = 0.05, lambda = 0.001, epochs = 200, batchSize = 16, numClasses = 3 } = {}) {
    this.lr         = lr;
    this.lambda     = lambda;
    this.epochs     = epochs;
    this.batchSize  = batchSize;
    this.numClasses = numClasses;
    this.weights    = null; // [numClasses][FEATURE_DIM]
    this.trainedAt  = null;
    this.lossHistory = [];
  }

  train(X, y) {
    // y: クラスインデックス配列（0, 1, 2, ...）
    if (!X || X.length === 0) throw new Error('学習データが空です');

    const N = X.length;
    const C = this.numClasses;
    this.weights = Array.from({ length: C }, () => new Float64Array(FEATURE_DIM));
    this.lossHistory = [];

    for (let epoch = 0; epoch < this.epochs; epoch++) {
      const order = _shuffle(N);
      let epochLoss = 0.0;

      for (let bStart = 0; bStart < N; bStart += this.batchSize) {
        const batch = order.slice(bStart, bStart + this.batchSize);
        const grads = Array.from({ length: C }, () => new Float64Array(FEATURE_DIM));

        for (const i of batch) {
          const logits = this.weights.map(w => _dot(w, X[i]));
          const probs  = _softmax(logits);
          epochLoss -= Math.log(probs[y[i]] + 1e-10);

          for (let c = 0; c < C; c++) {
            const err = probs[c] - (c === y[i] ? 1 : 0);
            for (let j = 0; j < FEATURE_DIM; j++) {
              grads[c][j] += err * X[i][j];
            }
          }
        }

        const bs = batch.length;
        for (let c = 0; c < C; c++) {
          for (let j = 0; j < FEATURE_DIM; j++) {
            this.weights[c][j] -= this.lr * (grads[c][j] / bs + this.lambda * this.weights[c][j]);
          }
        }
      }

      this.lossHistory.push(epochLoss / N);
    }

    this.trainedAt = new Date().toISOString();
    return this;
  }

  predict(x) {
    const logits = this.weights.map(w => _dot(w, x));
    return _softmax(logits);
  }

  toJSON() {
    return {
      type: 'SoftmaxClassifier',
      weights: this.weights.map(w => Array.from(w)),
      lr: this.lr, lambda: this.lambda,
      epochs: this.epochs, batchSize: this.batchSize,
      numClasses: this.numClasses,
      trainedAt: this.trainedAt,
    };
  }

  static fromJSON(obj) {
    const m = new SoftmaxClassifier({
      lr: obj.lr, lambda: obj.lambda, epochs: obj.epochs,
      batchSize: obj.batchSize, numClasses: obj.numClasses,
    });
    m.weights   = obj.weights.map(w => new Float64Array(w));
    m.trainedAt = obj.trainedAt;
    return m;
  }
}

module.exports = { LogisticRegression, LinearRegression, SoftmaxClassifier };
