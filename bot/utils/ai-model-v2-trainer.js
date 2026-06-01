'use strict';

// =====================================================
// ai-model-v2-trainer.js — ML モデルのトレーニング処理（v2）
//
// 役割:
//   data/history/*.json を CHUNK_SIZE 単位で安全に処理し、
//   ai-model-v2.js の ML モデルを学習して data/ml-models.json に保存する。
//
// 学習モデル:
//   1. LogisticRegression — タスク成功確率（初回レビュー通過を正例）
//   2. LinearRegression   — 完了時間推定（stateHistory の実測値）
//
// trainV2():
//   全 history ファイルを対象にフルトレーニング。
//
// trainIncrementalV2():
//   前回トレーニング以降に更新されたファイルが存在する場合のみ
//   全データを再収集して再トレーニング（モデルを正確に維持するため差分再学習ではなく全再学習）。
//   差分ファイルが 0 件の場合はスキップを返す。
//
// 保存先: data/ml-models.json
// 依存:   ai-feature-extractor.js, ai-model-v2.js, logger.js
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const { encode } = require('./ai-feature-extractor');
const { LogisticRegression, LinearRegression } = require('./ai-model-v2');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const MODELS_FILE = path.join(DATA_DIR, 'ml-models.json');
const MODELS_TMP  = MODELS_FILE + '.tmp';

const CHUNK_SIZE  = 20;  // 一度に処理する history ファイル数
const MIN_SAMPLES = 5;   // モデル学習に必要な最低サンプル数

// ─────────────────────────────────────────────────────
// _checkClassBalance(y) — 二値ラベル配列に正例・負例の両クラスがあるか確認
//
// 戻り値: { posCount, negCount, isBalanced }
// isBalanced = true のときのみ LogisticRegression を学習すべき。
// ─────────────────────────────────────────────────────
function _checkClassBalance(y) {
  let posCount = 0, negCount = 0;
  for (const v of y) {
    if (v === 1) posCount++;
    else         negCount++;
  }
  return { posCount, negCount, isBalanced: posCount > 0 && negCount > 0 };
}

// ─────────────────────────────────────────────────────
// 内部: タスクの初回レビュー通過判定（v1 trainer と同じロジック）
// ─────────────────────────────────────────────────────
function _isFirstPassOk(task) {
  if (!task.reviewResult) return true;
  const r = String(task.reviewResult);
  if (r.includes('修正推奨') || r.includes('却下推奨')) return false;
  return true;
}

// ─────────────────────────────────────────────────────
// 内部: タスクの実際の所要時間（分）を算出する（v1 trainer と同じロジック）
//
// 0分以下 または 480分超（8時間）は異常値として除外。
// ─────────────────────────────────────────────────────
function _computeDuration(task) {
  const h = task.stateHistory;
  if (!h || h.length < 2) return null;
  const ms  = new Date(h[h.length - 1].at) - new Date(h[0].at);
  const min = ms / 60000;
  return (min > 0 && min <= 480) ? min : null;
}

// ─────────────────────────────────────────────────────
// 内部: history ファイルを CHUNK_SIZE 単位で処理し、
//       特徴量ベクトルとラベルを収集する。
//
// タスクオブジェクト自体はスコープを抜けると GC 対象になるよう設計。
//
// 戻り値:
//   {
//     X_success: Float64Array[],  y_success: number[],   // 0 or 1
//     X_time:    Float64Array[],  y_time:    number[],   // 分
//     totalTasks: number,
//   }
// ─────────────────────────────────────────────────────
function _collectTrainingData(historyFiles) {
  const X_success = [];
  const y_success = [];
  const X_time    = [];
  const y_time    = [];
  let   totalTasks = 0;

  for (let i = 0; i < historyFiles.length; i += CHUNK_SIZE) {
    const chunk = historyFiles.slice(i, i + CHUNK_SIZE);
    for (const file of chunk) {
      let tasks;
      try {
        const raw  = fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8');
        const data = JSON.parse(raw);
        tasks = Array.isArray(data.tasks) ? data.tasks : [];
      } catch (e) {
        logger.warn(`[V2Trainer] ${file} 読み込み失敗: ${e.message}`);
        continue;
      }

      for (const t of tasks) {
        totalTasks++;
        const vec = encode(t);

        // 成功率ラベル（全タスク対象）
        X_success.push(vec);
        y_success.push(_isFirstPassOk(t) ? 1 : 0);

        // 時間ラベル（実測値がある場合のみ）
        const dur = _computeDuration(t);
        if (dur !== null) {
          X_time.push(vec);
          y_time.push(dur);
        }
      }
      // tasks はスコープを抜けた時点で GC 対象
    }
  }

  return { X_success, y_success, X_time, y_time, totalTasks };
}

