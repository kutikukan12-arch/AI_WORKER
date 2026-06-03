'use strict';
// =====================================================
// youtube-diagnostic.js — YouTube 投稿前診断エンジン
//
// 既存の youtube-predictor / youtube-feature-extractor を
// 診断AIとして再利用する。診断時に外部APIは一切呼ばない。
//   - YouTube Data API: 呼ばない
//   - Claude API / LLM: 呼ばない
//   - 全スコアはローカル計算（即時応答）
//
// 出力方針:
//   - 再生数レンジ表示: 禁止
//   - 6軸診断スコア (0-100) + 総合スコア + ランク
//   - 弱点軸から具体的な改善提案を生成
//
// 診断6軸:
//   ctr         — CTR適性 (タイトルクリック訴求)
//   retention   — 視聴維持適性 (動画尺・説明文)
//   seo         — SEO強度 (タグ・キーワード)
//   emotion     — 感情フック (タイトル感情要素)
//   timing      — 投稿タイミング (時刻・曜日)
//   uniqueness  — 競合差別化 (独自性・ニッチ性)
//
// コマンド例:
//   !youtube diagnose title="..." genre=vtuber tags="タグ1,タグ2" sec=600 subs=5000
// =====================================================

const youtubePredictor = require('./youtube-predictor');

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

// ─── 絵文字スコアバー ─────────────────────────────────
function _scoreBar(score) {
  const filled = Math.round(score / 20); // 0-5 blocks
  return '🟦'.repeat(filled) + '⬜'.repeat(5 - filled) + ` ${score}`;
}

// ─────────────────────────────────────────────────────
// 6軸スコア算出関数
// ─────────────────────────────────────────────────────

// CTR適性: タイトルのクリック訴求力
function _scoreCTR(title) {
  let score = 45;
  if (!title) return score;

  // タイトル長（8〜60文字が最適）
  if (title.length >= 8 && title.length <= 60) score += 15;
  else if (title.length >= 61 && title.length <= 80) score += 8;
  else if (title.length > 80) score -= 5;
  else score -= 10; // < 8文字

  // 感嘆符・疑問符（注目引き）
  if (/[!！]/.test(title)) score += 10;
  if (/[?？]/.test(title)) score += 7;

  // 絵文字（視覚的引き付け）
  const emojiCount = (title.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) || []).length;
  if (emojiCount >= 1 && emojiCount <= 3) score += 10;
  else if (emojiCount > 3) score += 5; // 多すぎるとスパムっぽい

  // 数字（具体性）
  if (/\d/.test(title)) score += 5;

  // 括弧（補足情報）
  if (/[【〔\[（(]/.test(title)) score += 5;

  return Math.min(Math.max(Math.round(score), 0), 95);
}

// 視聴維持適性: 動画尺・説明文の充実度
function _scoreRetention(duration, description) {
  let score = 45;

  // 動画尺（秒）
  if (duration > 0) {
    if (duration >= 300 && duration <= 1200) score += 20; // 5〜20分: 最適
    else if (duration >= 60 && duration < 300) score += 10; // 1〜5分: ショート寄り
    else if (duration > 1200 && duration <= 3600) score += 10; // 20〜60分: 長め
    else if (duration < 60) score -= 5; // 1分未満
    // 60分超は加点なし
  }

  // 説明文の充実度（長ければ視聴者への情報が多い = 離脱リスク低減）
  if (description && description.length >= 500) score += 15;
  else if (description && description.length >= 200) score += 10;
  else if (description && description.length >= 50) score += 5;

  return Math.min(Math.max(Math.round(score), 0), 95);
}

// SEO強度: タグ数・キーワード密度
function _scoreSEO(title, tags, description) {
  let score = 40;

  // タグ数（YouTube検索流入の主要因）
  const tagCount = Array.isArray(tags) ? tags.length : 0;
  if (tagCount >= 15) score += 25;
  else if (tagCount >= 10) score += 18;
  else if (tagCount >= 5) score += 10;
  else if (tagCount >= 1) score += 4;

  // タイトル長（キーワード密度に関係）
  if (title && title.length >= 30) score += 8;
  else if (title && title.length >= 15) score += 4;

  // 説明文（検索インデックスに貢献）
  if (description && description.length >= 300) score += 12;
  else if (description && description.length >= 100) score += 7;
  else if (description && description.length > 0) score += 3;

  return Math.min(Math.max(Math.round(score), 0), 95);
}

// 感情フック: タイトルの感情訴求力
function _scoreEmotion(title) {
  let score = 40;
  if (!title) return score;

  // 感嘆符・疑問符（感情的刺激）
  if (/[!！]/.test(title)) score += 15;
  if (/[?？]/.test(title)) score += 8;

  // 感情語（日本語の代表的な感情トリガー）
  const emotionWords = ['やばい', 'すごい', '衝撃', '感動', '最強', '神回', '爆笑', '泣ける',
    '初見', '禁断', '限界', 'ハマる', 'ドッキリ', '炎上', '本音', '暴露', '怖い',
    'かわいい', 'ありがとう', '謝罪', '感謝', '挑戦', '奇跡', '爆速', '神技'];
  const lowerTitle = title.toLowerCase();
  let matchCount = 0;
  for (const word of emotionWords) {
    if (title.includes(word) || lowerTitle.includes(word)) matchCount++;
  }
  score += Math.min(matchCount * 8, 20);

  // 絵文字（視覚的感情表現）
  const emojiCount = (title.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) || []).length;
  if (emojiCount >= 1) score += 8;

  // 大文字・強調表現
  if (/[A-Z]{3,}/.test(title)) score += 4;

  return Math.min(Math.max(Math.round(score), 0), 95);
}

