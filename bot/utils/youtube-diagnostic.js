'use strict';
// =====================================================
// youtube-diagnostic.js — YouTube 投稿前診断エンジン v2
//
// 実データ学習型診断AI: 固定ルールではなくMLパイプラインを主軸とする。
//
// フロー:
//   input
//     ↓
//   encodePre()  ← youtube-feature-extractor
//     ↓ 15次元特徴ベクトル
//   youtube-model-pre.json  ← 学習済み重みを直接読み込む
//     ↓ 軸別 partial dot product → sigmoid
//   6軸診断スコア
//     ↓
//   改善提案生成
//
// cold-start fallback:
//   モデルなし / 学習サンプル不足 (< 20件) の場合のみ
//   固定ルール (_scoreCTR 等) を使用。
//
// 禁止事項（設計方針）:
//   - 再生数レンジ表示: 禁止
//   - YouTube Data API 診断時呼び出し: 禁止
//   - LLM / Claude API 診断時呼び出し: 禁止
// =====================================================

const fs   = require('fs');
const path = require('path');
const { encodePre, FEATURE_DIM_PRE } = require('./youtube-feature-extractor');

const MODEL_FILE_PRE = path.join(__dirname, '..', '..', 'data', 'youtube-model-pre.json');
const MIN_ML_SAMPLES = 20;

// ─────────────────────────────────────────────────────
// FEATURE_NAMES_PRE の各インデックス（youtube-feature-extractor.js と同順）
//  0:title_len_norm  1:title_has_excl  2:title_has_quest  3:title_emoji_norm
//  4:title_caps_ratio  5:tag_count_norm  6:desc_len_norm  7:duration_norm
//  8:pub_hour_sin  9:pub_hour_cos  10:pub_dow_sin  11:pub_dow_cos
//  12:sub_magnitude_norm  13:genre_hit_rate  14:bias
//
// 軸ごとの利用特徴インデックス（bias=14 は除外）
// ─────────────────────────────────────────────────────
const AXIS_FEATURE_IDX = {
  ctr:        [0, 1, 2, 3, 4],      // タイトル長・感嘆符・疑問符・絵文字・大文字
  retention:  [6, 7, 12, 13],       // 説明文長・動画尺・チャンネル規模・ジャンルヒット率
  seo:        [0, 5, 6],            // タイトル長・タグ数・説明文長
  emotion:    [1, 2, 3, 4],         // 感嘆符・疑問符・絵文字・大文字比率
  timing:     [8, 9, 10, 11],       // 投稿時刻 cyclic (hour_sin/cos, dow_sin/cos)
  uniqueness: [0, 3, 5, 13],        // タイトル長・絵文字・タグ数・ジャンルヒット率
};

// partial activation の sigmoid spread 増幅係数
// 小さい重み値でも 0-100 の広い範囲に展開するためのスケール
const ML_AXIS_SCALE = 3.0;

// ─── ランク定義 ───────────────────────────────────────
const RANK_TABLE = [
  { min: 90, rank: 'S',  label: '🏆 最高水準' },
  { min: 80, rank: 'A+', label: '⭐ 投稿準備 優秀' },
  { min: 70, rank: 'A',  label: '✅ 投稿準備 良好' },
  { min: 60, rank: 'B+', label: '📈 あと少しで伸びる' },
  { min: 50, rank: 'B',  label: '🔧 改善で大きく変わる' },
  { min: 40, rank: 'C+', label: '⚠️ 要改善（CTR/SEO）' },
  { min: 30, rank: 'C',  label: '⚠️ 要改善（複数軸）' },
  { min: 0,  rank: 'D',  label: '🔴 大幅な見直しを推奨' },
];

function _toRank(score) {
  for (const r of RANK_TABLE) {
    if (score >= r.min) return { rank: r.rank, label: r.label };
  }
  return { rank: 'D', label: '🔴 大幅な見直しを推奨' };
}

