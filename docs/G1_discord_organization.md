# Phase G-1 Discord Organization 設計書

**作成日:** 2026-06-01  
**対象バージョン:** Phase F-4 HUMAN_CHECK 完成後  
**commit:** `38b0ef3` fix: C-1 HUMAN_CHECK approval record + awaiting_human cleanup

---

## 1. 現在構成 ── 調査結果

### 1-1. Discord チャンネル構成（現時点の想定）

現在の `ALLOWED_CHANNEL_IDS` はカンマ区切りで複数チャンネルを許可しているが、
専用カテゴリ・チャンネル設計は未定義。  
Bot は「許可されたどのチャンネルでも」コマンドを受け付ける。

**現状の問題点:**
- チャンネルと機能の対応が明示されていない
- human-check の通知がどのチャンネルに届くか不定（`channelId` = 発話チャンネル）
- 品質ゲート・ランナーログ専用チャンネルがない

---

### 1-2. `!help` の現状（Phase E-5b 表記のまま）

フッター: `AI_WORKER Phase E-5b | 半自律AI開発チーム`

掲載コマンド（古い順・新しい順）:

| カテゴリ | コマンド | 状態 |
|---------|---------|------|
| Claude Code | `!claude <指示>` | ✅ 現役 |
| Codex | `!codex <内容>` | ✅ 現役 |
| タスク管理 | `!task list/done/hold/resume/stats` | ✅ 現役 |
| AI会議 | `!meeting <議題>` | ✅ 現役 |
| 承認フロー | `!approve / !deny / !pause / !resume` | ⚠️ 説明が旧世代（高危険度 !claude のみ記載）|
| 再起動 | `!restart [confirm]` | ✅ 現役 |
| キュー | `!queue / !queue clear` | ✅ 現役 |
| 実行 | `!next / !run-next` | ⚠️ 旧世代フロー（!project run 未掲載）|
| Auto Runner | `!auto run 1` | ⚠️ 旧世代（Phase3）|
| Auto Runner | `!auto on` | ⚠️ 旧世代（Phase4）|
| バッチ | `!batch` | ✅ 現役 |
| Worker役割 | `!worker add/list/rm/status` | ✅ 現役 |
| システム診断 | `!doctor` | ✅ 現役 |
| ヘルプ | `!help` | ✅ 現役 |

**未掲載の重要コマンド（F-4 まで実装済み）:**

| コマンド | 実装フェーズ |
|---------|-----------|
| `!project run <id>` | F-0/F-1 |
| `!project stop <id>` | F-0/F-1 |
| `!project runner status` | E-5c |
| `!project runner on/off` | E-5c |
| `!quality status [id]` | E-6 |
| `!quality gate list/add/remove/check` | E-6 |
| `!quality report [id]` | E-6 |
| `!company staff [id]` | E-5b |
| `!company assign [id] [--preview]` | E-5b |
| `!approve <taskId>` での HUMAN_CHECK 再開 | F-4 |
| `!deny <taskId>` での HUMAN_CHECK 停止 | F-4 |
| `!task show <id>` | F-4 |

---

### 1-3. README.md の現状

**フェーズ:** Phase 1 固定（`# AI_WORKER Bot - Phase 1` と明記）  
**説明モデル:** `!claude <指示>` → Claude Code → 結果通知 の単純フロー  
**未反映:**
- Auto Project Runner
- Quality Gate
- HUMAN_CHECK / approve / deny
- !project run 自律ループ
- Worker / Company 人員管理

---

### 1-4. docs/ ディレクトリの現状

| ファイル | 内容 | 鮮度 |
|---------|------|------|
| `phase1-spec.md` ～ `phase5-spec.md` | Phase 1〜5 の仕様書 | 古い（Phase 5 = タスクキュー止まり）|
| `project_status.md` | Phase A-D までのステータスレポート | 古い（2026-05-31作成・F-4未反映）|
| `auto-project-runner-design.md` | Phase E-F の設計方針 | 最新に近い |
| `auto-project-runner-spec.md` | !apr コマンド仕様（一部未実装）| 参照用 |
| `meetings/2026-05-28_*.md` | AI会議議事録 | 旧世代 |
| `batch_2026-05-*.md` | バッチログ | 自動生成・随時 |

