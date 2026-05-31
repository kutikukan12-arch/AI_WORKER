# AI_WORKER プロジェクト ステータスレポート

**作成日:** 2026-06-01  
**対象フェーズ:** Phase 1〜F-4  
**最新 commit:** `38b0ef3` fix: C-1 HUMAN_CHECK approval record + awaiting_human cleanup  
**コード規模:** bot/index.js 5000行超 / utils 27ファイル / テスト 8ファイル 192件 / 総 commit 54件以上

---

## 完成済み機能一覧

### Phase 1 — Discord Bot 基盤（100%）

| 機能 | コマンド |
|------|---------|
| Claude Code CLI 連携・タスク実行 | `!claude <指示>` |
| Codex（GPT-4o）レビュー手動実行 | `!codex <内容>` |
| セキュリティチェック（危険パターン検出・最大長制限） | 自動 |
| 許可チャンネル制限・ログ出力 | 自動 |

### Phase 2 — GitHub / Codex 連携（100%）

| 機能 | コマンド |
|------|---------|
| git commit/push 自動化 | 自動（タスク完了後）|
| OpenAI API レビュー・危険度判定（高/中/低）| 自動 |
| Secret Masking（GitHub PAT・Bearer token）| 自動 |

### Phase 3 — PR・フィードバック（100%）

| 機能 | コマンド |
|------|---------|
| Codex フィードバック適用・FIX 自動生成 | `!apply-review <ID>` |
| PR 自動生成（フィーチャーブランチ作成）| `!create-pr <ID>` |
| レビュー履歴管理・表示 | `!history [ID]` |
| 調査レポート・Codex レビュー結果表示 | `!research` / `!review` |

### Phase 4 — タスク管理・バッチ（100%）

| 機能 | コマンド |
|------|---------|
| タスク CRUD（作成・参照・完了・保留・再開）| `!task add/list/done/hold/resume` |
| タスク優先度ソート・分割・統合・アーカイブ | `!task split/merge/archive/cleanup` |
| ナイトバッチ / 朝バッチ | 毎日 02:00 / 08:00 / `!batch` |
| AI 会議（Claude/Codex/ChatGPT 3者討論）| `!meeting [full] <議題>` |

### Phase 5 — キュー・承認・再起動（100%）

| 機能 | コマンド |
|------|---------|
| タスクキュー（同時実行数制御）| `!queue` / `!queue clear` |
| 高危険度タスク承認フロー | `!approve` / `!deny` / `!pause` / `!resume` |
| Bot 安全再起動（構文・Token チェック）| `!restart [confirm]` |
| システム診断 | `!doctor` |

### Phase D — Auto Project Runner / LLM Planner（100%）

| 機能 | コマンド |
|------|---------|
| プロジェクト管理（作成・切替・一覧）| `!project create/switch/list/current` |
| Auto Runner ON/OFF/reset / loopCount 上限 | `!project runner on/off/reset/status` |
| LLM ベース planProjectGoalsBest | 自動（!project run 内）|
| autoApplyPlanning（DOCS/RESEARCH/TEST のみ安全登録）| `!project runner auto-apply on/off` |
| runPlannerStepAsync（FIX・REVIEW 自動生成）| 自動（タスク完了後フック）|

### Phase E — 自律化基盤（100%）

| 機能 | コマンド |
|------|---------|
| Auto Policy（BLOCKED/HUMAN_APPROVAL/AI_REVIEW/AUTO_SAFE）| 自動 |
| Worker Registry（役割別タスク取得）| `!worker add/list/rm/status` |
| Task Lease（ソフトロック 30分・期限切れ自動解放）| 自動 |
| Timeout Auto Split（タイムアウトタスクを3分割・再分割防止）| 自動 |
| Company Staffing（推奨人員・適用）| `!company staff/assign [--preview]` |
| Quality Gate（GREEN/YELLOW/RED 判定）| `!quality status/gate/report` |
| getResumeCandidates（自動再開候補フィルタ）| 自動 |

