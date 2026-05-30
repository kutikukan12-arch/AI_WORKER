# YouTube再生回数予測AI — MVP仕様書

- **作成日:** 2026/5/31
- **バージョン:** v1.0
- **関連仕様書:** [投稿前診断AI仕様書](./youtube-diagnostic-ai-mvp-spec.md) / [長期アーキテクチャ設計書](./youtube-diagnostic-ai-architecture.md)
- **対象プロダクト:** YouTube View Count Prediction AI
- **想定ユーザー:** VTuber・ゲーム実況者・切り抜き師・音楽投稿者・実写系YouTuber

---

## 診断AIとの位置づけの違い

| 観点 | 投稿前診断AI | 再生回数予測AI |
|------|------------|--------------|
| 目的 | 投稿前コンテンツの最適化度スコア | 投稿後の再生回数・エンゲージメントの数値予測 |
| 出力 | 6軸スコア + 改善提案 | 予測再生回数レンジ + 達成確率 |
| データ依存 | Claude API の汎用知識 | 実YouTube実績データ（シード + チャンネル履歴） |
| 精度の性質 | 定性的な最適化指標 | 統計的な確率レンジ（幅を持たせた予測） |
| リリース優先度 | Phase1（即日可能） | Phase1はMVP、精度向上はPhase2以降 |

> **注意:** 予測AIは「○万回再生される」という断言ではなく、「過去の類似動画の実績から○〜○万回が60%の確率で期待できる」という確率レンジで提示する。断定予測による誤認・誇大広告リスクを避ける。

---

## 目次

