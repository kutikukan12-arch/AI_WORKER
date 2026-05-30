# Auto Project Runner 実装仕様書

- **作成日:** 2026/5/31
- **対象:** AI_WORKER Phase6 — Auto Project Runner
- **目的:** 人間はDiscordで結果を見るだけでプロジェクトが前進する自律実行システム

---

## 1. 技術スタック

| 項目 | 採用技術 | 理由 |
|------|---------|------|
| 言語 | Node.js (既存) | 変更なし |
| Discord | discord.js v14 (既存) | 変更なし |
| AI実行エンジン | Claude Code CLI (既存) | 変更なし |
| レビューエンジン | Codex API / OpenAI gpt-4o (既存) | 変更なし |
| データ永続化 | JSON ファイル (既存) | 新スキーマ追加のみ |
| スケジューラ | node-cron / setInterval (既存) | 既存バッチ基盤を流用 |
| 状態管理 | data/projects.json 拡張 | runner設定を追加 |

---

## 2. 既存機能流用箇所

```
executeClaudeTask()      ← タスク実行エンジン（そのまま流用）
executeReviewTask()      ← REVIEW→Codex転送（そのまま流用）
executeResearchTask()    ← RESEARCH→調査モード（そのまま流用）
prepareNextTask()        ← 次タスク取得・安全チェック（そのまま流用）
enqueueAndWait()         ← キュー待機（そのまま流用）
createFixTaskFromReview()← Codex結果→FIX生成（そのまま流用）
taskManager.createTask() ← タスク生成（そのまま流用）
projectManager           ← プロジェクト管理（そのまま流用）
sendNotification()       ← チャンネル通知（そのまま流用）
nightBatch.runBatch()    ← バッチスケジューラ基盤（流用）
```

---

## 3. 新規ファイル構成

```
bot/
├── utils/
│   ├── auto-project-runner.js   ← ★ 新規: Auto Runner エンジン本体
│   └── project-planner.js       ← ★ 新規: 自動タスク生成 Planner
data/
├── runner-state.json            ← ★ 新規: 実行状態・ループカウント
├── projects.json                ← 既存（runnerSettings フィールド追加）
docs/
├── auto-project-runner-spec.md  ← 本仕様書
```

---

## 4. Project Planner 設計

### 4-1. 役割

プロジェクトの「次にやるべきタスク」を自動で決定し、タスクを生成する。

### 4-2. Planner の入力

```javascript
{
  project: { id, name, goal, currentPhase },
  tasks:   [ ...existingTasks ],         // 現在のタスク一覧
  history: [ ...completedTasks ],         // 完了済みタスク履歴
  reviews: [ ...codexReviewResults ],     // Codexレビュー結果
}
```

### 4-3. Planner の出力

```javascript
{
  action: 'create_task' | 'no_action' | 'project_done',
  task: {
    type:     'IMPLEMENT' | 'DOCS' | 'TEST' | 'REVIEW' | 'RESEARCH' | 'FIX',
    priority: '高' | '中' | '低',
    prompt:   string,          // Claude Code への指示全文
    size:     'SMALL' | 'MEDIUM' | 'LARGE',
    reason:   string,          // なぜこのタスクが必要か
  } | null,
  stopReason: string | null,  // no_action / project_done の理由
}
```

### 4-4. タスク生成優先ルール

```
1位: FIX（Codexが高/中危険度を検出） → !apply-review と同様
2位: TEST（IMPLEMENTが完了したが TESTタスクがない）
3位: IMPLEMENT（設計書に基づく未着手機能）
4位: DOCS（実装完了後のドキュメント化）
5位: RESEARCH（不確かな技術判断が必要）
6位: REVIEW（重要なIMPLEMENT完了後）
```

---

## 5. 自動タスク生成アルゴリズム

### 5-1. プランナー呼び出しタイミング

```
[タスク完了]
     ↓
completionValidator → OK
     ↓
AIレビュー → 問題なし / 修正推奨 / 却下推奨
     ↓
createFixTaskFromReview()  ← 既存
     ↓
runPlannerStep()           ← ★ 新規: 次タスクを計画
     ↓
次タスクが未着手ゼロ && Planner が次タスクを生成
     ↓
タスクキューに追加
```

### 5-2. `runPlannerStep()` の実装