### Phase F — 自律ループ・品質・HUMAN_CHECK（100%）

| 機能 | コマンド |
|------|---------|
| RunContext（per-run 実行状態管理）| 内部 |
| `!project run` — 完全自律実行ループ（_runProjectLoop）| `!project run <id>` |
| `!project stop` — 安全停止（awaiting_human 中でも対応）| `!project stop <id>` |
| PRE-RUN QA → MID-RUN Gate（3タスクごと）→ POST-RUN QA | 自動 |
| soft RED auto-FIX（レビュー失敗 → FIX タスク自動生成 優先度:高）| 自動 |
| HUMAN_CHECK（AUTH/PERMISSION/AWAITING/soft_red_unresolved）| 自動通知 |
| `!approve <taskId>` → ループ再開 / `!deny <taskId>` → 安全停止 | `!approve` / `!deny` |
| activeRuns リークなし（awaiting_human 中 stop で _teardown 呼出）| 自動 |

---

## テスト状況サマリー

| テストファイル | 結果 | テスト数 | カバー内容 |
|--------------|------|----------|----------|
| `project_run_f0_test.js` | ✅ 92/92 | 92 | RunContext・!project run/stop・HUMAN_CHECK・approve/deny・MID-RUN Gate・soft RED |
| `quality_gate_test.js` | ✅ 57/57 | 57 | Quality Gate 判定・MID-RUN Gate・_isValidationFailureNote |
| `auto_policy_test.js` | ✅ 43/43 | 43 | BLOCKED/HUMAN_APPROVAL/AI_REVIEW/AUTO_SAFE 分類 |
| `d4e_auto_apply_test.js` | ✅ 23/23 | 23 | autoApplyPlanning ON/OFF・安全条件全6項目 |
| `b7b_integration_test.js` | ✅ 13/13 | 13 | FIX 自動生成・重複防止・runner OFF |
| `full_flow_integration_test.js` | ✅ 12/12 | 12 | IMPLEMENT→REVIEW→Codex→完了 |
| `final_stability_test.js` | ✅ 29/29 | 29 | Step 2〜4 全安全条件確認 |
| `company_manager_test.js` | ✅ 参照 | — | Staffing 推奨・適用 |

**自動実行可能テスト合計: 192件 / 全通過 ✅**

---

## 未完成機能・技術的負債

| 項目 | 優先度 | 内容 |
|------|--------|------|
| `!project runner max <回数>` コマンド | 🟡 中 | loopCount 上限を Discord から変更できない（projects.json 直接編集必要）|
| workspace ルーティング完成 | 🟡 中 | Claude Code が常に AI_WORKER ルートで実行（プロジェクト別ディレクトリ未分離）|
| IMPLEMENT→REVIEW→FIX 完全連鎖 E2E テスト | 🟡 中 | 各フェーズ単体は通過済み。全連鎖フルパス未テスト |
| `full_flow_integration_test.js` git チェック堅牢化 | 🟡 中 | 新ファイル追加で `6c. git status clean` が失敗する |
| `plannerCallCount` フィールド整理 | 🟢 低 | defaultState に残るが未使用（loopCount で代替）|
| Web 管理ダッシュボード | 🟢 低 | タスク一覧・Runner 状態をブラウザで確認する UI |
| 複数プロジェクト並列実行 | 🟢 低 | 現在は逐次処理 |
| 24 時間連続実行テスト | 🟢 低 | 長時間稼働での安定性未確認 |

---

## バグ履歴（解決済み）

### Phase F-4 で修正（2026-06-01）

| バグ | 影響 |
|------|------|
| C-1: `_handleHumanCheck` が `approvalManager.createApproval` を呼んでいなかった | `!approve`/`!deny` が HUMAN_CHECK タスクに反応しなかった |
| H-1: `!project stop` 中の `activeRuns` リーク（awaiting_human 状態）| stop しても activeRuns が残りメモリリーク |

