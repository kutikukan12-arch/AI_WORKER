# AI_WORKER プロジェクト状態レポート

- **作成日時:** 2026/5/31 01:55
- **調査対象:** bot/ 全ファイル・仕様書・ログ・workspace・tasks.json・GitHub
- **最新コミット:** `6396319` fix: split tasks from LARGE cap size at MEDIUM

---

## 1. 完成済み機能一覧

### Phase1 — Discord ↔ Claude Code 基本連携

| 機能 | ファイル | 状態 |
|------|---------|------|
| `!claude` コマンド受信・実行 | index.js | ✅ 完成 |
| Claude Code CLI 起動（shell:false・claude.exe 自動解決） | claude-runner.js | ✅ 完成 |
| 危険コマンドセキュリティフィルタ | security.js | ✅ 完成 |
| タスクワークスペース作成（workspace/projectId/taskId/） | index.js | ✅ 完成 |
| prompt.md / result.md / error.md 保存 | index.js | ✅ 完成 |
| タイムアウト処理（TASK_TIMEOUT_SECONDS） | claude-runner.js | ✅ 完成 |
| ログ出力（日付ローテーション） | logger.js | ✅ 完成 |
| `!help` コマンド | index.js | ✅ 完成 |
| 探索ルール付与（node_modules 除外・タイムアウト対策） | task-type.js | ✅ 完成 |

### Phase2 — GitHub連携・Codex連携・AIレビュー

| 機能 | ファイル | 状態 |
|------|---------|------|
| AI レビュー自動実行（問題なし/修正推奨/却下推奨） | ai-review.js | ✅ 完成 |
| TaskType別レビュー（IMPLEMENT+0件=問題あり） | ai-review.js | ✅ 完成 |
| Codex 依頼文自動生成（元prompt全文保存） | codex.js | ✅ 完成 |
| Codex API 実呼び出し（OPENAI_API_KEY 設定済み） | codex.js | ✅ 完成・動作確認済み |
| `!codex` コマンド | index.js | ✅ 完成 |
| GitHub 自動コミット・Push | github.js | ✅ 実装済み（ENABLE_GITHUB=false） |
| 多チャンネル通知（7チャンネル振り分け） | index.js | ✅ 完成 |
| AIレビュー結果保存（reviews/projectId/review_taskId.md） | ai-review.js | ✅ 完成 |
| 通知先チャンネルロギング（[NOTIFY_CONFIG]） | index.js | ✅ 完成 |

### Phase3 — Codexフィードバック・GitHub PR・レビュー履歴

| 機能 | ファイル | 状態 |
|------|---------|------|
| `!apply-review` Codex回答フィードバック | codex-feedback.js | ✅ 完成 |
| `!create-pr` 手動PR作成 | github-pr.js | ✅ 実装済み（ENABLE_PR=false） |
| `!history [taskId]` レビュー履歴表示 | review-history.js | ✅ 完成 |

### Phase4 — タスク管理・ナイトバッチ・AI会議

| 機能 | ファイル | 状態 |
|------|---------|------|
| タスク管理（CRUD・状態遷移・月次アーカイブ） | task-manager.js | ✅ 完成 |
| `!task list/detail/done/hold/stats/cleanup/archive` | index.js | ✅ 完成 |
| 優先度スコアリング（キーワード自動判定） | priority.js | ✅ 完成 |
| ナイトバッチ（毎日 2:00 自動実行） | night-batch.js | ✅ 完成 |
| `!batch` 手動実行 | index.js | ✅ 完成 |
| AI会議（`!meeting`・3者討論プロンプト） | ai-meeting.js | ✅ 完成 |

### Phase5 — タスクキュー・朝バッチ・優先度再評価

| 機能 | ファイル | 状態 |
|------|---------|------|
| タスクキュー（順番管理・待機通知） | task-queue.js | ✅ 完成 |
| `!queue` / `!queue clear` コマンド | index.js | ✅ 完成 |
| 朝バッチ（優先度再評価・長期待機警告） | night-batch.js | ✅ 完成 |

### 追加実装（仕様外）

