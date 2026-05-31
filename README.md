# AI_WORKER Bot — 自律 AI 開発チーム

**Phase F-4** | スマホの Discord から指示を送ると、Windows PC 上で Claude Code が計画・実装・レビュー・品質判定・自己修復まで自律的に動くシステムです。

---

## これで何ができる？

```
スマホ → Discord に !project run を送る
          ↓
        AI が自律ループを開始
          ↓
        📋 計画（RESEARCH → DOCS → IMPLEMENT）
        🔨 実装（Claude Code CLI）
        🔍 レビュー（Codex / GPT-4o）
        📊 品質判定（Quality Gate: GREEN / YELLOW / RED）
        🔧 自己修復（soft RED → FIX タスク自動生成）
        ❓ 人間確認（HUMAN_CHECK → !approve / !deny）
          ↓
        結果・ログが Discord に届く
          ↓
        GitHub に自動コミット・Push
```

---

## セットアップ手順

### 必要なもの

| ツール | 説明 | 入手先 |
|--------|------|--------|
| Node.js 18以上 | Bot を動かす基盤 | https://nodejs.org → LTS版 |
| Claude Code | AI がコードを書くツール | `npm install -g @anthropic-ai/claude-code` |
| Discord Bot | Discord と PC をつなぐ橋 | 下記手順で作成 |

---

### STEP 1: Node.js をインストール

1. https://nodejs.org を開く
2. **「LTS」** をクリックしてダウンロード・インストール
3. 確認：
   ```
   node --version
   ```
   `v18.x.x` と表示されればOK

---

### STEP 2: Claude Code をインストール

```powershell
npm install -g @anthropic-ai/claude-code
claude   # 初回ログイン
```

---

### STEP 3: Discord Bot を作る

1. https://discord.com/developers/applications → 「New Application」
2. 左メニュー「Bot」→「Add Bot」→「MESSAGE CONTENT INTENT」をオン
3. 「Reset Token」でトークンをコピー（他人に見せないこと）
4. 「OAuth2」→「URL Generator」→ `bot` スコープ + `Send Messages / Read Messages / Embed Links / Read Message History` でサーバーに招待

---

### STEP 4: 環境変数を設定する

```powershell
Copy-Item .env.example .env
notepad .env
```

| 設定名 | 説明 |
|--------|------|
| `DISCORD_TOKEN` | Bot のトークン |
| `ALLOWED_CHANNEL_IDS` | 監視チャンネル ID（カンマ区切りで複数可）|
| `DISCORD_OWNER_ID` | あなた自身のユーザー ID |
| `OPENAI_API_KEY` | Codex レビュー用（任意）|
| `GITHUB_TOKEN` | GitHub 自動 Push 用（任意）|
| `BATCH_CHANNEL_ID` | バッチ通知チャンネル ID（任意）|

チャンネル ID の取得: Discord 設定 → 詳細設定 → 開発者モード ON → チャンネル右クリック →「ID をコピー」

---

### STEP 5: 起動する

```powershell
npm start
```

以下が表示されれば成功：
```
✅ AI_WORKER Bot がオンラインになりました
```

---

## 使い方

### 基本フロー（推奨）

```
① プロジェクト作成
   !project create <名前>

② タスク登録（任意 — AI が自動生成するので省略可）
   !task add <やりたいこと>

③ 自律ループ開始
   !project run <名前>

④ 人間確認が来たら
   !task show <taskId>    ← 内容確認
   !approve <taskId>      ← 承認 → ループ再開
   !deny <taskId>         ← 却下 → 停止

⑤ 停止
   !project stop <名前>
```

---

### 状態確認コマンド

| コマンド | 内容 |
|---------|------|
| `!project runner status` | ループ状況・loopCount・品質スコア |
| `!quality status [id]` | Quality Gate 状態（GREEN/YELLOW/RED）|
| `!task list` | タスク一覧（優先度順）|
| `!task stats` | タスク統計 |
| `!worker list` | AI Worker 一覧 |
| `!doctor` | システム診断 |

---

### Claude Code に直接作業を依頼（単発）

```
!claude <やりたいこと>
```

---

## Discord チャンネル推奨構成

