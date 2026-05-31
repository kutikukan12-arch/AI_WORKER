'use strict';

// =====================================================
// ai-predictor.js — AI 予測モデル（初期バージョン）
//
// 役割:
//   タスクの特徴量からルールベースの予測を行う。
//   将来的な ML 移行を見据えた構造にする。
//
// 予測機能:
//   1. predictAIRouting()       — 担当 AI を信頼スコア付きで予測
//   2. predictTaskOutcome()     — タスク成功確率を予測
//   3. predictCompletionTime()  — 完了時間を推定
//   4. buildPredictionSummary() — Discord 表示用サマリー生成
//
// 依存: logger.js のみ（外部 API 不使用）
// =====================================================

const logger = require('./logger');

// ─────────────────────────────────────────────────────
// 担当 AI の重み付きシグナルテーブル
// weight: マッチ1件あたりのスコア加算値
// ─────────────────────────────────────────────────────
const ROUTING_SIGNALS = {
  'Codex': [
    { keywords: ['エラー', 'バグ', 'bug', 'error', '落ちた', '動かない', 'クラッシュ', 'crash'], weight: 3 },
    { keywords: ['最適化', 'optimize', 'リファクタ', 'refactor', '軽量', '高速化', 'performance'], weight: 2 },
    { keywords: ['セキュリティ', 'security', '脆弱性', 'vulnerability', '漏洩', 'breach'], weight: 3 },
    { keywords: ['非同期', 'async', 'await', '並列', 'concurrent'], weight: 2 },
    { keywords: ['修正', 'fix', '直して', '改善', 'improve'], weight: 1 },
  ],
  'ChatGPT': [
    { keywords: ['仕様', '設計', 'spec', 'design', '方針', 'plan'], weight: 3 },
    { keywords: ['相談', 'アドバイス', '提案', 'advice', '議論'], weight: 2 },
    { keywords: ['優先', 'priority', '判断', '何をすべき', '次は何'], weight: 2 },
    { keywords: ['UI', 'UX', 'インターフェース', 'デザイン', 'layout'], weight: 2 },
    { keywords: ['運用', 'operation', '整理', '見直し', '整頓'], weight: 1 },
  ],
  'Claude Code': [
    { keywords: ['実装', 'implement', '作成', 'create', '開発', 'build'], weight: 3 },
    { keywords: ['新機能', '追加', 'add', '次フェーズ', 'Phase', 'phase'], weight: 2 },
    { keywords: ['書いて', 'write', '生成', 'generate', '作って'], weight: 2 },
    { keywords: ['テスト', 'test', '検証', 'verify', 'validate'], weight: 1 },
    { keywords: ['インストール', 'install', 'setup', 'セットアップ'], weight: 1 },
  ],
};

// ─────────────────────────────────────────────────────
// タスク成功確率に影響するリスク要因
// ─────────────────────────────────────────────────────
const RISK_FACTORS = [
  { pattern: /認証|auth|token|password|secret|credential/i, penalty: 15, label: '認証・機密関連' },
  { pattern: /削除|delete|drop|truncate|rm\s+-rf/i,         penalty: 20, label: 'データ削除操作' },
  { pattern: /本番|production|prod|deploy|リリース/i,        penalty: 10, label: '本番環境変更' },
  { pattern: /データベース|database|db|sql|migration/i,     penalty: 8,  label: 'DB操作' },
  { pattern: /Phase\s*[4-9]|Phase\s*[1-9][0-9]/i,          penalty: 5,  label: '大規模フェーズ' },
];

// 成功確率を上げるポジティブ要因
const POSITIVE_FACTORS = [
  { pattern: /テスト|test|spec|検証/i,      bonus: 5,  label: 'テスト付き' },
  { pattern: /バックアップ|backup|snapshot/i, bonus: 3,  label: 'バックアップ前提' },
  { pattern: /小さく|最小限|minimal|small/i,  bonus: 5,  label: '最小変更' },
  { pattern: /ドキュメント|docs|README/i,     bonus: 3,  label: 'ドキュメント系' },
];

// ─────────────────────────────────────────────────────
// TaskType 別の基本パラメータ
// ─────────────────────────────────────────────────────
const TYPE_BASE = {
  IMPLEMENT: { successBase: 75, timeMin: 10, timeMax: 60  },
  FIX:       { successBase: 80, timeMin: 5,  timeMax: 30  },
  RESEARCH:  { successBase: 90, timeMin: 5,  timeMax: 20  },
  DESIGN:    { successBase: 85, timeMin: 5,  timeMax: 20  },
  REVIEW:    { successBase: 92, timeMin: 3,  timeMax: 15  },
  DOCS:      { successBase: 88, timeMin: 5,  timeMax: 25  },
  OPS:       { successBase: 85, timeMin: 3,  timeMax: 10  },
  TEST:      { successBase: 82, timeMin: 8,  timeMax: 30  },
};

const DEFAULT_TYPE_BASE = { successBase: 75, timeMin: 10, timeMax: 60 };

