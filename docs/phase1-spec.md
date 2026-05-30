# Phase1 仕様書 - Discord ↔ Claude Code 連携Bot

## 概要

Discord のメッセージを受け取り、Windows PC 上で Claude Code を起動する Bot システム。

---

## システム構成

```
スマホ
  ↓ メッセージ送信
Discord（特定チャンネル）
  ↓ !claude コマンド検知
AI_WORKER Bot（Node.js）
  ↓ セキュリティチェック後に起動
Claude Code CLI（Windows）
  ↓ workspace/タスクID/ で作業
完了通知
  ↓
Discord に結果送信
  ↓
次担当AI判断 → next_task.md 保存
```

---

## ファイル構成

```
AI_WORKER/
├─ bot/
│   ├─ index.js              メインBot（Discord接続・コマンド処理）
│   └─ utils/
│       ├─ logger.js         ログ管理（logs/日付.log へ保存）
│       ├─ security.js       セキュリティチェック（危険コマンド遮断）
│       ├─ claude-runner.js  Claude Code CLI 実行エンジン
│       └─ next-task.js      次タスク担当AI判断・docs保存
├─ workspace/                Claude Code の作業領域
│   └─ task_*/               タスクごとのフォルダ
│       ├─ prompt.md         元の指示
│       ├─ result.md         実行結果
│       └─ error.md          エラー（発生時のみ）
├─ logs/                     実行ログ（YYYY-MM-DD.log）
├─ prompts/                  プロンプトテンプレート（将来用）
├─ docs/
│   ├─ phase1-spec.md        この仕様書
│   ├─ setup-guide.md        セットアップガイド
│   ├─ next_task.md          直近の次タスク情報（自動更新）
│   └─ history/              タスクごとの完了記録
├─ reviews/                  AIレビュー記録（将来用）
├─ temp/                     一時ファイル
├─ scripts/
│   └─ start.ps1             Windows 起動スクリプト
├─ package.json
├─ .env.example              環境変数テンプレート
└─ .gitignore
```

---

## コマンド仕様

| コマンド | 書式 | 説明 |
|---------|------|------|
| `!claude` | `!claude <指示>` | Claude Code に作業を依頼 |

### 使用例

```
!claude Hello Worldを出力するPythonスクリプトを作ってください
!claude READMEを日本語で書いてください
!claude package.jsonに必要な依存パッケージを追加してください
```

---

## セキュリティ設計

### 入力フィルタ（security.js）

以下のパターンを含む指示はブロックされる：

- `rm -rf` / `rmdir /s` などのファイル削除コマンド
- `shutdown` / `restart` などのシステム操作
- `taskkill` / `kill` などのプロセス強制終了
- レジストリ操作 (`reg delete` 等)
- ディレクトリトラバーサル (`../../` 等)
- ドライブ直接指定 (`C:\` 等)

### ワークスペース制限

- Claude Code はタスクごとの `workspace/task_*/` フォルダ内でのみ動作
- 作業ディレクトリを専用フォルダに設定することで自然な範囲制限

### タイムアウト

- デフォルト: 300秒（5分）
- `TASK_TIMEOUT_SECONDS` 環境変数で変更可能

---

## 次タスク判断ルール

### Codex に回す条件（スコア制）

キーワード例: エラー、バグ、最適化、リファクタ、軽量化、セキュリティ

### ChatGPT に回す条件

キーワード例: 仕様、設計、相談、優先順位、運用、UI/UX

### Claude Code に回す条件

上記いずれにも該当しない場合（次フェーズ実装）

---

## エラー処理

| エラー種別 | 対応 |
|-----------|------|
| Claude Code 未インストール | エラーメッセージ + インストール方法案内 |
| タイムアウト | タスク強制終了 + Discord通知 |
| セキュリティブロック | 実行せず理由をDiscord通知 |
| Discord接続エラー | ログ保存 + 自動再接続 |
| 予期しないエラー | ログ保存 + Discord通知 + 人間メンション |

---

## Phase2 以降の予定機能（現在未実装）

- Codex 連携（API経由）
- GitHub 自動コミット・PR作成
- タスクキュー（複数タスクの順番管理）
- 複数AI並列実行
- タスク履歴の検索機能
- Webhook による外部通知

これらは `docs/` の提案として記録のみ行う。実装はPhase2以降。

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-05-28 | Phase1 初版作成 |
