'use strict';

// =====================================================
// night-batch.js - 定期バッチ処理（デフォルト: 毎日2:00）
//
// 役割:
//   夜間にログ整理・ドキュメント整理・タスク確認・
//   GitHub状態確認・Discord通知を自動実行する。
//
// 重要:
//   - 削除・危険操作は一切行わない（7日超えログはアーカイブのみ）
//   - パッケージ追加なし（Node.js標準モジュールのみ）
//   - 実行上限あり（無限ループ防止）
//
// 設定（.env）:
//   BATCH_ENABLED=true        バッチを有効化
//   BATCH_HOUR=2              実行時刻（時）
//   BATCH_MINUTE=0            実行時刻（分）
//   BATCH_CHANNEL_ID=         Discord通知先チャンネル（空=コマンドchへ）
//   BATCH_MAX_RUNS=0          最大実行回数（0=無制限）
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const taskManager = require('./task-manager');
const trainer    = require('./ai-predictor-trainer');
const v2Trainer  = require('./ai-model-v2-trainer');
const predictor  = require('./ai-predictor');

// ─── 設定 ───
const BATCH_HOUR     = parseInt(process.env.BATCH_HOUR    || '2',  10);
const BATCH_MINUTE   = parseInt(process.env.BATCH_MINUTE  || '0',  10);
const BATCH_MAX_RUNS = parseInt(process.env.BATCH_MAX_RUNS || '0', 10);
const BATCH_CHANNEL_ID = process.env.BATCH_CHANNEL_ID || '';

// Phase5: 朝バッチ設定
const MORNING_BATCH_HOUR    = parseInt(process.env.MORNING_BATCH_HOUR   || '8', 10);
const MORNING_BATCH_MINUTE  = parseInt(process.env.MORNING_BATCH_MINUTE || '0', 10);
const MORNING_BATCH_CHANNEL_ID = process.env.MORNING_BATCH_CHANNEL_ID || BATCH_CHANNEL_ID;
// 社長向け日報の投稿先（#📊-日報）。未設定なら朝バッチchへフォールバック
const CEO_REPORT_CHANNEL_ID = process.env.CEO_REPORT_CHANNEL_ID || '';

// ─── パス ───
const ROOT_DIR    = path.join(__dirname, '..', '..');
const LOGS_DIR    = path.join(ROOT_DIR, 'logs');
const REVIEWS_DIR = path.join(ROOT_DIR, 'reviews');
const DOCS_DIR    = path.join(ROOT_DIR, 'docs');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'logs', 'archive');

let runCount = 0;
let batchTimer   = null;
let morningTimer = null;

// ─────────────────────────────────────────────────────
// ログアーカイブ（7日超のログを archive/ フォルダへ移動）
// ─────────────────────────────────────────────────────
function archiveLogs() {
  const results = [];
  if (!fs.existsSync(LOGS_DIR)) return results;
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7日前
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));

  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      const dest = path.join(ARCHIVE_DIR, file);
      fs.renameSync(filePath, dest);
      results.push(`ログアーカイブ: ${file} → archive/`);
      logger.info(`ログアーカイブ: ${file}`);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────
