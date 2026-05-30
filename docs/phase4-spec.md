# Phase4 仕様書 - タスク管理・ナイトバッチ・AI会議

## 概要

Phase3（Codexフィードバック・GitHub PR・レビュー履歴）に以下を追加。

---

## 追加された機能

### 1. タスク管理（`bot/utils/task-manager.js`）

#### タスクの状態遷移

```
未着手 → 作業中 → レビュー待ち → 人間確認待ち → 完了
                                              ↕
                                            保留（いつでも）
```

#### 保存先

| ファイル | 内容 |
|---------|------|
| `data/tasks.json` | 現在の全タスク（アクティブ） |
| `data/history/YYYY-MM.json` | 月次アーカイブ（完了タスク） |

#### タスク情報

| フィールド | 内容 |
|-----------|------|
| id | タスクID（例: task_1748344800000） |
| prompt | 依頼内容（最大500文字） |
| state | 現在の状態 |
| priority | 優先度（高/中/低） |
| dangerLevel | 危険度（高/中/低） |
| assignee | 担当AI |
| requestedBy | 依頼したDiscordユーザーID |
| reviewResult | AIレビュー結果 |
| prUrl | PR URL（PR作成時） |
| stateHistory | 状態変更の時系列ログ |

#### Discord コマンド

```
!task list                  タスク一覧（優先度順）
!task <タスクID>            タスク詳細
!task done <タスクID>       タスクを完了にする
!task hold <タスクID>       タスクを保留にする
!task stats                 タスク統計
```

---

### 2. 優先度スコアリング（`bot/utils/priority.js`）

#### 優先度判定ロジック

| 条件 | スコア変動 |
|------|----------|
| 緊急・至急・urgentなどのキーワード | +1（最大+3） |
| バグ・エラー・クラッシュなど | +1 |
| セキュリティ・脆弱性など | +1 |
| 本番・production・deployなど | +1 |
| 整理・リファクタ・ドキュメントなど | -1 |
| 将来・いずれ・そのうちなど | -1 |
| 危険度「高」 | +1 |
| 危険度「低」 | -1 |

#### スコアからラベルへ

| スコア | 優先度 |
|--------|--------|
| 2以上 | 高 |
| 1〜0 | 中 |
| -1以下 | 低 |

---

### 3. ナイトバッチ（`bot/utils/night-batch.js`）

#### 実行内容

| 処理 | 詳細 |
|------|------|
| ログアーカイブ | 7日超の `.log` ファイルを `logs/archive/` へ移動 |
| レビューアーカイブ | 30日超の `codex_*.md` / `review_*.md` を `reviews/archive/` へ移動 |
| タスク確認 | 24時間以上「作業中」のタスクを検出・警告 |
| GitHub確認 | GitHub API 接続テスト |
| レポート保存 | `docs/batch_YYYY-MM-DD.md` に結果を保存 |
| Discord通知 | バッチ結果を指定チャンネルへ送信 |

#### 設定

```env
BATCH_ENABLED=true     バッチ有効（デフォルト: true）
BATCH_HOUR=2           実行時刻（時）
BATCH_MINUTE=0         実行時刻（分）
BATCH_MAX_RUNS=0       最大実行回数（0=無制限）
BATCH_CHANNEL_ID=      通知チャンネル（空=通知なし）
```

#### 手動実行

```
!batch
```

#### 重要な制約

- **削除なし**: ファイルは移動のみ（`rename`）、`unlink` は使わない
- **パッケージ追加なし**: Node.js 標準モジュールのみ
- **実行上限**: `BATCH_MAX_RUNS` で暴走防止

---

### 4. AI 会議（`bot/utils/ai-meeting.js`）

#### 概要

`!meeting <議題>` を受信すると、Claude Code に「3者討論プロンプト」を送り、
Claude / Codex / ChatGPT が議論する場面をシミュレーションして決定を下す。

#### 会議フロー

```
!meeting <議題>
  ↓
Claude Code に討論プロンプトを送信
  ↓
議論を生成（Claude が3者の立場で発言）
  ↓
決定事項を抽出:
  - 優先度: 高/中/低
  - 担当: Claude Code / Codex / ChatGPT / 人間
  - 推奨アクション
  - 人間確認が必要か
  ↓
docs/meetings/YYYY-MM-DD_議題.md に保存
  ↓
Discord に要約を通知
  ↓
人間確認が必要なら @ユーザー にメンション
```

