'use strict';
/**
 * Phase G-1: #ai-worker-guide / #changelog に固定メッセージを投稿するスクリプト
 *
 * 実行: node scripts/post_guide_messages.js
 */

const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ DISCORD_TOKEN が未設定'); process.exit(1); }

const GUIDE_CHANNEL_ID     = '1510712274464145448';
const CHANGELOG_CHANNEL_ID = '1510712275818909886';

// ── ガイドメッセージ（分割投稿 ×2）────────────────────
const GUIDE_PART1 = `\
🤖 **AI_WORKER — 自律AI開発チーム ガイド**
Phase F-4 | 2026-06-01 更新

━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 **基本の使い方（自律ループ）**
━━━━━━━━━━━━━━━━━━━━━━━━━━

**① プロジェクトを作成**
\`\`\`
!project create <プロジェクト名>
\`\`\`

**② タスクを登録（任意）**
\`\`\`
!task add <やりたいこと>
\`\`\`
※ AI が自動でタスクを生成するので手動登録は省略可

**③ 自律ループ開始**
\`\`\`
!project run <プロジェクト名>
\`\`\`
→ AI が以下を自動で実行します：
　📋 計画（RESEARCH → DOCS → IMPLEMENT）
　🔨 実装（Claude Code）
　🔍 レビュー（Codex GPT-4o）
　📊 品質判定（Quality Gate）
　🔧 自己修復（soft RED → FIX タスク自動生成）
　❓ 人間確認（HUMAN_CHECK → \`!approve\` / \`!deny\`）

**④ 停止**
\`\`\`
!project stop <プロジェクト名>
\`\`\``;

const GUIDE_PART2 = `\
━━━━━━━━━━━━━━━━━━━━━━━━━━
❓ **人間確認が来たら（HUMAN_CHECK）**
━━━━━━━━━━━━━━━━━━━━━━━━━━

AIが判断できない場面（認証エラー・危険操作・未解決バグ）で通知が届きます。
\`\`\`
!task show <taskId>   → 内容確認
!approve <taskId>     → 承認 → ループ再開
!deny <taskId>        → 却下 → 安全停止
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **状態確認**
━━━━━━━━━━━━━━━━━━━━━━━━━━
\`\`\`
!project runner status  → ループ状況・loopCount
!quality status         → 品質スコア（GREEN/YELLOW/RED）
!task list              → タスク一覧
!task stats             → 統計
!worker list            → AI Worker 一覧
!doctor                 → システム診断
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **チャンネル案内**
━━━━━━━━━━━━━━━━━━━━━━━━━━
> **#project-run** — ループ実行・停止
> **#human-check** — 人間確認・approve/deny（ここから !project run するとHUMAN_CHECK通知が集約）
> **#quality-gate** — 品質ゲート管理
> **#planner** — タスク・会議・計画
> **#research** — 調査レポート
> **#codex-review** — AIレビュー結果
> **#fix-tasks** — 自動修復タスク
> **#project-status** — 総合モニタリング
> **#auto-runner-log** — バッチ・自動通知

━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 **管理者コマンド**
━━━━━━━━━━━━━━━━━━━━━━━━━━
\`\`\`
!restart [confirm]   → Bot 再起動
!doctor              → システム診断
!batch               → バッチ手動実行
!help                → 全コマンド一覧
\`\`\``;

// ── changelogメッセージ（分割投稿 ×2）─────────────────
const CHANGELOG_PART1 = `\
📝 **AI_WORKER 更新履歴**

━━━━━━━━━━━━━━━━━━━━━━━━━━
**2026-06-01 — Phase F-4 HUMAN_CHECK 完成**
━━━━━━━━━━━━━━━━━━━━━━━━━━

🆕 **新機能**

✅ **HUMAN_CHECK** — AIが判断できない場面で人間に確認を求める
　AUTH/PERMISSION エラー・AWAITING 状態・soft_red_unresolved
　→ \`!approve <id>\` で承認・ループ再開
　→ \`!deny <id>\` で却下・安全停止

✅ **approve/deny ループ再開** — !approve が activeRuns から
　該当コンテキストを探し _runProjectLoop を再開
　（二重承認防止・stopReason チェック付き）

✅ **!project stop awaiting_human 対応** —
　人間確認待ち中に stop しても activeRuns を確実にクリーンアップ

🔧 **修正**

✅ C-1: _handleHumanCheck が approvalManager.createApproval を呼ぶように
　→ 従来は approval record が作られず !approve/!deny が無効だった

✅ H-1: !project stop 中の activeRuns リーク修正
　→ awaiting_human 状態で stop → _teardown 直接呼び出しで確実解放

━━━━━━━━━━━━━━━━━━━━━━━━━━
**2026-06-01 — Phase G-1 Discord Organization**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Discord カテゴリ・チャンネル構成を整備（6カテゴリ・12チャンネル）
✅ !help を Phase F-4 対応に全面改訂（!project run / !quality / !company 追加）
✅ README.md を Phase F-4 ベースに全面改訂
✅ docs/project_status.md を最新化（テスト192件・MVP 100%）`;