// reviews/ の整理（30日超えの codex_*.md を archive へ）
// ─────────────────────────────────────────────────────
function archiveReviews() {
  const results = [];
  if (!fs.existsSync(REVIEWS_DIR)) return results;

  const reviewArchive = path.join(REVIEWS_DIR, 'archive');
  if (!fs.existsSync(reviewArchive)) fs.mkdirSync(reviewArchive, { recursive: true });

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30日前
  const patterns = ['codex_', 'review_'];

  for (const pattern of patterns) {
    const files = fs.readdirSync(REVIEWS_DIR)
      .filter(f => f.startsWith(pattern) && f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(REVIEWS_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        const dest = path.join(reviewArchive, file);
        fs.renameSync(filePath, dest);
        results.push(`レビューアーカイブ: ${file}`);
        logger.info(`レビューアーカイブ: ${file}`);
      }
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────
// 未完了タスクの確認
// ─────────────────────────────────────────────────────
function checkIncompleteTasks() {
  const tasks = taskManager.listTasks();
  const inProgress = tasks.filter(t => t.state === taskManager.STATES.IN_PROGRESS);
  const awaiting   = tasks.filter(t => t.state === taskManager.STATES.AWAITING);
  const stuck = [];

  // 24時間以上「作業中」のタスクを検出
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  for (const t of inProgress) {
    if (new Date(t.updatedAt).getTime() < cutoff24h) {
      stuck.push({ id: t.id, state: t.state, hours: Math.floor((Date.now() - new Date(t.updatedAt).getTime()) / 3600000) });
    }
  }

  return { inProgress: inProgress.length, awaiting: awaiting.length, stuck };
}

// ─────────────────────────────────────────────────────
// GitHub 接続確認（token が設定されているか確認のみ）
// ─────────────────────────────────────────────────────
async function checkGitHubStatus() {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !repo) return { connected: false, reason: 'GITHUB_TOKEN / GITHUB_REPO 未設定' };

  try {
    const [owner, repoName] = repo.split('/');
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );
    if (response.ok) {
      const data = await response.json();
      return { connected: true, repo: data.full_name, defaultBranch: data.default_branch };
    }
    return { connected: false, reason: `HTTP ${response.status}` };
  } catch (e) {
    return { connected: false, reason: e.message };
  }
}

// ─────────────────────────────────────────────────────
// バッチレポートを docs/ に保存
// ─────────────────────────────────────────────────────
function saveBatchReport(report) {
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(DOCS_DIR, `batch_${date}.md`);

  const tr = report.trainResult;
  const trainSection = tr === null
    ? '⚠️ トレーニング失敗（ログ参照）'
    : tr.skipped
    ? `スキップ（${tr.reason === 'no_new_data' ? '差分なし' : tr.reason}）`
    : `✅ ${tr.incremental ? `インクリメンタル完了 | 新規: ${tr.newSampleCount}件 / 累計: ${tr.sampleCount}件` : `完了 | サンプル: ${tr.sampleCount}件`} | ` +
      Object.entries(tr.typeReport || {})
        .map(([t, r]) => `${t}(n=${r.samples},adj=${r.successAdj >= 0 ? '+' : ''}${r.successAdj},×${r.timeMult})`)
        .join(' / ');

  const v2tr = report.v2TrainResult;
  const v2TrainSection = v2tr === null
    ? '⚠️ V2トレーニング失敗（ログ参照）'
    : v2tr.skipped
    ? `スキップ（${v2tr.reason === 'no_new_data' ? '差分なし' : v2tr.reason}）`
    : `✅ ${v2tr.incremental ? `差分検出→全再学習 | samples:${v2tr.sampleCount} timeSamples:${v2tr.timeSampleCount}` : `完了 | samples:${v2tr.sampleCount} timeSamples:${v2tr.timeSampleCount}`}`;

  const content = [
    `# ナイトバッチレポート ${date}`,
    ``,
    `実行日時: ${new Date().toLocaleString('ja-JP')}`,
    `実行回数: ${report.runCount}回目`,
    ``,
    `## ログアーカイブ`,
    report.logResults.length > 0 ? report.logResults.join('\n') : 'なし',
    ``,
    `## レビューアーカイブ`,
    report.reviewResults.length > 0 ? report.reviewResults.join('\n') : 'なし',
    ``,
    `## タスク状況`,
    `- 作業中: ${report.taskStatus.inProgress}件`,
    `- 人間確認待ち: ${report.taskStatus.awaiting}件`,
    report.taskStatus.stuck.length > 0
      ? `- ⚠️ 24時間以上停止中: ${report.taskStatus.stuck.map(s => `${s.id}（${s.hours}時間）`).join(', ')}`
      : '- 停止タスクなし',
    ``,
    `## GitHub 接続`,
    report.github.connected
      ? `✅ 接続OK: ${report.github.repo}（デフォルトブランチ: ${report.github.defaultBranch}）`
      : `❌ 接続失敗: ${report.github.reason}`,
    ``,
    `## AI 予測モデル トレーニング（V1: ルールベース）`,
    trainSection,
    ``,
    `## AI ML モデル トレーニング（V2: LogisticRegression / LinearRegression）`,
    v2TrainSection,
  ].join('\n');

  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ─────────────────────────────────────────────────────
// バッチ処理の本体
// ─────────────────────────────────────────────────────
async function runBatch(notifyFn = null) {
  // 実行上限チェック
  if (BATCH_MAX_RUNS > 0 && runCount >= BATCH_MAX_RUNS) {
    logger.info(`バッチ上限 ${BATCH_MAX_RUNS} 回に達しました。バッチを停止します。`);
    stopBatch();
    return null;
  }

  runCount++;
  logger.info(`ナイトバッチ開始 (${runCount}回目)`);

  // 各処理を実行
  const logResults    = archiveLogs();
  const reviewResults = archiveReviews();
  const taskStatus    = checkIncompleteTasks();
  const github        = await checkGitHubStatus();

  // V1: ルールベース AI 予測モデルのトレーニング（差分のみ学習）
  let trainResult = null;
  try {
    trainResult = trainer.trainIncremental();
    if (trainResult && !trainResult.skipped) {
      predictor.reloadWeights();
      const label = trainResult.incremental
        ? `インクリメンタル完了 | new:${trainResult.newSampleCount} total:${trainResult.sampleCount}`
        : `フル完了 | samples:${trainResult.sampleCount}`;
      logger.info(`[Batch] トレーニング${label}`);
    } else {
      logger.info(`[Batch] トレーニングスキップ | reason:${trainResult?.reason}`);
    }
  } catch (e) {
    logger.warn(`[Batch] トレーニング失敗: ${e.message}`);
  }

  // V2: ML モデル（LogisticRegression / LinearRegression）のトレーニング
  let v2TrainResult = null;
  try {
    v2TrainResult = v2Trainer.trainIncrementalV2();
    if (v2TrainResult && !v2TrainResult.skipped) {
      predictor.reloadV2Models();
      logger.info(`[Batch] V2トレーニング完了 | samples:${v2TrainResult.sampleCount} timeSamples:${v2TrainResult.timeSampleCount}`);
    } else {
      logger.info(`[Batch] V2トレーニングスキップ | reason:${v2TrainResult?.reason}`);
    }
  } catch (e) {
    logger.warn(`[Batch] V2トレーニング失敗: ${e.message}`);
  }

  const report = { runCount, logResults, reviewResults, taskStatus, github, trainResult, v2TrainResult };
  const reportFile = saveBatchReport(report);

  // Discord 通知テキストを生成
  const stats = taskManager.getStats();
  const stuckWarn = taskStatus.stuck.length > 0
    ? `\n⚠️ **24時間以上停止中のタスク:** ${taskStatus.stuck.map(s => `\`${s.id}\`（${s.hours}h）`).join(', ')}`
    : '';
  const awaitWarn = taskStatus.awaiting > 0
    ? `\n❓ **人間確認待ちタスク:** ${taskStatus.awaiting}件`
    : '';

  const trainLine = trainResult === null
    ? `🤖 **AIトレーニング(V1)**: ⚠️ 失敗（ログ参照）`
    : trainResult.skipped
    ? `🤖 **AIトレーニング(V1)**: ⭕ スキップ（${trainResult.reason === 'no_data' ? 'データなし' : trainResult.reason === 'no_new_data' ? '差分なし' : trainResult.reason}）`
    : trainResult.incremental
    ? `🤖 **AIトレーニング(V1)**: ✅ 差分学習 | +${trainResult.newSampleCount}件（累計 ${trainResult.sampleCount}件）`
    : `🤖 **AIトレーニング(V1)**: ✅ 完了 | ${trainResult.sampleCount}サンプル`;

  const v2TrainLine = v2TrainResult === null
    ? `🧠 **ML モデル(V2)**: ⚠️ 失敗（ログ参照）`
    : v2TrainResult.skipped
    ? `🧠 **ML モデル(V2)**: ⭕ スキップ（${v2TrainResult.reason === 'no_data' ? 'データなし' : v2TrainResult.reason === 'no_new_data' ? '差分なし' : v2TrainResult.reason}）`
    : (() => {
        let line = `🧠 **ML モデル(V2)**: ✅ 学習完了 | success:${v2TrainResult.sampleCount}件 time:${v2TrainResult.timeSampleCount}件`;
        if (v2TrainResult.successDirectionalAcc !== null && v2TrainResult.successDirectionalAcc !== undefined)
          line += ` | 方向性正解率:${(v2TrainResult.successDirectionalAcc * 100).toFixed(1)}%`;
        if (v2TrainResult.timeMAPE !== null && v2TrainResult.timeMAPE !== undefined)
          line += ` | MAPE:${v2TrainResult.timeMAPE.toFixed(1)}%`;
        return line;
      })();

  const message = [
    `🌙 **ナイトバッチ完了** (${new Date().toLocaleString('ja-JP')})`,
    ``,
    `📁 ログアーカイブ: ${logResults.length}件`,
    `📋 レビューアーカイブ: ${reviewResults.length}件`,
    ``,
    `📊 **タスク状況**`,
    `> 全体: ${stats.total}件 | 作業中: ${stats.counts['作業中'] || 0}件 | 未着手: ${stats.counts['未着手'] || 0}件`,
    stuckWarn,
    awaitWarn,
    ``,
    `🔗 **GitHub**: ${github.connected ? `✅ ${github.repo}` : `❌ ${github.reason}`}`,
    ``,
    trainLine,
    v2TrainLine,
    ``,
    `📄 レポート: \`docs/batch_${new Date().toISOString().slice(0, 10)}.md\``,
  ].filter(l => l !== undefined).join('\n');

  // Discord へ通知
  if (notifyFn) {
    await notifyFn(BATCH_CHANNEL_ID, message);
  }

  logger.info(`ナイトバッチ完了 | ログ${logResults.length}件 | レビュー${reviewResults.length}件`);
  return { report, message, reportFile };
}

