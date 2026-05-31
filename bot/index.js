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

// ─── Approval（承認管理）───
const approvalManager = require('./utils/approval-manager');

// ─── Project 判定 ───
const projectDetector    = require('./utils/project-detector');
const projectManager     = require('./utils/project-manager');
const autoProjectRunner  = require('./utils/auto-project-runner');
const autoPolicy         = require('./utils/auto-policy');

// ─── Phase E-5b: Worker Role ───
const workerRegistry  = require('./utils/worker-registry');
const companyManager  = require('./utils/company-manager');
const qualityGate     = require('./utils/quality-gate');

// 承認待ちの実行待機Map: taskId → () => void
// ※ Bot 再起動で消える設計（意図的割り切り）
const pendingExecutions = new Map();

// Phase F-0/F-1: !project run の RunContext Map
// key: projectId, value: RunContext（実行中状態を保持）
const activeRuns = new Map();

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
    tasksDone:         0,
    tasksFailed:       0,
    consecutiveErrors: 0,
    yellowCount:       0,

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

const NOTIFICATION_CHANNELS = Object.freeze({
  history:     HISTORY_CHANNEL_ID,
  aiReview:    AI_REVIEW_CHANNEL_ID,
  codexReview: CODEX_REVIEW_CHANNEL_ID,
  error:       ERROR_CHANNEL_ID,
  meeting:     MEETING_CHANNEL_ID,
  git:         GITHUB_LOG_CHANNEL_ID,
  pr:          PR_CHANNEL_ID,
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
  const targetChannelId = options.channelType ? NOTIFICATION_CHANNELS[options.channelType] : '';

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

  const mentionMessage =
    `<@${DISCORD_OWNER_ID}>\n\n` +
    `【確認してほしいこと】\n\n${title}\n\n` +
    `【何が起きる？】\n\n${detail}\n\n` +
    (options.merits    ? `【メリット】\n\n${options.merits}\n\n`    : '') +
    (options.demerits  ? `【デメリット】\n\n${options.demerits}\n\n` : '') +
    `【おすすめ】\n\nおすすめ: ${recommended}\n\n` +
    `【危険度】\n\n${dangerEmoji} ${danger}\n\n` +
    `（タスクID: \`${taskId}\`）\n` +
    `✅ 承認: \`!approve ${taskId}\`　❌ 却下: \`!deny ${taskId}\``;

  try {
    if (options.channelType) {
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
// !help コマンド
// ─────────────────────────────────────────────────────
async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🤖 AI_WORKER Bot コマンド一覧 (Phase5)')
    .addFields(
      {
        name: '!claude <指示>',
        value: 'Claude Code に作業を依頼します\n例: `!claude Pythonでfizzbuzzを書いて`',
        inline: false,
      },
      {
        name: '!codex <内容>',
        value: [
          'スマホから直接 Codex（GPT-4o）にレビューを依頼します',
          '`OPENAI_API_KEY` が設定済みなら自動でレビュー結果を表示します',
          '未設定の場合は手動貼り付け用ファイルを `reviews/` に保存します',
          '例: `!codex このエラーの直し方を教えて: TypeError: Cannot read properties of undefined`',
        ].join('\n'),
        inline: false,
      },
      {
        name: '!task [サブコマンド]',
        value: [
          'タスクを管理します',
          '`!task list` — タスク一覧（優先度順）',
          '`!task <タスクID>` — タスク詳細',
          '`!task done <タスクID>` — タスクを完了にする',
          '`!task hold <タスクID>` — タスクを保留にする',
          '`!task resume <タスクID>` — 保留タスクを未着手に戻す',
          '`!task stats` — タスク統計',
        ].join('\n'),
        inline: false,
      },
      {
        name: '!meeting <議題>',
        value: 'Claude / Codex / ChatGPT の3者が議題を議論します\n例: `!meeting 次にどの機能を作るべきか`',
        inline: false,
      },
      {
        name: '!approve / !deny / !pause / !resume',
        value: [
          '⚠️ 承認システム（管理者のみ）',
          '高危険度の `!claude` は自動実行されず承認待ちになります',
          '`!approve <タスクID>` — 承認して Claude Code を実行',
          '`!deny <タスクID>` — 却下してキャンセル',
          '`!pause <タスクID>` — 一時停止',
          '`!resume <タスクID>` — 一時停止を解除',
          '`!approve` — 承認待ち一覧を表示',
        ].join('\n'),
        inline: false,
      },
      {
        name: '!restart',
        value: [
          '⚙️ Bot を安全に再起動します（管理者のみ）',
          '再起動前に構文チェック・Token確認・キュー状態を確認します',
          '問題がある場合は確認メッセージを表示します',
          '`!restart confirm` — 警告がある場合に強制再起動',
        ].join('\n'),
        inline: false,
      },
      {
        name: '!queue',
        value: 'タスクキューの状況を確認します\n`!queue clear` — 待機中タスクをクリア（オーナーのみ）',
        inline: false,
      },
      {
        name: '!next',
        value: '最優先の実行可能タスクを1件表示します（完了・レビュー待ち・人間確認待ち・保留を除外）',
        inline: false,
      },
      {
        name: '!run-next',
        value: '最優先の未着手タスクを自動実行します（PENDING → IN_PROGRESS → Claude Code 実行）',
        inline: false,
      },
      {
        name: '!auto run 1',
        value: 'Auto Task Runner Phase3: 未着手タスクを1件だけ安全実行します\n例: `!auto run 1`',
        inline: false,
      },
      {
        name: '!auto on',
        value: 'Auto Task Runner Phase4: 未着手タスクを最大3件まで順次自動実行します\n停止条件: タスクなし / 高危険度 / バリデーション失敗 / 人間確認待ち / 上限(3件)',
        inline: false,
      },
      {
        name: '!batch',
        value: 'ナイトバッチを今すぐ手動実行します',
        inline: false,
      },
      {
        name: '!train',
        value: 'AI 予測モデルを手動でトレーニングします\n`data/history/` のアーカイブデータを分析してウェイトを更新します',
        inline: false,
      },
      {
        name: '!apply-review <タスクID>',
        value: 'Codex のレビュー結果を Claude Code にフィードバックします\n例: `!apply-review task_1748344800000`',
        inline: false,
      },
      {
        name: '!create-pr <タスクID>',
        value: 'タスクの PR を手動で作成します（ENABLE_PR=true が必要）\n例: `!create-pr task_1748344800000`',
        inline: false,
      },
      {
        name: '!history [タスクID]',
        value: 'レビュー履歴を表示します\n例: `!history` / `!history task_1748344800000`',
        inline: false,
      },
      {
        name: '!research list / show <ID>',
        value: '調査レポートを一覧表示 / フル表示します\n例: `!research list` / `!research show task_xxx`',
        inline: false,
      },
      {
        name: '!review list / show <ID>',
        value: 'Codex レビュー結果を一覧表示 / フル表示します\n例: `!review list` / `!review show task_xxx`',
        inline: false,
      },
      {
        name: '!project [サブコマンド]',
        value: [
          'プロジェクトを管理します',
          '`!project current` — 現在のプロジェクトを表示',
          '`!project list` — プロジェクト一覧',
          '`!project create <名前>` — 新しいプロジェクトを作成',
          '`!project switch <名前>` — プロジェクトを切り替え',
          '例: `!project create youtube-ai` / `!project switch youtube-ai`',
        ].join('\n'),
        inline: false,
      },
      {
        name: '!worker [サブコマンド]',
        value: [
          'Worker Role を管理します（Phase E-5b）',
          '`!worker add <role> [id] [project]` — Worker を登録',
          '`!worker list` — 登録 Worker 一覧',
          '`!worker rm <id>` — Worker を削除',
          '`!worker status` — ワンライナー状況',
          '役割: IMPLEMENTER / REVIEWER / TESTER / RESEARCHER',
        ].join('\n'),
        inline: false,
      },
      {
        name: '!doctor',
        value: '⚙️ システム診断（管理者のみ）\n設定・Claude・ログ・タスクの状態を確認します',
        inline: false,
      },
      {
        name: '!help',
        value: 'このヘルプを表示します',
        inline: false,
      },
    )
    .setFooter({ text: 'AI_WORKER Phase E-5b | 半自律AI開発チーム' })
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

  // 開始メッセージ
  await message.reply(
    `🚀 **Project Runner 開始**\n\n` +
    `Project: **${project.name}** (\`${projectId}\`)${staffText}\n\n` +
    `Auto Runner を有効化しました。タスクを順次実行します。\n` +
    `停止: \`!project stop ${projectId}\` | 状態: \`!project runner status\``
  ).catch(() => {});

  // handleAutoOn fire-and-forget（Discord ハンドラをブロックしない）
  handleAutoOn(message)
    .catch(err => logger.error(`[ProjectRun] handleAutoOn エラー: ${err.message}`))
    .finally(() => {
      _teardown(ctx, prevPid);
    });
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
  const { projectId, message, runId, tasksDone, tasksFailed, stopReason } = ctx;

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
  const stopMsg = stopReason === 'stopped_by_user' ? ' (ユーザーが停止)' : '';
  await message.channel.send(
    `🏁 **Project Runner 完了**${stopMsg}\n\n` +
    `Project: \`${projectId}\` | runId: \`${runId}\`\n` +
    `✅ 完了: ${tasksDone}件 | ❌ 失敗: ${tasksFailed}件` +
    postQaText
  ).catch(() => {});

  // 4. activeRuns から削除
  activeRuns.delete(projectId);

  // 5. チャンネル projectId 復元
  if (prevPid && prevPid !== projectId) {
    projectManager.setCurrentProject(message.channelId, prevPid);
  }

  // 6. logger
  logger.info(
    `[ProjectRun] teardown: ${projectId} | runId:${runId} ` +
    `done:${tasksDone} failed:${tasksFailed} stop:${stopReason || 'none'}`
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
    const errorText = `❌ **会議の実行に失敗しました**\n\n${error.message.slice(0, 500)}`;
    await processingMsg.edit(errorText);
    await sendNotification('error', message.channel, errorText);
  }
}

// ─────────────────────────────────────────────────────
// !research list / show <id> — 調査レポートの一覧・詳細表示
//
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
    // なぜ実行できないか状態別に詳細を表示
    const stateDetail = {};
    filtered.forEach(t => { stateDetail[t.state] = (stateDetail[t.state] || 0) + 1; });
    const detailLines = Object.entries(stateDetail)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `  ${taskManager.STATE_EMOJI[s] || '❓'} ${s}: ${c}件`);
    const hint = stateDetail['レビュー待ち'] > 0 || stateDetail['保留'] > 0
      ? '\n💡 `!task cleanup` で整理するか `!task resume <id>` で再開できます。'
      : '';
    await message.reply(
      `📋 **次タスク**\n\nProject: **${currentPid}**\n実行可能な未着手タスクはありません。` +
      (detailLines.length > 0 ? '\n\n現在のタスク:\n' + detailLines.join('\n') : '') +
      hint
    );
    return;
  }

  // task.type / task.size（後方互換: 未設定は IMPLEMENT / MEDIUM）
  const typeLabel = next.type || taskManager.TASK_TYPES.IMPLEMENT;
  const sizeLabel = next.size || taskManager.TASK_SIZES.MEDIUM;
  const typeEmoji = taskManager.TYPE_EMOJI[typeLabel]  || '📋';
  const sizeEmoji = taskManager.SIZE_EMOJI[sizeLabel]  || '🟡';

  const PRIORITY_EN = { '高': 'HIGH', '中': 'MEDIUM', '低': 'LOW' };
  const priorityEn  = PRIORITY_EN[next.priority] || next.priority;

  // LARGE タスクは警告を付ける
  const largeWarn = sizeLabel === taskManager.TASK_SIZES.LARGE
    ? `\n\n⚠️ このタスクは **LARGE** です。\`!claude\` で手動実行を推奨します。`
    : '';

  await message.reply(
    `📋 **次タスク**\n\n` +
    `Task:\n\`${next.id}\`\n\n` +
    `[${typeLabel}/${sizeLabel}] ${typeEmoji}${sizeEmoji}\n\n` +
    `内容: ${next.prompt.slice(0, 80)}${next.prompt.length > 80 ? '...' : ''}\n\n` +
    `Priority: ${priorityEn}` +
    largeWarn
  );
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

  let processingMsg = null;
  try {
    const phaseFlags = [
      ENABLE_GITHUB ? '🔗GitHub' : '',
      ENABLE_PR ? '📋PR' : '',
      ENABLE_CODEX  ? '🤖Codex' : '',
    ].filter(Boolean).join(' | ');

    const timeoutMin = Math.floor((parseInt(process.env.TASK_TIMEOUT_SECONDS) || 300) / 60);

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

    const augmentedPrompt  = prompt + explorationRules + docsOutputGuard;

    // 探索対象をログに記録
    const explorationTargets = taskSizeResult.fileMatches.length > 0
      ? taskSizeResult.fileMatches.join(', ')
      : 'bot/**/*.js（ファイル指定なし）';
    logger.info(`探索対象: ${explorationTargets} | TaskType:${taskType} | TaskSize:${taskSizeResult.size}`);

    const taskStartMs = Date.now();
    const result = await claudeRunner.run(augmentedPrompt, taskWorkspace, AI_WORKER_ROOT);

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
        }
      }

      const dangerColor = { '高': 0xFF3333, '中': 0xFFAA00, '低': 0x00CC66 }[codexRequest.danger] || 0x0099FF;
      await sendNotification('codexReview', message.channel,
        fmt.message(discordMsg, `codex_${taskId}.md`)
      );

      if (codexRequest.danger === '高' && DISCORD_OWNER_ID) {
        await sendHumanMention(
          message.channel, taskId,
          'Codex 依頼の危険度が「高」です',
          `reviews/codex_${taskId}.md を確認してください。`,
          '高',
          { channelType: 'codexReview' }
        );
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
            // セキュリティ: pushError の中身（トークン等）は Discord に出さない
            // 詳細はマスク済みのログを確認すること
            await sendHumanMention(
              message.channel, taskId,
              'GitHub Push が失敗しました',
              '詳細はログを確認してください',
              '中',
              { channelType: 'git' }
            );
          }
        } catch (gitErr) {
          const { maskSecret } = require('./utils/github');
          logger.error(`GitHub Push エラー: ${maskSecret(gitErr.message)}`);
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

    const errorTypeEmoji = { TIMEOUT: '⏱️', AUTH: '🔑', PERMISSION: '🚫', SYNTAX: '📝', UNKNOWN: '❓' }[errorType] || '❓';
    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF3333)
      .setTitle('❌ 作業中にエラーが発生しました')
      .setDescription(
        `AIが作業していたタスクでエラーが起きて止まりました。\n\n` +
        // Discord embed にも maskSecret 済みメッセージを使用
        `**エラーの詳細**\n${fmt.embedDesc(maskedErrMsg, `../logs/`)}`
      )
      .addFields(
        { name: '📋 タスクID', value: `\`${taskId}\``, inline: true },
        { name: `${errorTypeEmoji} エラー種別`, value: errorType, inline: true },
        { name: '📁 ログの場所', value: `\`logs/\` または \`workspace/${taskId}/error.md\``, inline: false },
        { name: '💡 次のステップ', value: '内容を確認して、必要なら `!claude` で再度依頼してください。', inline: false },
      )
      .setTimestamp();

    try {
      if (processingMsg) await processingMsg.edit({ content: '', embeds: [errorEmbed] });
      else await message.channel.send({ embeds: [errorEmbed] });
    } catch { /* ignore */ }

    // エラー通知チャンネルへ送信（初心者向け）
    if (ERROR_CHANNEL_ID) {
      const errorNotifyEmbed = new EmbedBuilder()
        .setColor(0xFF3333)
        .setTitle('❌ エラーが発生しました')
        .setDescription(
          `AIの作業中に問題が起きました。以下の内容を確認してください。\n\n` +
          `**エラー内容（概要）**\n\`\`\`\n${error.message.slice(0, 300)}\n\`\`\`\n\n` +
          `**どうすれば？**\nエラー内容を確認して \`!claude\` で再度依頼するか、管理者に連絡してください。`
        )
        .addFields({ name: '📋 タスクID', value: `\`${taskId}\``, inline: true })
        .setTimestamp();
      await sendNotification('error', message.channel, { embeds: [errorNotifyEmbed] });
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

  // ─── 高危険度は自動実行しない（非変更系タイプは除外）───
  const NON_CHANGING_TYPES = new Set(['REVIEW', 'RESEARCH', 'DOCS']);
  const preDanger = codex.assessDanger(prompt, '', []);
  if (preDanger === '高' && !NON_CHANGING_TYPES.has(String(taskType).toUpperCase())) {
    taskManager.releaseLease(next.id); // claim を解除
    await message.reply(
      `🔴 **高危険度タスクは自動実行できません**\n\n` +
      `タスク: \`${next.id}\`\n\n` +
      `高危険度タスクは \`!claude\` から直接実行し、承認フロー（\`!approve\`）を経てください。`
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
      `❌ **調査タスク失敗**\n\nタスク: \`${taskId}\`\nエラー: ${e.message.slice(0, 200)}`
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
  if (!task || task.state !== taskManager.STATES.IN_PROGRESS) {
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
    await processingMsg.edit(`❌ **バッチ実行に失敗しました**\n${error.message.slice(0, 500)}`);
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
    const accLine = stats?.accuracy?.avgTimeAccuracy !== null && stats?.accuracy?.avgTimeAccuracy !== undefined
      ? `⏱️ 時間推定精度: **${(stats.accuracy.avgTimeAccuracy * 100).toFixed(1)}%**`
      : '⏱️ 時間推定精度: N/A（データ不足）';
    const succAccLine = stats?.accuracy?.avgSuccessAccuracy !== null && stats?.accuracy?.avgSuccessAccuracy !== undefined
      ? `🎯 成功率予測精度: **${(stats.accuracy.avgSuccessAccuracy * 100).toFixed(1)}%**`
      : '🎯 成功率予測精度: N/A（データ不足）';

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
    await processingMsg.edit(`❌ **トレーニングに失敗しました**\n${error.message.slice(0, 300)}`);
  }
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
    await processingMsg.edit(`❌ 診断中にエラーが発生しました\n${e.message.slice(0, 200)}`);
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

  await message.reply(taskQueue.formatStatus());
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
    const errorText = `❌ **Codex レビューに失敗しました**\n${error.message.slice(0, 300)}`;
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

  if (content.startsWith('!queue')) {
    const sub = content.split(/\s+/)[1] || '';
    await handleQueue(message, sub);
    return;
  }

  if (content === '!doctor') {
    await handleDoctor(message);
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