---

## 2. 推奨 Discord 構成

### 2-1. カテゴリ・チャンネル設計

```
📁 AI_WORKER
│
├── 📢 INFORMATION
│   ├── #ai-worker-guide       ← 固定メッセージ: 使い方ガイド（新版）
│   └── #changelog             ← 固定メッセージ: 最新変更履歴
│
├── 🚀 OPERATIONS
│   ├── #project-run           ← !project run / stop / runner status
│   ├── #human-check           ← HUMAN_CHECK 通知専用・approve / deny
│   └── #quality-gate          ← !quality status / gate / report
│
├── 🧠 PLANNING
│   ├── #planner               ← !project plan / !task add / !meeting
│   └── #research              ← !research list / show
│
├── 🔍 REVIEW
│   ├── #codex-review          ← !review list/show・Codex 自動レビュー通知
│   └── #fix-tasks             ← !apply-review・soft RED auto-FIX 通知
│
├── 📊 MONITORING
│   ├── #project-status        ← !project runner status・!task stats・!doctor
│   └── #auto-runner-log       ← BATCH_CHANNEL_ID 向け・バッチ通知・MID-RUN Gate 通知
│
└── 📦 ARCHIVE
    └── #archive               ← 旧通知・完了済みスレッド移動先
```

### 2-2. 各チャンネルの役割と主要コマンド

#### `#project-run`
```
!project run <projectId>      → 自律ループ開始
!project stop <projectId>     → 停止（awaiting_human中も安全停止）
!project runner status        → ループ状況・loopCount・softRED回数
!project runner on/off        → Auto Runner 有効化/無効化
!project list                 → プロジェクト一覧
!project create <名前>         → プロジェクト作成
!project switch <名前>         → プロジェクト切替
```

#### `#human-check` ← 最重要・新設推奨
```
（通知）⚠️ 人間確認が必要です: <タスクID>
!task show <taskId>            → タスク詳細確認
!approve <taskId>             → 承認→ループ再開
!deny <taskId>                → 却下→安全停止
```
> **理由:** HUMAN_CHECK 通知は channelId = 発話チャンネルに届く。
> 専用チャンネルを `ALLOWED_CHANNEL_IDS` に追加して
> `!project run` をそこから起動すれば通知が集約される。

#### `#quality-gate`
```
!quality status [projectId]   → 現在の品質状態（GREEN/YELLOW/RED）
!quality gate list            → 登録ゲート一覧
!quality gate add/remove      → ゲート管理
!quality report [projectId]   → 詳細レポート
```

#### `#planner`
```
!project plan [projectId]     → タスク候補表示
!project plan apply           → 上位3件登録
!task add <内容>              → タスク手動追加
!task list                    → タスク一覧
!meeting <議題>               → AI 3者会議
!company staff [id]           → 推奨人員表示
!company assign [id]          → 人員適用
```

#### `#research`
```
!research list                → 調査レポート一覧
!research show <ID>           → 詳細表示
```

#### `#codex-review`
```
!review list                  → Codex レビュー一覧
!review show <ID>             → 詳細表示
!codex <内容>                 → 手動レビュー依頼
```

#### `#fix-tasks`
```
!apply-review <taskId>        → Codex フィードバック適用
（通知）🔴 soft RED 検出 → FIX タスク自動生成
```

#### `#project-status`
```
!project runner status        → 総合ステータス
!task stats                   → タスク統計
!worker list                  → Worker 一覧
!doctor                       → システム診断
```

#### `#auto-runner-log`
> BATCH_CHANNEL_ID に設定することで自動受信
```
（自動）MID-RUN Quality Gate 結果
（自動）毎朝バッチ・夜バッチ通知
（自動）ループ完了サマリー
```

---

## 3. 更新対象一覧

### 3-1. 優先度 HIGH（すぐ更新すべき）

| 対象 | 現状 | 更新内容 |
|------|------|---------|
| `!help` フッター | `Phase E-5b` | `Phase F-4` に更新 |
| `!help` 承認フロー説明 | 高危険度 !claude のみ | HUMAN_CHECK での !approve/!deny 用途を追記 |
| `!help` 未掲載コマンド | !project run/stop/quality/company 未掲載 | 追加（下記④参照）|
| `!help` 旧コマンド説明 | `!auto run 1`（Phase3）| `!project run` に置き換え |
| README.md タイトル | `Phase 1` 固定 | `Phase F-4（自律AI開発チーム）` に更新 |
| README.md 説明モデル | !claude 単発フロー | !project run 自律ループを中心に書き直し |

