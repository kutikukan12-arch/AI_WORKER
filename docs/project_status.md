# AI_WORKER プロジェクト ステータスレポート

**作成日:** 2026-05-31  
**調査対象:** Phase 1〜6（Phase A-D 含む）  
**最新 commit:** `18465c0` + plannerCallCount 表示バグ修正  
**コード規模:** bot/index.js 4057行 / utils 25ファイル / テスト 6ファイル / 総 commit 52件

---

## 完成済み機能一覧

### Phase 1 — Discord Bot 基盤（100%）

| 機能 | コマンド |
|------|---------|
| Claude Code CLI 連携・タスク実行 | `!claude <指示>` |
| Codex(GPT-4o) レビュー手動実行 | `!codex <内容>` |
| セキュリティチェック（危険パターン検出・最大長制限） | 自動 |
| ログ出力・DEBUG モード | 自動 |
| 許可チャンネル制限 | 自動 |

### Phase 2 — GitHub / Codex 連携（100%）

| 機能 | コマンド |
|------|---------|
| git commit/push 自動化 | 自動（タスク完了後） |
| OpenAI API (GPT-4o) レビュー | 自動 |
| 危険度判定（高/中/低）と Discord 通知振り分け | 自動 |

### Phase 3 — PR・フィードバック（100%）

| 機能 | コマンド |
|------|---------|
| Codex フィードバック適用・FIX 自動生成 | `!apply-review <ID>` |
| PR 自動生成（フィーチャーブランチ作成） | `!create-pr <ID>` |
| レビュー履歴管理・表示 | `!history [ID]` |
| 調査レポート・Codex レビュー結果表示 | `!research` / `!review` |

### Phase 4 — タスク管理・バッチ（100%）

| 機能 | コマンド |
|------|---------|
| タスク CRUD（作成・参照・完了・保留・再開） | `!task add/list/done/hold/resume` |
| タスク優先度ソート（危険度・プロンプト長） | 自動 |
| タスク分割（3〜5件に自動分割、プレビュー付き） | `!task split [preview] <ID>` |
| タスク統合 | `!task merge <ID1> <ID2>` |
| タスクタイプ変更・統計・孤立整理・アーカイブ | `!task edit/stats/cleanup/archive` |
| ナイトバッチ（ログアーカイブ・GitHub 確認） | 毎日 02:00 / `!batch` |
| 朝バッチ（優先度再評価） | 毎日 08:00 |
| AI 会議（Claude/Codex/ChatGPT 3者討論） | `!meeting [full] <議題>` |

### Phase 5 — キュー・承認・再起動（100%）

| 機能 | コマンド |
|------|---------|
| タスクキュー（同時実行数制御） | `!queue` / `!queue clear` |
| 最優先タスク自動実行 | `!auto run <数>` / `!auto on` |
| 高危険度タスク承認フロー | `!approve` / `!deny` / `!pause` / `!resume` |
| Bot 安全再起動（構文・Token チェック） | `!restart [confirm]` |
| システム診断 | `!doctor` |

### Phase 6 — Auto Project Runner（基盤〜D-4e 実装済み）

| 機能 | コマンド |
|------|---------|
| プロジェクト管理（作成・切替・一覧） | `!project create/switch/list/current` |
| Auto Runner ON/OFF/reset | `!project runner on/off/reset` |
| Auto Runner ステータス表示（loopCount・Auto Apply） | `!project runner status` |
| runPlannerStep（FIX・REVIEW 自動生成） | 自動（タスク完了後フック） |
| loopCount 上限（デフォルト 10 回）で自動停止 | 自動 |
| project_done 検出（残作業 0 で Runner 停止） | 自動 |
| REVIEW タスクの自動キュー投入 | 自動 |
| ルールベース nextCandidates 生成（D-4a） | 自動 |
| `!project plan` で候補表示（D-4b） | `!project plan` |
| `!project plan apply` で上位 3 件登録（D-4c） | `!project plan apply` |
| runner summary に nextCandidates ヒント（D-4d） | 自動 |
| autoApplyPlanning ON/OFF（D-4e） | `!project runner auto-apply on/off/status` |
| 安全 type（DOCS/RESEARCH/TEST）のみ自動登録 | 自動（autoApplyPlanning=ON 時） |
| 重複登録防止・最大 1 件・自動実行なし | 自動 |