const CHANGELOG_PART2 = `\
━━━━━━━━━━━━━━━━━━━━━━━━━━
**2026-05-31 — Phase F-2/F-3**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **MID-RUN Quality Gate** — 3タスク完了ごとに品質チェック
　YELLOW → 警告継続 / RED → 即停止

✅ **soft RED auto-FIX** — レビュー失敗タスクを検出し
　FIX タスクを自動生成（優先度: 高）

✅ **lastMidRunTasksDone** — MID-RUN Gate の重複発火防止

━━━━━━━━━━━━━━━━━━━━━━━━━━
**2026-05-30 — Phase E-6 / F-0 / F-1**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **Quality Gate** — GREEN/YELLOW/RED 判定
✅ **!project run** — 完全自律実行ループ（_runProjectLoop）
✅ **!project stop** — 停止リクエスト（安全停止）
✅ **RunContext** — per-run 実行状態管理

━━━━━━━━━━━━━━━━━━━━━━━━━━
**2026-05-29 — Phase E-1〜E-5**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **Auto Policy** — BLOCKED / HUMAN_APPROVAL / AI_REVIEW / AUTO_SAFE
✅ **Worker Registry** — IMPLEMENTER / REVIEWER / TESTER / RESEARCHER
✅ **Task Lease** — ソフトロック（30分）・期限切れ自動解放
✅ **Timeout Auto Split** — タイムアウトタスクを3分割・再分割防止
✅ **Company Staffing** — !company staff / assign

━━━━━━━━━━━━━━━━━━━━━━━━━━
**2026-05-28 — Phase 1〜D**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Discord Bot 基盤（Phase 1）
✅ GitHub 自動コミット・Codex レビュー（Phase 2）
✅ PR 自動作成・フィードバック適用（Phase 3）
✅ タスク管理・バッチ・AI会議（Phase 4）
✅ タスクキュー・承認フロー（Phase 5）
✅ Auto Project Runner・LLM Planner（Phase D）
✅ Secret Masking（GitHub PAT・Bearer token）`;

// ── 投稿処理 ─────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

async function postAndPin(channelId, messages, label) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) { console.error(`❌ チャンネル取得失敗: ${channelId}`); return; }

  // 既存の Bot メッセージを削除（再実行冪等）
  try {
    const fetched = await channel.messages.fetch({ limit: 10 });
    const botMsgs = fetched.filter(m => m.author.id === client.user.id);
    for (const [, m] of botMsgs) await m.delete().catch(() => {});
    if (botMsgs.size > 0) console.log(`  🗑️  既存 Bot メッセージ ${botMsgs.size} 件削除`);
  } catch { /* 権限なしは無視 */ }

  // 投稿
  const posted = [];
  for (const text of messages) {
    const m = await channel.send(text);
    posted.push(m);
  }

  // 最初のメッセージをピン留め
  try {
    await posted[0].pin();
    console.log(`  📌 ピン留め完了`);
  } catch { console.log(`  ⚠️  ピン留めには「メッセージをピン留めする」権限が必要です`); }

  console.log(`✅ ${label} 投稿完了 (${messages.length}件)`);
}

client.once('ready', async () => {
  console.log(`\n✅ Bot ログイン: ${client.user.tag}\n`);

  console.log('📢 #ai-worker-guide に投稿中...');
  await postAndPin(GUIDE_CHANNEL_ID, [GUIDE_PART1, GUIDE_PART2], '#ai-worker-guide');

  console.log('\n📝 #changelog に投稿中...');
  await postAndPin(CHANGELOG_CHANNEL_ID, [CHANGELOG_PART1, CHANGELOG_PART2], '#changelog');

  console.log('\n✅ 全投稿完了');
  client.destroy();
});

client.login(TOKEN).catch(err => {
  console.error('❌ ログイン失敗:', err.message);
  process.exit(1);
});