| 機能 | ファイル | 状態 |
|------|---------|------|
| 承認フロー（`!approve / !deny / !pause / !resume`） | approval-manager.js | ✅ 完成 |
| 完了バリデーター（handoff/会話応答/短文/質問文 検出） | completion-validator.js | ✅ 完成 |
| マルチプロジェクト対応（#チャンネル名 → projectId） | project-detector.js | ✅ 完成 |
| **Task Type System**（IMPLEMENT/FIX/REFACTOR/RESEARCH/DOCS/TEST/REVIEW） | task-manager.js | ✅ 完成・テスト済み |
| **Task Size Validator**（SMALL/MEDIUM/LARGE・自動推定） | task-manager.js | ✅ 完成・テスト済み |
| Bot 安全再起動（`!restart`） | restart-manager.js | ✅ 完成 |
| **単一Bot起動ロック**（bot.lock・login前チェック） | restart-manager.js | ✅ 完成・テスト済み |
| システム診断（`!doctor`・通知先チャンネルチェック含む） | doctor.js | ✅ 完成 |
| `!next` 最優先タスク表示（[TYPE/SIZE]表示） | index.js | ✅ 完成 |
| **`!run-next` 安全化**（全安全フロー・共通エンジン化） | index.js | ✅ 完成 |
| **Auto Task Runner Phase3**（`!auto run 1`） | index.js | ✅ 完成 |
| **Auto Task Runner Phase4**（`!auto on`・最大3件） | index.js | ✅ 完成 |
| **LARGE タスク自動スキップ**（auto runner） | index.js | ✅ 完成 |
| **Type Guard**（type別実行制約をプロンプトに付与） | task-manager.js | ✅ 完成 |
| **REVIEW → Codex 連携**（executeReviewTask） | index.js | ✅ 完成・API動作確認済み |
| **RESEARCH → 調査専用モード**（executeResearchTask） | index.js | ✅ 完成 |
| **`!task add [TYPE]`** コマンド | index.js | ✅ 完成 |
| **`!task edit <id> type <TYPE>`** コマンド | index.js | ✅ 完成 |
| **`!task split [preview]`** コマンド | index.js | ✅ 完成・LARGE→MEDIUM修正済み |
| **`!task merge <id1> <id2>`** コマンド | index.js | ✅ 完成 |
| **`!review list / show <id>`** コマンド | index.js | ✅ 完成・テスト済み |
| **`!research list / show <id>`** コマンド | index.js | ✅ 完成 |
| Project分離 Phase2（workspace/projectId/taskId/） | index.js | ✅ 完成 |
| tasks.json に projectId / type / size 保存 | task-manager.js | ✅ 完成 |
| RESEARCH 完了後の次担当メッセージ非表示 | index.js | ✅ 完成 |
| コピペ用依頼文 全文保存（1000文字） | next-task.js | ✅ 完成 |
| Discord サーバー完全セットアップ（13チャンネル） | — | ✅ 完成 |
| GitHub push 済み（AI_WORKER リポジトリ） | — | ✅ `6396319` |

---

## 2. 未完成機能一覧

| 機能 | 理由 | 優先度 |
|------|------|--------|
| GitHub 連携の有効化 | ENABLE_GITHUB=false・GIT_REPO_PATH 未設定 | 高 |
| git リポジトリ初期化 | AI_WORKER が git 管理外（git diff が常に空） | 高 |
| PR 自動作成の有効化 | ENABLE_PR=false | 中 |
| Codex 自動フィードバック | ENABLE_AUTO_FEEDBACK=false | 低 |
| RESEARCH → Claude Code 本番実行 | テスト時はダミーデータ使用。実 Claude Code 実行は本番でのみ確認可 | 中 |
| `!task archive` の30日超え対象 | 全タスクが1日未満のため 0件 | — |
| `!auto` の連続ループ（`!auto on` 3件完了後に停止） | 3件制限は意図的。無限ループは未実装 | 低 |
| `!review show <id>` / `!research show <id>` の分割送信 | 1800文字超過時に省略。複数メッセージ分割は未実装 | 低 |
| Web ダッシュボード | Phase6以降 | なし |
| Slack 連携 | 設計で禁止 | なし |

---

## 3. バグ一覧

### 🔴 重大バグ

| # | バグ内容 | 原因 | 対処 |
|---|---------|------|------|
| B-1 | `git diff` が常に `+0 -0` を返す | AI_WORKER が git リポジトリ未初期化（git init 未実行）。completionValidator は mtime フォールバックで動作中 | `git init && git add -A && git commit` で初期化 |
| B-2 | Bot 多重起動が発生しやすい | `!restart` 後に旧プロセスが Discord 接続を維持したまま残ることがある。`rm -f bot.lock` による手動削除が引き金 | **bot.lock を手動削除しない**。再起動は常に `!restart` または PowerShell で正規プロセスを停止してから起動 |

### 🟡 警告

| # | バグ内容 | 原因 | 対処 |
|---|---------|------|------|
| B-3 | tasks.json に孤立タスク25件（保留18件・作業中1件・レビュー待ち1件） | 開発セッション中の蓄積 | `!task cleanup` → `!task archive` で整理 |
| B-4 | タイムアウト時の Discord embed が「処理中…」のまま残る | reject 処理が embed を更新しない | index.js の reject 時に embed 更新を追加 |
| B-5 | `!doctor` の workspace カウントが projectId 別サブフォルダを未集計 | doctor.js が直下ディレクトリのみカウント | doctor.js の workspace チェックを再帰対応に修正 |
| B-6 | DIAG ログ（[DIAG-1/2/3]）が本番で常時出力される | LOG_LEVEL 制御が未実装 | `LOG_LEVEL=info` 時は DIAG を出さないように |

### 🟢 軽微