// TaskSize 別の時間係数
const SIZE_TIME_MULTIPLIER = { SMALL: 0.6, MEDIUM: 1.0, LARGE: 1.8 };

// ─────────────────────────────────────────────────────
// 内部: テキストに対してシグナルのスコアを計算する
// ─────────────────────────────────────────────────────
function _calcSignalScore(text, signalGroups) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const group of signalGroups) {
    for (const kw of group.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += group.weight;
        break; // 同一グループ内は1回のみカウント
      }
    }
  }
  return score;
}

// ─────────────────────────────────────────────────────
// 内部: スコア配列から信頼度ラベルを生成
// ─────────────────────────────────────────────────────
function _confidenceLabel(topScore, secondScore) {
  const gap = topScore - secondScore;
  if (topScore === 0) return 'low';
  if (gap >= 4 && topScore >= 4) return 'high';
  if (gap >= 2 || topScore >= 3) return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────────────
// 内部: 数値を 0〜100 の範囲にクランプ
// ─────────────────────────────────────────────────────
function _clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

// ─────────────────────────────────────────────────────
// predictAIRouting(prompt, taskType, output?)
//
// タスク内容から担当 AI を信頼スコア付きで予測する。
//
// 引数:
//   prompt   - タスクの依頼文
//   taskType - 'IMPLEMENT'|'RESEARCH'|'DESIGN'|'REVIEW'|'OPS'
//   output   - Claude Code の出力（任意）
//
// 戻り値:
//   {
//     recommended: 'Claude Code'|'Codex'|'ChatGPT',
//     confidence:  'high'|'medium'|'low',
//     scores: { 'Claude Code': number, 'Codex': number, 'ChatGPT': number },
//     reason: string,
//   }
// ─────────────────────────────────────────────────────
function predictAIRouting(prompt, taskType = 'IMPLEMENT', output = '') {
  const text = (prompt + ' ' + (output || '')).slice(0, 2000);

  const scores = {};
  for (const [ai, groups] of Object.entries(ROUTING_SIGNALS)) {
    scores[ai] = _calcSignalScore(text, groups);
  }

  // TaskType による補正
  if (taskType === 'DESIGN' || taskType === 'RESEARCH') {
    scores['ChatGPT']    = (scores['ChatGPT']    || 0) + 2;
  }
  if (taskType === 'IMPLEMENT' || taskType === 'FIX') {
    scores['Claude Code'] = (scores['Claude Code'] || 0) + 2;
    // IMPLEMENT では ChatGPT を抑制（誤判定防止）
    scores['ChatGPT']     = Math.max(0, (scores['ChatGPT'] || 0) - 3);
  }
  if (taskType === 'OPS') {
    scores['Claude Code'] = (scores['Claude Code'] || 0) + 1;
  }

  // 推奨 AI を決定（スコア最大）
  const sorted     = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore]   = sorted[0];
  const [, secondScore]     = sorted[1] || [null, 0];

  const recommended = bestScore > 0 ? best : 'Claude Code'; // デフォルト: Claude Code
  const confidence  = _confidenceLabel(bestScore, secondScore);

  const reason = recommended === 'Codex'
    ? 'コード修正・最適化・セキュリティ改善のシグナルを検出'
    : recommended === 'ChatGPT'
    ? '設計・仕様相談・運用改善のシグナルを検出'
    : '実装・新機能・次フェーズのシグナルを検出（またはデフォルト）';

  logger.info(
    `[Predictor] AIRouting: ${recommended} (confidence:${confidence}) | ` +
    `scores: ${JSON.stringify(scores)} | type:${taskType}`
  );

  return { recommended, confidence, scores, reason };
}

// ─────────────────────────────────────────────────────
// predictTaskOutcome(prompt, taskType, taskSize?)
//
// タスクの成功確率（0〜100）を予測する。
//
// 引数:
//   prompt   - タスクの依頼文
//   taskType - 'IMPLEMENT'|'RESEARCH' 等
//   taskSize - 'SMALL'|'MEDIUM'|'LARGE'（任意）
//
// 戻り値:
//   {
//     probability: number,  // 0〜100
//     confidence:  'high'|'medium'|'low',
//     risks:       string[],   // 検出したリスク要因
//     bonuses:     string[],   // 検出したポジティブ要因
//   }
// ─────────────────────────────────────────────────────
function predictTaskOutcome(prompt, taskType = 'IMPLEMENT', taskSize = 'MEDIUM') {
  const base = (TYPE_BASE[taskType] || DEFAULT_TYPE_BASE).successBase;
  const text = (prompt || '').slice(0, 1500);

  let score = base;
  const risks   = [];
  const bonuses = [];

  // リスク要因
  for (const { pattern, penalty, label } of RISK_FACTORS) {
    if (pattern.test(text)) {
      score -= penalty;
      risks.push(label);
    }
  }

  // ポジティブ要因
  for (const { pattern, bonus, label } of POSITIVE_FACTORS) {
    if (pattern.test(text)) {
      score += bonus;
      bonuses.push(label);
    }
  }

  // タスクサイズ補正
  if (taskSize === 'LARGE')  score -= 10;
  if (taskSize === 'SMALL')  score += 5;

  const probability = _clamp(score);

  // 信頼度: リスク/ボーナスが検出されるほど予測根拠が明確
  const signals = risks.length + bonuses.length;
  const confidence = signals >= 3 ? 'high' : signals >= 1 ? 'medium' : 'low';

  logger.info(
    `[Predictor] TaskOutcome: ${probability}% (confidence:${confidence}) | ` +
    `risks:${risks.length} bonuses:${bonuses.length} | type:${taskType} size:${taskSize}`
  );

  return { probability, confidence, risks, bonuses };
}