### 3-2. 優先度 MEDIUM（今週中）

| 対象 | 現状 | 更新内容 |
|------|------|---------|
| `docs/project_status.md` | Phase D 止まり（2026-05-31）| Phase E〜F-4 の完成機能・テスト状況を反映 |
| `#ai-worker-guide` 固定メッセージ | 未作成 | 新ガイド草案（④）を掲載 |
| `#changelog` 固定メッセージ | 未作成 | changelog草案（⑤）を掲載 |

### 3-3. 優先度 LOW（Phase G-2 以降）

| 対象 | 現状 | 更新内容 |
|------|------|---------|
| `docs/auto-project-runner-spec.md` | !apr コマンド記載（未実装）| !project run ベースに整理 |
| phase1〜5-spec.md | 旧世代 | アーカイブフォルダへ移動 |
| `#human-check` 専用チャンネル設定 | 未設定 | ALLOWED_CHANNEL_IDS に追加 |

---

## 4. 新しいガイド草案（`#ai-worker-guide` 固定メッセージ用）

```
🤖 AI_WORKER — 自律AI開発チーム ガイド
Phase F-4 | 2026-06-01 更新

━━━━━━━━━━━━━━━━━━━━━
🚀 基本の使い方（自律ループ）
━━━━━━━━━━━━━━━━━━━━━

① プロジェクトを作成
   !project create <プロジェクト名>

② タスクを登録（必要なら）
   !task add <やりたいこと>
   ※ AI が自動でタスクを生成するので手動登録は任意

③ 自律ループ開始
   !project run <プロジェクト名>

   → AI が以下を自動で実行します：
      📋 計画（RESEARCH → DOCS → IMPLEMENT）
      🔨 実装（Claude Code）
      🔍 レビュー（Codex GPT-4o）
      📊 品質判定（Quality Gate）
      🔧 自己修復（soft RED → FIX タスク自動生成）
      ❓ 人間確認（HUMAN_CHECK → !approve / !deny）

④ 停止
   !project stop <プロジェクト名>

━━━━━━━━━━━━━━━━━━━━━
❓ 人間確認が来たら（HUMAN_CHECK）
━━━━━━━━━━━━━━━━━━━━━

AIが判断できない場面で通知が届きます。

   !task show <taskId>    → 内容確認
   !approve <taskId>      → 承認 → ループ再開
   !deny <taskId>         → 却下 → 安全停止

━━━━━━━━━━━━━━━━━━━━━
📊 状態確認
━━━━━━━━━━━━━━━━━━━━━

   !project runner status → ループ状況・loopCount
   !quality status        → 品質スコア（GREEN/YELLOW/RED）
   !task list             → タスク一覧
   !task stats            → 統計
   !worker list           → AI Worker 一覧
   !doctor                → システム診断

━━━━━━━━━━━━━━━━━━━━━
📋 チャンネル案内
━━━━━━━━━━━━━━━━━━━━━

   #project-run    → ループ実行・停止
   #human-check    → 人間確認・approve/deny
   #quality-gate   → 品質ゲート管理
   #planner        → タスク・会議・計画
   #codex-review   → AIレビュー結果
   #fix-tasks      → 自動修復タスク
   #project-status → 総合モニタリング
   #auto-runner-log → バッチ・自動通知

━━━━━━━━━━━━━━━━━━━━━
🔧 管理者コマンド
━━━━━━━━━━━━━━━━━━━━━

   !restart [confirm]     → Bot 再起動
   !doctor                → システム診断
   !queue                 → タスクキュー確認
   !batch                 → バッチ手動実行
```

---

## 5. changelog 草案（`#changelog` 固定メッセージ用）

