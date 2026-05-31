'use strict';
/**
 * Phase G-1: Discord カテゴリ・チャンネル自動作成スクリプト
 *
 * 実行: node scripts/setup_discord_channels.js
 *
 * - 既存の同名カテゴリ/チャンネルはスキップ（冪等）
 * - .env から DISCORD_TOKEN / ALLOWED_CHANNEL_IDS を読み込む
 * - 作成したチャンネル ID を ALLOWED_CHANNEL_IDS 候補として表示
 */

const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN が .env に設定されていません');
  process.exit(1);
}

// ── 作成する構成 ────────────────────────────────────────
const STRUCTURE = [
  {
    category: '📢 INFORMATION',
    channels: [
      { name: 'ai-worker-guide', topic: '使い方ガイド（固定メッセージ）| !help で全コマンド確認' },
      { name: 'changelog',       topic: '更新履歴（固定メッセージ）' },
    ],
  },
  {
    category: '🚀 OPERATIONS',
    channels: [
      { name: 'project-run',  topic: '!project run / stop / runner status — 自律ループ実行・停止' },
      { name: 'human-check',  topic: '⚠️ HUMAN_CHECK 通知専用 | !approve <id> / !deny <id>' },
      { name: 'quality-gate', topic: '!quality status / gate / report — 品質ゲート管理' },
    ],
  },
  {
    category: '🧠 PLANNING',
    channels: [
      { name: 'planner',  topic: '!project plan / !task add / !meeting — 計画・タスク登録・会議' },
      { name: 'research', topic: '!research list / show — 調査レポート確認' },
    ],
  },
  {
    category: '🔍 REVIEW',
    channels: [
      { name: 'codex-review', topic: '!review list/show / !codex — Codex レビュー結果' },
      { name: 'fix-tasks',    topic: '!apply-review — soft RED auto-FIX 通知・フィードバック適用' },
    ],
  },
  {
    category: '📊 MONITORING',
    channels: [
      { name: 'project-status',  topic: '!project runner status / !task stats / !doctor — 総合モニタリング' },
      { name: 'auto-runner-log', topic: '自動通知専用（BATCH_CHANNEL_ID に設定）| バッチ・MID-RUN Gate' },
    ],
  },
  {
    category: '📦 ARCHIVE',
    channels: [
      { name: 'archive', topic: '完了済みスレッド・旧通知の移動先' },
    ],
  },
];

// ── メイン処理 ──────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const createdIds = [];  // ALLOWED_CHANNEL_IDS 候補

client.once('ready', async () => {
  console.log(`\n✅ Bot ログイン: ${client.user.tag}`);

  // guild を選択（複数の場合は最初の1件）
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('❌ Bot がどのサーバーにも参加していません');
    client.destroy();
    return;
  }
  console.log(`🏠 対象サーバー: ${guild.name} (${guild.id})\n`);

  // 既存チャンネル/カテゴリを取得
  const existing = await guild.channels.fetch();

  for (const { category: catName, channels } of STRUCTURE) {
    // ── カテゴリ ──────────────────────────────────────
    let cat = existing.find(
      c => c.type === ChannelType.GuildCategory && c.name === catName
    );
    if (cat) {
      console.log(`⏭️  カテゴリ既存スキップ: ${catName}`);
    } else {
      cat = await guild.channels.create({
        name: catName,
        type: ChannelType.GuildCategory,
      });
      console.log(`✅ カテゴリ作成: ${catName}`);
    }

    // ── テキストチャンネル ───────────────────────────
    for (const { name, topic } of channels) {
      const exists = existing.find(
        c => c.type === ChannelType.GuildText && c.name === name
      );
      if (exists) {
        console.log(`   ⏭️  チャンネル既存スキップ: #${name} (${exists.id})`);
        createdIds.push(exists.id);
      } else {
        const ch = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: cat.id,
          topic,
        });
        console.log(`   ✅ チャンネル作成: #${name} (${ch.id})`);
        createdIds.push(ch.id);
      }
    }
  }

  // ── 結果サマリー ─────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 .env 設定候補');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n# ALLOWED_CHANNEL_IDS（全チャンネルを許可する場合）:');
  console.log(`ALLOWED_CHANNEL_IDS=${createdIds.join(',')}`);

  // OPERATIONS チャンネル群の ID を個別に表示
  const opsStart = STRUCTURE.findIndex(s => s.category === '🚀 OPERATIONS');
  const opsChannels = STRUCTURE[opsStart].channels;
  const monStart   = STRUCTURE.findIndex(s => s.category === '📊 MONITORING');
  const monChannels = STRUCTURE[monStart].channels;

  // auto-runner-log の ID を探す
  const allChannels = await guild.channels.fetch();
  const runnerLog = allChannels.find(c => c.name === 'auto-runner-log');
  if (runnerLog) {
    console.log(`\n# BATCH_CHANNEL_ID（バッチ通知 → #auto-runner-log）:`);
    console.log(`BATCH_CHANNEL_ID=${runnerLog.id}`);
    console.log(`MORNING_BATCH_CHANNEL_ID=${runnerLog.id}`);
  }

  const humanCheck = allChannels.find(c => c.name === 'human-check');
  if (humanCheck) {
    console.log(`\n# ヒント: !project run を #human-check から起動すると`);
    console.log(`# HUMAN_CHECK 通知が集約されます (ID: ${humanCheck.id})`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ セットアップ完了');
  console.log('次のステップ:');
  console.log('  1. 上記の ALLOWED_CHANNEL_IDS / BATCH_CHANNEL_ID を .env に設定');
  console.log('  2. #ai-worker-guide に guide を固定メッセージ投稿');
  console.log('  3. #changelog に changelog を固定メッセージ投稿');
  console.log('  4. Bot を再起動: npm start');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  client.destroy();
});

client.login(TOKEN).catch(err => {
  console.error('❌ ログイン失敗:', err.message);
  process.exit(1);
});
