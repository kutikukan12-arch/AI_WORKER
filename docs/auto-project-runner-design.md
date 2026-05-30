# Auto Project Runner 設計書 (Phase 6)

> 作成日: 2026-05-31
> ステータス: DRAFT
> 目的: 人間が工程管理をしなくても AI 同士で開発を進めるシステム

---

## 1. 概要

現行（Phase1-5）は「人間が `!claude <指示>` を送るたびに AI が1タスク実行する」モデル。  
Auto Project Runner（APR）は「プロジェクト目標を1回だけ人間が宣言すれば、以降は AI が不足工程を判定して自律的に完走する」モデルに昇格させる。

```
[人間]
  !project <プロジェクト目標>
       ↓ 1回だけ
[APR]
  GoalAnalyzer → PhaseOrchestrator → TaskExecutor → CompletionValidator
                    ↑                                        |
                    └──── LoopGuard ────────────────────────┘
                                        ↓
                              DiscordReporter (スマホで確認)
```

---

## 2. システム構成図

```
Discord
  │
  │ !project <目標>      !apr status / !apr stop
  ▼
bot/index.js
  │
  ├─ bot/utils/goal-analyzer.js    ← NEW: 目標→不足工程判定
  │
  ├─ bot/utils/phase-orchestrator.js  ← NEW: 工程ループ制御
  │   │
  │   ├─ RESEARCH → bot/utils/claude-runner.js (既存)
  │   ├─ DOCS     → bot/utils/claude-runner.js (既存)
  │   ├─ IMPLEMENT→ bot/utils/claude-runner.js (既存)
  │   ├─ REVIEW   → bot/utils/codex.js + bot/utils/ai-review.js (既存)
  │   └─ FIX      → bot/utils/auto-fix-generator.js ← NEW
  │
  ├─ bot/utils/loop-guard.js       ← NEW: 無限ループ防止
  │
  ├─ bot/utils/completion-validator.js (既存)
  │
  └─ bot/utils/apr-reporter.js     ← NEW: Discord 4種レポート
       │
       ├─ 進捗レポート   (スマホ対応)
       ├─ エラーレポート (スマホ対応)
       ├─ レビューサマリー (スマホ対応)
       └─ 開発履歴       (スマホ対応)

永続化:
  data/projects/<projectId>/apr_state.json
  data/projects/<projectId>/phase_history.json
```

---

## 3. データ構造

### 3.1 AutoProject (apr_state.json)

```json
{
  "id": "apr_1748700000000",
  "projectId": "yt_predict",
  "goal": "YouTube動画投稿前診断AIのMVPをリリースする",
  "status": "RUNNING",
  "phases": [
    {
      "id": "phase_001",
      "type": "RESEARCH",
      "prompt": "既存のYouTube診断機能の現状を調査し、不足機能をリストアップしてください。",
      "status": "DONE",
      "taskId": "task_1748700001000",
      "attempts": 1,
      "maxAttempts": 3,
      "result": {
        "ok": true,
        "outputLength": 1240,
        "changedFiles": [],
        "reviewResult": null,
        "fixApplied": false
      },
      "createdAt": 1748700001000,
      "completedAt": 1748700300000
    }
  ],
  "currentPhaseIndex": 1,
  "loopGuard": {
    "phase_003": 2
  },
  "startedAt": 1748700000000,
  "completedAt": null,
  "timeoutAt": 1748707200000,
  "history": []
}
```

### 3.2 Phase 型定義

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | `phase_NNN` |
| `type` | PhaseType | RESEARCH / DOCS / IMPLEMENT / REVIEW / FIX |
| `prompt` | string | AI への指示文（自動生成） |
| `status` | PhaseStatus | PENDING / RUNNING / DONE / FAILED / SKIPPED |
| `taskId` | string \| null | 対応する TaskManager のタスクID |
| `attempts` | number | 試行回数（0始まり） |
| `maxAttempts` | number | 上限（デフォルト 3） |
| `result` | PhaseResult \| null | 完了時の結果 |
| `createdAt` | number | ms timestamp |
| `completedAt` | number \| null | ms timestamp |

### 3.3 PhaseResult

```json
{
  "ok": true,
  "output": "...",
  "outputLength": 1240,
  "changedFiles": ["bot/utils/foo.js"],
  "diffStat": "+42 -3",
  "reviewResult": {
    "issues": [],
    "severity": "LOW",
    "rawCodex": "..."
  },
  "fixApplied": false,
  "syntaxOk": true
}
```

### 3.4 PhaseType 定数

```
RESEARCH  → 既存機能・コードの調査（変更なしでOK）
DOCS      → 設計書・仕様書更新（変更なしでOK）
IMPLEMENT → コード実装（変更あり必須）
REVIEW    → Codex + AIReview によるコードレビュー
FIX       → レビュー結果を元にした自動修正
```

