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
  const reasons   = _buildReasons(video, isPrePub, buzzRatio);

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
    reasons,
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

  // 学習データ上での方向性正解率
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = _sigmoid(_dot(weights, X[i])) >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  const trainDirectionalAcc = Math.round(correct / X.length * 1000) / 1000;

  const modelData = {
    weights:            Array.from(weights),
    sampleCount:        valid.length,
    hitCount,
    missCount,
    trainDirectionalAcc,
    trainedAt:          new Date().toISOString(),
  };

  const dir = path.dirname(MODEL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(modelData, null, 2));

  logger.info(
    `[YouTubePredictor] 訓練完了: ${valid.length}件 (hit:${hitCount} miss:${missCount}) ` +
    `方向性正解率:${(trainDirectionalAcc * 100).toFixed(1)}%`
  );
  return modelData;
}

// ── モデル状態確認 ─────────────────────────────────────────

function getModelStatus() {
  const data = _loadModel();
  if (!data) return { trained: false, sampleCount: 0 };
  return {
    trained:             true,
    sampleCount:         data.sampleCount         || 0,
    hitCount:            data.hitCount             || 0,
    missCount:           data.missCount            || 0,
    trainDirectionalAcc: data.trainDirectionalAcc  ?? null,
    trainedAt:           data.trainedAt,
  };
}

// ── スコア説明（主要因） ──────────────────────────────────