function _sigmoid(x) {
  return 1.0 / (1.0 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function _scoreBar(score) {
  const filled = Math.round(score / 20);
  return '🟦'.repeat(filled) + '⬜'.repeat(5 - filled) + ` ${score}`;
}

// ─────────────────────────────────────────────────────
// モデル読み込み
// ─────────────────────────────────────────────────────
function _loadPreModel() {
  try {
    if (fs.existsSync(MODEL_FILE_PRE)) {
      return JSON.parse(fs.readFileSync(MODEL_FILE_PRE, 'utf8'));
    }
  } catch { /* ignore - cold start にフォールバック */ }
  return null;
}

// ジャンルのヒット率を preModel から取得（predictor と同ロジック）
function _lookupGenreHitRate(genre, preModel) {
  const rates = preModel?.genreHitRates;
  if (!rates) return 0.5;
  if (genre && rates[genre] !== undefined) return rates[genre];
  return rates['_overall'] ?? 0.5;
}

// ─────────────────────────────────────────────────────
// ML 軸スコア計算
//
// features: encodePre() が返す Float64Array (FEATURE_DIM_PRE 次元)
// weights:  モデルの学習済み重み配列 (同次元)
//
// 各軸のフィーチャ部分集合の dot product に sigmoid(x * ML_AXIS_SCALE) を適用し
// 0〜100 のスコアへ変換する。
//
// 設計根拠:
//   - bias(14) は全軸共通の切片なので軸ごとの寄与に含めない
//   - ML_AXIS_SCALE=3.0 で小さな weight でも十分な spread を確保
//   - 同一特徴量が複数軸で利用されるのは意図的
//     (e.g. tag_count はSEO軸でも uniqueness軸でも異なる文脈で寄与)
// ─────────────────────────────────────────────────────
function _computeMLAxisScores(features, weights) {
  const scores = {};
  for (const [axis, indices] of Object.entries(AXIS_FEATURE_IDX)) {
    let activation = 0;
    for (const i of indices) {
      activation += features[i] * weights[i];
    }
    scores[axis] = Math.min(
      Math.max(Math.round(_sigmoid(activation * ML_AXIS_SCALE) * 100), 0),
      95
    );
  }
  return scores;
}

// ─────────────────────────────────────────────────────
// Cold-start フォールバック: 固定ルールによる6軸スコア
//
// モデルなし / 学習データ不足の場合のみ使用。
// 特徴量値は encodePre() の結果を直接利用することで
// feature-extractor との一貫性を保つ。
// ─────────────────────────────────────────────────────
function _computeFallbackAxisScores(features, title, description, tags, duration, publishedAt) {
  // features を直接使用することで固定ルールと encodePre() が一致する
  const f = features; // alias

  // CTR: title_len(0) + excl(1) + quest(2) + emoji(3) + caps(4)
  const ctrRaw = (
    (f[0] >= 0.08 && f[0] <= 0.6 ? 0.5 : f[0] < 0.08 ? 0.1 : 0.3) +  // 8〜60文字最適
    f[1] * 0.4 +   // 感嘆符
    f[2] * 0.3 +   // 疑問符
    (f[3] > 0 && f[3] <= 0.6 ? f[3] * 0.4 : f[3] > 0.6 ? 0.25 : 0) + // 絵文字1〜3個
    f[4] * 0.2     // 大文字比率
  );

  // Retention: desc_len(6) + duration_norm(7) + sub_magnitude(12)
  const durOptimal = f[7] >= 0.083 && f[7] <= 0.333; // 5〜20分
  const retRaw = (
    f[6] * 0.4 +
    (durOptimal ? 0.5 : f[7] > 0 ? 0.2 : 0) +
    f[12] * 0.3
  );

  // SEO: title_len(0) + tag_count_norm(5) + desc_len(6)
  const seoRaw = f[0] * 0.25 + f[5] * 0.55 + f[6] * 0.35;

  // Emotion: excl(1) + quest(2) + emoji(3) + caps(4)
  const emoRaw = f[1] * 0.5 + f[2] * 0.3 + f[3] * 0.35 + f[4] * 0.2;

  // Timing: cyclic 特徴量から UTC時刻・曜日を復元してスコア化
  // sin/cos → 各時刻の最適度に変換
  const hourSin = f[8], hourCos = f[9];
  const dowSin  = f[10], dowCos = f[11];
  const hour    = Math.round((Math.atan2(hourSin, hourCos) / (2 * Math.PI) * 24 + 24) % 24);
  const dow     = Math.round((Math.atan2(dowSin,  dowCos)  / (2 * Math.PI) * 7  + 7)  % 7);
  // JST 18-23 = UTC 9-14 → 高スコア; 金(5)土(6) → 高スコア
  const timingHour = (hour >= 9 && hour <= 14) ? 0.7 : (hour >= 7 && hour <= 9) ? 0.5 : 0.3;
  const timingDow  = (dow === 5 || dow === 6) ? 0.7 : (dow === 0) ? 0.6 : (dow === 4) ? 0.5 : 0.35;
  const timRaw     = !publishedAt ? 0.5 : timingHour * 0.55 + timingDow * 0.45;

  // Uniqueness: title_len(0) + emoji(3) + tag_count(5)
  const uniRaw = f[0] * 0.3 + f[3] * 0.3 + f[5] * 0.4;

  // 0-1 の生スコアを 0-95 に変換（sigmoid でクランプ）
  const toScore = raw => Math.min(Math.max(Math.round(_sigmoid(raw * 2 - 1) * 100), 0), 95);

  return {
    ctr:        toScore(ctrRaw),
    retention:  toScore(retRaw),
    seo:        toScore(seoRaw),
    emotion:    toScore(emoRaw),
    timing:     !publishedAt ? 50 : toScore(timRaw),
    uniqueness: toScore(uniRaw),
  };
}

// ─────────────────────────────────────────────────────
// 改善提案生成（固定ルール / ML 共通）
// ─────────────────────────────────────────────────────
const IMPROVEMENT_MAP = {
  ctr: [
    { threshold: 50, text: 'タイトルに感嘆符「！」または疑問符「？」を追加してクリック衝動を高めましょう' },
    { threshold: 65, text: 'タイトル長を20〜60文字に調整すると一覧表示での視認性が上がります' },
    { threshold: 75, text: 'タイトルの先頭に絵文字を1〜2個追加すると一覧での目立ちやすさが上がります' },
  ],
  retention: [
    { threshold: 50, text: '動画尺を5〜20分（300〜1200秒）に調整するとアルゴリズム上の評価が安定しやすいです' },
    { threshold: 65, text: '説明文に200文字以上の内容（動画の見どころ・目次）を書くと直帰率が改善されます' },
    { threshold: 75, text: '冒頭30秒の引きを意識した構成にすると離脱率の改善が期待できます' },
  ],
  seo: [
    { threshold: 50, text: 'タグを最低でも10個以上設定しましょう。ジャンル名・チャンネル名・動画テーマを含めます' },
    { threshold: 65, text: '説明文の冒頭2〜3行にタイトルと同じキーワードを含めると検索流入が増えやすくなります' },
    { threshold: 75, text: 'タグに「ロングテールキーワード」を追加すると競合の少ない流入が取れます' },
  ],
  emotion: [
    { threshold: 50, text: 'タイトルに「衝撃」「やばい」「初見」など感情を動かす言葉を1つ入れましょう' },
    { threshold: 65, text: '視聴者が「気になる」と感じる疑問形タイトル（〜してみた結果…？）が効果的です' },
    { threshold: 75, text: '具体的な状況説明より「感情体験の予告」をタイトルに込めると視聴動機が高まります' },
  ],
  timing: [
    { threshold: 50, text: '投稿時刻を金〜日の JST 18:00〜22:00 に合わせると視聴者活動ピークをとらえやすいです' },
    { threshold: 65, text: '週中（月〜木）投稿の場合は JST 21:00 前後が比較的有効な帯です' },
  ],
  uniqueness: [
    { threshold: 50, text: 'タイトルに【】〔〕などの括弧で補足情報を加え、他チャンネルと差別化しましょう' },
    { threshold: 65, text: 'シリーズ動画の場合は「#1」「第1回」を明示するとリピート視聴につながりやすいです' },
    { threshold: 75, text: 'ニッチなキーワードタグを5個以上追加することで競合の薄い流入が取れます' },
  ],
};

const AXIS_LABEL = {
  ctr:       'CTR適性',
  retention: '視聴維持適性',
  seo:       'SEO強度',
  emotion:   '感情フック',
  timing:    '投稿タイミング',
  uniqueness:'競合差別化',
};

function _buildImprovements(scores) {
  const suggestions = [];
  for (const [axis, rules] of Object.entries(IMPROVEMENT_MAP)) {
    const score   = scores[axis];
    const matched = rules.filter(r => score < r.threshold);
    if (matched.length === 0) continue;
    const priority = score < 50 ? 'high' : score < 65 ? 'medium' : 'low';
    suggestions.push({ axis, axisLabel: AXIS_LABEL[axis], score, priority, text: matched[0].text });
  }
  suggestions.sort((a, b) => a.score - b.score);
  return suggestions.slice(0, 3);
}

// ─────────────────────────────────────────────────────
// diagnose(input) — メイン診断関数
//
// input: {
//   title:            string  (必須)
//   genre?:           string
//   description?:     string
//   tags?:            string[]
//   duration?:        number  (秒)
//   subscriberCount?: number
//   publishedAt?:     string  (ISO8601)
// }
//
// 戻り値: {
//   ok:          boolean
//   totalScore:  number (0-100)
//   rank:        string
//   rankLabel:   string
//   scores:      { ctr, retention, seo, emotion, timing, uniqueness }
//   improvements:[{ axis, axisLabel, score, priority, text }]
//   modelInfo:   { usedML, mlSamples, mlProb }
// }
// ─────────────────────────────────────────────────────
function diagnose(input) {
  if (!input || !String(input.title || '').trim()) {
    return {
      ok:   false,
      text: '❌ タイトルは必須です。\n`!youtube diagnose title="タイトル"` で診断できます。',
    };
  }

  const title       = String(input.title || '').trim();
  const description = String(input.description || '');
  const tags        = Array.isArray(input.tags) ? input.tags : [];
  const duration    = Number(input.duration    || 0);
  const subs        = Number(input.subscriberCount || 0);
  const publishedAt = input.publishedAt || null;

  // ── [1] モデル読み込み ────────────────────────────────
  const preModel    = _loadPreModel();
  const mlSamples   = preModel?.sampleCount || 0;
  const hasModel    = Array.isArray(preModel?.weights) &&
                      preModel.weights.length === FEATURE_DIM_PRE &&
                      mlSamples >= MIN_ML_SAMPLES;

  // ── [2] encodePre() で特徴ベクトル生成 ────────────────
  // youtube-feature-extractor を明示的に利用
  const genreHitRate = _lookupGenreHitRate(input.genre, preModel);
  const video = {
    title, description, tags, duration, subscriberCount: subs,
    publishedAt: publishedAt || new Date().toISOString(),
    viewCount: 0, likeCount: 0, commentCount: 0,
  };
  const features = encodePre(video, genreHitRate);

  // ── [3] スコア計算: ML or フォールバック ───────────────
  let scores;
  let usedML  = false;
  let mlProb  = null;

  if (hasModel) {
    // ML モード: 学習済み重みで軸別 partial dot product → sigmoid
    const weights = new Float64Array(preModel.weights);
    scores  = _computeMLAxisScores(features, weights);
    usedML  = true;
    // 全体 ML 確率（情報表示用）
    let fullAct = 0;
    for (let i = 0; i < FEATURE_DIM_PRE; i++) fullAct += features[i] * weights[i];
    mlProb = Math.round(_sigmoid(fullAct) * 100);
  } else {
    // Cold-start フォールバック: 固定ルール（特徴量ベクトルを流用）
    scores = _computeFallbackAxisScores(
      features, title, description, tags, duration, publishedAt
    );
    usedML = false;
    mlProb = null;
  }

  // ── [4] 総合スコア・ランク・改善提案 ──────────────────
  const totalScore   = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / 6);
  const { rank, label: rankLabel } = _toRank(totalScore);
  const improvements = _buildImprovements(scores);

  return {
    ok: true,
    totalScore,
    rank,
    rankLabel,
    scores,
    improvements,
    modelInfo: { usedML, mlSamples, mlProb },
  };
}

// ─────────────────────────────────────────────────────
// formatDiagnosticText(result, input) — Discord 用テキスト整形
// ─────────────────────────────────────────────────────
function formatDiagnosticText(result, input = {}) {
  if (!result.ok) return result.text;

  const { totalScore, rank, rankLabel, scores, improvements, modelInfo } = result;
  const titlePreview = (input.title || '').slice(0, 40);

  const lines = [
    `🎬 **YouTube 投稿前診断**`,
    titlePreview ? `📝 タイトル: 「${titlePreview}${(input.title || '').length > 40 ? '…' : ''}」` : '',
    ``,
    `**総合スコア: ${totalScore} / 100 — ${rank} ${rankLabel}**`,
    ``,
    `**── 6軸診断 ──**`,
    `📊 CTR適性:        ${_scoreBar(scores.ctr)}`,
    `📊 視聴維持適性:   ${_scoreBar(scores.retention)}`,
    `📊 SEO強度:        ${_scoreBar(scores.seo)}`,
    `📊 感情フック:     ${_scoreBar(scores.emotion)}`,
    `📊 投稿タイミング: ${_scoreBar(scores.timing)}`,
    `📊 競合差別化:     ${_scoreBar(scores.uniqueness)}`,
    ``,
  ].filter(l => l !== '');

  if (improvements.length > 0) {
    lines.push(`**── 改善提案 TOP${improvements.length} ──**`);
    improvements.forEach((imp, i) => {
      const pEmoji = imp.priority === 'high' ? '🔴' : imp.priority === 'medium' ? '🟡' : '🟢';
      lines.push(`${i + 1}. ${pEmoji} **[${imp.axisLabel}]** ${imp.text}`);
    });
    lines.push('');
  } else {
    lines.push('✅ 全軸スコアが高水準です。このまま投稿を進めましょう！');
    lines.push('');
  }

  const mlNote = modelInfo.usedML
    ? `🤖 学習済みMLモデル使用（${modelInfo.mlSamples}件, 推定ヒット率 ${modelInfo.mlProb}%）`
    : `🔧 Cold-start: ルールベース診断（訓練データ ${modelInfo.mlSamples} 件 / 必要 ${MIN_ML_SAMPLES} 件）`;
  lines.push(`*${mlNote}*`);
  lines.push('*このスコアは投稿前の最適度を示します。実際の再生回数を予測するものではありません。*');

  return lines.join('\n');
}

module.exports = {
  diagnose,
  formatDiagnosticText,
  // テスト用内部 API
  _computeMLAxisScores,
  _computeFallbackAxisScores,
  _buildImprovements,
  _toRank,
  _loadPreModel,
  AXIS_FEATURE_IDX,
  MIN_ML_SAMPLES,
};