### 3.5 ProjectStatus 遷移

```
PLANNING  → 目標受付・工程生成中
RUNNING   → 工程ループ実行中
REVIEW    → 最終レビュー待ち
DONE      → 全工程完了
FAILED    → 回復不能エラー（LoopGuard発動 or タイムアウト）
STALLED   → 人間の確認待ち（LoopGuard上限到達）
```

---

## 4. 状態遷移図

```
           !project <目標>
                │
                ▼
          ┌─────────────┐
          │  PLANNING   │  GoalAnalyzer: 不足工程を判定
          └─────┬───────┘
                │ phases[] 生成完了
                ▼
          ┌─────────────┐
          │   RUNNING   │◄──────────────────────┐
          └─────┬───────┘                       │
                │                               │
    ┌───────────▼───────────┐                   │
    │   現在 Phase を実行    │                   │
    │  (RESEARCH/DOCS/      │                   │
    │   IMPLEMENT)          │                   │
    └───────────┬───────────┘                   │
                │                               │
          ┌─────▼──────┐   NG(attempts<max)     │
          │CompletionV.│──────────────────► retry(RUNNING)
          └─────┬──────┘                        │
                │ OK                            │
          ┌─────▼──────┐                        │
          │  REVIEW    │  Codex + AIReview       │
          └─────┬──────┘                        │
                │                               │
         ┌──────┴──────┐                        │
         │             │                        │
      passed         failed                     │
         │             │                        │
    ┌────▼────┐   ┌────▼────────┐               │
    │次Phaseへ│   │  FIX生成    │               │
    └────┬────┘   └────┬────────┘               │
         │             │                        │
    最後のPhase?       FIX実行完了               │
     Yes │ No          │ LoopGuard OK            │
         │  └──────────┘                        │
         │  次Phaseへ ──────────────────────────┘
         ▼
    ┌─────────────┐
    │    DONE     │  全工程完了 → Discord 完了レポート
    └─────────────┘

LoopGuard 発動時:
  attempts >= maxAttempts
        │
        ▼
  ┌───────────────┐    ┌─────────────┐
  │   STALLED     │ or │   FAILED    │
  │ (人間確認待ち) │    │ (タイムアウト)│
  └───────────────┘    └─────────────┘
        │
        ▼
  Discord エラーレポート + 操作方法を通知
```

---

## 5. 主要モジュール仕様

### 5.1 goal-analyzer.js (NEW)

**役割**: プロジェクト目標テキストから不足工程を判定し、Phase[] を生成する。

**フェーズ生成ルール**:

| 条件 | 生成するPhase |
|---|---|
| 目標に「調査」「現状確認」なし | RESEARCH を先頭に追加 |
| 目標に「仕様」「設計」なし + IMPLEMENT あり | DOCS を IMPLEMENT 前に追加 |
| 目標に実装系キーワードあり | IMPLEMENT を追加 |
| IMPLEMENT あり | REVIEW を末尾に追加 |
| 目標が MVP / リリース / 完了 | 全工程セット |

**プロンプト自動生成**:
```js
// 例: RESEARCH フェーズのプロンプト
`[RESEARCH] ${projectId} の現状を調査し、以下の目標達成に必要な不足機能・
実装済み機能の一覧をMarkdownで出力してください。
目標: ${goal}`
```

**エクスポート**:
```js
module.exports = {
  analyzeGoal(goal, projectId) → Phase[]
}
```

---

### 5.2 phase-orchestrator.js (NEW)

**役割**: Phase[] を順番に実行し、CompletionValidator と LoopGuard に連携する。

**主要ロジック**:
```
runNextPhase(aprState)
  1. currentPhaseIndex の Phase を取得
  2. status = RUNNING に更新
  3. claude-runner.js でタスク実行
  4. completion-validator.js で結果検証
  5a. OK → PhaseResult に保存 → reviewPhase()
  5b. NG → attempts++ → LoopGuard チェック → retry or STALLED
  6. reviewPhase() でレビュー実行
  7a. レビューOK → 次Phaseへ or DONE
  7b. レビューNG → auto-fix-generator.js でFIX生成 → FIX実行
```

---

### 5.3 auto-fix-generator.js (NEW)

**役割**: Codex レビュー結果（codex_review.md）を解析し、FIX タスクのプロンプトを自動生成する。

**入力**: `codex_review.md` の内容（既存の `bot/utils/codex-feedback.js` が生成）

**出力**: `[FIX] <具体的な修正指示>` プロンプト文字列

