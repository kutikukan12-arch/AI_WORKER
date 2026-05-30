# AI_WORKER プロジェクト状態レポート

- **作成日時:** 2026/5/30 04:10
- **調査対象:** bot/ 全ファイル・仕様書(Phase1〜5)・ログ・workspace・tasks.json・.env

---

## 1. 完成済み機能一覧

### Phase1 — Discord ↔ Claude Code 基本連携

| 機能 | ファイル | 状態 |
|------|---------|------|
| `!claude` コマンド受信・実行 | index.js | ✅ 完成 |
| Claude Code CLI 起動（shell:false・claude.exe自動解決） | claude-runner.js | ✅ 完成 |
| 危険コマンドセキュリティフィルタ | security.js | ✅ 完成 |
| タスクワークスペース作成（workspace/projectId/taskId/） | index.js | ✅ 完成 |
| prompt.md / result.md / error.md 保存 | index.js | ✅ 完成 |
| タイムアウト処理（TASK_TIMEOUT_SECONDS） | claude-runner.js | ✅ 完成 |
| ログ出力（日付ローテーション） | logger.js | ✅ 完成 |
| `!help` コマンド | index.js | ✅ 完成 |

### Phase2 — GitHub連携・Codex連携・AIレビュー

| 機能 | ファイル | 状態 |
|------|---------|------|
| AI レビュー自動実行（問題なし/修正推奨/却下推奨） | ai-review.js | ✅ 完成 |
| TaskType別レビュー（IMPLEMENT+0件=問題あり） | ai-review.js | ✅ 完成 |
| Codex 依頼文自動生成（元prompt全文保存） | codex.js | ✅ 完成 |
| `!codex` コマンド（依頼文表示・API連携） | index.js | ✅ 完成 |
| GitHub 自動コミット・Push | github.js | ✅ 実装済み（ENABLE_GITHUB=false） |
| 多チャンネル通知（#ai-review / #github-log / #codex-review） | index.js | ✅ 完成 |
| AIレビュー結果保存（reviews/projectId/review_taskId.md） | ai-review.js | ✅ 完成 |

### Phase3 — Codexフィードバック・GitHub PR・レビュー履歴

| 機能 | ファイル | 状態 |
|------|---------|------|
| `!apply-review` Codex回答フィードバック | codex-feedback.js | ✅ 実装済み |
| `!create-pr` 手動PR作成 | github-pr.js | ✅ 実装済み（ENABLE_PR=false） |
| `!history [taskId]` レビュー履歴表示 | review-history.js | ✅ 完成 |

### Phase4 — タスク管理・ナイトバッチ・AI会議

| 機能 | ファイル | 状態 |
|------|---------|------|
| タスク管理（CRUD・状態遷移・月次アーカイブ） | task-manager.js | ✅ 完成 |
| `!task list/detail/done/hold/stats/cleanup` コマンド | index.js | ✅ 完成 |
| 優先度スコアリング（キーワード自動判定） | priority.js | ✅ 完成 |
| ナイトバッチ（毎日自動・ログ整理・タスク確認） | night-batch.js | ✅ 完成 |
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
| TaskType 判定（[RESEARCH]/[DESIGN]/[REVIEW]/IMPLEMENT） | task-type.js | ✅ 完成 |
| Bot 安全再起動（`!restart`） | restart-manager.js | ✅ 完成 |
| システム診断（`!doctor`） | doctor.js | ✅ 完成 |
| `!next` 最優先タスク表示（未着手のみ） | index.js | ✅ 完成 |
| `!run-next` 安全実行（全安全フロー通過・共通エンジン化） | index.js | ✅ 完成 |
| 次タスク判断（TaskType別・IMPLEMENT→ChatGPT除外） | next-task.js | ✅ 完成 |
| RESEARCH完了後の次担当メッセージ非表示 | index.js | ✅ 完成 |
| コピペ用依頼文 全文保存（1000文字・改行保持） | next-task.js | ✅ 完成 |
| reviews/ に元prompt全文を保存 | codex.js | ✅ 完成 |
| `!task cleanup`（孤立タスクを保留へ一括整理） | task-manager.js | ✅ 完成 |
| Project分離 Phase2（workspace/projectId/taskId/ 分離） | index.js, task-manager.js | ✅ 完成 |
| tasks.json に projectId 保存 | task-manager.js | ✅ 完成 |
| Discord サーバー自動セットアップスクリプト | setup-discord.js 他 | ✅ 完成 |
| 受信ログ DIAG-1/2/3（デバッグ用） | index.js | ✅ 完成 |

