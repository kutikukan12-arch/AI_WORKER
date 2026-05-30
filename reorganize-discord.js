'use strict';
// reorganize-discord.js — 既存チャンネルのリネーム・移動・重複削除

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const dotenv = require('dotenv');
const path   = require('path');
const fs     = require('fs');

dotenv.config({ path: path.join(__dirname, '.env') });
const ENV_PATH = path.join(__dirname, '.env');

function setEnv(key, value) {
  let raw = fs.readFileSync(ENV_PATH, 'utf8');
  const re = new RegExp(`^(${key}=).*`, 'm');
  raw = re.test(raw) ? raw.replace(re, `$1${value}`) : raw + `\n${key}=${value}`;
  fs.writeFileSync(ENV_PATH, raw, 'utf8');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`\n✅ ログイン: ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  await guild.channels.fetch();

  // ── ID ショートカット（スキャン結果から確定値） ──────────────
  const ID = {
    // カテゴリ
    cat_unei:          '1509543941341446236', // 運営 → 📌 案内 にリネーム
    cat_ai_desk:       '1509571399293997157', // AIのデスク（そのまま）
    cat_annai_new:     '1509985922442330184', // 📌 案内（前回作成・削除）
    cat_review:        '1509985928205172796', // 🔍 レビュー・品質
    cat_github:        '1509985932189765774', // 🔗 GitHub・リリース
    cat_batch:         '1509985935150940210', // 🌙 バッチ・自動化
    cat_kanri:         '1509985937541693491', // 🔒 管理

    // 運営チャンネル（リネーム）
    ch_oshirase:       '1509980596552728788', // お知らせ → はじめに
    ch_server_desc:    '1509543941341446238', // サーバー説明 → コマンド一覧

    // AIのデスク（リネーム＋移動）
    ch_ai_chat:        '1509545187846652034', // ai-chat → ai-worker
    ch_approval:       '1509547954116104283', // approval → 承認-確認
    ch_ai_history:     '1509557457007935530', // ai-history → review-history → 🔍
    ch_ai_review:      '1509547986911232204', // ai-review → 🔍（名前そのまま）
    ch_github_log:     '1509548020860194916', // github-log → 🔗（名前そのまま）
    ch_error_log:      '1509548061884682453', // error-log → error-alert → 🔒
    ch_meeting:        '1509556635817742346', // ミーティングルーム → ai-meeting → 🔍
    ch_batch:          '1509556764008382495', // batchチャンネル → night-batch → 🌙
    ch_pr:             '1509557395830083634', // pr-通知専用 → pull-requests → 🔗

    // 前回作成した重複チャンネル（削除）
    ch_del_aisinner:   '1509985923599831040', // はじめに（重複）
    ch_del_cmdlist:    '1509985924702797905', // コマンド一覧（重複）
    ch_del_aiworker:   '1509985926045237379', // ai-worker（重複）
    ch_del_shouin:     '1509985927152537811', // 承認-確認（重複）
    ch_del_meeting:    '1509985931086663771', // ai-meeting（重複）
    ch_del_pr:         '1509985933989249105', // pull-requests（重複）
    ch_del_batch:      '1509985935909982219', // night-batch（重複）
  };

  const get = id => guild.channels.cache.get(id);

  const step = async (label, fn) => {
    try {
      await fn();
      console.log(`  ✅ ${label}`);
    } catch (e) {
      console.log(`  ⚠️  ${label} — ${e.message}`);
    }
    await sleep(400); // レート制限対策
  };

  // ════════════════════════════════════════
  // STEP 1: 重複チャンネル削除
  // ════════════════════════════════════════
  console.log('\n── STEP 1: 重複チャンネル削除 ──');
  await step('削除: #はじめに（重複）',    () => get(ID.ch_del_aisinner)?.delete());
  await step('削除: #コマンド一覧（重複）', () => get(ID.ch_del_cmdlist)?.delete());
  await step('削除: #ai-worker（重複）',   () => get(ID.ch_del_aiworker)?.delete());
  await step('削除: #承認-確認（重複）',   () => get(ID.ch_del_shouin)?.delete());
  await step('削除: #ai-meeting（重複）',  () => get(ID.ch_del_meeting)?.delete());
  await step('削除: #pull-requests（重複）', () => get(ID.ch_del_pr)?.delete());
  await step('削除: #night-batch（重複）', () => get(ID.ch_del_batch)?.delete());

  // 重複カテゴリ削除（空になったはず）
  await step('削除: 📌 案内カテゴリ（重複）', () => get(ID.cat_annai_new)?.delete());

  // ════════════════════════════════════════
  // STEP 2: カテゴリ名変更
  // ════════════════════════════════════════
  console.log('\n── STEP 2: カテゴリ名変更 ──');
  await step('リネーム: 運営 → 📌 案内',
    () => get(ID.cat_unei)?.setName('📌 案内'));

  // ════════════════════════════════════════
  // STEP 3: 運営チャンネルをリネーム
  // ════════════════════════════════════════
  console.log('\n── STEP 3: 案内チャンネルをリネーム ──');
  await step('リネーム: #お知らせ → #はじめに',
    () => get(ID.ch_oshirase)?.setName('はじめに'));
  await step('リネーム: #サーバー説明 → #コマンド一覧',
    () => get(ID.ch_server_desc)?.setName('コマンド一覧'));

  // ════════════════════════════════════════
  // STEP 4: AIのデスク内チャンネルをリネーム
  // ════════════════════════════════════════
  console.log('\n── STEP 4: AIのデスク チャンネルをリネーム ──');
  await step('リネーム: #ai-chat → #ai-worker',
    () => get(ID.ch_ai_chat)?.setName('ai-worker'));
  await step('リネーム: #approval → #承認-確認',
    () => get(ID.ch_approval)?.setName('承認-確認'));

  // ════════════════════════════════════════
  // STEP 5: チャンネルを正しいカテゴリへ移動（＋リネーム）
  // ════════════════════════════════════════
  console.log('\n── STEP 5: チャンネル移動＋リネーム ──');

  // → 🔍 レビュー・品質
  await step('#ai-review を 🔍 レビュー・品質 へ移動',
    () => get(ID.ch_ai_review)?.setParent(ID.cat_review, { lockPermissions: false }));
  await step('#ミーティングルーム → #ai-meeting を 🔍 へ移動',
    async () => {
      const ch = get(ID.ch_meeting);
      if (ch) { await ch.setName('ai-meeting'); await sleep(300); await ch.setParent(ID.cat_review, { lockPermissions: false }); }
    });
  await step('#ai-history → #review-history を 🔍 へ移動',
    async () => {
      const ch = get(ID.ch_ai_history);
      if (ch) { await ch.setName('review-history'); await sleep(300); await ch.setParent(ID.cat_review, { lockPermissions: false }); }
    });

  // → 🔗 GitHub・リリース
  await step('#github-log を 🔗 GitHub・リリース へ移動',
    () => get(ID.ch_github_log)?.setParent(ID.cat_github, { lockPermissions: false }));
  await step('#pr-通知専用 → #pull-requests を 🔗 へ移動',
    async () => {
      const ch = get(ID.ch_pr);
      if (ch) { await ch.setName('pull-requests'); await sleep(300); await ch.setParent(ID.cat_github, { lockPermissions: false }); }
    });

  // → 🌙 バッチ・自動化
  await step('#batchチャンネル → #night-batch を 🌙 へ移動',
    async () => {
      const ch = get(ID.ch_batch);
      if (ch) { await ch.setName('night-batch'); await sleep(300); await ch.setParent(ID.cat_batch, { lockPermissions: false }); }
    });

  // → 🔒 管理
  await step('#error-log → #error-alert を 🔒 管理 へ移動',
    async () => {
      const ch = get(ID.ch_error_log);
      if (ch) { await ch.setName('error-alert'); await sleep(300); await ch.setParent(ID.cat_kanri, { lockPermissions: false }); }
    });

  // ════════════════════════════════════════
  // STEP 6: .env を正しい ID に更新
  // ════════════════════════════════════════
  console.log('\n── STEP 6: .env 更新 ──');

  // コマンド受信チャンネル（リネームしたが ID は変わらない）
  setEnv('ALLOWED_CHANNEL_IDS', `${ID.ch_ai_chat},${ID.ch_approval}`);
  console.log(`  ALLOWED_CHANNEL_IDS = ${ID.ch_ai_chat},${ID.ch_approval}`);

  // 通知専用チャンネル（既存チャンネルの ID を使う）
  setEnv('AI_REVIEW_CHANNEL_ID',    ID.ch_ai_review);
  setEnv('CODEX_REVIEW_CHANNEL_ID', ID.ch_ai_review); // ai-review と共用
  setEnv('GITHUB_LOG_CHANNEL_ID',   ID.ch_github_log);
  setEnv('PR_CHANNEL_ID',           ID.ch_pr);
  setEnv('BATCH_CHANNEL_ID',        ID.ch_batch);
  setEnv('MEETING_CHANNEL_ID',      ID.ch_meeting);
  console.log('  通知チャンネル ID を既存チャンネル(リネーム後)に更新');

  console.log('\n══════════════════════════════════════');
  console.log('  ✅ 再編成完了');
  console.log('  Discordで確認後、Botを !restart してください。');
  console.log('══════════════════════════════════════\n');
  process.exit(0);
});

client.on('error', e => { console.error(`❌ ${e.message}`); process.exit(1); });
client.login(process.env.DISCORD_TOKEN).catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
