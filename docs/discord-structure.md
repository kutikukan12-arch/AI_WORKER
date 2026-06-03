# AI_WORKER Discord 構成ガイド

**バージョン:** 2.0（会社脳フェーズ対応）  
**作成:** 2026-06-04  
**前バージョン:** docs/G1_discord_organization.md

---

## チャンネル構成

### 🏢 社内本部

| チャンネル | 用途 | 主なコマンド |
|-----------|------|------------|
| `#社長室` | CEO 最終判断 / 重要承認 / HUMAN_CHECK / 経営判断 | `!approve` `!deny` `!project run` |
| `#副社長室` | GPT 相談 / 方針整理 / AI社員への指示準備 / inbox 整理 | `!inbox check` `!inbox status` |
| `#黒川-進行管理` | 社員間配送 / 返信待ち管理 / ボトルネック検出 | `!inbox status` `!msg pending` `!workflow messages` |
| `#作業指示` | 社員への作業依頼 / task 投入 | `!task add` `!msg send` |

### 🤖 AI社員室

| チャンネル | 担当社員 | 用途 |
|-----------|---------|------|
| `#宮城-lead-engineer` | 宮城 Lead Engineer | 実装 / 修正 / 技術作業 |
| `#守谷-cto-review` | 守谷 CTO | READY / NEED_FIX / セキュリティ / 品質確認 |
| `#白石-coo` | 白石 COO | 優先順位 / 実行順 / 肥大化防止 |
| `#市川-pm` | 市川 PM | 要件整理 / MVP 判断 / 商品価値確認 |
| `#相沢-cs` | 相沢 CS | ユーザー視点 / β テスト / feedback 整理 |
| `#金森-cfo` | 金森 CFO | コスト / ROI / 課金判断 |
| `#育野-learning` | 育野 | Decision / Incident / Lesson / 組織学習 |
| `#神崎-vp` | 神崎 VP | 判断材料整理 / 社員意見統合 / 論点まとめ（決定はしない） |

### 📚 記録室

| チャンネル | 用途 | 主なコマンド |
|-----------|------|------------|
| `#decision-log` | 意思決定履歴 | `!decision log` `!decision list` |
| `#incident-log` | 障害 / 原因 / 再発防止 | `!incident open` `!incident list` |
| `#lesson-log` | 学習資産 / 改善ルール | LESSONS.md 参照 |
| `#release-log` | リリース判断 | `!quality status` |
| `#security-log` | 機密 / 権限 / security-check | `npm run security-check` |

---

## .env チャンネルID マッピング

新チャンネル構成に合わせて以下の設定を確認する。

| 環境変数 | 推奨チャンネル | 説明 |
|---------|--------------|------|
| `CEO_REPORT_CHANNEL_ID` | `#社長室` | CEO 向け日報・承認通知 |
| `HUMAN_CHECK_CHANNEL_ID` | `#社長室` | HUMAN_CHECK 承認依頼 |
| `AI_REVIEW_CHANNEL_ID` | `#守谷-cto-review` | AI レビュー結果通知 |
| `CODEX_REVIEW_CHANNEL_ID` | `#守谷-cto-review` | Codex レビュー結果通知 |
| `ERROR_CHANNEL_ID` | `#security-log` | エラー・セキュリティ通知 |
| `BATCH_CHANNEL_ID` | `#作業指示` | バッチ通知 |
| `MORNING_BATCH_CHANNEL_ID` | `#作業指示` | 朝バッチ通知 |
| `PR_CHANNEL_ID` | `#宮城-lead-engineer` | PR 通知 |
| `GITHUB_LOG_CHANNEL_ID` | `#宮城-lead-engineer` | GitHub push ログ |
| `AI_BOARD_CHANNEL_ID` | `#守谷-cto-review` | AI Board Report |
| `MEETING_CHANNEL_ID` | `#副社長室` | AI 会議結果 |

---

## セットアップ手順

### 1. チャンネル作成

```bash
# 冪等: 既存チャンネルはスキップ
node scripts/setup-company-discord.js
```

### 2. .env 更新

セットアップスクリプトが出力したチャンネル ID を `.env` に設定する。

### 3. Decision 初期登録

```bash
node scripts/init-company-decisions.js
```

### 4. Bot 再起動

```bash
npm start
```

---

## セキュリティ

- このチャンネル構成は社内限定（外部公開禁止）
- チャンネル ID は `.env` で管理
- `ALLOWED_CHANNEL_IDS` に新チャンネルを追加する
