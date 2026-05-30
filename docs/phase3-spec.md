# Phase3 仕様書 - Codexフィードバック・GitHub PR・レビュー履歴

## 概要

Phase2（GitHub Push・Codex依頼・AIレビュー）に以下を追加。

---

## 追加された機能

### 1. Codex回答 自動フィードバック（`bot/utils/codex-feedback.js`）

```
reviews/codex_task_ID.md を読む
  ↓
Codex 回答を解析（APIまたは手動記入）
  ↓
判定: 問題なし / 修正推奨 / 却下推奨
  ↓
修正推奨 → Claude Code に修正指示
却下推奨 → 人間確認
問題なし → スキップ
  ↓
workspace/task_ID/codex_feedback.md に保存
reviews/codex_task_ID.md に追記
```

#### 手動フィードバックの使い方

```
# 1. Codexのレビュー結果を手動記入する
#    reviews/codex_task_ID.md を開く
#    「Codex の回答」セクションに内容を貼り付け

# 2. Discord でコマンド実行
!apply-review task_1748344800000
```

#### 自動フィードバック（OPENAI_API_KEY設定時）

`.env` に設定:
```
OPENAI_API_KEY=sk-xxxxxxxxxx
ENABLE_AUTO_FEEDBACK=true
```

Claude Code 完了後、自動で Codex API を呼び出してフィードバックを適用。

---

### 2. GitHub PR 自動作成（`bot/utils/github-pr.js`）

```
フィーチャーブランチ作成: ai/task-XXXX
  ↓
git add -f workspace/task_ID/
  ↓
git commit（自動メッセージ）
  ↓
git push origin ai/task-XXXX
  ↓
GitHub API で PR 作成（feat: [AI] 〇〇）
  ↓
Discord に PR URL を通知
  ↓
人間確認メンション送信
  ↓
人間が GitHub で確認してマージ（自動マージ禁止）
```

#### PR本文に含まれる情報

| 項目 | 内容 |
|------|------|
| 変更内容 | Claude Code への依頼内容 |
| 変更理由 | 新機能追加/バグ修正など自動判断 |
| AIレビュー結果 | 問題なし/修正推奨/却下推奨 |
| Codexフィードバック | 適用済み/未適用 |
| 危険度 | 低/中/高 |
| 初心者向け説明 | 専門用語なしで何が起きるかを説明 |
| チェックリスト | マージ前の確認事項 |

#### 重要ルール

- **PR の自動マージは禁止**
- 必ず人間が GitHub でレビューしてからマージ
- 高危険度PRは `@ユーザー名` でメンション

#### 手動PR作成コマンド

```
!create-pr task_1748344800000
```

---

### 3. AIレビュー履歴（`bot/utils/review-history.js`）

#### 保存先

| ファイル | 内容 |
|---------|------|
| `reviews/history.md` | 全タスク共通の時系列ログ（テーブル形式） |
| `reviews/history/task_ID.md` | タスクごとの詳細ログ |

#### 記録対象イベント

| イベント | 記録タイミング |
|---------|-------------|
| Claude Code 実行 | タスク開始時 |
| AI レビュー | レビュー完了時 |
| Codex 依頼生成 | 依頼文生成時 |
| Codex 回答取得 | API回答取得時 |
| フィードバック適用 | !apply-review 実行時 |
| PR 作成 | PR作成完了時 |
| 人間確認 | メンション送信時 |
| 却下 | 却下推奨判定時 |
| エラー | エラー発生時 |

#### 履歴表示コマンド

```
!history                          # 最新10件の全体履歴
!history task_1748344800000       # 特定タスクの詳細
```

---

### 4. 新コマンド一覧

| コマンド | 説明 |
|---------|------|
| `!claude <指示>` | Claude Code に作業依頼（Phase1から継続） |
| `!apply-review <taskId>` | **NEW** Codex回答をフィードバック |
| `!create-pr <taskId>` | **NEW** PRを手動作成 |
| `!history [taskId]` | **NEW** レビュー履歴を表示 |
| `!help` | **NEW** コマンド一覧を表示 |

---

### 5. 人間確認フロー（強化）

#### メンションが送られる条件

| 条件 | 危険度 |
|------|--------|
| AIレビュー「却下推奨」 | 高 |
| Codex「却下推奨」 | 高 |
| Codex 依頼の危険度「高」 | 高 |
| PR 作成完了（常に） | PR の危険度に準じる |
| GitHub Push 失敗 | 中 |
| 重大エラー発生 | 高 |

#### メンション通知フォーマット

```
@ユーザー名

【確認してほしいこと】
PRをマージしてもいいですか？

【何が起きる？】
GitHub に新しい変更が作成されました

【メリット】
・コードが追加されます

【デメリット】
・マージすると本番に反映されます

【おすすめ】
おすすめ: はい（確認後）

【危険度】
🟡 中
```

---

## 処理フロー（Phase3完全版）

```
!claude コマンド受信
  │
  ├─ STEP1: Claude Code 実行
  │
  ├─ STEP2: AI レビュー → #ai-review
  │   ├─ 却下推奨 → 人間メンション
  │   └─ 問題なし/修正推奨 → 続行
  │
  ├─ STEP3: Codex 依頼生成 → #codex-review
  │   └─ OPENAI_API_KEY あり → API呼び出し → 回答保存
  │
  ├─ STEP4: 自動フィードバック（ENABLE_AUTO_FEEDBACK=true時）
  │   └─ Claude Code に修正指示 → 修正実施
  │
  ├─ STEP5: GitHub 操作
  │   ├─ ENABLE_PR=true  → フィーチャーブランチ作成 → Push → PR作成
  │   └─ ENABLE_GITHUB=true → 直接 Push（Phase2動作）
  │
  ├─ STEP6: 次タスク担当判断 → docs/next_task.md
  │
  └─ STEP7: 完了通知（全ステータスまとめ）
```

---

## 設定値一覧（Phase3追加分）

| 環境変数 | デフォルト | 説明 |
|---------|-----------|------|
| `ENABLE_PR` | `false` | PR作成を有効化 |
| `ENABLE_AUTO_FEEDBACK` | `false` | Codex自動フィードバックを有効化 |
| `PR_CHANNEL_ID` | （空） | PR通知専用Discordチャンネル |
| `HISTORY_CHANNEL_ID` | （空） | 履歴通知専用チャンネル |

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| PRの自動マージ | 実装なし（設計上禁止） |
| フィーチャーブランチの蓄積 | 命名規則 ai/task-ID で管理 |
| フィードバックの無限ループ | AIループ上限3回（next-task.jsで管理） |
| Codex API 誤判定による誤修正 | 却下推奨は必ず人間確認 |
| 大量の reviews/ ファイル | history/ フォルダで整理 |

---

## Phase4 以降の予定（現在未実装）

- PR マージ後の自動デプロイ通知
- Slack 連携
- 定期バッチ（夜間自動タスク）
- 複数 AI の並列実行
- タスクキュー（順番管理）
- Web ダッシュボード（タスク状況の可視化）

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-05-28 | Phase1: Discord Bot 基本構成 |
| 2026-05-28 | Phase2: GitHub Push / Codex依頼 / AIレビュー |
| 2026-05-28 | Phase3: Codexフィードバック / PR自動作成 / 履歴強化 |