// ─────────────────────────────────────────────────────
// Phase5: 朝バッチ — アクティブタスクの優先度再評価
// ─────────────────────────────────────────────────────
async function runMorningBatch(notifyFn = null) {
  logger.info('朝バッチ開始: アクティブタスクの優先度再評価');
  const priorityUtil = require('./priority');

  const activeStates = [
    taskManager.STATES.PENDING,
    taskManager.STATES.IN_PROGRESS,
    taskManager.STATES.REVIEWING,
    taskManager.STATES.AWAITING,
    taskManager.STATES.ON_HOLD,
  ];

  const tasks       = taskManager.listTasks();
  const active      = tasks.filter(t => activeStates.includes(t.state));
  const updated     = [];

  for (const task of active) {
    const { priority: newP, reason } = priorityUtil.calculate(
      task.prompt || '', task.dangerLevel || '低'
    );
    if (newP !== task.priority) {
      taskManager.updateTask(task.id, { priority: newP, priorityReason: reason });
      updated.push({ id: task.id, from: task.priority, to: newP });
      logger.info(`朝バッチ: 優先度変更 ${task.id} ${task.priority}→${newP}`);
    }
  }

  // 24時間以上「人間確認待ち」のタスクを警告
  const cutoff24h     = Date.now() - 24 * 60 * 60 * 1000;
  const longAwaiting  = active.filter(t =>
    t.state === taskManager.STATES.AWAITING &&
    new Date(t.updatedAt).getTime() < cutoff24h
  );

  const lines = [
    `☀️ **朝バッチ完了** (${new Date().toLocaleString('ja-JP')})`,
    ``,
    `📊 **アクティブタスク:** ${active.length}件`,
    updated.length > 0
      ? `🔄 **優先度更新:** ${updated.map(u => `\`${u.id}\` ${u.from}→${u.to}`).join(', ')}`
      : `✅ 優先度変更なし`,
    longAwaiting.length > 0
      ? `⚠️ **24h以上 人間確認待ち:** ${longAwaiting.map(t => `\`${t.id}\``).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');

  if (notifyFn) await notifyFn(MORNING_BATCH_CHANNEL_ID, lines);

  // ─── 社長向け日報を #📊-日報 へ自動投稿 ───
  if (notifyFn) {
    try {
      const ceoReport = require('./ceo-report');
      const digest    = ceoReport.formatDailyDigest(taskManager);
      await notifyFn(CEO_REPORT_CHANNEL_ID || MORNING_BATCH_CHANNEL_ID, digest);
      logger.info('日報を #📊-日報 へ自動投稿しました');
    } catch (e) {
      logger.warn(`日報の自動投稿に失敗（朝バッチは継続）: ${e.message}`);
    }
  }

  logger.info(`朝バッチ完了 | アクティブ${active.length}件 | 優先度更新${updated.length}件`);
  return { active: active.length, updated, longAwaiting };
}

