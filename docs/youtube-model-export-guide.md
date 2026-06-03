# YouTube診断AI — モデルファイル管理ガイド

**作成:** 2026-06-04  
**対象:** AI_WORKER 開発者 / Webビルド担当

---

## ファイル分類

| ファイル | 分類 | git 管理 | 説明 |
|---------|------|---------|------|
| `data/youtube-model.json` | 🔒 **非公開** | **gitignore** | 投稿後データ学習済みモデル（training metadata 含む） |
| `data/youtube-model-pre.json` | 🔒 **非公開** | **gitignore** | 投稿前専用学習モデル（training metadata 含む） |
| `data/youtube-seeds/` | 🔒 **非公開** | **gitignore** | 収集済み YouTube データセット |
| `data/youtube-model-export.json` | ✅ **公開可能** | コメントアウト ※ | 推論専用 export（weights + featureDim のみ） |

※ `youtube-model-export.json` は AI_WORKER 本体 repo では **誤公開防止のためデフォルト非追跡**。  
  Web ビルド時に手動でコピーする「公開成果物」として扱う（下記参照）。

---

## training model に含まれる非公開情報

`data/youtube-model.json` / `data/youtube-model-pre.json` には以下が含まれるため **絶対に公開しない**:

| フィールド | 理由 |
|-----------|------|
| `sampleCount` | 収集規模を外部に開示しない |
| `hitCount` / `missCount` | 内部データ統計 |
| `trainDirectionalAcc` | 内部パフォーマンス指標 |
| `trainedAt` | データ収集タイミングを開示しない |
| `genreHitRates` | 内部ジャンル分析パターン |

---

## export model (`youtube-model-export.json`) の扱い

### 何が入っているか

```json
{
  "version":      "1.0",
  "exportedAt":   "2026-06-04T...",
  "featureDim":   15,
  "featureNames": ["title_len_norm", ...],
  "weights":      [0.1, -0.3, ...]
}
```

上記のみ。training metadata は **一切含まない**。

### 生成方法

```
!youtube export-model   （管理者専用コマンド）
```

`data/youtube-model-pre.json` から training metadata を除外して  
`data/youtube-model-export.json` を生成する。  
生成ロジック: `bot/utils/youtube-model-exporter.js`

### Web ビルド時の手順

1. AI_WORKER 内で `!youtube train` を実行してモデルを更新
2. `!youtube export-model` を実行して export を生成
3. `data/youtube-model-export.json` を Web リポジトリの所定パスにコピー
4. Web リポジトリ側で git commit してデプロイ

> ⚠️ AI_WORKER 本体 repo では `youtube-model-export.json` を commit しない。  
> Web 向けの公開成果物は別 repo / デプロイパイプラインで管理する。

---

## 現時点の git 管理方針

AI_WORKER repo は **現時点では社内非公開前提**。  
そのため training model が過去の git 履歴に含まれていても、現時点では対応不要。

将来 **public 化・外部共有** する場合のみ、以下を検討する:

```bash
# 過去の履歴から training model を完全削除（要: 全メンバー clone 更新）
git filter-repo --path data/youtube-model.json --invert-paths
git filter-repo --path data/youtube-model-pre.json --invert-paths
```

> ⚠️ `git filter-repo` は履歴書き換えを伴うため、必ず全員と合意の上で実施。