---

## 2. 未完成機能一覧

| 機能 | 理由 | 優先度 |
|------|------|--------|
| GitHub 連携の有効化 | ENABLE_GITHUB=false・GIT_REPO_PATH 未設定 | 高 |
| git リポジトリ初期化 | AI_WORKER が git 管理外（fatal: not a git repository）| 高 |
| Codex API 直接呼び出し | OPENAI_API_KEY 未設定（依頼文生成のみ動作） | 中 |
| PR 自動作成の有効化 | ENABLE_PR=false | 中 |
| Codex 自動フィードバック | ENABLE_AUTO_FEEDBACK=false | 低 |
| Auto Task Runner（`!run-next` 連続ループ・`!auto`） | 未着手（Phase6相当） | 低 |
| reviews/ の自動アーカイブ | ファイルが蓄積し続ける仕組みがない | 低 |
| workspace/ 旧形式ディレクトリの整理 | 33件の task_xxx/ が直下に散在 | 低 |
| Web ダッシュボード | Phase6以降の予定 | なし |
| Slack 連携 | 設計で禁止 | なし |

---

## 3. バグ一覧

### 🔴 重大バグ

| # | バグ内容 | 原因 | 対処 |
|---|---------|------|------|
| B-1 | `git diff` が常に `+0 -0` を返す | AI_WORKER が git リポジトリ未初期化。completionValidator の変更検出が mtime フォールバックのみ動作 | `git init && git add -A && git commit` で初期化 |
| B-2 | tasks.json の既存19件に `projectId` が存在しない | Phase2実装前に作成されたタスク。旧タスクは `!run-next` で `default` にフォールバック | `!task cleanup` で保留化後、タスクを再登録 |

### 🟡 警告

| # | バグ内容 | 原因 | 対処 |
|---|---------|------|------|
| B-3 | タイムアウト時の Discord embed が「処理中…」のまま残る | reject 処理が embed を更新しない | index.js の reject 時に embed 更新を追加 |
| B-4 | `!doctor` の workspace カウントがサブフォルダを正しく集計しない | workspace 直下のみカウント・projectId 別サブフォルダが対象外 | doctor.js の集計処理を再帰対応に修正 |
| B-5 | reviews/ 直下に projectId なしの旧 codex_*.md が蓄積 | Phase2以前の副産物。reviews/projectId/ に整理されていない | 手動または整理スクリプトで reviews/default/ へ移動 |
| B-6 | workspace/ 直下に task_xxx/ 形式の旧ディレクトリが33件 | Phase2以前に誤配置されたもの（ファイルあり） | 手動でアーカイブまたは削除 |

### 🟢 軽微

| # | バグ内容 | 原因 |
|---|---------|------|
| B-7 | RESEARCH タスクで変更0件でも validator OK になる条件が甘い | 200文字以上の出力なら OK。調査内容の質・構造は判定していない |
| B-8 | DIAG ログが常時出力される | デバッグ用ログが本番でも動いている。`LOG_LEVEL=debug` 制御が未実装 |

---

## 4. MVP完成率

**MVP 定義:** `!claude` → Claude Code 実行 → AIレビュー → Discord通知 の基本フロー

```
MVP 完成率: 90%
```

| MVP 項目 | 状態 | 備考 |
|---------|------|------|
| コマンド受信・実行 | ✅ | |
| Claude Code 起動（長文プロンプト） | ✅ | shell:false + claude.exe 自動解決済み |
| セキュリティフィルタ | ✅ | |
| 完了バリデーション | ✅ | mtime フォールバックで動作中 |
| AI レビュー | ✅ | |
| 結果通知（Discord Embed） | ✅ | |
| git コミット | ❌ | git 未初期化・ENABLE_GITHUB=false |
| Codex API 連携 | ❌ | OPENAI_API_KEY 未設定 |

