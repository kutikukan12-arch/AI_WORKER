'use strict';

// =====================================================
// ai-predictor-trainer.js — AI 予測モデル トレーニング
//
// 役割:
//   data/history/*.json（完了済みタスクのアーカイブ）を分析し、
//   ai-predictor.js が使うウェイトを調整して保存する。
//
// 学習対象:
//   1. typeSuccessAdjustments — タスクタイプ別の成功確率補正値
//   2. typeTimeMultipliers    — タスクタイプ別の時間推定乗数
//
// 学習アルゴリズム:
//   指数平滑化（学習率 LEARNING_RATE = 0.3）で段階的に更新。
//   過去の学習済み値を 70% 保持しながら新しいデータを 30% 反映する。
//
// 保存先: data/predictor-weights.json
// 依存:   logger.js のみ
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const HISTORY_DIR  = path.join(DATA_DIR, 'history');
const WEIGHTS_FILE = path.join(DATA_DIR, 'predictor-weights.json');
const WEIGHTS_TMP  = WEIGHTS_FILE + '.tmp';

const LEARNING_RATE          = 0.3;  // 指数平滑化の学習率 (0〜1)
const MIN_SAMPLES            = 3;    // 学習に必要な最低サンプル数
const RECENCY_HALF_LIFE_DAYS = 60;   // 60日前のタスクは重み 0.5 で学習
const CHUNK_SIZE             = 20;   // 一度に処理する history ファイル数

// ─── ai-predictor.js の TYPE_BASE と一致させる ───
const TYPE_BASE_SUCCESS = {
  IMPLEMENT: 75, FIX: 80, RESEARCH: 90, DESIGN: 85,
  REVIEW: 92,   DOCS: 88, OPS: 85,     TEST: 82,
};

// タイプ別デフォルト時間推定の中間値 (timeMin + timeMax) / 2
const TYPE_BASE_TIME_MID = {
  IMPLEMENT: 35, FIX: 17.5, RESEARCH: 12.5, DESIGN: 12.5,
  REVIEW: 9,    DOCS: 15,  OPS: 6.5,        TEST: 19,
};

// ─────────────────────────────────────────────────────
// 内部: タスクの近年重みを計算する
//
// updatedAt（完了日時）に基づいて指数減衰を適用する。
// RECENCY_HALF_LIFE_DAYS 日前のタスクは重み 0.5。
// ─────────────────────────────────────────────────────
function _recencyWeight(task) {
  const updatedAt = task.updatedAt;
  if (!updatedAt) return 1.0;
  const daysOld = (Date.now() - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, daysOld / RECENCY_HALF_LIFE_DAYS);
}

// ─────────────────────────────────────────────────────
// 内部: history ファイルを CHUNK_SIZE 単位で処理し、
//       タスク配列を保持せずタイプ別の集計値のみ返す。
//
// 戻り値:
//   {
//     stats: {
//       [type]: {
//         count, totalWeight,
//         weightedSuccessSum,
//         durWeightedSum, durTotalWeight, durCount
//       }
//     },
//     totalTasks: number,
//   }
// ─────────────────────────────────────────────────────
function _collectStats(historyFiles) {
  const stats = {};
  let totalTasks = 0;

  for (let i = 0; i < historyFiles.length; i += CHUNK_SIZE) {
    const chunk = historyFiles.slice(i, i + CHUNK_SIZE);
    for (const file of chunk) {
      let tasks;
      try {
        const raw  = fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8');
        const data = JSON.parse(raw);
        tasks = Array.isArray(data.tasks) ? data.tasks : [];
      } catch (e) {
        logger.warn(`[Trainer] ${file} 読み込み失敗: ${e.message}`);
        continue;
      }
      for (const t of tasks) {
        const type = t.type || 'IMPLEMENT';
        if (!stats[type]) {
          stats[type] = {
            count: 0, totalWeight: 0,
            weightedSuccessSum: 0, successTotalWeight: 0,  // reviewResult あり分のみ
            durWeightedSum: 0, durTotalWeight: 0, durCount: 0,
          };
        }
        const w = _recencyWeight(t);
        stats[type].totalWeight += w;
        stats[type].count++;
        totalTasks++;
        const passResult = _isFirstPassOk(t);
        if (passResult !== null) {
          stats[type].successTotalWeight += w;
          if (passResult) stats[type].weightedSuccessSum += w;
        }
        const dur = _computeDuration(t);
        if (dur !== null) {
          stats[type].durWeightedSum  += dur * w;
          stats[type].durTotalWeight  += w;
          stats[type].durCount++;
        }
      }
      // tasks はスコープを抜けた時点で GC 対象
    }
  }

  return { stats, totalTasks };
}