1. [サービス概要](#1-サービス概要)
2. [対象ユーザー](#2-対象ユーザー)
3. [Phase1 MVP範囲](#3-phase1-mvp範囲)
4. [Phase2 ジャンルシード学習](#4-phase2-ジャンルシード学習)
5. [Phase3 チャンネル専用学習](#5-phase3-チャンネル専用学習)
6. [MVPで作る機能](#6-mvpで作る機能)
7. [MVPで作らない機能](#7-mvpで作らない機能)
8. [API設計](#8-api設計)
9. [DB設計](#9-db設計)
10. [画面設計](#10-画面設計)
11. [スコア設計](#11-スコア設計)
12. [サブスク設計](#12-サブスク設計)
13. [完成条件](#13-完成条件)
14. [次に作るIMPLEMENTタスク](#14-次に作るimplementタスク)

---

## 1. サービス概要

YouTube に投稿予定の動画のメタデータ（タイトル・説明文・タグ・サムネイル・尺・ジャンル）を入力すると、**過去の類似動画の実績データをもとに再生回数・視聴維持率・エンゲージメント率の予測レンジ**を返すサービス。

### コアコンセプト

```
入力: 動画メタデータ（タイトル・説明文・タグ・ジャンル・尺）
         ↓
    類似動画マッチング
    （ジャンル別実績DB）
         ↓
出力: 予測再生回数レンジ + 達成確率 + 比較ベンチマーク
```

### 提供価値

- **投稿判断の根拠を数値で得られる** — 「伸びる気がする」という感覚論からの脱却
- **ジャンル内ベンチマーク比較** — 同ジャンルの平均・上位10%・上位1%と自分の予測値を比較
- **改善シミュレーション** — タイトルや投稿時間を変えたときに予測値がどう変わるか確認できる
- **チャンネル成長トラッキング** — 予測 vs 実績の差異を蓄積し、チャンネル固有の精度を向上

---

## 2. 対象ユーザー

### プライマリユーザー

| セグメント | 課題 | 本サービスの価値 |
|-----------|------|----------------|
| **VTuber（小〜中規模）** | なぜ伸びる動画と伸びない動画があるかわからない | ジャンル内の類似動画実績と比較した予測が得られる |
| **ゲーム実況者** | ゲームタイトル選定が感覚任せ | ゲームタイトル×実況形式別の期待再生回数がわかる |
| **切り抜き師** | 切り抜き元のバズ依存でコントロールしにくい | 元動画の規模と切り抜きタイトルから期待値を予測 |
| **音楽投稿者** | 再生回数が伸びる曲と伸びない曲の違いを把握しにくい | カバー/オリジナル・アーティスト別のベンチマーク比較 |
| **実写YouTuber** | サムネとタイトルの組み合わせ最適化が難しい | A/Bパターン比較で投稿前に高スコア案を選べる |

### セカンダリユーザー

- **チャンネル運営マネージャー** — 複数チャンネルの予測傾向をダッシュボードで管理
- **コンテンツプランナー** — 月次コンテンツカレンダーを予測値ベースで組む

---

## 3. Phase1 MVP範囲

### 概要

YouTube Data API から収集した**ジャンル別シードデータ（hit/miss各100件）**をコンテキストとして Claude API に渡し、入力動画の類似度スコアと予測レンジを生成する。シンプルな RAG 構成で、ML モデルの学習インフラ不要。

### 予測の仕組み（Phase1）

```
[入力メタデータ]
      ↓
[ジャンル別シードデータ検索]
  ・タイトル類似度スコアリング（Chroma DB）
  ・上位10件の実績データを取得
      ↓
[Claude API 予測プロンプト]
  ・類似動画10件の再生回数・エンゲージメント実績を提示
  ・入力動画との差分要素を分析
  ・予測レンジと達成確率を生成
      ↓
[出力: 予測レポート]
```

### 予測出力の構造

```json
{
  "requestId": "pred_20260531_001",
  "timestamp": "2026-05-31T10:00:00+09:00",
  "genre": "VTuber",
  "learningPhase": "genre_seed",
  "confidence": "medium",

  "prediction": {
    "viewCount": {
      "low":    5000,
      "median": 18000,
      "high":   45000,
      "unit":   "views_7days"
    },
    "probability": {
      "above5k":  0.82,
      "above10k": 0.55,
      "above30k": 0.21,
      "above100k": 0.04
    }
  },

  "benchmark": {
    "genreMedian":  12000,
    "genreTop10pct": 50000,
    "genreTop1pct": 200000,
    "yourPercentile": 60
  },

  "similarVideos": [
    {
      "title": "類似動画タイトル例",
      "actualViews": 22000,
      "similarityScore": 0.87,
      "keyDifferences": ["尺が2分短い", "投稿時間が1時間早い"]
    }
  ],

  "keyFactors": [
    { "factor": "タイトルのフック強度", "impact": "+15%", "detail": "感情語「初見」が含まれている" },
    { "factor": "投稿曜日", "impact": "-8%", "detail": "このジャンルは金土が最大。平日は約8%減の傾向" },
    { "factor": "動画の尺", "impact": "+5%", "detail": "12分は最適帯（8〜15分）内に収まっている" }
  ],

  "simulation": {
    "ifSaturdayPost": { "medianChange": "+12%", "newMedian": 20160 },
    "ifAddKeyword":   { "medianChange": "+8%",  "newMedian": 19440 }
  },

  "summary": "ジャンル中央値(12,000)を上回る予測。土曜投稿に変えることで約12%の上乗せが期待できる。"
}
```

### Phase1 技術スタック

| コンポーネント | 採用技術 | 理由 |
|------------|--------|------|
| インターフェース | Discord Bot（既存 AI_WORKER 基盤） | 追加実装コスト最小 |
| AI推論 | Claude API（claude-sonnet-4-6） | 汎用性・コスト効率 |
| シードデータ収集 | YouTube Data API v3 | 公開APIのみ・無料枠内 |
| ベクトル類似検索 | Chroma DB（ローカル） | 軽量・Node.js対応 |
| データ保存 | JSON ファイル + Chroma DB | MVPは軽量構成 |
| 実行環境 | Node.js（既存環境） | 既存コードベースと統一 |

---

## 4. Phase2 ジャンルシード学習

### 概要

YouTube Data API でジャンルごとに「バズった動画（hit）」と「伸びなかった動画（miss）」を各500件収集し、統計的な特徴量を抽出してジャンルプロファイルを構築する。Phase1 の10件マッチングより大きなサンプルサイズで予測精度を向上させる。

### 対象ジャンル（5種）

| ジャンル | hit定義（チャンネル規模比） | miss定義 | 固有の予測変数 |
|---------|---------------------|---------|-----------| 
| **VTuber** | チャンネル平均の3倍以上 | チャンネル平均の1/3以下 | コラボ有無・枠種別（歌/ゲーム/雑談）・ライバー知名度 |
| **切り抜き** | 元動画の5%以上の再生回数 | 元動画の1%未満 | 元動画規模・切り抜き尺・タイトルのネタバレ度 |
| **音楽** | 高評価率3%超かつ5万回以上 | 高評価率1%未満 | オリジナル/カバー・アーティスト知名度・サビ配置 |
| **実写** | 7日で1万回以上 | 7日で1,000回未満 | 顔出し有無・話速・テーマの共感度 |
| **ゲーム実況** | ゲームタイトル補正後で上位10% | 下位30% | ゲームタイトルの旬・プレイスタイル・リアクション強度 |

### 学習パイプライン

```
[1. データ収集]      [2. 特徴量抽出]      [3. モデル構築]      [4. 予測時RAG注入]
YouTube Data API  →  Claude APIで分析  →  統計モデル作成    →  クエリ→類似検索
ジャンル別           タイトルパターン       回帰ベース           →プロンプト注入
hit: 500件          タグ頻度分析          (Ridge/XGBoost)
miss: 500件         投稿時間分布          Chroma DB格納
月1回バッチ更新      尺分布                namespace:
                                          "genre_models_v2"
```

### ジャンルプロファイルv2構造（抜粋）

```json
{
  "genre": "VTuber",
  "version": "2.0.0",
  "updatedAt": "2026-05-31",
  "sampleSize": { "hit": 500, "miss": 500 },
  "viewCountDistribution": {
    "p10": 800, "p25": 2500, "p50": 12000,
    "p75": 45000, "p90": 150000, "p99": 800000
  },
  "titleFeatures": {
    "hitKeywords": [
      { "word": "初見", "hitLiftRatio": 1.8 },
      { "word": "コラボ", "hitLiftRatio": 2.1 },
      { "word": "歌ってみた", "hitLiftRatio": 1.6 }
    ],
    "missKeywords": [
      { "word": "雑談", "missRatio": 0.61 },
      { "word": "テスト", "missRatio": 0.72 }
    ],
    "optimalLength": { "min": 20, "max": 35, "unit": "chars" }
  },
  "durationProfile": {
    "hitSweetSpot": { "min": 8, "max": 15, "unit": "minutes" },
    "missOvershoot": { "threshold": 30, "unit": "minutes" }
  },
  "postingProfile": {
    "bestDays": ["金曜", "土曜"],
    "bestHours": [20, 21, 22],
    "worstDays": ["月曜", "火曜"],
    "weekdayMultiplier": 0.72
  },
  "regressionCoefficients": {
    "titleSentimentScore": 0.18,
    "tagCount":            0.07,
    "durationMinutes":    -0.03,
    "isSaturdayPost":      0.15,
    "hasCollabKeyword":    0.22
  }
}
```

### Phase2 技術スタック追加分

| コンポーネント | 採用技術 |
|------------|--------|
| 特徴量抽出 | Claude API（バッチ処理） |
| 統計モデル | scikit-learn（Ridge回帰 / XGBoost）Python スクリプト |
| モデル格納 | joblib + JSON（Chroma DB 併用） |
| 更新バッチ | night-batch.js 拡張（月1回 + 手動起動） |

---

## 5. Phase3 チャンネル専用学習

### 概要

ユーザー自身の YouTube チャンネルの公開動画データを収集し、「そのチャンネル固有の伸びパターン」を学習したチャンネルモデルを構築する。Phase2 のジャンルモデルをベースラインとして、チャンネルモデルの差分スコアで補正する二層構造。

### 予測の二層構造

```
[ジャンルモデル（Phase2）]
  ジャンル内の「平均的な伸び方」を予測
        ↓ × チャンネル補正係数
[チャンネルモデル（Phase3）]
  「このチャンネルらしい動画」での補正予測
        ↓
[最終予測値]
  チャンネル固有ベースラインを考慮した予測レンジ
```

### チャンネルプロファイル構造（抜粋）

```json
{
  "channelId": "UC_xxxxx",
  "channelName": "例: 白詠チャンネル",
  "genre": "VTuber",
  "subscriberCount": 45000,
  "videoCount": 200,
  "analyzedVideos": 180,

  "channelBaseline": {
    "avgViewCount7d":      15000,
    "avgLikeRate":         0.08,
    "avgCommentRate":      0.012,
    "avgRetentionRate":    0.62,
    "subscriberViewRatio": 0.33
  },

  "hitPattern": {
    "topPerformingCategories": ["歌枠", "ゲーム初見", "コラボ"],
    "hitTitleKeywords":       ["初見", "コラボ", "歌ってみた"],
    "hitDurationRange":       { "min": 9, "max": 14 },
    "hitPostDay":             "土曜",
    "hitPostHour":            21
  },

  "channelMultiplier": {
    "collab":       1.45,
    "saturdayPost": 1.18,
    "longVideo30m": 0.62,
    "mondayPost":   0.71
  },

  "predictionAccuracy": {
    "samplePairs": 50,
    "mae":         3200,
    "mape":        0.22
  }
}
```

### Phase3 追加コマンド

```
!learn-channel {channelUrl}
  → チャンネルの公開動画を最大500件収集・学習開始（所要時間: 約5〜15分）

!predict-channel {channelUrl} [タイトル] / [説明文] / [タグ]
  → チャンネル専用モデルで予測を実行

!channel-accuracy
  → 自チャンネルの予測vs実績の精度レポート表示
```

### Phase3 技術スタック追加分

| コンポーネント | 採用技術 |
|------------|--------|
| チャンネルデータ取得 | YouTube Data API v3（公開APIのみ） |
| チャンネルモデル | 線形補正係数 + 重み付き平均 |
| プロファイル保存 | JSON + Chroma DB（namespace: "channel_profiles"） |
| 学習実行 | channel-learner.js（新規実装）|

---

## 6. MVPで作る機能

MVP = Phase1（シードデータ＋Claude APIによる予測）の実装のみ。

### 実装ファイル構成

```
bot/
├── predictor.js              ★新規 — 予測エンジン本体
│   ├── buildPredictionPrompt()   : 入力＋類似動画→プロンプト変換
│   ├── callClaudeAPI()           : Claude API呼び出し
│   ├── parsePrediction()         : JSON出力パース・バリデーション
│   └── formatPredictionEmbed()   : Discord Embed整形
│
├── seed-collector.js         ★新規 — YouTubeシードデータ収集
│   ├── collectGenreSeeds()       : ジャンル別hit/miss100件収集
│   ├── saveSeedToChroma()        : Chroma DBへ格納
│   └── refreshSeeds()            : 月次更新バッチ
│
├── chroma-client.js          ★新規 — Chroma DB接続管理
│   ├── searchSimilar()           : 類似動画検索（上位10件）
│   └── upsertDocument()          : ドキュメント追加・更新
│
└── index.js                  既存 — !predict コマンド追加
    └── !predict → executePredictionTask() 呼び出し
```

### コマンド仕様

```
基本コマンド（テキストのみ）:
!predict [ジャンル] [タイトル] / [説明文] / [タグ] / [尺(分)]
例: !predict VTuber 【初見】ゲーム名に挑戦した！ / VTuberが初めてプレイ / VTuber,ゲーム / 12

オプション:
!predict ... --post-day 土曜 --post-hour 21   : 投稿予定時刻指定
!predict ... --simulate                        : 改善シミュレーション付き出力
!predict ... --compare {他タイトル案}          : 複数タイトル案のA/B比較

シードデータ管理:
!seed-refresh [genre]    : 指定ジャンルのシードデータを再収集
!seed-status             : 各ジャンルのシードデータ件数・更新日表示
```

---

## 7. MVPで作らない機能

| 機能 | 除外理由 | 対応フェーズ |
|-----|---------|------------|
| チャンネル専用学習モデル | 学習インフラが複雑 | Phase3 |
| 統計的回帰モデル（XGBoost等） | Python環境整備が必要 | Phase2 |
| Webダッシュボード | Discord UIで十分 | Phase4以降 |
| 実績フィードバック自動取得 | YouTube Analytics API認証が必要 | Phase3 |
| リアルタイムトレンド補正 | YouTube Trends APIの統合が複雑 | Phase2 |
| バッチ予測（複数動画一括） | MVP後の利便性向上として実装 | Phase2+ |
| 競合チャンネル比較 | 倫理・利用規約リスクを要検討 | Phase3 |
| サムネイル自動生成提案 | スコープ外（別サービス） | 未定 |

---

## 8. API設計

### エンドポイント（内部 REST API / Discord Bot経由）

```
POST /api/predict
  Body: {
    genre:        "VTuber" | "切り抜き" | "音楽" | "実写" | "ゲーム実況" | "other",
    title:        string (max 100),
    description?: string (max 500),
    tags?:        string[] (max 20),
    durationMin?: number,
    postDay?:     "月" | "火" | "水" | "木" | "金" | "土" | "日",
    postHour?:    number (0-23),
    simulate?:    boolean
  }
  Response: PredictionResult (上述JSONスキーマ参照)

GET /api/seeds/status
  Response: {
    genres: {
      VTuber: { hitCount: 100, missCount: 100, updatedAt: "2026-05-31" },
      ...
    }
  }

POST /api/seeds/refresh
  Body: { genre: string }
  Response: { status: "started" | "completed", message: string }

GET /api/history/:userId
  Response: PredictionResult[] (直近20件)
```

### Claude API プロンプト設計（Phase1）

```
system: |
  あなたはYouTubeコンテンツの再生回数予測専門家です。
  提供された過去の類似動画の実績データをもとに、入力動画の
  7日間再生回数を統計的に予測してください。
  必ず確率レンジで回答し、断定的な数値を避けてください。
  回答はJSON形式のみで返してください。

user: |
  【入力動画メタデータ】
  ジャンル: {genre}
  タイトル: {title}
  説明文: {description}
  タグ: {tags}
  動画尺: {duration}分
  投稿予定: {postDay} {postHour}時

  【ジャンル内類似動画10件の実績データ】
  {similarVideosContext}

  【ジャンル統計サマリー】
  中央値: {genreMedian}回, 上位10%: {genreTop10pct}回
```

---

## 9. DB設計

### Chroma DB コレクション構成

```
コレクション名: youtube_seeds
  namespace: genre_{ジャンル名}

  Document構造:
    id:        "{genre}_{videoId}"
    text:      "{タイトル} {説明文の冒頭200文字} {タグ列}"  ← 埋め込み対象
    metadata: {
      videoId:       string,
      genre:         string,
      title:         string,
      viewCount7d:   number,
      likeCount:     number,
      commentCount:  number,
      durationSec:   number,
      postDay:       string,
      postHour:      number,
      performanceLabel: "hit" | "miss" | "normal",
      collectedAt:   ISO8601
    }
```

### JSON ファイル保存（ローカル）

```
data/
├── prediction/
│   ├── history/
│   │   └── {userId}_{timestamp}.json    ← 予測履歴（ユーザー別）
│   └── seeds/
│       ├── vtuber_seeds.json            ← シードデータキャッシュ
│       ├── game_seeds.json
│       ├── music_seeds.json
│       ├── clips_seeds.json
│       └── realshot_seeds.json
```

### データ保持ポリシー

| データ種別 | 保持期間 | 更新頻度 |
|----------|--------|--------|
| ジャンルシードデータ | 無期限（月次更新） | 月1回バッチ |
| 予測履歴（個人） | 90日 | 随時 |
| チャンネルプロファイル（Phase3） | 無期限 | 週次バッチ |
| Chroma DB インデックス | シードと同期 | シード更新時 |

---

## 10. 画面設計

### Discord Embed — 予測結果（基本出力）

```
┌─────────────────────────────────────────────────────┐
│ 🎯 YouTube再生回数予測レポート                        │
│ ジャンル: VTuber  |  信頼度: MEDIUM                  │
├─────────────────────────────────────────────────────┤
│ 📊 7日間再生回数 予測レンジ                           │
│                                                      │
│  LOW     ████░░░░░░░░░░░░   5,000回                 │
│  MEDIAN  ████████░░░░░░░░  18,000回  ← あなたの予測 │
│  HIGH    ████████████░░░░  45,000回                 │
│                                                      │
│  10k超え: 55%  |  30k超え: 21%  |  100k超え: 4%    │
├─────────────────────────────────────────────────────┤
│ 📈 ジャンル内ベンチマーク比較                         │
│  ジャンル中央値:   12,000回                           │
│  上位10%:         50,000回                           │
│  あなたの予測:     18,000回 → ジャンル内 上位40%相当 │
├─────────────────────────────────────────────────────┤
│ 🔑 主要予測因子                                       │
│  ✅ +15% タイトルに「初見」を含む                     │
│  ⚠️  -8%  平日投稿（金土比）                         │
│  ✅  +5%  尺が最適帯（8〜15分）内                    │
├─────────────────────────────────────────────────────┤
│ 💡 改善シミュレーション                               │
│  土曜投稿に変更 → +12% → 中央値 20,160回             │
│  「コラボ」キーワード追加 → +8% → 中央値 19,440回    │
├─────────────────────────────────────────────────────┤
│ 📝 サマリー                                           │
│ ジャンル中央値を上回る予測。土曜投稿への変更で約12%  │
│ の上乗せが期待できる。                               │
└─────────────────────────────────────────────────────┘
[🔄 再診断] [📊 A/B比較] [📚 履歴]
```

### Discord Embed — A/B比較出力

```
┌─────────────────────────────────────────────────────┐
│ 🅰️🅱️ タイトルA/B比較予測                              │
├─────────────────────────────────────────────────────┤
│ 案A: 【初見】ゲーム名に挑戦！    予測中央値: 18,000回 │
│ 案B: ゲーム名を初プレイしたら…   予測中央値: 13,500回 │
│                                                      │
│ → 案A が約33%高い予測。「【】」強調＋感情語が有効   │
└─────────────────────────────────────────────────────┘
```

### Discord Embed — シードデータ状態

```
┌─────────────────────────────────────────────────────┐
│ 📦 シードデータ状態                                   │
│ VTuber    : hit 100件 / miss 100件  更新: 05/01     │
│ ゲーム実況: hit 100件 / miss 100件  更新: 05/01     │
│ 音楽      : hit  80件 / miss  90件  更新: 04/15 ⚠️  │
│ 切り抜き  : hit 100件 / miss 100件  更新: 05/01     │
│ 実写      : hit  60件 / miss  60件  更新: 04/10 ⚠️  │
└─────────────────────────────────────────────────────┘
```

---

## 11. スコア設計

### 信頼度レベル（Confidence Level）

予測の信頼度は入力の充実度・シードデータの品質・類似動画の近さで決まる。

| レベル | 条件 | 予測レンジの幅 |
|-------|------|-------------|
| **HIGH** | 全入力項目あり + 類似スコア0.85以上の動画3件以上 | ±30% |
| **MEDIUM** | 必須入力のみ or 類似スコア0.7以上 | ±60% |
| **LOW** | シードデータ不足 or ジャンル"other" | ±100%（参考値） |

### 予測精度指標（Phase1評価基準）

| 指標 | 目標値 | 測定タイミング |
|------|-------|-------------|
| MAPE（平均絶対誤差率） | ≤ 35% | Phase1完成後30日 |
| 方向性正解率（上位/下位判定） | ≥ 70% | Phase1完成後30日 |
| ジャンル別中央値誤差 | ≤ ±20% | 月次レビュー |

### 予測レンジの計算ロジック

```
median_prediction = weighted_avg(similar_videos.viewCount, weights=similarityScores)
low_bound  = median_prediction × (1 - confidence_interval)
high_bound = median_prediction × (1 + confidence_interval)

confidence_interval:
  HIGH   → 0.30
  MEDIUM → 0.60
  LOW    → 1.00

補正係数（Claude APIが分析・適用）:
  postDayMultiplier:    ジャンルプロファイルの曜日係数
  titleSentimentBonus:  感情語・数字・記号の有無
  durationFitRatio:     最適尺帯への収まり具合
```

---

## 12. サブスク設計

### プラン構成

| プラン | 月額 | 予測回数/月 | 主要機能 |
|-------|------|-----------|--------|
| **FREE** | 無料 | 10回 | 基本予測（テキストのみ）・ジャンル5種 |
| **CREATOR** | ¥980 | 100回 | 全機能・シミュレーション・A/B比較・予測履歴90日 |
| **PRO** | ¥2,980 | 無制限 | CREATOR全機能 + チャンネル学習（Phase3）+ 月次精度レポート |
| **AGENCY** | ¥9,800 | 無制限×10チャンネル | PRO全機能 + 複数チャンネル管理 + APIアクセス |

### 利用制限の実装

```javascript
// rate-limiter.js
const PLAN_LIMITS = {
  free:    { monthly: 10,  features: ["basic_predict"] },
  creator: { monthly: 100, features: ["basic_predict", "simulate", "ab_compare", "history"] },
  pro:     { monthly: -1,  features: ["basic_predict", "simulate", "ab_compare", "history", "channel_learn"] },
  agency:  { monthly: -1,  features: ["all"], channels: 10 }
};
```

### Phase1 でのサブスク実装範囲

MVP では**フリープラン（10回/月）のみ実装**。課金機能は Phase2 以降（Stripe 統合）。

---

## 13. 完成条件

### 機能的完成条件

```
✅ !predict コマンドで予測結果が Discord Embed で返ってくる
✅ VTuber・ゲーム実況・音楽・切り抜き・実写の5ジャンルでシードデータが揃っている
✅ 予測結果に再生回数レンジ（low/median/high）と確率が含まれている
✅ ジャンル内ベンチマーク比較（中央値・上位10%）が表示される
✅ 主要予測因子（+/-影響度）が3件以上表示される
✅ 改善シミュレーション（投稿曜日変更・キーワード追加）が表示される
✅ 信頼度レベル（HIGH/MEDIUM/LOW）が表示される
✅ !seed-status でシードデータの状態が確認できる
✅ 予測履歴が data/prediction/history/ に保存される
```

### 品質的完成条件

```
✅ 各ジャンルのシードデータが hit/miss 各50件以上
✅ Claude API エラー時に再試行（最大3回）し、失敗時はユーザーに通知
✅ Chroma DB 検索で類似動画が0件の場合でも予測が返る（LOW信頼度）
✅ 1予測の応答時間が 10秒以内（平均）
✅ 予測結果のJSONパース失敗時にフォールバック処理がある
```

### 検収テスト（完成判定用）

| テストケース | 期待動作 |
|-----------|--------|
| VTuber・タイトルのみ入力 | LOW信頼度で予測レンジが返る |
| 全項目入力・VTuber | MEDIUM以上の信頼度で予測返る |
| 存在しないジャンル指定 | エラーメッセージでジャンル選択を促す |
| !seed-status実行 | 全5ジャンルのシードデータ状態が表示される |
| Claude API タイムアウト | 3回リトライ後にエラー通知 |
| !predict --simulate付き | 改善シミュレーション項目が2件以上含まれる |

---

## 14. 次に作るIMPLEMENTタスク

### タスク優先順位

```
優先度: HIGH
[IMPLEMENT] predictor.js — YouTube再生回数予測エンジン実装
  ・buildPredictionPrompt() / callClaudeAPI() / parsePrediction() / formatPredictionEmbed()
  ・!predict コマンドを index.js に追加
  ・blockedBy: seed-collector.js の完成

優先度: HIGH
[IMPLEMENT] seed-collector.js — YouTubeシードデータ収集モジュール実装
  ・YouTube Data API v3 でジャンル別hit/miss各100件収集
  ・collectGenreSeeds() / saveSeedToChroma() / refreshSeeds()
  ・YouTube Data API キー設定（.env 追記）
  ・blockedBy: chroma-client.js の完成

優先度: HIGH
[IMPLEMENT] chroma-client.js — Chroma DB接続クライアント実装
  ・Chroma DB ローカル起動設定（Docker or ローカルプロセス）
  ・searchSimilar() / upsertDocument()
  ・blockedBy: なし（最初に着手）

優先度: MEDIUM
[IMPLEMENT] !seed-status コマンド実装
  ・各ジャンルのシードデータ件数・更新日を Embed 表示
  ・blockedBy: seed-collector.js

優先度: MEDIUM
[IMPLEMENT] !predict --simulate オプション実装
  ・投稿曜日変更・キーワード追加の改善シミュレーション
  ・blockedBy: predictor.js

優先度: LOW（Phase2準備）
[IMPLEMENT] seed-refresh バッチを night-batch.js に統合
  ・月1回自動実行・シードデータ差分更新
  ・blockedBy: seed-collector.js
```

### 実装推奨順序

```
1. chroma-client.js          ← 基盤。依存なし
2. seed-collector.js         ← chroma-client.js 完成後
3. 初回シードデータ収集実行  ← seed-collector.js 完成後（手動バッチ）
4. predictor.js              ← shroma + seed 完成後
5. !seed-status コマンド     ← seed-collector.js 完成後（predictor と並行可）
6. !predict --simulate       ← predictor.js 完成後
7. night-batch.js 統合       ← 全完成後
```

---

*このドキュメントは AI_WORKER プロジェクトの YouTube 再生回数予測AI MVP の仕様を定義する。Phase1 実装完了後、実績データをもとに精度評価を行い Phase2 移行の判断をする。*