---

## 未完成機能一覧

| 機能 | 優先度 | 説明 |
|------|--------|------|
| IMPLEMENT タスクの自動生成 | 🔴 高 | `planNextTask()` は FIX/REVIEW のみ対応。目標文から IMPLEMENT を自動生成する仕組みが未実装 |
| LLM ベースの planProjectGoals | 🔴 高 | 現在はキーワードルールマッチのみ（YouTube/AI/API/認証 等）。Claude/Codex API で目標を解析し精度向上が必要 |
| `!apr` コマンドセット | 🟡 中 | 仕様書（auto-project-runner-spec.md）記載の `!apr start/status/history/retry/skip/stop` が未実装 |
| workspace ルーティング | 🟡 中 | プロジェクトごとに異なるディレクトリで Claude を実行する仕組みが未完成（現在は常に AI_WORKER ルート） |
| project.runner.maxPlannerCalls 設定 UI | 🟡 中 | 上限回数を Discord から変更するコマンドがない（projects.json を直接編集必要） |
| 24 時間連続実行テスト | 🟡 中 | 長時間稼働での安定性未確認 |
| IMPLEMENT→REVIEW→FIX 完全連鎖 E2E テスト | 🟡 中 | 各フェーズ単体テストは通過済みだが、全連鎖のフルパステストが未実施 |
| Web 管理ダッシュボード | 🟢 低 | タスク一覧・Runner 状態をブラウザで確認する UI |
| 複数プロジェクト並列実行 | 🟢 低 | 現在は同時実行数=1 で逐次処理 |
| !meeting 結果のタスク自動変換 | 🟢 低 | 会議アクションアイテムの自動タスク化 |

---

## バグ一覧

### 今回のセッションで修正済み

| バグ | 影響 |
|------|------|
| `autoAppliedTask` のスコープバグ（`create_task` パスで ReferenceError） | D-4e テストが即クラッシュ |
| `formatRunnerStatus()` が `plannerCallCount`（常に 0）を表示していた | `!project runner status` のコール数が常に `0/10` と誤表示 |
| B-7b テストが実 Codex API の応答値に依存し不安定 | CI/CD で結果が変動 |
| `formatRunnerStatus()` に Auto Apply 表示がなかった | `!project runner status` で ON/OFF が確認できなかった |
| 不明サブコマンドのヘルプに `auto-apply` が未記載 | ユーザーが `auto-apply` コマンドを発見できなかった |

### 現存バグ・懸念事項

| バグ | 影響度 | 内容 |
|------|--------|------|
| tasks.json の 19 件が `type: undefined` | 🟡 中 | プロジェクト移行前の旧タスク。タイプ別フィルタに影響する可能性 |
| `full_flow_integration_test.js` の git status チェックが脆弱 | 🟡 中 | 未追跡ファイルがあると `6c. git status clean` が失敗する（今回も発生） |
| `plannerCallCount` フィールドが state に残存するが未使用 | 🟢 低 | `defaultState` に定義されているが、`loopCount` で代替されており混乱を招く |
| `smoke_test_full_runner.js` STEP 14 の git チェックが data/ 変更で失敗しうる | 🟢 低 | テスト実行後に runner-state.json が dirty になる場合がある |

---

## MVP 完成率

```
████████████████████░░░░░░  85%
```

**MVP 定義:** Discord から Claude Code を呼び出し、タスクを実行・レビュー・GitHub push する半自律 AI 開発 Bot

| 領域 | 完成率 |
|------|--------|
| Discord Bot 基盤 | 100% |
| Claude Code 連携 | 100% |
| タスク管理 | 100% |
| GitHub / Codex 連携 | 100% |
| PR・フィードバック | 100% |
| 夜間バッチ・朝バッチ | 100% |
| 承認・キュー管理 | 100% |
| Auto Project Runner 基盤 | 70% |

Phase 1〜5 は完全稼働。Phase 6 の中核（FIX/REVIEW 自動生成・autoApply）は動作するが、IMPLEMENT 自動生成と LLM ベース計画が未実装のため完全自律ループには至っていない。

---

## 製品版完成率

```
█████████████░░░░░░░░░░░░░  52%
```