// ─────────────────────────────────────────────────────
// loadModels() — 保存済み ML モデルを返す（なければ null）
// ─────────────────────────────────────────────────────
function loadModels() {
  try {
    if (fs.existsSync(MODELS_FILE)) {
      return JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

// ─────────────────────────────────────────────────────
// _saveModels(meta, successModel, timeModel) — アトミック保存
// ─────────────────────────────────────────────────────
function _saveModels(meta, successModel, timeModel, metrics = {}) {
  const payload = {
    version: 2,
    sampleCount:    meta.sampleCount,
    timeSampleCount: meta.timeSampleCount,
    lastTrainedAt:  new Date().toISOString(),
    successModel:   successModel ? successModel.toJSON() : null,
    timeModel:      timeModel    ? timeModel.toJSON()    : null,
    metrics: {
      successDirectionalAcc: metrics.successDirectionalAcc ?? null,
      timeMAPE:              metrics.timeMAPE              ?? null,
    },
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MODELS_TMP, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(MODELS_TMP, MODELS_FILE);
  return payload;
}

// ─────────────────────────────────────────────────────
// trainV2()
//
// 全 history ファイルを CHUNK_SIZE 単位で読み込み、
// LogisticRegression と LinearRegression を学習して保存する。
//
// 戻り値:
//   { skipped: true, reason, sampleCount }           — データ不足でスキップ
//   { skipped: false, sampleCount, timeSampleCount }  — 学習完了
// ─────────────────────────────────────────────────────
function trainV2() {
  if (!fs.existsSync(HISTORY_DIR)) {
    logger.info('[V2Trainer] アーカイブなし: トレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const historyFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  if (historyFiles.length === 0) {
    logger.info('[V2Trainer] アーカイブなし: トレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const { X_success, y_success, X_time, y_time, totalTasks } = _collectTrainingData(historyFiles);

  if (totalTasks === 0) {
    logger.info('[V2Trainer] タスクデータなし: トレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  let successModel = null;
  if (X_success.length >= MIN_SAMPLES) {
    const balance = _checkClassBalance(y_success);
    if (balance.isBalanced) {
      successModel = new LogisticRegression().train(X_success, y_success);
      logger.info(`[V2Trainer] LogisticRegression 学習完了 (samples:${X_success.length}, pos:${balance.posCount}, neg:${balance.negCount})`);
    } else {
      logger.warn(
        `[V2Trainer] 成功モデル: 全${X_success.length}件が単一クラス` +
        ` (pos:${balance.posCount}, neg:${balance.negCount}) — 判別不能のためスキップ`
      );
    }
  } else {
    logger.info(`[V2Trainer] 成功モデルはサンプル不足でスキップ (${X_success.length}/${MIN_SAMPLES})`);
  }

  let timeModel = null;
  if (X_time.length >= MIN_SAMPLES) {
    timeModel = new LinearRegression().train(X_time, y_time);
    logger.info(`[V2Trainer] LinearRegression 学習完了 (samples:${X_time.length})`);
  } else {
    logger.info(`[V2Trainer] 時間モデルはサンプル不足でスキップ (${X_time.length}/${MIN_SAMPLES})`);
  }

  // ─── 学習データ上での精度評価 ─────────────────────────────
  let successDirectionalAcc = null;
  if (successModel && X_success.length > 0) {
    let correct = 0;
    for (let i = 0; i < X_success.length; i++) {
      const pred = successModel.predict(X_success[i]) >= 0.5 ? 1 : 0;
      if (pred === y_success[i]) correct++;
    }
    successDirectionalAcc = Math.round(correct / X_success.length * 1000) / 1000;
  }

  let timeMAPE = null;
  if (timeModel && X_time.length > 0) {
    let mapeSum = 0, mapeCount = 0;
    for (let i = 0; i < X_time.length; i++) {
      if (y_time[i] > 0) {
        mapeSum += Math.abs(timeModel.predict(X_time[i]) - y_time[i]) / y_time[i] * 100;
        mapeCount++;
      }
    }
    timeMAPE = mapeCount > 0 ? Math.round(mapeSum / mapeCount * 10) / 10 : null;
  }

  const payload = _saveModels(
    { sampleCount: totalTasks, timeSampleCount: X_time.length },
    successModel,
    timeModel,
    { successDirectionalAcc, timeMAPE },
  );

  logger.info(
    `[V2Trainer] 完了 | tasks:${totalTasks} | ` +
    `successSamples:${X_success.length} | timeSamples:${X_time.length} | ` +
    `方向性正解率:${successDirectionalAcc !== null ? (successDirectionalAcc * 100).toFixed(1) + '%' : 'N/A'} | ` +
    `MAPE:${timeMAPE !== null ? timeMAPE.toFixed(1) + '%' : 'N/A'}`
  );

  return {
    skipped:              false,
    sampleCount:          totalTasks,
    timeSampleCount:      X_time.length,
    lastTrainedAt:        payload.lastTrainedAt,
    successDirectionalAcc,
    timeMAPE,
  };
}

// ─────────────────────────────────────────────────────
// trainIncrementalV2()
//
// 前回トレーニング以降に mtime が更新された history ファイルが存在する場合のみ
// 全データを再収集して再トレーニングする。
//
// ML モデルは差分オンライン学習が難しいため、
// 差分検出後は全データを使って再トレーニングする（精度の一貫性を保つ）。
//
// 初回（lastTrainedAt なし）は trainV2() に委譲する。
// 差分ファイルが 0 件の場合はスキップを返す。
//
// 戻り値:
//   trainV2() と同じ形式 + incremental:true
//   { skipped: true, reason: 'no_new_data', sampleCount } — 差分なし
// ─────────────────────────────────────────────────────
function trainIncrementalV2() {
  if (!fs.existsSync(HISTORY_DIR)) {
    logger.info('[V2Trainer] アーカイブなし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const allFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  if (allFiles.length === 0) {
    logger.info('[V2Trainer] アーカイブなし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const current = loadModels();

  // 初回（モデルなし / lastTrainedAt なし）はフルトレーニングに委譲
  if (!current || !current.lastTrainedAt) {
    logger.info('[V2Trainer] 初回学習: フルトレーニングに委譲');
    return trainV2();
  }

  const lastTrainedMs = new Date(current.lastTrainedAt).getTime();

  const newFiles = allFiles.filter(f => {
    try {
      return fs.statSync(path.join(HISTORY_DIR, f)).mtimeMs > lastTrainedMs;
    } catch {
      return false;
    }
  });

  if (newFiles.length === 0) {
    logger.info('[V2Trainer] 差分なし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_new_data', sampleCount: current.sampleCount || 0 };
  }

  logger.info(`[V2Trainer] 差分検出: ${newFiles.length}/${allFiles.length}ファイル — 全データ再学習`);
  const result = trainV2();
  return result.skipped ? result : { ...result, incremental: true };
}

// ─────────────────────────────────────────────────────
// getV2Stats() — 保存済みモデルの統計を返す（Discord 表示用）
// ─────────────────────────────────────────────────────
function getV2Stats() {
  const m = loadModels();
  if (!m) return null;

  return {
    version:         m.version,
    sampleCount:     m.sampleCount,
    timeSampleCount: m.timeSampleCount,
    lastTrainedAt:   m.lastTrainedAt,
    hasSuccessModel: !!m.successModel,
    hasTimeModel:    !!m.timeModel,
    successTrainedAt: m.successModel?.trainedAt ?? null,
    timeTrainedAt:    m.timeModel?.trainedAt    ?? null,
    metrics:          m.metrics ?? null,
  };
}

module.exports = { trainV2, trainIncrementalV2, loadModels, getV2Stats, _checkClassBalance };