```javascript
// bot/utils/auto-project-runner.js

async function runPlannerStep(projectId, message) {
  const project  = projectManager.getProject(projectId);
  if (!project?.runner?.enabled) return;           // runner off なら skip

  const tasks    = taskManager.listTasks();
  const myTasks  = projectManager.filterTasksByProject(tasks, projectId);
  const pending  = myTasks.filter(t => t.state === STATES.PENDING);

  // ① 未着手タスクが残っていれば Planner 不要
  if (pending.length > 0) return;

  // ② ループカウント確認（無限ループ防止）
  const state = loadRunnerState();
  const count = state.plannerCallCount?.[projectId] || 0;
  const MAX   = project.runner.maxPlannerCalls ?? 10;
  if (count >= MAX) {
    await notifyRunnerStop(message, projectId, `Planner上限(${MAX}回)到達`);
    setRunnerEnabled(projectId, false);
    return;
  }

  // ③ Planner 呼び出し
  const plan = await planNextTask(project, myTasks);
  if (plan.action === 'project_done') {
    await notifyRunnerStop(message, projectId, '全タスク完了');
    setRunnerEnabled(projectId, false);
    return;
  }
  if (plan.action === 'no_action') {
    await notifyRunnerPause(message, projectId, plan.stopReason);
    return;
  }

  // ④ 新タスクを登録
  incrementPlannerCallCount(projectId);
  const newTask = taskManager.createTask(
    plan.task.prompt,
    'auto-runner',
    null,
    plan.task.priority === '高' ? '高' : '低',
    projectId,
    plan.task.type
  );

  await sendNotification('history', message.channel,
    `📋 **[Planner]** 新タスク生成: \`${newTask.id}\`\n` +
    `[${newTask.type}/${newTask.size}] ${plan.task.reason}`
  );
}
```

### 5-3. `planNextTask()` の実装

```javascript
// bot/utils/project-planner.js

async function planNextTask(project, tasks) {
  const completed = tasks.filter(t => /* アーカイブ済み = 完了 */ false);
  // ← 実際には data/history/ から取得

  // FIX タスクが必要か？（最新レビューが 高/中）
  const latestReview = getLatestReview(project.id);
  if (latestReview && (latestReview.danger === '高' || latestReview.danger === '中')) {
    return {
      action: 'create_task',
      task: {
        type:     'FIX',
        priority: latestReview.danger === '高' ? '高' : '中',
        prompt:   buildFixPrompt(latestReview),
        size:     'SMALL',
        reason:   `Codexレビュー(${latestReview.danger})への対応`,
      },
    };
  }

  // project.goal と完了済みタスクから次を推論
  const nextAction = inferNextAction(project.goal, tasks);
  return nextAction;
}

function buildFixPrompt(review) {
  return [
    `[FIX] Codexレビュー結果への対応`,
    ``,
    `問題点: ${review.problem}`,
    `改善案: ${review.suggestion}`,
    ``,
    `最小限の修正のみ行うこと。関係ない変更は禁止。`,
  ].join('\n');
}
```

---

## 6. 自動レビュー連鎖

### 6-1. レビュー連鎖フロー

```
IMPLEMENT完了
     ↓
[自動] REVIEW タスクを生成
     ↓
executeReviewTask() → Codex API
     ↓
results/result_<id>.md に保存
     ↓
危険度が 高/中
     ↓
[自動] FIX タスクを生成（createFixTaskFromReview）
     ↓
[自動] FIX 実行
     ↓
[自動] REVIEW タスクを再生成（apply-review 連鎖）
     ↓
危険度が 低 → Planner へ
```

### 6-2. ループ防止（レビュー連鎖）

```javascript
// reviews/apply-counts.json で追跡
// 同一 reviewId への apply-review は最大 MAX_AUTO_APPLY = 2回
// 超過した場合: 人間通知 + runner pause
```

---

## 7. Discord スマホ UI

### 7-1. コマンド体系

```
!project runner on        → Auto Runner を有効化（自動実行開始）
!project runner off       → Auto Runner を停止
!project runner status    → 現在の実行状態を確認
!project runner reset     → カウンタをリセット
```

### 7-2. 実行中の通知形式（スマホ向け短文）

```
▶ [Auto Runner] task_xxx
[FIX/SMALL] 🐛🟢
エラーハンドリング改善
```

```
✅ [Auto Runner] 完了
[FIX/SMALL] 1件 → OK
次: Planner実行中...
```

```
📋 [Planner] 新タスク生成
[REVIEW/SMALL] 実装内容の品質確認
⏳ 自動実行を続行します
```

```
⏸️ [Auto Runner] 一時停止
理由: 人間確認待ち
!approve task_xxx で続行
```

```
🏁 [Auto Runner] 完了
プロジェクト: youtube予測ai
実行タスク: 12件
成功: 11件 / 失敗: 1件
所要時間: 2時間18分
```

### 7-3. 通知先チャンネル

| 通知種別 | チャンネル |
|---------|---------|
| タスク開始・完了 | `#ai-worker`（コマンドチャンネル） |
| Codexレビュー | `#codex-review` |
| エラー・人間確認 | `#承認-確認` / `#error-alert` |
| 全体サマリー | `#ai-worker` |