```
📁 AI_WORKER
├── 📢 INFORMATION
│   ├── #ai-worker-guide    ← 使い方ガイド（固定メッセージ）
│   └── #changelog          ← 更新履歴
├── 🚀 OPERATIONS
│   ├── #project-run        ← !project run / stop / runner status
│   ├── #human-check        ← HUMAN_CHECK 通知 / !approve / !deny
│   └── #quality-gate       ← !quality status / gate / report
├── 🧠 PLANNING
│   ├── #planner            ← !project plan / !task / !meeting
│   └── #research           ← !research
├── 🔍 REVIEW
│   ├── #codex-review       ← !review / !codex
│   └── #fix-tasks          ← !apply-review / soft RED 通知
└── 📊 MONITORING
    ├── #project-status     ← !task stats / !worker / !doctor
    └── #auto-runner-log    ← バッチ・MID-RUN Gate 自動通知
```

> **ヒント:** `!project run` を `#human-check` から起動すると
> HUMAN_CHECK 通知がそのチャンネルに届き、`!approve/!deny` が集約されます。

---

## コマンド一覧

`!help` を Discord で送ると最新のコマンド一覧が表示されます。

主要コマンド：

| カテゴリ | コマンド |
|---------|---------|
| 自律ループ | `!project run/stop <id>` |
| 人間確認 | `!approve / !deny <taskId>` |
| 品質ゲート | `!quality status/report/gate` |
| プロジェクト | `!project create/list/switch/plan` |
| タスク | `!task list/add/done/hold/show` |
| 人員管理 | `!worker add/list` / `!company staff/assign` |
| レビュー | `!codex / !review / !apply-review` |
| 会議 | `!meeting <議題>` |
| システム | `!restart / !doctor / !batch` |

---

## フォルダ構成

```
AI_WORKER/
├─ bot/
│   ├─ index.js                Bot 本体（コマンドルーター）
│   └─ utils/
│       ├─ claude-runner.js    Claude Code CLI 実行
│       ├─ task-manager.js     タスク CRUD
│       ├─ auto-project-runner.js  Auto Runner
│       ├─ quality-gate.js     Quality Gate 判定
│       ├─ auto-policy.js      タスク安全分類
│       ├─ worker-registry.js  Worker 役割管理
│       ├─ approval-manager.js 承認フロー
│       ├─ project-manager.js  プロジェクト管理
│       ├─ project-planner.js  LLM 計画生成
│       ├─ codex.js            OpenAI API
│       ├─ github.js           git commit/push
│       └─ night-batch.js      定期バッチ
├─ data/
│   ├─ tasks.json              タスクデータ
│   ├─ projects.json           プロジェクトデータ
│   ├─ workers.json            Worker データ
│   └─ approvals.json          承認待ちデータ
├─ workspace/                  Claude Code の作業場所
├─ docs/                       設計書・仕様書・ステータス
├─ reviews/                    Codex レビュー記録
├─ logs/                       Bot 実行ログ
├─ tests/                      自動テスト（92件）
├─ scripts/
│   └─ start.ps1               起動スクリプト
└─ .env.example                環境変数テンプレート
```

---

## よくあるエラーと対処法

| エラー | 対処 |
|--------|------|
| `DISCORD_TOKEN が設定されていません` | `.env` に `DISCORD_TOKEN` を設定 |
| `MESSAGE CONTENT INTENT` エラー | Discord Developer Portal → Bot → Intent をオン |
| Bot がオフライン | Token が正しいか確認（スペースに注意）|
| `!project run` が RED で止まる | `!quality status` で原因を確認 → `!approve` または手動修正 |
| HUMAN_CHECK 通知が来た | `!task show <id>` で内容確認 → `!approve` / `!deny` |

---

## 実装済み機能（Phase F-4 時点）

| フェーズ | 機能 |
|---------|------|
| Phase 1 | Discord Bot 基盤・Claude Code 連携・セキュリティチェック |
| Phase 2 | GitHub 自動コミット・Codex レビュー・危険度判定 |
| Phase 3 | PR 自動作成・フィードバック適用・レビュー履歴 |
| Phase 4 | タスク管理・優先度ソート・AI 会議・バッチ処理 |
| Phase 5 | タスクキュー・高危険度承認フロー・Bot 再起動 |
| Phase D | Auto Project Runner・LLM Planner・Secret Masking |
| Phase E | Auto Policy・Worker Registry・Task Lease・Quality Gate・Company Staffing |
| Phase F | RunContext・!project run/stop・MID-RUN Gate・soft RED auto-FIX・HUMAN_CHECK |

---

## セキュリティ

- GitHub PAT・Bearer トークンは Discord に表示されません（自動マスク）
- 危険コマンド（`rm -rf` 等）は事前にブロック
- 高危険度タスクは `!approve` で人間が承認するまで実行されません
- トークンは `.env` で管理し Git には含まれません

---

*AI_WORKER Phase F-4 | 2026-06-01*