// ─────────────────────────────────────────────────────
// 内部: タスクの実際の所要時間（分）を算出する
//
// stateHistory の最初〜最後の差分を使う。
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
// 内部: タスクの初回レビュー通過判定
//
// 戻り値: true=通過, false=要修正, null=未レビュー（ラベル不明）
// '修正推奨' や '却下推奨' を含む場合 = 要修正
// reviewResult がない場合は null を返し、呼び出し元でラベル集計から除外する。
// ─────────────────────────────────────────────────────
function _isFirstPassOk(task) {
  if (!task.reviewResult) return null;  // 未レビュー = ラベル不明
  const r = String(task.reviewResult);
  if (r.includes('修正推奨') || r.includes('却下推奨')) return false;
  return true;
}

// ─────────────────────────────────────────────────────
// loadWeights() — 保存済みウェイトを返す（なければ null）
// ─────────────────────────────────────────────────────
function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE))
      return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
  } catch {}
  return null;
}

// ─────────────────────────────────────────────────────
// defaultWeights() — 初期ウェイト（全補正なし）
// ─────────────────────────────────────────────────────
function defaultWeights() {
  return {
    version: 1,
    sampleCount: 0,
    lastTrainedAt: null,
    routingAdjustments: { 'Codex': 1.0, 'ChatGPT': 1.0, 'Claude Code': 1.0 },
    typeSuccessAdjustments: {},
    typeTimeMultipliers: {},
    accuracy: {
      outcomeSamples: 0,
      avgTimeAccuracy: null,
      avgSuccessAccuracy: null,
      avgTimeMAPE: null,
      avgDirectionalAcc: null,
    },
  };
}