```
📝 AI_WORKER 更新履歴

━━━━━━━━━━━━━━━━━━━━━
2026-06-01  Phase F-4 HUMAN_CHECK 完成
━━━━━━━━━━━━━━━━━━━━━

🆕 新機能

  ✅ HUMAN_CHECK — AIが判断できない場面で人間に確認を求める
     AUTH/PERMISSION エラー・AWAITING 状態・soft_red_unresolved
     → !approve <id> で承認・ループ再開
     → !deny <id> で却下・安全停止

  ✅ approve/deny ループ再開 — !approve が activeRuns から
     該当コンテキストを探し _runProjectLoop を再開
     （二重承認防止・stopReason チェック付き）

  ✅ !project stop awaiting_human 対応 —
     人間確認待ち中に stop しても activeRuns を確実にクリーンアップ

🔧 修正

  ✅ C-1: _handleHumanCheck が approvalManager.createApproval を呼ぶように
     → 従来は approval record が作られず !approve/!deny が無効だった

  ✅ H-1: !project stop 中の activeRuns リーク修正
     → awaiting_human 状態で stop → _teardown 直接呼び出しで確実解放

━━━━━━━━━━━━━━━━━━━━━
2026-05-31  Phase F-2/F-3 完成
━━━━━━━━━━━━━━━━━━━━━

  ✅ MID-RUN Quality Gate — 3タスク完了ごとに品質チェック
     YELLOW → 警告継続 / RED → 即停止

  ✅ soft RED auto-FIX — レビュー失敗タスクを検出し
     FIX タスクを自動生成（優先度: 高）

  ✅ lastMidRunTasksDone — MID-RUN Gate の重複発火防止

━━━━━━━━━━━━━━━━━━━━━
2026-05-30  Phase E-6 / F-0 / F-1 完成
━━━━━━━━━━━━━━━━━━━━━

  ✅ Quality Gate — GREEN/YELLOW/RED 判定
     RED トリガー: 認証エラー・バリデーション失敗・高危険 Codex
     !quality status / gate / report コマンド

  ✅ !project run — 完全自律実行ループ（_runProjectLoop）
     PRE-RUN QA → タスク取得 → IMPLEMENT/REVIEW/RESEARCH 分岐
     → MID-RUN Gate → POST-RUN QA → 完了通知

  ✅ !project stop — 停止リクエスト（次ループ区切りで安全停止）

  ✅ RunContext — per-run 実行状態管理
     stopRequested / stopReason / pendingApproval / tasksDone 等

━━━━━━━━━━━━━━━━━━━━━
2026-05-29  Phase E-1〜E-5 完成
━━━━━━━━━━━━━━━━━━━━━

  ✅ Auto Policy — BLOCKED / HUMAN_APPROVAL_REQUIRED /
     AI_REVIEW_REQUIRED / AUTO_SAFE 分類

  ✅ Worker Registry — IMPLEMENTER / REVIEWER /
     TESTER / RESEARCHER 役割登録
     !worker add/list/rm/status

  ✅ Task Lease — ソフトロック（30分）・期限切れ自動解放
     claimNextTask / releaseLease / reapExpiredLeases

  ✅ Timeout Auto Split — タイムアウトタスクを3分割
     再分割防止（rootTaskId ガード）

  ✅ Company Staffing — !company staff / assign
     プロジェクトに必要な Worker 役割を推奨・適用

━━━━━━━━━━━━━━━━━━━━━
2026-05-28  Phase 1〜Phase D 完成
━━━━━━━━━━━━━━━━━━━━━

  ✅ Discord Bot 基盤（Phase 1）
  ✅ GitHub 自動コミット・Codex レビュー（Phase 2）
  ✅ PR 自動作成・フィードバック適用（Phase 3）
  ✅ タスク管理・バッチ・AI会議（Phase 4）
  ✅ タスクキュー・承認フロー（Phase 5）
  ✅ Auto Project Runner・LLM Planner（Phase D）
  ✅ Secret Masking（GitHub PAT・Bearer token）
```

---

## 6. 実装が必要な項目

### 6-1. コード変更（bot/index.js）

