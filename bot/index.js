'use strict';

// =====================================================
// index.js - AI_WORKER Discord Bot メインファイル
//
// Phase4 追加機能:
//   - タスク管理（task-manager.js）
//   - 優先度スコアリング（priority.js）
//   - ナイトバッチ（night-batch.js）
//   - AI会議（ai-meeting.js）
//   - !task / !meeting / !batch コマンド追加
//
// Phase5 追加機能:
//   - タスクキュー（task-queue.js）— 多重依頼を順番に処理
//   - 朝バッチ（morning batch）— タスク優先度の自動再評価
//   - !queue コマンド — キュー状況確認・クリア
//
// コマンド一覧:
//   !claude <指示>          Claude Code に作業依頼
//   !codex <内容>           スマホから直接 Codex にレビュー依頼
//   !approve [taskId]       承認（引数なしで一覧表示）（管理者のみ）
//   !deny <taskId>          却下（管理者のみ）
//   !pause <taskId>         一時停止（管理者のみ）
//   !resume <taskId>        一時停止解除（管理者のみ）
//   !restart                Bot を安全に再起動（管理者のみ）
//   !restart confirm        警告がある場合の強制再起動（管理者のみ）
//   !next                   最優先の実行可能タスクを1件表示
//   !run-next               最優先の未着手タスクを自動実行（Phase2）
//   !queue                  キュー状況を表示
//   !queue clear            待機中タスクをクリア
//   !task list/stats/done/hold/resume  タスク管理
//   !meeting <議題>         AI チーム会議
//   !batch                  ナイトバッチ手動実行
//   !train                  AI予測モデルの手動トレーニング
//   !apply-review <taskId>  Codex回答を Claude にフィードバック
//   !create-pr <taskId>     指定タスクの PR を手動作成
//   !history [taskId]       レビュー履歴を表示
//   !project refine [id]    不足機能分析→タスク案生成→人間確認→一括登録
//   !doctor                 システム診断（管理者のみ）
//   !help                   コマンド一覧
// =====================================================

// ─── 外部ライブラリ ───
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const dotenv = require('dotenv');
const path   = require('path');
const fs     = require('fs');

// ─── Phase1 ユーティリティ ───
const logger       = require('./utils/logger');
const security     = require('./utils/security');
const claudeRunner = require('./utils/claude-runner');
const nextTask            = require('./utils/next-task');
const completionValidator = require('./utils/completion-validator');
const taskTypeUtil        = require('./utils/task-type');

// ─── Phase2 ユーティリティ ───
const github   = require('./utils/github');
const codex    = require('./utils/codex');
const aiReview = require('./utils/ai-review');

// ─── Phase3 ユーティリティ ───
const codexFeedback   = require('./utils/codex-feedback');
const githubPR        = require('./utils/github-pr');
const reviewHistory   = require('./utils/review-history');

// ─── Phase4 ユーティリティ ───
const taskManager = require('./utils/task-manager');
const nightBatch  = require('./utils/night-batch');
const aiMeeting   = require('./utils/ai-meeting');

// ─── Doctor（診断ツール） ───
const doctor = require('./utils/doctor');

// ─── Formatter（文字数制限・AI別フォーマット） ───
const fmt = require('./utils/formatter');

// ─── Phase5 ユーティリティ ───
const taskQueue      = require('./utils/task-queue');
const restartManager = require('./utils/restart-manager');

// ─── AI 予測モデル ───
const aiTrainer    = require('./utils/ai-predictor-trainer');
const aiV2Trainer  = require('./utils/ai-model-v2-trainer');
const aiPredictor  = require('./utils/ai-predictor');

// ─── YouTube 視聴予測 ───
const YouTubeApiClient    = require('./utils/youtube-api-client');
const youtubeCollector    = require('./utils/youtube-data-collector');
const youtubePredictor    = require('./utils/youtube-predictor');
const { GENRE_PRESETS, estimateQuotaForGenre } = require('./utils/youtube-seed-presets');

// ─── Approval（承認管理）───
const approvalManager = require('./utils/approval-manager');

// ─── Project 判定 ───
const projectDetector    = require('./utils/project-detector');
const projectManager     = require('./utils/project-manager');
const autoProjectRunner  = require('./utils/auto-project-runner');
const autoPolicy         = require('./utils/auto-policy');

// ─── Phase E-5b: Worker Role ───
const workerRegistry  = require('./utils/worker-registry');

// ─── !project refine: 保留計画管理 ───
const pendingPlans = require('./utils/pending-plans');

// ─── !project refine: Gap 分析（優先順位付き）───
const refineGapAnalyzer = require('./utils/refine-gap-analyzer');

// ─── タスク状態監視（状態ベース待機）───
const { waitForStateChange } = require('./utils/task-state-watcher');

// ─── Project Insights（Human feedback / Audit / Requirements）───
const projectInsights = require('./utils/project-insights');

// ─── AI Board Report ───
const aiBoardReport = require('./utils/ai-board-report');

// ─── CEO Report ───
const ceoReport = require('./utils/ceo-report');

// ─── CEO Command Layer Phase 2 ───
const ceoCommands = require('./utils/ceo-commands');

// ─── Finance Manager ───
const financeManager = require('./utils/finance-manager');

// ─── Finance Gate ───
const financeGate = require('./utils/finance-gate');

const companyManager  = require('./utils/company-manager');
const qualityGate     = require('./utils/quality-gate');

// ─── Web Dashboard ───
const { startDashboard } = require('./utils/dashboard-server');

// 承認待ちの実行待機Map: taskId → () => void
// ※ Bot 再起動で消える設計（意図的割り切り）
const pendingExecutions = new Map();

// Phase F-0/F-1: !project run の RunContext Map
// key: projectId, value: RunContext（実行中状態を保持）
const activeRuns = new Map();

// ─── Daily Closing 連投防止 ───────────────────────────
// key: `${channelId}:${YYYY-MM-DD}` → 最後に送信した unix ms
// 同日同チャンネルで 30 分以内の重複送信を防ぐ
const _dailyCloseLastSent = new Map();
const DAILY_CLOSE_COOLDOWN_MS = 30 * 60 * 1000; // 30 分

// 自然文トリガー（含む文言）
const DAILY_CLOSE_TRIGGERS = [
  '作業終了', '作業終わり', '今日はここまで',
  '退勤', '終了します', '今日終わり',
];

// ─────────────────────────────────────────────────────
// createRunContext(projectId, message) — Step 1
//
// !project run 開始時に生成するコンテキストオブジェクト。
// activeRuns に格納し、stop / teardown から参照する。
// ─────────────────────────────────────────────────────
function createRunContext(projectId, message) {
  return {
    // 識別情報
    projectId,
    runId:      `run_${Date.now()}`,
    startedAt:  new Date().toISOString(),
    channelId:  message.channelId,
    message,

    // 実行統計
    tasksDone:             0,
    tasksFailed:           0,
    consecutiveErrors:     0,
    yellowCount:           0,
    lastMidRunTasksDone:   0, // MID-RUN 重複発火防止マーカー

    // 状態フラグ
    softRedHandled:    false,

    // 停止制御（Step2: !project stop で設定）
    stopRequested:     false,
    stopReason:        null,

    // 承認待ち（未実装: Step4以降）
    pendingApproval:   null,

    // タイマー（未実装: Step4以降）
    progressTimerId:   null,
    maxRunTimerId:     null,
  };
}

// ─── 環境変数読み込み ───
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── 起動時刻（再起動完了通知の起動時間算出に使う）───
const BOT_START_TIME = Date.now();

// ─────────────────────────────────────────────────────
// 設定値（.env から取得）
// ─────────────────────────────────────────────────────

// Phase1
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || '')
  .split(',').map(id => id.trim()).filter(Boolean);
const DISCORD_OWNER_ID    = process.env.DISCORD_OWNER_ID || '';
// MAX_CONCURRENT は task-queue.js で管理

// Phase2
const ENABLE_GITHUB = process.env.ENABLE_GITHUB === 'true';
const ENABLE_CODEX  = process.env.ENABLE_CODEX  === 'true';
const GITHUB_LOG_CHANNEL_ID   = process.env.GITHUB_LOG_CHANNEL_ID   || '1509548020860194916';
const AI_REVIEW_CHANNEL_ID    = process.env.AI_REVIEW_CHANNEL_ID    || '1509547986911232204';
const CODEX_REVIEW_CHANNEL_ID = process.env.CODEX_REVIEW_CHANNEL_ID || '1509985929648013492';

// Phase3
const ENABLE_PR        = process.env.ENABLE_PR        === 'true';  // PR作成を有効にする
const ENABLE_AUTO_FEEDBACK = process.env.ENABLE_AUTO_FEEDBACK === 'true'; // Codex APIフィードバック自動実行
const PR_CHANNEL_ID    = process.env.PR_CHANNEL_ID    || '1509557395830083634'; // PR通知専用チャンネル
const HISTORY_CHANNEL_ID = process.env.HISTORY_CHANNEL_ID || '1509557457007935530'; // 履歴通知チャンネル

// Phase4
const BATCH_ENABLED       = process.env.BATCH_ENABLED !== 'false'; // バッチ有効（デフォルト: true）
const BATCH_CHANNEL_ID    = process.env.BATCH_CHANNEL_ID    || '';  // バッチ通知チャンネル
const MEETING_CHANNEL_ID  = process.env.MEETING_CHANNEL_ID  || '1509556635817742346'; // 会議結果チャンネル

// Phase6: チャンネル振り分け拡張
const ERROR_CHANNEL_ID    = process.env.ERROR_CHANNEL_ID    || '1509548061884682453'; // エラー通知チャンネル

// YouTube 視聴予測 AI
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// AI Board Report チャンネル（未設定時はコマンドチャンネルにフォールバック）
const AI_BOARD_CHANNEL_ID = process.env.AI_BOARD_CHANNEL_ID || '';
// CEO Report チャンネル（未設定時はコマンドチャンネルにフォールバック）
const CEO_REPORT_CHANNEL_ID = process.env.CEO_REPORT_CHANNEL_ID || '';
// HUMAN_CHECK（承認）通知の集約先（#承認-確認）。設定時は全承認依頼をここへ
const HUMAN_CHECK_CHANNEL_ID = process.env.HUMAN_CHECK_CHANNEL_ID || '';

const NOTIFICATION_CHANNELS = Object.freeze({
  history:     HISTORY_CHANNEL_ID,
  aiReview:    AI_REVIEW_CHANNEL_ID,
  codexReview: CODEX_REVIEW_CHANNEL_ID,
  error:       ERROR_CHANNEL_ID,
  meeting:     MEETING_CHANNEL_ID,
  git:         GITHUB_LOG_CHANNEL_ID,
  pr:          PR_CHANNEL_ID,
  boardReport: AI_BOARD_CHANNEL_ID,
  ceoReport:   CEO_REPORT_CHANNEL_ID,
  humanCheck:  HUMAN_CHECK_CHANNEL_ID,
});

// workspace パス
const WORKSPACE_PATH   = path.join(__dirname, '..', 'workspace');
// AI_WORKER プロジェクトルート（Claude Code の cwd として渡す）
// これにより Claude Code が bot/index.js 等のプロジェクト本体を編集できる
const AI_WORKER_ROOT   = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────
// 起動前チェック
// ─────────────────────────────────────────────────────
if (!DISCORD_TOKEN || DISCORD_TOKEN.includes('ここに')) {
  console.error('\n❌ DISCORD_TOKEN が設定されていません。.env を確認してください。\n');
  process.exit(1);
}
fs.mkdirSync(WORKSPACE_PATH, { recursive: true });

// ─────────────────────────────────────────────────────
// Discord クライアント
// ─────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// (Phase5: 同時実行管理は task-queue.js に移行)

// ─────────────────────────────────────────────────────
// 起動完了
// ─────────────────────────────────────────────────────
client.once('ready', async () => {
  logger.info(`Bot 起動完了: ${client.user.tag}`);
  // プロセス情報はログにのみ記録（Discord には表示しない）
  logger.info(`起動診断 | Node v${process.versions.node} | PID=${process.pid} | argv_count=${process.argv.length}`);

  // ─── ready 内ではロック確認のみ（取得は login 前に完了済み）───
  // acquireStartupLock() は client.login() より前で実行済み。
  // ここに到達した時点でロックは取得されている。
  logger.info(`[LOCK] Discord接続確認 | PID=${process.pid}`);

  const flags = [
    ENABLE_GITHUB ? '✅ GitHub' : '⭕ GitHub',
    ENABLE_CODEX  ? '✅ Codex'  : '⭕ Codex',
    ENABLE_PR     ? '✅ PR自動作成' : '⭕ PR自動作成',
    ENABLE_AUTO_FEEDBACK ? '✅ 自動フィードバック' : '⭕ 自動フィードバック',
    BATCH_ENABLED ? '✅ ナイトバッチ' : '⭕ ナイトバッチ',
    `✅ タスクキュー(max:${taskQueue.maxConcurrent})`,
  ].join(' | ');

  console.log('\n' + '═'.repeat(60));
  console.log(`  ✅ AI_WORKER Bot Phase5 オンライン`);
  console.log(`  Bot: ${client.user.tag}`);
  console.log(`  ${flags}`);
  console.log(`  監視CH: ${ALLOWED_CHANNEL_IDS.join(', ') || '全チャンネル'}`);
  console.log('═'.repeat(60) + '\n');

  startDashboard(logger);

  // ─── 再起動後の完了通知（restart-state.json があれば）───
  const restartState = restartManager.readRestartState();
  if (restartState && restartState.notifyChannelId) {
    try {
      const ch = await client.channels.fetch(restartState.notifyChannelId);
      if (ch) {
        const startupMs = Date.now() - BOT_START_TIME;
        await ch.send(restartManager.buildRestartCompleteMessage(restartState, startupMs));
      }
    } catch (e) {
      logger.error(`再起動完了通知失敗: ${e.message}`);
    }
  }

  // ─── 通知先チャンネル設定を起動時にログ出力 ───
  logNotifyChannelConfig().catch(e => logger.warn(`NOTIFY_CONFIG ログ失敗: ${e.message}`));

  // ─── Phase4: ナイトバッチを自動開始 ───
  const batchNotify = async (channelId, text) => {
    const targetId = channelId || BATCH_CHANNEL_ID;
    if (targetId) {
      try {
        const ch = await client.channels.fetch(targetId);
        if (ch) await ch.send(text);
      } catch (e) {
        logger.error(`バッチ通知送信失敗: ${e.message}`);
      }
    }
  };

  if (BATCH_ENABLED) {
    nightBatch.startBatch(batchNotify);
    // Phase5: 朝バッチも自動開始
    nightBatch.startMorningBatch(batchNotify);
  }
});

// ─────────────────────────────────────────────────────
// ヘルパー: 指定チャンネルへ送信（フォールバック付き）
// ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────
// 通知先チャンネル情報を収集する（起動時ログ・!doctor 共用）
//
// 戻り値: { [type]: { id, name, ok, error } }
// ─────────────────────────────────────────────────────
async function buildNotifyChannelInfo() {
  const info = {};
  for (const [type, channelId] of Object.entries(NOTIFICATION_CHANNELS)) {
    if (!channelId) {
      info[type] = { id: '', name: '未設定', ok: false, error: '未設定' };
      continue;
    }
    try {
      const ch      = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
      const canSend = ch?.permissionsFor(client.user)?.has('SendMessages') ?? false;
      info[type] = {
        id:    channelId,
        name:  ch ? `#${ch.name}` : '?',
        ok:    !!canSend,
        error: canSend ? '' : '送信権限なし',
      };
    } catch (e) {
      info[type] = { id: channelId, name: '?', ok: false, error: e.message?.slice(0, 60) || '取得失敗' };
    }
  }
  return info;
}

// ─────────────────────────────────────────────────────
// 起動時に通知先チャンネル設定をログ出力する
// ─────────────────────────────────────────────────────
async function logNotifyChannelConfig() {
  logger.info('[NOTIFY_CONFIG] 通知先チャンネル設定 ─────────');
  const info = await buildNotifyChannelInfo();

  for (const [type, ch] of Object.entries(info)) {
    if (!ch.id) {
      logger.warn(`[NOTIFY_CONFIG] ${type}: 未設定`);
    } else if (!ch.ok) {
      logger.error(`[NOTIFY_CONFIG] ${type}: ${ch.id} ${ch.name} ❌ ${ch.error}`);
    } else {
      logger.info(`[NOTIFY_CONFIG] ${type}: ${ch.id} ${ch.name} ✅`);
    }
  }

  // AIレビューとCodexレビューが同じIDなら警告
  const ai    = info.aiReview?.id;
  const codex = info.codexReview?.id;
  if (ai && codex && ai === codex) {
    logger.warn(`[NOTIFY_CONFIG] ⚠️ 警告: aiReview と codexReview が同じ channelId (${ai})`);
  }
  logger.info('[NOTIFY_CONFIG] ─────────────────────────────');
}

async function sendToChannel(channelId, fallback, content) {
  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch) { await ch.send(content); return; }
    } catch {
      logger.warn(`専用CH(${channelId})送信失敗。フォールバック。`);
    }
  }
  try { await fallback.send(content); } catch (e) {
    logger.error(`メッセージ送信失敗: ${e.message}`);
  }
}

async function sendNotification(type, fallback, content) {
  const channelId = NOTIFICATION_CHANNELS[type] || '';

  // ─── Secret Guard: Discord 投稿前に秘密情報チェック（フェイルクローズ）───
  // 方針: 秘密情報保護は可用性より優先。guardError 時も元コンテンツは送らない。
  try {
    const { guardDiscordContent } = require('./utils/secret-guardian');
    const guard = guardDiscordContent(content, { type });
    if (!guard.allowed) {
      if (guard.guardError) {
        // スキャン例外 → redactedContent があればそちらを送信、なければ完全ブロック
        logger.warn(`[SecretGuard][NOTIFY] type=${type} スキャンエラー（fail-closed）`);
        if (guard.redactedContent) {
          // マスク済みコンテンツで通常フローへ続行
          content = guard.redactedContent;
          // fall-through: マスク済み content で送信
        } else {
          // redact も失敗 → 完全ブロック
          return;
        }
      } else {
        logger.error(`[SecretGuard][NOTIFY] type=${type} 秘密情報検出 → 投稿差し止め (${guard.violations.length}件)`);
        if (guard.alertText) {
          try { await fallback.send(guard.alertText.slice(0, 1900)); } catch { /* ignore */ }
        }
        return; // 元の content は送信しない
      }
    }
  } catch (guardErr) {
    // ガード自体が予期しない例外 → fail-closed: 送信しない
    logger.error(`[SecretGuard][NOTIFY] type=${type} ガード予期外例外 → fail-closed: ${guardErr.message?.slice(0, 80)}`);
    return;
  }

  // ─── 送信前ログ ───
  const preview = typeof content === 'string'
    ? content.replace(/\n/g, ' ').slice(0, 80)
    : `[Embed]`;
  let chName = channelId;
  try {
    const ch = client.channels.cache.get(channelId);
    if (ch) chName = `#${ch.name}`;
  } catch { /* ignore */ }
  logger.info(`[NOTIFY] type=${type} target=${channelId} ${chName} sending... | "${preview}"`);

  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch) {
        const sent = await ch.send(content);
        logger.info(`[NOTIFY] type=${type} sent messageId=${sent.id} channel=${channelId}`);
        return;
      }
      logger.warn(`[NOTIFY_ERROR] type=${type} channel=${channelId} チャンネルが null → フォールバック`);
    } catch (e) {
      const code = e.code ?? e.status ?? '';
      logger.error(
        `[NOTIFY_ERROR] type=${type} channel=${channelId} ` +
        `code=${code} name=${e.name} message=${e.message?.slice(0, 120)}`
      );
      logger.warn(`[NOTIFY] type=${type} フォールバック送信へ`);
    }
  } else {
    logger.warn(`[NOTIFY] type=${type} channelId 未設定 → フォールバック`);
  }

  // フォールバック（コマンドチャンネルへ）
  try {
    const sent = await fallback.send(content);
    logger.info(`[NOTIFY] type=${type} fallback sent messageId=${sent.id} channel=${fallback.id}`);
  } catch (e) {
    logger.error(`[NOTIFY_ERROR] type=${type} fallback失敗 message=${e.message?.slice(0, 120)}`);
  }
}

// ─────────────────────────────────────────────────────
// ヘルパー: 人間へのメンション（初心者向けフォーマット）
// ─────────────────────────────────────────────────────
async function sendHumanMention(channel, taskId, title, detail, danger = '中', options = {}) {
  if (!DISCORD_OWNER_ID) return;

  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[danger] || '🟡';
  const recommended = options.recommended ?? 'はい';
  // 承認依頼は #承認-確認 に集約する。未設定時のみ従来の channelType を使う
  const targetChannelId = NOTIFICATION_CHANNELS.humanCheck
    || (options.channelType ? NOTIFICATION_CHANNELS[options.channelType] : '');

  // 履歴に記録
  reviewHistory.recordHumanConfirm(taskId, title, danger);

  // Approval に記録（!approve / !deny で制御できるようにする）
  approvalManager.createApproval(taskId, {
    reason:    title,
    danger,
    channelId: targetChannelId || channel.id,
    authorTag: 'system',
    type:      'post',
  });

  // options.customMessage が指定された場合はそちらを使用（CEO フォーマット対応）
  const mentionMessage = options.customMessage
    ? `<@${DISCORD_OWNER_ID}>\n\n${options.customMessage}`
    : (
      `<@${DISCORD_OWNER_ID}>\n\n` +
      `【確認してほしいこと】\n\n${title}\n\n` +
      `【何が起きる？】\n\n${detail}\n\n` +
      (options.merits    ? `【メリット】\n\n${options.merits}\n\n`    : '') +
      (options.demerits  ? `【デメリット】\n\n${options.demerits}\n\n` : '') +
      `【おすすめ】\n\nおすすめ: ${recommended}\n\n` +
      `【危険度】\n\n${dangerEmoji} ${danger}\n\n` +
      `（タスクID: \`${taskId}\`）\n` +
      `✅ 承認: \`!approve ${taskId}\`　❌ 却下: \`!deny ${taskId}\``
    );

  // ─── Secret Guard: 人間通知の投稿前チェック（フェイルクローズ）────────
  try {
    const { guardDiscordContent } = require('./utils/secret-guardian');
    const guard = guardDiscordContent(mentionMessage, { type: 'humanMention' });
    if (!guard.allowed) {
      if (guard.guardError && guard.redactedContent) {
        // スキャンエラー + redact 済み → マスク済みで送信
        mentionMessage = typeof guard.redactedContent === 'string'
          ? guard.redactedContent
          : String(guard.redactedContent);
        // fall-through: マスク済み mentionMessage で送信
      } else {
        logger.error(`[SecretGuard][MENTION] ${guard.guardError ? 'スキャンエラー' : '秘密情報検出'} → 投稿差し止め`);
        if (guard.alertText) {
          try { await channel.send(guard.alertText.slice(0, 1900)); } catch { /* ignore */ }
        }
        return;
      }
    }
  } catch (guardErr) {
    logger.error(`[SecretGuard][MENTION] ガード予期外例外 → fail-closed: ${guardErr.message?.slice(0, 80)}`);
    return;
  }

  try {
    if (NOTIFICATION_CHANNELS.humanCheck) {
      // 承認依頼を #承認-確認 に集約
      await sendNotification('humanCheck', channel, mentionMessage);
    } else if (options.channelType) {
      await sendNotification(options.channelType, channel, mentionMessage);
    } else {
      await channel.send(mentionMessage);
    }
  } catch (e) {
    logger.error(`人間メンション送信失敗: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────
// PR 作成後の人間確認通知
// ─────────────────────────────────────────────────────
async function sendPRHumanConfirm(channel, taskId, prResult, dangerLevel) {
  if (!DISCORD_OWNER_ID) return;

  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[dangerLevel] || '🟡';
  const recommended = dangerLevel === '高' ? '慎重に確認してください' : 'はい（確認後）';

  await sendHumanMention(
    channel, taskId,
    `PR #${prResult.prNumber} をマージしてもいいですか？`,
    `GitHub に新しい変更が Pull Request として作成されました。\n` +
    `PR URL: ${prResult.prUrl}\n` +
    `ブランチ: \`${prResult.featureBranch}\` → \`${prResult.baseBranch}\``,
    dangerLevel,
    {
      merits:   '・AIが作成したコードがリポジトリに追加されます\n・変更内容はPRページで詳しく確認できます',
      demerits: '・マージすると変更が本番ブランチに反映されます\n・テストなしでマージすると問題が起きることがあります',
      recommended,
      channelType: 'pr',
    }
  );
}

// ─────────────────────────────────────────────────────
// !ceo コマンド — CEO Command Layer Phase 2
//
// Phase 1 (調査・設計):
// !ceo [status]               全体状況サマリー
// !ceo investigate [project]  調査レポート
// !ceo design [project]       設計提案
//
// Phase 2 (実装):
// !ceo report [project]       CEO レポート全文
// !ceo approve                承認待ち一覧
// ─────────────────────────────────────────────────────
async function handleCeo(message, args) {
  const sub       = (args[0] || 'status').toLowerCase();
  const projectId = args[1] || null;

  try {
    if (sub === 'status' || sub === '') {
      const text = ceoCommands.buildCeoStatus(taskManager, qualityGate, autoProjectRunner, projectManager);
      await message.reply(text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (sub === 'investigate' || sub === 'inv') {
      const text = ceoCommands.buildCeoInvestigate(projectId, taskManager, qualityGate, autoProjectRunner);
      await message.reply(text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (sub === 'design' || sub === 'des') {
      const text = ceoCommands.buildCeoDesign(projectId, taskManager, projectManager);
      await message.reply(text.slice(0, 1900)).catch(() => {});
      return;
    }

    // ── Phase 2: 実装コマンド ─────────────────────────

    if (sub === 'report' || sub === 'rep') {
      const parts = ceoCommands.buildCeoReport(projectId, taskManager, qualityGate, projectManager);
      for (const part of parts) {
        if (part) await message.channel.send(part).catch(() => {});
      }
      return;
    }

    if (sub === 'approve' || sub === 'app') {
      const text = ceoCommands.buildCeoApproveList(approvalManager);
      await message.reply(text.slice(0, 1900)).catch(() => {});
      return;
    }

    // 未知のサブコマンド
    await message.reply(ceoCommands.buildCeoHelp()).catch(() => {});
  } catch (err) {
    logger.error(`[CEO] エラー: ${err.message}`);
    await message.reply(`⚠️ CEO コマンドでエラーが発生しました: ${err.message}`).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────
// !help コマンド
// ─────────────────────────────────────────────────────
async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🤖 AI_WORKER Bot コマンド一覧')
    .addFields(
      // ── 自律ループ ───────────────────────────────────────
      {
        name: '🚀 !project run <projectId>',
        value: [
          '**自律 AI 開発ループを開始します**',
          'RESEARCH → DOCS → IMPLEMENT → REVIEW → 品質判定 → 自己修復 を自動で繰り返します',
          '`!project stop <projectId>` — 安全停止（人間確認待ち中でも対応）',
          '`!project runner status` — ループ状況・loopCount・softRED 回数を表示',
          '`!project runner on/off` — Auto Runner 有効化/無効化',
          '例: `!project run youtube予測ai`',
        ].join('\n'),
        inline: false,
      },
      // ── 人間確認 ─────────────────────────────────────────
      {
        name: '❓ !approve / !deny — HUMAN_CHECK 対応',
        value: [
          '**AI が判断できない場面（AUTH エラー・危険操作・未解決バグ）で通知が届きます**',
          '`!task show <taskId>` — タスク内容を確認',
          '`!approve <taskId>` — 承認 → ループ再開',
          '`!deny <taskId>` — 却下 → 安全停止',
          '`!approve` — 承認待ち一覧を表示',
          '※ 高危険度の `!claude` 直接実行にも使用します（管理者のみ）',
        ].join('\n'),
        inline: false,
      },
      // ── 品質ゲート ────────────────────────────────────────
      {
        name: '📊 !quality [サブコマンド]',
        value: [
          '`!quality status [projectId]` — 品質状態（GREEN / YELLOW / RED）',
          '`!quality report [projectId]` — 詳細レポート（スコア・RED 要因）',
          '`!quality gate list` — 登録ゲート一覧',
          '`!quality gate add <id> <project> <GREEN|YELLOW> [説明]` — ゲート追加',
          '`!quality gate remove <id>` — ゲート削除',
          '`!quality gate check [project]` — ゲート評価',
        ].join('\n'),
        inline: false,
      },
      // ── プロジェクト管理 ─────────────────────────────────
      {
        name: '📁 !project [サブコマンド] — プロジェクト管理',
        value: [
          '`!project current` — 現在のプロジェクトを表示',
          '`!project list` — プロジェクト一覧',
          '`!project create <名前>` — 新しいプロジェクトを作成',
          '`!project switch <名前>` — プロジェクトを切り替え',
          '`!project plan [id]` — タスク候補を表示',
          '`!project plan apply` — 候補上位3件をタスクに登録',
          '`!project runner auto-apply on/off/status` — 自動タスク登録',
          '🔎 `!project refine [projectId]` — 不足機能を分析してタスク案を生成',
          '✅ `!project refine approve [projectId]` — 提案を一括登録（Owner のみ）',
          '🗑️ `!project refine cancel/show [projectId]` — 提案を破棄・再表示',
        ].join('\n'),
        inline: false,
      },
      // ── タスク管理 ────────────────────────────────────────
      {
        name: '📋 !task [サブコマンド] — タスク管理',
        value: [
          '`!task list` — タスク一覧（優先度順）',
          '`!task show <id>` / `!task <id>` — タスク詳細',
          '`!task add <内容>` — タスク手動追加',
          '`!task done/hold/resume <id>` — 状態変更',
          '`!task stats` — 統計',
          '`!task split [preview] <id>` — 大タスクを分割',
          '`!task archive` / `!task cleanup` — 整理',
        ].join('\n'),
        inline: false,
      },
      // ── Worker / 人員管理 ─────────────────────────────────
      {
        name: '👥 !worker / !company — 人員管理',
        value: [
          '`!worker add <role> [id] [project]` — Worker を登録',
          '`!worker list` / `!worker status` — 一覧・状況確認',
          '`!worker rm <id>` — 削除',
          '役割: IMPLEMENTER / REVIEWER / TESTER / RESEARCHER',
          '`!company staff [projectId]` — 推奨人員を表示',
          '`!company assign [projectId] [--preview]` — 人員を適用',
        ].join('\n'),
        inline: false,
      },
      // ── レビュー・研究 ───────────────────────────────────
      {
        name: '🔍 レビュー・調査系',
        value: [
          '`!codex <内容>` — Codex（GPT-4o）に直接レビューを依頼',
          '`!review list / show <ID>` — Codex レビュー結果を表示',
          '`!research list / show <ID>` — 調査レポートを表示',
          '`!apply-review <taskId>` — Codex フィードバックを Claude Code に適用',
          '`!history [taskId]` — レビュー履歴を表示',
          '`!create-pr <taskId>` — PR を手動作成（ENABLE_PR=true 必須）',
        ].join('\n'),
        inline: false,
      },
      // ── AI 会議・Claude 直接実行 ─────────────────────────
      {
        name: '🧠 !meeting / !claude — 会議・直接実行',
        value: [
          '`!meeting [full] <議題>` — Claude / Codex / ChatGPT の3者討論',
          '`!claude <指示>` — Claude Code に直接作業を依頼（単発実行）',
          '`!pause <taskId>` / `!resume <taskId>` — 一時停止・解除',
        ].join('\n'),
        inline: false,
      },
      // ── YouTube 視聴予測 ──────────────────────────────────
      {
        name: '🎬 !youtube — YouTube 視聴予測 / 投稿前診断 AI',
        value: [
          '`!youtube diagnose title="..." genre=vtuber` — **投稿前6軸診断（API不使用・即時）**',
          '`!youtube predict <URL>` — 投稿済み動画URLのヒット/ミス予測',
          '`!youtube predict title="..." subs=5000` — 投稿前メタデータで予測',
          '`!youtube status` — APIクォータ・モデル状態確認',
          '`!youtube collect <genre> <query>` — シードデータ収集（管理者・API Key必須）',
          '`!youtube train` — 収集データでモデル訓練（管理者）',
          '`!youtube export-model` — 推論専用モデルをエクスポート（管理者）',
        ].join('\n'),
        inline: false,
      },
      // ── CEO コマンド ──────────────────────────────────────
      {
        name: '👑 !ceo — CEO Command Layer Phase 2（調査・設計・実装）',
        value: [
          '`!ceo` / `!ceo status` — 全体状況サマリー（非エンジニア向け）',
          '`!ceo investigate [projectId]` — 調査: 問題・ボトルネック分析',
          '`!ceo design [projectId]` — 設計: 次に実装すべき機能の提案',
          '`!ceo report [projectId]` — CEO レポート全文（判定・ロール評価）',
          '`!ceo approve` — 承認待ちタスク一覧',
        ].join('\n'),
        inline: false,
      },
      // ── システム管理 ─────────────────────────────────────
      {
        name: '⚙️ システム管理（管理者のみ）',
        value: [
          '`!restart [confirm]` — Bot を安全に再起動',
          '`!doctor` — システム診断（設定・Claude・タスク状態確認）',
          '`!queue` / `!queue clear` — タスクキュー確認・クリア',
          '`!batch` — ナイトバッチを手動実行',
          '`!help` — このヘルプを表示',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: 'AI_WORKER | 自律AI開発チーム | !project run で開始' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────
// スマートフロー用ヘルパー: ループ防止カウンタ管理
// ─────────────────────────────────────────────────────
const APPLY_COUNTS_FILE = path.join(AI_WORKER_ROOT, 'data', 'apply-counts.json');
const MAX_AUTO_APPLY = 2;

function getApplyCount(reviewId) {
  if (!fs.existsSync(APPLY_COUNTS_FILE)) return 0;
  try { return JSON.parse(fs.readFileSync(APPLY_COUNTS_FILE, 'utf8'))[reviewId] || 0; }
  catch { return 0; }
}

function incrementApplyCount(reviewId) {
  let data = {};
  if (fs.existsSync(APPLY_COUNTS_FILE)) {
    try { data = JSON.parse(fs.readFileSync(APPLY_COUNTS_FILE, 'utf8')); } catch {}
  }
  data[reviewId] = (data[reviewId] || 0) + 1;
  fs.writeFileSync(APPLY_COUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data[reviewId];
}

// ─────────────────────────────────────────────────────
// スマートフロー用ヘルパー: タスクから executeClaudeTask パラメータを構築
// ─────────────────────────────────────────────────────
function buildExecuteParamsFromTask(task, message, projectId) {
  const prompt         = task.prompt || '';
  const taskType       = task.type   || taskTypeUtil.TASK_TYPES.IMPLEMENT;
  const taskSizeResult = taskTypeUtil.estimateTaskSize(prompt);
  const effectivePid   = task.projectId || projectId || 'default';
  const taskWorkspace  = path.join(WORKSPACE_PATH, effectivePid, task.id);
  return {
    message, prompt, taskId: task.id,
    projectId: effectivePid, taskType, taskSizeResult,
    taskWorkspace, refTaskId: null,
  };
}

// ─────────────────────────────────────────────────────
// !apply-review コマンド
//
// result_<id>.md が存在する場合: スマートフロー（スマホ完結）
//   1. 危険度確認 → 低なら 適用不要
//   2. ループ防止チェック（最大2回）
//   3. FIX タスクを取得 or 生成
//   4. Claude Code で FIX 実行
//   5. REVIEW タスクを自動生成 → Codex 再レビュー
//   6. 結果をスマホ向け短文で通知
//
// result_<id>.md がない場合: 既存の applyFeedback() フローを使用
// ─────────────────────────────────────────────────────
async function handleApplyReview(message, taskId) {
  if (!taskId) {
    await message.reply(
      '**使い方**\n```\n!apply-review <レビューID>\n```\n' +
      'Codex レビュー結果に基づき Claude が自動修正し、再レビューまで実行します。\n' +
      'ID は `!review list` で確認できます。'
    );
    return;
  }

  // ── スマートフロー: reviews/result_<id>.md が存在する場合 ──
  const reviewsPath = path.join(AI_WORKER_ROOT, 'reviews');
  const resultPath  = path.join(reviewsPath, `result_${taskId}.md`);

  if (fs.existsSync(resultPath)) {
    const resultContent = fs.readFileSync(resultPath, 'utf8');
    const dangerMatch   = resultContent.match(/\|\s*危険度\s*\|\s*([^\|]+)\|/);
    const dangerLabel   = dangerMatch ? dangerMatch[1].trim() : '';
    const isLow         = !dangerLabel || dangerLabel.includes('低');

    // 1. 低危険度 → 適用不要
    if (isLow) {
      await message.reply(
        `✅ **適用不要**\n\n` +
        `危険度: ${dangerLabel || '🟢 低'}\n\n` +
        `Codex のレビューで問題は検出されませんでした。修正は不要です。`
      );
      return;
    }

    // 2. ループ防止チェック
    const applyCount = getApplyCount(taskId);
    if (applyCount >= MAX_AUTO_APPLY) {
      await message.reply(
        `🔴 **自動修正の上限到達** (${MAX_AUTO_APPLY}回)\n\n` +
        `\`${taskId}\` は既に ${applyCount} 回自動修正しました。\n` +
        `手動で確認・修正してください。\n` +
        `📄 詳細:\n\`reviews/result_${taskId}.md\``
      );
      return;
    }

    const currentPid  = projectManager.getCurrentProject(message.channelId);
    const runNo       = applyCount + 1;
    const dangerEmoji = { '高': '🔴', '中': '🟡' }[dangerLabel.replace(/[🔴🟡🟢]/g,'').trim()] || dangerLabel.slice(0,2);

    // 3. FIX タスクを取得 or 生成
    const existingFixes = taskManager.findFixTasksFromReview(taskId);
    let fixTask = existingFixes.find(t => t.state === taskManager.STATES.PENDING)
               || existingFixes.find(t => t.state === taskManager.STATES.ON_HOLD);

    if (!fixTask) {
      const fixResult = taskManager.createFixTaskFromReview(resultContent, taskId, message.author.id, currentPid);
      if (!fixResult) {
        await message.reply(`⚠️ FIX タスクの生成に失敗しました。危険度: ${dangerLabel}`);
        return;
      }
      fixTask = fixResult.task;
    }

    // 4. FIX 実行開始通知（スマホ向け短文）
    const startMsg = await message.reply(
      `🔧 **自動修正 ${runNo}/${MAX_AUTO_APPLY} 回目**\n\n` +
      `${dangerEmoji} 危険度: ${dangerLabel}\n` +
      `FIX: \`${fixTask.id}\`\n\n` +
      `⏳ Claude が修正中です...`
    ).catch(() => null);

    // 5. カウント更新 & FIX 実行
    incrementApplyCount(taskId);
    // FIX タスクが保留中なら未着手に戻す
    if (fixTask.state === taskManager.STATES.ON_HOLD) {
      taskManager.updateState(fixTask.id, taskManager.STATES.PENDING, 'apply-review で再開');
    }

    const execParams = buildExecuteParamsFromTask(fixTask, message, currentPid);
    await enqueueAndWait(fixTask.id, () => executeClaudeTask({ ...execParams, source: 'apply-review' }));

    // 6. FIX 完了確認
    const fixedTask   = taskManager.getTask(fixTask.id);
    const fixDone     = !fixedTask; // null = DONE・アーカイブ済み
    const fixStatus   = fixDone ? '✅ 修正完了' : `⚠️ 状態: ${fixedTask?.state}`;

    if (startMsg) await startMsg.edit(`🔧 **自動修正 ${runNo}/${MAX_AUTO_APPLY} 回目 — ${fixStatus}**`).catch(() => {});

    if (!fixDone) {
      await message.channel.send(
        `⚠️ **修正が完了しませんでした**\n\nFIX: \`${fixTask.id}\` | 状態: ${fixedTask?.state}\n手動で確認してください。`
      ).catch(() => {});
      return;
    }

    // 7. REVIEW タスクを自動生成 → Codex 再レビュー
    await message.channel.send(`🔍 **修正完了 → 自動再レビュー開始**`).catch(() => {});

    const reviewTask = taskManager.createTask(
      `[自動再レビュー] ${taskId} の修正後確認 (${runNo}回目)`,
      message.author.id, null, '低', currentPid, 'REVIEW'
    );
    await executeReviewTask({ message, task: reviewTask, projectId: currentPid });

    // 8. 最終通知（スマホ向け短文）
    await message.channel.send(
      `✅ **スマート apply-review 完了**\n\n` +
      `元レビュー: \`${taskId}\`\n` +
      `FIX 実行: \`${fixTask.id}\`\n` +
      `再レビュー: \`${reviewTask.id}\`\n\n` +
      fmt.formatSmartphoneCommand('結果を確認:', `!review show ${reviewTask.id}`)
    ).catch(() => {});
    return;
  }

  // ── 既存フロー: result_<id>.md がない場合 ──
  const processingMsg = await message.reply(
    `⏳ **Codex フィードバックを適用中...**\n` +
    `\`reviews/codex_${taskId}.md\` を確認しています。`
  );

  try {
    const result = await codexFeedback.applyFeedback(taskId);

    if (result.skipped) {
      await processingMsg.edit(
        `⭕ **フィードバックをスキップしました**\n\n${result.reason}`
      );
      return;
    }

    // 履歴に記録
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.FEEDBACK_APPLY,
      taskId,
      result.verdict === '修正推奨' ? '適用済み' : 'スキップ',
      `Codex フィードバック: ${result.verdict}`,
      result.claudeResult?.output?.slice(0, 200)
    );

    if (result.verdict === '却下推奨') {
      // 却下推奨 → 人間確認
      reviewHistory.recordRejection(taskId, result.codexResponse?.slice(0, 100), 'Codex');
      await processingMsg.edit(
        `🔴 **Codex が却下推奨と判定しました**\n\n` +
        `この変更は修正が困難です。人間による確認が必要です。`
      );
      await sendHumanMention(
        message.channel, taskId,
        'Codex レビューが「却下推奨」と判定しました',
        `Codex の判定: 却下推奨\n詳細: reviews/codex_${taskId}.md を確認してください。`,
        '高',
        { channelType: 'codexReview' }
      );
      return;
    }

    // 成功通知
    const verdictColor = { '問題なし': 0x00CC66, '修正推奨': 0xFFAA00 }[result.verdict] || 0x0099FF;
    const successEmbed = new EmbedBuilder()
      .setColor(verdictColor)
      .setTitle(`✅ Codex フィードバック 適用完了`)
      .addFields(
        { name: '📋 タスクID', value: `\`${taskId}\``, inline: true },
        { name: '🔍 Codex 判定', value: result.verdict, inline: true },
        { name: '⚙️ Claude 実行', value: result.claudeResult ? `${result.claudeResult.duration}秒` : 'スキップ', inline: true },
        {
          name: '📝 Codex 回答（抜粋）',
          value: `\`\`\`\n${result.codexResponse?.slice(0, 300)}\n\`\`\``,
          inline: false,
        },
        result.claudeResult ? {
          name: '🔧 Claude 修正内容（抜粋）',
          value: `\`\`\`\n${result.claudeResult.output?.slice(0, 300)}\n\`\`\``,
          inline: false,
        } : { name: '⭕ Claude 修正', value: '問題なしのためスキップ', inline: false },
      )
      .setTimestamp();

    await processingMsg.edit({ content: '', embeds: [successEmbed] });

    // 修正完了後にPR作成を提案
    if (ENABLE_PR && result.claudeResult) {
      await sendNotification('pr', message.channel,
        `💡 修正が完了しました。PR を作成する場合:\n\`\`\`\n!create-pr ${taskId}\n\`\`\``
      );
    }

    logger.info(`フィードバック適用完了 | ${taskId} | ${result.verdict}`);

  } catch (error) {
    const { maskSecret } = require('./utils/github');
    logger.error(`apply-review エラー: ${maskSecret(error.message)}`);
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.ERROR, taskId, 'エラー',
      'apply-review 失敗 (詳細はログ参照)'
    );
    const errorText = `❌ **Codexフィードバックでエラー**\n詳細はログを確認してください`;
    await processingMsg.edit(errorText);
    await sendNotification('error', message.channel, errorText);
  }
}

// ─────────────────────────────────────────────────────
// !worker コマンド — Phase E-5b Worker Role 管理
//
// サブコマンド:
//   add <role> [workerId] [project]  Worker を登録
//   list                              一覧表示
// ─────────────────────────────────────────────────────
// !company staff [projectId]  — 推奨人員を表示
// !company assign [projectId] [--preview] — 人員を実際に調整
// ─────────────────────────────────────────────────────
function _companyResolvePid(args, channelId) {
  // args から --preview フラグを除いたトークンで projectId を探す
  const tokens = args.filter(a => a !== '--preview');
  const rawPid = tokens[0] || '';
  const current = projectManager.getCurrentProject(channelId);
  return rawPid || current || 'default';
}

// ─────────────────────────────────────────────────────
// !project run <projectId> — Phase E-5c
//
// 指定プロジェクトの人員を自動配置し、Auto Runner を起動する。
// handleAutoOn() は fire-and-forget で非同期実行し、
// Discord ハンドラをブロックしない。
//
// 実行順序:
//   1. 二重起動チェック（activeRuns）
//   2. companyManager.getStaffingReport() で現状確認
//   3. companyManager.applyStaffingPlan() で人員配置
//   4. autoProjectRunner.enableRunner() + setAutoApplyPlanning(true)
//   5. 開始メッセージ送信
//   6. handleAutoOn() fire-and-forget
//
// TODO !project stop <project>:
//   activeRuns.delete(projectId) で実行中フラグをクリアし、
//   autoProjectRunner.disableRunner(projectId) を呼んで
//   Runner を安全停止する。
// ─────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────
// gatherRunnerPreview(projectId)
//
// !project run 開始時に表示する「実行前見通し」を集計する。
// Runner 実行ロジック・タスク選定ロジックは変更しない（表示専用）。
//
// 戻り値:
//   {
//     total: number,        残タスク合計
//     autoSafe: number,     AUTO_SAFE（自動実行可）
//     aiReview: number,     AI_REVIEW_REQUIRED（実行可・レビュー付き）
//     needsApproval: number, HUMAN_APPROVAL_REQUIRED
//     blocked: number,      BLOCKED
//     byType: { IMPLEMENT, FIX, RESEARCH, TEST, DOCS, REVIEW, OTHER },
//     hasLarge: boolean,    LARGE タスクがあれば true
//     largeCount: number,
//   }
// ─────────────────────────────────────────────────────
function gatherRunnerPreview(projectId) {
  try {
    const all   = taskManager.listTasks();
    const tasks = projectManager.filterTasksByProject(all, projectId)
      .filter(t =>
        t.state === taskManager.STATES.PENDING ||
        t.state === taskManager.STATES.ON_HOLD  // Auto Resume 候補
      );

    let autoSafe = 0, aiReview = 0, needsApproval = 0, blocked = 0;
    let largeCount = 0;
    const byType = { IMPLEMENT: 0, FIX: 0, RESEARCH: 0, TEST: 0, DOCS: 0, REVIEW: 0, OTHER: 0 };

    for (const t of tasks) {
      // policy 判定（タスク選定ロジックとは独立した集計のみ）
      const policy = autoPolicy.classifyTask(t, { danger: t.dangerLevel || '低' });
      switch (policy) {
        case autoPolicy.AUTO_POLICY.AUTO_SAFE:                autoSafe++;       break;
        case autoPolicy.AUTO_POLICY.AI_REVIEW_REQUIRED:       aiReview++;       break;
        case autoPolicy.AUTO_POLICY.HUMAN_APPROVAL_REQUIRED:  needsApproval++;  break;
        case autoPolicy.AUTO_POLICY.BLOCKED:                  blocked++;        break;
        case autoPolicy.AUTO_POLICY.LARGE_TASK:               break; // largeCount は size チェックで計上
        default:                                              aiReview++;       break;
      }

      // LARGE チェック
      if (t.size === taskManager.TASK_SIZES.LARGE) largeCount++;

      // タイプ別集計
      const typ = String(t.type || '').toUpperCase();
      if (byType[typ] !== undefined) byType[typ]++;
      else byType.OTHER++;
    }

    return {
      total: tasks.length,
      autoSafe,
      aiReview,
      needsApproval,
      blocked,
      byType,
      hasLarge:   largeCount > 0,
      largeCount,
    };
  } catch (e) {
    logger.warn(`[ProjectRun] preview 集計エラー: ${e.message}`);
    return { total: 0, autoSafe: 0, aiReview: 0, needsApproval: 0, blocked: 0,
             byType: {}, hasLarge: false, largeCount: 0 };
  }
}

// ─────────────────────────────────────────────────────
// formatRunnerPreview(preview, projectId) → Discord テキスト
// ─────────────────────────────────────────────────────
function formatRunnerPreview(preview, projectId) {
  if (preview.total === 0) {
    return (
      `📋 **実行前確認** — 実行対象タスクなし\n` +
      `現在 \`${projectId}\` に PENDING / ON_HOLD タスクがありません。\n` +
      `\`!project refine ${projectId}\` で不足機能を分析して新しいタスクを生成してください。\n\n` +
      `> ℹ️ タスク0件 = プロジェクト完成 **ではありません**。AI Board Report で達成度を確認してください。`
    );
  }

  // type 別内訳（0件のものは省略）
  const typeLines = Object.entries(preview.byType)
    .filter(([, c]) => c > 0)
    .map(([t, c]) => {
      const e = { IMPLEMENT: '🔧', FIX: '🛠️', RESEARCH: '🔍', TEST: '🧪',
                  DOCS: '📝', REVIEW: '🔎', OTHER: '📌' }[t] || '📌';
      return `  ${e} ${t}: ${c}件`;
    })
    .join('\n') || '  （タイプ情報なし）';

  // 注意ライン
  const warnings = [];
  if (preview.hasLarge)      warnings.push(`⚠️ LARGE タスク ${preview.largeCount}件 → 自動分割されます`);
  if (preview.blocked > 0)   warnings.push(`🚫 BLOCKED ${preview.blocked}件 → 自動実行スキップ`);
  if (preview.needsApproval > 0) warnings.push(`⚠️ 承認必要 ${preview.needsApproval}件 → Runner が停止・人間確認が必要`);
  const warnText = warnings.length > 0 ? '\n' + warnings.join('\n') : '';

  const runnable = preview.autoSafe + preview.aiReview;

  return (
    `📋 **実行前確認** — \`${projectId}\`\n` +
    `残タスク: **${preview.total}件**` +
    ` | 自動実行可: ${runnable}件` +
    (preview.needsApproval > 0 ? ` | 承認必要: ${preview.needsApproval}件` : '') +
    (preview.blocked > 0       ? ` | スキップ: ${preview.blocked}件`       : '') +
    `\n\n**タイプ別:**\n${typeLines}` +
    warnText +
    `\n\n> ⚠️ 登録タスクが完了しても「商品完成」ではありません。` +
    `完成度は **AI Board Report** / **CEO Report** で判定します。`
  );
}

async function handleProjectRun(message, projectId) {
  if (!projectId) {
    await message.reply(
      '**使い方**\n```\n!project run <projectId>\n```\n' +
      '例: `!project run youtube予測ai`'
    ).catch(() => {});
    return;
  }

  // 二重起動防止（Step1: RunContext の存在チェック）
  if (activeRuns.has(projectId)) {
    const existing = activeRuns.get(projectId);
    await message.reply(
      `⚠️ **\`${projectId}\` は既に実行中です**\n\n` +
      `runId: \`${existing?.runId || '—'}\`\n` +
      `停止: \`!project stop ${projectId}\` | 状態: \`!project runner status\``
    ).catch(() => {});
    return;
  }

  // プロジェクト存在確認
  const project = projectManager.getProject(projectId);
  if (!project) {
    await message.reply(`❌ プロジェクト \`${projectId}\` が見つかりません。`).catch(() => {});
    return;
  }

  // ─── Finance Gate: 予算チェック ──────────────────────────
  try {
    const budgetCheck = financeGate.checkRunnerStart();
    if (!budgetCheck.allowed) {
      await message.reply(
        `💰 **Finance Gate — 実行停止**\n\n` +
        (budgetCheck.message || '予算チェックで停止しました。') + '\n\n' +
        `詳細: \`!finance status\``
      ).catch(() => {});
      return;
    }
    if (budgetCheck.message) {
      // WARNING 等の非停止メッセージ
      await message.channel.send(budgetCheck.message).catch(() => {});
    }
  } catch (fgErr) {
    logger.warn(`[FinanceGate] チェックエラー（続行）: ${fgErr.message}`);
  }

  // ─── H1: PRE-RUN Quality Gate チェック ────────────────
  try {
    const qa = qualityGate.assessQuality(projectId);
    if (qa.level === 'RED') {
      await message.reply(
        `🔴 **Quality Gate: RED — 実行を停止しました**\n\n` +
        `Project: \`${projectId}\`\n\n` +
        qa.redTriggers.map(t => `  ${t}`).join('\n') + '\n\n' +
        `問題を解消してから \`!project run\` を再実行してください。\n` +
        `詳細: \`!quality status ${projectId}\``
      ).catch(() => {});
      return;
    }
    if (qa.level === 'YELLOW') {
      await message.channel.send(
        `🟡 **Quality Gate: YELLOW — 警告して続行**\n\n` +
        `Project: \`${projectId}\`\n` +
        `スコア: ${qa.score}/100\n` +
        (qa.deductions.length > 0 ? qa.deductions.map(d => `  • ${d}`).join('\n') + '\n' : '') +
        `\`!quality status ${projectId}\` で詳細を確認できます。`
      ).catch(() => {});
    }
  } catch (qaErr) {
    // M2: フェイルクローズ — 評価失敗時は安全のため実行を停止する
    logger.error(`[ProjectRun] Quality Gate 評価エラー: ${qaErr.message}`);
    await message.reply(
      `🛑 **品質ゲート評価に失敗したため安全のため停止しました**\n\n` +
      `Project: \`${projectId}\`\n` +
      `エラー: ${qaErr.message.slice(0, 100)}\n\n` +
      `\`!quality status ${projectId}\` で状態を確認するか、管理者に連絡してください。`
    ).catch(() => {});
    return;
  }

  // チャンネルの現在プロジェクトを設定（handleAutoOn が getCurrentProject を使うため）
  const prevPid = projectManager.getCurrentProject(message.channelId);
  projectManager.setCurrentProject(message.channelId, projectId);

  // 人員配置（applyStaffingPlan は部分失敗を warnings に記録するだけでクラッシュしない）
  let staffText = '';
  try {
    const staffResult = companyManager.applyStaffingPlan(projectId, { dryRun: false });
    const added   = staffResult.added.length;
    const removed = staffResult.removed.length;
    if (added > 0 || removed > 0) {
      staffText = `\n👥 人員調整: +${added} / -${removed}人`;
    }
    if (staffResult.warnings.length > 0) {
      logger.warn(`[ProjectRun] staffing warnings: ${staffResult.warnings.join(' | ')}`);
    }
  } catch (staffErr) {
    logger.warn(`[ProjectRun] applyStaffingPlan エラー（無視して続行）: ${staffErr.message}`);
  }

  // Runner 有効化
  autoProjectRunner.enableRunner(projectId);
  autoProjectRunner.setAutoApplyPlanning(projectId, true);

  // Step1: RunContext を生成して activeRuns に登録
  const ctx = createRunContext(projectId, message);
  activeRuns.set(projectId, ctx);
  logger.info(`[ProjectRun] 開始 runId:${ctx.runId} | ${projectId}`);

  // ─── 実行前見通し表示 ────────────────────────────────
  const preview = gatherRunnerPreview(projectId);
  const previewText = formatRunnerPreview(preview, projectId);

  // 予算状況（1行）
  const budgetLine = (() => {
    try {
      const eval_ = financeGate.evaluateBudget();
      return financeGate.formatBudgetLine(eval_);
    } catch { return null; }
  })();

  // 開始メッセージ（見通し + 予算状況）
  await message.reply(
    `🚀 **Project Runner 開始**\n\n` +
    `Project: **${project.name}** (\`${projectId}\`)${staffText}\n\n` +
    previewText + '\n\n' +
    (budgetLine ? budgetLine + '\n\n' : '') +
    `停止: \`!project stop ${projectId}\` | 状態: \`!project runner status\``
  ).catch(() => {});

  // Step4: _runProjectLoop fire-and-forget（Discord ハンドラをブロックしない）
  // handleAutoOn は !auto on 専用のまま維持。
  _runProjectLoop(ctx)
    .catch(err => logger.error(`[ProjectRun] _runProjectLoop エラー: ${err.message}`))
    .finally(() => {
      _teardown(ctx, prevPid);
    });
}

// ─────────────────────────────────────────────────────
// _handleHumanCheck(ctx, task, reason, details) — Phase F-4
//
// AIが安全に自己修復できない場合だけ呼ぶ。
//
// 対象:
//   - AUTH / PERMISSION 系エラー（APIキー・権限不足）
//   - BILLING / QUOTA 系（課金停止・rate limit継続）
//   - AI自己修復2回以上失敗（soft_red_unresolved）
//   - 仕様判断が必要（destructive / 外部送信 等）
//
// 動作:
//   - ctx.pendingApproval = task.id（または task-level ID）
//   - ctx.stopReason = 'awaiting_human'
//   - Discord 通知（理由・次の操作案内）
//   - activeRuns は削除しない（approve で再開可能）
//   - _teardown は呼ばない
//   - ループは break → 呼び出し元が break する
//
// 戻り値: なし（呼び出し元が break すること）
// ─────────────────────────────────────────────────────
async function _handleHumanCheck(ctx, task, reason, details) {
  const { projectId, message } = ctx;
  const taskId = task?.id || '(不明)';

  ctx.pendingApproval = taskId;
  ctx.stopReason      = 'awaiting_human';

  // C-1修正: approval record を作成して !approve / !deny が機能するようにする
  // M-2修正: ensurePending で「必ず PENDING」を保証する。
  //   過去に APPROVED/DENIED 済みの taskId でも再 HUMAN_CHECK を承認可能にする。
  try {
    approvalManager.ensurePending(taskId, {
      type:      'post',
      projectId,
      reason:    reason.slice(0, 200),
      danger:    '中',
      prompt:    (task?.prompt || '').slice(0, 500),
      channelId: message.channelId,
    });
  } catch (approvalErr) {
    logger.warn(`[HumanCheck] approval 作成失敗（続行）: ${approvalErr.message}`);
  }

  logger.warn(`[HumanCheck] 人間確認が必要: ${projectId} | task:${taskId} | reason:${reason}`);

  // Phase D-1: CEO 向けフォーマット（承認/却下/放置の結果を明示）
  const humanCheckText = fmt.formatHumanCheck({
    taskId,
    projectId,
    reason,
    details,
    task,
  });
  await message.channel.send(humanCheckText.slice(0, 1900)).catch(() => {});
}

// ─────────────────────────────────────────────────────
// _isValidationFailureNote(task)
//
// completion-validator 失敗を stateHistory から検出する。
// quality-gate.js の _isValidationFailure と同じロジック。
// 最新の REVIEWING エントリの note に「未完了」が含まれる場合を検出。
//
// 戻り値: 失敗理由の note 文字列 | null（通常のレビュー待ち）
// ─────────────────────────────────────────────────────
function _isValidationFailureNote(task) {
  const hist = (task && task.stateHistory) || [];
  const lastReviewing = [...hist].reverse().find(h =>
    h.state === 'レビュー待ち' || h.state === 'REVIEWING'
  );
  const note = lastReviewing?.note || '';
  return note.includes('未完了') ? note : null;
}

// ─────────────────────────────────────────────────────
// _handleSoftRed(ctx, failedTask, failureNote) — Phase F-3 Step6
//
// completion-validator 失敗（soft RED）時に FIX タスクを自動生成する。
// 生成した FIX タスクは次のループで自動実行される。
//
// 呼び出し条件:
//   - finalTask.state === REVIEWING
//   - 最新 REVIEWING note に「未完了」が含まれる
//   - ctx.softRedHandled === false（初回のみ）
//
// 戻り値: 生成した FIX タスクオブジェクト | null（生成失敗）
// ─────────────────────────────────────────────────────
async function _handleSoftRed(ctx, failedTask, failureNote) {
  const { projectId, message } = ctx;
  const originalId     = failedTask?.id     || '(不明)';
  const originalPrompt = (failedTask?.prompt || '').slice(0, 300);
  const reason         = (failureNote        || '未完了').slice(0, 120);

  const fixPrompt = [
    `[quality-gate auto-FIX] completion-validator 失敗`,
    ``,
    `元タスクID: ${originalId}`,
    `失敗理由: ${reason}`,
    ``,
    `元タスクの指示内容:`,
    originalPrompt,
    ``,
    `対応方針:`,
    `- 変更が0件だった場合は実装が完了していない可能性があります。続きを実装してください。`,
    `- 失敗理由を確認し、最小限の修正で完了させてください。`,
    `- 必ずコード変更を伴う実装を行ってください。`,
    `- 過剰な変更は禁止。必要な箇所だけ修正すること。`,
  ].join('\n');

  let fixTask = null;
  try {
    fixTask = taskManager.createTask(
      fixPrompt,
      'auto-runner',   // requestedBy
      null,            // taskId（自動生成）
      '低',            // dangerLevel（priority は下記で明示上書き）
      projectId,
      'FIX'
    );
    // H-1: dangerLevel から priority への変換は不安定なため、明示的に上書きする
    taskManager.updateTask(fixTask.id, {
      priority:       '高',
      priorityReason: 'soft RED auto-FIX',
    });
    fixTask.priority = '高'; // 戻り値にも反映
    logger.info(`[SoftRed] FIX タスク生成: ${fixTask.id} priority:高 → 元タスク:${originalId} | ${projectId}`);
  } catch (createErr) {
    logger.error(`[SoftRed] FIX タスク生成失敗: ${createErr.message}`);
    await message.channel.send(
      `❌ **soft RED auto-FIX 生成失敗**\n\`${originalId}\` の FIX タスクを生成できませんでした。`
    ).catch(() => {});
    return null;
  }

  await message.channel.send(
    `🔧 **soft RED auto-FIX**\n\n` +
    `元タスク: \`${originalId}\`\n` +
    `失敗理由: ${reason}\n\n` +
    `FIXタスクを生成しました: \`${fixTask.id}\`\n` +
    `次のループで自動実行します。`
  ).catch(() => {});

  return fixTask;
}

// ─────────────────────────────────────────────────────
// _maybeRunMidQualityGate(ctx) — Phase F-2 Step5 修正
//
// MID-RUN Quality Gate 実行ヘルパー。
// 以下の条件を全て満たす場合のみ実行し、重複発火を防ぐ。
//
//   1. ctx.tasksDone > 0
//   2. ctx.tasksDone % MID_RUN_INTERVAL === 0
//   3. ctx.tasksDone !== ctx.lastMidRunTasksDone  ← 重複防止
//
// REVIEW / RESEARCH / IMPLEMENT 完了後に共通で呼ぶ。
// 失敗タスク後は tasksDone が変わらないため条件3が成立せず重複しない。
//
// 戻り値:
//   true  → 呼び出し元は break すること（RED停止）
//   false → 続行可能
// ─────────────────────────────────────────────────────
async function _maybeRunMidQualityGate(ctx) {
  const { projectId, message } = ctx;
  const interval = qualityGate.MID_RUN_INTERVAL || 3;

  if (!(ctx.tasksDone > 0 &&
        ctx.tasksDone % interval === 0 &&
        ctx.tasksDone !== ctx.lastMidRunTasksDone)) {
    return false; // 発火条件を満たさない
  }

  // 発火確定 — マーカーを更新して重複発火を防ぐ
  ctx.lastMidRunTasksDone = ctx.tasksDone;

  try {
    const midQa = qualityGate.assessQuality(projectId);
    logger.info(`[ProjectLoop] MID-RUN QA: ${projectId} | level=${midQa.level} score=${midQa.score} done=${ctx.tasksDone}`);

    if (midQa.level === 'RED') {
      ctx.stopReason = 'midrun_quality_gate_red';
      await message.channel.send(
        `🔴 **MID-RUN Quality Gate: RED — 停止します**\n\n` +
        `Project: \`${projectId}\`\n` +
        midQa.redTriggers.map(t => `  ${t}`).join('\n') + '\n\n' +
        `問題を解消してから \`!project run\` で再開してください。`
      ).catch(() => {});
      return true; // break 指示
    }

    if (midQa.level === 'YELLOW') {
      ctx.yellowCount++;
      await message.channel.send(
        `🟡 **MID-RUN Quality Gate: YELLOW (${ctx.yellowCount}回目)**\n\n` +
        `Project: \`${projectId}\` | スコア: ${midQa.score}/100\n` +
        (midQa.deductions.length > 0
          ? midQa.deductions.map(d => `  • ${d}`).join('\n') + '\n'
          : '') +
        `続行します。\`!quality status ${projectId}\` で詳細を確認できます。`
      ).catch(() => {});
    }
    // GREEN は通知なしで続行
  } catch (midQaErr) {
    logger.warn(`[ProjectLoop] MID-RUN Quality Gate エラー（続行）: ${midQaErr.message}`);
    // フェイルオープン: MID-RUN チェック失敗はループを止めない
  }

  return false; // 続行
}

// ─────────────────────────────────────────────────────
// _runProjectLoop(ctx) — Phase F-1 Step4
//
// !project run 専用の実行ループ。handleAutoOn を使わず独立実装。
//
// ループ先頭で ctx.stopRequested を確認し、
// ユーザーが !project stop を打てば次の区切りで停止する。
//
// 今回未実装（Step5以降）:
//   - MID-RUN Quality Gate
//   - soft RED auto-FIX / hard RED
//   - HUMAN_CHECK / approve / deny resume
//   - progress report / restart recovery
// ─────────────────────────────────────────────────────
const PROJ_RUN_MAX_TASKS         = 200; // 暴走防止の絶対上限
const PROJ_RUN_MAX_CONSEC_ERRORS = 3;   // 連続エラー上限

async function _runProjectLoop(ctx) {
  const { projectId, message } = ctx;

  logger.info(`[ProjectLoop] 開始 runId:${ctx.runId} | ${projectId}`);

  for (let i = 0; i < PROJ_RUN_MAX_TASKS; i++) {
    // ─ 停止チェック（!project stop で即反映）─
    if (ctx.stopRequested) {
      ctx.stopReason = ctx.stopReason || 'stopped_by_user';
      logger.info(`[ProjectLoop] stopRequested: ${projectId} | reason:${ctx.stopReason}`);
      break;
    }

    // ─ 連続エラー上限チェック ─
    if (ctx.consecutiveErrors >= PROJ_RUN_MAX_CONSEC_ERRORS) {
      ctx.stopReason = `consecutive_errors_${ctx.consecutiveErrors}`;
      logger.warn(`[ProjectLoop] 連続エラー ${ctx.consecutiveErrors}回 → 停止: ${projectId}`);
      await message.channel.send(
        `🛑 **連続エラー ${ctx.consecutiveErrors}回のため停止しました**\n` +
        `\`!project run\` で再開できます。`
      ).catch(() => {});
      break;
    }

    // ─ 次タスク準備 ─
    const prepared = await prepareNextTask(message, 'project-run');

    if (!prepared) {
      // PENDING タスクなし → Auto Resume または project_done 判定
      const runnerState = autoProjectRunner.getRunnerState(projectId);
      if (!runnerState.enabled) {
        ctx.stopReason = 'no_pending_tasks';
        break;
      }

      // project_done チェック
      const activeTasks = taskManager.listTasks().filter(t =>
        t.projectId === projectId &&
        (t.state === taskManager.STATES.PENDING || t.state === taskManager.STATES.IN_PROGRESS)
      );
      if (activeTasks.length === 0) {
        // Auto Resume 候補確認
        const resumeCandidates = autoProjectRunner.getResumeCandidates(projectId, { maxCount: 1 });
        if (resumeCandidates.length === 0) {
          ctx.stopReason = 'project_done';
          logger.info(`[ProjectLoop] project_done: ${projectId}`);
          await message.channel.send(
            `🎉 **Project Runner: 全タスク完了**\n\`${projectId}\``
          ).catch(() => {});
          break;
        }
        // Resume 候補あり → PENDING に戻してループ継続
        const toResume = resumeCandidates[0];
        taskManager.updateState(toResume.id, taskManager.STATES.PENDING, 'auto-resume');
        logger.info(`[ProjectLoop] Auto Resume: ${toResume.id} [${toResume.type}] | ${projectId}`);
        await message.channel.send(
          `♻️ **Auto Resume** | \`${projectId}\`\n` +
          `\`${toResume.id}\` [${toResume.type}] を復帰しました。`
        ).catch(() => {});
        continue;
      }

      // IN_PROGRESS タスクが残っている場合は「no_pending_tasks」ではなく
      // 完了を待って次のループへ進む（孤立タスク対策・商品完成との分離）
      const inProgressTasks = activeTasks.filter(
        t => t.state === taskManager.STATES.IN_PROGRESS
      );
      if (inProgressTasks.length > 0) {
        logger.info(`[ProjectLoop] IN_PROGRESS ${inProgressTasks.length}件あり — 完了を待機: ${inProgressTasks.map(t => t.id).join(',')}`);
        await message.channel.send(
          `⏳ **作業中タスクの完了を待っています** | \`${projectId}\`\n` +
          `完了待ち: ${inProgressTasks.map(t => `\`${t.id}\` [${t.type || '?'}]`).join(', ')}`
        ).catch(() => {});
        // 最初の IN_PROGRESS タスクの状態変化を待つ
        const inProg = inProgressTasks[0];
        const watchRes = await waitForStateChange(inProg.id, taskManager, {
          maxWaitMs:      (parseInt(process.env.TASK_TIMEOUT_SECONDS) || 300) * 1000 + 10_000,
          pollIntervalMs: 2000,
          checkStopFn:    () => ctx.stopRequested,
        });
        logger.info(`[ProjectLoop] IN_PROGRESS 完了待ち終了: ${inProg.id} outcome=${watchRes.outcome}`);
        if (watchRes.outcome === 'stopped') {
          ctx.stopReason = 'stopped_by_user';
          break;
        }
        // 状態変化したのでループ先頭へ戻る（次ループで PENDING を再確認）
        continue;
      }

      ctx.stopReason = 'no_pending_tasks';
      break;
    }

    if (prepared.blocked) {
      ctx.stopReason = 'blocked_by_policy';
      break;
    }

    const { task: next, prompt, taskType, taskSizeResult, taskWorkspace } = prepared;
    const storedType = next.type || taskManager.TASK_TYPES.IMPLEMENT;
    const storedSize = next.size || taskManager.TASK_SIZES.MEDIUM;
    const typeEmoji  = taskManager.TYPE_EMOJI[storedType] || '📋';
    const sizeEmoji  = taskManager.SIZE_EMOJI[storedSize] || '🟡';

    // ─ Auto Policy チェック（prepareNextTask と同じ基準）─
    // F-1: dangerLevel を渡して「危険な操作」と「危険単語の言及」を正しく分離する。
    //   AI_REVIEW_REQUIRED → 停止しない（レビュー付きで実行可）
    //   BLOCKED / HUMAN_APPROVAL_REQUIRED → 停止
    //   LARGE_TASK → 大きすぎる（LARGE サイズと同一扱い）
    const prePolicy = autoPolicy.classifyTask(next, { danger: next.dangerLevel || '低' });
    if (prePolicy === autoPolicy.AUTO_POLICY.LARGE_TASK) {
      ctx.stopReason = 'large_task';
      await message.channel.send(
        `🔴 **LARGE タスク** \`${next.id}\` [${storedType}/${storedSize}]\n` +
        `このタスクは大きすぎます。分割してから再実行してください。\n` +
        `\`!task split preview ${next.id}\` / \`!task split ${next.id}\``
      ).catch(() => {});
      break;
    }
    if (prePolicy === autoPolicy.AUTO_POLICY.BLOCKED) {
      ctx.stopReason = `blocked_${storedType}`;
      await message.channel.send(
        `🚫 **BLOCKED** \`${next.id}\` [${storedType}/${storedSize}]\n` +
        `このタスクは自動実行できません（force push / rm -rf 等の危険操作を含む可能性）。\n` +
        `内容を確認してから \`!claude\` で直接実行してください。`
      ).catch(() => {});
      break;
    }
    if (prePolicy === autoPolicy.AUTO_POLICY.HUMAN_APPROVAL_REQUIRED) {
      ctx.stopReason = 'human_approval_required';
      await message.channel.send(
        `⚠️ **人間確認が必要** \`${next.id}\` [${storedType}/${storedSize}]\n` +
        `\`!approve ${next.id}\` → 承認して実行 | \`!deny ${next.id}\` → 却下`
      ).catch(() => {});
      break;
    }
    // AI_REVIEW_REQUIRED → ログのみ（停止しない・レビュー付きで続行）

    // ─ タイプ別振り分け ─
    logger.info(`[ProjectLoop] [${i + 1}] ${next.id} [${storedType}/${storedSize}] policy=${prePolicy}`);
    await message.channel.send(
      `▶ **[${ctx.tasksDone + ctx.tasksFailed + 1}]** \`${next.id}\` [${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}`
    ).catch(() => {});

    try {
      if (storedType === taskManager.TASK_TYPES.REVIEW) {
        await executeReviewTask({ message, task: next, projectId });
        ctx.tasksDone++;
        ctx.consecutiveErrors = 0;
        // REVIEW完了後も MID-RUN チェック（3の倍数到達で発火）
        if (await _maybeRunMidQualityGate(ctx)) break;
        continue;
      }

      if (storedType === taskManager.TASK_TYPES.RESEARCH) {
        await executeResearchTask({ message, task: next, projectId });
        ctx.tasksDone++;
        ctx.consecutiveErrors = 0;
        // RESEARCH完了後も MID-RUN チェック
        if (await _maybeRunMidQualityGate(ctx)) break;
        continue;
      }

      // IMPLEMENT / FIX / REFACTOR / TEST / DOCS 等
      const typeGuard     = taskManager.buildTypeGuard(storedType);
      const guardedPrompt = prompt + typeGuard;

      // ─ 状態ベース監視で実行 ─────────────────────────────
      // executeClaudeTask をバックグラウンド起動し、
      // task.state のポーリングと Promise.race させる。
      // 状態変化を即検出 → 後処理（Discord/GitHub）はバックグラウンドで継続。
      const taskTimeoutMs = (parseInt(process.env.TASK_TIMEOUT_SECONDS) || 300) * 1000 + 10_000;
      const execPromise   = enqueueAndWait(next.id, () => executeClaudeTask({
        message, prompt: guardedPrompt, taskId: next.id, projectId,
        taskType, taskSizeResult, taskWorkspace, refTaskId: null, source: 'project-run',
      }));
      // 状態監視: 1.5 秒ポーリングで IN_PROGRESS 以外への遷移を即検出
      const watchPromise  = waitForStateChange(next.id, taskManager, {
        maxWaitMs:      taskTimeoutMs,
        pollIntervalMs: 1500,
        checkStopFn:    () => ctx.stopRequested,
      });
      // 状態変化が先に来たらそちらを採用（後処理はバックグラウンドで継続）
      const watchResult   = await Promise.race([
        watchPromise,
        execPromise.then(() => {
          // exec 完了後の最新状態を取得
          const t = taskManager.getTask(next.id);
          return { outcome: t ? (t.state !== taskManager.STATES.IN_PROGRESS ? 'changed' : 'in_progress') : 'done', task: t };
        }),
      ]);
      // execPromise が背後で継続している場合も吸収（エラーは無視）
      execPromise.catch(() => {});

      // watchResult から finalTask を取得（exec が先に完了した場合も同様）
      const finalTask = watchResult.task !== undefined
        ? watchResult.task
        : taskManager.getTask(next.id);

      logger.info(`[ProjectLoop] 状態検出: ${next.id} outcome=${watchResult.outcome} state=${finalTask?.state || 'archived'}`);

      if (!finalTask || watchResult.outcome === 'done') {
        // DONE（アーカイブ済み）
        ctx.tasksDone++;
        ctx.consecutiveErrors = 0;
      } else if (finalTask.state === taskManager.STATES.AWAITING) {
        // AWAITING: AIレビュー却下推奨 or PR作成済みなど人間確認が必要
        // Phase F-4: HUMAN_CHECK として一時停止
        await _handleHumanCheck(ctx, finalTask,
          'AIレビュー却下推奨またはPR確認待ち',
          `タスク \`${finalTask.id}\` が人間確認待ち状態です。`
        );
        break;
      } else if (finalTask.state === taskManager.STATES.REVIEWING) {
        // REVIEWING: completion-validator 失敗 か 正常なレビュー待ちかを判定
        const validFailNote = _isValidationFailureNote(finalTask);

        if (validFailNote) {
          // M-1: completion-validator 失敗時のみ failed / consecutiveErrors を増やす
          ctx.tasksFailed++;
          ctx.consecutiveErrors++;

          // ── Phase F-3: soft RED auto-FIX ───────────────────
          if (!ctx.softRedHandled) {
            // 初回: FIX タスクを自動生成して次ループへ
            await _handleSoftRed(ctx, finalTask, validFailNote);
            ctx.softRedHandled = true;
            // continue しないでループ末尾の MID-RUN チェックも通す
          } else {
            // 2回目以降: auto-FIX 後も未解決 → HUMAN_CHECK
            await _handleHumanCheck(ctx, finalTask,
              'soft RED 未解決（auto-FIX 後も completion-validator 失敗）',
              `\`!quality gate\` / \`!task list\` で状況を確認してください。`
            );
            break;
          }
        }
        // M-1: 正常なレビュー待ち（AIレビュー等）は failed 扱いしない
        // tasksDone も増やさない（実行済みだが完了ではない）
      } else if (
        finalTask.state === taskManager.STATES.IN_PROGRESS ||
        // TIMEOUT: executeClaudeTask catch が IN_PROGRESS→ON_HOLD に遷移済み
        (finalTask.errorType === 'TIMEOUT' && finalTask.state === taskManager.STATES.ON_HOLD)
      ) {
        // タイムアウト → Auto Split 試行
        const splitAction = await handleAutoTimeoutSplit({
          message, task: finalTask, contextLabel: 'PROJ-RUN',
        });
        if (splitAction === 'split_ok') {
          ctx.consecutiveErrors = 0;
          continue;
        }
        if (splitAction === 'timeout_limit') {
          ctx.tasksFailed++;
          ctx.consecutiveErrors++;
          ctx.stopReason = 'timeout_limit';
          break;
        }
        ctx.tasksFailed++;
        ctx.consecutiveErrors++;
      } else {
        ctx.tasksFailed++;
        ctx.consecutiveErrors++;
      }
    } catch (taskErr) {
      logger.error(`[ProjectLoop] タスクエラー: ${next.id} | ${taskErr.message}`);
      ctx.tasksFailed++;
      ctx.consecutiveErrors++;

      // Phase F-4: AUTH / PERMISSION エラーは HUMAN_CHECK
      const errType = taskManager.classifyErrorType(taskErr.message);
      if (errType === 'AUTH' || errType === 'PERMISSION') {
        await _handleHumanCheck(ctx, next,
          `${errType} エラー — 認証・権限の確認が必要`,
          taskErr.message.slice(0, 150)
        );
        break;
      }
    }

    // ─ Phase F-2 修正: MID-RUN Quality Gate（共通ヘルパー経由）──
    // tasksDone 変化時のみ発火。失敗タスク後の重複発火はマーカーで防ぐ。
    if (await _maybeRunMidQualityGate(ctx)) break;
  }

  if (!ctx.stopReason) ctx.stopReason = 'max_tasks_reached';
  logger.info(`[ProjectLoop] 終了 ${projectId} | done:${ctx.tasksDone} failed:${ctx.tasksFailed} reason:${ctx.stopReason}`);
}

// ─────────────────────────────────────────────────────
// _teardown(ctx, prevPid) — Step3
//
// !project run の handleAutoOn.finally() から呼ばれる後処理。
//
// 責務:
//   1. タイマー cleanup
//   2. POST-RUN Quality Gate
//   3. 完了メッセージ送信
//   4. activeRuns.delete(projectId)
//   5. チャンネル projectId 復元
//   6. logger 出力
// ─────────────────────────────────────────────────────
async function _teardown(ctx, prevPid) {
  // Phase F-4: awaiting_human の場合は teardown をスキップ
  // activeRuns を削除しない（approve で再開できるようにする）
  if (ctx.stopReason === 'awaiting_human') {
    logger.info(`[Teardown] スキップ（awaiting_human）: ${ctx.projectId}`);
    return;
  }

  const { projectId, message, runId, tasksDone, tasksFailed, stopReason, yellowCount } = ctx;

  // 1. タイマー cleanup
  if (ctx.progressTimerId) { clearInterval(ctx.progressTimerId); ctx.progressTimerId = null; }
  if (ctx.maxRunTimerId)   { clearTimeout(ctx.maxRunTimerId);    ctx.maxRunTimerId   = null; }

  // 2. POST-RUN Quality Gate
  let postQaText = '';
  try {
    const qa   = qualityGate.assessQuality(projectId);
    const icon = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[qa.level] || '❓';
    postQaText = `\n${icon} **POST-RUN Quality: ${qa.level}**` +
      (qa.score !== null ? ` (${qa.score}/100)` : '') +
      (qa.redTriggers.length > 0 ? '\n' + qa.redTriggers.map(t => `  ${t}`).join('\n') : '');
  } catch (e) {
    logger.warn(`[Teardown] POST-RUN Quality Gate エラー: ${e.message}`);
  }

  // 3. 完了メッセージ
  const stopMsg      = stopReason === 'stopped_by_user' ? ' (ユーザーが停止)' : '';
  const yellowNote   = yellowCount > 0 ? ` | 🟡 YELLOW警告: ${yellowCount}回` : '';
  const midRedNote   = stopReason === 'midrun_quality_gate_red' ? '\n⚠️ MID-RUN Quality Gate RED で停止' : '';
  await message.channel.send(
    `🏁 **Project Runner 完了**${stopMsg}\n\n` +
    `Project: \`${projectId}\` | runId: \`${runId}\`\n` +
    `✅ 完了: ${tasksDone}件 | ❌ 失敗: ${tasksFailed}件${yellowNote}${midRedNote}` +
    postQaText
  ).catch(() => {});

  // 3b. AI Board Report（project_done 時または全stopReason で送信）
  try {
    const qaForBoard = (() => {
      try { return qualityGate.assessQuality(projectId); } catch { return { level: 'GREEN', score: null, redTriggers: [] }; }
    })();
    const runStats = { tasksDone, tasksFailed, stopReason: stopReason || '', yellowCount };
    const report   = aiBoardReport.generateBoardReport(
      projectId, runStats, qaForBoard, taskManager, projectManager
    );
    const reportText = aiBoardReport.formatBoardReport(report);
    // AI_BOARD_CHANNEL_ID があればそこへ、なければ実行チャンネルへ
    if (AI_BOARD_CHANNEL_ID) {
      await sendNotification('boardReport', message.channel, reportText.slice(0, 1900)).catch(() => {});
    } else {
      await message.channel.send(reportText.slice(0, 1900)).catch(() => {});
    }
    logger.info(`[BoardReport] 送信完了: ${projectId} | status:${report.status}`);

    // 3c. CEO Report（Board Report と同じ qa/runStats を流用）
    try {
      const ceoRpt = ceoReport.generateCeoReport(
        projectId, runStats, qaForBoard, report.status, taskManager, projectManager
      );
      // Finance Manager: Claude Code コストを月次集計に同期
      try { financeManager.syncClaudeCosts(); } catch { /* ignore */ }

      // 3パートに分けて送信（Part4: Finance セクション追加）
      const parts = [
        ceoReport.formatCeoReportPart1(ceoRpt),
        ceoReport.formatCeoReportPart2(ceoRpt),
        ceoReport.formatCeoReportPart3(ceoRpt),
        financeGate.formatBudgetSection(),       // 💰 Finance Gate 予算セクション
      ];
      // 送信先: CEO_REPORT_CHANNEL_ID → sendNotification, 未設定 → コマンドチャンネル
      const sendPart = async (text) => {
        if (CEO_REPORT_CHANNEL_ID) {
          await sendNotification('ceoReport', message.channel, text.slice(0, 1900)).catch(() => {});
        } else {
          await message.channel.send(text.slice(0, 1900)).catch(() => {});
        }
      };
      for (const part of parts) await sendPart(part);
      logger.info(`[CeoReport] 送信完了: ${projectId} | status:${ceoRpt.execStatus}`);
    } catch (ceoErr) {
      logger.warn(`[CeoReport] 生成エラー（続行）: ${ceoErr.message}`);
    }
  } catch (brErr) {
    logger.warn(`[BoardReport] 生成エラー（続行）: ${brErr.message}`);
  }

  // 4. activeRuns から削除
  activeRuns.delete(projectId);

  // 5. チャンネル projectId 復元
  if (prevPid && prevPid !== projectId) {
    projectManager.setCurrentProject(message.channelId, prevPid);
  }

  // 6. logger
  logger.info(
    `[ProjectRun] teardown: ${projectId} | runId:${runId} ` +
    `done:${tasksDone} failed:${tasksFailed} yellow:${yellowCount} stop:${stopReason || 'none'}`
  );
}

async function handleCompanyStaff(message, args) {
  const pid = _companyResolvePid(args, message.channelId);
  try {
    const report = companyManager.getStaffingReport(pid);
    await message.reply(report.text).catch(() => {});
  } catch (e) {
    logger.warn(`[Company] staff エラー: ${e.message}`);
    await message.reply(`❌ 人員分析に失敗しました: ${e.message.slice(0, 100)}`).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────
// !quality status [projectId]  — Quality Gate の現在状態を表示
// !quality gate list           — 登録ゲート一覧
// !quality gate add <id> <project> <GREEN|YELLOW> [説明]
// !quality gate remove <id>
// !quality report [projectId]  — 詳細レポート
// ─────────────────────────────────────────────────────
async function handleQuality(message, args) {
  const sub        = args[0] || 'status';
  const currentPid = projectManager.getCurrentProject(message.channelId);

  // ── !quality status [projectId] ──────────────────────
  if (sub === 'status') {
    const pid = args[1] || currentPid || 'default';
    const msg = await message.reply(`🔍 **Quality 状態を確認中...**\n\`${pid}\``).catch(() => null);
    try {
      const assessment = qualityGate.assessQuality(pid);
      const text       = qualityGate.formatQualityStatus(assessment);
      if (msg) await msg.edit(text).catch(() => {});
      else await message.channel.send(text).catch(() => {});
    } catch (e) {
      const err = `❌ Quality チェックに失敗しました: ${e.message.slice(0, 100)}`;
      if (msg) await msg.edit(err).catch(() => {});
      else await message.reply(err).catch(() => {});
    }
    return;
  }

  // ── !quality gate ──────────────────────────────────────
  if (sub === 'gate') {
    const gateSub = args[1] || 'list';

    if (gateSub === 'list') {
      await message.reply(qualityGate.formatGateList()).catch(() => {});
      return;
    }

    if (gateSub === 'add') {
      // !quality gate add <id> <project> <GREEN|YELLOW> [説明...]
      const [, , gateId, gatePid, minLevel, ...descParts] = args;
      if (!gateId || !gatePid || !minLevel) {
        await message.reply(
          '**使い方**\n```\n!quality gate add <id> <project> <GREEN|YELLOW> [説明]\n```\n' +
          '例: `!quality gate add ci-check youtube予測ai GREEN 本番前 GREEN 必須`'
        ).catch(() => {});
        return;
      }
      const res = qualityGate.addGate({
        id:          gateId,
        projectId:   gatePid,
        minLevel:    minLevel.toUpperCase(),
        description: descParts.join(' '),
      });
      await message.reply(
        res.ok
          ? `✅ ゲート \`${gateId}\` を追加しました。\nProject: \`${gatePid}\` | 必須レベル: **${minLevel.toUpperCase()}**`
          : `❌ 追加失敗: ${res.reason}`
      ).catch(() => {});
      return;
    }

    if (gateSub === 'remove') {
      const gateId = args[2];
      if (!gateId) {
        await message.reply('使い方: `!quality gate remove <id>`').catch(() => {});
        return;
      }
      const res = qualityGate.removeGate(gateId);
      await message.reply(
        res.ok ? `✅ ゲート \`${gateId}\` を削除しました。` : `❌ ${res.reason}`
      ).catch(() => {});
      return;
    }

    if (gateSub === 'check') {
      const pid = args[2] || currentPid || 'default';
      const res = qualityGate.evaluateGates(pid);
      if (res.noGates) {
        await message.reply(`⬜ \`${pid}\` にゲートが設定されていません。\n\`!quality gate add\` で追加できます。`).catch(() => {});
        return;
      }
      const icon  = res.passed ? '✅ PASSED' : '❌ FAILED';
      const lines = [`🚦 **Gate 評価: ${icon}** | \`${pid}\``];
      res.results.forEach(r => {
        const ri = r.ok ? '✅' : '❌';
        lines.push(`  ${ri} \`${r.gate.id}\` 必須:${r.gate.minLevel} → 現在:**${r.level}** (${r.score ?? 'n/a'}点)`);
      });
      await message.reply(lines.join('\n')).catch(() => {});
      return;
    }

    await message.reply(
      '**!quality gate の使い方**\n```\n' +
      '!quality gate list                           → ゲート一覧\n' +
      '!quality gate add <id> <project> <level>     → ゲート追加\n' +
      '!quality gate remove <id>                    → ゲート削除\n' +
      '!quality gate check [project]                → ゲート評価\n' +
      '```'
    ).catch(() => {});
    return;
  }

  // ── !quality report [projectId] ───────────────────────
  if (sub === 'report') {
    const pid = args[1] || currentPid || 'default';
    const msg = await message.reply(`📋 **Quality レポート生成中...**\n\`${pid}\``).catch(() => null);
    try {
      const report = qualityGate.generateReport(pid);
      // 長い場合は 1900 文字で切り詰め
      const text   = report.text.slice(0, 1900);
      if (msg) await msg.edit(text).catch(() => {});
      else await message.channel.send(text).catch(() => {});
    } catch (e) {
      const err = `❌ レポート生成に失敗しました: ${e.message.slice(0, 100)}`;
      if (msg) await msg.edit(err).catch(() => {});
      else await message.reply(err).catch(() => {});
    }
    return;
  }

  // ── ヘルプ ─────────────────────────────────────────────
  await message.reply(
    '**!quality の使い方**\n```\n' +
    '!quality status [project]   → Quality 現在状態\n' +
    '!quality gate list          → ゲート一覧\n' +
    '!quality gate add/remove    → ゲート管理\n' +
    '!quality gate check         → ゲート評価\n' +
    '!quality report [project]   → 詳細レポート\n' +
    '```'
  ).catch(() => {});
}

async function handleCompanyAssign(message, args) {
  const dryRun = args.includes('--preview');
  const pid    = _companyResolvePid(args, message.channelId);

  const processingText = dryRun
    ? `🔍 **人員変更プレビュー中...**\nProject: \`${pid}\``
    : `⚙️ **人員を調整中...**\nProject: \`${pid}\``;
  const processing = await message.reply(processingText).catch(() => null);

  try {
    const result = companyManager.applyStaffingPlan(pid, { dryRun });
    const text   = companyManager.formatAssignResult(result);
    if (processing) await processing.edit(text).catch(() => {});
    else await message.channel.send(text).catch(() => {});
  } catch (e) {
    logger.warn(`[Company] assign エラー: ${e.message}`);
    const errText = `❌ 人員調整に失敗しました: ${e.message.slice(0, 100)}`;
    if (processing) await processing.edit(errText).catch(() => {});
    else await message.reply(errText).catch(() => {});
  }
}

//   rm <workerId>                     Worker を削除
//   status                            ワンライナー状況
// ─────────────────────────────────────────────────────
async function handleWorker(message, content) {
  const parts = content.trim().split(/\s+/);
  const sub   = parts[1] || 'list';

  // ── !worker list ─────────────────────────────────
  if (sub === 'list' || sub === 'ls') {
    await message.reply(workerRegistry.formatWorkerList());
    return;
  }

  // ── !worker status ───────────────────────────────
  if (sub === 'status') {
    await message.reply(workerRegistry.formatWorkerStatus());
    return;
  }

  // ── !worker add <role> [workerId] [project] ──────
  if (sub === 'add') {
    const role      = parts[2] || '';
    const workerId  = parts[3] || null;
    const projectId = parts[4] || '*';

    if (!role) {
      await message.reply(
        '**使い方**\n```\n!worker add <role> [workerId] [project]\n```\n' +
        '**role**\n```\nIMPLEMENTER  → IMPLEMENT / FIX / REFACTOR\n' +
        'REVIEWER     → REVIEW\nTESTER       → TEST\nRESEARCHER   → RESEARCH / DOCS\n```\n' +
        '**例**\n```\n!worker add IMPLEMENTER\n!worker add REVIEWER rev-1 ai-worker\n```'
      );
      return;
    }

    const result = workerRegistry.addWorker(role, workerId, projectId);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }

    const { worker } = result;
    const roleEmoji  = workerRegistry.ROLE_EMOJI[worker.role] || '🤖';
    const types      = [...(workerRegistry.ROLE_TYPE_MAP[worker.role] || [])].join(' / ');
    await message.reply(
      `✅ **Worker 登録完了**\n\n` +
      `${roleEmoji} \`${worker.workerId}\`  ${worker.role}\n` +
      `担当タイプ: \`${types}\`\n` +
      `プロジェクト: \`${worker.projectId}\`\n\n` +
      `\`!worker list\` で一覧を確認できます。`
    );
    return;
  }

  // ── !worker rm <workerId> ────────────────────────
  if (sub === 'rm' || sub === 'remove' || sub === 'del') {
    const workerId = parts[2] || '';
    if (!workerId) {
      await message.reply('**使い方**\n```\n!worker rm <workerId>\n```');
      return;
    }

    const result = workerRegistry.removeWorker(workerId);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }

    const warn = result.wasBusy
      ? '\n⚠️ **このWorkerは実行中でした。** タスクの lease が残っている場合は `!task cleanup` で解消してください。'
      : '';
    await message.reply(`🗑️ \`${workerId}\` を削除しました。${warn}`);
    return;
  }

  // ── 不明なサブコマンド ───────────────────────────
  await message.reply(
    '**!worker サブコマンド一覧**\n```\n' +
    '!worker add <role> [id] [project]  Worker を登録\n' +
    '!worker list                        一覧表示\n' +
    '!worker rm <id>                     Worker を削除\n' +
    '!worker status                      ワンライナー状況\n```'
  );
}

// ─────────────────────────────────────────────────────
// !create-pr コマンド
// ─────────────────────────────────────────────────────
async function handleCreatePR(message, taskId) {
  if (!taskId) {
    await message.reply(
      '**使い方**\n```\n!create-pr <タスクID>\n```\n' +
      '**例**\n```\n!create-pr task_1748344800000\n```'
    );
    return;
  }

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    await message.reply(
      '❌ PR 作成には以下の .env 設定が必要です:\n' +
      '```\nGITHUB_TOKEN=ghp_xxxxxxxxxx\nGITHUB_REPO=username/repo\n```'
    );
    return;
  }

  const processingMsg = await message.reply(
    `⏳ **PR を作成中...**\n` +
    `タスク \`${taskId}\` のフィーチャーブランチを準備しています。`
  );

  try {
    // プロンプトを取得
    const promptFile = path.join(WORKSPACE_PATH, taskId, 'prompt.md');
    const prompt = fs.existsSync(promptFile)
      ? fs.readFileSync(promptFile, 'utf8').replace(/^#.*\n|^-.*\n/gm, '').trim()
      : `タスク ${taskId} の変更`;

    // PRワークフロー実行
    const prResult = await githubPR.createPRWorkflow(prompt, taskId, null, null);

    if (prResult.skipped) {
      await processingMsg.edit(`⭕ PR 作成をスキップ\n理由: ${prResult.reason}`);
      return;
    }

    // 履歴に記録
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.PR_CREATED, taskId, 'PR作成',
      `PR #${prResult.prNumber}: ${prResult.prTitle}`,
      `PR URL: ${prResult.prUrl}`
    );

    // 成功Embed
    const prEmbed = new EmbedBuilder()
      .setColor(0x6F42C1)
      .setTitle(`🔗 PR #${prResult.prNumber} が作成されました`)
      .setURL(prResult.prUrl)
      .addFields(
        { name: 'タイトル',   value: prResult.prTitle, inline: false },
        { name: 'ブランチ',   value: `\`${prResult.featureBranch}\` → \`${prResult.baseBranch}\``, inline: false },
        { name: 'PR URL',    value: prResult.prUrl, inline: false },
        { name: '⚠️ 重要',   value: '**PR の自動マージは行いません。**\n内容を確認してから手動でマージしてください。', inline: false },
      )
      .setTimestamp();

    await processingMsg.edit({ content: '', embeds: [prEmbed] });

    // PR チャンネルへも送信
    await sendNotification('pr', message.channel, { embeds: [prEmbed] });

    // 人間確認
    await sendPRHumanConfirm(message.channel, taskId, prResult, '低');

    logger.info(`PR 作成完了 | #${prResult.prNumber} | ${prResult.prUrl}`);

  } catch (error) {
    const { maskSecret } = require('./utils/github');
    const maskedMsg = maskSecret(error.message);
    logger.error(`create-pr エラー: ${maskedMsg}`);
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.ERROR, taskId, 'エラー',
      'create-pr 失敗 (詳細はログ参照)'
    );

    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF3333)
      .setTitle('❌ PR 作成に失敗しました')
      .setDescription('詳細はログを確認してください')
      .setTimestamp();

    await processingMsg.edit({ content: '', embeds: [errorEmbed] });
    await sendNotification('error', message.channel, { embeds: [errorEmbed] });
  }
}

// ─────────────────────────────────────────────────────
// !history コマンド
// ─────────────────────────────────────────────────────
async function handleHistory(message, taskId) {
  if (taskId) {
    // タスク別の詳細履歴
    const history = reviewHistory.getTaskHistory(taskId);
    if (!history) {
      await message.reply(`\`${taskId}\` の履歴が見つかりません。`);
      return;
    }
    // 長い場合は分割
    const preview = history.slice(0, 1800);
    await message.reply(`**${taskId} の履歴**\n\`\`\`markdown\n${preview}\n\`\`\`${history.length > 1800 ? '\n（省略）' : ''}`);
  } else {
    // 最新10件の全体履歴
    const lines = reviewHistory.getRecentHistory(10);
    if (lines.length === 0) {
      await message.reply('履歴がまだありません。');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📜 最新レビュー履歴（10件）')
      .setDescription('```\n' + lines.join('\n') + '\n```')
      .setFooter({ text: 'reviews/history.md に全履歴が保存されています' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  }
}

// ─────────────────────────────────────────────────────
// !task コマンド（Phase4）
// ─────────────────────────────────────────────────────
async function handleTask(message, args) {
  const sub       = args[0] || 'list';
  const taskId    = args[1] || '';
  const projectId = projectDetector.detectProjectId(message.channel);

  // !task stats
  if (sub === 'stats') {
    const stats = taskManager.getStats();
    const lines = Object.entries(stats.counts)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `${taskManager.STATE_EMOJI[state] || '❓'} ${state}: ${count}件`);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 タスク統計')
      .setDescription(`現在Project: **${projectId}**\n\n` + (lines.join('\n') || 'タスクはありません'))
      .addFields(
        { name: '合計',         value: `${stats.total}件`,         inline: true },
        { name: '高優先度',     value: `${stats.highPriority}件`,  inline: true },
        { name: '人間確認待ち', value: `${stats.awaiting}件`,      inline: true },
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  // !task list — 現在プロジェクトのタスクのみ表示
  if (sub === 'list' || args.length === 0) {
    const currentPid  = projectManager.getCurrentProject(message.channelId);
    const currentProj = projectManager.getProject(currentPid);
    const allTasks    = taskManager.listTasksByPriority();
    const filtered    = projectManager.filterTasksByProject(allTasks, currentPid);
    const projLabel   = currentProj ? `${currentProj.name} (${currentPid})` : currentPid;
    await message.reply(
      `現在Project: **${projLabel}**\n\n` +
      taskManager.formatTaskList(filtered, 'タスク一覧（優先度順）') +
      (filtered.length < allTasks.length
        ? `\n\n_他 ${allTasks.length - filtered.length} 件は別プロジェクトのタスクです。_`
        : '')
    );
    return;
  }

  // !task done <id>
  if (sub === 'done' && taskId) {
    const task = taskManager.updateState(taskId, taskManager.STATES.DONE, '手動完了');
    if (!task) {
      await message.reply(`\`${taskId}\` が見つかりません。`);
      return;
    }
    await message.reply(`✅ タスク \`${taskId}\` を **完了** にしました。`);
    return;
  }

  // !task hold <id>
  if (sub === 'hold' && taskId) {
    const task = taskManager.updateState(taskId, taskManager.STATES.ON_HOLD, '手動保留');
    if (!task) {
      await message.reply(`\`${taskId}\` が見つかりません。`);
      return;
    }
    await message.reply(`⏸️ タスク \`${taskId}\` を **保留** にしました。`);
    return;
  }

  // !task resume <id>
  if (sub === 'resume' && taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) {
      await message.reply(`❌ \`${taskId}\` が見つかりません。`);
      return;
    }
    if (task.state !== taskManager.STATES.ON_HOLD) {
      await message.reply(`❌ \`${taskId}\` は保留状態ではありません。\n現在の状態: **${task.state}**`);
      return;
    }
    taskManager.updateState(taskId, taskManager.STATES.PENDING, '手動再開');
    await message.reply(
      `✅ タスクを再開しました\n\n` +
      `Task:\n\`${taskId}\`\n\n` +
      `State:\n保留 → 未着手\n\n` +
      `次に \`!next\` で確認できます。`
    );
    return;
  }

  // ─────────────────────────────────────────────────────
  // !task run <id> — 指定IDのタスクを直接実行（優先キューをバイパス）
  //
  // 対象状態: PENDING / ON_HOLD
  // 安全ゲート: セキュリティ / BLOCKED / HUMAN_APPROVAL_REQUIRED / LARGE
  // 実行フロー: 通常の executeClaudeTask / executeReviewTask / executeResearchTask を使用
  // `!auto run 1` / `!auto on` の挙動は変更しない
  // ─────────────────────────────────────────────────────
  if (sub === 'run' && args[1]) {
    const runTaskId = args[1];
    const runTask   = taskManager.getTask(runTaskId);

    if (!runTask) {
      await message.reply(
        `❌ \`${runTaskId}\` が見つかりません。\n\`!task list\` で確認してください。`
      );
      return;
    }

    // ── 対象状態チェック ──
    const validRunStates = [taskManager.STATES.PENDING, taskManager.STATES.ON_HOLD];
    if (!validRunStates.includes(runTask.state)) {
      await message.reply(
        `❌ \`${runTaskId}\` は実行できません。\n\n` +
        `現在の状態: **${runTask.state}**\n\n` +
        `実行可能な状態: ${taskManager.STATES.PENDING} / ${taskManager.STATES.ON_HOLD}`
      );
      return;
    }

    // ── セキュリティチェック ──
    const runSec = security.checkPrompt(runTask.prompt || '');
    if (!runSec.safe) {
      await message.reply(
        `🚫 **セキュリティチェックで拒否**\n\n` +
        `タスク: \`${runTaskId}\`\n理由: ${runSec.reason}`
      );
      return;
    }

    // ── Auto Policy チェック（BLOCKED / HUMAN_APPROVAL_REQUIRED は停止）──
    const runPolicy = autoPolicy.classifyTask(runTask, { danger: runTask.dangerLevel || '低' });
    if (runPolicy === autoPolicy.AUTO_POLICY.BLOCKED ||
        runPolicy === autoPolicy.AUTO_POLICY.HUMAN_APPROVAL_REQUIRED) {
      const policyLabel = runPolicy === autoPolicy.AUTO_POLICY.BLOCKED
        ? '🚫 BLOCKED'
        : '⚠️ 人間確認が必要 (HUMAN_APPROVAL_REQUIRED)';
      await message.reply(
        `${policyLabel}\n\n` +
        `タスク: \`${runTaskId}\`\n\n` +
        `このタスクは自動実行できません。\`!claude\` から直接実行し、承認フロー（\`!approve\`）を経てください。`
      );
      return;
    }

    // ── LARGE サイズチェック ──
    const runSizeResult = taskTypeUtil.estimateTaskSize(runTask.prompt || '');
    if (runSizeResult.size === taskTypeUtil.TASK_SIZES.LARGE) {
      const splitMsg = taskTypeUtil.buildSplitSuggestion(runTask.prompt || '', runSizeResult);
      await message.reply(
        `⚠️ **タスクが大きすぎます**\n\nタスク: \`${runTaskId}\`\n\n` + splitMsg
      );
      return;
    }

    // ── ON_HOLD → PENDING に一時解除してからクレーム ──
    const wasOnHold = runTask.state === taskManager.STATES.ON_HOLD;
    if (wasOnHold) {
      taskManager.updateState(runTaskId, taskManager.STATES.PENDING, 'task run 一時解除');
    }

    // 特定IDのみを対象にクレーム（原子的 PENDING → IN_PROGRESS）
    const claimedRunTask = taskManager.claimNextTaskByFilter(
      t => t.id === runTaskId, 'run-task-cmd'
    );
    if (!claimedRunTask) {
      // クレームに失敗した場合は元の状態に戻す
      if (wasOnHold) {
        taskManager.updateState(runTaskId, taskManager.STATES.ON_HOLD, 'task run claim 失敗・復元');
      }
      await message.reply(
        `❌ \`${runTaskId}\` のクレームに失敗しました。\n` +
        `他のワーカーが実行中か、リース期間内の可能性があります。`
      );
      return;
    }

    // ── 実行パラメータ構築 ──
    const runProjectId  = claimedRunTask.projectId
      || projectDetector.detectProjectId(message.channel)
      || projectManager.getCurrentProject(message.channelId)
      || 'default';
    const runStoredType = claimedRunTask.type || taskManager.TASK_TYPES.IMPLEMENT;
    const runTypeEmoji  = taskManager.TYPE_EMOJI[runStoredType] || '📋';
    const runSizeEmoji  = taskManager.SIZE_EMOJI[claimedRunTask.size || taskManager.TASK_SIZES.MEDIUM] || '🟡';
    const runPrompt     = claimedRunTask.prompt || '';

    await message.reply(
      `▶️ **!task run: 指定タスク実行開始**\n\n` +
      `タスク: \`${runTaskId}\`\n` +
      `[${runStoredType}] ${runTypeEmoji}${runSizeEmoji}\n` +
      `指示: ${runPrompt.slice(0, 80)}${runPrompt.length > 80 ? '...' : ''}\n\n` +
      `completionValidator・AIレビュー・Codex を通常通り実行します。`
    ).catch(() => {});

    // ── REVIEW タスクは Codex へ転送 ──
    if (runStoredType === taskManager.TASK_TYPES.REVIEW) {
      const runReviewFn = async () =>
        executeReviewTask({ message, task: claimedRunTask, projectId: runProjectId });
      const runReviewQueuePos = taskQueue.enqueue(runTaskId, runReviewFn);
      if (runReviewQueuePos > 0) {
        await message.reply(
          `📋 **キューに追加しました（待機 ${runReviewQueuePos} 番目）**\n` +
          `\`${runTaskId}\` は ${taskQueue.activeCount} 件の処理完了後に自動実行されます。`
        ).catch(() => {});
      }
      return;
    }

    // ── RESEARCH タスクは調査専用モードで実行 ──
    if (runStoredType === taskManager.TASK_TYPES.RESEARCH) {
      const runResearchFn = async () =>
        executeResearchTask({ message, task: claimedRunTask, projectId: runProjectId });
      const runResearchQueuePos = taskQueue.enqueue(runTaskId, runResearchFn);
      if (runResearchQueuePos > 0) {
        await message.reply(
          `📋 **キューに追加しました（待機 ${runResearchQueuePos} 番目）**\n` +
          `\`${runTaskId}\` は ${taskQueue.activeCount} 件の処理完了後に自動実行されます。`
        ).catch(() => {});
      }
      return;
    }

    // ── その他（IMPLEMENT / FIX / REFACTOR / TEST / DOCS 等）──
    const runExecParams = buildExecuteParamsFromTask(claimedRunTask, message, runProjectId);
    const runClaudeFn   = async () => executeClaudeTask({ ...runExecParams, source: 'run-task-cmd' });
    const runClaudeQueuePos = taskQueue.enqueue(runTaskId, runClaudeFn);
    if (runClaudeQueuePos > 0) {
      await message.reply(
        `📋 **キューに追加しました（待機 ${runClaudeQueuePos} 番目）**\n` +
        `\`${runTaskId}\` は ${taskQueue.activeCount} 件の処理完了後に自動実行されます。\n` +
        `\`!queue\` でキュー状況を確認できます。`
      ).catch(() => {});
    }
    return;
  }

  // !task merge <id1> <id2> — 2つのタスクを1つに統合
  if (sub === 'merge') {
    const mergeId1 = args[1] || '';
    const mergeId2 = args[2] || '';
    if (!mergeId1 || !mergeId2) {
      await message.reply(
        '**使い方**\n```\n!task merge <タスクID1> <タスクID2>\n```\n' +
        '2つのタスクを1つに統合します。元タスクはアーカイブされます。'
      );
      return;
    }
    const result = taskManager.mergeTasks(mergeId1, mergeId2);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }
    const { mergedTask, typeMerged } = result;
    const typeEmoji = taskManager.TYPE_EMOJI[mergedTask.type] || '📋';
    const sizeEmoji = taskManager.SIZE_EMOJI[mergedTask.size] || '🟡';
    const lines = [
      `🔗 **タスク統合完了**`,
      ``,
      `統合元: \`${mergeId1}\` + \`${mergeId2}\` → アーカイブ済み`,
      ``,
      `**統合後タスク:**`,
      `ID: \`${mergedTask.id}\``,
      `[${mergedTask.type}/${mergedTask.size}] ${typeEmoji}${sizeEmoji}`,
      `内容: ${mergedTask.prompt.slice(0, 100)}${mergedTask.prompt.length > 100 ? '...' : ''}`,
    ];
    if (typeMerged) {
      lines.push(``, `⚠️ 2件の type が異なるため **IMPLEMENT** に統一しました。`);
    }
    lines.push('', '`!task list` で確認できます。');
    await message.reply(lines.join('\n'));
    return;
  }

  // !task split <id> / !task split preview <id>
  if (sub === 'split') {
    // ─── !task split preview <id> — 登録せず分割案だけ確認 ───
    if (taskId === 'preview') {
      const previewId = args[2] || '';
      if (!previewId) {
        await message.reply(
          '**使い方**\n```\n!task split preview <タスクID>\n```\n' +
          '分割案をプレビュー表示します。タスク登録・元タスクのアーカイブはしません。'
        );
        return;
      }
      const targetTask = taskManager.getTask(previewId);
      if (!targetTask) {
        await message.reply(`❌ \`${previewId}\` が見つかりません。`);
        return;
      }
      const proposals      = taskManager.generateSplitProposals(targetTask.prompt);
      const inheritedType  = targetTask.type || taskManager.TASK_TYPES.IMPLEMENT;
      const typeEmoji      = taskManager.TYPE_EMOJI[inheritedType] || '📋';
      const origSizeLabel  = targetTask.size || taskManager.TASK_SIZES.MEDIUM;
      const origSizeEmoji  = taskManager.SIZE_EMOJI[origSizeLabel] || '🟡';

      const lines = [
        `🔍 **タスク分割プレビュー**`,
        ``,
        `元タスク: \`${previewId}\``,
        `タイプ: ${typeEmoji} **${inheritedType}**  サイズ: ${origSizeEmoji} **${origSizeLabel}**`,
        ``,
        `**分割案 (${proposals.length}件) — まだ登録されていません:**`,
      ];
      proposals.forEach((p, i) => {
        const estSize    = taskManager.estimateTaskSize(p);
        const sizeEmoji2 = taskManager.SIZE_EMOJI[estSize] || '🟡';
        lines.push(
          `${i + 1}. ${typeEmoji}${sizeEmoji2} [${inheritedType}/${estSize}]`,
          `   ${p.slice(0, 70)}${p.length > 70 ? '...' : ''}`
        );
      });
      lines.push('', `登録するには: \`!task split ${previewId}\``);
      await message.reply(lines.join('\n'));
      return;
    }

    // ─── !task split <id> — 実際に分割登録 ───
    if (!taskId) {
      await message.reply(
        '**使い方**\n```\n!task split <タスクID>\n!task split preview <タスクID>\n```\n' +
        'LARGEタスクを3〜5個の小さいタスクに分割します。\n' +
        'preview を付けると登録せず分割案だけ確認できます。'
      );
      return;
    }
    const result = taskManager.splitTask(taskId);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }
    const lines = [
      `✂️ **タスク分割完了**`,
      ``,
      `元タスク: \`${taskId}\` → アーカイブ済み`,
      ``,
      `**新タスク (${result.newTasks.length}件):**`,
    ];
    result.newTasks.forEach((t, i) => {
      const sizeEmoji = taskManager.SIZE_EMOJI[t.size] || '🟡';
      const typeEmoji = taskManager.TYPE_EMOJI[t.type] || '📋';
      lines.push(
        `${i + 1}. ${typeEmoji}${sizeEmoji} \`${t.id}\``,
        `   [${t.type}/${t.size}] ${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '...' : ''}`
      );
    });
    lines.push('', '`!task list` で確認できます。');
    await message.reply(lines.join('\n'));
    return;
  }

  // !task archive — 30日超過の保留・レビュー待ちを data/archive_tasks.json へ移動
  if (sub === 'archive') {
    const result = taskManager.archiveStaleTasks(30);
    const lines = [
      '📦 **アーカイブ完了**',
      '',
      `保留: **${result.onHold}件**`,
      `レビュー待ち: **${result.reviewing}件**`,
      `合計: **${result.total}件**`,
    ];
    if (result.total === 0) {
      lines.push('\n対象タスクはありませんでした（30日未満 or 該当状態なし）。');
    } else {
      lines.push('\n移動先: `data/archive_tasks.json`');
    }
    await message.reply(lines.join('\n'));
    return;
  }

  // !task add [TYPE] <content> — タスクを手動登録
  // 書式: !task add IMPLEMENT 内容  → type=IMPLEMENT
  //       !task add 内容            → type=IMPLEMENT (デフォルト)
  if (sub === 'add') {
    const rest = args.slice(1); // args[0]='add' を除いた残り
    if (rest.length === 0) {
      await message.reply(
        '**使い方**\n```\n!task add <内容>\n!task add IMPLEMENT <内容>\n!task add FIX <内容>\n```\n' +
        `利用可能タイプ: ${Object.keys(taskManager.TASK_TYPES).join(' / ')}`
      );
      return;
    }

    // 先頭が有効な TYPE かどうかを判定
    const maybeType = taskManager.normalizeTaskType(rest[0]);
    let taskType, promptParts;
    if (maybeType && rest.length > 1) {
      taskType    = maybeType;
      promptParts = rest.slice(1);
    } else {
      taskType    = taskManager.TASK_TYPES.IMPLEMENT;
      promptParts = rest;
    }

    const prompt = promptParts.join(' ').trim();
    if (!prompt) {
      await message.reply('依頼内容が空です。内容を入力してください。');
      return;
    }

    // !task add: 現在の project を優先して使用
    const addProjectId = projectManager.getCurrentProject(message.channelId);
    const newTask = taskManager.createTask(
      prompt,
      message.author.id,
      null,         // taskId 自動生成
      '低',         // dangerLevel
      addProjectId, // 現在プロジェクト
      taskType
    );

    const typeEmoji = taskManager.TYPE_EMOJI[newTask.type] || '📋';
    const sizeEmoji = taskManager.SIZE_EMOJI[newTask.size] || '🟡';
    const sizeWarn  = newTask.size === taskManager.TASK_SIZES.LARGE
      ? '\n\n⚠️ **このタスクは大きすぎる可能性があります。**\n分割をおすすめします。'
      : '';

    await message.reply(
      `✅ **タスクを登録しました**\n\n` +
      `ID: \`${newTask.id}\`\n` +
      `タイプ: ${typeEmoji} **${newTask.type}**\n` +
      `サイズ: ${sizeEmoji} **${newTask.size}**\n` +
      `内容: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}` +
      sizeWarn
    );
    return;
  }

  // !task edit <id> type <TYPE> — タスクの type を変更
  if (sub === 'edit') {
    const editId    = args[1] || '';
    const editField = args[2] || '';
    const editValue = args[3] || '';

    if (!editId || editField !== 'type' || !editValue) {
      await message.reply(
        '**使い方**\n```\n!task edit <タスクID> type <TYPE>\n```\n' +
        `利用可能タイプ: ${Object.keys(taskManager.TASK_TYPES).join(' / ')}`
      );
      return;
    }

    const result = taskManager.updateTaskType(editId, editValue);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }
    const typeEmoji = taskManager.TYPE_EMOJI[result.task.type] || '📋';
    await message.reply(
      `✅ **タスクタイプを変更しました**\n\n` +
      `ID: \`${editId}\`\n` +
      `タイプ: ${typeEmoji} **${result.task.type}**`
    );
    return;
  }

  // !task cleanup — 孤立タスク整理（24時間超過の作業中・レビュー待ち → 保留）
  if (sub === 'cleanup') {
    const result = taskManager.cleanupStaleTasks(24);
    const lines = [
      '🧹 **タスク整理完了**',
      '',
      `作業中 → 保留: **${result.inProgress}件**`,
      `レビュー待ち → 保留: **${result.reviewing}件**`,
      `合計: **${result.total}件**`,
    ];
    if (result.total === 0) {
      lines.push('\n対象タスクはありませんでした（24時間未満 or 該当状態なし）。');
    }
    await message.reply(lines.join('\n'));
    return;
  }

  // !task <id> — task_ プレフィックスは常にID扱い（サブコマンド扱いしない）
  if (sub.startsWith('task_')) {
    const task = taskManager.getTask(sub);
    if (task) {
      const currentPid = projectManager.getCurrentProject(message.channelId);
      if (!projectManager.taskBelongsToProject(task, currentPid)) {
        const taskPid = task.projectId || projectManager.DEFAULT_PROJECT_ID;
        await message.reply(
          `⚠️ **現在プロジェクト外のタスクです**\n\n` +
          `タスクのプロジェクト: \`${taskPid}\`\n` +
          `現在のプロジェクト: \`${currentPid}\`\n\n` +
          `プロジェクトを切り替えてから再度確認してください:\n` +
          `\`\`\`\n!project switch ${taskPid}\n!task ${sub}\n\`\`\``
        );
        return;
      }
      await message.reply(taskManager.formatTaskDetail(task));
      return;
    }
    // タスクが存在しない場合は usage ではなく明示的なエラーを返す
    await message.reply(
      `❌ **タスクが見つかりません**\n\n` +
      `**タスクID**\n\`\`\`\n${sub}\n\`\`\`\n` +
      `タスク一覧を確認するには:\n\`\`\`\n!task list\n\`\`\``
    );
    return;
  }

  await message.reply(
    '**使い方**\n```\n!task list\n!task <タスクID>\n!task add <内容>\n!task add IMPLEMENT|FIX|REFACTOR|RESEARCH|DOCS|TEST|REVIEW <内容>\n!task edit <ID> type <TYPE>\n!task split preview <タスクID>\n!task split <タスクID>\n!task merge <タスクID1> <タスクID2>\n!task done <タスクID>\n!task hold <タスクID>\n!task resume <タスクID>\n!task stats\n!task cleanup\n!task archive\n```'
  );
}

// ─────────────────────────────────────────────────────
// !meeting コマンド（Phase4）
// ─────────────────────────────────────────────────────
async function handleMeeting(message, rawTopic) {
  if (!rawTopic) {
    await message.reply(
      '**使い方**\n```\n!meeting <議題>        （短縮モード: 結論のみ）\n!meeting full <議題>  （詳細モード: 3者討論）\n```\n**例**\n```\n!meeting 次にどの機能を優先して作るべきか\n```'
    );
    return;
  }

  const projectId = projectDetector.detectProjectId(message.channel);

  // full モード判定
  const isFull = rawTopic.toLowerCase().startsWith('full ');
  const topic  = isFull ? rawTopic.slice(5).trim() : rawTopic;
  const shortMode = !isFull;

  const processingMsg = await message.reply(
    `🤝 **AI 会議 [${shortMode ? '短縮' : '詳細'}モード]**\n` +
    `**Project:** ${projectId}\n` +
    `**議題:** ${topic.slice(0, 100)}\n` +
    `結論を生成中です...`
  );

  try {
    const result = await aiMeeting.conductMeeting(topic, '', shortMode, projectId);

    await processingMsg.edit(result.summary);

    // 会議結果を専用チャンネルへも送信
    await sendNotification('meeting', message.channel, result.summary);

    // 人間確認が必要な場合
    if (result.needsHuman && DISCORD_OWNER_ID) {
      await sendHumanMention(
        message.channel,
        `meeting_${Date.now()}`,
        `AI 会議の結果、人間の判断が必要です`,
        `議題: ${topic}\n\n理由: ${result.needsHumanReason}`,
        '中',
        { recommended: '確認してから指示してください', channelType: 'meeting' }
      );
    }

    logger.info(`AI 会議完了 | 議題: ${topic.slice(0, 50)}`);

  } catch (error) {
    logger.error(`!meeting エラー: ${error.message}`);
    const errorText = `❌ **会議の実行に失敗しました**\n\n${_classifyDiscordError(error.message)}`;
    await processingMsg.edit(errorText);
    await sendNotification('error', message.channel, errorText);
  }
}

// ─────────────────────────────────────────────────────
// !research list / show <id> — 調査レポートの一覧・詳細表示
//
// ─────────────────────────────────────────────────────
// !project refine — 不足機能分析 → タスク案生成 → 人間確認 → 一括登録
//
// サブコマンド:
//   !project refine [projectId]          — 分析・提案生成（登録なし）
//   !project refine approve [projectId]  — Owner のみ一括登録
//   !project refine cancel [projectId]   — pending 破棄
//   !project refine show [projectId]     — 提案再表示
//
// 安全条件:
//   - approve は DISCORD_OWNER_ID のみ
//   - status: pending → consumed（二重 approve 防止）
//   - 最大 20件（超過分は「次回候補」表示）
//   - auto-refine/auto-approve 禁止（コマンド起点のみ）
//   - 各 prompt に security.checkPrompt() を適用
// ─────────────────────────────────────────────────────
async function handleProjectRefine(message, args) {
  // args: ['refine', subSub?, projectId?]
  const subSub   = args[1] || '';          // approve / cancel / show / '' (生成)
  const pidArg   = args[2] || '';
  const pid      = pidArg || projectManager.getCurrentProject(message.channelId) || 'default';
  const project  = projectManager.getProject(pid);

  if (!project) {
    await message.reply(
      `❌ プロジェクトが見つかりません: \`${pid}\`\n` +
      `\`!project list\` で確認してください。`
    ).catch(() => {});
    return;
  }

  // ── !project refine approve ───────────────────────
  if (subSub === 'approve') {
    // ① Owner のみ
    if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
      await message.reply('🚫 **!project refine approve は Owner のみ実行できます。**').catch(() => {});
      return;
    }

    const plan = pendingPlans.getLatestPlan(pid);
    if (!plan) {
      await message.reply(
        `⚠️ **${pid}** に pending な refine 計画がありません。\n` +
        `先に \`!project refine ${pid}\` を実行してください。`
      ).catch(() => {});
      return;
    }

    // ② consumed チェック（二重 approve 防止）
    if (plan.status === pendingPlans.PLAN_STATUS.CONSUMED) {
      await message.reply(
        `⚠️ この計画は既に登録済みです (consumed)。\n` +
        `新しい提案を作成するには \`!project refine ${pid}\` を再実行してください。`
      ).catch(() => {});
      return;
    }

    const processingMsg = await message.reply(`⏳ **Refine Approve 中...**\n${plan.tasks.length}件を登録します。`).catch(() => null);

    const registered = [];
    const skipped    = [];

    for (const t of plan.tasks) {
      // 重複チェック（同一 prompt の未完了タスクがあればスキップ）
      const existing = taskManager.listTasks().find(
        x => x.projectId === pid &&
             x.prompt === t.prompt &&
             x.state !== taskManager.STATES.DONE
      );
      if (existing) {
        skipped.push({ prompt: t.prompt, reason: '重複' });
        continue;
      }
      const created = taskManager.createTask(
        t.prompt,
        message.author.id,
        null,
        t.dangerLevel || '低',
        pid,
        t.type || 'IMPLEMENT'
      );
      registered.push(created);
    }

    // ③ consumed に遷移（二重登録防止）
    pendingPlans.consumePlan(plan.id);

    const lines = registered.map((t, i) =>
      `${i + 1}. \`${t.id}\` [${t.type}] ${(t.prompt || '').slice(0, 50)}`
    ).join('\n') || '（なし）';

    const skipLines = skipped.length > 0
      ? `\n⏭️ スキップ（重複）: ${skipped.length}件`
      : '';

    const reply =
      `✅ **Refine Approve 完了** — Project: \`${pid}\`\n\n` +
      `登録: **${registered.length}件**${skipLines}\n\n` +
      lines.slice(0, 1400) +
      `\n\n実行: \`!project run ${pid}\``;

    if (processingMsg) await processingMsg.edit(reply.slice(0, 1900)).catch(() => {});
    else await message.reply(reply.slice(0, 1900)).catch(() => {});
    logger.info(`[Refine] approve: ${pid} | ${registered.length}件登録 planId:${plan.id}`);
    return;
  }

  // ── !project refine cancel ───────────────────────
  if (subSub === 'cancel') {
    const count = pendingPlans.discardByProject(pid);
    await message.reply(
      count > 0
        ? `🗑️ **Refine 計画を破棄しました** — \`${pid}\` (${count}件)`
        : `⚠️ \`${pid}\` に pending な計画はありません。`
    ).catch(() => {});
    return;
  }

  // ── !project refine show ─────────────────────────
  if (subSub === 'show') {
    const plan = pendingPlans.getLatestPlan(pid);
    if (!plan) {
      await message.reply(
        `⚠️ **${pid}** に pending な refine 計画がありません。\n` +
        `\`!project refine ${pid}\` で新しい提案を生成してください。`
      ).catch(() => {});
      return;
    }
    await message.reply(_formatRefinePlan(plan, pid)).catch(() => {});
    return;
  }

  // ── !project refine（生成）────────────────────────
  const processingMsg = await message.reply(
    `⏳ **Refine 分析中...**\n` +
    `Project: \`${pid}\`\n不足機能を分析しています…`
  ).catch(() => null);

  try {
    // 完了済みタスクを収集
    const allTasks    = taskManager.listTasks();
    const projTasks   = projectManager.filterTasksByProject(allTasks, pid);
    const doneSums    = [];

    projTasks
      .filter(t => t.state === taskManager.STATES.ON_HOLD)
      .forEach(t => doneSums.push(`${t.type}: ${(t.prompt || '').slice(0, 40)}`));

    const histDir = path.join(AI_WORKER_ROOT, 'data', 'history');
    try {
      if (fs.existsSync(histDir)) {
        fs.readdirSync(histDir).filter(f => f.endsWith('.json')).slice(-3).forEach(hf => {
          try {
            const hist = JSON.parse(fs.readFileSync(path.join(histDir, hf), 'utf8'));
            (hist.tasks || [])
              .filter(t => (t.projectId || 'default') === pid)
              .forEach(t => doneSums.push(`${t.type}: ${(t.prompt || '').slice(0, 40)}`));
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }

    // ─ Gap 分析（優先順位付き）+ Planner 結果を合流 ──
    // Phase 改善: 一般的な次ステップではなく PM/Product 監査視点で優先順位付け
    const qaForRefine = (() => {
      try { return qualityGate.assessQuality(pid); }
      catch { return { level: 'GREEN', score: null, redTriggers: [], indicators: {} }; }
    })();
    const indForRefine = (() => {
      try { return qualityGate.gatherIndicators(pid); }
      catch { return {}; }
    })();
    const boardStatusForRefine = (() => {
      try {
        const runStats = { tasksDone: indForRefine.doneCount || 0, tasksFailed: indForRefine.failedCount || 0, stopReason: '' };
        const rpt = aiBoardReport.generateBoardReport(pid, runStats, qaForRefine, taskManager, projectManager);
        return rpt.status;
      } catch { return 'NEEDS_REFINEMENT'; }
    })();
    const reviewsDirForRefine = path.join(AI_WORKER_ROOT, 'reviews');
    // Insights（Human feedback / Product/PM Audit / Requirements）を取得して最優先で反映
    const insightsForRefine = projectInsights.getInsights(pid);
    if (insightsForRefine.length > 0) {
      logger.info(`[Refine] Insights 参照: ${pid} | ${insightsForRefine.length}件（${insightsForRefine.map(i => i.type).join(',')}）`);
    }

    const gapResult = refineGapAnalyzer.analyzeGaps({
      projectId:      pid,
      project,
      boardStatus:    boardStatusForRefine,
      indicators:     indForRefine,
      qualityLevel:   qaForRefine.level,
      taskManager,
      projectManager,
      reviewsDir:     reviewsDirForRefine,
      insights:       insightsForRefine,
    });
    logger.info(`[Refine] Gap分析: ${pid} | P1:${gapResult.gaps.filter(g=>g.category==='P1').length} P2:${gapResult.gaps.filter(g=>g.category==='P2').length} P3:${gapResult.gaps.filter(g=>g.category==='P3').length} insight:${gapResult.insightGaps?.length||0} sources:${gapResult.sources.join(',')}`);

    // Planner の nextCandidates を P3〜P5 として後ろに追加（gap analyzer が優先）
    const planner = require('./utils/project-planner.js');
    const plannerResult = await planner.planProjectGoalsBest(pid, {
      description: (project.description || project.name || '') + (project.goal || ''),
      doneTasks:   doneSums,
    });
    const plannerExtras = (plannerResult.nextCandidates || []).slice(0, 15).map(c => ({
      type:          c.type || 'IMPLEMENT',
      prompt:        (c.title || c.prompt || '').slice(0, 500),
      priority:      c.priority || '中',
      dangerLevel:   '低',
      category:      'P5',  // planner 候補は最低優先度として追加
      categoryRank:  6,
      categoryLabel: '一般候補',
      reason:        c.reason || '不足機能候補',
      source:        'planner',
      fromLarge:     false,
    }));

    // Gap + Planner をマージ（gap 優先、重複除去）
    const merged = [...gapResult.gaps];
    const existingPrompts = new Set(merged.map(g => g.prompt.slice(0, 40)));
    for (const extra of plannerExtras) {
      if (!extra.prompt) continue;
      const key = extra.prompt.slice(0, 40);
      if (!existingPrompts.has(key)) {
        merged.push(extra);
        existingPrompts.add(key);
      }
    }

    // LARGE タスクを分割
    const rawProposals = [];
    for (const item of merged) {
      const prompt  = item.prompt || '';
      const estSize = taskTypeUtil.estimateTaskSize(prompt);
      if (estSize.size === taskTypeUtil.TASK_SIZES.LARGE) {
        const splits = taskManager.generateSplitProposals(prompt);
        for (const sp of splits) {
          rawProposals.push({ ...item, prompt: sp.slice(0, 500),
            size: taskTypeUtil.estimateTaskSize(sp).size, fromLarge: true,
            reason: `${item.reason} (LARGE分割)` });
        }
      } else {
        rawProposals.push({ ...item, size: estSize.size });
      }
    }

    // security.checkPrompt フィルタ
    const safeProposals = [];
    for (const p of rawProposals) {
      if (!p.prompt) continue;
      const sec = security.checkPrompt(p.prompt);
      if (!sec.safe) {
        logger.warn(`[Refine] セキュリティブロック: ${p.prompt.slice(0, 40)} | ${sec.reason}`);
        continue;
      }
      safeProposals.push({ ...p, securityOk: true });
    }

    // 20件 / overflow に分割（優先順位順なので先頭が高優先）
    const MAX = pendingPlans.MAX_TASKS;
    const tasks    = safeProposals.slice(0, MAX);
    const overflow = safeProposals.slice(MAX);

    if (tasks.length === 0) {
      if (processingMsg) await processingMsg.edit(
        `📊 **Refine 分析完了** — Project: \`${pid}\`\n\n` +
        `現時点では不足タスク候補が見つかりませんでした。\n` +
        `Board Status: **${boardStatusForRefine}** | Quality: **${qaForRefine.level}**\n\n` +
        `プロジェクトの説明・目標を更新するか、直接 \`!task add\` でタスクを追加してください。`
      ).catch(() => {});
      return;
    }

    // pending-plans.json に保存
    const saved = pendingPlans.createPlan(pid, message.author.id, tasks, overflow);

    // Discord に表示
    const replyPayload = _formatRefinePlan(saved, pid);
    if (processingMsg) await processingMsg.edit(replyPayload).catch(() => {});
    else await message.reply(replyPayload).catch(() => {});
    logger.info(`[Refine] 生成: ${pid} | ${tasks.length}件 overflow:${overflow.length}件 planId:${saved.id}`);

  } catch (err) {
    logger.error(`[Refine] エラー: ${err.message}`);
    if (processingMsg) await processingMsg.edit(
      `❌ **Refine 分析中にエラーが発生しました**\n\n${_classifyDiscordError(err.message)}`
    ).catch(() => {});
  }
}

/** refine 計画を Discord Embed にフォーマット（優先カテゴリ付き） */
function _formatRefinePlan(plan, pid) {
  const TYPE_EMOJI = { IMPLEMENT: '🔧', RESEARCH: '🔍', TEST: '🧪', DOCS: '📝', REVIEW: '🔎', FIX: '🛠️' };
  const CAT_EMOJI  = { P1: '🔴', P2: '🟠', P3: '🟡', P4: '🔵', P5: '⬜', undefined: '📌' };

  // カテゴリ別にグループ化して表示
  const byCategory = {};
  for (const t of plan.tasks) {
    const cat = t.category || 'P5';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  }

  const taskLines = plan.tasks.map((t, i) => {
    const typeEmoji = TYPE_EMOJI[t.type] || '📌';
    const catEmoji  = CAT_EMOJI[t.category] || '📌';
    const catLabel  = t.categoryLabel ? `[${t.categoryLabel}]` : '';
    const prompt    = (t.prompt || '').slice(0, 48);
    const suffix    = t.fromLarge ? ' *(分割)*' : '';
    const reason    = t.reason ? `\n   └ ${t.reason.slice(0, 45)}` : '';
    return `${i + 1}. ${catEmoji}${typeEmoji} ${catLabel} ${prompt}${suffix}${reason}`;
  }).join('\n');

  // 優先度サマリー
  const p1Count = (byCategory['P1'] || []).length;
  const p2Count = (byCategory['P2'] || []).length;
  const prioritySummary = [
    p1Count > 0 ? `🔴 コア価値未達:${p1Count}件` : '',
    p2Count > 0 ? `🟠 致命的不具合:${p2Count}件` : '',
  ].filter(Boolean).join(' | ');

  const embed = new EmbedBuilder()
    .setColor(p1Count > 0 || p2Count > 0 ? 0xFF6600 : 0x5865F2)
    .setTitle(`📋 Refine 提案 — ${pid}`)
    .setDescription(
      `Plan ID: \`${plan.id}\`\n` +
      `ステータス: **${plan.status}** | 有効期限: ${new Date(plan.expiresAt).toLocaleString('ja-JP')}\n` +
      (prioritySummary ? `\n**優先度:** ${prioritySummary}` : '')
    )
    .addFields({
      name: `不足タスク候補 (${plan.tasks.length}件) — 上が優先度高`,
      value: fmt.embedField(taskLines || '（なし）'),
      inline: false,
    });

  if (plan.overflow && plan.overflow.length > 0) {
    embed.addFields({
      name: '⏭️ 次回 refine 候補',
      value: `${plan.overflow.length}件（20件上限のため今回除外）`,
      inline: false,
    });
  }

  embed.addFields({
    name: '操作',
    value: `✅ 登録: \`!project refine approve ${pid}\`\n🗑️ 破棄: \`!project refine cancel ${pid}\``,
    inline: false,
  });

  return { embeds: [embed] };
}

// ─────────────────────────────────────────────────────
// !project コマンド — プロジェクト管理
//
// list    — プロジェクト一覧を表示
// create  — 新しいプロジェクトを作成
// switch  — 現在のプロジェクトを切り替え
// current — 現在選択中のプロジェクトを表示
// ─────────────────────────────────────────────────────
async function handleProject(message, args) {
  const sub  = args[0] || 'current';
  const name = args.slice(1).join(' ').trim();

  // ─── !project refine — 不足機能分析 → タスク案生成 ───────────
  if (sub === 'refine') {
    await handleProjectRefine(message, args);
    return;
  }

  // ─── !project insight — Human feedback / Audit / Requirements 管理 ───
  if (sub === 'insight') {
    const insightSub = args[1] || 'list';
    const insightPid = args[2] || projectManager.getCurrentProject(message.channelId) || 'default';

    // !project insight list [pid]
    if (insightSub === 'list') {
      const list = projectInsights.getInsights(insightPid);
      if (list.length === 0) {
        await message.reply(
          `📋 \`${insightPid}\` に登録済み Insight はありません。\n` +
          `\`!project insight add ${insightPid} <type> <text>\` で追加できます。\n` +
          `type: feedback / product / pm / req`
        ).catch(() => {});
        return;
      }
      const lines = list.map((ins, i) =>
        `${i + 1}. [${ins.type}/${ins.severity}] ${ins.text.slice(0, 60)}\n   ID: \`${ins.id}\` | ${ins.addedAt.slice(0, 10)}`
      ).join('\n');
      await message.reply(
        `📋 **Project Insights** — \`${insightPid}\`\n\n${lines.slice(0, 1700)}\n\n` +
        `\`!project refine ${insightPid}\` でこれらを優先した改善案を生成できます。`
      ).catch(() => {});
      return;
    }

    // !project insight add <pid> <type> <text...>
    // type aliases: feedback/f → human_feedback, product/p → product_audit, pm → pm_audit, req/r → requirement
    if (insightSub === 'add') {
      // Owner のみ
      if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 `!project insight add` は Owner のみ実行できます。').catch(() => {});
        return;
      }
      const rawType = args[3] || '';
      const text    = args.slice(4).join(' ').trim();
      if (!rawType || !text) {
        await message.reply(
          '**使い方**\n```\n!project insight add <pid> <type> <内容>\n```\n' +
          'type: `feedback`（CEO指摘）/ `product`（Product監査）/ `pm`（PM監査）/ `req`（要件）\n' +
          '例: `!project insight add youtube予測ai product viewCount依存で投稿前予測不可`'
        ).catch(() => {});
        return;
      }
      const typeMap = {
        feedback: 'human_feedback', f:       'human_feedback',
        product:  'product_audit',  p:       'product_audit',
        pm:       'pm_audit',
        req:      'requirement',    r:       'requirement',
        // フルネームもそのまま受け付ける
        human_feedback: 'human_feedback',
        product_audit:  'product_audit',
        pm_audit:       'pm_audit',
        requirement:    'requirement',
      };
      const insType = typeMap[rawType.toLowerCase()] || 'human_feedback';
      const sec = security.checkPrompt(text);
      if (!sec.safe) {
        await message.reply(`🚫 セキュリティチェックで拒否: ${sec.reason}`).catch(() => {});
        return;
      }
      const ins = projectInsights.addInsight(insightPid, insType, text, {
        addedBy: message.author.id,
        source:  'discord_command',
      });
      const typeLabel = projectInsights.typeLabel(insType);
      await message.reply(
        `✅ **Insight 追加** — \`${insightPid}\`\n\n` +
        `種別: ${typeLabel} | 優先度: ${ins.category}\n` +
        `内容: ${text.slice(0, 100)}\n` +
        `ID: \`${ins.id}\`\n\n` +
        `\`!project refine ${insightPid}\` で P${ins.category.slice(1)} 優先の改善案を生成できます。`
      ).catch(() => {});
      logger.info(`[Insight] 追加: ${insightPid} | ${insType} | ${text.slice(0, 50)} | by:${message.author.id}`);
      return;
    }

    // !project insight resolve <pid> <insightId>
    if (insightSub === 'resolve') {
      if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 `!project insight resolve` は Owner のみ実行できます。').catch(() => {});
        return;
      }
      const insId = args[3] || '';
      if (!insId) {
        await message.reply('使い方: `!project insight resolve <pid> <insightId>`').catch(() => {});
        return;
      }
      const result = projectInsights.resolveInsight(insightPid, insId);
      if (!result) {
        await message.reply(`❌ Insight \`${insId}\` が見つかりません。`).catch(() => {});
        return;
      }
      await message.reply(`✅ Insight \`${insId}\` を解決済みにしました。`).catch(() => {});
      return;
    }

    // !project insight clear <pid>
    if (insightSub === 'clear') {
      if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 `!project insight clear` は Owner のみ実行できます。').catch(() => {});
        return;
      }
      const count = projectInsights.clearInsights(insightPid);
      await message.reply(`🗑️ \`${insightPid}\` の Insight ${count}件 を削除しました。`).catch(() => {});
      return;
    }

    // ヘルプ
    await message.reply(
      '**!project insight コマンド:**\n```\n' +
      '!project insight list [pid]                  → 一覧\n' +
      '!project insight add <pid> <type> <内容>     → 追加（Owner のみ）\n' +
      '!project insight resolve <pid> <id>          → 解決済みに（Owner のみ）\n' +
      '!project insight clear <pid>                 → 全削除（Owner のみ）\n' +
      '```\n' +
      'type: `feedback`（CEO指摘）/ `product`（Product監査）/ `pm`（PM監査）/ `req`（要件）'
    ).catch(() => {});
    return;
  }

  // ─── !project board [projectId] — AI Board Report 手動生成 ───
  if (sub === 'board') {
    const boardPid = args[1] || projectManager.getCurrentProject(message.channelId) || 'default';
    const boardProj = projectManager.getProject(boardPid);
    if (!boardProj) {
      await message.reply(`❌ プロジェクトが見つかりません: \`${boardPid}\``).catch(() => {});
      return;
    }
    const processingBoard = await message.reply(`⏳ **AI Board Report 生成中...**\n\`${boardPid}\``).catch(() => null);
    try {
      const qa = (() => {
        try { return qualityGate.assessQuality(boardPid); }
        catch { return { level: 'GREEN', score: null, redTriggers: [] }; }
      })();
      // 手動実行の場合 runStats は現在のタスク状態から推定
      const allT     = taskManager.listTasks();
      const projT    = projectManager.filterTasksByProject(allT, boardPid);
      const doneCount = projT.filter(t => t.state === taskManager.STATES.DONE).length;
      const runStats = {
        tasksDone:   doneCount,
        tasksFailed: 0,
        stopReason:  'manual_board',
        yellowCount: 0,
      };
      const report   = aiBoardReport.generateBoardReport(boardPid, runStats, qa, taskManager, projectManager);
      const text     = aiBoardReport.formatBoardReport(report);
      if (processingBoard) await processingBoard.edit(text.slice(0, 1900)).catch(() => {});
      else await message.reply(text.slice(0, 1900)).catch(() => {});
      logger.info(`[BoardReport] 手動生成: ${boardPid} | status:${report.status}`);
    } catch (e) {
      logger.error(`[BoardReport] 手動生成エラー: ${e.message}`);
      if (processingBoard) await processingBoard.edit(`❌ Board Report 生成に失敗しました: ${e.message.slice(0, 100)}`).catch(() => {});
    }
    return;
  }

  // ─── !project runner <サブコマンド> — Phase A-2 ───────────────
  if (sub === 'runner') {
    const runnerSub = args[1] || 'status';
    const pid       = projectManager.getCurrentProject(message.channelId);
    const project   = projectManager.getProject(pid);

    if (!project) {
      await message.reply(`❌ プロジェクトが見つかりません: \`${pid}\`\n\`!project list\` で確認してください。`);
      return;
    }

    // !project runner status
    if (runnerSub === 'status') {
      const statusText = autoProjectRunner.formatRunnerStatus(pid);
      await message.reply(
        statusText + '\n\n' +
        '```\n' +
        '!project runner on     → 有効化\n' +
        '!project runner off    → 無効化\n' +
        '!project runner reset  → リセット\n' +
        '```'
      );
      return;
    }

    // !project runner on
    if (runnerSub === 'on') {
      autoProjectRunner.enableRunner(pid);
      const state = autoProjectRunner.getRunnerState(pid);
      await message.reply(
        `✅ **Auto Runner を有効化しました**\n\n` +
        `Project: **${project.name}** (\`${pid}\`)\n\n` +
        `現在は状態管理のみです。自動実行は Phase B 以降に実装されます。\n\n` +
        `状態確認:\n\`\`\`\n!project runner status\n\`\`\``
      );
      return;
    }

    // !project runner off
    if (runnerSub === 'off') {
      autoProjectRunner.disableRunner(pid);
      await message.reply(
        `⛔ **Auto Runner を無効化しました**\n\n` +
        `Project: **${project.name}** (\`${pid}\`)\n\n` +
        `再開するには:\n\`\`\`\n!project runner on\n\`\`\``
      );
      return;
    }

    // !project runner reset
    if (runnerSub === 'reset') {
      autoProjectRunner.resetRunner(pid);
      await message.reply(
        `🔄 **Auto Runner をリセットしました**\n\n` +
        `Project: **${project.name}** (\`${pid}\`)\n` +
        `ループカウント・完了数・フェーズをすべて初期値に戻しました。\n` +
        `Runner は無効状態です。\n\n` +
        `再開するには:\n\`\`\`\n!project runner on\n\`\`\``
      );
      return;
    }

    // !project runner auto-apply on/off/status
    if (runnerSub === 'auto-apply') {
      const aaSub   = args[2] || 'status';
      const state   = autoProjectRunner.getRunnerState(pid);

      if (aaSub === 'on') {
        autoProjectRunner.setAutoApplyPlanning(pid, true);
        await message.reply(
          `✅ **Auto Apply Planning: ON**\n\n` +
          `Project: **${project.name}**\n\n` +
          `runner step で DOCS/RESEARCH/TEST 候補が1件だけ自動登録されます。\n` +
          `IMPLEMENT/FIX/REVIEW は自動登録しません。\n\n` +
          `OFF にするには:\n\`\`\`\n!project runner auto-apply off\n\`\`\``
        );
        return;
      }
      if (aaSub === 'off') {
        autoProjectRunner.setAutoApplyPlanning(pid, false);
        await message.reply(
          `⛔ **Auto Apply Planning: OFF**\n\n` +
          `Project: **${project.name}**\n\n` +
          `次候補の自動登録を停止しました。手動で登録するには:\n\`\`\`\n!project plan apply\n\`\`\``
        );
        return;
      }
      // status
      const apFlag = autoProjectRunner.getRunnerState(pid).autoApplyPlanning;
      await message.reply(
        `📋 **Auto Apply Planning 状態**\n\n` +
        `Project: **${project.name}** (\`${pid}\`)\n` +
        `状態: **${apFlag ? '✅ ON' : '⛔ OFF'}**\n\n` +
        `ON: DOCS/RESEARCH/TEST を1件/step 自動登録\n` +
        `OFF: ヒント表示のみ\n\n` +
        `\`\`\`\n!project runner auto-apply on\n!project runner auto-apply off\n\`\`\``
      );
      return;
    }

    await message.reply(
      '**!project runner の使い方**\n```\n' +
      '!project runner status              → 状態確認\n' +
      '!project runner on                  → 有効化\n' +
      '!project runner off                 → 無効化\n' +
      '!project runner reset               → リセット\n' +
      '!project runner auto-apply on       → 自動登録 ON\n' +
      '!project runner auto-apply off      → 自動登録 OFF\n' +
      '!project runner auto-apply status   → 自動登録 状態確認\n' +
      '```'
    );
    return;
  }

  // !project current
  if (sub === 'current' || (!sub)) {
    const pid     = projectManager.getCurrentProject(message.channelId);
    const project = projectManager.getProject(pid);
    await message.reply(
      `📁 **現在のプロジェクト**\n\n` +
      `ID: \`${pid}\`\n` +
      `名前: **${project?.name || pid}**\n\n` +
      `変更するには: \`!project switch <プロジェクト名>\``
    );
    return;
  }

  // !project list
  if (sub === 'list') {
    const projects   = projectManager.listProjects();
    const currentPid = projectManager.getCurrentProject(message.channelId);
    await message.reply(
      `📁 **プロジェクト一覧** (${projects.length}件)\n\n` +
      projectManager.formatProjectList(projects, currentPid) + '\n\n' +
      `\`!project switch <名前>\` で切り替え / \`!project create <名前>\` で作成`
    );
    return;
  }

  // !project create <name>
  if (sub === 'create') {
    if (!name) {
      await message.reply('**使い方**\n```\n!project create <プロジェクト名>\n```\n例: `!project create YT予測`');
      return;
    }
    const result = projectManager.createProject(name);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }
    await message.reply(
      `✅ **プロジェクトを作成しました**\n\n` +
      `ID: \`${result.project.id}\`\n` +
      `名前: **${result.project.name}**\n\n` +
      `\`!project switch ${result.project.name}\` で切り替えできます。`
    );
    return;
  }

  // !project switch <name>
  if (sub === 'switch') {
    if (!name) {
      await message.reply('**使い方**\n```\n!project switch <プロジェクト名>\n```\n例: `!project switch AI_WORKER`');
      return;
    }
    const result = projectManager.setCurrentProject(message.channelId, name);
    if (!result.ok) {
      await message.reply(`❌ ${result.reason}`);
      return;
    }
    await message.reply(
      `✅ **プロジェクトを切り替えました**\n\n` +
      `現在: \`${result.projectId}\` — **${result.projectName}**\n\n` +
      `以降の \`!task list\` / \`!next\` / \`!auto run 1\` はこのプロジェクトのタスクを対象にします。`
    );
    return;
  }

  // !project plan / !project plan apply
  if (sub === 'plan') {
    const planSub = args[1] || '';
    const pid     = projectManager.getCurrentProject(message.channelId);
    const project = projectManager.getProject(pid);

    if (!project) {
      await message.reply(`❌ プロジェクトが見つかりません: \`${pid}\``);
      return;
    }

    // description / docs を収集
    const description = project.description || project.name || '';
    const docsDir     = path.join(AI_WORKER_ROOT, 'docs');
    let docsSummary   = '';
    try {
      if (fs.existsSync(docsDir)) {
        const docFiles = fs.readdirSync(docsDir)
          .filter(f => f.endsWith('.md') && !f.startsWith('auto-runner'))
          .slice(0, 3);
        docsSummary = docFiles
          .map(f => fs.readFileSync(path.join(docsDir, f), 'utf8').slice(0, 200))
          .join('\n');
      }
    } catch { /* ignore */ }

    // doneTasks: 完了済みタスクのサマリーを収集
    const allTasks = taskManager.listTasks();
    const projectTasks = projectManager.filterTasksByProject(allTasks, pid);
    const doneSummaries = projectTasks
      .filter(t => t.state === taskManager.STATES.ON_HOLD || /* archived=DONE is gone */false)
      .map(t => `${t.type}: ${(t.prompt || '').slice(0, 40)}`)
      .slice(0, 10);
    // history から完了タスクのサマリーを追加
    const historyDir = path.join(AI_WORKER_ROOT, 'data', 'history');
    try {
      if (fs.existsSync(historyDir)) {
        const histFiles = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        for (const hf of histFiles.slice(-2)) {
          const hist = JSON.parse(fs.readFileSync(path.join(historyDir, hf), 'utf8'));
          (hist.tasks || [])
            .filter(t => (t.projectId || 'default') === pid)
            .forEach(t => doneSummaries.push(`${t.type}: ${(t.prompt || '').slice(0, 40)}`));
        }
      }
    } catch { /* ignore */ }

    // ─── !project plan apply — 候補を tasks.json に登録 ───
    if (planSub === 'apply') {
      const applyMsg = await message.reply(`⏳ **Plan Apply 中...**\n\`${pid}\``);

      const planner2  = require('./utils/project-planner.js');
      const allTasks2 = taskManager.listTasks();
      const pTasks2   = projectManager.filterTasksByProject(allTasks2, pid);
      const doneSums2 = pTasks2
        .filter(t => t.state === taskManager.STATES.ON_HOLD)
        .map(t => `${t.type}: ${(t.prompt || '').slice(0, 40)}`);
      const histDir2  = path.join(AI_WORKER_ROOT, 'data', 'history');
      try {
        if (fs.existsSync(histDir2)) {
          fs.readdirSync(histDir2).filter(f => f.endsWith('.json')).slice(-2).forEach(hf => {
            try {
              const hist = JSON.parse(fs.readFileSync(path.join(histDir2, hf), 'utf8'));
              (hist.tasks || []).filter(t => (t.projectId || 'default') === pid)
                .forEach(t => doneSums2.push(`${t.type}: ${(t.prompt || '').slice(0, 40)}`));
            } catch {}
          });
        }
      } catch {}

      // Phase D-6: LLM Planner 優先（apply コマンドも LLM 候補を使用）
      const proj2 = projectManager.getProject(pid);
      const plan2 = await planner2.planProjectGoalsBest(pid, {
        description: (proj2?.description || proj2?.name || '') + (proj2?.goal || ''),
        doneTasks:   doneSums2,
      });

      // 上位3件を登録（重複チェック付き）
      const candidates = plan2.nextCandidates.slice(0, 3);
      const registered = [];
      for (const cand of candidates) {
        // 重複チェック: 同プロジェクト・同タイトルの PENDING/作業中 タスクがないか
        const isDup = allTasks2.some(t =>
          t.projectId === pid &&
          t.type === cand.type &&
          (t.state === taskManager.STATES.PENDING || t.state === taskManager.STATES.IN_PROGRESS) &&
          (t.prompt || '').slice(0, 30) === (cand.prompt || '').slice(0, 30)
        );
        if (isDup) {
          registered.push({ skipped: true, title: cand.title, type: cand.type });
          continue;
        }
        const newTask = taskManager.createTask(
          cand.prompt,
          message.author.id,
          null,
          cand.priority === '高' ? '高' : '低',
          pid,
          cand.type
        );
        registered.push({ skipped: false, task: newTask, title: cand.title });
      }

      const regLines = registered.map((r, i) => {
        if (r.skipped) return `${i+1}. [スキップ: 重複] ${r.title}`;
        const typeEmoji = taskManager.TYPE_EMOJI[r.task.type] || '📋';
        return `${i+1}. ${typeEmoji} [${r.task.type}/${r.task.priority}]\n\`\`\`\n${r.task.id}\n\`\`\``;
      }).join('\n');

      const newCount = registered.filter(r => !r.skipped).length;
      const replyText =
        `✅ **Plan Apply 完了**\n\n` +
        `登録: ${newCount}件 / スキップ: ${registered.filter(r => r.skipped).length}件\n\n` +
        regLines + '\n\n' +
        (newCount > 0
          ? `次:\n\`\`\`\n!task list\n!auto run 1\n\`\`\``
          : '新規登録なし。`!task list` で確認してください。');

      await applyMsg.edit(replyText.slice(0, 1900));
      return;
    }

    const processingMsg = await message.reply(`🔍 **Project Plan を分析中...**\n\`${pid}\``);

    // Phase D-6: LLM Planner 優先、API キーなし/失敗時はルールベースへフォールバック
    const planner = require('./utils/project-planner.js');
    const plan    = await planner.planProjectGoalsBest(pid, {
      description: description + '\n' + project.goal || '',
      docs:        docsSummary,
      doneTasks:   doneSummaries,
    });

    // スマホ向け表示を構築
    const sourceLabel  = plan.source === 'llm' ? '🤖 LLM Planner' : '📋 rule-based';
    const gapLines = plan.gaps.slice(0, 5)
      .map((g, i) => `${i + 1}. ${g}`).join('\n') || '（なし）';

    const candidateLines = plan.nextCandidates.slice(0, 5)
      .map((c, i) => `${i + 1}. [${c.type}/${c.priority}] ${c.title}\n   理由: ${c.reason}`)
      .join('\n') || '（なし）';

    const reply =
      `📋 **Project Plan** (${sourceLabel})\n` +
      `Project: **${project.name}** (\`${pid}\`)\n\n` +
      `**不足と推定:**\n${gapLines}\n\n` +
      `**次タスク候補:**\n${candidateLines}\n\n` +
      `登録する場合:\n` +
      `\`\`\`\n!project plan apply\n\`\`\``;

    await processingMsg.edit(reply.slice(0, 1900));
    return;
  }

  // !project run <projectId>
  if (sub === 'run') {
    const runPid = args[1] || '';
    await handleProjectRun(message, runPid);
    return;
  }

  // Step2: !project stop [projectId]
  if (sub === 'stop') {
    const stopPid = args[1] || projectManager.getCurrentProject(message.channelId) || '';
    if (!stopPid) {
      await message.reply('使い方: `!project stop <projectId>`').catch(() => {});
      return;
    }
    const ctx = activeRuns.get(stopPid);
    if (!ctx) {
      await message.reply(`⚠️ \`${stopPid}\` は現在実行中ではありません。`).catch(() => {});
      return;
    }
    // ④ C-1修正: awaiting_human 中の stop は _teardown を直接呼んで activeRuns を解放
    if (ctx.stopReason === 'awaiting_human') {
      ctx.stopRequested = true;
      ctx.stopReason    = 'stopped_by_user';
      ctx.pendingApproval = null;
      await message.reply(
        `⏹️ **人間確認待ちを中断して停止します**\n\nProject: \`${stopPid}\``
      ).catch(() => {});
      logger.info(`[ProjectRun] awaiting_human 中の stop: ${stopPid}`);
      const prevPid2 = projectManager.getCurrentProject(message.channelId);
      await _teardown(ctx, prevPid2);
      return;
    }

    ctx.stopRequested = true;
    ctx.stopReason    = 'stopped_by_user';
    await message.reply(
      `⏹️ **停止リクエストを受け付けました**\n\n` +
      `Project: \`${stopPid}\`\n` +
      `現在実行中のタスクが完了した後に停止します。`
    ).catch(() => {});
    logger.info(`[ProjectRun] stop requested: ${stopPid}`);
    return;
  }

  // 不明なサブコマンド
  await message.reply(
    '**使い方**\n```\n!project current\n!project list\n!project create <名前>\n!project switch <名前>\n!project plan\n!project runner status|on|off|reset\n!project run <projectId>   → Runner 起動\n!project stop [projectId]  → Runner 停止\n```'
  );
}

// list: reports/research_*.md を新しい順に最大10件表示する。
// show: reports/research_<id>.md のフル内容を表示する。
// reports/ フォルダがない場合も安全に処理する。
// ─────────────────────────────────────────────────────
async function handleResearch(message, sub) {
  const reportsDir = path.join(AI_WORKER_ROOT, 'reports');

  // ─── !research show <id> — フル調査レポートを表示 ───
  if (sub === 'show') {
    // args[2] 相当: !research show task_xxx → content.split()[2]
    const rawId = message.content.split(/\s+/)[2] || '';
    if (!rawId) {
      await message.reply(
        '**使い方**\n```\n!research show <タスクID>\n```\n' +
        '例: `!research show task_1780123456789`\n\n' +
        'タスクIDは `!research list` で確認できます。'
      );
      return;
    }

    const reportPath = path.join(reportsDir, `research_${rawId}.md`);
    if (!fs.existsSync(reportPath)) {
      await message.reply(
        `❌ **調査レポートが見つかりません**\n\n` +
        `ID: \`${rawId}\`\n` +
        `確認場所: \`reports/research_${rawId}.md\`\n\n` +
        `\`!research list\` で利用可能なレポート一覧を確認できます。`
      );
      return;
    }

    const content  = fs.readFileSync(reportPath, 'utf8');
    const date     = new Date(fs.statSync(reportPath).mtimeMs).toLocaleString('ja-JP');
    const header   = `📄 **調査レポート: \`${rawId}\`** | ${date}\n\n`;
    const MAX_BODY = 1800 - header.length;

    if (content.length <= MAX_BODY) {
      // 全文を1メッセージで送信
      await message.reply(header + content);
    } else {
      // 先頭 MAX_BODY 文字 + 省略案内
      const truncated = content.slice(0, MAX_BODY);
      const suffix    = `\n\n...[省略] フル内容: \`reports/research_${rawId}.md\``;
      await message.reply(header + truncated + suffix);
    }
    return;
  }

  // ─── !research list 以外は使い方を表示 ───
  if (sub !== 'list') {
    await message.reply(
      '**使い方**\n```\n!research list\n!research show <タスクID>\n```\n' +
      '`list` — 調査レポート一覧を表示\n' +
      '`show <ID>` — 特定のレポートをフル表示'
    );
    return;
  }

  // reports/ フォルダがない場合
  if (!fs.existsSync(reportsDir)) {
    await message.reply(
      '📂 **調査レポートがありません**\n\n' +
      '`reports/` フォルダが存在しません。\n' +
      '`!auto run 1` または `!auto on` で RESEARCH タスクを実行すると保存されます。'
    );
    return;
  }

  // research_*.md ファイルを取得
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('research_') && f.endsWith('.md'))
    .map(f => ({
      name:  f,
      mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs,
      full:  path.join(reportsDir, f),
    }))
    .sort((a, b) => b.mtime - a.mtime) // 新しい順
    .slice(0, 10);                       // 最大10件

  if (files.length === 0) {
    await message.reply(
      '📂 **調査レポートがありません**\n\n' +
      '`reports/` フォルダは存在しますが、調査レポートがまだ保存されていません。\n' +
      'RESEARCH タスクを実行すると `reports/research_<id>.md` に保存されます。'
    );
    return;
  }

  // 各ファイルの先頭サマリーを抽出
  const lines = [
    `📚 **調査レポート一覧** (${files.length}件 / 最新10件)`,
    ``,
  ];

  files.forEach((f, i) => {
    // ファイル名から taskId を抽出: research_<taskId>.md
    const taskId  = f.name.replace(/^research_/, '').replace(/\.md$/, '');
    const date    = new Date(f.mtime).toLocaleString('ja-JP');
    const content = fs.readFileSync(f.full, 'utf8');

    // 「## 調査結果」セクションの先頭100文字を抽出
    const resultMatch = content.match(/## 調査結果\n+([^\n].{0,100})/);
    const summary     = resultMatch
      ? resultMatch[1].trim().slice(0, 80)
      : content.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 1).join('').slice(0, 80);

    lines.push(
      `**${i + 1}.** \`${taskId}\``,
      `　📅 ${date}`,
      summary ? `　${summary}${summary.length >= 80 ? '...' : ''}` : '',
      ``,
    );
  });

  lines.push(`> \`reports/research_<id>.md\` でフルレポートを確認できます。`);

  await message.reply(lines.filter(l => l !== null).join('\n'));
}

// ─────────────────────────────────────────────────────
// !review list — 過去の Codex レビュー結果一覧を表示
//
// reviews/result_*.md を新しい順に最大10件表示する。
// 各ファイルから危険度・問題点サマリーを抽出して表示。
// reviews/ フォルダがない場合も安全に処理する。
// ─────────────────────────────────────────────────────
async function handleReview(message, sub) {
  const reviewsDir = path.join(AI_WORKER_ROOT, 'reviews');

  // ─── !review backfill <id> — codex_task_*.md から result_task_*.md を生成 ───
  if (sub === 'backfill') {
    const rawId = message.content.split(/\s+/)[2] || '';
    if (!rawId) {
      await message.reply(
        '**使い方**\n```\n!review backfill <タスクID>\n```\n' +
        '`codex_task_<id>.md` が存在する場合に `result_task_<id>.md` を生成します。\n' +
        '例: `!review backfill task_1780317028048`'
      ).catch(() => {});
      return;
    }

    const codexPath  = path.join(reviewsDir, `codex_${rawId}.md`);
    const resultPath = path.join(reviewsDir, `result_${rawId}.md`);

    if (!fs.existsSync(codexPath)) {
      await message.reply(
        `❌ **codex_${rawId}.md が見つかりません**\n\nCodex 依頼ファイルが存在しないため backfill できません。`
      ).catch(() => {});
      return;
    }
    if (fs.existsSync(resultPath)) {
      await message.reply(
        `⏭️ **result_${rawId}.md は既に存在します**\n\n上書きは行いません。\n` +
        `確認: \`!review show ${rawId}\``
      ).catch(() => {});
      return;
    }

    try {
      const content = fs.readFileSync(codexPath, 'utf8');

      // API 回答セクションを抽出
      const markerMatch = content.match(/^## Codex API 回答（自動取得:[^）]*）\s*\n/m)
                       || content.match(/^## Codex 回答（自動取得）\s*\n/m);
      const apiText = markerMatch
        ? content.slice(markerMatch.index + markerMatch[0].length).trim()
        : null;

      if (!apiText) {
        await message.reply(
          `❌ **Codex API 回答セクションが見つかりません**\n\n` +
          `\`codex_${rawId}.md\` に \`## Codex API 回答（自動取得:...）\` ヘッダーがありません。`
        ).catch(() => {});
        return;
      }

      // ヘッダーの危険度を抽出（フォールバック: '低'）
      const dangerMatch = content.match(/\| 危険度\s+\|\s*(高|中|低)/);
      const headerDanger = dangerMatch ? dangerMatch[1] : '低';

      // parseCodexResult で構造化マーカーを試みる（なければフリーテキストをそのまま）
      const parsed = codex.parseCodexResult(apiText);
      const finalDanger = (parsed.danger && parsed.danger !== '低')
        ? parsed.danger
        : headerDanger;
      const problem    = parsed.problem || apiText;
      const suggestion = parsed.suggestion || '（なし）';
      const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[finalDanger] || '⬜';

      fs.writeFileSync(resultPath, [
        `# Codex レビュー結果: ${rawId}`,
        ``,
        `| 項目 | 内容 |`,
        `|------|------|`,
        `| 作成日時 | ${new Date().toLocaleString('ja-JP')} |`,
        `| タスクID | ${rawId} |`,
        `| 危険度   | ${dangerEmoji} ${finalDanger} |`,
        ``,
        `## 問題点`,
        ``,
        problem,
        ``,
        `## 改善案`,
        ``,
        suggestion,
        ``,
        `## フィードバック適用コマンド`,
        ``,
        `\`!apply-review ${rawId}\``,
      ].join('\n'), 'utf8');

      logger.info(`[Review] backfill 完了: result_${rawId}.md | 危険度: ${finalDanger}`);
      await message.reply(
        `✅ **backfill 完了**\n\n` +
        `タスク: \`${rawId}\`\n` +
        `危険度: ${dangerEmoji} ${finalDanger}\n\n` +
        `確認: \`!review show ${rawId}\``
      ).catch(() => {});
    } catch (bfErr) {
      logger.error(`[Review] backfill エラー: ${bfErr.message}`);
      await message.reply(
        `❌ **backfill 失敗**\n\n${bfErr.message.slice(0, 100)}`
      ).catch(() => {});
    }
    return;
  }

  // ─── !review show <id> — レビュー結果全文を表示 ───
  if (sub === 'show') {
    const rawId = message.content.split(/\s+/)[2] || '';
    if (!rawId) {
      await message.reply(
        '**使い方**\n```\n!review show <タスクID>\n```\n' +
        '例: `!review show task_1780123456789`\n\n' +
        'タスクIDは `!review list` で確認できます。'
      );
      return;
    }

    const resultPath = path.join(reviewsDir, `result_${rawId}.md`);
    if (!fs.existsSync(resultPath)) {
      await message.reply(
        `❌ **レビュー結果が見つかりません**\n\n` +
        `ID: \`${rawId}\`\n` +
        `確認場所: \`reviews/result_${rawId}.md\`\n\n` +
        `\`!review list\` で利用可能なレビュー結果一覧を確認できます。`
      );
      return;
    }

    const content = fs.readFileSync(resultPath, 'utf8');
    const date    = new Date(fs.statSync(resultPath).mtimeMs).toLocaleString('ja-JP');

    // FIX タスクが生成されていれば状態を表示
    const fixTasks = taskManager.findFixTasksFromReview(rawId);
    const fixStatus = fixTasks.length > 0
      ? `\n🔧 **修正タスク生成済み (${fixTasks.length}件):**\n` +
        fixTasks.map(t => `  \`${t.id}\` [${t.type}/${t.size}] ${t.state}`).join('\n')
      : '';

    const header   = `📋 **Codexレビュー結果: \`${rawId}\`** | ${date}${fixStatus}\n\n`;
    const MAX_BODY = 1800 - header.length;

    const applyCmd = fmt.formatSmartphoneCommand('適用するには:', `!apply-review ${rawId}`);
    if (content.length <= MAX_BODY) {
      await message.reply(header + content + `\n\n${applyCmd}`);
    } else {
      const suffix = `\n\n...[省略] フル内容:\n\`reviews/result_${rawId}.md\`\n\n` +
                     fmt.formatSmartphoneCommand('適用するには:', `!apply-review ${rawId}`);
      await message.reply(header + content.slice(0, MAX_BODY) + suffix);
    }
    return;
  }

  // ─── !review list 以外は使い方を表示 ───
  if (sub !== 'list') {
    await message.reply(
      '**使い方**\n```\n!review list\n!review show <タスクID>\n```\n' +
      '`list` — レビュー結果一覧を表示\n' +
      '`show <ID>` — 特定のレビュー結果をフル表示'
    );
    return;
  }

  // reviews/ フォルダがない場合
  if (!fs.existsSync(reviewsDir)) {
    await message.reply(
      '📂 **Codex レビュー結果がありません**\n\n' +
      '`reviews/` フォルダが存在しません。\n' +
      'REVIEW タスクを実行すると `reviews/result_<id>.md` に保存されます。'
    );
    return;
  }

  // result_*.md ファイルを取得（最大10件・新しい順）
  const files = fs.readdirSync(reviewsDir)
    .filter(f => f.startsWith('result_') && f.endsWith('.md'))
    .map(f => ({
      name:  f,
      mtime: fs.statSync(path.join(reviewsDir, f)).mtimeMs,
      full:  path.join(reviewsDir, f),
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10);

  if (files.length === 0) {
    await message.reply(
      '📂 **Codex レビュー結果がありません**\n\n' +
      '`reviews/` フォルダは存在しますが、`result_*.md` がまだ保存されていません。\n' +
      'REVIEW タスクを実行すると保存されます。'
    );
    return;
  }

  // 各ファイルから危険度・問題点を抽出
  const lines = [
    `🔍 **Codex レビュー結果一覧** (${files.length}件 / 最新10件)`,
    ``,
  ];

  files.forEach((f, i) => {
    const taskId  = f.name.replace(/^result_/, '').replace(/\.md$/, '');
    const date    = new Date(f.mtime).toLocaleString('ja-JP');
    const content = fs.readFileSync(f.full, 'utf8');

    // 危険度を抽出: `| 危険度   | 🔴 高 |` 形式
    const dangerMatch  = content.match(/\|\s*危険度\s*\|\s*([^\|]+)\|/);
    const dangerLabel  = dangerMatch
      ? dangerMatch[1].trim()
      : '未評価';

    // 問題点の先頭80文字を抽出
    const problemMatch = content.match(/## 問題点\n+([^\n#].{0,100})/);
    const problem      = problemMatch
      ? problemMatch[1].trim().slice(0, 80)
      : '';

    lines.push(
      `**${i + 1}.** \`${taskId}\``,
      `　📅 ${date}  |  危険度: ${dangerLabel}`,
      problem ? `　❗ ${problem}${problem.length >= 80 ? '...' : ''}` : '',
      fmt.formatSmartphoneCommand('次のコマンド:', `!apply-review ${taskId}`),
      fmt.formatTypeGuard(dangerLabel),
      ``,
    );
  });

  lines.push(`> \`reviews/result_<id>.md\` でフル結果を確認できます。`);

  await message.reply(lines.filter(l => l !== null).join('\n'));
}

// ─────────────────────────────────────────────────────
// !next コマンド — 最優先の実行可能タスクを1件表示
// ─────────────────────────────────────────────────────
async function handleNext(message) {
  const currentPid = projectManager.getCurrentProject(message.channelId);
  const tasks      = taskManager.listTasksByPriority();
  const filtered   = projectManager.filterTasksByProject(tasks, currentPid);
  const next = filtered.find(t => t.state === taskManager.STATES.PENDING);

  if (!next) {
    const stateDetail = {};
    filtered.forEach(t => { stateDetail[t.state] = (stateDetail[t.state] || 0) + 1; });
    const detailLines = Object.entries(stateDetail)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `${taskManager.STATE_EMOJI[s] || '❓'} ${s}: ${c}件`);
    const canResume = stateDetail['レビュー待ち'] > 0 || stateDetail['保留'] > 0;

    const embed = new EmbedBuilder()
      .setColor(0x95A5A6)
      .setTitle('📋 次タスク')
      .setDescription(`Project: **${currentPid}**\n実行可能な未着手タスクはありません。`)
      .setTimestamp();
    if (detailLines.length > 0) {
      embed.addFields({ name: '現在のタスク状況', value: detailLines.join('\n'), inline: false });
    }
    if (canResume) {
      embed.setFooter({ text: '!task cleanup で整理するか !task resume <id> で再開できます。' });
    }
    await message.reply({ embeds: [embed] });
    return;
  }

  const typeLabel = next.type || taskManager.TASK_TYPES.IMPLEMENT;
  const sizeLabel = next.size || taskManager.TASK_SIZES.MEDIUM;
  const typeEmoji = taskManager.TYPE_EMOJI[typeLabel] || '📋';
  const sizeEmoji = taskManager.SIZE_EMOJI[sizeLabel] || '🟡';
  const PRIORITY_EN = { '高': 'HIGH', '中': 'MEDIUM', '低': 'LOW' };
  const priorityEn  = PRIORITY_EN[next.priority] || next.priority;
  const isLarge     = sizeLabel === taskManager.TASK_SIZES.LARGE;

  const embed = new EmbedBuilder()
    .setColor(isLarge ? 0xED4245 : 0x57F287)
    .setTitle('📋 次タスク')
    .addFields(
      { name: 'Task ID',  value: `\`${next.id}\``,               inline: true },
      { name: 'タイプ',   value: `${typeEmoji} ${typeLabel}`,     inline: true },
      { name: 'サイズ',   value: `${sizeEmoji} ${sizeLabel}`,     inline: true },
      { name: '優先度',   value: priorityEn,                      inline: true },
      { name: 'Project',  value: currentPid,                      inline: true },
      { name: '内容',     value: next.prompt.slice(0, 200) + (next.prompt.length > 200 ? '…' : ''), inline: false },
    )
    .setTimestamp();

  if (isLarge) {
    embed.addFields({ name: '⚠️ 注意', value: 'LARGEタスクです。`!claude` で手動実行を推奨します。', inline: false });
  }

  await message.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────
// executeClaudeTask - !claude / !run-next 共通実行エンジン
//
// !claude も !run-next も同じ関数を通すことで
// 以下の安全機能が必ず実行される:
//   - prompt.md / result.md 保存
//   - workspace/<projectId>/<taskId>/ 作成
//   - completionValidator（変更なし/handoff検出）
//   - AIレビュー・Codexレビュー
//   - GitHub/PR連携
//   - next-task担当判断
//   - 無条件DONE禁止（validator通過後のみDONE）
//
// 引数:
//   message        - Discord メッセージオブジェクト
//   prompt         - 指示内容（全文）
//   taskId         - tasks.json に登録済みのタスクID
//   projectId      - プロジェクトID
//   taskType       - 'IMPLEMENT'|'RESEARCH'|'DESIGN'|'REVIEW'
//   taskSizeResult - { size, reason } from taskTypeUtil.estimateTaskSize
//   taskWorkspace  - workspace/<projectId>/<taskId>/ の絶対パス
//   refTaskId      - 継続モードの参照タスクID（通常null）
//   source         - 'claude' | 'run-next'（ログ識別用）
// ─────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────
// resolveTaskTimeoutMs(size) — タスクサイズ別のタイムアウト(ms)
//
// 一律5分だと MEDIUM/LARGE のタスクが頻繁にタイムアウトしていたため、
// サイズに応じて上限を伸ばす。各値は環境変数で上書き可能。
//   SMALL  : TASK_TIMEOUT_SECONDS        (既定 300 = 5分)
//   MEDIUM : TASK_TIMEOUT_MEDIUM_SECONDS (既定 600 = 10分)
//   LARGE  : TASK_TIMEOUT_LARGE_SECONDS  (既定 900 = 15分)
// ─────────────────────────────────────────────────────
function resolveTaskTimeoutMs(size) {
  const small  = parseInt(process.env.TASK_TIMEOUT_SECONDS) || 300;
  const medium = parseInt(process.env.TASK_TIMEOUT_MEDIUM_SECONDS) || 600;
  const large  = parseInt(process.env.TASK_TIMEOUT_LARGE_SECONDS) || 900;
  const sec = size === taskManager.TASK_SIZES.LARGE ? large
            : size === taskManager.TASK_SIZES.MEDIUM ? medium
            : small;
  return sec * 1000;
}

async function executeClaudeTask({
  message, prompt, taskId, projectId, taskType, taskSizeResult,
  taskWorkspace, refTaskId = null, source = 'claude',
}) {
  logger.info(`タスク開始 | ID: ${taskId} | source:${source} | ${message.author.tag} | ${prompt.slice(0, 80)}`);

  taskManager.updateState(taskId, taskManager.STATES.IN_PROGRESS, 'Claude Code 実行開始');
  reviewHistory.addEntry(
    reviewHistory.EVENT_TYPES.CLAUDE_RUN, taskId, '適用済み',
    `Claude Code 実行開始: ${prompt.slice(0, 60)}`
  );

  // タスクサイズ別タイムアウト（display と claudeRunner.run の両方で使う）
  const taskTimeoutMs = resolveTaskTimeoutMs(taskSizeResult.size);

  let processingMsg = null;
  try {
    const phaseFlags = [
      ENABLE_GITHUB ? '🔗GitHub' : '',
      ENABLE_PR ? '📋PR' : '',
      ENABLE_CODEX  ? '🤖Codex' : '',
    ].filter(Boolean).join(' | ');

    const timeoutMin = Math.floor(taskTimeoutMs / 60000);

    processingMsg = await message.channel.send(
      `▶️ **Claude Code が作業を開始しました**\n` +
      `\`\`\`\nタスクID : ${taskId}\nProject  : ${projectId}\n` +
      (refTaskId ? `継続元  : ${refTaskId}\n` : '') +
      `指示内容 : ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\n` +
      `TaskType : ${taskTypeUtil.TYPE_EMOJI[taskType] || ''} ${taskType}\n` +
      `TaskSize : ${taskTypeUtil.SIZE_EMOJI[taskSizeResult.size] || ''} ${taskSizeResult.size}\n` +
      `完了条件 : ${taskTypeUtil.getCompletionCriteria(taskType)}\n` +
      `最大待機 : ${timeoutMin}分\n有効機能 : ${phaseFlags || 'なし'}\n\`\`\`\n` +
      `作業完了後にここへ結果を報告します。`
    );
  } catch (err) {
    logger.error(`処理中メッセージ送信失敗: ${err.message}`);
    return;
  }

  try {
    fs.mkdirSync(taskWorkspace, { recursive: true });

    fs.writeFileSync(
      path.join(taskWorkspace, 'prompt.md'),
      `# タスク: ${taskId}\n\n- **日時:** ${new Date().toLocaleString('ja-JP')}\n- **依頼者:** ${message.author.tag}\n- **Project:** ${projectId}\n\n## 指示内容\n${prompt}\n`,
      'utf8'
    );

    // ═══════════════════════════════════════
    // STEP 1: Claude Code 実行
    // タイムアウト対策: 探索ルールをプロンプト末尾に自動付与して
    // node_modules 等の広域検索によるタイムアウトを防ぐ
    // ═══════════════════════════════════════
    const explorationRules = taskTypeUtil.buildExplorationRules(taskType, taskSizeResult);

    // DOCS タスク: 出力ファイルを自動指定して「確認します」だけで終わることを防ぐ
    const docsOutputGuard = (taskType === 'DOCS')
      ? `\n---\n【DOCSタスク出力要件】\n必ず以下のMarkdownファイルを新規作成または更新すること:\ndocs/${taskId}.md\n\nファイルを作成せずに会話応答だけで終わることは禁止。`
      : '';

    const augmentedPrompt  = prompt + explorationRules + docsOutputGuard + taskManager.buildCommonLessons();

    // 探索対象をログに記録
    const explorationTargets = taskSizeResult.fileMatches.length > 0
      ? taskSizeResult.fileMatches.join(', ')
      : 'bot/**/*.js（ファイル指定なし）';
    logger.info(`探索対象: ${explorationTargets} | TaskType:${taskType} | TaskSize:${taskSizeResult.size}`);

    const taskStartMs = Date.now();
    const result = await claudeRunner.run(augmentedPrompt, taskWorkspace, AI_WORKER_ROOT, { timeoutMs: taskTimeoutMs });

    fs.writeFileSync(
      path.join(taskWorkspace, 'result.md'),
      `# 実行結果: ${taskId}\n\n- **完了日時:** ${new Date().toLocaleString('ja-JP')}\n- **実行時間:** ${result.duration}秒\n\n## 出力内容\n${result.output}\n`,
      'utf8'
    );

    // ═══════════════════════════════════════
    // STEP 1.5: 完了バリデーション（最優先・STEP 2 より前）
    // 変更なし / handoffのみ → 即 return（AIレビュー・Codex を生成しない）
    // ═══════════════════════════════════════
    const GIT_REPO   = process.env.GIT_REPO_PATH || path.join(__dirname, '..');
    const validation = completionValidator.validate(
      result.output,
      GIT_REPO,
      taskId,
      null,
      taskStartMs,
      taskType,
      prompt,
    );

    if (!validation.ok) {
      logger.warn(`完了バリデーション NG: ${taskId} — ${validation.reason}`);
      taskManager.updateState(taskId, taskManager.STATES.REVIEWING, `未完了 — ${validation.reason}`);

      const detectionDetail = [
        `handoff: ${validation.isHandoffOnly ? '🔴 検出' : '🟢 なし'}`,
        `会話応答: ${validation.isConversational ? `🔴 ${validation.conversationalReason}` : '🟢 なし'}`,
        `短文: ${validation.isShortResponse ? `🔴 ${validation._outputLength}文字` : '🟢 OK'}`,
        `質問文: ${validation.isQuestionEnding ? '🔴 検出' : '🟢 なし'}`,
      ].join('\n');

      const incompleteEmbed = new EmbedBuilder()
        .setColor(0xFF6600)
        .setTitle(`⚠️ 未完了 — コード変更が確認できませんでした`)
        .addFields(
          { name: '📋 ID',       value: `\`${taskId}\``,                                              inline: true },
          { name: '⏱️ 時間',    value: `${result.duration}秒`,                                        inline: true },
          { name: '📁 変更',     value: `${validation.changedFiles.length + validation.modifiedFiles.length}件 (${validation.diffStat})`, inline: true },
          { name: '❌ 理由',     value: validation.reason,                                             inline: false },
          { name: '🔍 検出詳細', value: detectionDetail,                                               inline: false },
          { name: '💡 対処',     value: `\`!claude ${taskId} 続行して実装してください\`\nまたは依頼内容を具体的に書き直してください`, inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `AI_WORKER | ${taskId}` });

      await processingMsg.edit({ content: '', embeds: [incompleteEmbed] });
      logger.info(`handoff抑制 | ${taskId} — ${validation.reason}`);
      return;
    }

    // バリデーションOK: 構文エラーは警告のみ
    if (!validation.syntaxOk) {
      logger.warn(`構文エラーあり(完了は許可): ${validation.syntaxErrors.map(e => e.file).join(', ')}`);
    }

    const taskChangedFiles = [
      ...validation.changedFiles,
      ...validation.modifiedFiles.map(m => m.file),
    ].filter((f, i, arr) => arr.indexOf(f) === i);

    // ═══════════════════════════════════════
    // STEP 2: AI レビュー
    // ═══════════════════════════════════════
    const review = aiReview.reviewChanges(prompt, result.output, taskChangedFiles, taskType);
    const { formatted: reviewText } = aiReview.saveReviewResult(taskId, prompt, review, projectId);

    taskManager.updateState(taskId, taskManager.STATES.REVIEWING, `AIレビュー: ${review.verdict}`);
    taskManager.updateTask(taskId, { reviewResult: { verdict: review.verdict }, dangerLevel: review.verdict === '却下推奨' ? '高' : review.verdict === '修正推奨' ? '中' : '低' });

    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.AI_REVIEW, taskId, review.verdict,
      `AIレビュー: ${review.issues.length}件の問題 / ${review.warnings.length}件の警告`
    );

    const reviewColor = { '問題なし': 0x00CC66, '修正推奨': 0xFFAA00, '却下推奨': 0xFF3333 }[review.verdict] || 0x999999;
    const reviewEmojiBig = { '問題なし': '🟢', '修正推奨': '🟡', '却下推奨': '🔴' }[review.verdict] || '🔍';
    const reviewExplain = {
      '問題なし':  'AIが確認しました。コードに大きな問題は見当たりませんでした。',
      '修正推奨':  'AIが確認しました。いくつか気になる点があります。修正を検討してください。',
      '却下推奨':  'AIが確認しました。このコードには問題があります。そのままでは使わないでください。',
    }[review.verdict] || 'AIがコードをレビューしました。';
    await sendNotification('aiReview', message.channel, {
      embeds: [new EmbedBuilder()
        .setColor(reviewColor)
        .setTitle(`${reviewEmojiBig} AIレビュー結果: ${review.verdict}`)
        .setDescription(
          `${reviewExplain}\n\n` +
          fmt.embedDesc(
            `\`\`\`\n${reviewText}\n\`\`\``,
            `review_${taskId}.md`
          )
        )
        .addFields(
          { name: '📋 タスクID', value: `\`${taskId}\``, inline: true },
          { name: '📁 詳細ファイル', value: `\`reviews/${projectId}/review_${taskId}.md\``, inline: false },
        )
        .setFooter({ text: 'このレビューはAIが自動的に行ったものです' })
        .setTimestamp()
      ],
    });

    if (review.verdict === '却下推奨') {
      reviewHistory.recordRejection(taskId, review.issues.join(' | '), 'AIレビュー');
      taskManager.updateState(taskId, taskManager.STATES.AWAITING, '却下推奨 — 人間確認待ち');
      await sendHumanMention(
        message.channel, taskId,
        'AIレビューが「却下推奨」と判定しました',
        `問題点:\n${review.issues.join('\n')}`,
        '高',
        { channelType: 'aiReview' }
      );
      approvalManager.createApproval(taskId, {
        reason:    `AIレビュー却下推奨: ${review.issues.slice(0, 2).join(' / ').slice(0, 80)}`,
        danger:    '高',
        channelId: message.channelId,
        authorTag: message.author.tag,
        type:      'post',
      });
    }

    // ═══════════════════════════════════════
    // STEP 3: Codex 依頼生成
    // ═══════════════════════════════════════
    let codexInfo    = null;
    let codexApiResp = null;

    const needsCodex = ENABLE_CODEX || codex.needsCodexReview(prompt, result.output);
    if (needsCodex) {
      const codexRequest = codex.generateCodexRequest(taskId, prompt, result.output, taskChangedFiles);
      const discordMsg   = codex.generateDiscordMessage(taskId, codexRequest);
      codex.saveReview(taskId, { ...codexRequest, discordMessage: discordMsg });
      codexInfo = { ...codexRequest, discordMessage: discordMsg };

      reviewHistory.addEntry(
        reviewHistory.EVENT_TYPES.CODEX_REQUEST, taskId, '問題なし',
        `Codex 依頼生成 | 危険度: ${codexRequest.danger}`
      );

      if (process.env.OPENAI_API_KEY) {
        codexApiResp = await codex.callCodexAPI(prompt, result.output);
        if (codexApiResp) {
          codex.saveCodexResponse(taskId, codexApiResp);
          reviewHistory.addEntry(
            reviewHistory.EVENT_TYPES.CODEX_RESPONSE, taskId, '適用済み',
            'Codex API 回答取得完了'
          );

          // IMPLEMENT タスクでも result_task_*.md を作成し
          // !review list / !review show から参照できるようにする
          // （executeReviewTask と同一フォーマット）
          try {
            const parsedResult = codex.parseCodexResult(codexApiResp);
            if (parsedResult) {
              const reviewsPath  = path.join(AI_WORKER_ROOT, 'reviews');
              const resultPath   = path.join(reviewsPath, `result_${taskId}.md`);
              const dangerEmoji  = { '高': '🔴', '中': '🟡', '低': '🟢' }[parsedResult.danger] || '⬜';
              fs.writeFileSync(resultPath, [
                `# Codex レビュー結果: ${taskId}`,
                ``,
                `| 項目 | 内容 |`,
                `|------|------|`,
                `| 作成日時 | ${new Date().toLocaleString('ja-JP')} |`,
                `| タスクID | ${taskId} |`,
                `| 危険度   | ${dangerEmoji} ${parsedResult.danger} |`,
                ``,
                `## 問題点`,
                ``,
                parsedResult.problem || '（なし）',
                ``,
                `## 改善案`,
                ``,
                parsedResult.suggestion || '（なし）',
                ``,
                `## フィードバック適用コマンド`,
                ``,
                `\`!apply-review ${taskId}\``,
              ].join('\n'), 'utf8');
              logger.info(`Codex 結果保存: reviews/result_${taskId}.md | 危険度: ${parsedResult.danger}`);
            }
          } catch (parseErr) {
            logger.warn(`result_task_*.md 保存失敗（続行）: ${parseErr.message}`);
          }
        }
      }

      const dangerColor = { '高': 0xFF3333, '中': 0xFFAA00, '低': 0x00CC66 }[codexRequest.danger] || 0x0099FF;
      await sendNotification('codexReview', message.channel,
        fmt.message(discordMsg, `codex_${taskId}.md`)
      );

      if (codexRequest.danger === '高' && DISCORD_OWNER_ID) {
        // Phase D-1: CEO 向けフォーマット（承認/却下/放置を明示）
        // split task (_s1/_s2/_s3) も executeClaudeTask を通るため同じパスで処理される。
        // title/detail 引数は recordHumanConfirm / createApproval の内部記録用。
        // Discord 表示は customMessage で上書きされる（旧フォーマットは表示されない）。
        // 注意: Bot が未再起動の場合は fmt.formatCodexHighDanger が undefined になる可能性あり。
        //       その場合は customMessage: undefined → 旧フォーマットがフォールバック表示される。
        //       → !restart コマンドで Bot を再起動してください。
        const codexCEOMsg = typeof fmt.formatCodexHighDanger === 'function'
          ? fmt.formatCodexHighDanger({
              taskId,
              codexFile: `reviews/codex_${taskId}.md`,
              danger:    '高',
              taskType:  String(taskType || ''),
            })
          : null; // 旧バージョンとの互換フォールバック（null → 旧フォーマット使用）
        await sendHumanMention(
          message.channel, taskId,
          'Codex 依頼の危険度が「高」です',       // recordHumanConfirm / createApproval 用
          `reviews/codex_${taskId}.md を確認してください。`, // 内部記録用（Discord 表示は customMessage）
          '高',
          {
            channelType:   'codexReview',
            customMessage: codexCEOMsg,
          }
        );
        logger.info(`[D-1] Codex高危険通知: ${taskId} | formatCodexHighDanger=${typeof fmt.formatCodexHighDanger === 'function' ? 'OK' : 'undefined(要再起動)'}`);
      }
    }

    // ═══════════════════════════════════════
    // STEP 4: Codex 自動フィードバック（Phase3・自動モード）
    // ═══════════════════════════════════════
    let autoFeedbackResult = null;

    if (ENABLE_AUTO_FEEDBACK && codexApiResp && review.verdict !== '却下推奨') {
      try {
        logger.info(`自動フィードバック適用中: ${taskId}`);
        autoFeedbackResult = await codexFeedback.applyFeedback(taskId);

        if (!autoFeedbackResult.skipped) {
          reviewHistory.addEntry(
            reviewHistory.EVENT_TYPES.FEEDBACK_APPLY,
            taskId,
            autoFeedbackResult.verdict === '修正推奨' ? '適用済み' : 'スキップ',
            `自動フィードバック: ${autoFeedbackResult.verdict}`,
            autoFeedbackResult.claudeResult?.output?.slice(0, 200)
          );
        }
      } catch (fbErr) {
        logger.error(`自動フィードバック失敗: ${fbErr.message}`);
      }
    }

    // ═══════════════════════════════════════
    // STEP 5: GitHub Push または PR 作成
    // ═══════════════════════════════════════
    let gitResult = null;
    let prResult  = null;

    if (review.verdict !== '却下推奨') {
      if (ENABLE_PR) {
        try {
          prResult = await githubPR.createPRWorkflow(
            prompt, taskId, review, autoFeedbackResult
          );

          if (!prResult.skipped) {
            reviewHistory.addEntry(
              reviewHistory.EVENT_TYPES.PR_CREATED, taskId, 'PR作成',
              `PR #${prResult.prNumber}: ${prResult.prTitle}`,
              `PR URL: ${prResult.prUrl}`
            );

            const prDanger = review.verdict === '修正推奨' ? '中' : '低';
            const prEmbed = new EmbedBuilder()
              .setColor(0x6F42C1)
              .setTitle(`🔗 PR #${prResult.prNumber} 作成完了 — マージは人間が行ってください`)
              .setURL(prResult.prUrl)
              .addFields(
                { name: 'タイトル', value: prResult.prTitle, inline: false },
                { name: 'ブランチ', value: `\`${prResult.featureBranch}\` → \`${prResult.baseBranch}\``, inline: false },
                { name: '🔗 PR URL', value: prResult.prUrl, inline: false },
                { name: '⚠️ 注意', value: '**自動マージは行いません。**GitHub で確認してからマージしてください。', inline: false },
              )
              .setTimestamp();

            await sendNotification('pr', message.channel, { embeds: [prEmbed] });
            await sendPRHumanConfirm(message.channel, taskId, prResult, prDanger);
          }
        } catch (prErr) {
          const { maskSecret } = require('./utils/github');
          logger.error(`PR 作成エラー: ${maskSecret(prErr.message)}`);
          await sendNotification('pr', message.channel, {
            embeds: [new EmbedBuilder()
              .setColor(0xFF3333)
              .setTitle('❌ PR 作成に失敗しました')
              .setDescription('詳細はログを確認してください')
              .setTimestamp()
            ],
          });
        }

      } else if (ENABLE_GITHUB) {
        try {
          gitResult = await github.commitAndPush(prompt, taskId);

          const gitColor = gitResult?.pushed ? 0x00CC66 : gitResult?.skipped ? 0x999999 : 0xFFAA00;
          const gitTitle = gitResult?.pushed ? '✅ GitHub Push 完了'
            : gitResult?.skipped ? '📭 GitHub: 変更なし'
            : '⚠️ コミット済み・Push 失敗';

          reviewHistory.addEntry(
            reviewHistory.EVENT_TYPES.GITHUB_PUSH, taskId,
            gitResult?.pushed ? 'Push済み' : 'スキップ',
            gitResult?.subject || gitResult?.reason || ''
          );

          const gitExplain = gitResult?.pushed
            ? 'AIが作成したコードをGitHubに保存（Push）しました。'
            : gitResult?.skipped
            ? '今回は変更がなかったため、GitHubへの保存はスキップしました。'
            : 'GitHubへの保存（Push）が完了しませんでした。コミットは作成されています。';
          await sendNotification('git', message.channel, {
            embeds: [new EmbedBuilder()
              .setColor(gitColor)
              .setTitle(gitTitle)
              .setDescription(gitExplain)
              .addFields(
                gitResult?.subject
                  ? { name: '保存した変更の概要', value: gitResult.subject }
                  : { name: 'スキップの理由', value: gitResult?.reason || '不明' }
              )
              .setTimestamp()
            ],
          });

          if (!gitResult?.pushed && gitResult?.pushError && DISCORD_OWNER_ID) {
            // Phase D-1: CEO 向けフォーマット（技術情報は下部に保持）
            const pushFailText = fmt.formatGitHubPushFailed({
              taskId,
              pushError: gitResult.pushError || '',  // maskSecret 済み
            });
            await sendNotification('git', message.channel, pushFailText.slice(0, 1900)).catch(() => {});
          }
        } catch (gitErr) {
          const { maskSecret } = require('./utils/github');
          // Secret Guardian 検出エラーは CEO 向けフォーマットで通知（値は表示しない）
          if (gitErr.secretViolations) {
            logger.error(`[SecretGuardian] commit 停止: ${gitErr.secretViolations.length}件`);
            const secretBlockText = fmt.formatGitHubPushFailed({
              taskId,
              pushError: '',
              isSecretBlock: true,
            });
            await sendNotification('error', message.channel, secretBlockText.slice(0, 1900)).catch(() => {});
            if (DISCORD_OWNER_ID) {
              await message.channel.send(
                `<@${DISCORD_OWNER_ID}>\n\n${secretBlockText.slice(0, 1800)}`
              ).catch(() => {});
            }
          } else {
            logger.error(`GitHub Push エラー: ${maskSecret(gitErr.message)}`);
          }
        }
      }
    }

    // ═══════════════════════════════════════
    // STEP 6: 次タスク担当判断
    // RESEARCH タスクは調査で完結するため次担当生成をスキップ
    // ═══════════════════════════════════════
    const isResearch = (taskType === 'RESEARCH');
    let nextDecision = null;
    if (!isResearch) {
      nextDecision = nextTask.decide(prompt, result.output, taskType);
      nextTask.saveFiles(taskId, prompt, result.output, nextDecision);
    }

    // ═══════════════════════════════════════
    // STEP 7: 完了通知（スマホ向けコンパクトフォーマット）
    // ═══════════════════════════════════════
    const reviewEmoji = { '問題なし': '🟢', '修正推奨': '🟡', '却下推奨': '🔴' }[review.verdict] || '⬜';
    const gitStatus = ENABLE_PR
      ? prResult?.prUrl ? `PR#${prResult.prNumber}` : 'PRなし'
      : ENABLE_GITHUB
      ? gitResult?.pushed ? 'Push済' : '未Push'
      : 'Git無効';
    const diffLabel = `diff:${validation.diffStat}`;
    const oneLiner = isResearch
      ? `${reviewEmoji}${review.verdict} | ⏱${result.duration}s | ${diffLabel} | 調査完了`
      : `${reviewEmoji}${review.verdict} | ⏱${result.duration}s | ${gitStatus} | ${diffLabel} | 次→${nextDecision.assignee}`;

    const statusFields = [
      { name: '📋 ID',      value: `\`${taskId}\``,              inline: true },
      { name: '🗂️ Project', value: projectId,                    inline: true },
      { name: '⏱️ 時間',   value: `${result.duration}秒`,        inline: true },
      { name: '🔍 レビュー', value: review.verdict,               inline: true },
      { name: '📁 変更',    value: `${taskChangedFiles.length}件 (${validation.diffStat})`, inline: true },
      { name: '📝 指示',    value: prompt.slice(0, 150),          inline: false },
      needsCodex
        ? { name: '🤖 Codex', value: `危険度: ${codexInfo?.danger}\n${fmt.formatSmartphoneCommand('次のコマンド:', `!apply-review ${taskId}`)}`, inline: false }
        : null,
      prResult?.prUrl
        ? { name: '🔗 PR',    value: prResult.prUrl,              inline: false }
        : null,
    ].filter(Boolean);

    const successEmbed = new EmbedBuilder()
      .setColor(0x00CC66)
      .setTitle(`✅ ${oneLiner}`)
      .addFields(statusFields)
      .setTimestamp()
      .setFooter({ text: `AI_WORKER | ${taskId}` });

    await processingMsg.edit({ content: '', embeds: [successEmbed] });

    // 全タスク履歴チャンネルへ完了サマリーを送信（初心者向け）
    if (HISTORY_CHANNEL_ID) {
      const historyEmoji = { '問題なし': '🟢', '修正推奨': '🟡', '却下推奨': '🔴' }[review.verdict] || '⬜';
      const historyLine =
        `✅ **タスク完了** | ${new Date().toLocaleString('ja-JP')}\n` +
        `タスクID: \`${taskId}\` | レビュー: ${historyEmoji}${review.verdict} | 実行時間: ${result.duration}秒\n` +
        `指示内容: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`;
      await sendNotification('history', message.channel, historyLine);
    }

    // RESEARCH: 次担当メッセージは送らない（調査で完結）
    if (!isResearch && nextDecision) {
      await sendNotification('history', message.channel,
        `💬 **${nextDecision.humanSummary}**\n\n` +
        `【次担当】 ${nextDecision.assignee}\n` +
        `【コピペ用依頼文】\n` +
        `\`\`\`\n${nextDecision.copyableMessage}\n\`\`\``
      );
    }

    // DONE: PR作成済みなら人間確認待ち、それ以外は完了
    // ※ 無条件DONEは禁止。completionValidator 通過後のみここに到達する
    if (ENABLE_PR && prResult && !prResult.skipped) {
      taskManager.updateState(taskId, taskManager.STATES.AWAITING, 'PR作成済み — マージ待ち');
      taskManager.updateTask(taskId, { prUrl: prResult.prUrl });
    } else {
      taskManager.updateState(taskId, taskManager.STATES.DONE, '完了');
    }

    logger.info(
      `タスク完了 | ID: ${taskId} | source:${source} | ${result.duration}秒 | ` +
      `レビュー:${review.verdict} | PR:${prResult?.prNumber || 'なし'} | ` +
      `次担当:${nextDecision?.assignee || '(RESEARCH)'}  | diff:${validation.diffStat}`
    );

    // ─── Phase B-2 / C-2: Auto Project Runner 完了フック ───────────
    // タスク完了後に runPlannerStep を呼ぶ（runner off 時は何もしない）
    // Phase C-2: completedTask を context として渡し REVIEW 候補を検出する。
    // まだ REVIEW タスクは登録しない（副作用なし）。
    try {
      // Phase C-2: 完了タスク情報を context に含める
      const completedTaskContext = {
        id:            taskId,
        type:          taskType,
        prompt:        prompt.slice(0, 200),
        resultSummary: result.output.slice(0, 150),
      };
      const runnerResult = await autoProjectRunner.runPlannerStepAsync(projectId, {
        completedTask: completedTaskContext,
      });

      if (runnerResult.action !== 'skip') {
        const plannerAct = runnerResult.plannerResult?.action || 'none';

        // ─── Phase C-4: REVIEW タスクを taskQueue に自動投入 ─────
        // nextExecutableTaskId が REVIEW type の場合のみ投入する。
        // FIX / IMPLEMENT 等は投入しない。
        let autoQueuedReviewId = null;
        if (runnerResult.nextExecutableTaskId) {
          try {
            const nextTask     = taskManager.getTask(runnerResult.nextExecutableTaskId);
            const runnerState2 = autoProjectRunner.getRunnerState(projectId);
            const alreadyQueued = taskQueue.getStatus().pendingIds.includes(runnerResult.nextExecutableTaskId);

            if (nextTask &&
                nextTask.type === taskManager.TASK_TYPES.REVIEW &&
                nextTask.state === taskManager.STATES.PENDING &&
                runnerState2.enabled &&
                !alreadyQueued) {

              // REVIEW タスクは executeReviewTask() で処理する
              const reviewProjectId = nextTask.projectId || projectId;
              taskQueue.enqueue(nextTask.id, async () => {
                await executeReviewTask({ message, task: nextTask, projectId: reviewProjectId });
              });
              autoQueuedReviewId = nextTask.id;

              await message.channel.send(
                `🤖 **Auto Project Runner**\n` +
                `REVIEWタスクを自動キュー投入しました。\n` +
                `Task:\n\`\`\`\n${nextTask.id}\n\`\`\``
              ).catch(() => {});

              logger.info(`[AutoRunner] C-4: REVIEW 自動キュー投入 | ${nextTask.id} | ${projectId}`);
            }
          } catch (queueErr) {
            logger.warn(`[AutoRunner] C-4 キュー投入エラー: ${queueErr.message}`);
          }
        }

        // 通知（キュー投入済みの場合は重複しない）
        if (!autoQueuedReviewId) {
          let nextLine;
          if (plannerAct === 'create_task') {
            const suggested = runnerResult.plannerResult?.suggestedTask;
            nextLine =
              `Planner: ${suggested?.type || 'task'} 登録済み\n` +
              `\`!auto run 1\` で実行できます`;
          } else if (runnerResult.action === 'stopped') {
            nextLine = `⛔ 上限到達 → Runner停止\n\`\`\`\n!project runner reset\n!project runner on\n\`\`\``;
          } else {
            nextLine = `Planner: ${plannerAct}`;
          }
          const notifyMsg =
            `🤖 **Auto Project Runner**\n` +
            `Project: \`${projectId}\`\n` +
            `Loop: ${runnerResult.loopCount}/10\n` +
            nextLine;
          await message.channel.send(notifyMsg).catch(() => {});
        }

        logger.info(`[AutoRunner] C-4フック: ${projectId} | planner:${plannerAct} | loop:${runnerResult.loopCount}`);
      }
    } catch (runnerErr) {
      logger.warn(`[AutoRunner] runPlannerStepAsync エラー: ${runnerErr.message}`);
    }

  } catch (error) {
    logger.error(`タスク失敗 | ID: ${taskId} | source:${source} | ${error.message}`);
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.ERROR, taskId, 'エラー',
      error.message.slice(0, 80)
    );

    // Phase E-4: Secret マスク後に lastError / errorType をタスクに保存
    const { maskSecret } = require('./utils/github');
    const maskedErrMsg = maskSecret(error.message);
    const errorType    = taskManager.classifyErrorType(maskedErrMsg);
    taskManager.setTaskError(taskId, maskedErrMsg); // setTaskError内でも maskSecret するが念のため渡す
    logger.info(`[E-4] errorType: ${errorType} | ${taskId}`);

    // Phase E-5a: 失敗時に lease を解除する（IN_PROGRESS のまま固着を防ぐ）
    // ON_HOLD に遷移させて leaseOwner / leaseExpiresAt をクリアする
    try {
      const failTask = taskManager.getTask(taskId);
      if (failTask && failTask.state === taskManager.STATES.IN_PROGRESS) {
        taskManager.updateState(taskId, taskManager.STATES.ON_HOLD, `失敗: ${errorType}`);
        logger.info(`[Lease] 失敗による lease 解除: ${taskId} → ON_HOLD`);
      }
    } catch { /* lease 解除失敗は元処理を壊さない */ }

    try {
      fs.writeFileSync(
        path.join(taskWorkspace, 'error.md'),
        // error.md にも maskSecret 済みメッセージを使用
        `# エラー: ${taskId}\n\n- 発生日時: ${new Date().toLocaleString('ja-JP')}\n- errorType: ${errorType}\n\n## エラー内容\n${maskedErrMsg}\n`,
        'utf8'
      );
    } catch { /* ignore */ }

    // Phase D-1: CEO 向けエラー通知（技術詳細は下部に保持）
    const errorCeoText = fmt.formatTaskError({
      taskId,
      errorType,
      maskedErrMsg,
      taskType: String(source || ''),
    });

    try {
      if (processingMsg) await processingMsg.edit(errorCeoText.slice(0, 1900)).catch(() => {});
      else await message.channel.send(errorCeoText.slice(0, 1900)).catch(() => {});
    } catch { /* ignore */ }

    // エラー通知チャンネルへも同じ CEO 向けフォーマットで送信
    if (ERROR_CHANNEL_ID) {
      await sendNotification('error', message.channel, errorCeoText.slice(0, 1900)).catch(() => {});
    }

    // 全タスク履歴チャンネルへエラー記録を送信
    if (HISTORY_CHANNEL_ID) {
      const errorHistoryLine =
        `❌ **タスクエラー** | ${new Date().toLocaleString('ja-JP')}\n` +
        `タスクID: \`${taskId}\` | エラー: ${error.message.slice(0, 100)}`;
      await sendNotification('history', message.channel, errorHistoryLine);
    }

    if (DISCORD_OWNER_ID && /permission|denied|unauthorized|database|credential/i.test(error.message)) {
      await sendHumanMention(
        message.channel, taskId,
        'Bot 実行中に重大なエラーが発生しました',
        error.message.slice(0, 300),
        '高',
        { channelType: 'error' }
      );
    }
  }
}

// ─────────────────────────────────────────────────────
// prepareNextTask — !run-next / !auto run 共通の次タスク準備ヘルパー
//
// 未着手タスクを1件選択し、安全チェック（セキュリティ・危険度・サイズ）
// を行ってタスク実行に必要な情報を返す。
// ブロック時は message.reply() でエラーを返し { blocked: true } を返す。
// タスクなし時は null を返す（呼び出し元でメッセージを出す）。
//
// 戻り値:
//   null                           — 未着手タスクなし
//   { blocked: true }              — セキュリティ/危険度/サイズで拒否済み
//   { task, prompt, taskType, taskSizeResult, projectId, taskWorkspace }
// ─────────────────────────────────────────────────────
async function prepareNextTask(message, source = 'run-next') {
  const currentPid = projectManager.getCurrentProject(message.channelId);

  // Phase E-5a: claimNextTask で原子的に PENDING → IN_PROGRESS へ移行する。
  // 既存の find() + 個別 updateState() の代わりにこれを使う。
  // 後方互換: leaseOwner のない既存タスクも正常に処理される。
  const next = taskManager.claimNextTask(currentPid, source);
  if (!next) return null;

  const prompt = next.prompt || '';

  // ─── セキュリティチェック ───
  const sec = security.checkPrompt(prompt);
  if (!sec.safe) {
    logger.warn(`${source} セキュリティブロック: ${next.id} | ${sec.reason}`);
    taskManager.releaseLease(next.id); // claim を解除して PENDING に戻す
    await message.reply(
      `🚫 **セキュリティチェックで拒否**\n\n` +
      `タスク \`${next.id}\` をスキップします。\n理由: ${sec.reason}`
    ).catch(() => {});
    return { blocked: true };
  }

  // ─── TaskType / TaskSize 判定 ───
  // task.type が保存されていれば優先して使う（DOCS/REVIEW/RESEARCH等を上書きしない）
  // ※ assessDanger より先に taskType を確定させる（非変更系タイプの誤ブロック防止）
  const taskType       = next.type || taskTypeUtil.detectTaskType(prompt);

  // ─── autoPolicy で実行可否を判定（assessDanger による独自再計算を廃止）───
  // assessDanger はプロンプト文字列だけを見るため AUTH/credential 等のキーワードを
  // 含む無害なタスク（例: "errorType=AUTH のハンドリング修正"）を誤ってブロックしていた。
  // autoPolicy.classifyTask は保存済み dangerLevel・type・size を総合判断するため信頼性が高い。
  // BLOCKED / HUMAN_APPROVAL_REQUIRED のみ停止。AI_REVIEW_REQUIRED は自動実行可（レビュー付き）。
  const prePolicy = autoPolicy.classifyTask(next, { danger: next.dangerLevel || '低' });
  if (prePolicy === autoPolicy.AUTO_POLICY.BLOCKED ||
      prePolicy === autoPolicy.AUTO_POLICY.HUMAN_APPROVAL_REQUIRED) {
    taskManager.releaseLease(next.id); // claim を解除
    const policyLabel = prePolicy === autoPolicy.AUTO_POLICY.BLOCKED
      ? '🚫 BLOCKED'
      : '⚠️ 人間確認が必要 (HUMAN_APPROVAL_REQUIRED)';
    await message.reply(
      `${policyLabel}\n\n` +
      `タスク: \`${next.id}\`\n\n` +
      `このタスクは自動実行できません。\`!claude\` から直接実行し、承認フロー（\`!approve\`）を経てください。`
    ).catch(() => {});
    return { blocked: true };
  }
  const taskSizeResult = taskTypeUtil.estimateTaskSize(prompt);

  if (taskSizeResult.size === taskTypeUtil.TASK_SIZES.LARGE) {
    taskManager.releaseLease(next.id); // claim を解除
    const splitMsg = taskTypeUtil.buildSplitSuggestion(prompt, taskSizeResult);
    await message.reply(
      `⚠️ **タスクが大きすぎます**\n\nタスク: \`${next.id}\`\n\n` + splitMsg
    ).catch(() => {});
    return { blocked: true };
  }

  // ─── projectId / workspace 解決 ───
  const projectId     = next.projectId
    || projectDetector.detectProjectId(message.channel)
    || 'default';
  const taskWorkspace = path.join(WORKSPACE_PATH, projectId, next.id);

  return { task: next, prompt, taskType, taskSizeResult, projectId, taskWorkspace };
}

// ─────────────────────────────────────────────────────
// executeReviewTask — REVIEW タスクを Codex へ転送する
//
// task.type === REVIEW の場合、Claude Code を実行せず
// Codex レビュー依頼を生成して #codex-review へ通知する。
//
// フロー:
//   1. タスクを IN_PROGRESS に更新
//   2. Codex 用依頼文を生成（元プロンプト全文を保存）
//   3. OPENAI_API_KEY が設定されていれば API を呼び出す
//   4. reviews/codex_<id>.md に保存
//   5. #codex-review へ通知
//   6. タスクを DONE（アーカイブ）にする
//
// 引数:
//   message   - Discord メッセージオブジェクト
//   task      - タスクオブジェクト（task.id / task.prompt）
//   projectId - プロジェクトID
// ─────────────────────────────────────────────────────
async function executeReviewTask({ message, task, projectId }) {
  const taskId = task.id;
  const prompt = task.prompt;

  logger.info(`[AUTO] REVIEW task routed to Codex: ${taskId}`);

  taskManager.updateState(taskId, taskManager.STATES.IN_PROGRESS, 'REVIEWタスク: Codex転送開始');

  // Codex 依頼文を生成（Claude Code 実行なし・output は空）
  const codexRequest = codex.generateCodexRequest(taskId, prompt, '', []);
  const discordMsg   = codex.generateDiscordMessage(taskId, codexRequest);
  codex.saveReview(taskId, { ...codexRequest, discordMessage: discordMsg });

  // API 呼び出し（OPENAI_API_KEY が設定されていれば）
  let apiResult = null;
  let parsed    = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      apiResult = await codex.callCodexAPI(prompt, '');
      if (apiResult) {
        codex.saveCodexResponse(taskId, apiResult);
        parsed = codex.parseCodexResult(apiResult);
        logger.info(`[AUTO] REVIEW Codex API回答取得: ${taskId} | 危険度: ${parsed.danger}`);
      }
    } catch (e) {
      logger.error(`[AUTO] REVIEW Codex API失敗: ${e.message}`);
    }
  }

  // ─ Codex 結果がある場合: reviews/result_<id>.md に保存 ─
  if (parsed) {
    const reviewsPath = path.join(AI_WORKER_ROOT, 'reviews');
    const resultPath  = path.join(reviewsPath, `result_${taskId}.md`);
    const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[parsed.danger] || '⬜';
    fs.writeFileSync(resultPath, [
      `# Codex レビュー結果: ${taskId}`,
      ``,
      `| 項目 | 内容 |`,
      `|------|------|`,
      `| 作成日時 | ${new Date().toLocaleString('ja-JP')} |`,
      `| タスクID | ${taskId} |`,
      `| 危険度   | ${dangerEmoji} ${parsed.danger} |`,
      ``,
      `## 問題点`,
      ``,
      parsed.problem || '（なし）',
      ``,
      `## 改善案`,
      ``,
      parsed.suggestion || '（なし）',
      ``,
      `## フィードバック適用コマンド`,
      ``,
      `\`!apply-review ${taskId}\``,
    ].join('\n'), 'utf8');
    logger.info(`[AUTO] REVIEW 結果保存: reviews/result_${taskId}.md | 危険度: ${parsed.danger}`);
  }

  // ─ 危険度が高/中の場合: FIX タスクを自動生成（Claude↔Codex相互レビュー）─
  let fixTaskResult = null;
  if (parsed) {
    const resultContent = [
      `| 危険度 | ${parsed.danger} |`,
      `## 問題点`, parsed.problem || '',
    ].join('\n');
    fixTaskResult = taskManager.createFixTaskFromReview(
      resultContent, taskId, task.requestedBy || '', projectId
    );
    if (fixTaskResult) {
      logger.info(`[REVIEW] FIXタスク生成済み: ${fixTaskResult.task.id}`);
    }
  }

  // タスクを DONE にする（アーカイブ）
  taskManager.updateState(taskId, taskManager.STATES.DONE, 'REVIEWタスク: Codex転送完了');

  // ─ #codex-review へ通知 ─
  const dangerLabel = parsed?.danger || '未評価';
  const dangerEmoji2 = { '高': '🔴', '中': '🟡', '低': '🟢' }[dangerLabel] || '⬜';
  const fixNotice = fixTaskResult
    ? `\n🔧 FIX タスク自動生成: \`${fixTaskResult.task.id}\``
    : '';
  const reviewNotice = apiResult && parsed
    ? `👀 **REVIEW → Codex 結果あり** | \`${taskId}\`\n` +
      `${dangerEmoji2} 危険度: ${dangerLabel}\n` +
      `📄 \`reviews/result_${taskId}.md\`\n` +
      `✅ \`!apply-review ${taskId}\` でフィードバック適用` + fixNotice
    : `👀 **REVIEW タスク → Codex 転送** | \`${taskId}\`\n` +
      `📄 \`reviews/codex_${taskId}.md\` を確認してください。\n` +
      `⭕ API 未設定 — 手動レビューをお願いします`;
  await sendNotification('codexReview', message.channel, reviewNotice);

  // ─ コマンドチャンネルに詳細表示 ─
  let channelMsg;
  if (apiResult && parsed) {
    channelMsg =
      `👀 **REVIEWタスク完了 — Codex 結果あり**\n\n` +
      `タスク: \`${taskId}\`\n\n` +
      `${dangerEmoji2} **危険度: ${parsed.danger}**\n\n` +
      `**【問題点】**\n${(parsed.problem  || 'なし').slice(0, 150)}\n\n` +
      `**【改善案】**\n${(parsed.suggestion || 'なし').slice(0, 150)}\n\n` +
      `📄 \`reviews/result_${taskId}.md\`\n` +
      `✅ フィードバック適用: \`!apply-review ${taskId}\`` +
      (fixTaskResult
        ? `\n\n🔧 **FIX タスク自動生成済み**\nID: \`${fixTaskResult.task.id}\`\ntype: FIX / priority: 高\n\`!next\` で確認できます。`
        : '');
  } else {
    channelMsg =
      `👀 **REVIEWタスク完了**\n\n` +
      `タスク: \`${taskId}\`\n\n` +
      `Codex レビュー依頼を生成しました。\n` +
      `📄 \`reviews/codex_${taskId}.md\`\n\n` +
      `⭕ API キー未設定のため手動レビューが必要です。\n` +
      `レビュー後: \`!apply-review ${taskId}\``;
  }
  await message.channel.send(channelMsg).catch(() => {});

  // ─── Phase B-7b: Auto Project Runner — REVIEW完了フック ──────────
  // Codex 結果を context として runPlannerStep() に渡し、
  // FIX タスクが作成された場合のみキュー投入する。
  // runner off / FIX 以外 / ループ上限超過 / キュー混雑 の場合は投入しない。
  if (parsed) {
    try {
      const runnerState0 = autoProjectRunner.getRunnerState(projectId);
      if (runnerState0.enabled) {
        const runnerResult = await autoProjectRunner.runPlannerStepAsync(projectId, { reviewResult: parsed });

        if (runnerResult.nextExecutableTaskId) {
          const nextTask     = taskManager.getTask(runnerResult.nextExecutableTaskId);
          const runnerState2 = autoProjectRunner.getRunnerState(projectId);
          const queueStatus  = taskQueue.getStatus();
          const alreadyQueued = queueStatus.pendingIds.includes(runnerResult.nextExecutableTaskId);

          if (nextTask &&
              nextTask.type === taskManager.TASK_TYPES.FIX &&
              nextTask.state === taskManager.STATES.PENDING &&
              runnerState2.enabled &&
              !alreadyQueued) {

            const execParams = buildExecuteParamsFromTask(nextTask, message, projectId);
            taskQueue.enqueue(nextTask.id, () => executeClaudeTask({ ...execParams, source: 'auto-runner' }));

            await message.channel.send(
              `🤖 **Auto Project Runner**\n` +
              `FIXタスクを自動キュー投入しました。\n` +
              `Task:\n\`\`\`\n${nextTask.id}\n\`\`\``
            ).catch(() => {});

            logger.info(`[AutoRunner] B-7b: FIX 自動キュー投入 | ${nextTask.id} | ${projectId}`);
          }
        }
      }
    } catch (runnerErr) {
      // フックのエラーはREVIEW完了処理を壊さない
      logger.warn(`[AutoRunner] B-7b フック エラー: ${runnerErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────
// executeResearchTask — RESEARCH タスクを調査専用モードで実行する
//
// task.type === RESEARCH の場合、
// ファイル変更禁止 Type Guard を付与して Claude Code を実行し、
// 調査結果を reports/research_<id>.md に保存する。
// AI レビュー / Codex レビュー / PR 作成はスキップする。
//
// 引数:
//   message   - Discord メッセージオブジェクト
//   task      - タスクオブジェクト（task.id / task.prompt）
//   projectId - プロジェクトID
// ─────────────────────────────────────────────────────
async function executeResearchTask({ message, task, projectId }) {
  const taskId = task.id;
  const prompt = task.prompt;

  logger.info(`[AUTO] RESEARCH task routed to research mode: ${taskId}`);

  taskManager.updateState(taskId, taskManager.STATES.IN_PROGRESS, 'RESEARCHタスク: 調査開始');

  // ─ ワークスペース作成 + prompt.md 保存 ─
  const taskWorkspace = path.join(WORKSPACE_PATH, projectId, taskId);
  fs.mkdirSync(taskWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(taskWorkspace, 'prompt.md'),
    `# 調査タスク: ${taskId}\n\n` +
    `- **日時:** ${new Date().toLocaleString('ja-JP')}\n` +
    `- **依頼者:** ${message.author.tag}\n` +
    `- **Project:** ${projectId}\n\n## 指示内容\n${prompt}\n`,
    'utf8'
  );

  // ─ Claude Code を調査専用プロンプトで実行 ─
  const typeGuard      = taskManager.buildTypeGuard(taskManager.TASK_TYPES.RESEARCH);
  const researchPrompt = prompt + typeGuard;

  let resultOutput = '';
  let duration     = 0;
  try {
    const result = await claudeRunner.run(researchPrompt, taskWorkspace, AI_WORKER_ROOT);
    resultOutput = result.output;
    duration     = result.duration;

    // result.md を保存
    fs.writeFileSync(
      path.join(taskWorkspace, 'result.md'),
      `# 調査結果: ${taskId}\n\n` +
      `- **完了日時:** ${new Date().toLocaleString('ja-JP')}\n` +
      `- **実行時間:** ${duration}秒\n\n## 調査結果\n${resultOutput}\n`,
      'utf8'
    );
  } catch (e) {
    logger.error(`[AUTO] RESEARCH 実行失敗: ${taskId} | ${e.message}`);
    taskManager.updateState(taskId, taskManager.STATES.ON_HOLD,
      `RESEARCHタスク失敗: ${e.message.slice(0, 50)}`
    );
    await message.channel.send(
      `❌ **調査タスク失敗**\n\nタスク: \`${taskId}\`\n\n${_classifyDiscordError(e.message)}`
    ).catch(() => {});
    return;
  }

  // ─ reports/research_<id>.md に調査レポートを保存 ─
  const reportsDir  = path.join(AI_WORKER_ROOT, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath  = path.join(reportsDir, `research_${taskId}.md`);
  fs.writeFileSync(reportPath, [
    `# 調査レポート: ${taskId}`,
    ``,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| 作成日時 | ${new Date().toLocaleString('ja-JP')} |`,
    `| プロジェクト | ${projectId} |`,
    `| 実行時間 | ${duration}秒 |`,
    `| タスクID | ${taskId} |`,
    ``,
    `## 依頼内容`,
    ``,
    prompt,
    ``,
    `## 調査結果`,
    ``,
    resultOutput || '（出力なし）',
  ].join('\n'), 'utf8');
  logger.info(`[AUTO] RESEARCH レポート保存: reports/research_${taskId}.md`);

  // ─ タスクを DONE にする（アーカイブ） ─
  taskManager.updateState(taskId, taskManager.STATES.DONE, 'RESEARCHタスク: 調査完了');

  // ─ Discord に完了通知 ─
  await message.channel.send(
    `🔍 **RESEARCH タスク完了**\n\n` +
    `タスク: \`${taskId}\`\n\n` +
    `調査レポートを保存しました。\n` +
    `📄 \`reports/research_${taskId}.md\`\n\n` +
    (resultOutput
      ? `**結果（先頭200文字）:**\n${resultOutput.slice(0, 200)}${resultOutput.length > 200 ? '...' : ''}`
      : '（出力なし）')
  ).catch(() => {});

  // ─ Auto Project Runner フック ─
  // RESEARCH 完了後も runPlannerStepAsync() を呼び、
  // LLM Planner が次の候補（IMPLEMENT 等）を判断できるようにする。
  // runner off / エラー時は RESEARCH 完了処理を壊さない。
  try {
    const runnerState = autoProjectRunner.getRunnerState(projectId);
    if (runnerState.enabled) {
      const completedTaskCtx = {
        id:            taskId,
        type:          'RESEARCH',
        prompt:        prompt.slice(0, 200),
        resultSummary: resultOutput.slice(0, 150),
      };
      const runnerResult = await autoProjectRunner.runPlannerStepAsync(projectId, {
        completedTask: completedTaskCtx,
      });
      if (runnerResult.action !== 'skip') {
        await message.channel.send(runnerResult.summary).catch(() => {});
        logger.info(`[AutoRunner] RESEARCH 完了フック: ${projectId} | ${runnerResult.action} | loop:${runnerResult.loopCount}`);
      }
    }
  } catch (runnerErr) {
    logger.warn(`[AutoRunner] RESEARCH 完了フック エラー: ${runnerErr.message}`);
  }
}

// ─────────────────────────────────────────────────────
// !run-next コマンド — 最優先の未着手タスクを安全実行
//
// prepareNextTask() で安全チェックを行い
// executeClaudeTask() を通じて完全フローを実行する。
// ─────────────────────────────────────────────────────
async function handleRunNext(message) {
  // ── [DIAG-3] handleRunNext 到達ログ ──
  logger.info(`[DIAG-3] handleRunNext reached | ch:${message.channelId} | author:${message.author.id}`);

  const prepared = await prepareNextTask(message, 'run-next');

  if (!prepared) {
    await message.reply('📋 **!run-next**\n\n実行可能な未着手タスクはありません。\n`!task cleanup` で孤立タスクを整理できます。');
    return;
  }
  if (prepared.blocked) return;

  const { task: next, prompt, taskType, taskSizeResult, projectId, taskWorkspace } = prepared;

  await message.reply(
    `▶️ **!run-next: 通常フローで実行開始**\n\n` +
    `タスク: \`${next.id}\`\n` +
    `指示: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\n\n` +
    `completionValidator・AIレビュー・Codex を通常通り実行します。`
  ).catch(() => {});

  const runNextExecuteTask = async () => executeClaudeTask({
    message, prompt, taskId: next.id, projectId, taskType, taskSizeResult,
    taskWorkspace, refTaskId: null, source: 'run-next',
  });

  const queuePos = taskQueue.enqueue(next.id, runNextExecuteTask);
  if (queuePos > 0) {
    await message.reply(
      `📋 **キューに追加しました（待機 ${queuePos} 番目）**\n` +
      `\`${next.id}\` は ${taskQueue.activeCount} 件の処理完了後に自動実行されます。\n` +
      `\`!queue\` でキュー状況を確認できます。`
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────
// enqueueAndWait — taskQueue 経由でタスクを実行し完了を待つ
//
// handleAutoOn() の順次実行に使用。
// キューの concurrency 制限を尊重しつつ完了まで await できる。
// ─────────────────────────────────────────────────────
function enqueueAndWait(taskId, execute) {
  return new Promise((resolve) => {
    taskQueue.enqueue(taskId, async () => {
      await execute();
      resolve(); // execute 完了時に呼び出し元の await を解除
    });
  });
}

// ─────────────────────────────────────────────────────
// handleAutoTimeoutSplit — Auto Split 共通ロジック (Phase E-3)
//
// handleAutoOn() と handleAutoRun() の両方で使用する。
// IN_PROGRESS のまま残ったタスクを判定し、必要なら autoSplitOnTimeout() を呼ぶ。
//
// 対象条件:
//   - task.state === IN_PROGRESS
//   - type: IMPLEMENT / FIX / REFACTOR / TEST
//   - policy: AUTO_SAFE または AI_REVIEW_REQUIRED
//   - BLOCKED / HUMAN_APPROVAL_REQUIRED はsplitしない
//
// 引数:
//   message      - Discord message オブジェクト
//   task         - 完了後に確認するタスクオブジェクト
//   contextLabel - ログ識別用ラベル（'AUTO-ON' / 'AUTO-RUN' 等）
//
// 戻り値:
//   'split_ok'      - 分割成功（handleAutoOn では continue）
//   'timeout_limit' - 2回目タイムアウト（handleAutoOn では break）
//   'no_split'      - 対象外 or 分割不可（通常停止へフォールスルー）
// ─────────────────────────────────────────────────────
const AUTO_SPLIT_TASK_TYPES = new Set(['IMPLEMENT', 'FIX', 'REFACTOR', 'TEST']);

async function handleAutoTimeoutSplit({ message, task, contextLabel = 'AUTO' }) {
  if (!task) return 'no_split';
  // executeClaudeTask の catch ブロックが TIMEOUT 時に IN_PROGRESS→ON_HOLD へ遷移させるため、
  // task.state だけでは TIMEOUT を検出できない。
  // errorType='TIMEOUT' かつ state=ON_HOLD の場合も Auto Split 対象とする。
  // 通常の ON_HOLD（ユーザー保留・他エラー）は errorType が TIMEOUT でないため対象外のまま。
  const isTimeoutOnHold =
    task.errorType === 'TIMEOUT' &&
    task.state === taskManager.STATES.ON_HOLD;
  if (!isTimeoutOnHold && task.state !== taskManager.STATES.IN_PROGRESS) {
    return 'no_split';
  }

  const splitPolicy = autoPolicy.classifyTask(task, {});
  const canAttemptSplit =
    AUTO_SPLIT_TASK_TYPES.has(String(task.type || '').toUpperCase()) &&
    (splitPolicy === autoPolicy.AUTO_POLICY.AUTO_SAFE ||
     splitPolicy === autoPolicy.AUTO_POLICY.AI_REVIEW_REQUIRED);

  if (!canAttemptSplit) {
    logger.info(`[${contextLabel}] Auto Split スキップ: policy=${splitPolicy} type=${task.type}`);
    return 'no_split';
  }

  const splitResult = taskManager.autoSplitOnTimeout(task.id);

  if (splitResult.ok) {
    logger.info(`[${contextLabel}] Auto Split: ${task.id} → ${splitResult.newTasks.length}件`);
    await message.channel.send(
      `⏱️ **タイムアウト → Auto Split**\n` +
      `タスク: \`${task.id}\` [${task.type}]\n` +
      `→ ${splitResult.newTasks.length}件の小タスクに分割して続行します。\n` +
      splitResult.newTasks.map(t =>
        `\`${t.id}\`: ${(t.prompt || '').slice(0, 45)}`
      ).join('\n')
    ).catch(() => {});
    return 'split_ok';
  }

  if (splitResult.reason === 'timeout_limit') {
    logger.warn(`[${contextLabel}] timeout_limit: ${task.id}`);
    await message.channel.send(
      `🛑 **タイムアウト2回目 → 人間確認が必要**\n` +
      `タスク: \`${task.id}\` [${task.type}]\n` +
      `同一タスク系統で2回タイムアウトしました。内容を確認してください。`
    ).catch(() => {});
    return 'timeout_limit';
  }

  // unsplittable / unsplittable_type 等 → 通常停止へ
  logger.info(`[${contextLabel}] Auto Split 不可: ${splitResult.reason} | ${task.id}`);
  return 'no_split';
}

// ─────────────────────────────────────────────────────
// !auto on — Auto Task Runner Phase E-1（最大 AUTO_MAX_TASKS 件を順次自動実行）
//
// prepareNextTask() / executeClaudeTask() / enqueueAndWait を再利用。
// auto-policy.js で判定し、BLOCKED/HUMAN_APPROVAL_REQUIRED のみ停止。
// AUTO_SAFE / AI_REVIEW_REQUIRED は自動継続する。
//
// 停止条件 (Phase E-1):
//   ・未着手タスクなし
//   ・policy=BLOCKED（LARGE / force push / rm -rf 等）
//   ・policy=HUMAN_APPROVAL_REQUIRED（danger高 / 却下推奨 / .env変更 等）
//   ・実行後に AWAITING（人間確認待ち）または REVIEWING（バリデーション未通過）
//   ・実行エラー（予期しない状態）
//   ・最大 AUTO_MAX_TASKS 件到達（暴走防止）
//
// 自動継続条件:
//   ・policy=AUTO_SAFE（DOCS / RESEARCH / TEST / REVIEW / codex低 等）
//   ・policy=AI_REVIEW_REQUIRED（IMPLEMENT / FIX / REFACTOR / codex中 等）
// ─────────────────────────────────────────────────────
const AUTO_MAX_TASKS = 50; // Phase E-1: 暴走防止の上限（BLOCKED/HUMAN 判定で実際に停止）

async function handleAutoOn(message) {
  // キューが使用中なら拒否
  if (taskQueue.activeCount > 0 || taskQueue.pendingCount > 0) {
    await message.reply(
      `⚠️ **タスクが実行中または待機中です**\n\n` +
      `\`!queue\` でキュー状況を確認し、空になったら再度実行してください。`
    );
    return;
  }

  logger.info(`[AUTO-ON] 開始 | ch:${message.channelId} | max:${AUTO_MAX_TASKS}`);

  await message.reply(
    `▶ **Auto Task Runner 開始 (Phase E-1)**\n\n` +
    `最大 **${AUTO_MAX_TASKS}件** を順番に自動実行します。\n` +
    `✅ AUTO_SAFE / AI_REVIEW_REQUIRED → 自動継続\n` +
    `🚫 BLOCKED / HUMAN_APPROVAL_REQUIRED → 停止`
  ).catch(() => {});

  let succeeded  = 0;
  let failed     = 0;
  let stopReason = '';

  for (let i = 0; i < AUTO_MAX_TASKS; i++) {
    // ─ ① 次タスク準備（安全チェック込み）─
    const prepared = await prepareNextTask(message, 'auto-on');

    if (!prepared) {
      // ─ Phase E-2: Auto Resume ─────────────────────────────────
      // PENDING=0 のとき、安全な保留タスクを自動的に PENDING に戻して続行する。
      //
      // 順序:
      //   1. project_done でないことを確認（project_done なら停止）
      //   2. getResumeCandidates() で候補を取得
      //   3. 候補があれば最上位1件を PENDING に戻してループ継続
      //   4. 候補がなければ停止

      const currentPidAR = projectManager.getCurrentProject(message.channelId);
      const runnerStateAR = autoProjectRunner.getRunnerState(currentPidAR);

      // runner が有効でない場合は通常停止
      if (!runnerStateAR.enabled) {
        stopReason = '未着手タスクなし';
        break;
      }

      // project_done チェック（active タスクが 0 件 = 完了状態）
      const activeTasks = taskManager.listTasks().filter(t =>
        t.projectId === currentPidAR &&
        (t.state === taskManager.STATES.PENDING || t.state === taskManager.STATES.IN_PROGRESS)
      );
      if (activeTasks.length === 0) {
        // Auto Resume 候補があれば project_done にはしない
        const resumeCandidates = autoProjectRunner.getResumeCandidates(currentPidAR, { maxCount: 1 });
        if (resumeCandidates.length === 0) {
          stopReason = '未着手タスクなし（Resume候補もなし）';
          logger.info(`[AUTO-ON] Auto Resume 候補なし → 停止 | ${currentPidAR}`);
          break;
        }

        // 最上位1件を PENDING に戻す
        const toResume = resumeCandidates[0];
        taskManager.updateState(toResume.id, taskManager.STATES.PENDING, 'auto-resume');
        logger.info(`[AUTO-ON] Auto Resume: ${toResume.id} [${toResume.type}] | ${currentPidAR}`);
        await message.channel.send(
          `♻️ **Auto Resume** | \`${currentPidAR}\`\n` +
          `タスク \`${toResume.id}\` [${toResume.type}] を保留から復帰しました。\n` +
          `${(toResume.prompt || '').slice(0, 60)}${(toResume.prompt || '').length > 60 ? '...' : ''}`
        ).catch(() => {});
        continue; // ループ先頭に戻り prepareNextTask() で拾う
      }

      stopReason = '未着手タスクなし';
      break;
    }
    if (prepared.blocked) {
      // prepareNextTask が既にエラーメッセージを送信済み
      stopReason = '安全チェック（高危険度・サイズ超過等）';
      break;
    }

    const { task: next, prompt, taskType, taskSizeResult, projectId, taskWorkspace } = prepared;

    // ─ task.type / task.size 取得（後方互換: 未設定は IMPLEMENT / MEDIUM）─
    const storedType  = next.type || taskManager.TASK_TYPES.IMPLEMENT;
    const storedSize  = next.size || taskManager.TASK_SIZES.MEDIUM;
    const typeEmoji   = taskManager.TYPE_EMOJI[storedType]  || '📋';
    const sizeEmoji   = taskManager.SIZE_EMOJI[storedSize]  || '🟡';

    // ─ Phase E-1: Auto Policy 判定（実行前・事前チェック）─
    // コンテキスト: この時点では Codex/AIレビュー結果はまだないため
    // タスク属性（type / size / prompt）のみで判定する。
    const prePolicy = autoPolicy.classifyTask(next, {
      // prepareNextTask() が security.js / danger チェック済みなので securityBlocked は渡さない
    });
    logger.info(`[AUTO] Policy: ${prePolicy} | ${next.id} [${storedType}/${storedSize}]`);

    if (prePolicy === autoPolicy.AUTO_POLICY.BLOCKED) {
      const isLarge = storedSize === taskManager.TASK_SIZES.LARGE;
      logger.warn(`[AUTO-ON] BLOCKED: ${next.id} | type:${storedType} size:${storedSize}`);
      await message.channel.send(
        `🚫 **[${i + 1}/${AUTO_MAX_TASKS}] 自動実行ブロック (BLOCKED)**\n\n` +
        `タスク: \`${next.id}\`\n` +
        `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n\n` +
        (isLarge
          ? `LARGEタスクのため自動実行できません。\`!task split ${next.id}\` で分割してください。`
          : `プロンプトに危険操作（force push / rm -rf 等）が含まれています。手動で確認してください。`)
      ).catch(() => {});
      stopReason = `BLOCKED (${storedType}/${storedSize})`;
      break;
    }

    if (prePolicy === autoPolicy.AUTO_POLICY.HUMAN_APPROVAL_REQUIRED) {
      logger.warn(`[AUTO-ON] HUMAN_APPROVAL_REQUIRED: ${next.id} | type:${storedType}`);
      await message.channel.send(
        `⚠️ **[${i + 1}/${AUTO_MAX_TASKS}] 人間確認が必要 (HUMAN_APPROVAL_REQUIRED)**\n\n` +
        `タスク: \`${next.id}\`\n` +
        `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n\n` +
        `危険度が高いか、機密情報に関わる変更の可能性があります。\n` +
        `内容を確認してから \`!approve ${next.id}\` または \`!deny ${next.id}\` してください。`
      ).catch(() => {});
      stopReason = 'HUMAN_APPROVAL_REQUIRED';
      break;
    }

    // AUTO_SAFE / AI_REVIEW_REQUIRED → 自動継続
    logger.info(`[AUTO] Continuing... policy=${prePolicy} | ${next.id}`);

    // ─ REVIEW タスクは Codex へ転送（Claude Code は実行しない）─
    if (storedType === taskManager.TASK_TYPES.REVIEW) {
      await message.channel.send(
        `👀 **[${i + 1}/${AUTO_MAX_TASKS}]** REVIEWタスク → Codex 転送\n` +
        `タスク: \`${next.id}\`\n` +
        `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}`
      ).catch(() => {});
      await executeReviewTask({ message, task: next, projectId });
      succeeded++;
      logger.info(`[AUTO-ON] REVIEW 転送完了 (${i + 1}/${AUTO_MAX_TASKS}): ${next.id}`);
      continue;
    }

    // ─ RESEARCH タスクは調査専用モードで実行 ─
    if (storedType === taskManager.TASK_TYPES.RESEARCH) {
      await message.channel.send(
        `🔍 **[${i + 1}/${AUTO_MAX_TASKS}]** RESEARCHタスク → 調査モード\n` +
        `タスク: \`${next.id}\`\n` +
        `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n` +
        `ファイル変更は行いません。調査結果を reports/ に保存します。`
      ).catch(() => {});
      await executeResearchTask({ message, task: next, projectId });
      succeeded++;
      logger.info(`[AUTO-ON] RESEARCH 完了 (${i + 1}/${AUTO_MAX_TASKS}): ${next.id}`);
      continue;
    }

    // ─ Type Guard をプロンプトに付与 ─
    const typeGuard     = taskManager.buildTypeGuard(storedType);
    const guardedPrompt = prompt + typeGuard;
    const guardMode     = (storedType === taskManager.TASK_TYPES.RESEARCH ||
                           storedType === taskManager.TASK_TYPES.REVIEW)
      ? 'no file changes'
      : 'implementation allowed';

    logger.info(
      `[AUTO-ON] Task: ${next.id} | Type: ${storedType} | Size: ${storedSize} | Mode: ${storedType}`
    );
    logger.info(`[AUTO] Type Guard: ${storedType} / ${guardMode}`);

    await message.channel.send(
      `▶ **[${i + 1}/${AUTO_MAX_TASKS}]** 実行中\n` +
      `タスク: \`${next.id}\`\n` +
      `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n` +
      `指示: ${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}`
    ).catch(() => {});

    // ─ ② キュー経由で実行・完了を待機（Type Guard 付きプロンプトを使用）─
    await enqueueAndWait(next.id, () => executeClaudeTask({
      message, prompt: guardedPrompt, taskId: next.id, projectId, taskType, taskSizeResult,
      taskWorkspace, refTaskId: null, source: 'auto-on',
    }));

    // ─ ③ 完了後の状態確認 → 続行/停止を判断 ─
    const finalTask = taskManager.getTask(next.id);

    if (!finalTask) {
      // DONE → アーカイブ済み（success）
      succeeded++;
      logger.info(`[AUTO-ON] 成功 (${i + 1}/${AUTO_MAX_TASKS}): ${next.id}`);
    } else if (finalTask.state === taskManager.STATES.AWAITING) {
      // 人間確認待ち（AIレビュー却下推奨 or PR作成済み）
      succeeded++;
      stopReason = '人間確認待ち（AIレビュー却下推奨 or PR作成）';
      logger.info(`[AUTO-ON] 人間確認待ちで停止: ${next.id}`);
      break;
    } else if (finalTask.state === taskManager.STATES.REVIEWING) {
      // バリデーション未通過（変更なし / handoff / 短文等）
      failed++;
      stopReason = 'バリデーション未通過（変更なし・handoff検出等）';
      logger.warn(`[AUTO-ON] バリデーション未通過で停止: ${next.id}`);
      break;
    } else {
      // エラー or 予期しない状態（IN_PROGRESS のままなど）
      // Phase E-3: handleAutoTimeoutSplit() で Auto Split 判定（共通ロジック）
      const splitAction = await handleAutoTimeoutSplit({
        message, task: finalTask, contextLabel: 'AUTO-ON',
      });

      if (splitAction === 'split_ok') {
        continue; // ループ先頭へ戻り分割タスクを実行
      }
      if (splitAction === 'timeout_limit') {
        failed++;
        stopReason = 'タイムアウト2回 → 人間確認が必要';
        break;
      }
      // 'no_split' → 通常停止へフォールスルー

      failed++;
      stopReason = `実行エラー（状態: ${finalTask.state}）`;
      logger.warn(`[AUTO-ON] 予期しない状態で停止: ${next.id} → ${finalTask.state}`);
      break;
    }
  }

  if (!stopReason) stopReason = '上限到達';

  await message.channel.send(
    `✅ **Auto Task Runner 完了**\n\n` +
    `成功: **${succeeded}件**\n` +
    `失敗: **${failed}件**\n` +
    `停止理由: **${stopReason}**`
  ).catch(() => {});

  logger.info(`[AUTO-ON] 完了 | 成功:${succeeded} 失敗:${failed} 理由:${stopReason}`);
}

// ─────────────────────────────────────────────────────
// !auto コマンドルーター — Phase3: run 1 / Phase4: on
//
// prepareNextTask() / executeClaudeTask() / taskQueue を再利用。
// 新しい実行ロジックは持たない。
// ─────────────────────────────────────────────────────
async function handleAutoRun(message, args) {
  const sub   = args[0] || '';
  const count = parseInt(args[1] || '0', 10);

  // !auto on — Phase4: 最大3件を順次自動実行
  if (sub === 'on') {
    await handleAutoOn(message);
    return;
  }

  // !auto run 1 のみ受け付ける
  if (sub !== 'run') {
    await message.reply(
      '**使い方**\n```\n!auto run 1  — 未着手タスクを1件だけ実行\n!auto on     — 最大3件を順次自動実行\n```'
    );
    return;
  }
  if (count !== 1) {
    await message.reply(
      '🚫 **`!auto run 1` のみ対応しています**\n\n' +
      '複数件の連続実行は禁止です。\n' +
      '1件ずつ実行して結果を確認してください。'
    );
    return;
  }

  logger.info(`[AUTO] !auto run 1 | ch:${message.channelId} | author:${message.author.id}`);

  // ─── prepareNextTask() で安全チェック（!run-next と同一ロジック）───
  const prepared = await prepareNextTask(message, 'auto');

  if (!prepared) {
    // なぜ実行できないか状態別に詳細を表示
    const currentPidAuto = projectManager.getCurrentProject(message.channelId);
    const allForAuto     = taskManager.listTasksByPriority();
    const filteredAuto   = projectManager.filterTasksByProject(allForAuto, currentPidAuto);
    const stateDetailAuto = {};
    filteredAuto.forEach(t => { stateDetailAuto[t.state] = (stateDetailAuto[t.state] || 0) + 1; });
    const detailLinesAuto = Object.entries(stateDetailAuto)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `  ${taskManager.STATE_EMOJI[s] || '❓'} ${s}: ${c}件`);
    const hintAuto = stateDetailAuto['レビュー待ち'] > 0 || stateDetailAuto['保留'] > 0
      ? '\n💡 `!task cleanup` で整理するか `!task resume <id>` で再開できます。'
      : '';
    await message.reply(
      `📋 **Auto Task Runner**\n\nProject: **${currentPidAuto}**\n実行可能な未着手タスクはありません。` +
      (detailLinesAuto.length > 0 ? '\n\n現在のタスク:\n' + detailLinesAuto.join('\n') : '') +
      hintAuto
    );
    return;
  }
  if (prepared.blocked) return;

  const { task: next, prompt, taskType, taskSizeResult, projectId, taskWorkspace } = prepared;

  // task.type / task.size 取得（後方互換: 未設定は IMPLEMENT / MEDIUM）
  const storedType = next.type || taskManager.TASK_TYPES.IMPLEMENT;
  const storedSize = next.size || taskManager.TASK_SIZES.MEDIUM;
  const typeEmoji  = taskManager.TYPE_EMOJI[storedType]  || '📋';
  const sizeEmoji  = taskManager.SIZE_EMOJI[storedSize]  || '🟡';

  // LARGE タスクは自動実行しない
  if (storedSize === taskManager.TASK_SIZES.LARGE) {
    logger.warn(`[AUTO] LARGEタスクをスキップ: ${next.id} | type:${storedType}`);
    await message.reply(
      `⚠️ **LARGEタスクのため自動実行をスキップしました**\n\n` +
      `タスク: \`${next.id}\`\n` +
      `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n\n` +
      `サイズが LARGE のタスクは手動で実行してください。\n` +
      `\`!claude\` で直接実行するか、タスクを分割してから再実行してください。`
    );
    return;
  }

  // ─── REVIEW タスクは Codex へ転送（Claude Code は実行しない）───
  if (storedType === taskManager.TASK_TYPES.REVIEW) {
    await message.reply(
      `👀 **REVIEWタスク → Codex 転送**\n\n` +
      `タスク: \`${next.id}\`\n` +
      `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n\n` +
      `Codex レビュー依頼を生成します。ファイル変更は行いません。`
    ).catch(() => {});
    await executeReviewTask({ message, task: next, projectId });
    return;
  }

  // ─── RESEARCH タスクは調査専用モードで実行 ───
  if (storedType === taskManager.TASK_TYPES.RESEARCH) {
    await message.reply(
      `🔍 **RESEARCHタスク → 調査モード**\n\n` +
      `タスク: \`${next.id}\`\n` +
      `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n\n` +
      `調査専用モードで実行します。ファイル変更は行いません。\n` +
      `結果は \`reports/research_${next.id}.md\` に保存されます。`
    ).catch(() => {});
    await executeResearchTask({ message, task: next, projectId });
    return;
  }

  // ─── Type Guard をプロンプトに付与 ───
  const typeGuard1     = taskManager.buildTypeGuard(storedType);
  const guardedPrompt1 = prompt + typeGuard1;
  const guardMode1     = (storedType === taskManager.TASK_TYPES.RESEARCH ||
                          storedType === taskManager.TASK_TYPES.REVIEW)
    ? 'no file changes'
    : 'implementation allowed';

  logger.info(`[AUTO] Task: ${next.id} | Type: ${storedType} | Size: ${storedSize} | Mode: ${storedType}`);
  logger.info(`[AUTO] Type Guard: ${storedType} / ${guardMode1}`);

  await message.reply(
    `▶ **Auto Task Runner**\n\n` +
    `対象:\n\`${next.id}\`\n\n` +
    `[${storedType}/${storedSize}] ${typeEmoji}${sizeEmoji}\n\n` +
    `指示: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\n\n` +
    `状態:\n実行開始`
  ).catch(() => {});

  // ─── executeClaudeTask() / taskQueue を !run-next と同様に再利用（Type Guard 付き）───
  const autoExecuteTask = async () => executeClaudeTask({
    message, prompt: guardedPrompt1, taskId: next.id, projectId, taskType, taskSizeResult,
    taskWorkspace, refTaskId: null, source: 'auto',
  });

  // キュー位置を先に確認してメッセージ（enqueueAndWait に切り替える前に表示）
  const pendingBefore = taskQueue.pendingCount;
  if (pendingBefore > 0) {
    await message.reply(
      `📋 **キューに追加しました（待機 ${pendingBefore + 1} 番目）**\n` +
      `\`${next.id}\` は処理完了後に自動実行されます。\n` +
      `\`!queue\` でキュー状況を確認できます。`
    ).catch(() => {});
  }

  // Phase E-3修正: fire-and-forget から完了待ちに変更
  // enqueueAndWait() で完了を待ち、タイムアウト検出 → autoSplitOnTimeout() を呼べるようにする
  await enqueueAndWait(next.id, autoExecuteTask);

  // Phase E-3: 完了後 finalTask.state 確認 → Auto Split（共通ロジック）
  const finalTaskAR = taskManager.getTask(next.id);
  if (finalTaskAR) {
    await handleAutoTimeoutSplit({
      message, task: finalTaskAR, contextLabel: 'AUTO-RUN',
    });
  }
}

// ─────────────────────────────────────────────────────
// !batch コマンド（Phase4 手動実行）
// ─────────────────────────────────────────────────────
async function handleBatch(message) {
  const processingMsg = await message.reply('🌙 **ナイトバッチを手動実行中...**');

  try {
    const result = await nightBatch.runBatch(async (channelId, text) => {
      const targetId = channelId || BATCH_CHANNEL_ID;
      if (targetId && targetId !== message.channelId) {
        try {
          const ch = await client.channels.fetch(targetId);
          if (ch) await ch.send(text);
        } catch { /* ignore */ }
      }
    });

    if (!result) {
      await processingMsg.edit('⭕ バッチ実行上限に達したため、バッチを停止しました。');
      return;
    }

    await processingMsg.edit(result.message);

  } catch (error) {
    logger.error(`!batch エラー: ${error.message}`);
    await processingMsg.edit(`❌ **バッチ実行に失敗しました**\n\n${_classifyDiscordError(error.message)}`);
  }
}

// ─────────────────────────────────────────────────────
// !train コマンド — AI 予測モデルを手動でトレーニング
// ─────────────────────────────────────────────────────
async function handleTrain(message) {
  const processingMsg = await message.reply('🤖 **AI 予測モデル トレーニング中...**');

  try {
    const result = aiTrainer.train();

    if (result.skipped) {
      const reasonLabel = result.reason === 'no_data'
        ? 'アーカイブデータなし（`data/history/` が空）'
        : result.reason;
      await processingMsg.edit(
        `⭕ **トレーニングをスキップしました**\n\n理由: ${reasonLabel}\n\n` +
        `タスクが完了するとアーカイブが蓄積されます。`
      );
      return;
    }

    aiPredictor.reloadWeights();

    const stats   = aiTrainer.getStats();
    const acc = stats?.accuracy;
    const accLine = acc?.avgTimeAccuracy !== null && acc?.avgTimeAccuracy !== undefined
      ? `⏱️ 時間推定精度: **${(acc.avgTimeAccuracy * 100).toFixed(1)}%**`
      : '⏱️ 時間推定精度: N/A（データ不足）';
    const succAccLine = acc?.avgSuccessAccuracy !== null && acc?.avgSuccessAccuracy !== undefined
      ? `🎯 成功率予測精度: **${(acc.avgSuccessAccuracy * 100).toFixed(1)}%**`
      : '🎯 成功率予測精度: N/A（データ不足）';
    const mapeLine = acc?.avgTimeMAPE !== null && acc?.avgTimeMAPE !== undefined
      ? `📉 時間推定MAPE: **${acc.avgTimeMAPE.toFixed(1)}%**（低いほど精度高）`
      : '📉 時間推定MAPE: N/A（データ不足）';
    const dirAccLine = acc?.avgDirectionalAcc !== null && acc?.avgDirectionalAcc !== undefined
      ? `🏹 方向性正解率: **${(acc.avgDirectionalAcc * 100).toFixed(1)}%**（50%超=ランダム比優位）`
      : '🏹 方向性正解率: N/A（データ不足）';

    const typeLines = Object.entries(result.typeReport || {}).map(([type, r]) => {
      const adjSign = r.successAdj >= 0 ? '+' : '';
      return `> **${type}** — n=${r.samples} | 成功確率補正: ${adjSign}${r.successAdj}% | 時間乗数: ×${r.timeMult}`;
    });

    const lines = [
      `✅ **AI 予測モデル トレーニング完了**`,
      ``,
      `📊 サンプル数: **${result.sampleCount}件**`,
      accLine,
      succAccLine,
      mapeLine,
      dirAccLine,
      ``,
      typeLines.length > 0 ? `**タイプ別結果:**\n${typeLines.join('\n')}` : '（タイプ別データなし）',
      ``,
      `ウェイトは \`data/predictor-weights.json\` に保存されました。`,
      `次回の予測から新しいウェイトが反映されます。`,
    ];

    await processingMsg.edit(lines.join('\n'));
    logger.info(`[Train] 手動トレーニング完了 | samples:${result.sampleCount}`);

  } catch (error) {
    logger.error(`!train エラー: ${error.message}`);
    await processingMsg.edit(`❌ **トレーニングに失敗しました**\n\n${_classifyDiscordError(error.message)}`);
  }
}

// ─────────────────────────────────────────────────────
// キーワード引数パーサー: key=value または key="quoted value"
function _parseYtKwargs(str) {
  const result = {};
  const re = /(\w+)=(?:"([^"]*)"|((?:[^\s]+)))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    result[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return result;
}

const _classifyDiscordError = fmt.classifyDiscordError;

function _classifyYtDiscordError(errMsg) {
  if (/タイムアウト|timeout|timed/i.test(errMsg)) {
    return (
      '⏱️ **タイムアウト** — YouTube API への接続に時間がかかりすぎました。\n' +
      'ネットワーク接続を確認してから再試行してください。'
    );
  }
  if (/クォータ|quota/i.test(errMsg)) {
    return (
      '🚫 **API クォータ超過** — 本日の API 利用上限に達しました。\n' +
      '明日以降に再試行するか、`.env` の `YOUTUBE_API_KEY` を別のキーに変更してください。'
    );
  }
  if (/403|認証エラー|APIキー/i.test(errMsg)) {
    return (
      '🔑 **API 認証エラー** — `YOUTUBE_API_KEY` が無効または期限切れです。\n' +
      '`.env` を確認し、Google Cloud Console で新しいキーを発行してください。'
    );
  }
  if (/400|入力エラー/i.test(errMsg)) {
    return (
      '📋 **入力エラー** — 引数が正しくありません。\n' +
      '`!youtube` でコマンド一覧を確認してください。'
    );
  }
  if (/404|未発見|not found/i.test(errMsg)) {
    return '🔍 **リソース未発見** — 動画 ID・チャンネル ID が正しいか確認してください。';
  }
  if (/接続失敗|ENOTFOUND|ECONNREFUSED/i.test(errMsg)) {
    return (
      '🌐 **接続失敗** — YouTube API に接続できません。\n' +
      'ネットワーク接続または DNS を確認してください。'
    );
  }
  return (
    '⚠️ **API エラー** — YouTube API の呼び出しに失敗しました。\n' +
    '`!doctor` でシステム状態を確認してください。'
  );
}

// !youtube コマンド — YouTube 視聴予測 AI
//
// サブコマンド:
//   predict <URL>              動画URLの視聴ヒット予測
//   predict title="..." ...    投稿前メタデータで予測
//   status                     クォータ・モデル状態確認
//   collect <genre> <query>    シードデータ収集（管理者のみ・API Key必須）
//   train                      収集データでモデル訓練（管理者のみ）
// ─────────────────────────────────────────────────────
async function handleYoutube(message, args) {
  const sub = args[0] || '';

  // ── diagnose — 投稿前6軸診断（YouTube API / LLM API 不使用）──
  if (sub === 'diagnose') {
    const diagArg = args.slice(1).join(' ').trim();
    if (!diagArg || !/\w+=/.test(diagArg)) {
      await message.reply(
        '**!youtube diagnose — 投稿前診断（外部API不使用）**\n\n' +
        '```\n' +
        '!youtube diagnose title="タイトル"\n' +
        '!youtube diagnose title="タイトル" genre=vtuber tags="タグ1,タグ2" sec=600 subs=5000\n' +
        '```\n\n' +
        '**6軸を診断します:** CTR適性 / 視聴維持適性 / SEO強度 / 感情フック / 投稿タイミング / 競合差別化\n\n' +
        '再生数レンジは表示しません。診断スコアのみです。'
      );
      return;
    }

    const kw = _parseYtKwargs(diagArg);
    if (!kw.title) {
      await message.reply(
        '❌ `title=` が必須です。\n\n' +
        '例: `!youtube diagnose title="【初見】ゲーム名に挑戦してみた！" genre=vtuber`'
      );
      return;
    }

    const ytDiag  = require('./utils/youtube-diagnostic');
    const tagsArr = kw.tags ? kw.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const input   = {
      title:           kw.title,
      genre:           kw.genre  || '',
      description:     kw.desc   || '',
      tags:            tagsArr,
      duration:        kw.sec    ? parseInt(kw.sec,  10) : 0,
      subscriberCount: kw.subs   ? parseInt(kw.subs, 10) : 0,
      publishedAt:     kw.at     || null,   // ISO8601 投稿予定日時
    };

    const result = ytDiag.diagnose(input);
    const text   = ytDiag.formatDiagnosticText(result, input);
    await message.reply(text.slice(0, 1900)).catch(() => {});
    return;
  }

  // ── predict ──────────────────────────────────────────
  if (sub === 'predict') {
    const urlOrId  = args[1] || '';
    const argStr   = args.slice(1).join(' ');
    const hasKwarg = argStr && /\w+=/.test(argStr);

    if (!argStr) {
      await message.reply(
        '**使い方**\n```\n' +
        '!youtube predict <YouTube URL or videoId>\n' +
        '!youtube predict title="タイトル" tags="タグ1,タグ2" sec=600 subs=5000\n' +
        '```\n' +
        '例（URL）: `!youtube predict https://www.youtube.com/watch?v=XXXXXXXXXXX`\n' +
        '例（投稿前）: `!youtube predict title="新曲歌ってみた！" tags="歌ってみた,vtuber" sec=300 subs=10000`'
      );
      return;
    }

    // ── 投稿前メタデータ入力モード ────────────────────
    if (hasKwarg) {
      const kw = _parseYtKwargs(argStr);
      if (Object.keys(kw).length === 0) {
        await message.reply(
          '❌ **引数を解析できませんでした**\n' +
          '入力例: `!youtube predict title="新曲歌ってみた！" tags="歌ってみた,vtuber" sec=300 subs=10000`'
        );
        return;
      }

      const tagsArr = kw.tags
        ? kw.tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
      const video = {
        videoId:         null,
        viewCount:       0,
        likeCount:       0,
        commentCount:    0,
        title:           kw.title || '',
        description:     kw.desc  || '',
        tags:            tagsArr,
        duration:        kw.sec  ? parseInt(kw.sec,  10) : 0,
        publishedAt:     null,
        subscriberCount: kw.subs ? parseInt(kw.subs, 10) : 0,
      };

      try {
        const result  = youtubePredictor.predict(video);
        const summary = youtubePredictor.buildSummary(video, result);
        const durStr  = video.duration
          ? `${Math.floor(video.duration / 60)}分${video.duration % 60}秒`
          : '未指定';

        const prePubMeta =
          `📝 **投稿前予測モード** (再生数・エンゲージメントなし)\n` +
          `🏷️ タイトル: ${video.title || '（未入力）'}\n` +
          `🏷️ タグ: ${tagsArr.length}個  ` +
          `⏱️ 長さ: ${durStr}  ` +
          `👥 登録者: ${video.subscriberCount.toLocaleString()}` +
          (kw.genre ? `\n🎮 ジャンル: \`${kw.genre}\`` : '');
        await message.reply(prePubMeta + '\n\n' + summary);
      } catch (err) {
        logger.error(`!youtube predict (kwarg) エラー: ${err.message}`);
        await message.reply(
          `❌ **予測に失敗しました**\n\n` +
          `⚠️ **予測処理エラー** — 入力値を確認してください。\n` +
          `詳細: \`${(err.message || '').slice(0, 150)}\``
        );
      }
      return;
    }

    // ── URL / videoId モード（従来処理） ──────────────
    const videoIdMatch = urlOrId.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
    const videoId      = videoIdMatch ? videoIdMatch[1] : urlOrId;

    const processingMsg = await message.reply(`🔍 **予測中...** \`${videoId}\``);

    try {
      if (!YOUTUBE_API_KEY) {
        await processingMsg.edit(
          '❌ **YOUTUBE_API_KEY が未設定です**\n\n' +
          '**設定手順（初回のみ）:**\n' +
          '1. Google Cloud Console でプロジェクトを作成\n' +
          '2. 「APIとサービス」→「ライブラリ」→「YouTube Data API v3」を有効化\n' +
          '3. 「認証情報」→「APIキーを作成」でキーを発行\n' +
          '4. `.env` に `YOUTUBE_API_KEY=発行したキー` を追記してBotを再起動\n\n' +
          '⚠️ APIキーはコードやチャットに直接貼らず `.env` に保存してください\n' +
          '💡 APIキー不要の投稿前予測: `!youtube predict title="タイトル" subs=5000`'
        );
        return;
      }

      const ytClient = new YouTubeApiClient(YOUTUBE_API_KEY);
      const details  = await ytClient.getVideoDetails([videoId]);
      if (!details || details.length === 0) {
        await processingMsg.edit(`❌ **動画が見つかりません**: \`${videoId}\``);
        return;
      }

      const v          = details[0];
      const channelId  = v.snippet?.channelId;
      let   subscriberCount = 0;
      try {
        const chInfo = await ytClient.getUploadsPlaylistId(channelId);
        subscriberCount = chInfo.subscriberCount;
      } catch {
        // hiddenSubscriberCount チャンネルはサブ数0として扱う
      }

      const video = youtubeCollector.normalizeVideo(v, subscriberCount);
      const result = youtubePredictor.predict(video);
      const summary = youtubePredictor.buildSummary(video, result);

      const videoMeta =
        `📺 **${(video.title || '（タイトル不明）').slice(0, 60)}**\n` +
        `👁️ 再生数: ${video.viewCount.toLocaleString()}  ` +
        `👥 登録者: ${subscriberCount.toLocaleString()}\n` +
        `⏱️ 長さ: ${Math.floor(video.duration / 60)}分${video.duration % 60}秒  ` +
        `🏷️ タグ: ${video.tags.length}個`;
      await processingMsg.edit(videoMeta + '\n\n' + summary);
    } catch (err) {
      logger.error(`!youtube predict エラー: ${err.message}`);
      const errMsg = err.message || '';
      await processingMsg.edit(
        `❌ **予測に失敗しました**\n\n${_classifyYtDiscordError(errMsg)}\n\n詳細: \`${errMsg.slice(0, 150)}\``
      );
    }
    return;
  }

  // ── status ───────────────────────────────────────────
  if (sub === 'status') {
    try {
      const modelStatus = youtubePredictor.getModelStatus();
      const quotaStatus = YOUTUBE_API_KEY
        ? new YouTubeApiClient(YOUTUBE_API_KEY).getQuotaStatus()
        : { used: 0, date: '(API Key 未設定)' };

      const keyStatus = YOUTUBE_API_KEY ? '✅ 設定済み' : '❌ 未設定';
      const mlStatus  = modelStatus.trained && modelStatus.sampleCount >= 20
        ? `🤖 ML有効 (usedML=true)` : `📏 ルールベース (MLデータ不足)`;
      const modelLine = modelStatus.trained
        ? `✅ 訓練済み (${modelStatus.sampleCount}件: hit=${modelStatus.hitCount} miss=${modelStatus.missCount})  ${mlStatus}`
        : '⭕ 未訓練（シードデータを収集してください）';

      const accLine = (modelStatus.trained && modelStatus.trainDirectionalAcc != null)
        ? `\n  📐 方向性正解率: ${(modelStatus.trainDirectionalAcc * 100).toFixed(1)}% (学習データ上の参考値)`
        : '';
      const trainedAtLine = modelStatus.trainedAt
        ? `\n  🕐 最終訓練: ${new Date(modelStatus.trainedAt).toLocaleString('ja-JP')}`
        : '';

      const readiness = !YOUTUBE_API_KEY
        ? '⛔ **APIキー未設定** — `!youtube predict <URL>` は実行できません'
        : !modelStatus.trained
        ? '🟡 **セットアップ未完了** — シードデータ収集・訓練が必要です'
        : modelStatus.sampleCount < 20
        ? '🟡 **データ不足** — もう少しサンプルが必要です (20件以上でML有効)'
        : '🟢 **使用可能** — 予測を実行できます';

      const nextSteps = YOUTUBE_API_KEY
        ? (modelStatus.trained && modelStatus.sampleCount >= 20
          ? `✅ セットアップ完了！\n` +
            `\`!youtube predict <URL>\` — 投稿済み動画を予測\n` +
            `\`!youtube predict title="..." subs=10000\` — 投稿前に予測（APIキー不要）`
          : `① \`!youtube bulk-collect vtuber\` — シードデータ収集（推奨 / 数分）\n` +
            `② \`!youtube train\` — モデル訓練\n` +
            `③ \`!youtube predict <URL>\` — 予測\n\n` +
            `💡 APIキーなしでも投稿前予測は今すぐ使えます:\n` +
            `   \`!youtube predict title="タイトル" subs=5000 sec=600\`\n\n` +
            `利用可能ジャンル: ${Object.keys(GENRE_PRESETS).join(', ')}`)
        : `**APIキー設定手順（初回のみ）:**\n` +
          `1. Google Cloud Console でプロジェクトを作成\n` +
          `2. 「APIとサービス」→「ライブラリ」→「YouTube Data API v3」を有効化\n` +
          `3. 「認証情報」→「APIキーを作成」でキーを発行\n` +
          `4. \`.env\` に \`YOUTUBE_API_KEY=発行したキー\` を追記してBotを再起動\n\n` +
          `⚠️ APIキーはコードやチャットに直接貼らず \`.env\` に保存してください\n` +
          `💡 APIキー不要の投稿前予測は今すぐ使えます:\n` +
          `   \`!youtube predict title="タイトル" subs=5000 sec=600\``;

      await message.reply(
        `📊 **YouTube 視聴予測 AI — ステータス**\n` +
        `> 動画URLまたは投稿前データから「ヒットしやすいか」を統計的に予測するAIです\n\n` +
        `**状態:** ${readiness}\n\n` +
        `🔑 API Key: ${keyStatus}\n` +
        `📡 クォータ: ${quotaStatus.used} / 10,000 units  (${quotaStatus.date})\n` +
        `🤖 モデル: ${modelLine}${accLine}${trainedAtLine}\n\n` +
        `**次のステップ:**\n` + nextSteps
      );
    } catch (err) {
      logger.error(`!youtube status エラー: ${err.message}`);
      const errMsg = err.message || '';
      await message.reply(
        `❌ **ステータス取得に失敗しました**\n\n${_classifyYtDiscordError(errMsg)}\n\n詳細: \`${errMsg.slice(0, 150)}\``
      );
    }
    return;
  }

  // ── collect（管理者のみ）────────────────────────────
  if (sub === 'collect') {
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      await message.reply('管理者専用コマンドです');
      return;
    }
    if (!YOUTUBE_API_KEY) {
      await message.reply('❌ `YOUTUBE_API_KEY` が未設定です');
      return;
    }

    const genre = args[1] || '';
    const query = args.slice(2).join(' ') || '';
    if (!genre || !query) {
      await message.reply(
        '**使い方**\n```\n!youtube collect <genre> <検索クエリ>\n```\n' +
        '例: `!youtube collect vtuber VTuber 歌ってみた`\n\n' +
        'ジャンル名がファイル名になります（英数字・ハイフン推奨）'
      );
      return;
    }

    const processingMsg = await message.reply(
      `⏳ **シードデータ収集中...**\n` +
      `ジャンル: \`${genre}\`  クエリ: "${query}"\n` +
      `hit 最大100件 + miss 最大20件を収集します（数分かかります）`
    );

    try {
      const ytClient = new YouTubeApiClient(YOUTUBE_API_KEY);

      const hits = await youtubeCollector.collectHitVideos(ytClient, query, { limit: 100 });

      const hitChannelIds = [...new Set(hits.map(v => v.channelId).filter(Boolean))];
      const misses = await youtubeCollector.collectMissFromChannels(
        ytClient, hitChannelIds, { maxChannels: 10, limitPerChannel: 30 }
      );

      youtubeCollector.saveSeedData(genre, hits, misses);

      const quota = ytClient.getQuotaStatus();
      await processingMsg.edit(
        `✅ **収集完了**\n\n` +
        `ジャンル: \`${genre}\`\n` +
        `🟢 hit: ${hits.length}件  🔴 miss: ${misses.length}件\n` +
        `📡 クォータ消費: ${quota.used} / 10,000 units\n\n` +
        `次のステップ: \`!youtube train\` でモデルを訓練してください`
      );
    } catch (err) {
      logger.error(`!youtube collect エラー: ${err.message}`);
      const errMsg = err.message || '';
      await processingMsg.edit(
        `❌ **収集に失敗しました**\n\n${_classifyYtDiscordError(errMsg)}\n\n詳細: \`${errMsg.slice(0, 150)}\``
      );
    }
    return;
  }

  // ── bulk-collect（管理者のみ）───────────────────────
  // プリセットに登録された複数クエリを順番に実行して数百件規模のシードを収集
  if (sub === 'bulk-collect') {
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      await message.reply('管理者専用コマンドです');
      return;
    }
    if (!YOUTUBE_API_KEY) {
      await message.reply('❌ `YOUTUBE_API_KEY` が未設定です');
      return;
    }

    const genreKey = args[1] || '';
    if (!genreKey) {
      const genreList = Object.entries(GENRE_PRESETS)
        .map(([k, p]) => `\`${k}\` (${p.label})`)
        .join('\n');
      await message.reply(
        '**使い方**\n```\n!youtube bulk-collect <genre>\n```\n\n' +
        '**利用可能なジャンル:**\n' + genreList + '\n\n' +
        '各ジャンルで複数クエリを自動実行し、数百件規模のシードを収集します。\n' +
        '`!youtube collect <genre> <query>` の一括版です。'
      );
      return;
    }

    const preset = GENRE_PRESETS[genreKey];
    if (!preset) {
      const keys = Object.keys(GENRE_PRESETS).join(', ');
      await message.reply(`❌ 未知のジャンル: \`${genreKey}\`\n利用可能: ${keys}`);
      return;
    }

    const estimatedUnits = estimateQuotaForGenre(preset);
    const processingMsg  = await message.reply(
      `⏳ **一括シードデータ収集中...**\n` +
      `ジャンル: \`${genreKey}\` (${preset.label})\n` +
      `クエリ: ${preset.queries.length}件 × hit${preset.hitLimitPerQuery}件 + miss収集\n` +
      `推定クォータ: ≈${estimatedUnits} units\n` +
      `（完了まで数分かかります）`
    );

    try {
      const ytClient = new YouTubeApiClient(YOUTUBE_API_KEY);
      const allHits  = [];
      const allMissChIds = [];
      const queryResults = [];

      for (let i = 0; i < preset.queries.length; i++) {
        const query = preset.queries[i];
        try {
          const hits = await youtubeCollector.collectHitVideos(ytClient, query, {
            limit: preset.hitLimitPerQuery,
          });
          allHits.push(...hits);
          for (const h of hits) {
            if (h.channelId && !allMissChIds.includes(h.channelId)) {
              allMissChIds.push(h.channelId);
            }
          }
          queryResults.push(`[${i + 1}] "${query}" → hit ${hits.length}件`);
        } catch (qErr) {
          queryResults.push(`[${i + 1}] "${query}" → ⚠ ${qErr.message.slice(0, 60)}`);
        }
      }

      const misses = await youtubeCollector.collectMissFromChannels(
        ytClient, allMissChIds,
        { maxChannels: preset.missChannelsMax, limitPerChannel: preset.missPerChannel }
      );

      const saved = youtubeCollector.saveSeedData(genreKey, allHits, misses);
      const quota = ytClient.getQuotaStatus();

      await processingMsg.edit(
        `✅ **一括収集完了**\n\n` +
        `ジャンル: \`${genreKey}\` (${preset.label})\n\n` +
        `**クエリ結果:**\n${queryResults.join('\n')}\n\n` +
        `**累計保存:**\n` +
        `🟢 hit: ${saved.hits.length}件  🔴 miss: ${saved.misses.length}件\n` +
        `📡 クォータ消費: ${quota.used} / 10,000 units\n\n` +
        `次のステップ: \`!youtube train\` でモデルを訓練してください`
      );
    } catch (err) {
      logger.error(`!youtube bulk-collect エラー: ${err.message}`);
      const errMsg = err.message || '';
      await processingMsg.edit(
        `❌ **収集に失敗しました**\n\n${_classifyYtDiscordError(errMsg)}\n\n詳細: \`${errMsg.slice(0, 150)}\``
      );
    }
    return;
  }

  // ── train（管理者のみ）──────────────────────────────
  if (sub === 'train') {
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      await message.reply('管理者専用コマンドです');
      return;
    }

    const processingMsg = await message.reply('🤖 **YouTube 予測モデル 訓練中...**');

    try {
      const allSamples = youtubeCollector.loadAllSeedData();
      const result     = youtubePredictor.train(allSamples);

      if (!result) {
        await processingMsg.edit(
          `⭕ **訓練をスキップしました**\n\n` +
          `理由: サンプル不足（最低10件必要）\n` +
          `現在のサンプル数: ${allSamples.length}件\n\n` +
          `\`!youtube collect\` でデータを収集してください`
        );
        return;
      }

      await processingMsg.edit(
        `✅ **YouTube 予測モデル 訓練完了**\n\n` +
        `📊 サンプル数: **${result.sampleCount}件**\n` +
        `🟢 hit: ${result.hitCount}件  🔴 miss: ${result.missCount}件\n\n` +
        `モデルは \`data/youtube-model.json\` に保存されました。\n` +
        `\`!youtube predict <URL>\` で予測を試してください`
      );
    } catch (err) {
      logger.error(`!youtube train エラー: ${err.message}`);
      const errMsg = err.message || '';
      let guide;
      if (/EACCES|permission denied/i.test(errMsg)) {
        guide =
          '🔒 **権限エラー** — モデルファイルへの書き込み権限がありません。\n' +
          'サーバーのファイルパーミッションを確認してください。';
      } else if (/ENOENT|no such file/i.test(errMsg)) {
        guide =
          '📁 **ファイルエラー** — データファイルが見つかりません。\n' +
          '`!youtube collect` でデータを収集してから再試行してください。';
      } else {
        guide =
          '⚠️ **訓練エラー** — モデルの訓練中に予期しないエラーが発生しました。\n' +
          '`!doctor` でシステム状態を確認してください。';
      }
      await processingMsg.edit(
        `❌ **訓練に失敗しました**\n\n${guide}\n\n詳細: \`${errMsg.slice(0, 150)}\``
      );
    }
    return;
  }

  // ── export-model — 推論専用 model export（Owner 限定）──
  if (sub === 'export-model') {
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      await message.reply('🚫 `!youtube export-model` は管理者専用コマンドです。');
      return;
    }
    const ytExporter = require('./utils/youtube-model-exporter');
    const result = ytExporter.exportInferenceModel();
    const text   = result.ok
      ? result.message
      : `❌ **Export 失敗**\n\n${result.message}`;
    await message.reply(text.slice(0, 1900)).catch(() => {});
    return;
  }

  // ── ヘルプ ────────────────────────────────────────────
  await message.reply(
    '**YouTube 視聴予測 AI コマンド**\n```\n' +
    '!youtube predict <URL>                      → 投稿済み動画のヒット予測\n' +
    '!youtube predict title="..." tags="a,b"\n' +
    '         sec=600 subs=5000 genre=vtuber     → 投稿前メタデータで予測\n' +
    '!youtube status                             → クォータ・モデル状態\n' +
    '!youtube collect <genre> <query>            → シードデータ収集（1クエリ）\n' +
    '!youtube bulk-collect <genre>               → シードデータ一括収集（管理者）\n' +
    '!youtube train                              → モデル訓練（管理者）\n' +
    '```\n' +
    '**シード収集の流れ (MLを有効にするには)**\n' +
    '1. `!youtube bulk-collect vtuber` — プリセットクエリで数百件収集\n' +
    '2. `!youtube train` — シードデータでモデル訓練\n' +
    '3. `!youtube status` — sampleCount と `usedML=true` を確認\n\n' +
    '**投稿前予測の引数** (1つ以上指定)\n' +
    '`title="..."` タイトル  `tags="a,b"` タグ  `sec=600` 長さ(秒)  `subs=5000` 登録者数  `genre=xxx` ジャンル\n\n' +
    '**予測の見方**\n' +
    '`hit` (確率60%以上) — 平均より5倍以上再生が付く可能性\n' +
    '`miss` (確率40%以下) — 再生数が登録者の0.3倍未満になる可能性\n' +
    '`unknown` — 判定が難しい中間帯'
  );
}

// ─────────────────────────────────────────────────────
// !doctor コマンド（管理者限定・診断専用）
// ─────────────────────────────────────────────────────
async function handleDoctor(message) {
  // ── オーナーのみ実行可能 ──
  if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
    await message.reply('管理者専用です');
    return;
  }

  const projectId = projectDetector.detectProjectId(message.channel);
  const processingMsg = await message.reply('🩺 診断中...');
  try {
    const notifyChannelInfo = await buildNotifyChannelInfo();
    const result = doctor.runDiagnostics(projectId, notifyChannelInfo);
    // 2000文字制限を超える場合は分割
    if (result.length <= 2000) {
      await processingMsg.edit(result);
    } else {
      await processingMsg.edit(result.slice(0, 2000));
      await message.channel.send(result.slice(2000, 4000));
    }
  } catch (e) {
    logger.error(`!doctor エラー: ${e.message}`);
    await processingMsg.edit(`❌ 診断中にエラーが発生しました\n\n${_classifyDiscordError(e.message)}`);
  }
}

// ─────────────────────────────────────────────────────
// !queue コマンド（Phase5）
// ─────────────────────────────────────────────────────
async function handleQueue(message, sub) {
  if (sub === 'clear') {
    // オーナーのみ許可
    if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
      await message.reply('❌ `!queue clear` はオーナーのみ実行できます。');
      return;
    }
    const cleared = taskQueue.clear();
    await message.reply(`🗑️ 待機中タスクを **${cleared} 件** 削除しました。`);
    return;
  }

  const { active, queued, max, pendingIds } = taskQueue.getStatus();
  const embedColor = active >= max ? 0xED4245 : queued > 0 ? 0xFEE75C : 0x57F287;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('📊 タスクキュー')
    .addFields(
      { name: '実行中', value: `${active} / ${max}`, inline: true },
      { name: '待機中', value: `${queued} 件`,        inline: true },
    )
    .setTimestamp();

  if (pendingIds.length > 0) {
    const SHOW_MAX = 5;
    const shown = pendingIds.slice(0, SHOW_MAX);
    const rest  = pendingIds.length - shown.length;
    embed.addFields({
      name:  '待機タスク',
      value: shown.map(id => `\`${id}\``).join('\n') + (rest > 0 ? `\n…他${rest}件` : ''),
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────
// !restart コマンド（安全再起動・管理者限定）
// ─────────────────────────────────────────────────────
async function handleRestart(message, args) {
  // ① オーナーのみ実行可能
  if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
    await message.reply('❌ `!restart` はオーナーのみ実行できます。');
    return;
  }

  const isConfirm = args[0] === 'confirm';

  // ② 全チェック実行
  const processingMsg = await message.reply('🔍 **再起動前チェックを実行中...**');
  const checks = restartManager.runPreRestartChecks(taskQueue);
  const checksText = restartManager.formatChecksForDiscord(checks);

  // ③ 構文エラー → 絶対ブロック（confirmでも通らない）
  if (!checks.syntax.ok) {
    await processingMsg.edit(
      `🔴 **再起動をブロックしました — 構文エラー**\n\n` +
      checksText + '\n\n' +
      `\`\`\`\n${checks.syntax.error}\n\`\`\`\n` +
      `→ エラーを修正してから再試行してください。`
    );
    return;
  }

  // ④ Token 未設定 → ブロック（confirmでも通らない）
  if (!checks.token.ok) {
    await processingMsg.edit(
      `🔴 **再起動をブロックしました — Token 未設定**\n\n` +
      checksText + '\n\n' +
      `→ \`.env\` の DISCORD_TOKEN を確認してください。`
    );
    return;
  }

  // ⑤ 警告あり かつ confirm なし → 確認を求める
  if (checks.needsConfirm && !isConfirm) {
    const warningLines = checks.warnings.map(w => `⚠️ ${w}`).join('\n');
    await processingMsg.edit(
      `🟡 **【確認】Botを再起動しますか？**\n\n` +
      checksText + '\n\n' +
      `**警告:**\n${warningLines}\n\n` +
      `問題なければ以下を送信してください:\n\`\`\`\n!restart confirm\n\`\`\``
    );
    return;
  }

  // ⑥ 全OK（または confirm 付き）→ 再起動実行
  try {
    // ─── 多重再起動防止: restart.lock を取得 ───
    const restartLock = restartManager.acquireRestartLock(message.channelId);
    if (!restartLock.ok) {
      await processingMsg.edit(
        `🔄 **再起動処理中です**\n\n` +
        `別のBotプロセス (PID: ${restartLock.lockData?.pid}) が再起動処理を実行中です。\n` +
        `しばらく待ってから確認してください。`
      );
      return;
    }

    // キュー状態を保存（新プロセスが完了通知に使う）
    restartManager.saveRestartState(taskQueue, message.channelId);

    await processingMsg.edit(
      `🔄 **Bot を再起動します...**\n\n` +
      checksText + '\n\n' +
      `数秒後に再接続します。再起動完了時にここへ通知します。`
    );

    // Discord にメッセージが届くよう少し待ってから実行
    await new Promise(resolve => setTimeout(resolve, 800));
    logger.info(`!restart 実行 | ユーザー: ${message.author.tag}`);
    await restartManager.performRestart();

  } catch (restartErr) {
    logger.error(`再起動失敗: ${restartErr.message}`);
    await processingMsg.edit(
      `❌ **再起動に失敗しました**\n${restartErr.message.slice(0, 300)}\n\n` +
      `Botは停止していません。手動で確認してください。`
    );
  }
}

// ─────────────────────────────────────────────────────
// !approve コマンド — 承認待ちタスクを承認
// ─────────────────────────────────────────────────────
async function handleApprove(message, taskId) {
  if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
    await message.reply('❌ `!approve` はオーナーのみ実行できます。');
    return;
  }

  // taskId なし → pending 一覧を表示
  if (!taskId) {
    await message.reply(approvalManager.formatPendingList());
    return;
  }

  // ── Approval record を取得 ──────────────────────────
  let approval = approvalManager.getApproval(taskId);

  if (!approval) {
    // record がない → taskManager から on-the-fly で作成を試みる
    const task = taskManager.getTask(taskId);

    if (task) {
      // タスクが存在する → post 型 approval を作成して承認
      approval = approvalManager.createApproval(taskId, {
        reason:    `手動承認: ${(task.prompt || '').slice(0, 60)}`,
        danger:    task.dangerLevel || '中',
        prompt:    task.prompt || '',
        channelId: message.channelId,
        authorTag: message.author.tag,
        type:      'post',
      });
      approvalManager.approve(taskId, message.author.tag);
      await message.reply(
        `✅ **承認（記録作成＋確認済み）: \`${taskId}\`**\n\n` +
        `タスクに approval record がなかったため自動作成しました。\n` +
        `タスク内容を続行するには:\n\`\`\`\n!claude ${taskId} 続行してください\n\`\`\``
      );
    } else {
      // タスクも存在しない → 新規 !claude での再実行を案内
      await message.reply(
        `⚠️ \`${taskId}\` の承認記録もタスク記録も見つかりません。\n\n` +
        `**考えられる原因:**\n` +
        `・Botが再起動して承認待ち情報が消えた\n` +
        `・そのタスクIDが存在しない\n\n` +
        `**解決方法:**\n` +
        `\`\`\`\n!claude 【元の指示内容】\n\`\`\`\n` +
        `または既存タスクを継続する場合:\n` +
        `\`\`\`\n!claude ${taskId} 続行してください\n\`\`\``
      );
    }
    return;
  }

  // ── 状態チェック ────────────────────────────────────
  if (approval.state !== approvalManager.STATES.PENDING) {
    await message.reply(
      `❌ \`${taskId}\` は承認待ち状態ではありません\n現在の状態: **${approval.state}**`
    );
    return;
  }

  // ── type='pre': 実行前承認 ──────────────────────────
  if (approval.type === 'pre') {
    if (pendingExecutions.has(taskId)) {
      // 正常ケース: 実行待機あり → 承認して実行
      const execFn = pendingExecutions.get(taskId);
      pendingExecutions.delete(taskId);
      approvalManager.approve(taskId, message.author.tag);

      await message.reply(
        `✅ **承認しました: \`${taskId}\`**\n\nClaude Code を実行します...`
      );
      execFn();
    } else {
      // Bot再起動ケース: pendingExecution が消えている
      approvalManager.approve(taskId, message.author.tag);
      const storedPrompt    = approval.prompt     || '';
      const storedProjectId = approval.projectId  || 'default';
      const storedChannelId = approval.channelId  || '';
      const channelMention  = storedChannelId ? `<#${storedChannelId}>` : `元のチャンネル`;
      await message.reply(
        `✅ **承認済みにしました: \`${taskId}\`**\n\n` +
        `⚠️ Bot 再起動のため実行待機が消えています。\n` +
        `**Project: ${storedProjectId}** を維持するため、${channelMention} から以下を送ってください:\n` +
        `\`\`\`\n!claude ${storedPrompt || '（元の指示をここに入力）'}\n\`\`\``
      );
    }
    return;
  }

  // ── type='post': 実行後確認 → 確認済み記録のみ ──────
  approvalManager.approve(taskId, message.author.tag);
  await message.reply(`✅ **承認（確認済み）: \`${taskId}\`**`);

  // ── Phase F-4: HUMAN_CHECK からの approve → _runProjectLoop 再開 ──
  // activeRuns 全体から ctx.pendingApproval === taskId の RunContext を探す
  for (const [pid, ctx] of activeRuns.entries()) {
    if (ctx && ctx.pendingApproval === taskId) {
      if (ctx.stopReason !== 'awaiting_human') break; // 既に再開済み or 別停止理由
      ctx.pendingApproval = null;
      ctx.stopReason      = null;
      logger.info(`[HumanCheck] approve → run 再開: ${pid} task:${taskId}`);
      await message.channel.send(
        `▶️ **承認を受け付けました — 実行を再開します**\n\nProject: \`${pid}\``
      ).catch(() => {});
      const prevPid = projectManager.getCurrentProject(message.channelId);
      projectManager.setCurrentProject(message.channelId, pid);
      // 二重起動防止: stopReason を null にした直後のみ再開
      _runProjectLoop(ctx)
        .catch(err => logger.error(`[HumanCheck] 再開 _runProjectLoop エラー: ${err.message}`))
        .finally(() => { _teardown(ctx, prevPid); });
      break;
    }
  }
}

// ─────────────────────────────────────────────────────
// !deny コマンド — 承認待ちタスクを却下
// ─────────────────────────────────────────────────────
async function handleDeny(message, taskId) {
  if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
    await message.reply('❌ `!deny` はオーナーのみ実行できます。');
    return;
  }

  if (!taskId) {
    await message.reply('**使い方**\n```\n!deny <タスクID>\n```');
    return;
  }

  const approval = approvalManager.getApproval(taskId);
  if (!approval) {
    await message.reply(
      `⚠️ \`${taskId}\` の承認記録が見つかりません。\n` +
      `タスク自体を保留にするには: \`!task hold ${taskId}\``
    );
    return;
  }
  if (approval.state === approvalManager.STATES.DENIED) {
    await message.reply(`すでに却下済みです: \`${taskId}\``);
    return;
  }

  // pending / paused どちらでも却下可能
  // type='pre' の場合は実行待機も削除
  if (pendingExecutions.has(taskId)) {
    pendingExecutions.delete(taskId);
  }

  approvalManager.deny(taskId, message.author.tag);
  taskManager.updateState(taskId, taskManager.STATES.ON_HOLD, '却下');

  await message.reply(
    `❌ **却下しました: \`${taskId}\`**\n\nタスクは実行されません。`
  );

  // ── Phase F-4: HUMAN_CHECK からの deny → 停止・teardown ──
  for (const [pid, ctx] of activeRuns.entries()) {
    if (ctx && ctx.pendingApproval === taskId) {
      ctx.stopRequested = true;
      ctx.stopReason    = 'denied_by_human';
      ctx.pendingApproval = null;
      logger.info(`[HumanCheck] deny → 停止 teardown: ${pid} task:${taskId}`);
      await message.channel.send(
        `🛑 **却下を受け付けました — 実行を停止します**\n\nProject: \`${pid}\``
      ).catch(() => {});
      const prevPid = projectManager.getCurrentProject(message.channelId);
      await _teardown(ctx, prevPid);
      break;
    }
  }
}

// ─────────────────────────────────────────────────────
// !pause コマンド — 承認待ちタスクを一時停止
// ─────────────────────────────────────────────────────
async function handlePause(message, taskId) {
  if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
    await message.reply('❌ `!pause` はオーナーのみ実行できます。');
    return;
  }

  if (!taskId) {
    await message.reply('**使い方**\n```\n!pause <タスクID>\n```');
    return;
  }

  const approval = approvalManager.getApproval(taskId);
  if (!approval) {
    await message.reply(`❌ \`${taskId}\` の承認記録が見つかりません。`);
    return;
  }
  if (approval.state !== approvalManager.STATES.PENDING) {
    await message.reply(
      `❌ \`${taskId}\` は承認待ち状態ではありません\n現在の状態: **${approval.state}**`
    );
    return;
  }

  approvalManager.pause(taskId, message.author.tag);

  await message.reply(
    `⏸️ **一時停止しました: \`${taskId}\`**\n\n` +
    `再開するには: \`!resume ${taskId}\``
  );
}

// ─────────────────────────────────────────────────────
// !resume コマンド — 一時停止タスクを承認待ちに戻す
// ─────────────────────────────────────────────────────
async function handleResume(message, taskId) {
  if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
    await message.reply('❌ `!resume` はオーナーのみ実行できます。');
    return;
  }

  if (!taskId) {
    await message.reply('**使い方**\n```\n!resume <タスクID>\n```');
    return;
  }

  const approval = approvalManager.getApproval(taskId);
  if (!approval) {
    await message.reply(
      `⚠️ \`${taskId}\` の承認記録が見つかりません。\n` +
      `タスクを継続するには: \`!claude ${taskId} 続行してください\``
    );
    return;
  }
  if (approval.state !== approvalManager.STATES.PAUSED) {
    await message.reply(
      `❌ \`${taskId}\` は一時停止状態ではありません\n現在の状態: **${approval.state}**`
    );
    return;
  }

  approvalManager.resume(taskId);
  const hasPending = pendingExecutions.has(taskId);

  await message.reply(
    `▶️ **再開しました: \`${taskId}\`**\n\n` +
    `承認待ち状態に戻りました。\n` +
    (hasPending
      ? `承認するには: \`!approve ${taskId}\``
      : `（実行待機は残っていません）`)
  );
}

// ─────────────────────────────────────────────────────
// !codex コマンド（スマホから直接 Codex へレビュー依頼）
// ─────────────────────────────────────────────────────
async function handleCodex(message, userContent) {
  if (!userContent) {
    await message.reply(
      '**使い方**\n```\n!codex <レビューしてほしい内容>\n```\n' +
      '**例**\n```\n!codex このコードのエラー原因を教えて: function foo() { retur; }\n```\n\n' +
      'Codex（GPT-4o）がレビューし、結果を表示します。\n' +
      '`OPENAI_API_KEY` が未設定の場合は手動レビュー用のファイルを作成します。'
    );
    return;
  }

  const taskId      = `codex_${Date.now()}`;
  const hasApiKey   = !!process.env.OPENAI_API_KEY;

  const processingMsg = await message.reply(
    `🔧 **Codex レビュー依頼を送信中...**\n` +
    `${hasApiKey ? '🤖 API に接続中です。少々お待ちください。' : '⭕ API キー未設定。手動レビュー用ファイルを作成します。'}`
  );

  try {
    // ① API 呼び出し（キーがあれば）
    const apiResult = await codex.callDirectCodexReview(userContent, taskId);

    // ② 回答をパース
    const parsed = codex.parseCodexResult(apiResult);

    // ③ reviews/ に保存
    codex.saveDirectReview(taskId, userContent, apiResult, parsed);

    // ④ Discord に結果を表示（5行以内）
    let reviewNotice = '';
    if (apiResult) {
      reviewNotice = codex.formatCodexResultForDiscord(parsed, taskId);
      await processingMsg.edit(reviewNotice);
    } else {
      // API キー未設定 → 手動レビュー案内
      reviewNotice =
        `📋 **手動 Codex レビュー用ファイルを作成しました**\n` +
        `📄 \`reviews/codex_direct_${taskId}.md\`\n\n` +
        `このファイルを ChatGPT / Codex に貼り付けてレビューを依頼してください。\n` +
        `🔑 自動レビューを有効にするには: \`.env\` に \`OPENAI_API_KEY\` を設定`;
      await processingMsg.edit(reviewNotice);
    }
    await sendNotification('codexReview', message.channel, reviewNotice);

    logger.info(`!codex 完了 | ${taskId} | API: ${apiResult ? 'あり' : 'なし'} | 危険度: ${parsed.danger}`);

  } catch (error) {
    logger.error(`!codex エラー: ${error.message}`);
    const errorText = `❌ **Codex レビューに失敗しました**\n\n${_classifyDiscordError(error.message)}`;
    await processingMsg.edit(errorText);
    await sendNotification('error', message.channel, errorText);
  }
}

// ─────────────────────────────────────────────────────
// メッセージ受信ハンドラ
// ─────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── [DIAG-1] 受信ログ（Bot自身以外・チャンネルフィルタ前）──
  // ※ content は先頭50文字のみ。token/secret は含まれない
  const _diagContent = message.content.trim().slice(0, 50);
  const _diagAllowed = ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(message.channelId);
  logger.debug(
    `[DIAG-1] recv | ch:${message.channelId} | author:${message.author.id} | allowed:${_diagAllowed} | content:"${_diagContent}"`
  );

  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(message.channelId)) {
    logger.debug(`[DIAG-1] ch:${message.channelId} はフィルタ外のためスキップ`);
    return;
  }

  const content = message.content.trim();

  // ─── Daily Closing 自然文トリガー ───────────────────
  // Bot 自身の投稿には反応しない（messageCreate で author.bot=false は保証済み）
  // 「作業終了」「退勤」等のトリガーワードを含むメッセージを検知する
  if (DAILY_CLOSE_TRIGGERS.some(trigger => content.includes(trigger))) {
    // 30 分以内の同日同チャンネル連投を防止
    const today   = new Date().toISOString().slice(0, 10);
    const coolKey = `${message.channelId}:${today}`;
    const lastMs  = _dailyCloseLastSent.get(coolKey) || 0;
    const elapsed = Date.now() - lastMs;

    if (elapsed < DAILY_CLOSE_COOLDOWN_MS) {
      const remaining = Math.ceil((DAILY_CLOSE_COOLDOWN_MS - elapsed) / 60000);
      logger.debug(`[DailyClose] クールダウン中: 残り約${remaining}分 | ch:${message.channelId}`);
    } else {
      _dailyCloseLastSent.set(coolKey, Date.now());
      try {
        const { buildClosingSummary } = require('./utils/client-ops');
        const currentPid = projectManager.getCurrentProject(message.channelId);
        const result     = buildClosingSummary({
          taskManager,
          projectManager,
          projectId: currentPid || undefined,
        });
        // Daily Closing Report ヘッダー + 更新ログを付けて送信
        const { buildChangesSection } = require('./utils/daily-changes');
        const changesSection = buildChangesSection();
        const reportText =
          `📅 **Daily Closing Report**\n` +
          `（「${content.slice(0, 20)}」を検知 → 自動生成）\n\n` +
          result.text + '\n\n' +
          '━━━━━━━━━━━━━━━━\n\n' +
          changesSection;
        await message.channel.send(reportText.slice(0, 1900)).catch(() => {});
        logger.info(`[DailyClose] 送信: ch:${message.channelId} | trigger:"${content.slice(0, 20)}"`);
      } catch (closeErr) {
        logger.warn(`[DailyClose] 生成エラー: ${closeErr.message}`);
      }
    }
    // トリガーワードがあっても !コマンドの可能性があるためフォールスルー禁止
    // （「今日はここまで !task list」のような複合メッセージは close のみ実行）
    return;
  }

  // ── コマンドルーティング ──
  if (content === '!help') {
    await handleHelp(message);
    return;
  }

  if (content.startsWith('!apply-review')) {
    const taskId = content.split(/\s+/)[1];
    await handleApplyReview(message, taskId);
    return;
  }

  if (content.startsWith('!create-pr')) {
    const taskId = content.split(/\s+/)[1];
    await handleCreatePR(message, taskId);
    return;
  }

  if (content.startsWith('!history')) {
    const taskId = content.split(/\s+/)[1];
    await handleHistory(message, taskId);
    return;
  }

  if (content.startsWith('!research')) {
    const sub = content.split(/\s+/)[1] || 'list';
    await handleResearch(message, sub);
    return;
  }

  if (content.startsWith('!project')) {
    const args = content.split(/\s+/).slice(1);
    await handleProject(message, args);
    return;
  }

  if (content.startsWith('!review')) {
    const sub = content.split(/\s+/)[1] || 'list';
    await handleReview(message, sub);
    return;
  }

  if (content.startsWith('!task')) {
    const args = content.split(/\s+/).slice(1);
    await handleTask(message, args);
    return;
  }

  if (content.startsWith('!meeting')) {
    const rawTopic = content.slice('!meeting'.length).trim();
    await handleMeeting(message, rawTopic);
    return;
  }

  if (content === '!next') {
    await handleNext(message);
    return;
  }

  // ── [DIAG-2] !run-next 判定ログ ──
  logger.debug(
    `[DIAG-2] routing | content:"${content.slice(0, 50)}" | is_run_next:${content === '!run-next'}`
  );

  if (content === '!run-next') {
    await handleRunNext(message);
    return;
  }

  if (content.startsWith('!auto')) {
    const args = content.split(/\s+/).slice(1);
    await handleAutoRun(message, args);
    return;
  }

  if (content === '!batch') {
    await handleBatch(message);
    return;
  }

  if (content === '!train') {
    await handleTrain(message);
    return;
  }

  if (content.startsWith('!youtube')) {
    const ytArgs = content.slice('!youtube'.length).trim().split(/\s+/).filter(Boolean);
    await handleYoutube(message, ytArgs);
    return;
  }

  if (content.startsWith('!queue')) {
    const sub = content.split(/\s+/)[1] || '';
    await handleQueue(message, sub);
    return;
  }

  if (content === '!doctor') {
    await handleDoctor(message);
    return;
  }

  // !cost — Finance Manager コストレポート
  if (content === '!cost') {
    const costText = financeManager.formatCostReport();
    await message.reply(costText.slice(0, 1900)).catch(() => {});
    return;
  }

  // !job — 案件リスク分類（ブロックしない助言コマンド）
  if (content.startsWith('!job')) {
    const { classifyJob, formatJobRiskReport } = require('./utils/job-risk-classifier');
    const jobInput = content.slice('!job'.length).trim();

    // ヘルプ
    if (!jobInput || jobInput === 'help') {
      await message.reply(
        '**!job コマンド — ココナラ案件リスク分類**\n\n' +
        '```\n!job <案件タイトル> | <案件説明>\n```\n\n' +
        '**例:**\n' +
        '```\n!job Stripe決済実装 | ECサイトにクレジットカード決済を追加したい\n```\n' +
        '```\n!job ExcelマクロでCSV自動集計 | 月次売上データをVBAで整形する\n```\n\n' +
        '**分類レベル:**\n' +
        '🟢 LOW — 受けてOK\n' +
        '🟡 MEDIUM — 質問してから判断\n' +
        '🟠 HIGH — 慎重に検討・契約確認必須\n' +
        '🔴 REJECT — 断ることを推奨'
      ).catch(() => {});
      return;
    }

    // タイトルと説明を `|` で分割
    const sepIdx  = jobInput.indexOf('|');
    const title   = sepIdx >= 0 ? jobInput.slice(0, sepIdx).trim() : jobInput.trim();
    const desc    = sepIdx >= 0 ? jobInput.slice(sepIdx + 1).trim()  : '';

    if (!title) {
      await message.reply(
        '❌ タイトルを入力してください。\n\n' +
        '使い方: `!job <タイトル> | <説明>`\n' +
        '例: `!job Webスクレイピングツール | 競合価格を毎日自動収集`'
      ).catch(() => {});
      return;
    }

    const result  = classifyJob(title, desc);
    const report  = formatJobRiskReport(title, desc, result);

    await message.reply(report.slice(0, 1900)).catch(() => {});
    logger.info(`[JobRisk] title="${title.slice(0, 40)}" → ${result.level}`);
    return;
  }

  // ─── コトノハ案件対応コマンド (Phase 1) ─────────────

  // !request — 要件整理
  if (content.startsWith('!request')) {
    const { analyzeRequest } = require('./utils/client-ops');
    const reqText = content.slice('!request'.length).trim();
    if (!reqText) {
      await message.reply(
        '**!request — 要件整理**\n\n' +
        '使い方: `!request <依頼内容>`\n\n' +
        '例:\n```\n!request お客さんから「毎月のCSVを自動でグラフ化したい」と依頼が来ました\n```'
      ).catch(() => {});
      return;
    }
    const result = analyzeRequest(reqText);
    await message.reply(result.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !proposal — 返信案作成
  if (content.startsWith('!proposal')) {
    const { buildProposal } = require('./utils/client-ops');
    const projText = content.slice('!proposal'.length).trim();
    if (!projText) {
      await message.reply(
        '**!proposal — 返信案作成**\n\n' +
        '使い方: `!proposal <案件内容>`\n\n' +
        '例:\n```\n!proposal ExcelのVBAマクロで月次集計を自動化してほしい\n```\n\n' +
        '> ⚠️ 生成された返信は CEO 確認後に送信してください。'
      ).catch(() => {});
      return;
    }
    const result = buildProposal(projText);
    await message.reply(result.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !scope — 作業範囲肥大防止
  if (content.startsWith('!scope')) {
    const { checkScopeCreep } = require('./utils/client-ops');
    const scopeInput = content.slice('!scope'.length).trim();
    if (!scopeInput || !scopeInput.includes('|')) {
      await message.reply(
        '**!scope — 作業範囲チェック**\n\n' +
        '使い方: `!scope <元の仕様> | <追加依頼>`\n\n' +
        '例:\n```\n!scope CSVをグラフ化するExcelマクロを作る | ついでにメール送信機能も追加してほしい\n```'
      ).catch(() => {});
      return;
    }
    const sepIdx  = scopeInput.indexOf('|');
    const original  = scopeInput.slice(0, sepIdx).trim();
    const newReq    = scopeInput.slice(sepIdx + 1).trim();
    const result    = checkScopeCreep(original, newReq);
    await message.reply(result.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !delivery — 納品チェックリスト
  if (content.startsWith('!delivery')) {
    const { buildDeliveryChecklist } = require('./utils/client-ops');
    const args     = content.split(/\s+/).slice(1);
    const sub      = args[0] || '';
    if (sub !== 'check') {
      await message.reply(
        '**!delivery — 納品チェック**\n\n' +
        '使い方: `!delivery check [プロジェクト名]`\n\n' +
        '例: `!delivery check CSV自動集計ツール`'
      ).catch(() => {});
      return;
    }
    const projName = args.slice(1).join(' ') || '（プロジェクト名未指定）';
    const result   = buildDeliveryChecklist(projName);
    await message.reply(result.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !change — 日次更新ログ記録
  if (content.startsWith('!change')) {
    const dc   = require('./utils/daily-changes');
    const args = content.split(/\s+/).slice(1);
    const sub  = args[0] || 'help';

    // !change list
    if (sub === 'list') {
      const r = dc.listChanges();
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !change clear — Owner のみ（pending/promote より先に置き Owner チェックを 800 文字以内に収める）
    if (sub === 'clear') {
      if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 `!change clear` は Owner のみ実行できます。').catch(() => {});
        return;
      }
      const r = dc.clearChanges();
      await message.reply(r.text).catch(() => {});
      return;
    }

    // !change pending
    if (sub === 'pending') {
      const r = dc.listPending();
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !change promote <id>
    if (sub === 'promote') {
      const id = args[1];
      if (!id) {
        await message.reply('使い方: `!change promote <id>`\n例: `!change promote 3`').catch(() => {});
        return;
      }
      const r = dc.promoteRule(id);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !change <type> <内容>
    if (dc.VALID_TYPES.includes(sub)) {
      const changeText = args.slice(1).join(' ').trim();
      if (!changeText) {
        await message.reply(
          `使い方: \`!change ${sub} <内容>\`\n例: \`!change ${sub} 詳細をここに記入\``
        ).catch(() => {});
        return;
      }
      const r = dc.addChange(sub, changeText);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // ヘルプ
    await message.reply(
      '**!change コマンド — 日次更新ログ**\n\n' +
      '```\n' +
      '!change command <内容>   → コマンド追加・変更を記録\n' +
      '!change rule <内容>      → ルール変更を記録\n' +
      '!change ops <内容>       → 運用変更を記録\n' +
      '!change category <内容>  → カテゴリ変更を記録\n' +
      '!change channel <内容>   → チャンネル変更を記録\n' +
      '!change list             → 今日の更新一覧\n' +
      '!change pending          → 保留中ルール一覧\n' +
      '!change promote <id>     → 保留ルールを正式登録\n' +
      '!change clear            → 今日のログをクリア（Owner）\n' +
      '```'
    ).catch(() => {});
    return;
  }

  // ─────────────────────────────────────────────────────
  // !decision — Decision Log Manager（会社脳 Phase）
  // 共通エンベロープ仕様 docs/envelope-spec.md 参照
  //
  // !decision log <title>              — 意思決定を記録
  // !decision log <title> | <summary>  — タイトル+サマリーで記録
  // !decision log ... refs:id1 tags:x  — refs / tags 付き
  // !decision list                     — 最近10件を一覧
  // !decision show <id>                — 詳細表示
  // ─────────────────────────────────────────────────────
  if (content.startsWith('!decision')) {
    const decLog  = require('./utils/decision-log');
    const decArgs = content.split(/\s+/).slice(1);
    const decSub  = decArgs[0] || 'help';

    if (decSub === 'log') {
      const rawText = decArgs.slice(1).join(' ').trim();
      if (!rawText) {
        await message.reply(
          '**!decision log — 意思決定を記録**\n\n' +
          '```\n' +
          '!decision log <タイトル>\n' +
          '!decision log <タイトル> | <サマリー>\n' +
          '!decision log <タイトル> | <サマリー> refs:task_xxx tags:security\n' +
          '```\n\n' +
          '既存のタスク・レビュー・commitはコピーせず refs で参照してください。\n' +
          '`!decision list` で記録一覧を確認できます。'
        ).catch(() => {});
        return;
      }
      const { title, summary, refs, tags } = decLog.parseLogArgs(rawText);
      const currentDecPid = projectManager.getCurrentProject(message.channelId) || 'default';
      const r = decLog.logDecision({ title, summary, projectId: currentDecPid, refs, tags });
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (decSub === 'list') {
      const r = decLog.listDecisions(10);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (decSub === 'show') {
      const decId = decArgs[1] || '';
      const r = decLog.showDecision(decId);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // ヘルプ
    await message.reply(
      '**!decision — 意思決定ログ**\n\n' +
      '```\n' +
      '!decision log <タイトル>                    → 記録\n' +
      '!decision log <タイトル> | <サマリー>        → サマリー付きで記録\n' +
      '!decision log ... refs:task_xxx tags:sec    → refs/tags付き\n' +
      '!decision list                              → 直近10件\n' +
      '!decision show <ID>                         → 詳細表示\n' +
      '```\n\n' +
      '仕様: `docs/envelope-spec.md`'
    ).catch(() => {});
    return;
  }

  // ─────────────────────────────────────────────────────
  // !incident — Incident Manager MVP（会社脳 Phase）
  // 共通エンベロープ仕様 docs/envelope-spec.md 参照
  //
  // !incident open <要約>              — 起票
  // !incident open <要約> | <詳細>     — 詳細付き起票
  // !incident open ... refs:id tags:x  — refs/tags 付き
  // !incident list                     — 未解決一覧
  // !incident list all                 — 全件一覧
  // !incident show <id>                — 詳細表示
  // !incident resolve <id> <対応内容>  — 解決・Lesson化候補提示
  //
  // ※ error-alert / review-history との二重通知なし
  // ─────────────────────────────────────────────────────
  if (content.startsWith('!incident')) {
    const incMgr  = require('./utils/incident-manager');
    const incArgs = content.split(/\s+/).slice(1);
    const incSub  = incArgs[0] || 'help';

    if (incSub === 'open') {
      const rawText = incArgs.slice(1).join(' ').trim();
      if (!rawText) {
        await message.reply(
          '**!incident open — インシデント起票**\n\n' +
          '```\n' +
          '!incident open <要約>\n' +
          '!incident open <要約> | <詳細>\n' +
          '!incident open <要約> | <詳細> refs:task_xxx tags:security\n' +
          '```\n\n' +
          '起票後は `!incident resolve <id> <対応内容>` で解決できます。'
        ).catch(() => {});
        return;
      }
      const { title, summary, refs, tags } = incMgr.parseArgs(rawText);
      const incPid = projectManager.getCurrentProject(message.channelId) || 'default';
      const r = incMgr.openIncident({ title, summary, projectId: incPid, refs, tags });
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (incSub === 'list') {
      const showAll = (incArgs[1] || '') === 'all';
      const r = incMgr.listIncidents({ all: showAll });
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (incSub === 'show') {
      const incId = incArgs[1] || '';
      const r = incMgr.showIncident(incId);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (incSub === 'resolve') {
      const incId     = incArgs[1] || '';
      const resTxt    = incArgs.slice(2).join(' ').trim();
      const r = incMgr.resolveIncident(incId, resTxt);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // ヘルプ
    await message.reply(
      '**!incident — インシデントログ**\n\n' +
      '```\n' +
      '!incident open <要約>                  → 起票\n' +
      '!incident open <要約> | <詳細>          → 詳細付き起票\n' +
      '!incident open ... refs:t_xxx tags:sec → refs/tags付き\n' +
      '!incident list                         → 未解決一覧\n' +
      '!incident list all                     → 全件一覧\n' +
      '!incident show <ID>                    → 詳細表示\n' +
      '!incident resolve <ID> <対応内容>      → 解決・Lesson候補表示\n' +
      '```\n\n' +
      '仕様: `docs/envelope-spec.md`'
    ).catch(() => {});
    return;
  }

  // ─────────────────────────────────────────────────────
  // !inbox — Desktop Inbox Bridge（黒川 Phase2）
  //
  // ChatGPT Desktop メモを分類し実行候補を提案する。
  // 自動実行しない。提案まで。
  //
  // !inbox check  — incoming.md を分析してレポート生成
  // !inbox status — Inbox の状態確認
  // !inbox clear  — incoming.md をクリア（Owner 限定）
  // !inbox help   — コマンド一覧
  // ─────────────────────────────────────────────────────
  if (content.startsWith('!inbox')) {
    const inboxBridge = require('./utils/inbox-bridge');
    const inboxArgs   = content.split(/\s+/).slice(1);
    const inboxSub    = inboxArgs[0] || 'help';

    // check — Phase2: gpt inbox / Phase3: worker inbox
    if (inboxSub === 'check') {
      const workerArg = inboxArgs[1] || '';
      if (workerArg) {
        // Phase3: !inbox check <worker>
        const r = inboxBridge.checkWorkerInbox(workerArg);
        await message.reply(r.text.slice(0, 1900)).catch(() => {});
      } else {
        // Phase2: !inbox check (gpt)
        const r = inboxBridge.checkInbox();
        await message.reply(r.text.slice(0, 1900)).catch(() => {});
      }
      return;
    }

    // send — Phase3: !inbox send <worker> <message>
    if (inboxSub === 'send') {
      const workerArg = inboxArgs[1] || '';
      const msgBody   = inboxArgs.slice(2).join(' ').trim();
      if (!workerArg || !msgBody) {
        await message.reply(
          '**使い方**\n```\n!inbox send <社員> <内容>\n```\n\n' +
          '例: `!inbox send miyagi Phase1の実装をお願いします`\n\n' +
          `有効な社員: ${inboxBridge.VALID_WORKERS.join(' / ')}`
        ).catch(() => {});
        return;
      }
      const r = inboxBridge.sendToWorker(workerArg, msgBody);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // status — Phase2+3 統合ステータス
    if (inboxSub === 'status') {
      const gptStatus    = inboxBridge.getStatus();
      const workerStatus = inboxBridge.getWorkerStatus();
      const combined     = gptStatus.text + '\n\n' + workerStatus.text;
      await message.reply(combined.slice(0, 1900)).catch(() => {});
      return;
    }

    // clear — Phase2 gpt inbox のみ（Owner 限定）
    if (inboxSub === 'clear') {
      if (DISCORD_OWNER_ID && message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 `!inbox clear` は Owner のみ実行できます。').catch(() => {});
        return;
      }
      const r = inboxBridge.clearInbox();
      await message.reply(r.text).catch(() => {});
      return;
    }

    // help
    await message.reply(
      '**!inbox — Desktop Inbox Bridge（黒川 Phase2+3）**\n\n' +
      '```\n' +
      '!inbox check             → GPT inbox を分析（Phase2）\n' +
      '!inbox check <社員>      → 社員 inbox を分析（Phase3）\n' +
      '!inbox send <社員> <内容> → 社員への依頼を outbox に保存\n' +
      '!inbox status            → 全体の inbox/outbox 状態確認\n' +
      '!inbox clear             → GPT incoming.md をクリア（Owner）\n' +
      '```\n\n' +
      `有効な社員: ${inboxBridge.VALID_WORKERS.join(' / ')}\n\n` +
      '⚠️ 黒川は**提案のみ**。自動実行しません。\n' +
      '詳細ルール: `docs/vp-room-operations.md`'
    ).catch(() => {});
    return;
  }

  // ─────────────────────────────────────────────────────
  // !msg — 社内メッセージ配送（黒川 Chief of Staff）
  //
  // 黒川の役割: 配送・進行管理のみ。判断の代理は禁止。
  //
  // !msg send <to> <内容>   — 送信 (WAITING_REPLY)
  // !msg list               — 返信待ち一覧
  // !msg list all           — 全件一覧
  // !msg show <id>          — 詳細
  // !msg reply <id> <返信>  — 返信 (→ REPLIED)
  // !msg close <id>         — クローズ (→ CLOSED)
  // !msg pending            — 黒川レポート: 誰が誰の返信待ちか
  // ─────────────────────────────────────────────────────
  if (content.startsWith('!msg')) {
    const msgMod  = require('./utils/internal-messages');
    const msgArgs = content.split(/\s+/).slice(1);
    const msgSub  = msgArgs[0] || 'help';

    // send
    if (msgSub === 'send') {
      const toRaw   = msgArgs[1] || '';
      const bodyRaw = msgArgs.slice(2).join(' ').trim();
      if (!toRaw || !bodyRaw) {
        await message.reply(
          '**使い方**\n```\n!msg send <宛先> <内容>\n```\n\n' +
          '**宛先エイリアス:**\n' +
          '`miyagi/宮城/A` `moriya/守谷/B` `shiraishi/白石/C`\n' +
          '`aizawa/相沢/D` `ichikawa/市川/E` `kanemori/金森/F`\n' +
          '`kurokawa/黒川/G` `ikuno/育野/H` `ceo/CEO`'
        ).catch(() => {});
        return;
      }
      // 送信者は Discord ユーザーID から解決できないため "ceo" をデフォルトとし、
      // 将来的にユーザーマッピングで自動解決する
      const r = msgMod.sendMessage({ from: 'ceo', to: toRaw, content: bodyRaw });
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // list / list all
    if (msgSub === 'list') {
      const showAll = (msgArgs[1] || '') === 'all';
      const r = msgMod.listMessages({ all: showAll });
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // show
    if (msgSub === 'show') {
      const msgId = msgArgs[1] || '';
      const r     = msgMod.showMessage(msgId);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // reply
    if (msgSub === 'reply') {
      const msgId    = msgArgs[1] || '';
      const replyTxt = msgArgs.slice(2).join(' ').trim();
      const r        = msgMod.replyMessage(msgId, replyTxt);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // close
    if (msgSub === 'close') {
      const msgId = msgArgs[1] || '';
      const r     = msgMod.closeMessage(msgId);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // pending — 黒川レポート
    if (msgSub === 'pending') {
      const r = msgMod.pendingReport();
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // help
    await message.reply(
      '**!msg — 社内メッセージ配送（黒川 Chief of Staff）**\n\n' +
      '```\n' +
      '!msg send <宛先> <内容>       → 送信\n' +
      '!msg list                    → 返信待ち一覧\n' +
      '!msg list all                → 全件一覧\n' +
      '!msg show <ID>               → 詳細表示\n' +
      '!msg reply <ID> <返信>        → 返信\n' +
      '!msg close <ID>              → クローズ\n' +
      '!msg pending                 → 返信待ちレポート\n' +
      '```\n\n' +
      '**宛先エイリアス:**\n' +
      '`miyagi/宮城/A` `moriya/守谷/B` `shiraishi/白石/C`\n' +
      '`aizawa/相沢/D` `ichikawa/市川/E` `kanemori/金森/F`\n' +
      '`kurokawa/黒川/G` `ikuno/育野/H` `ceo/CEO`\n\n' +
      '⚠️ 黒川は配送・進行管理のみ。判断の代理は禁止。'
    ).catch(() => {});
    return;
  }

  // !workflow messages — !msg pending の別名（黒川レポート）
  if (content === '!workflow messages' || content.startsWith('!workflow messages')) {
    const msgMod = require('./utils/internal-messages');
    const r      = msgMod.pendingReport();
    await message.reply(r.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !close — 日次クロージング（更新ログ付き）
  if (content === '!close' || /^!close\b/.test(content)) {
    const { buildClosingSummary } = require('./utils/client-ops');
    const { buildChangesSection } = require('./utils/daily-changes');
    const currentPid = projectManager.getCurrentProject(message.channelId);
    const result     = buildClosingSummary({
      taskManager,
      projectManager,
      projectId: currentPid || undefined,
    });
    const changesSection = buildChangesSection();
    const fullText =
      `📅 **Daily Closing Report**\n\n` +
      result.text + '\n\n' +
      '━━━━━━━━━━━━━━━━\n\n' +
      changesSection;
    await message.reply(fullText.slice(0, 1900)).catch(() => {});
    return;
  }

  // ─── コトノハ Store Growth Manager (Phase 4) ─────────

  // !store — 出品ページ監査
  if (content.startsWith('!store')) {
    const sg = require('./utils/store-growth');
    const storeArgs = content.split(/\s+/).slice(1);
    const storeSub  = storeArgs[0] || 'help';
    if (storeSub === 'audit') {
      const pageText = storeArgs.slice(1).join(' ').trim();
      if (!pageText) {
        await message.reply('使い方: `!store audit <出品文>`\n例: `!store audit CSV集計を自動化します。`').catch(() => {});
        return;
      }
      const r = sg.auditStorePage(pageText);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }
    await message.reply('**!store コマンド**\n\n`!store audit <出品文>` — 出品ページ監査').catch(() => {});
    return;
  }

  // !persona — 顧客ペルソナ分析
  if (content.startsWith('!persona')) {
    const { buildPersona } = require('./utils/store-growth');
    const persText = content.slice('!persona'.length).trim();
    if (!persText) {
      await message.reply('使い方: `!persona <サービス説明>`\n例: `!persona CSV集計を自動化するExcelマクロ`').catch(() => {});
      return;
    }
    const r = buildPersona(persText);
    await message.reply(r.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !faq — FAQ 生成
  if (content.startsWith('!faq')) {
    const { buildFAQ } = require('./utils/store-growth');
    const faqText = content.slice('!faq'.length).trim();
    if (!faqText) {
      await message.reply('使い方: `!faq <サービス説明>`\n例: `!faq Excel自動集計マクロ`').catch(() => {});
      return;
    }
    const r = buildFAQ(faqText);
    await message.reply(r.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !inquiry — 問い合わせ分析
  if (content.startsWith('!inquiry')) {
    const { analyzeInquiry } = require('./utils/store-growth');
    const iqText = content.slice('!inquiry'.length).trim();
    if (!iqText) {
      await message.reply('使い方: `!inquiry <問い合わせ文>`\n例: `!inquiry CSV集計を依頼したいのですが料金を教えてください`').catch(() => {});
      return;
    }
    const r = analyzeInquiry(iqText);
    await message.reply(r.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !sales — 営業学習データ管理
  if (content.startsWith('!sales')) {
    const sg = require('./utils/store-growth');
    const salesArgs = content.split(/\s+/).slice(1);
    const salesSub  = salesArgs[0] || 'help';

    if (salesSub === 'learn') {
      const resultText = salesArgs.slice(1).join(' ').trim();
      if (!resultText) {
        await message.reply(
          '使い方: `!sales learn <結果>`\n例: `!sales learn 成約。CSV集計で初案件。要件が明確だとスムーズ`\n\n> ⚠️ 個人情報・秘密情報は自動的にマスクされます。'
        ).catch(() => {});
        return;
      }
      const r = sg.recordSalesLesson(resultText);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    if (salesSub === 'list') {
      const r = sg.listSalesLessons();
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    await message.reply(
      '**!sales コマンド**\n\n' +
      '`!sales learn <結果>` — 営業結果を学習データとして保存\n' +
      '`!sales list` — 蓄積データ一覧\n\n' +
      '> ⚠️ 個人情報・顧客名・連絡先は自動マスクされます。'
    ).catch(() => {});
    return;
  }

  // ─── コトノハ案件対応コマンド (Phase 2) ─────────────

  // !client — Client Project Tracker / Timeline / Review
  if (content.startsWith('!client')) {
    const ct = require('./utils/client-tracker');
    const { guardDiscordContent } = require('./utils/secret-guardian');
    const args = content.split(/\s+/).slice(1);
    const sub  = args[0] || 'help';

    // !client create <name>
    if (sub === 'create') {
      const name = args.slice(1).join(' ').trim();
      if (!name) {
        await message.reply('使い方: `!client create <案件名>`\n例: `!client create CSV自動集計ツール`').catch(() => {});
        return;
      }
      const r = ct.createProject(name);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !client list
    if (sub === 'list') {
      const r = ct.listProjects();
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !client show <id>
    if (sub === 'show') {
      const id = args[1] || '';
      if (!id) { await message.reply('使い方: `!client show <id>`').catch(() => {}); return; }
      const r = ct.showProject(id);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !client update <id> <STATUS>
    if (sub === 'update') {
      const id        = args[1] || '';
      const newStatus = args[2] || '';
      if (!id || !newStatus) {
        await message.reply(
          '使い方: `!client update <id> <STATUS>`\n' +
          'STATUS: INQUIRY / REQUIREMENT / DEVELOPING / REVIEW / DELIVERED / CLOSED'
        ).catch(() => {});
        return;
      }
      const r = ct.updateProjectStatus(id, newStatus);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !client note <id> <内容>
    if (sub === 'note') {
      const id      = args[1] || '';
      const noteRaw = args.slice(2).join(' ').trim();
      if (!id || !noteRaw) {
        await message.reply('使い方: `!client note <id> <内容>`\n例: `!client note cli_xxx CSV形式はA案で確定`').catch(() => {});
        return;
      }
      // Secret Guardian でノート内容を検査（秘密情報を混入させない）
      const guard = guardDiscordContent(noteRaw, { type: 'clientNote' });
      if (!guard.allowed) {
        await message.reply(
          '🚨 **Secret Guardian — メモへの秘密情報混入を防止**\n\n' +
          'メモ内容に秘密情報と思われる文字列が含まれています。\n' +
          'APIキー・トークン・個人情報は保存できません。'
        ).catch(() => {});
        return;
      }
      const r = ct.addNote(id, noteRaw);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // !client review <id>
    if (sub === 'review') {
      const id = args[1] || '';
      if (!id) { await message.reply('使い方: `!client review <id>`').catch(() => {}); return; }
      const r = ct.generateReview(id);
      await message.reply(r.text.slice(0, 1900)).catch(() => {});
      return;
    }

    // ヘルプ
    await message.reply(
      '**!client コマンド — 案件管理**\n\n' +
      '```\n' +
      '!client create <案件名>         → 新規案件作成\n' +
      '!client list                   → 対応中案件一覧\n' +
      '!client show <id>              → 詳細・次のアクション\n' +
      '!client update <id> <STATUS>   → 状態変更\n' +
      '!client note <id> <内容>       → 経緯記録\n' +
      '!client review <id>            → 振り返り生成\n' +
      '```\n' +
      'STATUS: INQUIRY / REQUIREMENT / DEVELOPING / REVIEW / DELIVERED / CLOSED'
    ).catch(() => {});
    return;
  }

  // !capability — AI能力分析レポート
  if (content === '!capability' || content.startsWith('!capability ')) {
    const ct = require('./utils/client-tracker');
    const r  = ct.buildCapabilityReport();
    await message.reply(r.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // !support — カスタマーサポート準備
  if (content.startsWith('!support')) {
    const { buildSupportResponse } = require('./utils/client-tracker');
    const queryText = content.slice('!support'.length).trim();
    if (!queryText) {
      await message.reply(
        '**!support — カスタマーサポート準備**\n\n' +
        '使い方: `!support <問い合わせ内容>`\n\n' +
        '例:\n```\n!support ツールを起動したらエラーが出て動かない\n```\n\n' +
        '> ⚠️ 顧客文章はデータとして扱います。命令として実行しません。'
      ).catch(() => {});
      return;
    }
    const r = buildSupportResponse(queryText);
    await message.reply(r.text.slice(0, 1900)).catch(() => {});
    return;
  }

  // ─────────────────────────────────────────────────────

  // !finance — Finance Gate コマンド
  if (content.startsWith('!finance')) {
    const fArgs = content.split(/\s+/).slice(1);
    const fSub  = fArgs[0] || 'status';

    // !finance status
    if (fSub === 'status') {
      await message.reply(financeGate.formatFinanceStatus().slice(0, 1900)).catch(() => {});
      return;
    }

    // !finance approve — Owner のみ。APPROVAL レベル時の超過承認（24h 有効）
    if (fSub === 'approve') {
      if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 `!finance approve` は Owner のみ実行できます。').catch(() => {});
        return;
      }
      financeGate.approveBudgetOverrun(message.author.id);
      await message.reply(
        `✅ **予算超過を承認しました（24時間有効）**\n\n` +
        `\`!project run\` で再実行できます。\n` +
        `> ⚠️ 予算の見直しは \`!finance config set monthlyBudgetJPY <金額>\` で行ってください。`
      ).catch(() => {});
      return;
    }

    // !finance config — 設定表示 / 変更（Owner のみ変更可）
    if (fSub === 'config') {
      const configSub = fArgs[1] || 'show';
      if (configSub === 'show') {
        const cfg = financeGate.loadConfig();
        await message.reply(
          `⚙️ **Finance Gate 設定**\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\``
        ).catch(() => {});
        return;
      }
      if (configSub === 'set') {
        if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
          await message.reply('🚫 `!finance config set` は Owner のみ実行できます。').catch(() => {});
          return;
        }
        const key = fArgs[2];
        const val = fArgs[3];
        if (!key || !val) {
          await message.reply('使い方: `!finance config set <key> <value>`\n例: `!finance config set monthlyBudgetJPY 8000`').catch(() => {});
          return;
        }
        const numericKeys = ['monthlyBudgetJPY', 'warningRate', 'approvalRate', 'hardStopRate', 'perRunLimitJPY'];
        const boolKeys    = ['enabled'];
        const cfg = financeGate.loadConfig();
        if (numericKeys.includes(key)) {
          cfg[key] = parseFloat(val);
        } else if (boolKeys.includes(key)) {
          cfg[key] = val === 'true';
        } else {
          await message.reply(`❌ 不明なキー: \`${key}\``).catch(() => {});
          return;
        }
        financeGate.saveConfig(cfg);
        await message.reply(`✅ **設定更新** \`${key}\` = \`${cfg[key]}\``).catch(() => {});
        logger.info(`[FinanceGate] 設定変更: ${key}=${cfg[key]} | by:${message.author.id}`);
        return;
      }
    }

    // !finance reset-approval — Owner のみ
    if (fSub === 'reset-approval') {
      if (!DISCORD_OWNER_ID || message.author.id !== DISCORD_OWNER_ID) {
        await message.reply('🚫 Owner のみ').catch(() => {});
        return;
      }
      financeGate.resetApproval();
      await message.reply('✅ Finance Gate 承認をリセットしました。').catch(() => {});
      return;
    }

    // ヘルプ
    await message.reply(
      '**!finance コマンド:**\n```\n' +
      '!finance status              → 予算状況表示\n' +
      '!finance approve             → 予算超過を承認（Owner・24h有効）\n' +
      '!finance config show         → 設定確認\n' +
      '!finance config set <k> <v>  → 設定変更（Owner）\n' +
      '!finance reset-approval      → 承認リセット（Owner）\n' +
      '```'
    ).catch(() => {});
    return;
  }

  if (content.startsWith('!restart')) {
    const args = content.split(/\s+/).slice(1);
    await handleRestart(message, args);
    return;
  }

  if (content.startsWith('!approve')) {
    const taskId = content.split(/\s+/)[1] || '';
    await handleApprove(message, taskId);
    return;
  }

  if (content.startsWith('!deny')) {
    const taskId = content.split(/\s+/)[1] || '';
    await handleDeny(message, taskId);
    return;
  }

  if (content.startsWith('!pause')) {
    const taskId = content.split(/\s+/)[1] || '';
    await handlePause(message, taskId);
    return;
  }

  if (content.startsWith('!resume')) {
    const taskId = content.split(/\s+/)[1] || '';
    await handleResume(message, taskId);
    return;
  }

  if (content.startsWith('!worker')) {
    await handleWorker(message, content);
    return;
  }

  if (content.startsWith('!company')) {
    const compArgs = content.slice('!company'.length).trim().split(/\s+/).filter(Boolean);
    const compSub  = compArgs[0] || '';
    if (compSub === 'staff') {
      await handleCompanyStaff(message, compArgs.slice(1));
      return;
    }
    if (compSub === 'assign') {
      await handleCompanyAssign(message, compArgs.slice(1));
      return;
    }
    await message.reply(
      '**!company の使い方**\n```\n' +
      '!company staff                        → 現在プロジェクトの推奨人員を表示\n' +
      '!company staff <project>              → 指定プロジェクトの推奨人員を表示\n' +
      '!company assign                       → 推奨人員を現在プロジェクトに適用\n' +
      '!company assign --preview             → 変更のプレビュー（実変更なし）\n' +
      '!company assign <project>             → 指定プロジェクトに適用\n' +
      '!company assign <project> --preview   → 指定プロジェクトをプレビュー\n' +
      '```'
    );
    return;
  }

  if (content.startsWith('!quality')) {
    const qualArgs = content.slice('!quality'.length).trim().split(/\s+/).filter(Boolean);
    await handleQuality(message, qualArgs);
    return;
  }

  if (content.startsWith('!codex')) {
    const userContent = content.slice('!codex'.length).trim();
    await handleCodex(message, userContent);
    return;
  }

  // ── CEO Command Layer Phase 2 ──
  if (content.startsWith('!ceo')) {
    const ceoArgs = content.slice('!ceo'.length).trim().split(/\s+/).filter(Boolean);
    await handleCeo(message, ceoArgs);
    return;
  }

  if (!content.startsWith('!claude')) return;

  // ─────────────────────────────────────────────────
  // !claude コマンドのメイン処理
  // ─────────────────────────────────────────────────
  const projectId = projectDetector.detectProjectId(message.channel);
  const prompt = content.slice('!claude'.length).trim();

  if (!prompt) {
    await message.reply(
      '**使い方**\n```\n!claude <やりたいこと>\n```\n' +
      '**その他コマンド**\n```\n!help\n```'
    ).catch(() => {});
    return;
  }

  const sec = security.checkPrompt(prompt);
  if (!sec.safe) {
    logger.warn(`セキュリティブロック: ${sec.reason}`);
    await message.reply(`🚫 **セキュリティチェックで拒否**\n理由: ${sec.reason}`).catch(() => {});
    return;
  }

  // ─── 既存タスク継続モード検出 ───
  // "task_1234567890 続行してください" 形式を検出して既存ワークスペースを再利用
  const continueMatch = prompt.match(/^(task_\d+)\s+(.+)$/s);
  let refTaskId       = null;
  let refWorkspace    = null;
  if (continueMatch) {
    const candidateId  = continueMatch[1];
    const candidateDir = path.join(WORKSPACE_PATH, candidateId);
    if (fs.existsSync(candidateDir)) {
      refTaskId   = candidateId;
      refWorkspace = candidateDir;
      logger.info(`継続モード: ${candidateId} のワークスペースを再利用`);
    }
  }

  // ─── TaskSize バリデーション（実行前・分割提案）───
  const taskSizeResult = taskTypeUtil.estimateTaskSize(prompt);
  if (taskSizeResult.size === taskTypeUtil.TASK_SIZES.LARGE) {
    const splitMsg = taskTypeUtil.buildSplitSuggestion(prompt, taskSizeResult);
    await message.reply(splitMsg).catch(() => {});
    return; // 大きすぎるタスクは実行しない
  }

  // ─── TaskType 判定 ───
  const taskType = taskTypeUtil.detectTaskType(prompt);

  // ─── 実行前危険度チェック ───
  // 高危険度 (delete / credential / auth 等) は承認が必要
  const preDanger = codex.assessDanger(prompt, '', []);

  // Phase5: タスクキューへ追加
  const taskId        = `task_${Date.now()}`;
  // 継続モードなら既存ワークスペースを使う（新規は project 別パスを使用）
  const taskWorkspace = refWorkspace || path.join(WORKSPACE_PATH, projectId, taskId);
  const timeoutMin    = Math.floor((parseInt(process.env.TASK_TIMEOUT_SECONDS) || 300) / 60);

  // Phase4: タスクを作成（危険度・projectId を反映）
  taskManager.createTask(prompt, message.author.id, taskId, preDanger === '高' ? '高' : '低', projectId);

  // ─── Claude Code 実行本体（!claude / !run-next 共通）───
  // completionValidator・AIレビュー・Codex 等の全安全機能は
  // executeClaudeTask() で一元管理される
  const executeTask = async () => executeClaudeTask({
    message, prompt, taskId, projectId, taskType, taskSizeResult,
    taskWorkspace, refTaskId, source: 'claude',
  });

  // ─── 高危険度: 承認待ちへ移行（自動実行禁止）───
  if (preDanger === '高') {
    // 承認されたら taskQueue.enqueue(taskId, executeTask) を呼び出す
    pendingExecutions.set(taskId, () => taskQueue.enqueue(taskId, executeTask));

    approvalManager.createApproval(taskId, {
      reason:    `高危険度の操作: ${prompt.slice(0, 60)}`,
      danger:    '高',
      prompt,
      projectId, // 元チャンネルの projectId を保存（Bot再起動後の再実行時に使用）
      channelId: message.channelId,
      authorTag: message.author.tag,
      type:      'pre',
    });

    const approvalInfo = approvalManager.getApproval(taskId);
    await message.reply(
      `🔴 **【確認待ち】高危険度の操作が検出されました**\n\n` +
      `${approvalManager.formatApproval(approvalInfo)}`
    ).catch(() => {});
    return; // 承認まで実行しない
  }

  // ─── 通常: 即時キューに追加 ───
  const queuePos = taskQueue.enqueue(taskId, executeTask);

  // Phase5: キューに積まれた場合はここで通知して終了
  if (queuePos > 0) {
    await message.reply(
      `📋 **キューに追加しました（待機 ${queuePos} 番目）**\n` +
      `\`\`\`\nタスクID : ${taskId}\n指示内容 : ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\n\`\`\`\n` +
      `現在 ${taskQueue.activeCount} 件処理中です。完了次第、自動で実行します。\n` +
      `\`!queue\` でキュー状況を確認できます。`
    ).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────
// エラーハンドリング
// ─────────────────────────────────────────────────────
client.on('error', err => logger.error(`Discord エラー: ${err.message}`));
process.on('unhandledRejection', r => logger.error(`未処理 Promise: ${r}`));
process.on('uncaughtException', e => logger.error(`予期しないエラー（継続）: ${e.message}`));

// ─── プロセス終了時に起動ロックを解放 ───
process.on('exit',    () => restartManager.releaseStartupLock());
process.on('SIGTERM', () => { restartManager.releaseStartupLock(); process.exit(0); });
process.on('SIGINT',  () => { restartManager.releaseStartupLock(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
// 【多重起動防止】Discord に接続する前にロックを確認・取得する
//
// 重要: ready イベント内でチェックしていた旧実装には
//   「全プロセスが接続してからロック競合」という致命的な race condition があった。
//   client.login() の前にチェックすることで、
//   ロック取得に失敗したプロセスは Discord に接続すらしない。
// ═══════════════════════════════════════════════════════════
{
  const lockResult = restartManager.acquireStartupLock();
  if (!lockResult.ok) {
    logger.error(
      `[LOCK] 多重起動を検出しました (既存PID: ${lockResult.existingPid})。` +
      `Discordに接続せずに終了します。`
    );
    process.exit(1);
  }
}

// Discord ログイン
client.login(DISCORD_TOKEN).catch(err => {
  console.error('\n❌ Discord ログイン失敗:', err.message);
  if (err.message.includes('TOKEN_INVALID')) {
    console.error('   DISCORD_TOKEN が無効です。');
  } else if (err.message.includes('DISALLOWED_INTENTS')) {
    console.error('   Developer Portal → Bot → MESSAGE CONTENT INTENT をONにしてください。');
  }
  process.exit(1);
});
