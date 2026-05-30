# YouTube投稿前診断AI MVP仕様書 — Phase 2-3 シード学習設計

- **作成日:** 2026-05-31
- **対象フェーズ:** Phase 2（ジャンルシード学習） / Phase 3（チャンネル専用学習）
- **前提ドキュメント:** `docs/youtube-ai-mvp-phase1.md`（Phase1 MVP仕様書）
- **アーキテクチャ全体:** `docs/youtube-diagnostic-ai-architecture.md`

---

## 目次

1. [Phase2: ジャンルシード学習](#1-phase2-ジャンルシード学習)
2. [Phase3: チャンネル専用学習](#2-phase3-チャンネル専用学習)
3. [データ構造設計](#3-データ構造設計)
4. [将来拡張](#4-将来拡張)

---

## 1. Phase2: ジャンルシード学習

### 1.1 概要

各ジャンルのYouTube上の「バズった動画（hit）」と「伸びなかった動画（miss）」のメタデータを収集・分析し、**ジャンル固有の判定プロファイル**を構築する。このプロファイルを診断プロンプトのコンテキストとして注入することで、Phase1の汎用診断より精度の高い判定を実現する。

### 1.2 学習パイプライン全体像

```
[1. シード収集]         [2. 特徴抽出]          [3. プロファイル構築]      [4. 診断注入]
──────────────         ──────────────         ──────────────────        ──────────────
YouTube Data API  →    Claude API で           Vector DB に              RAG で関連
でジャンル別の          メタデータから           埋め込みベクトル           プロファイルを
上位/下位動画を         パターンを抽出 →        として保存               取得してプロンプト
収集                   構造化JSON化                                     に注入
```

### 1.3 ステップ1 — シード動画収集

**収集基準:** ジャンルごとに以下の条件で各100件ずつ収集する。

| ラベル | 条件 |
|--------|------|
| **hit（バズ動画）** | `viewCount / channelSubscribers > 3.0` |
| **miss（凡庸動画）** | `viewCount / channelSubscribers < 0.5` |

**収集メタデータ（YouTube Data API v3）:**

```json
{
  "videoId": "string",
  "title": "string",
  "description": "string (first 500 chars)",
  "tags": ["string"],
  "thumbnailUrl": "string",
  "duration": "ISO8601",
  "publishedAt": "datetime",
  "channelSubscribers": 0,
  "viewCount": 0,
  "likeCount": 0,
  "commentCount": 0,
  "buzz_ratio": "viewCount / channelSubscribers",
  "category": "VTuber | clip | music | realshot | gaming",
  "seed_label": "hit | miss"
}
```

**VTuberジャンルの収集クエリ例:**

```
hit動画:
  keyword: "VTuber" + ("初見" OR "コラボ" OR "歌ってみた")
  filter: publishedBefore=30日前, viewCount>100k, orderBy=viewCount

miss動画:
  同チャンネルの平均再生数以下の動画
  同ジャンル・同期間でview数が低いもの
```

### 1.4 ステップ2 — パターン特徴抽出

収集したシード動画を Claude API に渡し、ジャンル固有のパターンを構造化して抽出する。

**抽出プロンプト構造（VTuberジャンルの例）:**

```
以下は VTuber ジャンルの「バズった動画」100件と「伸びなかった動画」100件の
メタデータです。両者を比較して以下の特徴を構造化JSONで抽出してください:

1. タイトルパターン
   - バズタイトルに共通する語彙・数字・記号
   - 避けるべきタイトルの特徴

2. サムネイル特徴
   - 色使い・表情・テキスト量（thumbnailUrl → Claude Vision API）

3. 最適な動画尺
   - ジャンル内バズ動画の尺分布

4. 投稿タイミング
   - 曜日・時間帯の分布

5. タグ戦略
   - 高頻度タグ上位20個 / 低パフォーマンス動画に多いタグ

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
    "hitKeywords": ["初見", "コラボ", "歌ってみた", "〇〇してみた"],
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

### 1.5 ステップ3 — Vector DB 格納

```
[ジャンルプロファイル JSON]
        ↓ テキスト化 + 埋め込みベクトル生成
          (OpenAI text-embedding-3-small または Claude 埋め込み)
        ↓
[Vector DB]
  ├─ ローカル: Chroma DB（Phase2前半）
  └─ クラウド: Pinecone（Phase2後半〜スケール時）

インデックス構造:
  namespace : "genre_profiles"
  key       : genre_name
  vector    : embedding of profile text
  metadata  : { genre, version, sampleSize, updatedAt }
```

### 1.6 ステップ4 — 診断時RAG注入

```
診断リクエスト受信
  ↓
ジャンル特定 → Vector DB検索
  └─ クエリ: ユーザー入力のタイトル + ジャンル名
  └─ 上位 k=3 件のチャンクを取得
  ↓
プロンプト組み立て:
  [SYSTEM]    : 診断専門家ペルソナ
  [CONTEXT]   : ジャンルプロファイル（RAG取得）
  [EXAMPLES]  : hit/miss動画の具体例 2〜3件
  [INPUT]     : ユーザーの動画情報
  [SCHEMA]    : 出力JSONスキーマ指定
  ↓
Claude API 呼び出し（JSON出力モード）
  ↓
スコア計算・整形 → Discord Embed 送信
```

**プロンプト注入テンプレート（Phase2）:**

```
[SYSTEM]
あなたはYouTubeコンテンツ診断の専門家です。

[CONTEXT - RAGで注入]
=== {ジャンル名} ジャンルのバズパターン（シード100件×2 学習済み）===
タイトルのバズパターン: {titlePatterns.hitKeywords}
避けるべきキーワード: {titlePatterns.avoidKeywords}
最適な動画尺: {durationProfile.sweetSpot}
最適投稿タイミング: {postingTime.bestDays} {postingTime.bestHours}
...

[USER INPUT]
以下の動画を診断してください:
タイトル: {input.title}
説明文: {input.description}
...

[INSTRUCTION]
上記のジャンル固有パターンと比較して、6軸で診断し改善提案を出してください。
スコアはジャンル内相対値で出すこと（汎用基準ではなく{ジャンル}基準で）。
```

### 1.7 ジャンル別シード収集戦略

| ジャンル | 代表キーワード | 特有の診断軸 |
|---------|-------------|------------|
| **VTuber** | VTuber, Vtuber配信, ホロライブ, にじさんじ | ライバーの感情表現, コラボ効果, 歌枠・ゲーム枠の区別 |
| **切り抜き** | 切り抜き, clip, まとめ | 元動画の知名度依存, タイトルの「ネタバレ」加減, 尺の短さ |
| **音楽** | 歌ってみた, 弾いてみた, オリジナル曲 | 再生数より高評価率, プレイリスト流入, サビ配置 |
| **実写** | vlog, 日常, ルーティン | 顔出し有無, 話し方のテンポ, カット割りの速さ |
| **ゲーム実況** | ゲーム実況, 初見, 縛りプレイ | タイトルのトレンド依存, リアクション強度, シリーズもの |

### 1.8 シード更新スケジュール

```
初回学習  : 手動実行（ジャンルあたり 2〜4 時間）
定期更新  : 月1回バッチ（night-batch.js 拡張）
  - 新規シード 50件を追加収集
  - プロファイルをマージ更新
  - Vector インデックスを再構築
学習精度向上サイクル:
  - 診断後にユーザーが投稿実績をフィードバック
  - 診断スコアと実績の乖離を測定
  - 乖離が大きいパターンをシードデータに追加（強化学習的）
```

---

## 2. Phase3: チャンネル専用学習

### 2.1 概要

ユーザー自身のYouTubeチャンネルの全過去動画を学習し、**「このチャンネルらしさ」**に基づく診断を行う。Phase2のジャンルプロファイルの上に、個人チャンネルプロファイルをレイヤーとして重ねる設計。

```
診断スコア = ジャンルプロファイル（Phase2） ＋ チャンネルプロファイル（Phase3）
```

### 2.2 チャンネル学習フロー

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
  └─ チャンネルプロファイル JSON 生成
  ↓
data/diagnostic/channel/{channelId}.json に保存
  ↓
Vector DB に格納（namespace: "channel_profiles"）
  ↓
以降の診断: ジャンルプロファイル + チャンネルプロファイルを両方注入
```

**YT Data API収集エンドポイント:**

```
全動画リスト:
  GET /youtube/v3/search?channelId=xxx&type=video&maxResults=50

各動画の詳細:
  GET /youtube/v3/videos?id=xxx&part=statistics,contentDetails
```

### 2.3 チャンネルプロファイル構造

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

### 2.4 チャンネル専用診断の出力例

```
📊 YouTube投稿前診断レポート（チャンネル専用）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 総合スコア: 81/100

📌 CTR予測（ジャンル比）:  ★★★★☆ (78点)
📌 チャンネル適合度:        ★★★★★ (92点)  ← Phase3追加軸
📌 過去実績との整合性:      ★★★★☆ (84点)  ← Phase3追加軸

💡 チャンネル固有アドバイス
- 「白詠」をタイトルに入れると既存ファンのCTRが+20%（過去実績）
- この動画尺（9分）は貴チャンネルの視聴維持率が最も高い範囲
- 土曜20時投稿は過去TOP5動画中4本が共通する最適タイミング

🎯 診断精度: チャンネル専用（過去200本学習）
```

### 2.5 認証方式

| 方式 | 取得データ | 難易度 | 推奨フェーズ |
|------|-----------|--------|------------|
| YouTube OAuth 2.0 | 非公開含む全統計 | 高 | Phase3後半 |
| Channel URL 手動入力（Public APIのみ） | 公開動画のみ | 低 | Phase3前半 |

---

## 3. データ構造設計

### 3.1 ディレクトリ構造

```
AI_WORKER/
├── bot/
│   └── utils/
│       ├── diagnostic.js          # 診断エンジン本体（Phase1から拡張）
│       ├── seed-collector.js      # YT API シード収集（Phase2新規）
│       ├── profile-builder.js     # プロファイル生成（Phase2新規）
│       └── vector-store.js        # Vector DB操作（Phase2新規）
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
│       │   └── {channelId}.json   # チャンネルプロファイル（Phase3）
│       └── seeds/
│           └── {genre}/
│               ├── hit/           # バズ動画メタデータ
│               └── miss/          # 凡庸動画メタデータ
│
└── vector_db/                     # Chroma DB ローカルストレージ
    └── diagnostic/
        ├── genre_profiles/
        └── channel_profiles/      # Phase3追加
```

### 3.2 診断リクエスト / レスポンス型

```typescript
interface DiagnosticRequest {
  title: string;
  description: string;
  tags: string[];
  genre: 'VTuber' | 'clip' | 'music' | 'realshot' | 'gaming' | 'general';
  thumbnailUrl?: string;
  durationSeconds?: number;
  openingScript?: string;
  channelId?: string;  // Phase3: チャンネル専用診断を使う場合
  userId: string;      // Discord User ID
}

interface DiagnosticResult {
  requestId: string;
  timestamp: string;
  genre: string;
  learningPhase: 'generic' | 'genre-seeded' | 'channel-specific';

  totalScore: number;  // 0-100

  scores: {
    ctr: number;             // クリック率予測
    retention: number;       // 視聴維持率予測
    seo: number;             // SEO強度
    emotionalHook: number;   // 感情フック
    postingTiming: number;   // 投稿タイミング
    differentiation: number; // 競合差別化
  };

  improvements: Array<{
    axis: string;
    priority: 'high' | 'medium' | 'low';
    suggestion: string;
    expectedImpact: string;
  }>;

  genreInsight: string;     // ジャンル固有アドバイス（Phase2以降）
  channelInsight?: string;  // チャンネル専用アドバイス（Phase3以降）
}
```

### 3.3 ジャンルプロファイル型

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

  descriptionProfile: {
    firstLinePattern: string;
    keywordDensity: string;
  };

  engagementTriggers: {
    hitCommonalities: string[];
    missCommonalities: string[];
  };
}
```

### 3.4 チャンネルプロファイル型

```typescript
interface ChannelProfile {
  channelId: string;
  channelName: string;
  genre: string;
  learnedAt: string;
  videoCount: number;

  performanceBaseline: {
    avgViewCount: number;
    avgLikeRate: number;
    avgRetentionRate: number;
  };

  titlePersonality: {
    commonWords: string[];
    emojiUsage: 'none' | 'low' | 'medium' | 'high';
    avgTitleLength: number;
  };

  contentPattern: {
    bestDuration: { min: number; max: number; unit: 'minutes' };
    bestPostDay: string;
    bestPostHour: number;
    topPerformingCategories: string[];
  };

  thumbnailStyle: {
    characterColor: string;
    textStyle: string;
    layoutPattern: string;
  };

  audienceInsight: {
    commentKeywords: string[];
    peakEngagementMinute: number;
  };
}
```

### 3.5 Phase比較

| 項目 | Phase1 (MVP) | Phase2 (ジャンルシード) | Phase3 (チャンネル専用) |
|------|-------------|----------------------|----------------------|
| **診断精度** | 汎用AIの知識のみ | ジャンル実績ベース | チャンネル実績ベース |
| **スコアの根拠** | プロンプト設計 | シード100件×2の統計 | 本人の過去成績 |
| **外部API** | Claude のみ | YouTube Data API追加 | YouTube OAuth追加 |
| **データ保存** | なし（都度生成） | JSON + Vector DB | JSON + Vector DB（拡張） |
| **バッチ処理** | なし | 月1回シード更新 | 初回学習 + 更新 |
| **開発工数** | 1〜2週間 | 1〜2ヶ月 | 2〜4ヶ月 |
| **APIコスト/月** | 〜¥500 | 〜¥3,000 | 〜¥8,000（チャンネル数依存） |
| **精度向上幅** | ベースライン | +20〜30%推定 | さらに+15〜25%推定 |

---

## 4. 将来拡張

### 4.1 短期拡張（Phase2 完成後）

| 拡張項目 | 内容 | 優先度 |
|---------|------|--------|
| **サムネイル A/Bテスト提案** | 2案生成してCTR予測を比較 | 高 |
| **競合動画比較** | 同ジャンル上位動画との差分分析 | 中 |
| **診断履歴トレンド** | ユーザーごとのスコア推移グラフ | 中 |
| **フィードバックループ** | 投稿後実績 → シードデータ自動強化 | 高 |

### 4.2 中期拡張（Phase3 完成後）

| 拡張項目 | 内容 |
|---------|------|
| **Web UI** | Discord依存を脱却したスタンドアロン診断UI |
| **API公開** | 外部ツール・自動投稿フロー連携向けREST API |
| **多チャンネル管理** | 事務所・MCN向け複数チャンネルダッシュボード |
| **投稿タイミング予測** | トレンド変動を加味したリアルタイム最適時刻提案 |
| **動画スクリプト診断** | 冒頭30秒の台本・字幕テキストから離脱リスク予測 |

### 4.3 長期拡張（フルプロダクト化）

| 拡張項目 | 内容 | 技術要素 |
|---------|------|---------|
| **Fine-tuning** | チャンネル専用の軽量モデル学習 | LoRA / QLoRA |
| **動画ファイル解析** | サムネ以外の映像・音声品質チェック | 動画エンコーダ |
| **投稿後トラッキング** | YouTube Analytics API 連携でCTR実績を自動収集 | OAuth + cron |
| **トレンド検知** | 急上昇ジャンル・キーワードのリアルタイム監視 | YouTube Trending API |
| **多言語対応** | 英語・韓国語タイトル最適化 | 言語別シードDB |

### 4.4 Vector DB スケールアップ戦略

```
Phase2前半: Chroma DB（ローカル）
  └─ コスト¥0、5ジャンル × 200件 = 1,000ベクトル程度
  └─ 開発・検証フェーズに最適

Phase2後半〜Phase3: Pinecone（クラウド）
  └─ 複数ユーザーの同時利用に対応
  └─ チャンネルプロファイルが増加してもスケール
  └─ Starter: 無料 / 有料: $70〜/月

将来: 専用Vector DB + キャッシュ層
  └─ 頻繁に参照されるジャンルプロファイルをインメモリキャッシュ
  └─ チャンネルプロファイルは Redis TTL 付きキャッシュ
```

### 4.5 収益モデルとの接続

| フェーズ | プラン | 月額 |
|---------|-------|------|
| Phase1完成 | FREE（月3回まで） | ¥0 |
| Phase2完成 | CREATOR（ジャンル診断 / 月30回） | ¥980 |
| Phase2フル | PRO（競合比較・履歴 / 月100回） | ¥2,980 |
| Phase3完成 | CHANNEL（チャンネル専用 / 月200回） | ¥5,980〜 |
| Phase3複数 | AGENCY（最大10チャンネル） | ¥19,800〜 |

---

*本ドキュメントは `docs/youtube-diagnostic-ai-architecture.md` の Section 4〜5・7〜8 を Phase 2-3 フォーカスで再構成したもの。*  
*次回更新タイミング: Phase2 実装着手時*