| 項目 | 優先度 | 工数 |
|------|--------|------|
| `!help` のフッター更新 `Phase E-5b` → `Phase F-4` | 🔴 High | 小 |
| `!help` に `!project run/stop` を追加 | 🔴 High | 小 |
| `!help` に `!quality status/gate/report` を追加 | 🔴 High | 小 |
| `!help` に `!company staff/assign` を追加 | 🟡 Medium | 小 |
| `!help` の `!approve/!deny` 説明に HUMAN_CHECK 用途追記 | 🔴 High | 小 |
| `!help` から `!auto run 1`（旧 Phase3）を削除または非推奨化 | 🟡 Medium | 小 |

### 6-2. ドキュメント更新（コード変更不要）

| 項目 | 優先度 | 工数 |
|------|--------|------|
| `README.md` を Phase F-4 ベースに全面改訂 | 🔴 High | 中 |
| `docs/project_status.md` を Phase F-4 時点に更新 | 🟡 Medium | 中 |
| `docs/phase6-spec.md`（新規） E-F フェーズ仕様書 | 🟡 Medium | 大 |
| `docs/G1_discord_organization.md`（本ファイル）| ✅ 完了 | — |

### 6-3. Discord 設定（手動作業）

| 項目 | 優先度 | 工数 |
|------|--------|------|
| カテゴリ・チャンネル作成（推奨構成に従う）| 🟡 Medium | 小 |
| `#ai-worker-guide` に固定メッセージ投稿（④のガイド）| 🔴 High | 小 |
| `#changelog` に固定メッセージ投稿（⑤の changelog）| 🟡 Medium | 小 |
| `ALLOWED_CHANNEL_IDS` に新チャンネル ID を追加 | 🟡 Medium | 小 |
| `BATCH_CHANNEL_ID` を `#auto-runner-log` に設定 | 🟡 Medium | 小 |
| `MORNING_BATCH_CHANNEL_ID` を `#auto-runner-log` に設定 | 🟡 Medium | 小 |

### 6-4. Phase G-2 以降に先送りでよい項目

| 項目 | 理由 |
|------|------|
| HUMAN_CHECK 通知チャンネル固定化 | 現状でも機能する（発話チャンネルに通知）|
| チャンネルごとのコマンド制限 | Bot 改修が必要・現状は全チャンネル共通 |
| `!apr` エイリアス実装 | `!project run` で代替可能 |
| Web 管理ダッシュボード | Phase G 以降の大型タスク |

---

## 付録: コマンド全体マップ（Phase F-4 時点）

```
!project
  run <id>              → 自律ループ開始
  stop <id>             → ループ停止
  current               → 現在プロジェクト表示
  list                  → プロジェクト一覧
  create <名前>         → 新規作成
  switch <名前>         → 切替
  plan [id]             → タスク候補表示
  plan apply            → 上位3件登録
  runner status         → ループ状態表示
  runner on/off         → Auto Runner 有効化
  runner auto-apply on/off/status → 自動タスク登録

!quality
  status [id]           → 品質状態表示
  gate list             → ゲート一覧
  gate add/remove/check → ゲート管理
  report [id]           → 詳細レポート

!company
  staff [id]            → 推奨人員表示
  assign [id] [--preview] → 人員適用

!worker
  add <role> [id] [project] → 登録
  list                  → 一覧
  rm <id>               → 削除
  status                → 状況

!approve [taskId]       → 承認 / 一覧表示
!deny <taskId>          → 却下

!task
  list / <id> / show <id>     → 参照
  add <内容>            → 作成
  done/hold/resume <id> → 状態変更
  stats                 → 統計
  edit <id> <field> <value> → 編集
  split [preview] <id>  → 分割
  merge <id1> <id2>     → 統合
  archive               → アーカイブ
  cleanup               → 孤立整理

!claude <指示>          → Claude Code 直接実行
!codex <内容>           → Codex レビュー
!meeting [full] <議題>  → AI 3者会議
!apply-review <id>      → フィードバック適用
!create-pr <id>         → PR 作成
!history [id]           → レビュー履歴
!research list/show <id> → 調査レポート
!review list/show <id>  → Codex レビュー結果

!restart [confirm]      → Bot 再起動
!doctor                 → システム診断
!queue / !queue clear   → タスクキュー
!batch                  → バッチ手動実行
!help                   → ヘルプ表示
```

---

*このドキュメントは commit 作業なし・設計・文書作成のみ*  
*実装（!help 更新・README 改訂）は Phase G-1 Step2 として別途実施*
