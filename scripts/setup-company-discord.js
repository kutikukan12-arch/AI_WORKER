'use strict';
/**
 * setup-company-discord.js — AI_WORKER 社内Discord構成セットアップ
 *
 * 冪等（既存の同名カテゴリ/チャンネルはスキップ）
 * 既存チャンネルの削除・権限変更は行わない
 *
 * 実行:
 *   node scripts/setup-company-discord.js
 *   node scripts/setup-company-discord.js --dry-run   (確認のみ)
 */

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN   = process.env.DISCORD_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN が .env に設定されていません');
  process.exit(1);
}

// ── 会社Discord構成 ─────────────────────────────────────
const COMPANY_STRUCTURE = [
  {
    category: '🏢 社内本部',
    channels: [
      { name: '社長室',       topic: 'CEO最終判断 / 重要承認 / HUMAN_CHECK / 経営判断 | !approve !deny' },
      { name: '副社長室',     topic: 'GPT相談 / 方針整理 / AI社員への指示準備 / inbox整理 | !inbox check' },
      { name: '黒川-進行管理', topic: '社員間配送 / 返信待ち管理 / ボトルネック検出 | !inbox status !msg pending' },
      { name: '作業指示',     topic: '社員への作業依頼 / task投入 | !task add !msg send' },
    ],
  },
  {
    category: '🤖 AI社員室',
    channels: [
      { name: '宮城-lead-engineer', topic: '実装 / 修正 / 技術作業 | 宮城 Lead Engineer 担当' },
      { name: '守谷-cto-review',    topic: 'READY / NEED_FIX / セキュリティ / 品質確認 | 守谷 CTO 担当' },
      { name: '白石-coo',           topic: '優先順位 / 実行順 / 肥大化防止 | 白石 COO 担当' },
      { name: '市川-pm',            topic: '要件整理 / MVP判断 / 商品価値確認 | 市川 PM 担当' },
      { name: '相沢-cs',            topic: 'ユーザー視点 / βテスト / feedback整理 | 相沢 CS 担当' },
      { name: '金森-cfo',           topic: 'コスト / ROI / 課金判断 | 金森 CFO 担当' },
      { name: '育野-learning',      topic: 'Decision / Incident / Lesson / 組織学習 | 育野 担当' },
    ],
  },
  {
    category: '📚 記録室',
    channels: [
      { name: 'decision-log',  topic: '意思決定履歴 | !decision log !decision list' },
      { name: 'incident-log',  topic: '障害 / 原因 / 再発防止 | !incident open !incident list' },
      { name: 'lesson-log',    topic: '学習資産 / 改善ルール | LESSONS.md 参照' },
      { name: 'release-log',   topic: 'リリース判断 | !quality status' },
      { name: 'security-log',  topic: '機密 / 権限 / security-check | npm run security-check' },
    ],
  },
];

// ── メイン処理 ──────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const results = { created: [], skipped: [], errors: [] };

client.once('ready', async () => {
  console.log(`\n✅ Bot ログイン: ${client.user.tag}`);
  if (DRY_RUN) console.log('⚠️  DRY-RUN モード: チャンネルは作成されません\n');

  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('❌ Bot がどのサーバーにも参加していません');
    client.destroy();
    process.exit(1);
  }
  console.log(`🏠 対象サーバー: ${guild.name} (${guild.id})\n`);

  const existing = await guild.channels.fetch();

  for (const { category: catName, channels } of COMPANY_STRUCTURE) {
    // ── カテゴリ ──────────────────────────────────────
    let cat = existing.find(c => c.type === ChannelType.GuildCategory && c.name === catName);
    if (cat) {
      console.log(`⏭️  カテゴリ既存スキップ: ${catName}`);
    } else if (DRY_RUN) {
      console.log(`[DRY] ✅ カテゴリ作成予定: ${catName}`);
    } else {
      try {
        cat = await guild.channels.create({ name: catName, type: ChannelType.GuildCategory });
        console.log(`✅ カテゴリ作成: ${catName}`);
        results.created.push(catName);
      } catch (e) {
        console.error(`❌ カテゴリ作成失敗: ${catName} — ${e.message}`);
        results.errors.push(`${catName}: ${e.message}`);
        continue;
      }
    }

    // ── テキストチャンネル ───────────────────────────
    for (const { name, topic } of channels) {
      const exists = existing.find(c => c.type === ChannelType.GuildText && c.name === name);
      if (exists) {
        console.log(`   ⏭️  チャンネル既存スキップ: #${name} (${exists.id})`);
        results.skipped.push({ name, id: exists.id });
      } else if (DRY_RUN) {
        console.log(`   [DRY] ✅ チャンネル作成予定: #${name}`);
      } else {
        try {
          const ch = await guild.channels.create({
            name,
            type:   ChannelType.GuildText,
            parent: cat?.id,
            topic,
          });
          console.log(`   ✅ チャンネル作成: #${name} (${ch.id})`);
          results.created.push({ name, id: ch.id });
        } catch (e) {
          console.error(`   ❌ チャンネル作成失敗: #${name} — ${e.message}`);
          results.errors.push(`#${name}: ${e.message}`);
        }
      }
    }
  }

  // ── サマリー ─────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 結果: 作成 ${results.created.length}件 / スキップ ${results.skipped.length}件 / エラー ${results.errors.length}件`);

  if (results.errors.length > 0) {
    console.log('\n❌ エラー:');
    results.errors.forEach(e => console.log(`  ${e}`));
  }

  const allChannels = await guild.channels.fetch();
  const companyChannels = [];
  for (const { channels } of COMPANY_STRUCTURE) {
    for (const { name } of channels) {
      const ch = allChannels.find(c => c.name === name && c.type === ChannelType.GuildText);
      if (ch) companyChannels.push(ch.id);
    }
  }

  if (companyChannels.length > 0) {
    console.log('\n# .env 追加候補（既存の ALLOWED_CHANNEL_IDS に追記）:');
    console.log(`# ${companyChannels.join(',')}`);
    console.log('\n# 各チャンネルID:');
    for (const { channels } of COMPANY_STRUCTURE) {
      for (const { name } of channels) {
        const ch = allChannels.find(c => c.name === name && c.type === ChannelType.GuildText);
        if (ch) console.log(`# ${name}: ${ch.id}`);
      }
    }
  }

  console.log('\n次のステップ:');
  console.log('  1. 上記チャンネルIDを .env の ALLOWED_CHANNEL_IDS に追加');
  console.log('  2. docs/discord-structure.md の .env マッピングを参考に各通知先を設定');
  console.log('  3. node scripts/init-company-decisions.js で初期Decision登録');
  console.log('  4. npm start で Bot 再起動');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  client.destroy();
  process.exit(results.errors.length > 0 ? 1 : 0);
});

client.login(TOKEN).catch(err => {
  console.error('❌ ログイン失敗:', err.message);
  process.exit(1);
});