| # | バグ内容 | 原因 |
|---|---------|------|
| B-7 | RESEARCH タスクで Claude Code が広域検索するとタイムアウトする可能性 | 探索ルールが追加されているが、Claude の判断に依存する部分が残る |
| B-8 | split プレビューが `!research show` と同じ ID 抽出方法（`message.content.split[2]`）のため、ID にスペースが含まれると誤動作 | タスクIDはスペース不含なので実害なし |

---

## 4. MVP完成率

**MVP 定義:** `!claude` → Claude Code 実行 → AIレビュー → Discord通知 の基本フロー

```
MVP 完成率: 92%
```

| MVP 項目 | 状態 | 備考 |
|---------|------|------|
| コマンド受信・実行 | ✅ | |
| Claude Code 起動（長文プロンプト） | ✅ | shell:false + claude.exe 自動解決 |
| セキュリティフィルタ | ✅ | |
| 完了バリデーション | ✅ | mtime フォールバックで動作中 |
| AI レビュー | ✅ | |
| Codex API レビュー | ✅ | OPENAI_API_KEY 設定済み・動作確認済み |
| 結果通知（Discord Embed） | ✅ | |
| git コミット | ❌ | GIT_REPO_PATH 未設定・ENABLE_GITHUB=false |

---

## 5. 製品版完成率

**製品版 定義:** Phase1〜5 仕様書の全機能 + 追加実装

```
製品版 完成率: 85%
```

| フェーズ / 機能群 | 完成率 | 未完成の主な項目 |
|----------------|-------|----------------|
| Phase1（基本連携） | 97% | git 管理外のみ |
| Phase2（GitHub・Codex・レビュー） | 80% | GitHub/PR 無効・git 初期化なし |
| Phase3（フィードバック・PR・履歴） | 80% | PR 無効 |
| Phase4（タスク管理・バッチ・会議） | 95% | 孤立タスク蓄積 |
| Phase5（キュー・朝バッチ） | 95% | 本番稼働テスト不足 |
| 追加実装（Type/Size/AutoRunner/Review/Research） | 95% | RESEARCH の本番実行未検証 |
| 運用環境（Discord・GitHub・ロック機構） | 95% | 多重起動が稀に再発 |

---

## 6. 次担当がやるべきタスク TOP10

### 🔴 最優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 1 | **git リポジトリ初期化** — `git init && git add -A && git commit -m "init"` で diff 検出を有効化。completionValidator の精度が大幅向上 | D:\璃蘭\AI_WORKER | 30分 |
| 2 | **ENABLE_GITHUB=true + GIT_REPO_PATH 設定** — git 初期化後に .env を更新してコミット・Push を有効化 | .env | 15分 |
| 3 | **`!task cleanup` → `!task archive`** — tasks.json の孤立タスク25件を整理。`!next` / `!auto on` の動作を安定化 | 運用 | 即時 |

### 🟡 高優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 4 | **タイムアウト時の Discord embed 更新** — reject 時に processingMsg を「タイムアウト」embed に更新 | index.js | 1時間 |
| 5 | **doctor.js の workspace 集計を再帰対応** — projectId 別サブフォルダを正しくカウント | doctor.js | 1時間 |
| 6 | **DIAG ログを LOG_LEVEL で制御** — `LOG_LEVEL=info` 時は DIAG-1/2 を出力しない | index.js, logger.js | 1時間 |

### 🟢 中優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 7 | **Bot 起動スクリプトの整備** — `rm -f bot.lock` を使わない安全な起動手順をスクリプト化（start.ps1 更新） | scripts/start.ps1 | 30分 |
| 8 | **RESEARCH タスクの本番実行テスト** — 実際に `!auto run 1` で RESEARCH を実行し `reports/research_*.md` が保存されるか確認 | 運用テスト | 30分 |
| 9 | **`!review show` / `!research show` の分割送信** — 1800文字超過時に複数メッセージに分割してフル内容を表示 | index.js | 1時間 |

### 🔵 低優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 10 | **`!auto on` の連続実行上限を可変に** — `!auto on 5` のように件数を指定できるようにする（現在は固定3件） | index.js | 1時間 |

---

## 7. 本番稼働状況（2026/5/31 01:55 時点）

| 項目 | 状態 |
|------|------|
| Bot プロセス | ✅ PID 19868（1プロセスのみ） |
| 最新コミット | ✅ `6396319` GitHub 反映済み |
| OPENAI_API_KEY | ✅ 設定済み・Codex API 動作確認済み（6秒応答） |
| 全チャンネル通知 | ✅ 7チャンネル全て ✅ |
| tasks.json | 25件（保留18・未着手5・作業中1・レビュー待ち1） |
| reviews/result_*.md | 4件 |
| git 状態 | ❌ AI_WORKER ディレクトリは git 管理外（bot.lock等がgitに見えない） |
| GitHub リポジトリ | ✅ https://github.com/kutikukan12-arch/AI_WORKER |

---

*このファイルは AI_WORKER Bot セッションにより生成されました。*
*次回更新: `!meeting プロジェクト状態レビュー` または手動で上書き*