### Phase F-2/F-3 で修正（2026-05-31）

| バグ | 影響 |
|------|------|
| MID-RUN Gate が `tasksDone` 変化なしで重複発火 | 失敗タスクがあると `lastMidRunTasksDone` ガードなしで連続発火 |
| 正常 REVIEWING が `consecutiveErrors` を誤加算 | validator 失敗でないのにエラーカウント増加 |
| FIX タスクの優先度が `高` にならない | `dangerLevel='高'` では priority フィールドが更新されなかった |
| REVIEW/RESEARCH ブランチが MID-RUN Gate をスキップ | `continue` より前にチェックがなかった |

### Phase E で修正

| バグ | 影響 |
|------|------|
| `autoAppliedTask` スコープバグ | D-4e テストが即クラッシュ |
| `formatRunnerStatus` が `plannerCallCount`（常に 0）を表示 | `!project runner status` のコール数が常に `0/10` と誤表示 |
| RESEARCH 重複生成 | `doneTasks` が planProjectGoalsBest に渡されていなかった |
| child task が再 split される | rootTaskId ガードなし |
| GitHub remote URL が変わる | GITHUB_REPO 環境変数誤設定 |
| BOM in completion-validator.js | `require()` が SyntaxError でクラッシュ |

---

## システム構成図

```
Discord
  ↓ discord.js v14
bot/index.js（コマンドルーター）
  ├── claude-runner.js       → Claude Code CLI (spawn --dangerously-skip-permissions)
  ├── codex.js               → OpenAI API (GPT-4o, retry 3回)
  ├── github.js              → git commit/push
  ├── github-pr.js           → PR 作成 (GitHub API)
  ├── task-manager.js        → data/tasks.json (CRUD + Lease)
  ├── task-queue.js          → 同時実行数制御
  ├── approval-manager.js    → data/approvals.json (承認フロー)
  ├── auto-project-runner.js → data/runner-state.json
  ├── project-planner.js     → LLM 計画生成 (planProjectGoalsBest)
  ├── quality-gate.js        → RED/YELLOW/GREEN 判定
  ├── auto-policy.js         → タスク安全分類
  ├── worker-registry.js     → data/workers.json
  ├── project-manager.js     → data/projects.json
  ├── company-manager.js     → 人員推奨・適用
  └── night-batch.js         → 定期バッチ

状態管理: JSON ファイルベース（DB 不使用）
依存パッケージ: discord.js, dotenv（最小構成）
Node.js: ≥ 18.0.0
```

---

## MVP 完成率

```
██████████████████████████  100%
```

**MVP 定義:** Discord から Claude Code を呼び出し、タスクを実行・レビュー・品質判定・GitHub push する半自律 AI 開発 Bot

---

## 製品版完成率

```
████████████████████░░░░░░  78%
```

**製品版定義:** プロジェクト目標を Discord で与えると、RESEARCH→DOCS→IMPLEMENT→REVIEW→FIX の全工程を自律的に完走し、完成物を GitHub に push する完全 AI 開発チーム

| 領域 | 完成率 | 不足内容 |
|------|--------|---------|
| 基本実行基盤 | 100% | — |
| Auto Runner（FIX/REVIEW）| 100% | — |
| !project run 自律ループ | 100% | — |
| HUMAN_CHECK / approve / deny | 100% | — |
| Quality Gate（PRE/MID/POST）| 100% | — |
| soft RED auto-FIX | 100% | — |
| Project Planner（LLM）| 70% | workspace ルーティング未分離 |
| 完全自律ループ（IMPLEMENT連鎖）| 60% | E2E テスト未実施 |
| 安定性・長期運用 | 50% | 24h テスト未実施 |
| 運用管理 UI | 10% | Web ダッシュボード未実装 |

---

*このドキュメントは 2026-06-01 の commit `38b0ef3` 時点を基に作成されました。*
