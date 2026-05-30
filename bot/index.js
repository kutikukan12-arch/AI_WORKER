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

// ─── Approval（承認管理）───
const approvalManager = require('./utils/approval-manager');

// ─── Project 判定 ───
const projectDetector = require('./utils/project-detector');

// 承認待ちの実行待機Map: taskId → () => void
// ※ Bot 再起動で消える設計（意図的割り切り）
const pendingExecutions = new Map();

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

  // ─── PIDファイル記録（再起動検知用）───
  restartManager.writePid();

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
        name: '!batch',
        value: 'ナイトバッチを今すぐ手動実行します',
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
    .setFooter({ text: 'AI_WORKER Phase5 | 半自律AI開発チーム' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────
// !apply-review コマンド
// ─────────────────────────────────────────────────────
async function handleApplyReview(message, taskId) {
  if (!taskId) {
    await message.reply(
      '**使い方**\n```\n!apply-review <タスクID>\n```\n' +
      '**例**\n```\n!apply-review task_1748344800000\n```\n\n' +
      'タスクIDは `workspace/` フォルダ内のフォルダ名です。'
    );
    return;
  }

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
    logger.error(`apply-review エラー: ${error.message}`);
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.ERROR, taskId, 'エラー',
      `apply-review 失敗: ${error.message}`
    );
    const errorText = `❌ **Codexフィードバックでエラー**\n${error.message}`;
    await processingMsg.edit(errorText);
    await sendNotification('error', message.channel, errorText);
  }
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
    logger.error(`create-pr エラー: ${error.message}`);
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.ERROR, taskId, 'エラー',
      `create-pr 失敗: ${error.message}`
    );

    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF3333)
      .setTitle('❌ PR 作成に失敗しました')
      .setDescription(fmt.embedDesc(error.message))
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

  // !task list
  if (sub === 'list' || args.length === 0) {
    const tasks = taskManager.listTasksByPriority();
    await message.reply(`現在Project: **${projectId}**\n\n` + taskManager.formatTaskList(tasks, 'タスク一覧（優先度順）'));
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

  // !task <id> — 詳細表示
  const task = taskManager.getTask(sub);
  if (task) {
    await message.reply(taskManager.formatTaskDetail(task));
    return;
  }

  await message.reply(
    '**使い方**\n```\n!task list\n!task <タスクID>\n!task done <タスクID>\n!task hold <タスクID>\n!task resume <タスクID>\n!task stats\n!task cleanup\n```'
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
// !next コマンド — 最優先の実行可能タスクを1件表示
// ─────────────────────────────────────────────────────
async function handleNext(message) {
  const tasks = taskManager.listTasksByPriority();
  const next = tasks.find(t => t.state === taskManager.STATES.PENDING);

  if (!next) {
    await message.reply('📋 **次タスク**\n\n実行可能なタスクはありません。');
    return;
  }

  const PRIORITY_EN = { '高': 'HIGH', '中': 'MEDIUM', '低': 'LOW' };
  const priorityEn = PRIORITY_EN[next.priority] || next.priority;
  const reason = next.priorityReason || '未着手かつ最優先';

  await message.reply(
    `📋 **次タスク**\n\n` +
    `Task:\n\`${next.id}\`\n\n` +
    `Priority:\n${priorityEn}\n\n` +
    `State:\n${next.state}\n\n` +
    `理由:\n${reason}`
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
    const augmentedPrompt  = prompt + explorationRules;

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
          logger.error(`PR 作成エラー: ${prErr.message}`);
          await sendNotification('pr', message.channel, {
            embeds: [new EmbedBuilder()
              .setColor(0xFF3333)
              .setTitle('❌ PR 作成に失敗しました')
              .setDescription(prErr.message.slice(0, 1000))
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
            await sendHumanMention(
              message.channel, taskId,
              'GitHub Push が失敗しました',
              `エラー: ${gitResult.pushError.slice(0, 200)}`,
              '中',
              { channelType: 'git' }
            );
          }
        } catch (gitErr) {
          logger.error(`GitHub Push エラー: ${gitErr.message}`);
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
        ? { name: '🤖 Codex', value: `危険度:${codexInfo?.danger} | \`!apply-review ${taskId}\``, inline: false }
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

  } catch (error) {
    logger.error(`タスク失敗 | ID: ${taskId} | source:${source} | ${error.message}`);
    reviewHistory.addEntry(
      reviewHistory.EVENT_TYPES.ERROR, taskId, 'エラー',
      error.message.slice(0, 80)
    );

    try {
      fs.writeFileSync(
        path.join(taskWorkspace, 'error.md'),
        `# エラー: ${taskId}\n\n- 発生日時: ${new Date().toLocaleString('ja-JP')}\n\n## エラー内容\n${error.message}\n`,
        'utf8'
      );
    } catch { /* ignore */ }

    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF3333)
      .setTitle('❌ 作業中にエラーが発生しました')
      .setDescription(
        `AIが作業していたタスクでエラーが起きて止まりました。\n\n` +
        `**エラーの詳細**\n${fmt.embedDesc(error.message, `../logs/`)}`
      )
      .addFields(
        { name: '📋 タスクID', value: `\`${taskId}\``, inline: true },
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
// !run-next コマンド — 最優先の未着手タスクを安全実行
//
// executeClaudeTask() を通じて !claude と完全に同じ
// フロー（completionValidator・AIレビュー・Codex等）を実行する。
// 無条件DONE禁止。高危険度タスクは実行しない。
// ─────────────────────────────────────────────────────
async function handleRunNext(message) {
  // ── [DIAG-3] handleRunNext 到達ログ ──
  logger.info(`[DIAG-3] handleRunNext reached | ch:${message.channelId} | author:${message.author.id}`);

  const tasks = taskManager.listTasksByPriority();
  const next  = tasks.find(t => t.state === taskManager.STATES.PENDING);

  if (!next) {
    await message.reply('📋 **!run-next**\n\n実行可能な未着手タスクはありません。\n`!task cleanup` で孤立タスクを整理できます。');
    return;
  }

  const prompt = next.prompt || '';

  // ─── セキュリティチェック ───
  const sec = security.checkPrompt(prompt);
  if (!sec.safe) {
    logger.warn(`!run-next セキュリティブロック: ${next.id} | ${sec.reason}`);
    await message.reply(
      `🚫 **セキュリティチェックで拒否**\n\n` +
      `タスク \`${next.id}\` をスキップします。\n` +
      `理由: ${sec.reason}`
    );
    return;
  }

  // ─── 高危険度は !run-next で実行しない ───
  const preDanger = codex.assessDanger(prompt, '', []);
  if (preDanger === '高') {
    await message.reply(
      `🔴 **高危険度タスクは \`!run-next\` で実行できません**\n\n` +
      `タスク: \`${next.id}\`\n\n` +
      `高危険度タスクは \`!claude\` から直接実行し、\n承認フロー（\`!approve\`）を経てください。`
    );
    return;
  }

  // ─── TaskType / TaskSize 判定 ───
  const taskType       = taskTypeUtil.detectTaskType(prompt);
  const taskSizeResult = taskTypeUtil.estimateTaskSize(prompt);

  if (taskSizeResult.size === taskTypeUtil.TASK_SIZES.LARGE) {
    const splitMsg = taskTypeUtil.buildSplitSuggestion(prompt, taskSizeResult);
    await message.reply(
      `⚠️ **タスクが大きすぎます**\n\nタスク: \`${next.id}\`\n\n` + splitMsg
    );
    return;
  }

  // タスク作成時に保存した projectId を優先して使用。
  // 旧タスク（projectId 未保存）はフォールバックとして現チャンネルで判定。
  const projectId     = next.projectId
    || projectDetector.detectProjectId(message.channel)
    || 'default';
  const taskWorkspace = path.join(WORKSPACE_PATH, projectId, next.id);

  await message.reply(
    `▶️ **!run-next: 通常フローで実行開始**\n\n` +
    `タスク: \`${next.id}\`\n` +
    `指示: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\n\n` +
    `completionValidator・AIレビュー・Codex を通常通り実行します。`
  ).catch(() => {});

  // ─── キューに追加（!claude と同じ concurrency 管理）───
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

  if (content === '!batch') {
    await handleBatch(message);
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