---

## 5. 製品版完成率

**製品版 定義:** Phase1〜5 仕様書の全機能 + 追加実装

```
製品版 完成率: 80%
```

| フェーズ | 完成率 | 未完成の主な項目 |
|---------|-------|----------------|
| Phase1（基本連携） | 95% | git 管理外のみ |
| Phase2（GitHub・Codex・レビュー） | 70% | GitHub/Codex 無効・Codex API 未設定 |
| Phase3（フィードバック・PR・履歴） | 75% | PR/自動フィードバック 無効 |
| Phase4（タスク管理・バッチ・会議） | 95% | 本番稼働テスト未完 |
| Phase5（キュー・朝バッチ） | 95% | 本番稼働テスト未完 |
| 追加実装（仕様外） | 95% | DIAG ログ制御未実装 |

---

## 6. 次担当がやるべきタスク TOP10

優先度順。いずれも実際のコード変更 or 設定変更。

### 🔴 最優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 1 | **git リポジトリ初期化** — `git init && git add -A && git commit -m "init"` で diff 検出を有効化。completionValidator のバリデーション精度が大幅向上 | D:\璃蘭\AI_WORKER | 30分 |
| 2 | **ENABLE_GITHUB=true + GIT_REPO_PATH 設定** — git 初期化後に .env を更新してコミット・Push を有効化 | .env | 15分 |
| 3 | **tasks.json の孤立タスクをクリーンアップ** — `!task cleanup` で作業中4件・レビュー待ち12件を保留化 | 運用 | 即時 |

### 🟡 高優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 4 | **タイムアウト時の Discord embed 更新** — reject 時に processingMsg を「タイムアウト」embed に更新する | index.js | 1時間 |
| 5 | **doctor.js の workspace 集計修正** — projectId 別サブフォルダを再帰カウントし正確な件数を表示 | doctor.js | 1時間 |
| 6 | **OPENAI_API_KEY 設定 + ENABLE_CODEX=true** — Codex API 直接呼び出しを有効化（現在は依頼文生成のみ） | .env | 15分 |

### 🟢 中優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 7 | **reviews/ 旧ファイルの整理** — reviews/ 直下に散らばった codex_*.md / review_*.md を reviews/default/ へ移動 | 手動 or スクリプト | 30分 |
| 8 | **workspace/ 旧形式ディレクトリの整理** — task_xxx/ 直下の33件を archive/ へ移動またはアーカイブ | 手動 or スクリプト | 30分 |
| 9 | **DIAG ログを LOG_LEVEL で制御** — 現在は常時 debug 出力。`LOG_LEVEL=info` 時は DIAG-1/2 を出さないように | index.js, logger.js | 1時間 |

### 🔵 低優先

| # | タスク | 対象 | 工数 |
|---|--------|------|------|
| 10 | **Auto Task Runner Phase2 — `!auto` または `!run-next` ループ実装** — 未着手タスクを順番に自動実行するループコマンド | index.js | 3時間 |

---

## 7. 本番稼働状況（2026/5/30 04:10 時点）

| 項目 | 状態 |
|------|------|
| Bot プロセス | ✅ 稼働中 |
| 全主要ファイル | ✅ node --check 通過 |
| tasks.json | 19件（全て旧タスク・projectId なし） |
| workspace 分離 | ✅ ai_chat / ai_worker / approval / default |
| git 状態 | ❌ 未初期化 |
| Discord サーバー | ✅ 全チャンネル設定・初期文面投稿済み |
| Project分離 Phase2 | ✅ 実装・テスト完了 |
| RESEARCH 次担当スキップ | ✅ 実装完了 |

---

*このファイルは AI_WORKER Bot セッションにより生成されました。*
*次回更新: `!meeting プロジェクト状態レビュー` または手動で上書き*
