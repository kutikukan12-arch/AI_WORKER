'use strict';

// =====================================================
// ai-feature-extractor.js — タスク特徴量エンコーダ
//
// 役割:
//   タスクオブジェクトを固定長の Float64Array（26次元）に変換する。
//   ai-model-v2.js の学習・推論に使用する特徴量を一元管理する。
//
// 特徴量構成:
//   [0..7]   taskType  one-hot (8次元)
//   [8..10]  taskSize  one-hot (3次元)
//   [11..18] promptシグナル binary (8次元)
//   [19]     promptLen normalized
//   [20..21] hour cyclic (sin, cos)
//   [22..23] dayOfWeek cyclic (sin, cos)
//   [24]     recency normalized (0=90日前, 1=today)
//   [25]     bias (常に 1.0)
//   計 26次元
// =====================================================

const TASK_TYPES = ['IMPLEMENT', 'FIX', 'RESEARCH', 'DESIGN', 'REVIEW', 'DOCS', 'OPS', 'TEST'];
const TASK_SIZES = ['SMALL', 'MEDIUM', 'LARGE'];

const PROMPT_SIGNALS = [
  { name: 'sig_auth',   pattern: /認証|auth|token|password|secret|credential/i },
  { name: 'sig_delete', pattern: /削除|delete|drop|truncate|rm\s+-rf/i },
  { name: 'sig_prod',   pattern: /本番|production|prod|deploy|リリース/i },
  { name: 'sig_db',     pattern: /データベース|database|db|sql|migration/i },
  { name: 'sig_test',   pattern: /テスト|test|spec|検証/i },
  { name: 'sig_backup', pattern: /バックアップ|backup|snapshot/i },
  { name: 'sig_small',  pattern: /小さく|最小限|minimal|small/i },
  { name: 'sig_docs',   pattern: /ドキュメント|docs|README/i },
];

const FEATURE_NAMES = [
  // Task type one-hot (8)
  ...TASK_TYPES.map(t => `type_${t}`),
  // Task size one-hot (3)
  ...TASK_SIZES.map(s => `size_${s}`),
  // Prompt signals (8)
  ...PROMPT_SIGNALS.map(s => s.name),
  // Prompt length normalized (1)
  'prompt_len_norm',
  // Hour cyclic (2)
  'hour_sin', 'hour_cos',
  // Day-of-week cyclic (2)
  'dow_sin', 'dow_cos',
  // Recency normalized (1)
  'recency_norm',
  // Bias (1)
  'bias',
];

const FEATURE_DIM = FEATURE_NAMES.length; // 26

// ─────────────────────────────────────────────────────
// encode(task) — タスクを特徴量ベクトルに変換する
//
// 引数:
//   task - { type, size, prompt, createdAt, updatedAt, ... }
//
// 戻り値: Float64Array(FEATURE_DIM)
// ─────────────────────────────────────────────────────
function encode(task) {
  const vec = new Float64Array(FEATURE_DIM);
  let idx = 0;

  // ── taskType one-hot ──
  const type = String(task.type || 'IMPLEMENT').toUpperCase();
  for (const t of TASK_TYPES) {
    vec[idx++] = type === t ? 1.0 : 0.0;
  }

  // ── taskSize one-hot ──
  const size = String(task.size || 'MEDIUM').toUpperCase();
  for (const s of TASK_SIZES) {
    vec[idx++] = size === s ? 1.0 : 0.0;
  }

  // ── prompt シグナル binary ──
  const prompt = String(task.prompt || '').slice(0, 1500);
  for (const sig of PROMPT_SIGNALS) {
    vec[idx++] = sig.pattern.test(prompt) ? 1.0 : 0.0;
  }

  // ── prompt 長さ正規化（0〜500 chars → 0〜1）──
  vec[idx++] = Math.min(prompt.length / 500.0, 1.0);

  // ── 時刻サイクリック符号化 ──
  const date = task.createdAt ? new Date(task.createdAt) : new Date();
  const hour = date.getUTCHours();
  const dow  = date.getUTCDay();
  vec[idx++] = Math.sin(2 * Math.PI * hour / 24);
  vec[idx++] = Math.cos(2 * Math.PI * hour / 24);
  vec[idx++] = Math.sin(2 * Math.PI * dow  / 7);
  vec[idx++] = Math.cos(2 * Math.PI * dow  / 7);

  // ── 直近度正規化（0=90日前以上, 1=今日）──
  const updatedAt = task.updatedAt || task.createdAt;
  if (updatedAt) {
    const daysOld = (Date.now() - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000);
    vec[idx++] = Math.max(0.0, 1.0 - daysOld / 90.0);
  } else {
    vec[idx++] = 0.5;
  }

  // ── バイアス項 ──
  vec[idx++] = 1.0;

  return vec;
}

// ─────────────────────────────────────────────────────
// describe(vec) — 特徴量ベクトルの可読サマリーを返す（デバッグ用）
// ─────────────────────────────────────────────────────
function describe(vec) {
  const entries = [];
  for (let i = 0; i < FEATURE_DIM; i++) {
    if (Math.abs(vec[i]) > 0.001) {
      entries.push(`${FEATURE_NAMES[i]}=${vec[i].toFixed(3)}`);
    }
  }
  return entries.join(', ');
}

module.exports = { encode, describe, FEATURE_NAMES, FEATURE_DIM, TASK_TYPES, TASK_SIZES, PROMPT_SIGNALS };
