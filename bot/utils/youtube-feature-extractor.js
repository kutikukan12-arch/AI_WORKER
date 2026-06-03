'use strict';

// 16次元特徴量ベクトル
// ai-model-v2.js の 26次元タスク特徴量とは独立した YouTube 専用エンコーダ

const FEATURE_NAMES = [
  'like_ratio',          // likeCount / viewCount (0-1)
  'comment_ratio',       // commentCount / viewCount × 10 (0-1)
  'title_len_norm',      // title.length / 100 (0-1)
  'title_has_excl',      // "!" or "！" を含む
  'title_has_quest',     // "?" or "？" を含む
  'title_emoji_norm',    // emoji 数 / 5 (0-1)
  'title_caps_ratio',    // 全大文字単語の割合 (0-1)
  'tag_count_norm',      // tags.length / 30 (0-1)
  'desc_len_norm',       // description.length / 2000 (0-1)
  'duration_norm',       // duration(秒) / 3600 (0-1)
  'published_hour_sin',  // 投稿時刻 cyclic sin
  'published_hour_cos',  // 投稿時刻 cyclic cos
  'published_dow_sin',   // 曜日 cyclic sin
  'published_dow_cos',   // 曜日 cyclic cos
  'sub_magnitude_norm',  // log10(subscribers+1) / 8 (0-1)
  'bias',                // 常に 1.0
];

const FEATURE_DIM = FEATURE_NAMES.length; // 16

const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;

function _emojiCount(str) {
  return (str.match(EMOJI_RE) || []).length;
}

function _capsRatio(str) {
  const words = str.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const capsWords = words.filter(w => /[A-Z]/.test(w) && w === w.toUpperCase());
  return capsWords.length / words.length;
}

// video: { viewCount, likeCount, commentCount, title, description,
//          tags, duration, publishedAt, subscriberCount }
function encode(video) {
  const vec = new Float64Array(FEATURE_DIM);
  let idx = 0;

  const views    = Math.max(video.viewCount    || 0, 1);
  const likes    = video.likeCount    || 0;
  const comments = video.commentCount || 0;
  const title    = video.title        || '';
  const desc     = video.description  || '';
  const tags     = video.tags         || [];
  const duration = video.duration     || 0;
  const subs     = Math.max(video.subscriberCount || 0, 1);

  // エンゲージメント比率
  vec[idx++] = Math.min(likes    / views, 1.0);
  vec[idx++] = Math.min((comments / views) * 10, 1.0);

  // タイトル特徴量
  vec[idx++] = Math.min(title.length / 100, 1.0);
  vec[idx++] = /[!！]/.test(title) ? 1.0 : 0.0;
  vec[idx++] = /[?？]/.test(title) ? 1.0 : 0.0;
  vec[idx++] = Math.min(_emojiCount(title) / 5, 1.0);
  vec[idx++] = _capsRatio(title);

  // コンテンツ特徴量
  vec[idx++] = Math.min(tags.length / 30, 1.0);
  vec[idx++] = Math.min(desc.length / 2000, 1.0);
  vec[idx++] = Math.min(duration / 3600, 1.0);

  // 投稿時刻 cyclic 特徴量
  const pub  = video.publishedAt ? new Date(video.publishedAt) : new Date();
  const hour = pub.getUTCHours();
  const dow  = pub.getUTCDay();
  vec[idx++] = Math.sin(2 * Math.PI * hour / 24);
  vec[idx++] = Math.cos(2 * Math.PI * hour / 24);
  vec[idx++] = Math.sin(2 * Math.PI * dow  / 7);
  vec[idx++] = Math.cos(2 * Math.PI * dow  / 7);

  // チャンネル規模
  vec[idx++] = Math.min(Math.log10(subs + 1) / 8, 1.0);

  // バイアス項
  vec[idx++] = 1.0;

  return vec;
}

// ── 投稿前専用エンコーダ（viewCount/likeCount/commentCount 不使用） ──────
// like_ratio, comment_ratio を除いた 15 次元ベクトル
const FEATURE_NAMES_PRE = [
  'title_len_norm',
  'title_has_excl',
  'title_has_quest',
  'title_emoji_norm',
  'title_caps_ratio',
  'tag_count_norm',
  'desc_len_norm',
  'duration_norm',
  'published_hour_sin',
  'published_hour_cos',
  'published_dow_sin',
  'published_dow_cos',
  'sub_magnitude_norm',
  'genre_hit_rate',      // ジャンル別過去ヒット率 (0-1)
  'bias',
];

const FEATURE_DIM_PRE = FEATURE_NAMES_PRE.length; // 15

// video: { title, description, tags, duration, publishedAt, subscriberCount }
// genreHitRate: ジャンルの過去ヒット率（モデルから取得、不明時は 0.5）
function encodePre(video, genreHitRate = 0.5) {
  const vec = new Float64Array(FEATURE_DIM_PRE);
  let idx = 0;

  const title    = video.title       || '';
  const desc     = video.description || '';
  const tags     = video.tags        || [];
  const duration = video.duration    || 0;
  const subs     = Math.max(video.subscriberCount || 0, 1);

  vec[idx++] = Math.min(title.length / 100, 1.0);
  vec[idx++] = /[!！]/.test(title) ? 1.0 : 0.0;
  vec[idx++] = /[?？]/.test(title) ? 1.0 : 0.0;
  vec[idx++] = Math.min(_emojiCount(title) / 5, 1.0);
  vec[idx++] = _capsRatio(title);

  vec[idx++] = Math.min(tags.length / 30, 1.0);
  vec[idx++] = Math.min(desc.length / 2000, 1.0);
  vec[idx++] = Math.min(duration / 3600, 1.0);

  const pub  = video.publishedAt ? new Date(video.publishedAt) : new Date();
  const hour = pub.getUTCHours();
  const dow  = pub.getUTCDay();
  vec[idx++] = Math.sin(2 * Math.PI * hour / 24);
  vec[idx++] = Math.cos(2 * Math.PI * hour / 24);
  vec[idx++] = Math.sin(2 * Math.PI * dow  / 7);
  vec[idx++] = Math.cos(2 * Math.PI * dow  / 7);

  vec[idx++] = Math.min(Math.log10(subs + 1) / 8, 1.0);
  vec[idx++] = Math.min(Math.max(genreHitRate, 0), 1.0);
  vec[idx++] = 1.0; // bias

  return vec;
}

module.exports = { encode, FEATURE_NAMES, FEATURE_DIM, encodePre, FEATURE_NAMES_PRE, FEATURE_DIM_PRE };