// 投稿タイミング: 時刻・曜日の適切さ
// JST 視聴者活動ピーク: 金〜日 / 18:00〜23:00
// UTC+9 → UTC 9:00〜14:00 = UTC hour 9-14
function _scoreTiming(publishedAt) {
  if (!publishedAt) return 50; // 未指定は中間値

  const pub  = new Date(publishedAt);
  const hour = pub.getUTCHours(); // UTC時
  const dow  = pub.getUTCDay();   // 0=日, 6=土

  let score = 45;

  // 時刻スコア（JST 18-23 = UTC 9-14）
  if (hour >= 9 && hour <= 14) score += 25;      // ゴールデンタイム
  else if (hour >= 7 && hour <= 9) score += 12;   // 通勤前
  else if (hour >= 14 && hour <= 17) score += 8;  // 夕方前
  // 深夜帯(UTC 15-22 = JST 0-7)は加点なし

  // 曜日スコア（金〜日が週末コンテンツ視聴ピーク）
  if (dow === 5 || dow === 6) score += 15;        // 金・土
  else if (dow === 0) score += 12;               // 日
  else if (dow === 4) score += 5;                // 木（週末前）

  return Math.min(Math.max(Math.round(score), 0), 95);
}

// 競合差別化: タイトルの独自性・ニッチ度
function _scoreUniqueness(title, tags) {
  let score = 45;
  if (!title) return score;

  const tagCount = Array.isArray(tags) ? tags.length : 0;

  // タイトルの多様性（複数の要素が組み合わさっている）
  let diversityScore = 0;
  if (title.length >= 20) diversityScore++;
  if (/[!！?？]/.test(title)) diversityScore++;
  if (/[【〔\[（(]/.test(title)) diversityScore++;
  if ((title.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) || []).length >= 1) diversityScore++;
  if (/\d/.test(title)) diversityScore++;
  score += diversityScore * 6;

  // タグの充実度（ニッチキーワードでの差別化）
  if (tagCount >= 10) score += 12;
  else if (tagCount >= 5) score += 7;

  // シリーズ系の固有表現（独自感）
  if (/[第#No\.][\d]|シリーズ|part\s?\d|ep\.\d/i.test(title)) score += 5;

  return Math.min(Math.max(Math.round(score), 0), 95);
}

// ─────────────────────────────────────────────────────
// 改善提案生成
//
// 弱点軸（スコア < 60）を priority 降順で最大3件返す
// 具体的・実行可能な提案のみ。再生数予測は含まない。
// ─────────────────────────────────────────────────────
const IMPROVEMENT_MAP = {
  ctr: [
    { threshold: 50, text: 'タイトルに感嘆符「！」または「！？」を追加してクリック衝動を高めましょう', axis: 'CTR適性' },
    { threshold: 60, text: 'タイトル長を20〜60文字に調整すると一覧表示での視認性が上がります', axis: 'CTR適性' },
    { threshold: 70, text: 'タイトルの先頭に絵文字を1〜2個追加すると一覧での目立ちやすさが上がります', axis: 'CTR適性' },
  ],
  retention: [
    { threshold: 50, text: '動画尺を5〜20分（300〜1200秒）に調整するとアルゴリズム上の評価が安定しやすいです', axis: '視聴維持適性' },
    { threshold: 60, text: '説明文に200文字以上の内容（動画の見どころ・目次）を書くと検索流入と直帰率が改善されます', axis: '視聴維持適性' },
    { threshold: 70, text: '冒頭30秒の引きを意識した構成にすると離脱率の改善が期待できます', axis: '視聴維持適性' },
  ],
  seo: [
    { threshold: 50, text: 'タグを最低でも10個以上設定しましょう。ジャンル名・チャンネル名・動画テーマを含めます', axis: 'SEO強度' },
    { threshold: 60, text: '説明文の冒頭2〜3行にタイトルと同じキーワードを含めると検索流入が増えやすくなります', axis: 'SEO強度' },
    { threshold: 70, text: 'タグに「ロングテールキーワード」（例：「VTuber 歌ってみた 初見」）を追加すると競合の少ない流入が取れます', axis: 'SEO強度' },
  ],
  emotion: [
    { threshold: 50, text: 'タイトルに「衝撃」「やばい」「初見」など感情を動かす言葉を1つ入れましょう', axis: '感情フック' },
    { threshold: 60, text: '視聴者が「気になる」と感じる疑問形タイトル（〜してみた結果…？）が効果的です', axis: '感情フック' },
    { threshold: 70, text: '具体的な状況説明より「感情体験の予告」をタイトルに込めると視聴動機が高まります', axis: '感情フック' },
  ],
  timing: [
    { threshold: 50, text: '投稿時刻を金〜日の JST 18:00〜22:00 に合わせると視聴者活動ピークをとらえやすいです', axis: '投稿タイミング' },
    { threshold: 65, text: '週中（月〜木）投稿の場合は JST 21:00 前後が比較的多い帯です', axis: '投稿タイミング' },
  ],
  uniqueness: [
    { threshold: 50, text: 'タイトルに【】〔〕などの括弧で補足情報を加え、他チャンネルと差別化しましょう', axis: '競合差別化' },
    { threshold: 60, text: 'シリーズ動画の場合は「#1」「第1回」を明示するとリピート視聴につながりやすいです', axis: '競合差別化' },
    { threshold: 70, text: 'ニッチなキーワードタグ（視聴者の検索語に近い表現）を5個以上追加することで競合の薄い流入が取れます', axis: '競合差別化' },
  ],
};

function _buildImprovements(scores) {
  const suggestions = [];

  for (const [axis, rules] of Object.entries(IMPROVEMENT_MAP)) {
    const score = scores[axis];
    // そのスコアに対して最も適切な提案を1件だけ選ぶ
    const matched = rules.filter(r => score < r.threshold);
    if (matched.length > 0) {
      const priority = score < 50 ? 'high' : score < 65 ? 'medium' : 'low';
      suggestions.push({
        axis,
        axisLabel: matched[0].axis,
        score,
        priority,
        text: matched[0].text,
      });
    }
  }

  // スコア昇順（弱い軸から優先）、同スコアは priority 順
  suggestions.sort((a, b) => a.score - b.score);
  return suggestions.slice(0, 3);
}

// ─────────────────────────────────────────────────────
// diagnose(input) — メイン診断関数
//
// input: {
//   title:           string  (必須)
//   genre?:          string
//   description?:    string
//   tags?:           string[]
//   duration?:       number  (秒)
//   subscriberCount?: number
//   publishedAt?:    string  (ISO8601 投稿予定日時)
// }
//
// 戻り値: {
//   ok:           boolean
//   totalScore:   number (0-100)
//   rank:         string
//   rankLabel:    string
//   scores: { ctr, retention, seo, emotion, timing, uniqueness }
//   improvements: [{ axis, axisLabel, score, priority, text }]
//   modelInfo:    { usedML, mlSamples }
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
  const duration    = Number(input.duration || 0);
  const publishedAt = input.publishedAt || null;

  // 6軸スコア算出（ローカル計算のみ）
  const ctr        = _scoreCTR(title);
  const retention  = _scoreRetention(duration, description);
  const seo        = _scoreSEO(title, tags, description);
  const emotion    = _scoreEmotion(title);
  const timing     = _scoreTiming(publishedAt);
  const uniqueness = _scoreUniqueness(title, tags);

  const scores = { ctr, retention, seo, emotion, timing, uniqueness };
  const totalScore = Math.round(
    (ctr + retention + seo + emotion + timing + uniqueness) / 6
  );
  const { rank, label: rankLabel } = _toRank(totalScore);

  // 改善提案（弱点軸から最大3件）
  const improvements = _buildImprovements(scores);

  // youtube-predictor でモデル情報を参照（再生数レンジは使わない）
  let modelInfo = { usedML: false, mlSamples: 0 };
  try {
    const video = {
      ...input,
      viewCount:    0, // 投稿前モード
      likeCount:    0,
      commentCount: 0,
      title, description, tags, duration,
    };
    const pred = youtubePredictor.predict(video);
    modelInfo = { usedML: pred.usedML, mlSamples: pred.mlSamples };
  } catch { /* モデルが未訓練でも診断は動作する */ }

  return {
    ok: true,
    totalScore,
    rank,
    rankLabel,
    scores,
    improvements,
    modelInfo,
  };
}

// ─────────────────────────────────────────────────────
// formatDiagnosticText(result, input) — Discord 用テキスト整形
//
// 再生数レンジは含まない（設計方針: 禁止）
// ─────────────────────────────────────────────────────
function formatDiagnosticText(result, input = {}) {
  if (!result.ok) return result.text;

  const { totalScore, rank, rankLabel, scores, improvements, modelInfo } = result;
  const title = (input.title || '').slice(0, 40);

  const lines = [
    `🎬 **YouTube 投稿前診断**`,
    title ? `📝 タイトル: 「${title}${input.title?.length > 40 ? '…' : ''}」` : '',
    ``,
    `**総合スコア: ${totalScore} / 100 — ${rank} ${rankLabel}**`,
    ``,
    `**── 6軸診断 ──**`,
    `📊 CTR適性:       ${_scoreBar(scores.ctr)}`,
    `📊 視聴維持適性:  ${_scoreBar(scores.retention)}`,
    `📊 SEO強度:       ${_scoreBar(scores.seo)}`,
    `📊 感情フック:    ${_scoreBar(scores.emotion)}`,
    `📊 投稿タイミング:${_scoreBar(scores.timing)}`,
    `📊 競合差別化:    ${_scoreBar(scores.uniqueness)}`,
    ``,
  ].filter(l => l !== null);

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

  // モデル使用状況
  const mlNote = modelInfo.usedML
    ? `🤖 訓練済みMLモデル参照（${modelInfo.mlSamples}件）`
    : `🔧 ルールベース診断（訓練データ不足）`;
  lines.push(`*${mlNote}*`);
  lines.push('*このスコアは投稿前の最適度を示します。実際の再生回数を予測するものではありません。*');

  return lines.join('\n');
}

module.exports = {
  diagnose,
  formatDiagnosticText,
  // テスト用内部 API
  _scoreCTR,
  _scoreRetention,
  _scoreSEO,
  _scoreEmotion,
  _scoreTiming,
  _scoreUniqueness,
  _buildImprovements,
  _toRank,
};
