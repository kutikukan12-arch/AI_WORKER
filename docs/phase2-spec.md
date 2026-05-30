# Phase2 仕様書 - GitHub連携・Codex連携・AIレビュー強化

## 概要

Phase1（Discord → Claude Code 基本連携）に以下の機能を追加。

---

## 追加された機能

### 1. GitHub 自動連携（`bot/utils/github.js`）

Claude Code 完了後に自動で以下を実行：

```
git status → 変更確認
  ↓
git add .  → 変更をステージング
  ↓
git commit → 自動生成メッセージでコミット
  ↓
git push   → GitHub へ送信（Token認証）
  ↓
Discord #github-log に結果通知
```

#### コミットメッセージの自動生成例

```
feat: [AI] Hello Worldを出力するPythonスクリプトを作って

AI_WORKER 自動コミット
タスクID : task_1748344800000
実行日時 : 2026/05/28 10:00:00

変更ファイル (2件):
  - [追加] workspace/task_xxx/hello.py
  - [追加] workspace/task_xxx/result.md

依頼内容:
Hello Worldを出力するPythonスクリプトを作ってください
```

#### 安全機能

- `.env` ファイルの誤コミット防止チェック
- 認証情報ファイルの誤コミット防止
- Push タイムアウト（30秒）
- GIT_TERMINAL_PROMPT=0（パスワードプロンプトによるハング防止）

---

### 2. Codex 連携（`bot/utils/codex.js`）

#### 自動判断

以下のキーワードを検出すると自動で Codex 依頼文を生成：

| キーワード例 | 判断 |
|------------|------|
| エラー、バグ、bug、error | Codex 依頼生成 |
| 最適化、リファクタ、軽量 | Codex 依頼生成 |
| セキュリティ、脆弱性 | Codex 依頼生成 |
| 非同期、async、高速化 | Codex 依頼生成 |

#### Codex 依頼文フォーマット

```
【対象ファイル】
・workspace/task_xxx/app.js

【問題・改善要求】
非同期処理を改善してください

【やってほしいこと】
・非同期処理を適切に改善してください
・コード全体をレビューして改善点を教えてください

【実行結果（参考）】
（Claude Code の出力結果）

【危険度】
低
```

#### 危険度判断ルール

| 危険度 | 条件 |
|--------|------|
| 高 | 削除・認証・パスワード・トークン・DBが含まれる |
| 中 | パッケージインストール・設定変更・15件超の変更 |
| 低 | 上記以外 |

---

### 3. AI レビュー強化（`bot/utils/ai-review.js`）

Claude Code の変更を自動チェックし、3段階で判定：

| 判定 | 条件 | 対応 |
|------|------|------|
| 🟢 問題なし | チェック全通過 | 実装続行 |
| 🟡 修正推奨 | 警告あり | Claude Codeへ差し戻し |
| 🔴 却下推奨 | 重大問題あり | 人間確認 |

#### チェック項目

| チェック | 閾値 | 判定 |
|---------|------|------|
| 変更ファイル数 | >25件 | 問題あり |
| 変更ファイル数 | >10件 | 警告 |
| 機密ファイル変更 | .env等 | 問題あり |
| 設定ファイル変更 | package.json等 | 警告 |
| 要件外パッケージ | webpack等 | 警告 |
| ファイル削除 | >3件 | 問題あり |

---

### 4. Discord 多チャンネル通知

| チャンネル | 環境変数 | 内容 |
|-----------|---------|------|
| #ai-review | `AI_REVIEW_CHANNEL_ID` | AIレビュー結果 |
| #github-log | `GITHUB_LOG_CHANNEL_ID` | GitHub操作ログ |
| #codex-review | `CODEX_REVIEW_CHANNEL_ID` | Codex依頼文 |

チャンネルIDが未設定の場合は全通知がコマンドチャンネルに届く。

---

### 5. 人間確認ルール（強化）

以下の場合、`@ユーザー名` でメンション：

| 条件 | 危険度 |
|------|--------|
| AIレビュー「却下推奨」 | 高 |
| GitHub Push 失敗 | 中 |
| Codex 危険度「高」 | 高 |
| 認証・DB系エラー | 高 |

---

## 処理フロー（Phase2完全版）

```
!claude コマンド受信
  │
  ├─ セキュリティチェック（security.js）
  │   ├─ 失敗 → エラーメッセージ + 終了
  │   └─ 成功 → 続行
  │
  ├─ STEP1: Claude Code 実行（claude-runner.js）
  │   └─ workspace/task_ID/ に作業
  │
  ├─ STEP2: AI レビュー（ai-review.js）
  │   ├─ 変更ファイル確認
  │   ├─ 自動チェック（5項目）
  │   ├─ 判定: 問題なし / 修正推奨 / 却下推奨
  │   ├─ reviews/review_task_ID.md に保存
  │   └─ #ai-review に通知
  │
  ├─ STEP3: GitHub 自動連携（github.js）※ENABLE_GITHUB=true時
  │   ├─ 却下推奨の場合はスキップ
  │   ├─ git add + commit（メッセージ自動生成）
  │   ├─ git push origin main
  │   └─ #github-log に結果通知
  │
  ├─ STEP4: Codex 依頼生成（codex.js）
  │   ├─ キーワード検出 or ENABLE_CODEX=true
  │   ├─ 依頼文自動生成
  │   ├─ reviews/codex_task_ID.md に保存
  │   ├─ OpenAI API 直接呼び出し（OPENAI_API_KEY設定時）
  │   └─ #codex-review に依頼文を送信
  │
  ├─ STEP5: 次タスク担当判断（next-task.js）
  │   └─ docs/next_task.md + history/ に保存
  │
  └─ STEP6: 完了通知（Discord メイン）
      ├─ 結果サマリ Embed
      └─ 次タスク依頼文 Embed
```

---

## ファイル構成（Phase2追加分）

```
AI_WORKER/
└─ bot/
    └─ utils/
        ├─ github.js     ← NEW: GitHub 自動連携
        ├─ codex.js      ← NEW: Codex 依頼生成
        └─ ai-review.js  ← NEW: AI レビュー
```

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| .env の誤 Push | 機密ファイル検出 + .gitignore で防止 |
| git push によるハング | タイムアウト30秒 + GIT_TERMINAL_PROMPT=0 |
| OpenAI API の課金 | OPENAI_API_KEY 未設定時はスキップ |
| 却下推奨の自動実行 | 却下推奨時はGitHub Push をスキップ |
| 無限 AI ループ | AIループ上限3回（次タスク判断で管理） |

---

## Phase3 以降の予定（現在未実装）

- Codex API 回答の自動取り込み → Claude Code への差し戻し
- GitHub PR 自動作成
- タスクキュー（複数タスクの順番管理）
- AI 会話ログの全文検索
- 定期実行（夜間バッチ処理）

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-05-28 | Phase1 初版 |
| 2026-05-28 | Phase2: GitHub・Codex・AIレビュー追加 |