const _fmtNum = n => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${n}`;

// 各特徴量の影響度スコア(0..1)と説明を算出し、偏差の大きい上位3件を返す
function _buildReasons(video, isPrePub, buzzRatio) {
  const factors = [];

  if (isPrePub) {
    const subs     = video.subscriberCount || 0;
    const title    = video.title           || '';
    const tags     = Array.isArray(video.tags) ? video.tags : [];
    const duration = video.duration        || 0;

    // チャンネル規模
    let subScore;
    let subDetail;
    if      (subs >= 100000) { subScore = 0.80; subDetail = `登録者${_fmtNum(subs)}人（大規模、初動に有利）`; }
    else if (subs >=  10000) { subScore = 0.65; subDetail = `登録者${_fmtNum(subs)}人（中規模）`; }
    else if (subs >=   1000) { subScore = 0.52; subDetail = `登録者${_fmtNum(subs)}人（小規模）`; }
    else if (subs >       0) { subScore = 0.38; subDetail = `登録者${_fmtNum(subs)}人（超小規模）`; }
    else                     { subScore = 0.45; subDetail = `登録者数不明`; }
    factors.push({ name: 'チャンネル規模', score: subScore, detail: subDetail });

    // タイトル品質（複合）
    let titleScore = 0.45;
    const titleHints = [];
    if (title.length >= 8 && title.length <= 70) { titleScore += 0.12; titleHints.push('長さ適切'); }
    if (/[!！]/.test(title))                      { titleScore += 0.10; titleHints.push('感嘆符あり'); }
    if (/[?？]/.test(title))                      { titleScore += 0.04; titleHints.push('疑問符あり'); }
    const titlePreview = title.length > 20 ? `${title.slice(0, 20)}…` : (title || '（タイトル不明）');
    const titleDetail  = `「${titlePreview}」${titleHints.length ? `（${titleHints.join('・')}）` : '（該当なし）'}`;
    factors.push({ name: 'タイトル品質', score: Math.min(titleScore, 0.90), detail: titleDetail });

    // タグ数
    let tagScore;
    let tagDetail;
    if      (tags.length >= 15) { tagScore = 0.75; tagDetail = `${tags.length}個（SEO露出が高い）`; }
    else if (tags.length >=  5) { tagScore = 0.60; tagDetail = `${tags.length}個（標準的）`; }
    else if (tags.length >   0) { tagScore = 0.38; tagDetail = `${tags.length}個（少なめ、SEO弱）`; }
    else                        { tagScore = 0.28; tagDetail = `タグなし（SEO不利）`; }
    factors.push({ name: 'タグ数（SEO）', score: tagScore, detail: tagDetail });

    // 動画尺
    const durMin = duration > 0 ? Math.round(duration / 60) : null;
    let durScore;
    let durDetail;
    if      (duration >= 300 && duration <= 1200) { durScore = 0.65; durDetail = `${durMin}分（VOD最適帯 5〜20分）`; }
    else if (durMin !== null)                      { durScore = 0.40; durDetail = `${durMin}分（最適帯外）`; }
    else                                           { durScore = 0.45; durDetail = `動画尺不明`; }
    factors.push({ name: '動画尺', score: durScore, detail: durDetail });

  } else {
    const subs     = video.subscriberCount || 0;
    const views    = video.viewCount       || 0;
    const likes    = video.likeCount       || 0;
    const comments = video.commentCount    || 0;

    // buzz_ratio（最重要）
    if (buzzRatio !== null) {
      let buzzScore;
      let buzzDetail;
      if      (buzzRatio >= HIT_THRESHOLD)  { buzzScore = 0.90; buzzDetail = `${buzzRatio.toFixed(2)}（閾値 ${HIT_THRESHOLD} 超え → 高伸長）`; }
      else if (buzzRatio <= MISS_THRESHOLD) { buzzScore = 0.10; buzzDetail = `${buzzRatio.toFixed(2)}（閾値 ${MISS_THRESHOLD} 以下 → 低伸長）`; }
      else {
        buzzScore  = 0.1 + (buzzRatio - MISS_THRESHOLD) / (HIT_THRESHOLD - MISS_THRESHOLD) * 0.8;
        buzzDetail = `${buzzRatio.toFixed(2)}（中間帯、目安: 伸び中）`;
      }
      factors.push({ name: '視聴数/登録者比(buzz)', score: buzzScore, detail: buzzDetail });
    }

    // いいね率
    const likeRatio = views > 0 ? likes / views : 0;
    let likeScore;
    let likeDetail;
    if      (likeRatio >= 0.05) { likeScore = 0.80; likeDetail = `${(likeRatio * 100).toFixed(1)}%（高エンゲージ）`; }
    else if (likeRatio >= 0.02) { likeScore = 0.60; likeDetail = `${(likeRatio * 100).toFixed(1)}%（標準）`; }
    else if (likeRatio >  0)    { likeScore = 0.33; likeDetail = `${(likeRatio * 100).toFixed(1)}%（低め）`; }
    else                        { likeScore = 0.45; likeDetail = `いいね数不明`; }
    factors.push({ name: 'いいね率', score: likeScore, detail: likeDetail });

    // コメント率
    const commentRatio = views > 0 ? comments / views : 0;
    let commScore;
    let commDetail;
    if      (commentRatio >= 0.005) { commScore = 0.75; commDetail = `${(commentRatio * 100).toFixed(2)}%（活発）`; }
    else if (commentRatio >= 0.001) { commScore = 0.55; commDetail = `${(commentRatio * 100).toFixed(2)}%（標準）`; }
    else if (commentRatio >  0)     { commScore = 0.36; commDetail = `${(commentRatio * 100).toFixed(2)}%（低め）`; }
    else                            { commScore = 0.45; commDetail = `コメント数不明`; }
    factors.push({ name: 'コメント率', score: commScore, detail: commDetail });

    // チャンネル規模
    let subScore;
    let subDetail;
    if      (subs >= 100000) { subScore = 0.70; subDetail = `${_fmtNum(subs)}人（大規模）`; }
    else if (subs >=  10000) { subScore = 0.60; subDetail = `${_fmtNum(subs)}人（中規模）`; }
    else if (subs >=   1000) { subScore = 0.50; subDetail = `${_fmtNum(subs)}人`; }
    else if (subs >       0) { subScore = 0.38; subDetail = `${_fmtNum(subs)}人（超小規模）`; }
    else                     { subScore = 0.45; subDetail = `登録者数不明`; }
    factors.push({ name: 'チャンネル規模', score: subScore, detail: subDetail });
  }

  // 中立(0.5)からの偏差が大きい順に並べ、上位3件を返す
  factors.sort((a, b) => Math.abs(b.score - 0.5) - Math.abs(a.score - 0.5));
  return factors.slice(0, 3).map(f => ({
    factor: f.name,
    impact: f.score >= 0.5 ? 'positive' : 'negative',
    detail: f.detail,
  }));
}

// ── 改善提案ビルダー ──────────────────────────────────────

function _buildSuggestions(video, result) {
  const suggestions = [];
  for (const reason of result.reasons) {
    if (reason.impact !== 'negative') continue;
    switch (reason.factor) {
      case 'チャンネル規模':
        suggestions.push('コラボ・SNS告知・既存動画の最適化などで登録者を増やす');
        break;
      case 'タイトル品質':
        suggestions.push('タイトルを8〜70文字にし、感嘆符（!）や数字を入れてクリック率を高める');
        break;
      case 'タグ数（SEO）':
        suggestions.push('関連タグを5〜15個追加してサジェスト・SEO露出を改善する');
        break;
      case '動画尺':
        suggestions.push('動画尺を5〜20分（300〜1200秒）に調整してVOD最適帯に合わせる');
        break;
      case 'いいね率':
        suggestions.push('エンドカードや概要欄で「いいね！」を呼びかけてエンゲージメントを高める');
        break;
      case 'コメント率':
        suggestions.push('動画内で視聴者へ質問を投げかけてコメントを促す演出を加える');
        break;
      case '視聴数/登録者比(buzz)':
        suggestions.push('サムネイル・タイトルを見直してクリック率を改善し外部トラフィックを増やす');
        break;
    }
  }
  if (!result.usedML) {
    suggestions.push('`!youtube bulk-collect <genre>` → `!youtube train` でMLデータを追加すると予測精度が上がります');
  }
  return suggestions.slice(0, 3);
}

// ── Discord 表示用サマリー ─────────────────────────────────

const LABEL_JP = { hit: '伸びやすい', miss: '伸びにくい', unknown: '判定保留' };
const CONF_JP  = { high: '高', medium: '中', low: '低（参考値）' };

function buildSummary(video, result) {
  const pEmoji  = result.probability >= 60 ? '🟢' : result.probability <= 40 ? '🔴' : '🟡';
  const labelJp = LABEL_JP[result.label] ?? result.label;
  const confJp  = CONF_JP[result.confidence]  ?? result.confidence;
  const lines  = [
    `🎬 **YouTube ヒット予測**`,
    ``,
    `${pEmoji} **確率:** ${result.probability}%  \`${result.label}\`（${labelJp}）  (信頼度: ${result.confidence}／${confJp})`,
  ];

  // 主要因（上位3件）
  if (result.reasons && result.reasons.length > 0) {
    lines.push(``);
    lines.push(`🔍 **このスコアの主要因（上位${result.reasons.length}件）**`);
    for (const r of result.reasons) {
      const icon = r.impact === 'positive' ? '✅' : '⚠️';
      lines.push(`  ${icon} **${r.factor}:** ${r.detail}`);
    }
  }

  // 予測再生数レンジ
  if (result.viewRange) {
    const { low, median, high } = result.viewRange;
    lines.push(``);
    lines.push(`📊 **予測再生数レンジ** (7日間目安)`);
    lines.push(`  LOW    ${_fmtNum(low)}回`);
    lines.push(`  MEDIAN ${_fmtNum(median)}回 ← 中央値予測`);
    lines.push(`  HIGH   ${_fmtNum(high)}回`);
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
    lines.push(`  同ジャンル推定中央値: ${_fmtNum(genreMedian)}回`);
    if (result.viewRange) {
      const diff      = result.viewRange.median - genreMedian;
      const sign      = diff >= 0 ? '+' : '-';
      const pct       = Math.round(Math.abs(diff) / genreMedian * 100);
      const diffLabel = diff >= 0 ? '上回る' : '下回る';
      lines.push(`  あなたの予測中央値:   ${_fmtNum(result.viewRange.median)}回 (中央値比 ${sign}${pct}% ${diffLabel}見込み)`);
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

  // 注意点
  lines.push(``);
  lines.push(`⚠️ **注意点**`);
  lines.push(`  ・統計モデルによる推定値です。再生数の保証・約束ではありません`);
  lines.push(`  ・サムネイル・投稿時間・アルゴリズムなど、本モデルが考慮しない要因があります`);
  if (!result.usedML) {
    lines.push(`  ・MLデータ不足のため現在はルールベース予測です（参考値としてご利用ください）`);
  }

  // 次の改善提案
  const suggestions = _buildSuggestions(video, result);
  if (suggestions.length > 0) {
    lines.push(``);
    lines.push(`💡 **次の改善提案**`);
    for (const s of suggestions) {
      lines.push(`  • ${s}`);
    }
  }

  return lines.join('\n');
}

module.exports = { predict, train, getModelStatus, buildSummary };
