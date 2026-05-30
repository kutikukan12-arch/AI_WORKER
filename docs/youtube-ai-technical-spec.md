# YouTube投稿前診断AI — MVP 技術仕様書

- **作成日:** 2026/5/31
- **バージョン:** v1.0
- **対象:** MVP（Phase1）技術仕様に限定
- **参照元:** [MVP仕様書](./youtube-diagnostic-ai-mvp-spec.md) / [長期アーキテクチャ](./youtube-diagnostic-ai-architecture.md)

---

## 目次

1. [API設計](#1-api設計)
2. [DB設計](#2-db設計)
3. [画面設計](#3-画面設計)
4. [スコア設計](#4-スコア設計)

---

## 1. API設計

### 1.1 内部モジュール API（Discord Bot 内）

MVPは外部公開 API を持たない。Discord Bot 内部モジュール呼び出しとして設計する。

#### `bot/utils/diagnostic.js` — 診断エンジン

```javascript
// エントリーポイント
async function runDiagnostic(request: DiagnosticRequest): Promise<DiagnosticResult>

// プロンプト構築（Phase2以降: genreProfile / channelProfile を注入）
function buildDiagnosticPrompt(
  request: DiagnosticRequest,
  genreProfile?: GenreProfile,   // Phase2〜
  channelProfile?: ChannelProfile // Phase3〜
): string

// Claude API 呼び出し（Prompt Caching 対応）
async function callClaudeAPI(
  prompt: string,
  thumbnailBase64?: string
): Promise<DiagnosticResult>

// Discord Embed 生成
function formatDiagnosticEmbed(result: DiagnosticResult): EmbedBuilder

// 診断履歴の JSON 保存
async function saveDiagnosticHistory(
  request: DiagnosticRequest,
  result: DiagnosticResult
): Promise<void>
```

#### `bot/index.js` — Discord コマンドハンドラ

```javascript
// !diag コマンド処理フロー
async function handleDiagCommand(message, args) {
  const { title, description, tags, genre } = parseDiagArgs(args);
  validateDiagInput({ title, genre });
  const thumbnailBase64 = await extractThumbnail(message.attachments);
  const result = await runDiagnostic({
    title, description, tags, genre, thumbnailBase64,
    userId: message.author.id
  });
  const embed = formatDiagnosticEmbed(result);
  await message.reply({ embeds: [embed] });
}
```

### 1.2 型定義

```typescript
type GenreType = 'VTuber' | 'clip' | 'music' | 'realshot' | 'gaming' | 'general';

interface DiagnosticRequest {
  title: string;               // 必須・最大100文字
  genre: GenreType;            // 必須
  description?: string;        // 最大500文字
  tags?: string[];             // 最大20個
  thumbnailBase64?: string;    // PNG/JPG・最大5MB
  durationSeconds?: number;
  openingScript?: string;      // 冒頭30秒の台本
  scheduledAt?: string;        // ISO8601
  userId: string;              // Discord User ID
  channelId?: string;          // Phase3〜
}

interface DiagnosticResult {
  requestId: string;           // "diag_{YYYYMMDD}_{HHmmss}_{hash}"
  timestamp: string;           // ISO8601 JST
  genre: GenreType;
  learningPhase: 'generic' | 'genre-seeded' | 'channel-specific';

  totalScore: number;          // 0〜100（6軸加重平均）
  rank: RankType;

  scores: {
    ctr: number;               // CTR適性
    retention: number;         // 視聴維持適性
    seo: number;               // SEO強度
    emotionalHook: number;     // 感情フック
    postingTiming: number;     // 投稿タイミング
    differentiation: number;   // 競合差別化
  };

  improvements: Array<{
    axis: keyof DiagnosticResult['scores'];
    priority: 'high' | 'medium' | 'low';
    suggestion: string;
    expectedEffect: string;    // "〇〇スコアの改善が見込める"
  }>;

  summary: string;
  genreInsight?: string;       // Phase2〜
  channelInsight?: string;     // Phase3〜
}

type RankType = 'S' | 'A+' | 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D';
```

### 1.3 Claude API プロンプト設計

**SYSTEM（Prompt Caching 適用対象）**

```
あなたはYouTubeコンテンツの投稿前診断の専門家です。
動画投稿者から提供された情報をもとに、6つの診断軸でスコアリングし、
改善提案を行います。

制約:
- スコアは「投稿前の状態の最適度」を示す診断スコアです
- 実際の再生回数を断定する数値予測は行いません
- 「〇万回再生される」「バズる」という断言は禁止
- 改善提案は具体的・実行可能なものに限定
- expectedEffect は必ず「〇〇スコアの改善が見込める」形式

出力は必ず以下のJSONスキーマに従ってください:
{ requestId, timestamp, genre, learningPhase, totalScore, rank,
  scores: { ctr, retention, seo, emotionalHook, postingTiming, differentiation },
  improvements: [{ axis, priority, suggestion, expectedEffect }],
  summary }
```

**USER（診断リクエスト毎）**

```
以下の動画情報を診断してください:

タイトル: {title}
ジャンル: {genre}
説明文: {description|"未入力"}
タグ: {tags.join(",")|"未入力"}
動画尺: {durationSeconds|"未入力"}
冒頭台本: {openingScript|"未入力"}
投稿予定日時: {scheduledAt|"未定"}
```

**Phase2 以降: RAG Context 注入（CONTEXT ブロック追加）**

```
[CONTEXT - ジャンルシードプロファイル]
=== {genre}ジャンルの診断プロファイル（シード学習済み v{version}）===

タイトルのバズパターン: {titlePatterns.hitKeywords}
避けるべきキーワード: {titlePatterns.avoidKeywords}
最適タイトル文字数: {optimalLength.min}〜{optimalLength.max}文字
最適な動画尺: {durationProfile.sweetSpot}
投稿タイミング: {postingTime.bestDays} {postingTime.bestHours}
高評価タグ: {tagStrategy.highValueTags}

スコアは {genre} ジャンル内の相対基準で算出すること。
```

### 1.4 コマンド仕様

| コマンド | 形式 | 説明 |
|---------|------|------|
| 基本診断 | `!diag [タイトル] / [説明文] / [タグ]` | テキストのみ診断 |
| ジャンル指定 | `!diag --genre VTuber [タイトル] / ...` | ジャンル明示 |
| サムネイル付き | `!diag [テキスト]` + 画像添付 | Vision API 使用 |
| 履歴表示 | `!diag-history` | 直近5件の診断結果 |
| チャンネル学習 | `!learn-channel {channelUrl}` | Phase3〜 |

### 1.5 エラーハンドリング

| エラー種別 | 対応 |
|----------|------|
| タイトル未入力 | エラーメッセージ返却・処理中断 |
| Claude API タイムアウト | 1回リトライ→失敗時エラーメッセージ |
| 不正 JSON 返却 | 診断失敗エラー（システムクラッシュなし） |
| 不正ジャンル入力 | `general` にフォールバック |
| 画像解析失敗 | サムネイルなしとして診断継続 |

---

## 2. DB設計

### 2.1 Phase1（MVP）: ファイルベース設計

Phase1 はリレーショナル DB を使わず、ローカル JSON ファイルで管理する。

#### ディレクトリ構造

```
data/
└── diagnostic/
    ├── history/
    │   └── {YYYY-MM}/
    │       └── {userId}_{timestamp}.json   # 診断1件1ファイル
    └── stats.json                          # 集計統計（任意）
```

#### 診断履歴 JSON スキーマ

```json
{
  "requestId": "diag_20260531_143000_abc123",
  "userId": "discord_user_id",
  "timestamp": "2026-05-31T14:30:00+09:00",
  "genre": "VTuber",
  "learningPhase": "generic",

  "input": {
    "title": "【初見】ゲーム名に挑戦してみた！",
    "description": "VTuberがゲームを初めてプレイします",
    "tags": ["VTuber", "ゲーム実況", "初見"],
    "durationSeconds": 600,
    "hasThumbnail": true,
    "openingScript": null,
    "scheduledAt": null
  },

  "output": {
    "totalScore": 72,
    "rank": "B+",
    "scores": {
      "ctr": 65,
      "retention": 78,
      "seo": 60,
      "emotionalHook": 80,
      "postingTiming": 55,
      "differentiation": 70
    },
    "improvements": [
      {
        "axis": "ctr",
        "priority": "high",
        "suggestion": "タイトルに数字を入れると注目度が上がりやすい",
        "expectedEffect": "CTR適性スコアの改善が見込める"
      }
    ],
    "summary": "感情フックが強く視聴維持適性は高い状態。SEOとCTRの改善が優先。"
  },

  "meta": {
    "claudeModel": "claude-sonnet-4-6",
    "promptVersion": "v1.0",
    "processingMs": 3200
  }
}
```

### 2.2 Phase2 以降: Vector DB 拡張設計（Chroma DB）

```
vector_db/
└── diagnostic/
    ├── genre_profiles/     # ジャンルプロファイルの埋め込み
    │   ├── VTuber
    │   ├── clip
    │   ├── music
    │   ├── realshot
    │   └── gaming
    └── channel_profiles/   # Phase3: チャンネルプロファイルの埋め込み
        └── {channelId}
```

#### Chroma コレクション設計

| コレクション | namespace | document | metadata |
|------------|-----------|----------|----------|
| `genre_profiles` | `genre_{ジャンル名}` | プロファイルのテキスト表現 | `{ genre, version, updatedAt, sampleSize }` |
| `channel_profiles` (Phase3) | `channel_{channelId}` | チャンネルプロファイルのテキスト表現 | `{ channelId, channelName, genre, videoCount, learnedAt }` |

#### ジャンルプロファイル JSON スキーマ（Phase2〜）

```json
{
  "genre": "VTuber",
  "version": "1.0.0",
  "updatedAt": "2026-05-31",
  "sampleSize": { "hit": 100, "miss": 100 },

  "titlePatterns": {
    "hitKeywords": ["初見", "コラボ", "歌ってみた"],
    "avoidKeywords": ["雑談", "練習", "テスト"],
    "optimalLength": { "min": 20, "max": 35, "unit": "chars" }
  },

  "thumbnailProfile": {
    "dominantColors": ["red", "yellow", "white"],
    "hitThumbnailFeatures": ["顔アップ", "感情表現強め", "コントラスト高め"]
  },

  "durationProfile": { "sweetSpot": "8〜12分" },

  "postingTime": {
    "bestDays": ["金曜", "土曜"],
    "bestHours": ["20:00", "21:00", "22:00"],
    "timezone": "JST"
  },

  "tagStrategy": {
    "highValueTags": ["VTuber", "Vtuber配信"],
    "optimalCount": { "min": 10, "max": 20 }
  }
}
```

### 2.3 Phase3 以降: ユーザー管理 DB（SQLite）

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,       -- Discord User ID
  plan        TEXT DEFAULT 'free',    -- 'free'|'creator'|'pro'|'channel'|'agency'
  diag_count  INTEGER DEFAULT 0,      -- 当月の診断使用回数
  reset_at    TEXT,                   -- 月次リセット日時
  channel_id  TEXT,                   -- 紐付けチャンネルID（Phase3）
  created_at  TEXT,
  updated_at  TEXT
);

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  price_jpy     INTEGER,
  diag_limit    INTEGER,              -- 月間診断上限（-1=無制限）
  genre_seed    INTEGER DEFAULT 0,    -- ジャンルシード診断可否
  channel_learn INTEGER DEFAULT 0,   -- チャンネル学習可否
  thumbnail     INTEGER DEFAULT 0    -- サムネイル診断可否
);
```

---

## 3. 画面設計

Discord Bot インターフェース（MVP）の画面設計。

### 3.1 コマンド入力フロー

```
① ユーザーが !diag コマンドを送信
   ┌─────────────────────────────────────────────────┐
   │ !diag 【初見】ゲーム名に挑戦してみた！          │
   │ / VTuberがゲームを初めてプレイします             │
   │ / VTuber,ゲーム実況,初見                        │
   │ [サムネイル.png を添付]                          │
   └─────────────────────────────────────────────────┘

② Bot が Processing メッセージを返す
   ┌─────────────────────────────────────────────────┐
   │ 🔍 診断中です... (約10〜20秒)                    │
   └─────────────────────────────────────────────────┘

③ 診断完了後、Embed で結果を返す
```

### 3.2 診断結果 Embed（メイン）

```
╔══════════════════════════════════════════════════╗
║  📊 YouTube 投稿前診断レポート                    ║
║  ジャンル: VTuber（汎用診断）                    ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  🏆 総合診断スコア: 72点  [B+]                   ║
║  「あと少しで伸びる状態」                         ║
║                                                  ║
╠══════════════════════════════════════════════════╣
║  📌 6軸スコア詳細                                ║
║                                                  ║
║  CTR適性          ★★★☆☆  65点                  ║
║  視聴維持適性      ★★★★☆  78点                  ║
║  SEO強度          ★★★☆☆  60点  ⚠️             ║
║  感情フック        ★★★★☆  80点  ✅             ║
║  投稿タイミング    ★★☆☆☆  55点  ⚠️             ║
║  競合差別化        ★★★☆☆  70点                  ║
║                                                  ║
╠══════════════════════════════════════════════════╣
║  ⚡ 改善提案 TOP3                                ║
║                                                  ║
║  1. [CTR・高] タイトルに数字を入れると注目度が   ║
║     上がりやすい（例: 「5分で〇〇」）             ║
║     → CTR適性スコアの改善が見込める              ║
║                                                  ║
║  2. [SEO・高] 説明文の冒頭2行にタイトルと同じ   ║
║     キーワードを含めると検索流入が増えやすい      ║
║     → SEO強度スコアの改善が見込める             ║
║                                                  ║
║  3. [タイミング・中] このジャンルは土曜21〜23時   ║
║     に視聴者が集中しやすい                       ║
║     → 投稿タイミングスコアの改善が見込める       ║
║                                                  ║
╠══════════════════════════════════════════════════╣
║  💬 総評                                         ║
║  感情フックが強く視聴維持適性は高い状態。         ║
║  SEOとCTR改善で総合スコアが大きく向上できる。    ║
║                                                  ║
║  ⚠️ このスコアは投稿前の最適度を示します。        ║
║     実際の再生回数を予測するものではありません。  ║
╚══════════════════════════════════════════════════╝
[🔄 再診断]  [📋 履歴]
```

### 3.3 ジャンル選択 UI（ボタン形式）

```
ジャンルを選択してください:
┌──────────┐ ┌──────────┐ ┌──────────┐
│  VTuber  │ │  切り抜き │ │   音楽   │
└──────────┘ └──────────┘ └──────────┘
┌──────────┐ ┌──────────┐ ┌──────────┐
│   実写   │ │ゲーム実況 │ │  その他  │
└──────────┘ └──────────┘ └──────────┘
```

### 3.4 診断履歴 Embed（`!diag-history`）

```
╔══════════════════════════════════════════════════╗
║  📋 診断履歴（直近5件）                          ║
╠══════════════════════════════════════════════════╣
║  2026-05-31 14:30  VTuber  72点  B+              ║
║  「【初見】ゲーム名に挑戦してみた！」             ║
╠══════════════════════════════════════════════════╣
║  2026-05-30 20:15  音楽    85点  A+              ║
║  「オリジナル曲「〇〇」MV公開」                  ║
╚══════════════════════════════════════════════════╝
```

### 3.5 エラー表示

```
╔══════════════════════════════════════════════════╗
║  ❌ 診断エラー                                   ║
║                                                  ║
║  タイトルが入力されていません。                  ║
║  使い方: !diag [タイトル] / [説明文] / [タグ]   ║
╚══════════════════════════════════════════════════╝
```

### 3.6 Phase2 以降の追加フィールド（ジャンル固有インサイト）

```
╠══════════════════════════════════════════════════╣
║  🎯 ジャンル固有インサイト（VTuber シード診断） ║
║  シードデータ: hit100件 + miss100件 学習済み     ║
║                                                  ║
║  このジャンルのバズタイトルは「コラボ」「初見」  ║
║  を含む割合が高い。現タイトルにはどちらも含まれ ║
║  ていないため、タイトル改善の余地がある。        ║
╚══════════════════════════════════════════════════╝
```

### 3.7 画面遷移フロー

```
[!diag 入力]
     │
     ▼
[入力バリデーション]──失敗──▶[3.5 エラー表示]
     │成功
     ▼
[ジャンル未指定？]──YES──▶[3.3 ジャンル選択 UI]──選択──▶[診断処理]
     │NO
     ▼
[診断処理（Claude API 呼び出し）]
     │
     ▼
[3.2 診断結果 Embed 送信]
     │
     ├──[🔄 再診断] ──▶ [!diag 入力] に戻る
     └──[📋 履歴]   ──▶ [3.4 履歴 Embed 表示]
```

---

## 4. スコア設計

### 4.1 診断6軸の定義

| 軸（キー） | 表示名 | 診断の観点 |
|-----------|-------|---------|
| `ctr` | CTR適性スコア | タイトル・サムネがクリックされやすい構成か（キーワード配置・感情語・数字の活用度） |
| `retention` | 視聴維持適性スコア | 冒頭・中盤・終盤の離脱リスクの低さ（冒頭30秒の引き込み・内容の凝集度） |
| `seo` | SEO強度スコア | 検索からの流入しやすさ（タイトル・説明文・タグのキーワード最適度） |
| `emotionalHook` | 感情フックスコア | 視聴者の感情を動かせるか（好奇心・驚き・共感・笑いの引き金の有無） |
| `postingTiming` | 投稿タイミングスコア | 投稿予定日時の適切さ（ジャンル別視聴者活動時間帯との一致度） |
| `differentiation` | 競合差別化スコア | 類似コンテンツとの差別化（タイトル・内容の独自性・ニッチ性） |

> 各軸は 0〜100 点。「このスコアが高いほど投稿前の状態として最適化されている」という診断スコアであり、実際の視聴回数を予測するものではない。

### 4.2 総合スコア算出

**Phase1（汎用診断）: 等重み平均**

```
totalScore = (ctr + retention + seo + emotionalHook + postingTiming + differentiation) / 6
```

**Phase2 以降（ジャンルシード診断）: ジャンル別加重平均**

| ジャンル | ctr | retention | seo | emotionalHook | postingTiming | differentiation |
|---------|-----|-----------|-----|---------------|---------------|-----------------|
| VTuber | 20% | 25% | 15% | 25% | 10% | 5% |
| 切り抜き | 30% | 20% | 15% | 20% | 10% | 5% |
| 音楽 | 20% | 30% | 10% | 25% | 10% | 5% |
| 実写 | 20% | 25% | 15% | 20% | 10% | 10% |
| ゲーム実況 | 25% | 20% | 15% | 25% | 10% | 5% |

### 4.3 ランク換算表

| 総合スコア | ランク | 表示テキスト |
|-----------|-------|------------|
| 90〜100 | S | 投稿準備 完璧 |
| 80〜89 | A+ | 投稿準備 優秀 |
| 70〜79 | A | 投稿準備 良好 |
| 60〜69 | B+ | あと少しで伸びる |
| 50〜59 | B | 改善で大きく変わる |
| 40〜49 | C+ | 要改善（CTR/SEO） |
| 30〜39 | C | 要改善（複数軸） |
| 0〜29 | D | 大幅な見直しを推奨 |

### 4.4 星表示（Discord Embed 用）

```
score >= 80 → ★★★★★
score >= 60 → ★★★★☆
score >= 40 → ★★★☆☆
score >= 20 → ★★☆☆☆
score <  20 → ★☆☆☆☆
```

### 4.5 改善提案の優先度判定

```javascript
// axis score → priority
function getPriority(score) {
  if (score < 50) return 'high';
  if (score < 70) return 'medium';
  return 'low';
}
```

改善提案は `priority: high → medium → low` の順にソートし、TOP3 を Embed に表示する。

### 4.6 スコア算出の設計方針

| 設計方針 | 詳細 |
|---------|------|
| **汎用基準** | Phase1 では「YouTube全体のベストプラクティス」との比較でスコアを算出 |
| **ジャンル相対基準** | Phase2 以降ではジャンル内相対値（VTuber として良いか、等）で算出 |
| **チャンネル実績基準** | Phase3 以降では本人の過去成績との比較で追加スコアを算出 |
| **断言禁止** | 「〇万回再生される」「バズる」等の断定表現は Claude API に禁止プロンプトで抑制 |
| **投稿前最適度の明示** | 全 Embed 下部に「このスコアは投稿前の最適度を示します。実際の再生回数を予測するものではありません。」を必須表示 |

### 4.7 コスト管理目標

| 指標 | 目標値 |
|-----|-------|
| 1診断あたりの Claude API コスト | ¥5 以下 |
| テキストのみ診断の応答時間 | 15秒以内 |
| サムネイル付き診断の応答時間 | 30秒以内 |
| Prompt Caching 適用 | SYSTEM プロンプトをキャッシュ対象に設定 |

---

*本ドキュメントは AI_WORKER YouTube投稿前診断AI MVP 技術仕様書 v1.0*
*参照: [MVP仕様書](./youtube-diagnostic-ai-mvp-spec.md) / [長期アーキテクチャ](./youtube-diagnostic-ai-architecture.md)*