// ─────────────────────────────────────────────────────
// 朝バッチスケジューラーを開始する
// ─────────────────────────────────────────────────────
function startMorningBatch(notifyFn = null) {
  if (morningTimer) {
    logger.warn('朝バッチはすでに起動中です');
    return;
  }

  logger.info(`朝バッチ スケジュール開始: 毎日 ${MORNING_BATCH_HOUR}:${String(MORNING_BATCH_MINUTE).padStart(2, '0')}`);

  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(MORNING_BATCH_HOUR, MORNING_BATCH_MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    logger.info(`次回朝バッチ: ${next.toLocaleString('ja-JP')} (${Math.round(delay / 60000)}分後)`);

    morningTimer = setTimeout(async () => {
      await runMorningBatch(notifyFn);
      morningTimer = null;
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ─────────────────────────────────────────────────────
// バッチスケジューラーを開始する
//
// 引数:
//   notifyFn - Discord 通知関数 (channelId, text) => Promise
// ─────────────────────────────────────────────────────
function startBatch(notifyFn = null) {
  if (batchTimer) {
    logger.warn('バッチはすでに起動中です');
    return;
  }

  logger.info(`ナイトバッチ スケジュール開始: 毎日 ${BATCH_HOUR}:${String(BATCH_MINUTE).padStart(2, '0')}`);

  // 次回実行時刻を計算
  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(BATCH_HOUR, BATCH_MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1); // 今日の時刻が過ぎていれば翌日

    const delay = next.getTime() - now.getTime();
    logger.info(`次回バッチ: ${next.toLocaleString('ja-JP')} (${Math.round(delay / 60000)}分後)`);

    batchTimer = setTimeout(async () => {
      await runBatch(notifyFn);
      batchTimer = null;
      scheduleNext(); // 次回をスケジュール
    }, delay);
  }

  scheduleNext();
}

// ─────────────────────────────────────────────────────
// バッチを停止する
// ─────────────────────────────────────────────────────
function stopBatch() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
    logger.info('ナイトバッチを停止しました');
  }
}

// ─────────────────────────────────────────────────────
// バッチが起動中かどうか
// ─────────────────────────────────────────────────────
function isBatchRunning() {
  return batchTimer !== null;
}

module.exports = {
  runBatch,
  startBatch,
  stopBatch,
  isBatchRunning,
  runMorningBatch,
  startMorningBatch,
  BATCH_CHANNEL_ID,
  MORNING_BATCH_CHANNEL_ID,
};