#### 議事録の保存先

`docs/meetings/YYYY-MM-DD_議題.md`

#### Discord コマンド

```
!meeting <議題>
```

**例:**
```
!meeting 次にどの機能を優先して作るべきか
!meeting ナイトバッチの実行時刻を変更すべきか
!meeting エラーログが急増している原因調査
```

#### 設定

```env
MEETING_CHANNEL_ID=    会議結果通知チャンネル（空=コマンドchへ）
```

---

### 5. 新コマンド一覧

| コマンド | 説明 |
|---------|------|
| `!claude <指示>` | Claude Code に作業依頼（Phase1から継続） |
| `!task list` | **NEW** タスク一覧（優先度順） |
| `!task <ID>` | **NEW** タスク詳細 |
| `!task done <ID>` | **NEW** タスクを完了にする |
| `!task hold <ID>` | **NEW** タスクを保留にする |
| `!task stats` | **NEW** タスク統計 |
| `!meeting <議題>` | **NEW** AI チーム会議 |
| `!batch` | **NEW** ナイトバッチを手動実行 |
| `!apply-review <ID>` | Codex回答をフィードバック（Phase3から継続） |
| `!create-pr <ID>` | PRを手動作成（Phase3から継続） |
| `!history [ID]` | レビュー履歴を表示（Phase3から継続） |
| `!help` | コマンド一覧 |

---

## 処理フロー（Phase4完全版）

```
!claude コマンド受信
  │
  ├─ Phase4: タスク作成（状態: 未着手 → 作業中）
  │
  ├─ STEP1: Claude Code 実行
  │
  ├─ STEP2: AI レビュー → #ai-review
  │   ├─ Phase4: タスク状態 → レビュー待ち
  │   ├─ 却下推奨 → 人間メンション / タスク状態 → 人間確認待ち
  │   └─ 問題なし/修正推奨 → 続行
  │
  ├─ STEP3: Codex 依頼生成 → #codex-review
  │
  ├─ STEP4: 自動フィードバック（ENABLE_AUTO_FEEDBACK=true時）
  │
  ├─ STEP5: GitHub 操作
  │   ├─ ENABLE_PR=true → PR作成 → Phase4: タスク状態 → 人間確認待ち
  │   └─ ENABLE_GITHUB=true → 直接Push → Phase4: タスク状態 → 完了
  │
  ├─ STEP6: 次タスク担当判断 → docs/next_task.md
  │
  └─ STEP7: 完了通知

!task list / !task <ID>
  → data/tasks.json を読み込み → Discord に表示

!meeting <議題>
  → Claude Code に討論プロンプト → 議事録保存 → Discord 通知

!batch
  → 手動バッチ実行 → Discord 通知

ナイトバッチ（毎日 BATCH_HOUR 時）
  → ログ整理 → レビュー整理 → タスク確認 → GitHub確認 → 通知
```

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| バッチの暴走 | `BATCH_MAX_RUNS` で実行上限設定 |
| ファイル削除の誤爆 | `renameSync` のみ使用、`unlink` は禁止 |
| AI会議の無限ループ | タイムアウト2分（変更不可） |
| tasks.json 破損 | try/catch で空配列にフォールバック |
| 完了タスクの肥大化 | 月次アーカイブ（data/history/YYYY-MM.json） |

---

## Phase5 以降の予定（現在未実装）

- PR マージ後の自動デプロイ通知
- タスクの自動優先度再評価（朝バッチ）
- 複数 AI の並列実行（タスクキュー）
- Web ダッシュボード（タスク状況の可視化）

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-05-28 | Phase1: Discord Bot 基本構成 |
| 2026-05-28 | Phase2: GitHub Push / Codex依頼 / AIレビュー |
| 2026-05-28 | Phase3: Codexフィードバック / PR自動作成 / 履歴強化 |
| 2026-05-28 | Phase4: タスク管理 / ナイトバッチ / AI会議 / 優先度スコアリング |
