# YouTube投稿前診断AI — 長期アーキテクチャ設計書

- **作成日:** 2026/5/31
- **対象プロダクト:** YouTube Pre-Upload Diagnostic AI
- **想定ユーザー:** VTuber・ゲーム実況者・切り抜き師・音楽投稿者・実写系YouTuber

---

## 目次

1. [全体構想](#1-全体構想)
2. [Phase別ロードマップ](#2-phase別ロードマップ)
3. [Phase1: 汎用診断AI (MVP)](#3-phase1-汎用診断ai-mvp)
4. [Phase2: ジャンルシード学習](#4-phase2-ジャンルシード学習)
5. [Phase3: チャンネル専用学習](#5-phase3-チャンネル専用学習)
6. [システム構成図](#6-システム構成図)
7. [データ構造設計](#7-データ構造設計)
8. [学習方法設計](#8-学習方法設計)
9. [MVPとの差分整理](#9-mvpとの差分整理)
10. [サブスク化設計](#10-サブスク化設計)

---

## 1. 全体構想

### コアコンセプト

> **「投稿ボタンを押す前に、バズる動画かどうかをAIが判定する」**

YouTube投稿者が動画ファイル・サムネ・タイトル・説明文を入力すると、AIが多角的に診断し改善提案を返す。Phase1は汎用診断、Phase2はジャンル固有のクセを学習、Phase3は本人の過去動画を学習して「そのチャンネルらしさ」まで判定できるようになる。

### 診断軸（全Phase共通）

| 軸 | 内容 |
|----|------|
| **CTR予測** | サムネ・タイトルのクリック率推定 |
| **視聴維持率予測** | 冒頭10秒・中盤・終盤の離脱リスク |
| **SEO強度** | タイトル・説明文のキーワード最適度 |
| **感情フック** | 冒頭のつかみ・感情的な引き込み強度 |
| **投稿タイミング** | ジャンル・曜日・時間帯の相性 |
| **競合差別化** | 類似動画との差別化ポイント |

---

## 2. Phase別ロードマップ

```
Phase1 (MVP)          Phase2                Phase3
─────────────────     ─────────────────     ─────────────────
汎用診断AI             ジャンルシード学習      チャンネル専用学習
・Claude API呼び出し   ・ジャンル別プロファイル  ・過去動画データ収集
・基本6軸診断          ・シード動画から抽出     ・個人スタイル学習
・テキスト入力のみ      ・ジャンル固有の判定基準  ・チャンネル専用スコア
      │                       │                       │
      ▼                       ▼                       ▼
  無料 / 体験版           有料プラン (月額)      プレミアム (月額高)
```

| Phase | 期間目安 | 主要技術 | 収益モデル |
|-------|---------|---------|-----------|
| Phase1 | 1〜2ヶ月 | Claude API + Discord Bot | 無料（集客） |
| Phase2 | 3〜5ヶ月 | Vector DB + RAG | 月額 ¥980〜¥1,980 |
| Phase3 | 6〜12ヶ月 | Fine-tuning or RAG + YT API | 月額 ¥3,980〜¥9,800 |

---

## 3. Phase1: 汎用診断AI (MVP)

### 概要

Claude APIに「プロの動画プロデューサー」ペルソナを与え、入力された動画情報を基に6軸診断を行う。シードデータ・学習不要でAPIキーがあれば即日稼働できる。

### 入力フォーム

```
【必須】
・タイトル（文字列）
・説明文（文字列）
・タグ（カンマ区切り）
・ジャンル選択（VTuber / 切り抜き / 音楽 / 実写 / ゲーム実況 / その他）

【任意】
・サムネイル画像（PNG/JPG）
・動画の尺（分秒）
・冒頭30秒の台本・字幕テキスト
```

### Discord連携フロー（AI_WORKER既存基盤を活用）

```
ユーザー: !diag [タイトル] / [説明文] / [タグ]
    ↓
index.js → executeDiagnosticTask()
    ↓
diagnostic.js → buildDiagnosticPrompt()
    ↓
Claude API (claude-sonnet-4-6)
    ↓
診断結果 JSON → Embed整形 → Discord送信
```

### 出力フォーマット（Discord Embed）

```
📊 YouTube投稿前診断レポート
━━━━━━━━━━━━━━━━━━━━━
🎯 総合スコア: 72/100

📌 CTR予測:        ★★★☆☆ (65点)
📌 視聴維持率予測:  ★★★★☆ (78点)
📌 SEO強度:        ★★★☆☆ (60点)
📌 感情フック:     ★★★★☆ (80点)
📌 投稿タイミング:  ★★☆☆☆ (55点)
📌 競合差別化:     ★★★☆☆ (70点)

⚡ 改善提案 TOP3
1. タイトルに数字を入れるとCTRが約15%向上（例: 「5分でわかる...」）
2. 説明文の最初の2行がSEOに効く。キーワード「〇〇」を前に出して
3. この内容は土曜21時〜23時に伸びやすいジャンル

💡 ジャンル: 汎用診断（Phase1）
```

### Phase1 技術スタック

| コンポーネント | 技術 | 理由 |
|-------------|------|------|
| フロントエンド | Discord Bot (既存) | 追加実装コスト最小 |
| AI推論 | Claude API (Sonnet) | 汎用性・コスト効率 |
| サムネ解析 | Claude Vision API | 別途モデル不要 |
| データ保存 | ローカル JSON | MVP段階は永続化不要 |

---

## 4. Phase2: ジャンルシード学習

### 概要

各ジャンルのYouTube上の「バズった動画」「伸びなかった動画」のメタデータを収集・分析し、**ジャンル固有の判定プロファイル**を構築する。これを診断時のコンテキストとして注入することで、汎用AIより精度の高い判定を実現する。

---

### 4.1 ジャンルシード学習の詳細設計

#### 学習パイプライン全体像

```
[1. シード収集]         [2. 特徴抽出]          [3. プロファイル構築]      [4. 診断注入]
──────────────         ──────────────         ──────────────────        ──────────────
YouTube Data API  →    Claude API で           Vector DB に              RAG で関連
でジャンル別の          メタデータから           埋め込みベクトル           プロファイルを
上位/下位動画を         パターンを抽出 →        として保存               取得してプロンプト
収集                   構造化JSON化                                     に注入
```

#### ステップ1: シード動画収集

**対象:** 各ジャンルごとに「バズ動画（再生数/チャンネル登録者比 > 3倍）」と「凡庸動画（比 < 0.5倍）」をそれぞれ100件ずつ収集。

```javascript
// 収集対象メタデータ（YouTube Data API v3）
{
  videoId: "string",
  title: "string",
  description: "string (first 500 chars)",
  tags: ["string"],
  thumbnailUrl: "string",
  duration: "ISO8601",
  publishedAt: "datetime",
  channelSubscribers: number,
  viewCount: number,
  likeCount: number,
  commentCount: number,
  // 計算値
  buzz_ratio: viewCount / channelSubscribers,
  category: "VTuber | clip | music | realshot | gaming",
  seed_label: "hit | miss"
}
```

**収集クエリ例（VTuberジャンル）:**

```
hit動画クエリ:
  - keyword: "VTuber" + "初見" OR "コラボ" OR "歌ってみた"
  - filter: publishedBefore=30日前, viewCount>100k, orderBy=viewCount

miss動画クエリ:
  - 同チャンネルの平均以下動画
  - 同ジャンル・同期間でview数が低いもの
```

---

#### ステップ2: パターン特徴抽出

収集したシード動画を Claude API に渡し、**ジャンル固有のパターン**を構造化して抽出する。

```
抽出プロンプト（例: VTuberジャンル）:

以下は VTuber ジャンルの「バズった動画」100件と「伸びなかった動画」100件のメタデータです。
両者を比較して以下の特徴を構造化JSONで抽出してください:

1. タイトルパターン
   - バズタイトルに共通する語彙・数字・記号
   - 避けるべきタイトルの特徴

2. サムネイル特徴（thumbnailUrl から Vision API で解析）
   - 色使い・表情・テキスト量

3. 最適な動画尺
   - ジャンル内のバズ動画の尺分布

4. 投稿タイミング
   - 曜日・時間帯の分布

5. タグ戦略
   - 高頻度タグ上位20個
   - 低パフォーマンス動画に多いタグ

6. 説明文パターン
   - 冒頭の定型文・キーワード配置
```

**出力（ジャンルプロファイルJSON）:**

```json
{
  "genre": "VTuber",
  "version": "1.0.0",
  "updatedAt": "2026-05-31",
  "sampleSize": { "hit": 100, "miss": 100 },

  "titlePatterns": {
    "hitKeywords": ["初見", "コラボ", "歌ってみた", "〇〇してみた", "w", "笑"],
    "hitStructures": ["【感情語】+ 行動 + ！", "数字 + 〇〇してみた"],
    "avoidKeywords": ["雑談", "練習", "テスト"],
    "optimalLength": { "min": 20, "max": 35, "unit": "chars" }
  },

  "thumbnailProfile": {
    "dominantColors": ["red", "yellow", "white"],
    "faceExpression": "surprise or joy > neutral",
    "textPresence": "short impact word recommended",
    "hitThumbnailFeatures": ["顔アップ", "感情表現強め", "コントラスト高め"]
  },

  "durationProfile": {
    "hitDistribution": { "under5min": 0.15, "5to15min": 0.55, "over15min": 0.30 },
    "sweetSpot": "8〜12分"
  },

  "postingTime": {
    "bestDays": ["金曜", "土曜"],
    "bestHours": ["20:00", "21:00", "22:00"],
    "timezone": "JST"
  },

  "tagStrategy": {
    "highValueTags": ["VTuber", "Vtuber配信", "にじさんじ", "ホロライブ"],
    "optimalCount": { "min": 10, "max": 20 }
  },

  "descriptionProfile": {
    "firstLinePattern": "動画の核心を1行で",
    "keywordDensity": "タイトルキーワードを説明文前半に2回以上"
  },

  "engagementTriggers": {
    "hitCommonalities": ["コメント誘導あり", "概要欄にタイムスタンプ"],
    "missCommonalities": ["概要欄が空", "タグなし"]
  }
}
```

---

#### ステップ3: Vector DB 格納

各ジャンルプロファイル + シード動画の特徴ベクトルを Vector DB に格納し、診断時の RAG 検索を可能にする。

```
[ジャンルプロファイル JSON]
        ↓ text-embedding-3-small (OpenAI) または
          claude 組み込み埋め込み
        ↓
[Vector DB] ─── Chroma DB (ローカル) または
                Pinecone (クラウド・Phase2後半〜)

インデックス構造:
  namespace: "genre_profiles"
  key: genre_name
  vector: embedding of profile text
  metadata: { genre, version, sampleSize, updatedAt }
```

---

#### ステップ4: 診断時のRAG注入

ユーザーが診断を依頼すると、選択ジャンルのプロファイルをVector DBから取得し、診断プロンプトに注入する。

```
診断プロンプト構造（Phase2）:

[SYSTEM]
あなたはYouTubeコンテンツ診断の専門家です。

[CONTEXT - RAGで注入]
=== {ジャンル名}ジャンルのバズパターン（シード学習済み）===
{genre_profile の主要部分をテキスト化して注入}

タイトルのバズパターン: {titlePatterns.hitKeywords}
最適な動画尺: {durationProfile.sweetSpot}
...

[USER INPUT]
以下の動画を診断してください:
タイトル: {input.title}
説明文: {input.description}
...

[INSTRUCTION]
上記のジャンル固有パターンと比較して、6軸で診断し改善提案を出してください。
スコアはジャンル内相対値で出すこと（汎用基準ではなくVTuber基準で）。
```

---

#### ジャンル別シード収集戦略

| ジャンル | 代表キーワード | 特有の診断軸 |
|---------|-------------|------------|
| **VTuber** | VTuber, Vtuber配信, ホロライブ, にじさんじ | ライバーの感情表現, コラボ効果, 歌枠・ゲーム枠の区別 |
| **切り抜き** | 切り抜き, clip, まとめ | 元動画の知名度依存, タイトルの「ネタバレ」加減, 尺の短さ |
| **音楽** | 歌ってみた, 弾いてみた, オリジナル曲 | 再生回数より高評価率, プレイリスト流入, サビ配置 |
| **実写** | vlog, 日常, ルーティン | 顔出し有無, 話し方のテンポ, カット割りの速さ |
| **ゲーム実況** | ゲーム実況, 初見, 縛りプレイ | ゲームタイトルのトレンド依存, リアクション強度, シリーズもの |

---

#### シード更新スケジュール

```
初回学習: 手動実行（ジャンルあたり2〜4時間）
定期更新: 月1回バッチ（night-batch.js 拡張）
  - 新規シード50件を追加収集
  - プロファイルをマージ更新
  - Vectorインデックスを再構築
```

---

## 5. Phase3: チャンネル専用学習

### 概要

ユーザー自身のYouTubeチャンネルの全過去動画を学習し、**「このチャンネルらしさ」**に基づく診断を行う。Phase2のジャンルプロファイルの上に、個人チャンネルプロファイルをレイヤーとして重ねる設計。

### 例: 白詠チャンネル専用診断

```
白詠チャンネルの過去動画200本を分析した結果:
  - 「歌ってみた」は平均視聴維持率 68%（ジャンル平均 52%）
  - タイトルに「白詠」を入れると既存ファンからのCTRが+20%
  - 動画尺8〜10分がチャンネル内で最も視聴維持率が高い
  - 土曜 20:00 投稿が過去最高再生数上位5本中4本に共通

→ 汎用診断・VTuberシード診断と組み合わせて
  「白詠さんの過去実績ベースのスコア」を算出
```

### チャンネルプロファイル構造

```json
{
  "channelId": "UC_xxxxx",
  "channelName": "白詠チャンネル",
  "genre": "VTuber",
  "learnedAt": "2026-05-31",
  "videoCount": 200,

  "performanceBaseline": {
    "avgViewCount": 15000,
    "avgLikeRate": 0.08,
    "avgRetentionRate": 0.62
  },

  "titlePersonality": {
    "commonWords": ["白詠", "歌ってみた", "ゲーム"],
    "emojiUsage": "high",
    "avgTitleLength": 28
  },

  "contentPattern": {
    "bestDuration": { "min": 8, "max": 10, "unit": "minutes" },
    "bestPostDay": "土曜",
    "bestPostHour": 20,
    "topPerformingCategories": ["歌枠", "ゲーム初見", "コラボ"]
  },

  "thumbnailStyle": {
    "characterColor": "purple-white",
    "textStyle": "bold-jp",
    "layoutPattern": "face-left-text-right"
  },

  "audienceInsight": {
    "commentKeywords": ["かわいい", "歌上手", "癒し"],
    "peakEngagementMinute": 3.5
  }
}
```

### YT Data API 収集フロー

```
1. ユーザーがYouTube OAuth認証
   (または Channel URLを手動入力 → Public APIのみ)

2. チャンネルの全動画リスト取得
   GET /youtube/v3/search?channelId=xxx&type=video&maxResults=50

3. 各動画の詳細メトリクス取得
   GET /youtube/v3/videos?id=xxx&part=statistics,contentDetails

4. Claude API で動画タイトル/説明文を分析
   → チャンネルプロファイルJSON生成

5. Vector DB に格納（namespace: "channel_profiles"）

6. 以降の診断では
   Genre Profile + Channel Profile の両方を RAG注入
```

---

## 6. システム構成図

### Phase1 構成

```
Discord
  └─ !diag コマンド
        ↓
  bot/index.js
        ↓
  bot/utils/diagnostic.js ──── Claude API (Sonnet)
        ↓
  診断結果 JSON
        ↓
  Discord Embed 送信
```

### Phase2 構成

```
Discord / Web UI
  └─ 診断リクエスト + ジャンル選択
        ↓
  bot/utils/diagnostic.js
        ↓
  [RAG検索]                          [AI推論]
  Vector DB (Chroma)                 Claude API (Sonnet)
  └─ genre_profiles/{ジャンル}  →   プロンプト注入 → 診断
        ↑
  [定期更新バッチ]
  YouTube Data API
  └─ シード収集 → Claude抽出 → Vector更新
```

### Phase3 構成

```
Discord / Web UI
  └─ 診断リクエスト
        ↓
  diagnostic.js
        ↓
  Vector DB
  ├─ genre_profiles/{ジャンル}   ─┐
  └─ channel_profiles/{userId}  ─┤→ RAG統合 → Claude API → 診断結果
        ↑
  [チャンネル学習バッチ]
  YouTube Data API (per channel)
  └─ 全動画収集 → Claude分析 → Vector格納
```

### フルシステム構成（Phase3完成形）

```
┌─────────────────────────────────────────────────────────┐
│                    入力レイヤー                           │
│  Discord Bot  │  Web UI (将来)  │  API (将来)           │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│                    診断エンジン                           │
│                  diagnostic.js                           │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ 入力バリデ  │→│  RAG Context │→│  Claude API   │  │
│  │ + 前処理    │  │  組み立て    │  │  (推論)       │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│                   知識ストア                              │
│  ┌─────────────────┐      ┌───────────────────────┐    │
│  │   Vector DB     │      │   JSON プロファイル    │    │
│  │  (Chroma/       │      │   data/profiles/       │    │
│  │   Pinecone)     │      │   genre/{name}.json    │    │
│  │                 │      │   channel/{id}.json    │    │
│  │ genre_profiles  │      └───────────────────────┘    │
│  │ channel_profiles│                                    │
│  └─────────────────┘                                    │
└──────────────────────────────────────────────────────────┘
                       ↑
┌─────────────────────────────────────────────────────────┐
│                   学習パイプライン                        │
│  YouTube Data API → Claude抽出 → Vector格納             │
│  ├─ ジャンルシード収集バッチ（月1回）                    │
│  └─ チャンネル学習バッチ（初回 + ユーザートリガー）      │
└─────────────────────────────────────────────────────────┘
```

---

## 7. データ構造設計

### ディレクトリ構造

```
AI_WORKER/
├── bot/
│   └── utils/
│       ├── diagnostic.js          # 診断エンジン本体
│       ├── seed-collector.js      # YT API シード収集
│       ├── profile-builder.js     # プロファイル生成
│       └── vector-store.js        # Vector DB操作
│
├── data/
│   └── diagnostic/
│       ├── genre/
│       │   ├── VTuber.json        # ジャンルプロファイル
│       │   ├── clip.json
│       │   ├── music.json
│       │   ├── realshot.json
│       │   └── gaming.json
│       ├── channel/
│       │   └── {channelId}.json   # チャンネルプロファイル
│       └── seeds/
│           └── {genre}/
│               ├── hit/           # バズ動画メタデータ
│               └── miss/          # 凡庸動画メタデータ
│
└── vector_db/                     # Chroma DBローカルストレージ
    └── diagnostic/
```

### 診断リクエスト/レスポンス型

```typescript
// 入力
interface DiagnosticRequest {
  title: string;
  description: string;
  tags: string[];
  genre: 'VTuber' | 'clip' | 'music' | 'realshot' | 'gaming' | 'general';
  thumbnailUrl?: string;
  durationSeconds?: number;
  openingScript?: string;
  channelId?: string; // Phase3: チャンネル専用診断を使う場合
  userId: string;     // Discord User ID
}

// 出力
interface DiagnosticResult {
  requestId: string;
  timestamp: string;
  genre: string;
  learningPhase: 'generic' | 'genre-seeded' | 'channel-specific';

  totalScore: number; // 0-100

  scores: {
    ctr: number;            // クリック率予測
    retention: number;      // 視聴維持率予測
    seo: number;            // SEO強度
    emotionalHook: number;  // 感情フック
    postingTiming: number;  // 投稿タイミング
    differentiation: number; // 競合差別化
  };

  improvements: Array<{
    axis: string;
    priority: 'high' | 'medium' | 'low';
    suggestion: string;
    expectedImpact: string; // "CTR +15%予想" など
  }>;

  genreInsight: string;    // ジャンル固有のアドバイス (Phase2以降)
  channelInsight?: string; // チャンネル専用アドバイス (Phase3以降)
}
```

### ジャンルプロファイル型

```typescript
interface GenreProfile {
  genre: string;
  version: string;
  updatedAt: string;
  sampleSize: { hit: number; miss: number };

  titlePatterns: {
    hitKeywords: string[];
    hitStructures: string[];
    avoidKeywords: string[];
    optimalLength: { min: number; max: number; unit: 'chars' };
  };

  thumbnailProfile: {
    dominantColors: string[];
    faceExpression: string;
    textPresence: string;
    hitThumbnailFeatures: string[];
  };

  durationProfile: {
    hitDistribution: Record<string, number>;
    sweetSpot: string;
  };

  postingTime: {
    bestDays: string[];
    bestHours: string[];
    timezone: string;
  };

  tagStrategy: {
    highValueTags: string[];
    optimalCount: { min: number; max: number };
  };
}
```

---

## 8. 学習方法設計

### Phase2 ジャンルシード学習 — 詳細フロー

#### 8.1 シード収集バッチ

```
入力: ジャンル名
  ↓
YouTube Data API で検索
  ├─ hit動画: viewCount/subscriber > 3.0 の動画 × 100件
  └─ miss動画: 同チャンネルで下位パフォーマンスの動画 × 100件
  ↓
各動画のメタデータをJSONに保存
  └─ data/diagnostic/seeds/{genre}/hit/*.json
  └─ data/diagnostic/seeds/{genre}/miss/*.json
  ↓
サムネイルURLリストを生成 → Claude Vision APIで一括解析
  ↓
seeds.jsonにサムネイル特徴を追記
```

#### 8.2 プロファイル生成バッチ

```
入力: seeds/{genre}/ ディレクトリ
  ↓
hit 100件 + miss 100件のテキスト要約を生成
  └─ タイトル・タグ・尺・投稿時刻を構造化テキストに変換
  ↓
Claude API に「差分分析」プロンプトを送信
  └─ バッチ処理: 10件ずつ分割して分析（トークン上限回避）
  ↓
分析結果をジャンルプロファイルJSONにマージ
  └─ data/diagnostic/genre/{name}.json
  ↓
プロファイルテキストを埋め込みベクトル化
  └─ OpenAI embeddings API or ローカルモデル
  ↓
Vector DB に upsert
  └─ namespace: "genre_profiles", key: genre_name
```

#### 8.3 診断時のRAG注入詳細

```
診断リクエスト受信
  ↓
ジャンル特定 → Vector DB検索
  └─ クエリ: ユーザー入力のタイトル + ジャンル名
  └─ 上位k=3件のチャンクを取得
  ↓
プロンプト組み立て:
  [SYSTEM]    : 診断専門家ペルソナ
  [CONTEXT]   : ジャンルプロファイル（RAG取得）
  [EXAMPLES]  : hit動画/miss動画の具体例 2〜3件
  [INPUT]     : ユーザーの動画情報
  [SCHEMA]    : 出力JSONスキーマ指定
  ↓
Claude API 呼び出し → JSON出力強制 (json_mode)
  ↓
スコア計算・整形 → Discord Embed
```

### Phase3 チャンネル学習フロー

```
ユーザーが !learn-channel {channelUrl} を実行
  ↓
YouTube Data API でチャンネル全動画取得（最大500件）
  └─ 公開動画のみ（プライバシー配慮）
  ↓
統計データ計算:
  └─ 動画別パフォーマンス（buzz_ratio）
  └─ チャンネル平均値・標準偏差
  └─ 上位/下位動画の特徴分析
  ↓
Claude API でパターン抽出
  └─ チャンネルプロファイルJSON生成
  ↓
data/diagnostic/channel/{channelId}.json に保存
  ↓
Vector DB に格納 (namespace: "channel_profiles")
  ↓
以降の診断: ジャンルプロファイル + チャンネルプロファイルを両方注入
```

### 学習精度向上サイクル

```
診断結果をユーザーが投稿後に「フィードバック」
  ↓
実際の動画パフォーマンス（投稿1週間後の数値）を収集
  ↓
診断スコアと実績の乖離を測定
  ↓
乖離が大きいパターンをシードデータに追加（強化学習的アプローチ）
  ↓
月次バッチでプロファイル更新
```

---

## 9. MVPとの差分整理

| 項目 | Phase1 (MVP) | Phase2 (ジャンルシード) | Phase3 (チャンネル専用) |
|------|-------------|----------------------|----------------------|
| **診断精度** | 汎用AIの知識のみ | ジャンル実績ベース | チャンネル実績ベース |
| **スコアの根拠** | プロンプト設計 | シード100件×2の統計 | 本人の過去成績 |
| **外部API** | Claude のみ | YouTube Data API追加 | YouTube OAuth追加 |
| **データ保存** | なし（都度生成） | JSON + Vector DB | JSON + Vector DB (拡張) |
| **バッチ処理** | なし | 月1回シード更新 | 初回学習 + 更新 |
| **開発工数** | 1〜2週間 | 1〜2ヶ月 | 2〜4ヶ月 |
| **API コスト/月** | 〜¥500 | 〜¥3,000（収集含む） | 〜¥8,000（チャンネル数依存） |
| **精度向上幅** | ベースライン | +20〜30%推定 | さらに+15〜25%推定 |

### 主要な追加実装（MVP → Phase2）

1. `seed-collector.js` — YouTube Data API 収集バッチ
2. `profile-builder.js` — シード→プロファイル変換
3. `vector-store.js` — ChromaDB操作ラッパー
4. `diagnostic.js` の RAG 拡張（現状は単純プロンプトのみ）
5. `night-batch.js` への月次更新フック追加

### 主要な追加実装（Phase2 → Phase3）

1. YouTube OAuth 認証フロー（Web UI必要）
2. `channel-learner.js` — チャンネル全動画学習バッチ
3. チャンネルプロファイルのVector DB格納
4. 診断プロンプトへのチャンネルコンテキスト追加注入
5. `!learn-channel` コマンド

---

## 10. サブスク化設計

### プランティア設計

```
┌──────────────────────────────────────────────────────────┐
│  FREE（無料・集客用）                                     │
│  ・Phase1 汎用診断 / 月3回まで                           │
│  ・6軸スコア表示                                         │
│  ・改善提案 TOP1のみ                                     │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  CREATOR (月額 ¥980) — Phase2                           │
│  ・ジャンルシード診断（5ジャンル全て）                   │
│  ・月30回まで診断                                        │
│  ・改善提案 TOP3                                         │
│  ・サムネイル画像診断（Claude Vision）                   │
│  ・投稿タイミング最適化                                  │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  PRO (月額 ¥2,980) — Phase2 フル                        │
│  ・CREATOR の全機能                                      │
│  ・月100回まで診断                                       │
│  ・改善提案 全件                                         │
│  ・競合動画との比較分析                                  │
│  ・診断履歴 + トレンド表示                               │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  CHANNEL (月額 ¥5,980〜) — Phase3                       │
│  ・PRO の全機能                                          │
│  ・チャンネル専用学習（1チャンネル）                     │
│  ・「自分らしさ」スコア                                  │
│  ・過去動画との整合性チェック                            │
│  ・ファン層への適合度                                    │
│  ・月200回まで診断                                       │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│  AGENCY (月額 ¥19,800〜) — Phase3 複数チャンネル        │
│  ・CHANNEL × 最大10チャンネル                           │
│  ・事務所・MCN向け                                       │
│  ・チャンネル間比較・統合ダッシュボード                  │
│  ・API アクセス（外部ツール連携）                        │
└──────────────────────────────────────────────────────────┘
```

### サブスク化しやすいポイント

| 機能 | 課金フック | 理由 |
|------|-----------|------|
| **診断回数制限** | FREE→CREATOR | 毎週投稿者は月4〜8回使うため即壁にあたる |
| **ジャンル診断の解除** | FREE→CREATOR | 精度差が体感できると自然にアップグレード |
| **チャンネル学習** | PRO→CHANNEL | 「自分のデータを学習」は明確な価値差別化 |
| **サムネイル診断** | 無料版では非対応 | 画像処理コストをユーザーに転嫁 |
| **API アクセス** | AGENCYのみ | 外部ツール・自動化需要 |
| **複数チャンネル** | AGENCYのみ | 事務所・マネージャー需要を取り込む |

### 収益試算（月間）

```
FREE:    500ユーザー × ¥0     = ¥0
CREATOR: 100ユーザー × ¥980   = ¥98,000
PRO:      30ユーザー × ¥2,980 = ¥89,400
CHANNEL:  10ユーザー × ¥5,980 = ¥59,800
AGENCY:    2契約   × ¥19,800 = ¥39,600

合計: ¥286,800/月
APIコスト概算: ¥20,000〜¥50,000/月
```

---

## 付録: 実装優先順位

### MVP最速リリースルート（Phase1）

```
Week 1:
  [ ] diagnostic.js の基本実装（Claude API呼び出し）
  [ ] !diag コマンドの追加（index.js）
  [ ] 6軸スコアのEmbed出力

Week 2:
  [ ] サムネイル画像入力対応（Claude Vision）
  [ ] ジャンル選択UI
  [ ] 診断結果の保存（JSON）
```

### Phase2 実装ルート

```
Month 1:
  [ ] seed-collector.js（YouTube Data API）
  [ ] VTuberジャンルのシード100件収集
  [ ] profile-builder.js（Claude抽出）

Month 2:
  [ ] ChromaDB セットアップ
  [ ] vector-store.js
  [ ] RAG注入の diagnostic.js 拡張
  [ ] 全5ジャンルへの展開

Month 3:
  [ ] 月次更新バッチ（night-batch.js拡張）
  [ ] フィードバック収集機能
  [ ] プラン管理（FREE/CREATOR判定）
```

---

*本ドキュメントは AI_WORKER 診断AI長期設計書 v1.0*
*次回更新タイミング: Phase1 MVP 完成時*
