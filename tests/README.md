# テスト メモ

## 現状

テストはまだ未実装。今後追加予定。

---

## テスト対象モジュール（予定）

| モジュール | ファイル | テスト内容 |
|-----------|---------|-----------|
| タスクキュー | `bot/utils/task-queue.js` | enqueue/dequeue の動作、優先度ソート |
| タスクタイプ判定 | `bot/utils/task-type.js` | Type Guard の分類ロジック |
| セキュリティ | `bot/utils/security.js` | 危険コマンドのブロック判定 |
| 優先度計算 | `bot/utils/priority.js` | サイズ・タイプ別スコア計算 |
| AIレビュー | `bot/utils/ai-review.js` | レビュー結果のパース |

---

## 実行方法（実装後）

```powershell
npm test
```

---

## メモ

- テストフレームワークは未選定（Jest または Node.js 標準の `node:test` を検討中）
- 外部依存（Discord API, Claude API）はモック化する方針
- `bot/utils/` 単体テストを優先して整備する
