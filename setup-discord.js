'use strict';

// =====================================================
// setup-discord.js — Discord チャンネル自動セットアップ
//
// 実行: node setup-discord.js
//
// 動作:
//   1. Botでログインして既存チャンネルを確認
//   2. 存在しないカテゴリ・チャンネルだけ作成
//   3. .env を更新（ALLOWED_CHANNEL_IDS 等）
//
// ※ 既存チャンネルは一切削除・変更しない
// ※ トークンはログに出さない
// =====================================================

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const dotenv = require('dotenv');
const path   = require('path');
const fs     = require('fs');

dotenv.config({ path: path.join(__dirname, '.env') });

const ENV_PATH = path.join(__dirname, '.env');

// ─────────────────────────────────────────────────
// 作成するチャンネル構成
// ─────────────────────────────────────────────────
const STRUCTURE = [
  // ── 案内 ──────────────────────────────────────
  {
    category: '📌 案内',
    channels: [
      { name: 'はじめに',     topic: '使い方・ルール。固定メッセージを読んでください。', allowed: false },
      { name: 'コマンド一覧', topic: '!help の内容。スマホで見返す用。',               allowed: false },
    ],
  },

  // ── AIのデスク（projectId の源泉）─────────────
  {
    category: 'AIのデスク',   // ← project-detector.js と完全一致が必須
    channels: [
      { name: 'ai-worker',  topic: 'メイン作業部屋。!claude / !next / !run-next / !task / !doctor',  allowed: true,  envKey: null },
      { name: '承認-確認',  topic: '!approve / !deny 専用。人間が確認するチャンネル。',              allowed: true,  envKey: null },
    ],
  },

  // ── レビュー・品質 ─────────────────────────────
  {
    category: '🔍 レビュー・品質',
    channels: [
      { name: 'ai-review',    topic: 'AIレビュー結果の自動通知先。',           allowed: false, envKey: 'AI_REVIEW_CHANNEL_ID'    },
      { name: 'codex-review', topic: 'Codexレビュー依頼の自動通知先。',        allowed: false, envKey: 'CODEX_REVIEW_CHANNEL_ID'  },
      { name: 'ai-meeting',   topic: '!meeting の結果投稿先。',                allowed: false, envKey: 'MEETING_CHANNEL_ID'       },
    ],
  },

  // ── GitHub・リリース ───────────────────────────
  {
    category: '🔗 GitHub・リリース',
    channels: [
      { name: 'github-log',    topic: 'GitHub Push / コミット通知。',          allowed: false, envKey: 'GITHUB_LOG_CHANNEL_ID' },
      { name: 'pull-requests', topic: 'PR作成通知。マージは人間が行う。',       allowed: false, envKey: 'PR_CHANNEL_ID'         },
    ],
  },

  // ── バッチ・自動化 ─────────────────────────────
  {
    category: '🌙 バッチ・自動化',
    channels: [
      { name: 'night-batch', topic: 'ナイトバッチ・朝バッチの自動通知先。',     allowed: false, envKey: 'BATCH_CHANNEL_ID' },
    ],
  },

  // ── 管理（管理者のみ）─────────────────────────
  {
    category: '🔒 管理',
    channels: [
      { name: 'bot-config', topic: '.env設定メモ・起動ログ貼り付け場所。Botは読まない。', allowed: false },
      { name: '運用メモ',   topic: '設定変更履歴・障害記録メモ。',                        allowed: false },
    ],
  },
];

// ─────────────────────────────────────────────────
// .env の指定キーを更新する（上書き）
// ─────────────────────────────────────────────────
function updateEnv(key, value) {
  let raw = fs.readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^(${key}=).*`, 'm');
  if (regex.test(raw)) {
    raw = raw.replace(regex, `$1${value}`);
  } else {
    raw += `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_PATH, raw, 'utf8');
}

