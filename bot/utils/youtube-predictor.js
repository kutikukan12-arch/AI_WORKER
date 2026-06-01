'use strict';

// YouTube 視聴予測モデル
// ai-model-v2.js は FEATURE_DIM=26 固定のため使用不可。
// ここでは YouTube 16次元専用のロジスティック回帰を内包する。

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const { encode, FEATURE_DIM } = require('./youtube-feature-extractor');
const { HIT_THRESHOLD, MISS_THRESHOLD } = require('./youtube-data-collector');

const MODEL_FILE    = path.join(__dirname, '..', '..', 'data', 'youtube-model.json');
const MIN_ML_SAMPLES = 20;
const MAX_ML_WEIGHT  = 0.7;  // ML の最大混合比率（残りはルールベース）

// ── 軽量ロジスティック回帰（全バッチ SGD） ─────────────────

function _sigmoid(x) {
  return 1.0 / (1.0 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function _dot(w, x) {
  let s = 0.0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

function _trainLR(X, y, { lr = 0.05, lambda = 0.001, epochs = 400 } = {}) {
  const dim     = X[0].length;
  const N       = X.length;
  const weights = new Float64Array(dim);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Float64Array(dim);
    for (let i = 0; i < N; i++) {
      const err = _sigmoid(_dot(weights, X[i])) - y[i];
      for (let j = 0; j < dim; j++) grad[j] += err * X[i][j];
    }
    for (let j = 0; j < dim; j++) {
      weights[j] -= lr * (grad[j] / N + lambda * weights[j]);
    }
  }
  return weights;
}

// ── モデル永続化 ──────────────────────────────────────────

function _loadModel() {
  try {
    if (fs.existsSync(MODEL_FILE)) {
      return JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
    }
  } catch (e) {
    logger.warn(`[YouTubePredictor] model load error: ${e.message}`);
  }
  return null;
}

// ── ルールベーススコア（buzz_ratio） ─────────────────────

function _ruleScore(video) {
  const views = video.viewCount       || 0;
  const subs  = video.subscriberCount || 0;
  if (!subs) return { score: 0.5, buzzRatio: null };

  const buzzRatio = views / subs;
  let score;
  if (buzzRatio >= HIT_THRESHOLD) {
    score = 0.9;
  } else if (buzzRatio <= MISS_THRESHOLD) {
    score = 0.1;
  } else {
    // MISS_THRESHOLD〜HIT_THRESHOLD の間を線形補間
    score = 0.1 + (buzzRatio - MISS_THRESHOLD) / (HIT_THRESHOLD - MISS_THRESHOLD) * 0.8;
  }
  return { score, buzzRatio };
}

// ── 予測 API ─────────────────────────────────────────────

// video: { viewCount, likeCount, commentCount, title, description,
//          tags, duration, publishedAt, subscriberCount, videoId? }
// 戻り値:
//   { probability, label, confidence, buzzRatio, usedML, mlSamples }
function predict(video) {
  const { score: ruleScore, buzzRatio } = _ruleScore(video);
  const modelData = _loadModel();

  let mlScore  = null;
  let mlSamples = 0;

  if (modelData?.weights?.length === FEATURE_DIM) {
    const weights = new Float64Array(modelData.weights);
    mlScore   = _sigmoid(_dot(weights, encode(video)));
    mlSamples = modelData.sampleCount || 0;
  }

  let probability;
  if (mlScore !== null && mlSamples >= MIN_ML_SAMPLES) {
    const mlWeight = Math.min(mlSamples / 100, MAX_ML_WEIGHT);
    probability = mlScore * mlWeight + ruleScore * (1 - mlWeight);
  } else {
    probability = ruleScore;
  }

  const label = probability >= 0.6 ? 'hit' : probability <= 0.4 ? 'miss' : 'unknown';
  const confidence = mlSamples >= MIN_ML_SAMPLES ? 'medium' : 'low';

  logger.debug(
    `[YouTubePredictor] ${video.videoId || '?'} ` +
    `p=${probability.toFixed(3)} label=${label} buzz=${buzzRatio?.toFixed(2) ?? 'n/a'}`
  );

  return {
    probability: Math.round(probability * 100),
    label,
    confidence,
    buzzRatio,
    usedML:    mlSamples >= MIN_ML_SAMPLES,
    mlSamples,
  };
}

// ── 訓練 API ─────────────────────────────────────────────

// samples: [{ ...video fields, label: 'hit'|'miss' }]
function train(samples) {
  const valid = samples.filter(s => s.label === 'hit' || s.label === 'miss');
  if (valid.length < 10) {
    logger.warn(`[YouTubePredictor] 訓練サンプル不足: ${valid.length}件（最低10件必要）`);
    return null;
  }

  const X = valid.map(s => encode(s));
  const y = valid.map(s => (s.label === 'hit' ? 1 : 0));

  const weights = _trainLR(X, y);

  const hitCount  = y.filter(v => v === 1).length;
  const missCount = y.filter(v => v === 0).length;

  const modelData = {
    weights:     Array.from(weights),
    sampleCount: valid.length,
    hitCount,
    missCount,
    trainedAt:   new Date().toISOString(),
  };

  const dir = path.dirname(MODEL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(modelData, null, 2));

  logger.info(
    `[YouTubePredictor] 訓練完了: ${valid.length}件 (hit:${hitCount} miss:${missCount})`
  );
  return modelData;
}

// ── モデル状態確認 ─────────────────────────────────────────

function getModelStatus() {
  const data = _loadModel();
  if (!data) return { trained: false, sampleCount: 0 };
  return {
    trained:     true,
    sampleCount: data.sampleCount || 0,
    hitCount:    data.hitCount    || 0,
    missCount:   data.missCount   || 0,
    trainedAt:   data.trainedAt,
  };
}

// ── Discord 表示用サマリー ─────────────────────────────────

function buildSummary(video, result) {
  const pEmoji = result.probability >= 60 ? '🟢' : result.probability <= 40 ? '🔴' : '🟡';
  const lines  = [
    `🎬 **YouTube ヒット予測**`,
    ``,
    `${pEmoji} **確率:** ${result.probability}%  \`${result.label}\`  (信頼度: ${result.confidence})`,
  ];
  if (result.buzzRatio !== null) {
    lines.push(`📊 **buzz_ratio:** ${result.buzzRatio.toFixed(2)}  (hit>5.0 / miss<0.3)`);
  }
  if (result.usedML) {
    lines.push(`🤖 ML モデル使用 (学習数: ${result.mlSamples}件)`);
  } else {
    lines.push(`📏 ルールベース予測 (MLデータ不足)`);
  }
  return lines.join('\n');
}

module.exports = { predict, train, getModelStatus, buildSummary };