---

## 8. Project Status 画面

### 8-1. `!project runner status` の表示

```
📊 Auto Runner Status
──────────────────────────────
Project: youtube予測ai
Runner:  ✅ 有効

実行中タスク: task_xxx [FIX/SMALL]
Plannerコール: 3/10回

最近の完了:
  ✅ task_aaa [IMPLEMENT/MEDIUM] 2h前
  ✅ task_bbb [REVIEW/SMALL] 1h前
  🔴 task_ccc [FIX/SMALL] 失敗 45m前

次の行動:
  未着手タスク: 2件
  ⬜ task_ddd [DOCS/MEDIUM]
  ⬜ task_eee [TEST/SMALL]
```

### 8-2. `!project status` への統合

```javascript
// 既存 !project コマンドに runner サブ情報を追記
```

---

## 9. エラー通知形式

### 9-1. completionValidator 失敗

```
⚠️ [Auto Runner] バリデーション失敗
task: task_xxx [DOCS/MEDIUM]
理由: 短文応答（45文字）
対処: 自動リトライ（1/2回目）
```

### 9-2. タイムアウト

```
⏰ [Auto Runner] タイムアウト
task: task_xxx
経過: 5分00秒
対処: 保留に移動。Plannerが代替タスクを生成します。
```

### 9-3. 人間確認が必要

```
🔴 [Auto Runner] 一時停止
理由: 高危険度タスクを検出
task: task_xxx

!approve task_xxx → 承認して続行
!deny task_xxx    → 却下してスキップ
!project runner off → Runner停止

Runner は承認待ちで停止中です。
```

### 9-4. ループ上限到達

```
🛑 [Auto Runner] 停止
理由: Plannerコール上限（10回）到達

このプロジェクトは手動確認が必要です。
!project runner reset で上限をリセット後
!project runner on で再開できます。
```

---

## 10. 完了判定ロジック

### 10-1. タスクレベル完了判定

```
既存 completionValidator を使用（変更なし）

IMPLEMENT → ファイル変更あり必須
DOCS      → 出力200文字以上
RESEARCH  → 出力200文字以上
REVIEW    → Codex API転送完了
FIX       → ファイル変更あり必須
TEST      → ファイル変更あり必須
REFACTOR  → ファイル変更あり必須
```

### 10-2. プロジェクトレベル完了判定

```javascript
function isProjectDone(project, tasks, plannerCallCount) {
  const pending   = tasks.filter(t => t.state === STATES.PENDING);
  const active    = tasks.filter(t => t.state === STATES.IN_PROGRESS);
  const reviewing = tasks.filter(t => t.state === STATES.REVIEWING);

  // 全タスクが消化されており、Plannerが「追加なし」と判断
  if (pending.length === 0 && active.length === 0 && reviewing.length === 0) {
    const plan = planNextTask(project, tasks);
    return plan.action === 'project_done' || plan.action === 'no_action';
  }
  return false;
}
```

### 10-3. Project完了の判断基準（Plannerが使用）

```
・project.goal に定義された全機能が IMPLEMENT 済みか
・全 IMPLEMENT に対して REVIEW が完了しているか
・高/中危険度の FIX が残っていないか
・DOCS が主要機能分作成されているか
```

---

## 11. 無限ループ防止

### 11-1. ループ防止機構一覧

| 機構 | 上限 | 設定場所 |
|------|------|---------|
| Plannerコール回数 | 10回/プロジェクト | `runner.maxPlannerCalls` |
| apply-review自動修正 | 2回/reviewId | `data/apply-counts.json`（既存） |
| FIXタスク自動生成 | 3回/originalTaskId | `data/fix-counts.json`（新規） |
| タスク連鎖深度 | 5階層 | `task.parentTaskId` のチェーン |
| Runner 実行時間 | 24時間 | `runner.startedAt` から計算 |

### 11-2. `data/runner-state.json` 構造

```json
{
  "youtube予測ai": {
    "plannerCallCount": 3,
    "lastPlannerAt": "2026-05-31T04:00:00Z",
    "totalTasksCreated": 8,
    "startedAt": "2026-05-31T02:00:00Z",
    "pausedAt": null,
    "pauseReason": null
  }
}
```

### 11-3. FIX ループ防止

```javascript
// data/fix-counts.json
{
  "task_originalId": 2   // この元タスクから生成した FIX 回数
}

// MAX_FIX_PER_ORIGINAL = 3
// 超過した場合: FIX 生成を停止して人間通知
```