// ─────────────────────────────────────────────────────
// train()
//
// history ファイルを CHUNK_SIZE 単位で読み込んでウェイトを更新し、
// アトミック書き込み（.tmp → rename）で predictor-weights.json に保存する。
//
// 戻り値:
//   { skipped: true, reason, sampleCount }               — データ不足でスキップ
//   { skipped: false, sampleCount, weights, typeReport } — 学習完了
// ─────────────────────────────────────────────────────
function train() {
  if (!fs.existsSync(HISTORY_DIR)) {
    logger.info('[Trainer] アーカイブなし: トレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const historyFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  if (historyFiles.length === 0) {
    logger.info('[Trainer] アーカイブなし: トレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  // チャンク単位でファイルを処理し、集計値のみメモリに保持する
  const { stats, totalTasks } = _collectStats(historyFiles);

  if (totalTasks === 0) {
    logger.info('[Trainer] タスクデータなし: トレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const current       = loadWeights() || defaultWeights();
  const newSuccessAdj = { ...current.typeSuccessAdjustments };
  const newTimeMult   = { ...current.typeTimeMultipliers };
  let timeAccTotal    = 0;
  let timeAccCount    = 0;
  let successAccTotal = 0;
  let successAccCount = 0;
  let timeMAPETotal   = 0;
  let timeMAPECount   = 0;
  let dirAccTotal     = 0;
  let dirAccCount     = 0;
  const typeReport    = {};

  for (const [type, s] of Object.entries(stats)) {
    // ── 成功確率補正（reviewResult ありのタスクのみ使用）──
    if (s.count >= MIN_SAMPLES && s.successTotalWeight > 0) {
      const actualRate    = (s.weightedSuccessSum / s.successTotalWeight) * 100;
      const baseRate      = TYPE_BASE_SUCCESS[type] || 75;
      const curAdj        = current.typeSuccessAdjustments[type] || 0;
      const targetAdj     = actualRate - baseRate;
      newSuccessAdj[type] = Math.round(curAdj + (targetAdj - curAdj) * LEARNING_RATE);

      // 精度計算は更新前の curAdj を使用（水増し防止）
      const predictedRate = Math.min(100, Math.max(0, baseRate + curAdj));
      const sAcc = 1 - Math.abs(predictedRate - actualRate) / Math.max(predictedRate, actualRate, 1);
      successAccTotal += sAcc;
      successAccCount++;

      // 方向性正解率: predicted と actual が 50% 閾値の同じ側にあるか
      const dirMatch = (predictedRate >= 50) === (actualRate >= 50) ? 1 : 0;
      dirAccTotal += dirMatch;
      dirAccCount++;
    }

    // ── 時間推定乗数 ──
    let timeMult = current.typeTimeMultipliers[type] || 1.0;
    if (s.durCount >= MIN_SAMPLES) {
      const weightedAvg  = s.durWeightedSum / s.durTotalWeight;
      const baseMid      = TYPE_BASE_TIME_MID[type] || 35;
      const targetM      = weightedAvg / baseMid;

      // 精度計算は更新前の timeMult を使用（水増し防止）
      const predictedMid = baseMid * timeMult;
      const acc = 1 - Math.abs(predictedMid - weightedAvg) / Math.max(predictedMid, weightedAvg, 1);
      timeAccTotal += acc;
      timeAccCount++;

      // MAPE: |predicted - actual| / actual × 100
      if (weightedAvg > 0) {
        timeMAPETotal += Math.abs(predictedMid - weightedAvg) / weightedAvg * 100;
        timeMAPECount++;
      }

      timeMult          = Math.round((timeMult + (targetM - timeMult) * LEARNING_RATE) * 100) / 100;
      newTimeMult[type] = timeMult;
    }

    typeReport[type] = {
      samples:        s.count,
      reviewedSamples: Math.round(s.successTotalWeight),  // レビュー済みタスク重み合計
      timeSamples:    s.durCount,
      successAdj:     newSuccessAdj[type] ?? 0,
      timeMult,
    };
  }

  const avgTimeAccuracy = timeAccCount > 0
    ? Math.round(timeAccTotal / timeAccCount * 1000) / 1000
    : current.accuracy?.avgTimeAccuracy ?? null;

  const avgSuccessAccuracy = successAccCount > 0
    ? Math.round(successAccTotal / successAccCount * 1000) / 1000
    : current.accuracy?.avgSuccessAccuracy ?? null;

  const avgTimeMAPE = timeMAPECount > 0
    ? Math.round(timeMAPETotal / timeMAPECount * 10) / 10
    : current.accuracy?.avgTimeMAPE ?? null;

  const avgDirectionalAcc = dirAccCount > 0
    ? Math.round(dirAccTotal / dirAccCount * 1000) / 1000
    : current.accuracy?.avgDirectionalAcc ?? null;

  const trainedWeights = {
    version: 1,
    sampleCount: totalTasks,
    lastTrainedAt: new Date().toISOString(),
    routingAdjustments:     current.routingAdjustments,
    typeSuccessAdjustments: newSuccessAdj,
    typeTimeMultipliers:    newTimeMult,
    accuracy: { outcomeSamples: totalTasks, avgTimeAccuracy, avgSuccessAccuracy, avgTimeMAPE, avgDirectionalAcc },
  };

  // アトミック書き込み: .tmp に書いてからリネーム（書き込み中クラッシュでファイル破損しない）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WEIGHTS_TMP, JSON.stringify(trainedWeights, null, 2), 'utf8');
  fs.renameSync(WEIGHTS_TMP, WEIGHTS_FILE);

  logger.info(
    `[Trainer] 完了 | samples:${totalTasks} | ` +
    `時間精度:${avgTimeAccuracy !== null ? (avgTimeAccuracy * 100).toFixed(1) + '%' : 'N/A'} | ` +
    `MAPE:${avgTimeMAPE !== null ? avgTimeMAPE.toFixed(1) + '%' : 'N/A'} | ` +
    `成功率精度:${avgSuccessAccuracy !== null ? (avgSuccessAccuracy * 100).toFixed(1) + '%' : 'N/A'} | ` +
    `方向性正解率:${avgDirectionalAcc !== null ? (avgDirectionalAcc * 100).toFixed(1) + '%' : 'N/A'}`
  );

  return { skipped: false, sampleCount: totalTasks, weights: trainedWeights, typeReport };
}

// ─────────────────────────────────────────────────────
// trainIncremental()
//
// 前回トレーニング以降に mtime が更新された history ファイルのみ処理し、
// 既存ウェイトへ差分学習を適用する（ナイトバッチ用）。
//
// 初回（lastTrainedAt なし）は train() に委譲する。
// 差分ファイルが 0 件の場合はスキップを返す。
//
// 戻り値:
//   train() と同じ形式 + incremental:true + newSampleCount:number
//   { skipped: true, reason: 'no_new_data', sampleCount } — 差分なし
// ─────────────────────────────────────────────────────
function trainIncremental() {
  if (!fs.existsSync(HISTORY_DIR)) {
    logger.info('[Trainer] アーカイブなし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const allFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  if (allFiles.length === 0) {
    logger.info('[Trainer] アーカイブなし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_data', sampleCount: 0 };
  }

  const current = loadWeights();

  // 初回（ウェイトなし / lastTrainedAt なし）はフルトレーニングに委譲
  if (!current || !current.lastTrainedAt) {
    logger.info('[Trainer] 初回学習: フルトレーニングに委譲');
    return train();
  }

  const lastTrainedMs = new Date(current.lastTrainedAt).getTime();

  // 前回トレーニング後に更新されたファイルのみ対象（mtime 比較）
  const newFiles = allFiles.filter(f => {
    try {
      return fs.statSync(path.join(HISTORY_DIR, f)).mtimeMs > lastTrainedMs;
    } catch {
      return false;
    }
  });

  if (newFiles.length === 0) {
    logger.info('[Trainer] 差分なし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_new_data', sampleCount: current.sampleCount || 0 };
  }

  logger.info(`[Trainer] インクリメンタル学習: ${newFiles.length}/${allFiles.length}ファイル`);

  const { stats, totalTasks: newTasks } = _collectStats(newFiles);

  if (newTasks === 0) {
    logger.info('[Trainer] 差分データなし: インクリメンタルトレーニングをスキップ');
    return { skipped: true, reason: 'no_new_data', sampleCount: current.sampleCount || 0 };
  }

  const newSuccessAdj = { ...current.typeSuccessAdjustments };
  const newTimeMult   = { ...current.typeTimeMultipliers };
  let timeAccTotal    = 0;
  let timeAccCount    = 0;
  let successAccTotal = 0;
  let successAccCount = 0;
  let timeMAPETotal   = 0;
  let timeMAPECount   = 0;
  let dirAccTotal     = 0;
  let dirAccCount     = 0;
  const typeReport    = {};

  for (const [type, s] of Object.entries(stats)) {
    // ── 成功確率補正（reviewResult ありのタスクのみ使用）──
    if (s.count >= MIN_SAMPLES && s.successTotalWeight > 0) {
      const actualRate    = (s.weightedSuccessSum / s.successTotalWeight) * 100;
      const baseRate      = TYPE_BASE_SUCCESS[type] || 75;
      const curAdj        = current.typeSuccessAdjustments[type] || 0;
      const targetAdj     = actualRate - baseRate;
      newSuccessAdj[type] = Math.round(curAdj + (targetAdj - curAdj) * LEARNING_RATE);

      const predictedRate = Math.min(100, Math.max(0, baseRate + curAdj));
      const sAcc = 1 - Math.abs(predictedRate - actualRate) / Math.max(predictedRate, actualRate, 1);
      successAccTotal += sAcc;
      successAccCount++;

      const dirMatch = (predictedRate >= 50) === (actualRate >= 50) ? 1 : 0;
      dirAccTotal += dirMatch;
      dirAccCount++;
    }

    let timeMult = current.typeTimeMultipliers[type] || 1.0;
    if (s.durCount >= MIN_SAMPLES) {
      const weightedAvg  = s.durWeightedSum / s.durTotalWeight;
      const baseMid      = TYPE_BASE_TIME_MID[type] || 35;
      const targetM      = weightedAvg / baseMid;

      const predictedMid = baseMid * timeMult;
      const acc = 1 - Math.abs(predictedMid - weightedAvg) / Math.max(predictedMid, weightedAvg, 1);
      timeAccTotal += acc;
      timeAccCount++;

      if (weightedAvg > 0) {
        timeMAPETotal += Math.abs(predictedMid - weightedAvg) / weightedAvg * 100;
        timeMAPECount++;
      }

      timeMult          = Math.round((timeMult + (targetM - timeMult) * LEARNING_RATE) * 100) / 100;
      newTimeMult[type] = timeMult;
    }

    typeReport[type] = {
      samples:         s.count,
      reviewedSamples: Math.round(s.successTotalWeight),
      timeSamples:     s.durCount,
      successAdj:      newSuccessAdj[type] ?? 0,
      timeMult,
    };
  }

  const avgTimeAccuracy = timeAccCount > 0
    ? Math.round(timeAccTotal / timeAccCount * 1000) / 1000
    : current.accuracy?.avgTimeAccuracy ?? null;

  const avgSuccessAccuracy = successAccCount > 0
    ? Math.round(successAccTotal / successAccCount * 1000) / 1000
    : current.accuracy?.avgSuccessAccuracy ?? null;

  const avgTimeMAPE = timeMAPECount > 0
    ? Math.round(timeMAPETotal / timeMAPECount * 10) / 10
    : current.accuracy?.avgTimeMAPE ?? null;

  const avgDirectionalAcc = dirAccCount > 0
    ? Math.round(dirAccTotal / dirAccCount * 1000) / 1000
    : current.accuracy?.avgDirectionalAcc ?? null;

  const totalSamples = (current.sampleCount || 0) + newTasks;

  const trainedWeights = {
    version: 1,
    sampleCount: totalSamples,
    lastTrainedAt: new Date().toISOString(),
    routingAdjustments:     current.routingAdjustments,
    typeSuccessAdjustments: newSuccessAdj,
    typeTimeMultipliers:    newTimeMult,
    accuracy: { outcomeSamples: totalSamples, avgTimeAccuracy, avgSuccessAccuracy, avgTimeMAPE, avgDirectionalAcc },
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WEIGHTS_TMP, JSON.stringify(trainedWeights, null, 2), 'utf8');
  fs.renameSync(WEIGHTS_TMP, WEIGHTS_FILE);

  logger.info(
    `[Trainer] インクリメンタル完了 | new:${newTasks} total:${totalSamples} | ` +
    `時間精度:${avgTimeAccuracy !== null ? (avgTimeAccuracy * 100).toFixed(1) + '%' : 'N/A'} | ` +
    `MAPE:${avgTimeMAPE !== null ? avgTimeMAPE.toFixed(1) + '%' : 'N/A'} | ` +
    `成功率精度:${avgSuccessAccuracy !== null ? (avgSuccessAccuracy * 100).toFixed(1) + '%' : 'N/A'} | ` +
    `方向性正解率:${avgDirectionalAcc !== null ? (avgDirectionalAcc * 100).toFixed(1) + '%' : 'N/A'}`
  );

  return {
    skipped: false,
    sampleCount: totalSamples,
    newSampleCount: newTasks,
    weights: trainedWeights,
    typeReport,
    incremental: true,
  };
}

// ─────────────────────────────────────────────────────
// getStats() — 現在のウェイト統計を返す（Discord 表示用）
// ─────────────────────────────────────────────────────
function getStats() {
  const w = loadWeights();
  if (!w) return null;

  return {
    sampleCount:            w.sampleCount,
    lastTrainedAt:          w.lastTrainedAt,
    accuracy:               w.accuracy,   // { outcomeSamples, avgTimeAccuracy, avgSuccessAccuracy }
    typeSuccessAdjustments: w.typeSuccessAdjustments,
    typeTimeMultipliers:    w.typeTimeMultipliers,
    routingAdjustments:     w.routingAdjustments,
  };
}

module.exports = { train, trainIncremental, getStats, loadWeights, defaultWeights };
