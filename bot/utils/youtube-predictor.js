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

// 信頼度ごとの確率レンジ幅（仕様書 §11 スコア設計）
const CONFIDENCE_INTERVALS = { high: 0.30, medium: 0.60, low: 1.00 };

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

// ── 投稿前判定 ────────────────────────────────────────────
// viewCount が 0 または未設定の場合は投稿前とみなす
function _isPrePublication(video) {
  return !video.viewCount || video.viewCount === 0;
}

// ── 投稿前ルールスコア（viewCount 不使用） ───────────────
// 投稿前に得られる特徴量（title/tags/duration/subscriberCount）のみで採点
function _ruleScorePrePub(video) {
  const subs     = video.subscriberCount || 0;
  const title    = video.title           || '';
  const tags     = Array.isArray(video.tags) ? video.tags : [];
  const duration = video.duration        || 0;

  let score = 0.45; // ベースライン（投稿前データのみ）

  // チャンネル規模（大きいほど初動が期待できる）
  if      (subs >= 100000) score += 0.15;
  else if (subs >=  10000) score += 0.08;
  else if (subs >=   1000) score += 0.03;

  // タイトル品質
  if (title.length >= 8 && title.length <= 70) score += 0.06;
  if (/[!！]/.test(title))                     score += 0.05;
  if (/[?？]/.test(title))                     score += 0.02;

  // タグ数（SEO・サジェスト露出）
  if (tags.length >= 5)  score += 0.05;
  if (tags.length >= 15) score += 0.03;

  // 動画尺（5〜20 分が VOD 最適帯）
  if (duration >= 300 && duration <= 1200) score += 0.05;

  return { score: Math.min(score, 0.90), buzzRatio: null };
}

// ── 再生数レンジ推定 ──────────────────────────────────────

// rawProbability (0..1) と confidence から再生数レンジ { low, median, high } を算出。
// subscriberCount が未知の場合は null を返す（データ不足）。
function _estimateViewRange(video, rawProbability, confidence) {
  const subs = video.subscriberCount || 0;
  if (!subs) return null;

  // rawProbability → expectedBuzzRatio（_ruleScore 線形補間の逆算）
  // ruleScore = 0.1 + (ratio - MISS) / (HIT - MISS) * 0.8
  // → ratio = (p - 0.1) / 0.8 * (HIT - MISS) + MISS
  const p = Math.max(0.1, Math.min(0.9, rawProbability));
  const expectedBuzzRatio = (p - 0.1) / 0.8 * (HIT_THRESHOLD - MISS_THRESHOLD) + MISS_THRESHOLD;
  const medianViews = Math.max(0, Math.round(subs * expectedBuzzRatio));

  const ci = CONFIDENCE_INTERVALS[confidence] ?? 1.00;
  return {
    low:    Math.max(0, Math.round(medianViews * (1 - ci))),
    median: medianViews,
    high:   Math.round(medianViews * (1 + ci)),
  };
}

// ジャンル推定中央値（HIT/MISS 中点 buzz_ratio を基準とした簡易ベンチマーク）
function _estimateBenchmark(video) {
  const subs = video.subscriberCount || 0;
  if (!subs) return null;

  const genreMedian = Math.round(subs * (HIT_THRESHOLD + MISS_THRESHOLD) / 2);
  return { genreMedian };
}

// ── 予測 API ─────────────────────────────────────────────

// video: { viewCount, likeCount, commentCount, title, description,
//          tags, duration, publishedAt, subscriberCount, videoId? }
// 戻り値:
//   { probability, label, confidence, buzzRatio, usedML, mlSamples }
function predict(video) {
  const isPrePub = _isPrePublication(video);
  const { score: ruleScore, buzzRatio } = isPrePub
    ? _ruleScorePrePub(video)
    : _ruleScore(video);
  const modelData = _loadModel();

  let mlScore  = null;
  let mlSamples = 0;

  // 投稿前はMLモデルを使用しない（like_ratio等のviewCount依存特徴量が0になり miss方向へバイアスするため）
  if (!isPrePub && modelData?.weights?.length === FEATURE_DIM) {
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

  const viewRange = _estimateViewRange(video, probability, confidence);
  const benchmark = _estimateBenchmark(video);

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
    viewRange,
    benchmark,
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

const LABEL_JP = { hit: '伸びやすい', miss: '伸びにくい', unknown: '判定保留' };
const CONF_JP  = { high: '高', medium: '中', low: '低（参考値）' };

function buildSummary(video, result) {
  const pEmoji  = result.probability >= 60 ? '🟢' : result.probability <= 40 ? '🔴' : '🟡';
  const fmt     = n => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${n}`;
  const labelJp = LABEL_JP[result.label] ?? result.label;
  const confJp  = CONF_JP[result.confidence]  ?? result.confidence;
  const lines  = [
    `🎬 **YouTube ヒット予測**`,
    ``,
    `${pEmoji} **確率:** ${result.probability}%  \`${result.label}\`（${labelJp}）  (信頼度: ${result.confidence}／${confJp})`,
  ];

  // 予測再生数レンジ
  if (result.viewRange) {
    const { low, median, high } = result.viewRange;
    lines.push(``);
    lines.push(`📊 **予測再生数レンジ** (7日間目安)`);
    lines.push(`  LOW    ${fmt(low)}回`);
    lines.push(`  MEDIAN ${fmt(median)}回 ← 中央値予測`);
    lines.push(`  HIGH   ${fmt(high)}回`);
    lines.push(`  ※ 統計的確率レンジ（確定値ではなく見込みによる予測）`);
  } else {
    lines.push(``);
    lines.push(`📊 **予測再生数レンジ:** 未確定（チャンネル登録者数の情報が必要です）`);
  }

  // 比較ベンチマーク
  if (result.benchmark) {
    const { genreMedian } = result.benchmark;
    lines.push(``);
    lines.push(`📈 **比較ベンチマーク（類似チャンネル推定中央値）**`);
    lines.push(`  同ジャンル推定中央値: ${fmt(genreMedian)}回`);
    if (result.viewRange) {
      const diff  = result.viewRange.median - genreMedian;
      const sign  = diff >= 0 ? '+' : '-';
      const pct   = Math.round(Math.abs(diff) / genreMedian * 100);
      const label = diff >= 0 ? '上回る' : '下回る';
      lines.push(`  あなたの予測中央値:   ${fmt(result.viewRange.median)}回 (中央値比 ${sign}${pct}% ${label}見込み)`);
    }
  }

  if (result.buzzRatio !== null) {
    lines.push(`📊 **buzz_ratio（登録者比の伸び）:** ${result.buzzRatio.toFixed(2)}  (目安: 5.0超→伸びやすい / 0.3未満→伸びにくい)`);
  }
  if (result.usedML) {
    lines.push(`🤖 ML モデル使用 (学習数: ${result.mlSamples}件)`);
  } else {
    lines.push(`📏 ルールベース予測 (MLデータ不足)`);
  }
  return lines.join('\n');
}

module.exports = { predict, train, getModelStatus, buildSummary };