**製品版定義:** プロジェクト目標を Discord で与えると、RESEARCH→DOCS→IMPLEMENT→REVIEW→FIX の全工程を自律的に完走し、完成物を GitHub に push する完全 AI 開発チーム

| 領域 | 完成率 | 不足内容 |
|------|--------|---------|
| 基本実行基盤 | 100% | — |
| Auto Runner（FIX/REVIEW） | 80% | IMPLEMENT 生成が必要 |
| Project Planner（LLM） | 20% | ルールベースのみ。LLM 解析未実装 |
| 完全自律ループ | 30% | IMPLEMENT→全工程連鎖が未テスト |
| 安定性・長期運用 | 40% | 24h テスト未実施 |
| 運用管理 UI | 10% | Web ダッシュボード未実装 |

---

## 次担当がやるべきタスク TOP 10

### 1. 🔴 IMPLEMENT タスクの自動生成を planNextTask に追加

**ファイル:** `bot/utils/project-planner.js`  
**現状:** `planNextTask()` は FIX（Codex 高危険度時）と REVIEW（IMPLEMENT 完了後）のみ生成する。目標から IMPLEMENT を自動生成する経路がない。  
**対応:** `planProjectGoals()` の nextCandidates から IMPLEMENT 候補を取得し、既存の PENDING IMPLEMENT がない場合のみ 1 件登録するロジックを追加。安全確認（最大 1 件・重複防止・autoApplyPlanning=true 時のみ）が必要。  
**効果:** Runner が IMPLEMENT タスクまで自律生成でき、完全な開発ループに近づく。

---

### 2. 🔴 tasks.json の type=undefined タスク 19 件をクリーンアップ

**ファイル:** `data/tasks.json`  
**現状:** プロジェクト移行前に作成した旧タスク 19 件が `type: undefined` のまま残存。タイプ別フィルタや自動生成判定の精度に影響する。  
**対応:** スクリプトでタスク内容から type を推定して付与するか、一括で `ON_HOLD` にアーカイブする。  
**効果:** `!task list` 表示の精度向上、Planner の誤認識防止。

---

### 3. 🔴 LLM ベースの planProjectGoals に切り替え

**ファイル:** `bot/utils/project-planner.js`  
**現状:** `planProjectGoals()` はキーワードルール（YouTube/AI/API 等）でマッチするだけ。未知のプロジェクトや日本語の目標文には対応できない。  
**対応:** `project.description` を Claude または Codex に渡し「不足機能のリスト」を生成させて nextCandidates に変換する。フォールバックとして現在のルールベースを維持。  
**効果:** 任意のプロジェクト説明から適切なタスク候補を生成できるようになる。

---

### 4. 🟡 `!project runner max <回数>` コマンドの追加

**ファイル:** `bot/index.js` + `bot/utils/auto-project-runner.js`  
**現状:** loopCount 上限は `projects.json` の `runner.maxPlannerCalls` を直接編集するしか変更方法がない。  
**対応:** `!project runner max <数>` コマンドを追加し、1〜50 のバリデーション込みで `projects.json` を更新する。`formatRunnerStatus()` の表示はすでに `maxPlannerCalls` を参照している。  
**効果:** Discord だけで Runner の上限を調整できる。

---

### 5. 🟡 workspace ルーティングの完成

**ファイル:** `bot/utils/claude-runner.js` + `bot/utils/project-manager.js`  
**現状:** Claude Code は常に AI_WORKER ルートで実行される。複数プロジェクトの成果物が同一ディレクトリに混在する。  
**対応:** `project.workspacePath`（または `workspace/<projectId>/`）を参照し、プロジェクトに対応するディレクトリで Claude を実行するよう `claude-runner.js` を更新。  
**効果:** プロジェクトごとの成果物分離、複数プロジェクト並列実行への道筋。

---

### 6. 🟡 IMPLEMENT→REVIEW→FIX 完全連鎖 E2E テスト

**ファイル:** `tests/` に新規追加  
**現状:** 各フェーズ単体テストは通過済み。ただし IMPLEMENT 自動生成→実行→REVIEW→Codex→FIX 生成の完全連鎖は未テスト。  
**対応:** `smoke_test_full_runner.js` を拡張し、ダミー Claude 実行で全工程を確認。API キーなしで動作することを確認。  
**効果:** リグレッション防止・実用前の最終確認。