**生成ルール**:
```
1. レビュー結果から severity: HIGH / MEDIUM / LOW を抽出
2. HIGH がある → HIGH の issues のみを FIX 対象に絞る
3. HIGH がない → MEDIUM 全件を FIX 対象に
4. すべて LOW → SKIPPED（FIX なしで次フェーズへ）
5. FIX プロンプトに対象ファイル名・行番号・修正内容を含める
```

---

### 5.4 loop-guard.js (NEW)

**役割**: 同一 Phase の無限ループを検知し停止する。

**ルール**:

| チェック | 閾値 | アクション |
|---|---|---|
| Phase 試行回数 | 3回 | STALLED に遷移 + Discord通知 |
| REVIEW → FIX サイクル | 3サイクル | STALLED に遷移 + Discord通知 |
| プロジェクト全体タイムアウト | 2時間 | FAILED に遷移 + Discord通知 |
| 同一エラーメッセージ繰り返し | 2回 | FAILED に遷移 |

**エクスポート**:
```js
module.exports = {
  check(aprState, phaseId)  → { allowed: bool, reason: string }
  recordAttempt(aprState, phaseId)
  recordFixCycle(aprState, phaseId)
  isTimedOut(aprState)      → bool
}
```

---

### 5.5 apr-reporter.js (NEW)

**役割**: Discord に4種類のスマホフレンドリーなレポートを投稿する。

#### レポート A: 進捗レポート

```
📊 **プロジェクト進捗**
[====-------] 40%

🎯 目標: YouTube診断AIのMVPリリース
📍 現在: IMPLEMENT (3/7)
✅ RESEARCH → 完了
✅ DOCS     → 完了
⚙️ IMPLEMENT → 実行中
⏳ REVIEW   → 待機
⏳ FIX      → 待機

⏱️ 経過: 23分 | 推定残り: 35分
```

#### レポート B: エラーレポート

```
🔴 **エラー発生**
Phase: IMPLEMENT (試行2/3)
ファイル: bot/utils/goal-analyzer.js

原因: 変更ファイル0件 (会話応答を検出)
出力: 「詳細をください...」

対処方法:
• !apr retry → 再試行
• !apr skip  → このPhaseをスキップ
• !apr stop  → プロジェクト停止
```

#### レポート C: レビューサマリー

```
🧐 **Codexレビュー結果**
Phase: IMPLEMENT #3

📁 対象: bot/utils/goal-analyzer.js (+45/-2)

HIGH  🔴: 0件
MED   🟡: 1件
  • L32: エラーハンドリング不足
LOW   🟢: 2件

判定: FIX生成 → 自動修正へ
```

#### レポート D: 開発履歴

```
📜 **開発履歴**
yt_predict | 2026-05-31

09:00 🚀 プロジェクト開始
09:03 ✅ RESEARCH 完了 (出力1.2k文字)
09:15 ✅ DOCS 完了 (design.md更新)
09:20 ⚙️ IMPLEMENT 開始
09:35 🧐 REVIEW: MED×1検出
09:36 🔨 FIX 自動生成・実行中
```

---

## 6. コマンド一覧

| コマンド | 説明 |
|---|---|
| `!project <目標>` | Auto Project Runner 開始 |
| `!apr status` | 現在の進捗レポートを表示 |
| `!apr history` | 開発履歴を表示 |
| `!apr review` | 最新レビューサマリーを表示 |
| `!apr retry` | 現在の Phase を再試行 |
| `!apr skip` | 現在の Phase をスキップ（要オーナー権限） |
| `!apr stop` | プロジェクトを停止 |
| `!apr list` | 全プロジェクト一覧 |

---

## 7. 無限ループ防止設計

```
Phase試行回数カウンター
  ┌─────────────────────────────────┐
  │ 各Phase に attempts / maxAttempts │
  │ デフォルト: maxAttempts = 3       │
  └───────────────┬─────────────────┘
                  │ attempts >= maxAttempts
                  ▼
            STALLED 遷移
            + Discord通知（操作コマンド付き）

REVIEW→FIXサイクルカウンター
  ┌──────────────────────────────────────┐
  │ loopGuard[phaseId].fixCycles を記録  │
  │ 3サイクル超 → STALLED               │
  └──────────────────────────────────────┘

同一エラー重複検知
  ┌─────────────────────────────────────┐
  │ 直前2回の failure reason が同一     │
  │ → FAILED 遷移（改善見込みなし）     │
  └─────────────────────────────────────┘

グローバルタイムアウト
  ┌─────────────────────────────────────┐
  │ startedAt + 7200000ms (2時間)       │
  │ 超過 → FAILED 遷移                  │
  └─────────────────────────────────────┘
```

---

## 8. 実装フェーズ

### Phase 6 MVP（最初にリリース）

