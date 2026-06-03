'use strict';
// =====================================================
// youtube-model-exporter.js — 推論専用モデル Export
//
// 【境界定義】
//
//  ─── 公開可能（Web / クライアントサイド）───────────
//   ✅ 推論専用 model.json（weights + featureDim のみ）
//   ✅ 特徴量計算ロジック（youtube-feature-extractor.js）
//
//  ─── 公開禁止（AI_WORKER 内部専用）────────────────
//   ❌ AI_WORKER 内部コード全般
//   ❌ 収集スクリプト (youtube-data-collector.js)
//   ❌ 学習パイプライン (youtube-predictor.train())
//   ❌ 元 YouTube データセット (data/youtube-seeds/)
//   ❌ 改善ノウハウ管理資料
//   ❌ training metadata (sampleCount / hitCount / missCount /
//      trainDirectionalAcc / trainedAt / genreHitRates)
//
// 【training model vs export model】
//
//  data/youtube-model.json     → training model（公開禁止・gitignore）
//  data/youtube-model-pre.json → training model（公開禁止・gitignore）
//  data/youtube-model-export.json → 推論専用 export（Web 側に渡す）
//
// 【export に含まれるフィールド】
//  - version     : export スキーマバージョン
//  - exportedAt  : export 日時（trainedAt とは別）
//  - featureDim  : 特徴ベクトル次元数 (FEATURE_DIM_PRE = 15)
//  - featureNames: 特徴量名一覧（デバッグ用）
//  - weights     : 学習済み重みのみ（training 付帯情報は全て除外）
//
// 【export から除外されるフィールド】
//  - sampleCount       → 収集規模を外部に開示しない
//  - hitCount / missCount → 内部データ統計
//  - trainDirectionalAcc → 内部パフォーマンス指標
//  - trainedAt          → データ収集タイミングを開示しない
//  - genreHitRates      → 内部ジャンル分析パターン
// =====================================================

const fs   = require('fs');
const path = require('path');
const { FEATURE_NAMES_PRE, FEATURE_DIM_PRE } = require('./youtube-feature-extractor');

const DATA_DIR         = path.join(__dirname, '..', '..', 'data');
const MODEL_FILE_PRE   = path.join(DATA_DIR, 'youtube-model-pre.json');
const EXPORT_FILE      = path.join(DATA_DIR, 'youtube-model-export.json');

const EXPORT_SCHEMA_VERSION = '1.0';

// ─────────────────────────────────────────────────────
// loadTrainingModel() — 内部 training model を読み込む
// ─────────────────────────────────────────────────────
function loadTrainingModel() {
  if (!fs.existsSync(MODEL_FILE_PRE)) return null;
  try {
    return JSON.parse(fs.readFileSync(MODEL_FILE_PRE, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────
// exportInferenceModel(outputPath?) — 推論専用 export を生成
//
// training model から以下を除外してエクスポートする:
//   sampleCount / hitCount / missCount
//   trainDirectionalAcc / trainedAt / genreHitRates
//
// outputPath を省略すると data/youtube-model-export.json に保存する。
//
// 戻り値: { ok, path, featureDim, weightsNonzero, message }
// ─────────────────────────────────────────────────────
function exportInferenceModel(outputPath = EXPORT_FILE) {
  const training = loadTrainingModel();

  if (!training) {
    return {
      ok:      false,
      message: 'training model が見つかりません。\n先に `!youtube train` を実行してください。',
    };
  }

  if (!Array.isArray(training.weights) || training.weights.length !== FEATURE_DIM_PRE) {
    return {
      ok:      false,
      message: `training model の weights が不正です。\n` +
               `期待次元: ${FEATURE_DIM_PRE} / 実際: ${training.weights?.length ?? 'なし'}`,
    };
  }

  // ─── 推論専用フィールドのみを抽出 ──────────────────
  // training metadata は一切含めない
  const inferenceModel = {
    version:      EXPORT_SCHEMA_VERSION,
    exportedAt:   new Date().toISOString(),
    featureDim:   FEATURE_DIM_PRE,
    featureNames: FEATURE_NAMES_PRE.slice(),   // 特徴量名（デバッグ用）
    weights:      training.weights.slice(),    // 学習済み重みのみ
  };

  // 除外確認（テスト・ログ用）
  const EXCLUDED_FIELDS = [
    'sampleCount', 'hitCount', 'missCount',
    'trainDirectionalAcc', 'trainedAt', 'genreHitRates',
  ];
  const leaked = EXCLUDED_FIELDS.filter(f => f in inferenceModel);
  if (leaked.length > 0) {
    // 万が一除外フィールドが混入した場合はエラーで停止
    return {
      ok:      false,
      message: `⛔ 内部フィールドの混入を検出: ${leaked.join(', ')}\nエクスポートを中止しました。`,
    };
  }

  // 書き込み（一時ファイル経由でアトミックに）
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = outputPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(inferenceModel, null, 2), 'utf8');
    fs.renameSync(tmp, outputPath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  const weightsNonzero = training.weights.filter(w => Math.abs(w) > 1e-6).length;

  return {
    ok:             true,
    path:           outputPath,
    featureDim:     FEATURE_DIM_PRE,
    weightsNonzero,
    weightsTotal:   FEATURE_DIM_PRE,
    message:        `✅ 推論専用モデルをエクスポートしました\n` +
                    `保存先: \`${path.basename(outputPath)}\`\n` +
                    `次元数: ${FEATURE_DIM_PRE}\n` +
                    `有効重み: ${weightsNonzero} / ${FEATURE_DIM_PRE}\n\n` +
                    `除外済み内部フィールド:\n` +
                    EXCLUDED_FIELDS.map(f => `  ✗ ${f}`).join('\n') + '\n\n' +
                    `このファイルを Web / クライアントサイドに渡してください。\n` +
                    `⚠️ \`data/youtube-model.json\` / \`data/youtube-model-pre.json\` は公開禁止です。`,
  };
}

// ─────────────────────────────────────────────────────
// getExportStatus() — export 状態確認
// ─────────────────────────────────────────────────────
function getExportStatus() {
  const trainingExists = fs.existsSync(MODEL_FILE_PRE);
  const exportExists   = fs.existsSync(EXPORT_FILE);

  let exportInfo = null;
  if (exportExists) {
    try {
      const e = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
      exportInfo = {
        version:        e.version,
        exportedAt:     e.exportedAt,
        featureDim:     e.featureDim,
        weightsNonzero: (e.weights || []).filter(w => Math.abs(w) > 1e-6).length,
        // 内部フィールドが混入していないか確認
        hasLeakedFields: ['sampleCount','hitCount','missCount','trainDirectionalAcc',
                          'trainedAt','genreHitRates'].some(f => f in e),
      };
    } catch { /* ignore */ }
  }

  return {
    trainingModelExists: trainingExists,
    exportExists,
    exportInfo,
    exportPath: EXPORT_FILE,
  };
}

module.exports = {
  exportInferenceModel,
  getExportStatus,
  EXPORT_FILE,
  EXCLUDED_FIELDS: [
    'sampleCount', 'hitCount', 'missCount',
    'trainDirectionalAcc', 'trainedAt', 'genreHitRates',
  ],
};