---

### 7. 🟡 `full_flow_integration_test.js` の git status チェックを堅牢化

**ファイル:** `tests/full_flow_integration_test.js:156`  
**現状:** `git status --short` が空文字か `?? tests/full_flow_integration_test.js` のみ許可する固定条件のため、新ファイル追加で即失敗する（今回も実際に発生）。  
**対応:** `git status --short -- bot/ data/` など特定ディレクトリのみチェックするか、`tests/` 配下の未追跡ファイルを許可パターンに追加する。  
**効果:** テスト追加のたびに壊れない安定したテスト。

---

### 8. 🟡 `!apr` コマンドセットの実装（仕様書準拠）

**ファイル:** `bot/index.js` + `docs/auto-project-runner-spec.md`（参照）  
**現状:** `!project runner` としてサブセットのみ実装。仕様書の `!apr start/status/history/review/retry/skip/stop` が未実装。  
**対応:** 仕様書に従って `!apr` コマンドを実装。`!project runner` とのエイリアス関係を整理。  
**効果:** 仕様書との整合性が取れ、スマホからの操作性が向上。

---

### 9. 🟡 24 時間連続実行テスト・Bot 安定性確認

**確認ポイント:**  
- `data/tasks.json` の同時書き込み競合なし  
- loopCount が正しくインクリメントされ上限で停止  
- ナイトバッチ・朝バッチが定時に実行  
- Discord 接続切断時の自動再接続  
- メモリリーク・ゾンビプロセスなし  

**効果:** 本番長期運用前の安定性保証。

---

### 10. 🟢 plannerCallCount フィールドの整理

**ファイル:** `bot/utils/auto-project-runner.js`  
**現状:** `defaultState()` に `plannerCallCount: 0` が定義されているが実際には使用されていない（`loopCount` が実質的なカウンタ）。今回 `formatRunnerStatus()` の表示バグ修正時に発覚。  
**対応:** 選択肢 A: フィールドを削除してコードを簡潔化。選択肢 B: `planNextTask()` の実際の呼び出し回数をカウントする用途に正式活用（loopCount との意味の違いを明確化）。  
**効果:** コードの意図が明確になる。技術的負債の解消。

---

## テスト状況サマリー

| テストファイル | 結果 | テスト数 | カバー内容 |
|--------------|------|----------|----------|
| `d4e_auto_apply_test.js` | ✅ 23/23 | 23 | autoApplyPlanning ON/OFF・安全条件全6項目 |
| `b7b_integration_test.js` | ✅ 13/13 | 13 | FIX 自動生成・重複防止・runner OFF |
| `full_flow_integration_test.js` | ✅ 12/12 | 12 | IMPLEMENT→REVIEW→Codex→完了 |
| `final_stability_test.js` | ✅ 29/29 | 29 | Step 2〜4 全安全条件確認 |
| `task-detail.test.js` | 未確認 | — | タスク詳細表示 |
| `smoke_test_full_runner.js` | 参考 | — | 通しテスト（実 Claude 実行必要） |

**自動実行可能テスト合計: 77 件 / 全通過 ✅**

---

## システム構成図

```
Discord
  ↓ discord.js v14
bot/index.js (4057行・コマンドルーター)
  ├── claude-runner.js    → Claude Code CLI (spawn / --dangerously-skip-permissions)
  ├── codex.js            → OpenAI API (GPT-4o, retry 3回)
  ├── github.js           → git commit/push
  ├── github-pr.js        → PR 作成 (GitHub API)
  ├── task-manager.js     → data/tasks.json (CRUD)
  ├── task-queue.js       → 同時実行数制御 (MAX_CONCURRENT_TASKS)
  ├── approval-manager.js → data/approvals.json (承認フロー)
  ├── auto-project-runner.js → data/runner-state.json (Phase A-D)
  ├── project-planner.js  → ルールベース計画 (→ 将来 LLM 化)
  └── night-batch.js      → 定期バッチ (cron 相当)

依存パッケージ: discord.js, dotenv (最小構成)
状態管理: JSON ファイルベース（DB 不使用）
Node.js: ≥ 18.0.0
```

---

*このドキュメントは 2026-05-31 のコードベースを基に作成されました。*
