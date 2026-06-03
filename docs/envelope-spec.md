# AI_WORKER 共通エンベロープ仕様

**バージョン:** 1.0  
**作成:** 2026-06-03  
**目的:** 意思決定・インシデント・レビュー等、AI_WORKER が生成・保存するすべての記録物に共通の構造を定義する

---

## 設計原則

### なぜエンベロープか

AI_WORKER の目的は「機能数増加」ではなく  
**意思決定 → 実行 → 結果 → 教訓** のサイクルを記録し、組織の学習資産にすること。

そのために:

- **単一フォーマット** — type を変えるだけで Decision/Incident/Review すべてに対応
- **refs 参照方式** — 既存の task/review/commit をコピー保存しない。IDで参照する
- **data は type ごとに拡張** — 共通フィールドは固定、type 固有の詳細は `data` に格納

---

## 共通エンベロープ

```json
{
  "id":        "dec_1780493005927",
  "type":      "DECISION",
  "createdAt": "2026-06-03T22:33:08.000Z",
  "projectId": "ai_worker",
  "severity":  "MEDIUM",
  "title":     "Secret Guardian の false positive 修正方針",
  "summary":   "process.env.* 参照を PURE_ENV_REF_RE で精密除外する方式を採用",
  "refs":      ["task_1780493005927", "commit:3f09360"],
  "tags":      ["security", "guardian"],
  "status":    "DECIDED",
  "data":      {}
}
```

---

## フィールド定義

| フィールド  | 型       | 必須 | 説明 |
|-------------|----------|------|------|
| `id`        | string   | ✅   | `<type_prefix>_<timestamp>` 形式。例: `dec_1780493005927` |
| `type`      | string   | ✅   | レコード種別（下表参照） |
| `createdAt` | ISO 8601 | ✅   | 作成日時（UTC） |
| `projectId` | string   | ✅   | 対象プロジェクトID。`default` / `ai_worker` 等 |
| `severity`  | string   | ✅   | 重要度（下表参照） |
| `title`     | string   | ✅   | 1行タイトル（最大200文字） |
| `summary`   | string   |      | 概要説明（最大500文字） |
| `refs`      | string[] |      | 参照ID一覧。既存データをコピー保存せず参照する |
| `tags`      | string[] |      | 検索用タグ |
| `status`    | string   | ✅   | 現在の状態（下表参照） |
| `data`      | object   |      | type 固有の追加情報（下記参照） |

---

## type 一覧

| type       | ID プレフィックス | 説明 | status 候補 |
|------------|-----------------|------|-------------|
| `DECISION` | `dec_`          | 意思決定・方針決定の記録 | `OPEN` / `DECIDED` / `SUPERSEDED` / `CANCELLED` |
| `INCIDENT` | `inc_`          | 障害・不具合・セキュリティ事象 | `OPEN` / `INVESTIGATING` / `MITIGATED` / `RESOLVED` / `CLOSED` |

> **将来拡張候補:** `REVIEW` / `LESSON` / `RISK` — 実際に必要になった時点で追加する

---

## severity 一覧

| 値         | 目安 |
|------------|------|
| `LOW`      | 軽微。運用に影響なし |
| `MEDIUM`   | 通常の意思決定・改善 |
| `HIGH`     | 重要な方針変更・大きな障害 |
| `CRITICAL` | 事業継続に関わる決定・セキュリティ事故 |

---

## refs の書き方

refs はコピーではなく **参照** する。以下のプレフィックス形式を推奨:

```
task_1780493005927          # タスクID（task-manager）
commit:3f09360              # git commit hash
review_task_1780493005927   # AIレビューファイル名
dec_1780492996639           # 別の意思決定
inc_1780500000000           # インシデント
```

---

## type 固有の data スキーマ

### DECISION

```json
{
  "data": {
    "options":   ["案A: ...", "案B: ..."],
    "chosen":    "案A",
    "rationale": "既存パターンとの整合性が高いため",
    "risks":     ["移行コスト", "後方互換性"],
    "decidedBy": "CEO"
  }
}
```

### INCIDENT

```json
{
  "data": {
    "detectedAt":  "2026-06-03T22:35:29.000Z",
    "resolvedAt":  null,
    "affectedArea": ["github-push", "auto-commit"],
    "rootCause":   "GITHUB_TOKEN が起動時キャプチャのため更新を拾えなかった",
    "mitigation":  "getGithubToken() を遅延評価に変更",
    "prevention":  "環境変数は常に呼び出し時に読む"
  }
}
```

---

## 実装状況

| 機能 | ファイル | 状態 |
|------|---------|------|
| Decision Log | `bot/utils/decision-log.js` | ✅ MVP実装済み |
| Incident Manager | `bot/utils/incident-manager.js` | 🔜 予定 |

---

## データ保存方針

- `data/decisions.json` — DECISION レコード一覧（`.gitignore` 済み）
- `data/incidents.json` — INCIDENT レコード一覧（`.gitignore` 済み）
- **コピー保存禁止**: task/review/commit の内容は refs で参照する
- **redact 適用**: 保存前に秘密情報・PII をマスクする