// ─────────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`\n✅ ログイン成功: ${client.user.tag}`);

  // ── ギルド(サーバー)を取得 ──
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    console.error('❌ Botがサーバーに参加していません。招待URLで招待してください。');
    process.exit(1);
  }

  // 複数サーバーに参加している場合は一覧を表示して終了
  if (guilds.length > 1) {
    console.log('\n⚠️  複数のサーバーに参加しています:');
    guilds.forEach((g, i) => console.log(`  ${i}: ${g.name} (${g.id})`));
    console.log('\nGUILD_ID を .env に追加して再実行してください。');
    process.exit(1);
  }

  const guild = guilds[0];

  // ── 権限チェック ──
  const me = guild.members.me || await guild.members.fetchMe();
  const canManage = me.permissions.has('ManageChannels');
  if (!canManage) {
    console.error('\n❌ Botに「チャンネルの管理」権限がありません。');
    console.error('\n以下の手順で権限を付与してください:');
    console.error('  1. Discord → サーバー設定 → ロール');
    console.error('  2. Bot のロールを選択');
    console.error('  3. 「チャンネルの管理」をONにして保存');
    console.error('  4. node setup-discord.js を再実行');
    process.exit(1);
  }
  console.log('✅ チャンネル管理権限: あり');
  console.log(`\nサーバー: ${guild.name} (${guild.id})`);

  // ── 既存チャンネルをキャッシュ ──
  await guild.channels.fetch();
  const existingCategories = new Map(); // name → CategoryChannel
  const existingChannels   = new Map(); // name → GuildChannel

  guild.channels.cache.forEach(ch => {
    if (ch.type === ChannelType.GuildCategory) existingCategories.set(ch.name, ch);
    else existingChannels.set(ch.name, ch);
  });

  console.log(`\n既存カテゴリ: ${existingCategories.size}件`);
  console.log(`既存チャンネル: ${existingChannels.size}件\n`);

  // ── 作成 & ID 収集 ──
  const allowedIds = new Set(
    (process.env.ALLOWED_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  const envUpdates = {}; // envKey → channelId

  for (const group of STRUCTURE) {
    // カテゴリを確保
    let category = existingCategories.get(group.category);
    if (!category) {
      console.log(`  [新規] カテゴリ作成: 「${group.category}」`);
      category = await guild.channels.create({
        name: group.category,
        type: ChannelType.GuildCategory,
      });
      existingCategories.set(group.category, category);
    } else {
      console.log(`  [既存] カテゴリ: 「${group.category}」`);
    }

    // チャンネルを確保
    for (const def of group.channels) {
      let ch = existingChannels.get(def.name);
      if (!ch) {
        console.log(`    [新規] チャンネル作成: #${def.name}`);
        ch = await guild.channels.create({
          name:   def.name,
          type:   ChannelType.GuildText,
          parent: category.id,
          topic:  def.topic,
        });
        existingChannels.set(def.name, ch);
      } else {
        console.log(`    [既存] チャンネル: #${def.name} (${ch.id})`);
      }

      // ALLOWED_CHANNEL_IDS に追加
      if (def.allowed) allowedIds.add(ch.id);

      // envKey があれば記録
      if (def.envKey) envUpdates[def.envKey] = ch.id;
    }
  }

  // ── .env を更新 ──
  console.log('\n── .env 更新 ──');

  const allowedStr = [...allowedIds].join(',');
  updateEnv('ALLOWED_CHANNEL_IDS', allowedStr);
  console.log(`  ALLOWED_CHANNEL_IDS = ${allowedStr}`);

  for (const [key, id] of Object.entries(envUpdates)) {
    updateEnv(key, id);
    console.log(`  ${key} = ${id}`);
  }

  // ── 完了サマリー ──
  console.log('\n══════════════════════════════════════');
  console.log('  ✅ チャンネルセットアップ完了');
  console.log('  .env を更新しました。');
  console.log('  Bot を !restart で再起動してください。');
  console.log('══════════════════════════════════════\n');

  process.exit(0);
});

client.on('error', err => {
  console.error(`❌ Discord エラー: ${err.message}`);
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error(`❌ ログイン失敗: ${err.message}`);
  process.exit(1);
});