**対象ファイル（新規）**:
- `bot/utils/goal-analyzer.js`
- `bot/utils/phase-orchestrator.js`
- `bot/utils/auto-fix-generator.js`
- `bot/utils/loop-guard.js`
- `bot/utils/apr-reporter.js`

**既存ファイル改修**:
- `bot/index.js` — `!project` コマンドハンドラ追加

**MVP スコープ**:
- GoalAnalyzer: キーワードベース（静的ルール、LLM不使用）
- PhaseOrchestrator: 逐次実行（並列なし）
- LoopGuard: 試行回数のみ（同一エラー検知は Phase 7）
- DiscordReporter: 4種類すべて実装
- `!project` / `!apr status` / `!apr stop` の3コマンド

**Phase 6 完了判定**:
- `!project "XXXを実装する"` を送ると工程が自動生成される
- 各工程が順番に実行される
- 3回失敗でSTALLEDになりDiscordに通知される
- `!apr status` でスマホから進捗を確認できる

---

### Phase 7（MVP 検証後）

- GoalAnalyzer を LLM ベースに強化（Claude でギャップ分析）
- FIX サイクル同一エラー検知
- REVIEW→FIX サイクル上限カウンター
- `!apr retry` / `!apr skip` コマンド追加

---

### Phase 8（将来）

- 複数 Phase の並列実行（RESEARCH と DOCS を同時）
- プロジェクト完了後の自動デプロイ通知（GitHub Actions 連携）
- Web ダッシュボード（スマホ向け React 軽量版）

---

## 9. MVP 定義

**MVP = Phase 6 完成時に以下がすべて動作すること**

| # | 検証項目 | 合否基準 |
|---|---|---|
| 1 | `!project <目標>` でPhaseが自動生成される | 最低3工程が生成される |
| 2 | 各Phaseが順番に自動実行される | 人間の追加操作なし |
| 3 | 3回失敗でSTALLEDになる | Discord通知が届く |
| 4 | `!apr status` で進捗確認できる | スマホ1画面に収まる |
| 5 | Codexレビュー結果からFIXが自動生成される | FIXプロンプトに行番号・ファイル名が含まれる |
| 6 | タイムアウト（2時間）でFAILEDになる | Discord通知が届く |
| 7 | 開発履歴がスマホで確認できる | `!apr history` が1画面に収まる |

---

## 10. 既存システムとの統合ポイント

| 新モジュール | 利用する既存モジュール | 利用方法 |
|---|---|---|
| `phase-orchestrator.js` | `claude-runner.js` | Phase実行時にclaudeRunnerを呼び出す |
| `phase-orchestrator.js` | `completion-validator.js` | 実行後の完了検証 |
| `phase-orchestrator.js` | `codex.js` / `ai-review.js` | REVIEWフェーズで利用 |
| `auto-fix-generator.js` | `codex-feedback.js` | Codexレビュー結果の解析 |
| `phase-orchestrator.js` | `task-manager.js` | タスクID管理・履歴保存 |
| `phase-orchestrator.js` | `task-queue.js` | キューへの追加 |
| `apr-reporter.js` | `formatter.js` | Discordメッセージ整形 |
| `loop-guard.js` | `task-manager.js` | 状態の永続化 |

---

## 11. スマホ対応設計方針

すべての Discord 出力は以下のルールに従う：

1. **1メッセージ = 1画面**: iPhone SE (幅 320px) でスクロールなし
2. **絵文字ステータス**: テキストより視覚的に状態を把握しやすい
3. **コピペコマンド**: `!apr retry` など操作コマンドを常に末尾に記載
4. **最大行数 15行**: Discordスマホアプリでの表示限界を考慮
5. **長いテキストは省略**: 詳細は `!apr review` 等のコマンドで分割表示

---

## 12. ファイル追加後の構成

```
AI_WORKER/
├─ bot/
│   └─ utils/
│       ├─ goal-analyzer.js       ← NEW (Phase6)
│       ├─ phase-orchestrator.js  ← NEW (Phase6)
│       ├─ auto-fix-generator.js  ← NEW (Phase6)
│       ├─ loop-guard.js          ← NEW (Phase6)
│       ├─ apr-reporter.js        ← NEW (Phase6)
│       ├─ completion-validator.js (既存・改修なし)
│       ├─ codex-feedback.js      (既存・改修なし)
│       ├─ task-manager.js        (既存・改修なし)
│       ├─ task-queue.js          (既存・改修なし)
│       └─ ... (その他既存)
├─ data/
│   └─ projects/
│       └─ <projectId>/
│           ├─ apr_state.json     ← NEW: APR実行状態
│           └─ phase_history.json ← NEW: フェーズ実行履歴
└─ docs/
    └─ auto-project-runner-design.md ← このファイル
```