// ─────────────────────────────────────────────────────
// predictCompletionTime(taskType, taskSize?)
//
// タスクの完了時間（分）を推定する。
//
// 引数:
//   taskType - 'IMPLEMENT'|'RESEARCH' 等
//   taskSize - 'SMALL'|'MEDIUM'|'LARGE'（任意）
//
// 戻り値:
//   {
//     estimateMin: number,  // 最短（分）
//     estimateMax: number,  // 最長（分）
//     unit:        'minutes',
//   }
// ─────────────────────────────────────────────────────
function predictCompletionTime(taskType = 'IMPLEMENT', taskSize = 'MEDIUM') {
  const base = TYPE_BASE[taskType] || DEFAULT_TYPE_BASE;
  const mult = SIZE_TIME_MULTIPLIER[taskSize] || 1.0;

  const estimateMin = Math.round(base.timeMin * mult);
  const estimateMax = Math.round(base.timeMax * mult);

  logger.info(
    `[Predictor] CompletionTime: ${estimateMin}〜${estimateMax}min | ` +
    `type:${taskType} size:${taskSize} mult:${mult}`
  );

  return { estimateMin, estimateMax, unit: 'minutes' };
}

// ─────────────────────────────────────────────────────
// buildPredictionSummary(prompt, taskType, taskSize?, output?)
//
// 全予測をまとめて Discord 表示用サマリーテキストを返す。
//
// 引数:
//   prompt   - タスクの依頼文
//   taskType - 'IMPLEMENT'|'RESEARCH' 等
//   taskSize - 'SMALL'|'MEDIUM'|'LARGE'（任意）
//   output   - Claude Code の出力（任意）
//
// 戻り値: string（Discord Embed 等に埋め込み可能）
// ─────────────────────────────────────────────────────
function buildPredictionSummary(prompt, taskType = 'IMPLEMENT', taskSize = 'MEDIUM', output = '') {
  const routing = predictAIRouting(prompt, taskType, output);
  const outcome = predictTaskOutcome(prompt, taskType, taskSize);
  const time    = predictCompletionTime(taskType, taskSize);

  const confEmoji = { high: '🟢', medium: '🟡', low: '🔴' };
  const probEmoji = outcome.probability >= 80 ? '🟢' : outcome.probability >= 60 ? '🟡' : '🔴';
  const aiEmoji   = { 'Codex': '🔧', 'ChatGPT': '💬', 'Claude Code': '🤖' };

  const lines = [
    '🔮 **AI 予測モデル（初期バージョン）**',
    '',
    `${aiEmoji[routing.recommended] || '🤖'} **担当AI予測:** ${routing.recommended} ${confEmoji[routing.confidence]} \`${routing.confidence}\``,
    `　${routing.reason}`,
    '',
    `${probEmoji} **成功確率:** ${outcome.probability}% ${confEmoji[outcome.confidence]} \`${outcome.confidence}\``,
  ];

  if (outcome.risks.length > 0) {
    lines.push(`　⚠️ リスク: ${outcome.risks.join(' / ')}`);
  }
  if (outcome.bonuses.length > 0) {
    lines.push(`　✨ ポジティブ: ${outcome.bonuses.join(' / ')}`);
  }

  lines.push('');
  lines.push(`⏱️ **完了時間推定:** ${time.estimateMin}〜${time.estimateMax}分`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// predict(prompt, taskType, taskSize?, output?)
//
// 全予測をまとめて返すメインエントリーポイント。
//
// 戻り値:
//   {
//     routing:  predictAIRouting() の戻り値,
//     outcome:  predictTaskOutcome() の戻り値,
//     time:     predictCompletionTime() の戻り値,
//     summary:  string,
//   }
// ─────────────────────────────────────────────────────
function predict(prompt, taskType = 'IMPLEMENT', taskSize = 'MEDIUM', output = '') {
  logger.info(`[Predictor] predict: type:${taskType} size:${taskSize}`);

  return {
    routing: predictAIRouting(prompt, taskType, output),
    outcome: predictTaskOutcome(prompt, taskType, taskSize),
    time:    predictCompletionTime(taskType, taskSize),
    summary: buildPredictionSummary(prompt, taskType, taskSize, output),
  };
}

module.exports = {
  predict,
  predictAIRouting,
  predictTaskOutcome,
  predictCompletionTime,
  buildPredictionSummary,
};