---

## 12. DB (JSON) 構造

### 12-1. `data/projects.json` — runnerSettings フィールド追加

```json
{
  "projects": [
    {
      "id": "youtube予測ai",
      "name": "YouTube予測AI",
      "description": "YouTube動画の再生数を予測するAI開発",
      "goal": "MVP: 動画URLを入力すると72時間後の再生数を予測して表示する",
      "currentPhase": "実装",
      "createdAt": "2026-05-31T00:00:00Z",
      "runner": {
        "enabled": false,
        "maxPlannerCalls": 10,
        "notifyChannelId": "1509545187846652034",
        "startedAt": null,
        "pausedAt": null,
        "pauseReason": null
      }
    }
  ]
}
```

### 12-2. `data/runner-state.json` — 新規

```json
{
  "<projectId>": {
    "plannerCallCount": 0,
    "lastPlannerAt": null,
    "totalTasksCreated": 0,
    "startedAt": null
  }
}
```

### 12-3. `data/fix-counts.json` — 新規（FIXループ防止）

```json
{
  "<originalTaskId>": 1
}
```

### 12-4. タスクスキーマ — `parentTaskId` フィールド追加

```json
{
  "id": "task_xxx",
  "type": "FIX",
  "projectId": "youtube予測ai",
  "parentTaskId": "task_yyy",    ← ★ 新規: 連鎖元タスクID
  "chainDepth": 2,                ← ★ 新規: 連鎖の深さ（ループ防止）
  "prompt": "...",
  "state": "未着手"
}
```

---

## 13. 実装順序

### Phase A: 基盤整備（1〜2日）

```
Step A1: project.runner フィールドを projects.json に追加
Step A2: data/runner-state.json の読み書き関数
Step A3: data/fix-counts.json の読み書き関数
Step A4: task に parentTaskId / chainDepth フィールドを追加
Step A5: !project runner on/off/status コマンドの骨格
```

### Phase B: 自動実行エンジン（2〜3日）

```
Step B1: auto-project-runner.js の runPlannerStep() 実装
Step B2: runnerStep をタスク完了フック（executeClaudeTask 末尾）に接続
Step B3: ループカウンタ管理
Step B4: Runner 停止条件の実装（上限・完了・エラー）
Step B5: スマホ向け通知フォーマット
```

### Phase C: Project Planner（2〜3日）

```
Step C1: project-planner.js の骨格（inferNextAction の空実装）
Step C2: FIX タスク生成ロジック（Codexレビュー結果から）
Step C3: REVIEW 自動生成ロジック（IMPLEMENT完了後）
Step C4: project.goal を解析して次アクションを推論
Step C5: project_done 判定ロジック
```

### Phase D: 統合テスト（1〜2日）

```
Step D1: 単体: !project runner on → 1タスク自動実行
Step D2: 連鎖: IMPLEMENT → 自動 REVIEW → 自動 FIX
Step D3: ループ防止確認（上限到達でstop）
Step D4: 24時間連続実行テスト
Step D5: Discord スマホ実地確認
```

---

## 付録: 実装上の注意事項

### A. executeClaudeTask へのフック位置

```javascript
// 既存コード（index.js）の末尾に追加
// STEP 7 完了通知後:
    taskManager.updateState(taskId, taskManager.STATES.DONE, '完了');
    // ★ ここで runPlannerStep を呼ぶ
    await autoProjectRunner.runPlannerStep(projectId, message).catch(e => {
      logger.error(`[AutoRunner] Plannerエラー: ${e.message}`);
    });
```

### B. 人間確認が必要な場面

以下の場合は **自動実行を停止して人間へ通知**する:
- 高危険度タスク（危険度 = 高）が queue に入った
- AIレビューが「却下推奨」を返した
- completionValidator が 2回連続失敗
- apply-review のループ上限（2回）に達した
- Planner のコール上限（10回）に達した

### C. スマートフォン操作のみで完結する運用フロー

```
1. !project create <名前>      プロジェクト作成
2. !project switch <名前>      切り替え
3. !task add DOCS <目標>       プロジェクト目標を DOCS タスクとして登録
4. !project runner on          Auto Runner 起動
   ← 以降は自動実行 →
5. 承認が必要な場合のみ
   !approve <taskId>           承認（または !deny で却下）
6. !project runner status      進捗確認
7. 完了通知を受信              プロジェクト完了
```

---

*本仕様書は AI_WORKER Auto Project Runner Phase6 の実装仕様書です。*
*実装は `docs/auto-project-runner-design.md` の設計を元に本仕様書の順序で進めること。*
