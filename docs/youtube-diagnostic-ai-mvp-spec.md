# YouTube投稿前診断AI — MVP仕様書

- **作成日:** 2026/5/31
- **バージョン:** v2.0（2026-06-03 CEO/PM方針で正式改訂・診断時LLM廃止／既存MLモデル再利用を確定）
- **参照アーキテクチャ:** [長期アーキテクチャ設計書](./youtube-diagnostic-ai-architecture.md)
- **対象プロダクト:** YouTube Pre-Upload Diagnostic AI
- **想定ユーザー:** VTuber・ゲーム実況者・切り抜き師・音楽投稿者・実写系YouTuber
- **β版の正典（このv2.0が優先）:** [β版MVP確定仕様](./youtube-diagnostic-ai-beta-mvp.md) / [宮城Lead向け開発要件](./youtube-diagnostic-ai-dev-requirements.md)

---

## ⚠️ v2.0 改訂宣言（最重要・旧前提を無効化）

> **本商品は「診断時に LLM(Claude/OpenAI) API を呼ぶ」設計を廃止し、「YouTube無料APIで集めた実データで学習した軽量モデルをローカル推論する」設計へ変更する。**

コトノハ初商品の方針（初期コスト最小・無料公開で需要確認・収益が出てからAPIコスト追加・無料大量利用での赤字化を避ける）に整合させる変更である。

| ❌ 旧前提（v1.0・廃止） | ✅ 新前提（v2.0・正） |
|---|---|
| 診断時に Claude/OpenAI API を常時利用 | **診断時はAPI呼び出しゼロ**（保存済みモデルのローカル推論のみ・1診断¥0） |
| LLMが改善案を生成 | **既存 `youtube-predictor`/`youtube-feature-extractor` の特徴量寄与から決定論生成** |
| サムネ解析に Claude Vision（MVP内） | MVPでは**画像診断なし**（コスト発生のため有料/将来へ） |
| `diagnostic.js` を新規実装 | **新規実装不要。既存 `youtube-predictor.js` の `diagnosePrePub()`/`buildDiagnosisSummary()` を正典エンジンに** |
| 再生数予測・レンジ表示 | **再生数は一切表示しない**（保証もレンジも禁止） |

> 本文中の「Claude API プロンプト設計」「callClaudeAPI()」「Claude Vision」「Claude APIコスト」等の記述は **v2.0 では無効**。実装の正典は冒頭リンクの2ドキュメントを参照。視聴予測AI資産（collector/feature-extractor/predictor/model.json）は**破棄せず診断エンジンとして再利用**する。

---

## 重要設計方針

> **このシステムは「視聴回数予測」ではなく「投稿前診断スコア」を提供する**

視聴回数は投稿後の外部要因（アルゴリズム変動・トレンド・競合動画）に大きく左右されるため、断定的な数値予測は行わない。本システムは「投稿前の状態がどれだけ最適化されているか」をスコア化し、改善の方向性を示すことに特化する。

| やること | やらないこと |
|---------|------------|
| 投稿前コンテンツの品質スコアリング | 再生回数の断定数値予測 |
| ジャンル内相対的な診断 | 「この動画は○万回再生される」という断言 |
| 改善提案と期待効果の方向感提示 | 投稿後のパフォーマンス保証 |

---

## 目次

1. [Phase1: 汎用診断AI（MVP）](#1-phase1-汎用診断ai-mvp)
2. [Phase2: ジャンルシード学習](#2-phase2-ジャンルシード学習)
3. [Phase3: チャンネル専用学習](#3-phase3-チャンネル専用学習)
4. [MVPで作るもの](#4-mvpで作るもの)
5. [MVPで作らないもの](#5-mvpで作らないもの)
6. [DB設計](#6-db設計)
7. [API設計](#7-api設計)
8. [画面設計](#8-画面設計)
9. [サブスクプラン](#9-サブスクプラン)
10. [完成条件](#10-完成条件)

---

## 1. Phase1: 汎用診断AI（MVP）

### 概要

**既存の `youtube-predictor` / `youtube-feature-extractor` をエンジンとして再利用**し、入力されたメタデータをもとに6軸診断スコアを算出する。YouTube Data API・Claude API・外部LLMを診断時に一切呼ばず、ローカルMLモデル＋ルールベースで即時応答する。シードデータで訓練済みのモデルがある場合はその出力を補助情報として活用する。

### 診断6軸

| 軸 | スコア内容 | 診断の観点 |
|----|---------|---------|
| **CTR適性スコア** | タイトル・サムネがクリックされやすい構成かどうか | キーワード配置・感情語・数字の活用度 |
| **視聴維持適性スコア** | 冒頭・中盤・終盤の離脱リスクの低さ | 冒頭30秒の引き込み・内容の凝集度 |
| **SEO強度スコア** | 検索からの流入のしやすさ | タイトル・説明文・タグのキーワード最適度 |
| **感情フックスコア** | 視聴者の感情を動かせるか | 好奇心・驚き・共感・笑いの引き金の有無 |
| **投稿タイミングスコア** | 投稿予定日時の適切さ | ジャンル別の視聴者活動時間帯との一致度 |
| **競合差別化スコア** | 類似コンテンツとの差別化がされているか | タイトル・内容の独自性・ニッチ性 |

> **スコアの解釈:** 各軸は 0〜100 点。「このスコアが高いほど投稿前の状態として最適化されている」という診断スコアであり、実際の視聴回数を予測するものではない。

### 入力仕様

```
【必須入力】
・タイトル（文字列、最大100文字）
・ジャンル（VTuber / 切り抜き / 音楽 / 実写 / ゲーム実況 / その他）

【推奨入力】
・説明文（文字列、最大500文字）
・タグ（カンマ区切り、最大20個）

【任意入力】
・サムネイル画像（PNG/JPG、最大5MB）
・動画の尺（分・秒）
・冒頭30秒の台本・字幕テキスト
・投稿予定日時
```

### 出力仕様

```json
{
  "requestId": "diag_20260531_001",
  "timestamp": "2026-05-31T10:00:00+09:00",
  "genre": "VTuber",
  "learningPhase": "generic",

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
      "suggestion": "タイトルに数字を入れると注目度が上がりやすい（例: 「5分でわかる...」）",
      "expectedEffect": "CTR適性スコアの改善が見込める"
    },
    {
      "axis": "seo",
      "priority": "high",
      "suggestion": "説明文の冒頭2行にタイトルと同じキーワードを含めると検索流入が増えやすい",
      "expectedEffect": "SEO強度スコアの改善が見込める"
    },
    {
      "axis": "postingTiming",
      "priority": "medium",
      "suggestion": "このジャンルは土曜21〜23時に視聴者が集中しやすい",
      "expectedEffect": "投稿タイミングスコアの改善が見込める"
    }
  ],

  "summary": "全体的に感情フックが強く視聴維持適性は高い。SEOとCTR改善で総合スコアが大きく向上できる状態。"
}
```

### Phase1 技術スタック

| コンポーネント | 採用技術 | 理由 |
|------------|--------|------|
| インターフェース | Discord Bot（既存 AI_WORKER 基盤） | 追加実装コスト最小 |
| AI推論 | youtube-predictor（既存MLモデル）+ ルールベース | 外部API不要・即時応答・コスト¥0 |
| サムネイル解析 | Phase2以降（MVP対象外） | テキスト診断を優先 |
| データ保存 | ローカル JSON ファイル | MVP段階は永続化 DB 不要 |
| 実行環境 | Node.js（既存環境） | 既存コードベースとの統一 |

---

## 2. Phase2: ジャンルシード学習

### 概要

各ジャンルの「バズった動画」と「伸びなかった動画」のメタデータを YouTube Data API で収集・分析し、ジャンル固有の判定プロファイルを構築する。このプロファイルを診断時のコンテキストとして RAG 注入することで、Phase1 の汎用診断よりジャンル特性に即した診断を実現する。

### 対象ジャンル（5種）

| ジャンル | 固有の診断観点 | シード収集キーワード例 |
|---------|-------------|------------------|
| **VTuber** | コラボ効果・歌枠/ゲーム枠の区別・ライバー感情表現 | VTuber, ホロライブ, にじさんじ, 歌ってみた |
| **切り抜き** | 元動画への依存度・タイトルのネタバレ加減・短尺最適化 | 切り抜き, clip, まとめ |
| **音楽** | 高評価率・プレイリスト流入・サビ配置の最適性 | 歌ってみた, 弾いてみた, オリジナル曲 |
| **実写** | 顔出し有無・話し方テンポ・カット割りの速さ | vlog, 日常, ルーティン |
| **ゲーム実況** | ゲームタイトルのトレンド依存・リアクション強度・シリーズもの | ゲーム実況, 初見, 縛りプレイ |

### 学習パイプライン概要

```
[1. シード収集]       →  [2. パターン抽出]     →  [3. プロファイル格納]  →  [4. 診断時RAG注入]
YouTube Data API        youtube-predictor で        youtube-model-pre.json     診断時参照
ジャンル別              hit/miss 特徴量学習           (ローカル JSON)             ルール補正
hit: 100件              ロジスティック回帰
miss: 100件             (投稿前15次元モデル)
```

### ジャンルプロファイル構造（抜粋）

```json
{
  "genre": "VTuber",
  "version": "1.0.0",
  "updatedAt": "2026-05-31",
  "sampleSize": { "hit": 100, "miss": 100 },
  "titlePatterns": {
    "hitKeywords": ["初見", "コラボ", "歌ってみた", "してみた"],
    "avoidKeywords": ["雑談", "練習", "テスト"],
    "optimalLength": { "min": 20, "max": 35, "unit": "chars" }
  },
  "durationProfile": { "sweetSpot": "8〜12分" },
  "postingTime": { "bestDays": ["金曜", "土曜"], "bestHours": ["20:00", "21:00", "22:00"] },
  "tagStrategy": { "highValueTags": ["VTuber", "Vtuber配信"], "optimalCount": { "min": 10, "max": 20 } }
}
```

### Phase2 技術スタック追加分

| コンポーネント | 採用技術 |
|------------|--------|
| シード収集 | YouTube Data API v3 |
| ベクトルDB | Chroma DB（ローカル） |
| 埋め込み生成 | OpenAI Embeddings API または Claude 組み込み |
| 更新バッチ | night-batch.js 拡張（月1回） |

---

## 3. Phase3: チャンネル専用学習

### 概要

ユーザー自身の YouTube チャンネルの過去動画データを収集・分析し、「そのチャンネルらしさ」に基づく診断を実現する。Phase2 のジャンルプロファイルの上に、個人チャンネルプロファイルをレイヤーとして重ねる設計。

### 診断の差別化

```
Phase1 診断（汎用）:   「一般的に良いコンテンツかどうか」
Phase2 診断（ジャンル）: 「VTuberとして良いコンテンツかどうか」
Phase3 診断（チャンネル）: 「あなたのチャンネルのファンが喜ぶコンテンツかどうか」
```

### チャンネルプロファイル構造（抜粋）

```json
{
  "channelId": "UC_xxxxx",
  "channelName": "例: 白詠チャンネル",
  "genre": "VTuber",
  "videoCount": 200,
  "performanceBaseline": {
    "avgViewCount": 15000,
    "avgLikeRate": 0.08,
    "avgRetentionRate": 0.62
  },
  "contentPattern": {
    "bestDuration": { "min": 8, "max": 10, "unit": "minutes" },
    "bestPostDay": "土曜",
    "bestPostHour": 20,
    "topPerformingCategories": ["歌枠", "ゲーム初見", "コラボ"]
  }
}
```

### Phase3 追加機能

- `!learn-channel {channelUrl}` コマンドでチャンネル学習開始
- 公開動画のみ対象（最大500件）
- 学習完了後: 診断結果に「チャンネル適合スコア」と「チャンネル専用アドバイス」が追加

### Phase3 技術スタック追加分

| コンポーネント | 採用技術 |
|------------|--------|
| チャンネルデータ取得 | YouTube Data API v3（公開APIのみ） |
| チャンネルプロファイル保存 | JSON + Chroma DB（namespace: "channel_profiles"） |
| チャンネル学習バッチ | channel-learner.js（新規実装） |

---

## 4. MVPで作るもの

MVP = Phase1（汎用診断AI）の実装のみ。

### 実装対象

```
[必須実装]
✅ youtube-diagnostic.js — 診断エンジン本体（既存モデル再利用）
   ├─ diagnose(input)          : メタデータ → 6軸スコア算出（LLM不使用）
   ├─ _scoreCTR()              : タイトル特徴量からCTR適性を算出
   ├─ _scoreRetention()        : 動画尺・説明文から視聴維持を算出
   ├─ _scoreSEO()              : タグ数・説明文からSEO強度を算出
   ├─ _scoreEmotion()          : タイトル感情要素から感情フックを算出
   ├─ _scoreTiming()           : 投稿時刻cyclic特徴量から時間帯適性を算出
   ├─ _scoreUniqueness()       : タイトル多様性・タグ密度から差別化を算出
   └─ _buildImprovements()     : 弱点軸から改善提案を生成

✅ index.js の !youtube diagnose サブコマンド追加
   └─ _parseYtKwargs()再利用 → diagnose() 呼び出し

✅ Discord テキスト出力
   ├─ 総合スコア + ランク表示
   ├─ 6軸スコア（絵文字バー + 数値）
   └─ 改善提案 TOP3（弱点軸から生成）

[MVP対象外]
❌ サムネイル画像診断（Phase2以降）
❌ ジャンル選択ボタンUI（テキスト入力で代替）
❌ 診断履歴保存（Phase2以降）
```

### コマンド仕様

```
既存 !youtube predict の診断拡張サブコマンド:
!youtube diagnose title="タイトル" genre=vtuber tags="タグ1,タグ2" sec=600 subs=5000

タイトルのみ（最小入力）:
!youtube diagnose title="【初見】ゲーム名に挑戦してみた！"

ジャンル指定:
!youtube diagnose title="..." genre=vtuber tags="..." subs=10000

注意:
- 再生回数レンジは表示しない（診断スコアのみ）
- YouTube Data API・Claude API は診断時に呼ばない
- 全スコアはローカル計算（オフライン動作）
```

### MVP実装スケジュール

```
Phase1 MVP（実装済み）:
  [✅] youtube-diagnostic.js — 6軸診断エンジン（LLM不使用）
  [✅] !youtube diagnose サブコマンド追加
  [✅] 6軸スコア + 改善提案 Discord テキスト出力

Phase2（予定）:
  [ ] ジャンルプロファイル反映（genre-specific補正）
  [ ] サムネイル診断（画像解析）
  [ ] 診断履歴保存・再表示
```

---

## 5. MVPで作らないもの

### 明示的に除外するもの

| 除外対象 | 理由 | 対応Phase |
|---------|------|---------|
| **YouTube Data API 連携** | シードデータ収集はMVP後の工数 | Phase2 |
| **Vector DB / RAG** | ChromaDB導入はPhase2以降 | Phase2 |
| **ジャンルシードプロファイル** | データ収集・構築工数が大きい | Phase2 |
| **チャンネル専用学習** | OAuthフロー含む大規模実装 | Phase3 |
| **Web UI** | Discord Botで代替可能 | Phase3以降 |
| **サブスクリプション管理** | 決済基盤は別タスク | Phase2以降 |
| **月次更新バッチ** | night-batch.js拡張は後回し | Phase2 |
| **競合動画との比較分析** | YouTube Data API 必須 | Phase2以降 |
| **診断履歴のトレンド表示** | Phase1では保存のみ | Phase2以降 |
| **APIアクセス（外部連携）** | AGENCY向け機能 | Phase3以降 |
| **再生回数の断定予測** | 設計方針として永久除外 | — |

### スコープ外の境界線

```
MVP の境界:
  ┌──────────────────────────────────┐
  │  Claude API + Discord Bot        │
  │  テキスト入力 + サムネイル添付    │
  │  6軸診断スコア + 改善提案        │
  │  JSON 保存（ローカル）           │
  └──────────────────────────────────┘

MVP 外:
  ・外部DB（SQLite / PostgreSQL / Chroma）
  ・YouTube API（全種）
  ・課金・プラン管理
  ・Web UI / 外部公開 API
```

---

## 6. DB設計

### MVP（Phase1）: ファイルベース設計

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

### Phase2 以降: Vector DB 拡張設計

Phase2 では Chroma DB をローカルに追加導入する。

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

```
コレクション名: genre_profiles
  - namespace: "genre_{ジャンル名}"
  - document: ジャンルプロファイルのテキスト表現
  - metadata: { genre, version, updatedAt, sampleSize }

コレクション名: channel_profiles  ← Phase3
  - namespace: "channel_{channelId}"
  - document: チャンネルプロファイルのテキスト表現
  - metadata: { channelId, channelName, genre, videoCount, learnedAt }
```

### Phase3 以降: ユーザー管理 DB（SQLite）

サブスク管理が必要になるタイミングで SQLite を導入する。

```sql
-- users テーブル
CREATE TABLE users (
  id          TEXT PRIMARY KEY,       -- Discord User ID
  plan        TEXT DEFAULT 'free',    -- 'free' | 'creator' | 'pro' | 'channel' | 'agency'
  diag_count  INTEGER DEFAULT 0,      -- 当月の診断使用回数
  reset_at    TEXT,                   -- 月次リセット日時
  channel_id  TEXT,                   -- 紐付けチャンネルID（Phase3）
  created_at  TEXT,
  updated_at  TEXT
);

-- plans テーブル
CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  price_jpy     INTEGER,
  diag_limit    INTEGER,              -- 月間診断上限（-1=無制限）
  genre_seed    INTEGER DEFAULT 0,   -- ジャンルシード診断可否
  channel_learn INTEGER DEFAULT 0,   -- チャンネル学習可否
  thumbnail     INTEGER DEFAULT 0    -- サムネイル診断可否
);
```

---

## 7. API設計

### 内部モジュール API（MVP）

MVP は外部公開 API を持たない。Discord Bot 内部のモジュール呼び出しとして設計する。

#### `diagnostic.js` — 診断エンジン

```javascript
/**
 * YouTube投稿前診断を実行する
 * @param {DiagnosticRequest} request - 診断リクエスト
 * @returns {Promise<DiagnosticResult>} 診断結果
 */
async function runDiagnostic(request) { ... }

/**
 * 診断プロンプトを構築する
 * @param {DiagnosticRequest} request
 * @param {GenreProfile|null} genreProfile - Phase2以降で注入
 * @param {ChannelProfile|null} channelProfile - Phase3以降で注入
 * @returns {string} プロンプト文字列
 */
function buildDiagnosticPrompt(request, genreProfile = null, channelProfile = null) { ... }

/**
 * Claude API を呼び出す（Prompt Caching 対応）
 * @param {string} prompt
 * @param {string|null} thumbnailBase64
 * @returns {Promise<DiagnosticResult>}
 */
async function callClaudeAPI(prompt, thumbnailBase64 = null) { ... }

/**
 * Discord Embed 用にフォーマットする
 * @param {DiagnosticResult} result
 * @returns {EmbedBuilder}
 */
function formatDiagnosticEmbed(result) { ... }

/**
 * 診断結果をJSONファイルに保存する
 * @param {DiagnosticRequest} request
 * @param {DiagnosticResult} result
 */
async function saveDiagnosticHistory(request, result) { ... }
```

#### `index.js` — Discord コマンドハンドラ

```javascript
// !diag コマンドの処理フロー
async function handleDiagCommand(message, args) {
  // 1. 入力パース
  const { title, description, tags, genre } = parseDiagArgs(args);

  // 2. 入力バリデーション
  validateDiagInput({ title, genre });

  // 3. サムネイル取得（添付ファイルがある場合）
  const thumbnailBase64 = await extractThumbnail(message.attachments);

  // 4. 診断実行
  const result = await runDiagnostic({ title, description, tags, genre, thumbnailBase64, userId: message.author.id });

  // 5. Discord Embed 送信
  const embed = formatDiagnosticEmbed(result);
  await message.reply({ embeds: [embed] });
}
```

#### 型定義

```typescript
interface DiagnosticRequest {
  title: string;                    // 必須
  genre: GenreType;                 // 必須
  description?: string;
  tags?: string[];
  thumbnailBase64?: string;
  durationSeconds?: number;
  openingScript?: string;
  scheduledAt?: string;             // ISO8601
  userId: string;                   // Discord User ID
  // Phase2以降
  channelId?: string;
}

type GenreType = 'VTuber' | 'clip' | 'music' | 'realshot' | 'gaming' | 'general';

interface DiagnosticResult {
  requestId: string;
  timestamp: string;
  genre: GenreType;
  learningPhase: 'generic' | 'genre-seeded' | 'channel-specific';

  totalScore: number;   // 0-100
  rank: 'S' | 'A+' | 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D';

  scores: {
    ctr: number;
    retention: number;
    seo: number;
    emotionalHook: number;
    postingTiming: number;
    differentiation: number;
  };

  improvements: Array<{
    axis: keyof DiagnosticResult['scores'];
    priority: 'high' | 'medium' | 'low';
    suggestion: string;
    expectedEffect: string;
  }>;

  summary: string;
  genreInsight?: string;    // Phase2以降
  channelInsight?: string;  // Phase3以降
}
```

### スコアランク換算表

| 総合スコア | ランク | 表示 |
|-----------|-------|------|
| 90〜100 | S | 🏆 投稿準備 完璧 |
| 80〜89 | A+ | ⭐ 投稿準備 優秀 |
| 70〜79 | A | ✅ 投稿準備 良好 |
| 60〜69 | B+ | 📈 あと少しで伸びる |
| 50〜59 | B | 🔧 改善で大きく変わる |
| 40〜49 | C+ | ⚠️ 要改善（CTR/SEO） |
| 30〜39 | C | ⚠️ 要改善（複数軸） |
| 0〜29 | D | 🔴 大幅な見直しを推奨 |

### Claude API プロンプト設計（MVP）

```
[SYSTEM]
あなたはYouTubeコンテンツの投稿前診断の専門家です。
動画投稿者から提供された情報をもとに、6つの診断軸でスコアリングし、
改善提案を行います。

重要な制約:
- スコアは「投稿前の状態の最適度」を示す診断スコアです
- 実際の再生回数を断定する数値予測は行いません
- 「〇万回再生される」「バズる」という断言は禁止
- 改善提案は具体的・実行可能なものに限定すること
- スコアはジャンルの一般的なベストプラクティスとの比較で算出すること

出力は必ず以下のJSONスキーマに従ってください:
{出力JSONスキーマ}

[USER]
以下の動画情報を診断してください:

タイトル: {title}
ジャンル: {genre}
説明文: {description}
タグ: {tags}
動画尺: {duration}
冒頭台本: {openingScript}
投稿予定日時: {scheduledAt}
```

### Phase2 以降の拡張: RAG Context 注入

```
[SYSTEM] (同上)

[CONTEXT - ジャンルシードプロファイル]
=== {genre}ジャンルの診断プロファイル（シード学習済み v{version}）===
このプロファイルは実際のYouTube動画データから抽出されたパターンです。

タイトルの傾向:
  ・バズりやすいキーワード: {titlePatterns.hitKeywords}
  ・避けるべきキーワード: {titlePatterns.avoidKeywords}
  ・最適なタイトル文字数: {optimalLength.min}〜{optimalLength.max}文字

最適な動画尺: {durationProfile.sweetSpot}
投稿タイミング: {postingTime.bestDays} {postingTime.bestHours}
高評価タグ: {tagStrategy.highValueTags}

スコアは汎用基準ではなく {genre} ジャンル内の相対基準で算出すること。

[USER] (同上)
```

---

## 8. 画面設計

Discord Bot インターフェース（MVP）の画面設計を示す。

### 8.1 コマンド入力フロー

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

### 8.2 診断結果 Embed（メイン）

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

### 8.3 ジャンル選択 UI（ボタン形式）

```
ジャンルを選択してください:
┌──────────┐ ┌──────────┐ ┌──────────┐
│  VTuber  │ │  切り抜き │ │   音楽   │
└──────────┘ └──────────┘ └──────────┘
┌──────────┐ ┌──────────┐ ┌──────────┐
│   実写   │ │ゲーム実況 │ │  その他  │
└──────────┘ └──────────┘ └──────────┘
```

### 8.4 診断履歴 Embed（`!diag-history`）

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

### 8.5 エラー表示

```
╔══════════════════════════════════════════════════╗
║  ❌ 診断エラー                                   ║
║                                                  ║
║  タイトルが入力されていません。                  ║
║  使い方: !diag [タイトル] / [説明文] / [タグ]   ║
╚══════════════════════════════════════════════════╝
```

### 8.6 Phase2 以降の Embed 追加フィールド

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

---

## 9. サブスクプラン

### プラン一覧

| プラン | 月額 | 対応Phase | 診断回数/月 | 主な特典 |
|-------|------|---------|-----------|---------|
| **FREE** | ¥0 | Phase1 | 3回 | 6軸スコア・改善提案TOP1 |
| **CREATOR** | ¥980 | Phase2 | 30回 | ジャンルシード診断・改善提案TOP3・サムネイル診断 |
| **PRO** | ¥2,980 | Phase2フル | 100回 | 全改善提案・競合比較・診断履歴トレンド |
| **CHANNEL** | ¥5,980〜 | Phase3 | 200回 | チャンネル専用学習・チャンネル適合スコア |
| **AGENCY** | ¥19,800〜 | Phase3複数 | 無制限 | 複数チャンネル・統合ダッシュボード・API連携 |

### プラン詳細

#### FREE（無料）— Phase1 相当

```
対象: 体験・ライトユーザー
月間診断回数: 3回
利用可能機能:
  ✅ 6軸診断スコア（汎用AIのみ）
  ✅ 改善提案 TOP1
  ✅ ランク表示
  ❌ ジャンルシード診断
  ❌ サムネイル診断
  ❌ 診断履歴トレンド

課金フック: 週1回投稿者は3回/月の制限にすぐ達する
```

#### CREATOR（¥980/月）— Phase2 必要

```
対象: 定期投稿している個人クリエイター
月間診断回数: 30回
利用可能機能:
  ✅ FREEの全機能
  ✅ ジャンルシード診断（5ジャンル）
  ✅ 改善提案 TOP3
  ✅ サムネイル画像診断（Claude Vision）
  ✅ 投稿タイミング最適化アドバイス
  ❌ 競合比較分析
  ❌ チャンネル専用学習

課金フック: ジャンル診断の精度差が体感できると自然にアップグレード
```

#### PRO（¥2,980/月）— Phase2フル

```
対象: 本格的に伸ばしたいクリエイター
月間診断回数: 100回
利用可能機能:
  ✅ CREATORの全機能
  ✅ 改善提案 全件表示
  ✅ 競合動画との比較分析
  ✅ 診断履歴 + 月次トレンド表示
  ❌ チャンネル専用学習

課金フック: 「自分の診断データの蓄積」という継続価値
```

#### CHANNEL（¥5,980〜/月）— Phase3 必要

```
対象: チャンネル特性を活かしたい中堅〜人気クリエイター
月間診断回数: 200回
利用可能機能:
  ✅ PROの全機能
  ✅ チャンネル専用学習（1チャンネル）
  ✅ チャンネル適合スコア
  ✅ 「自分のファンが喜ぶ内容か」の診断
  ✅ 過去動画との整合性チェック

課金フック: 「自分のデータを学習」は明確な価値差別化
```

#### AGENCY（¥19,800〜/月）— Phase3 複数チャンネル

```
対象: 事務所・MCN・マネージャー
月間診断回数: 無制限
利用可能機能:
  ✅ CHANNELの全機能 × 最大10チャンネル
  ✅ チャンネル間比較・統合ダッシュボード
  ✅ API アクセス（外部ツール連携）

課金フック: 事務所・マネージャー需要を取り込む
```

### サブスク移行ロードマップ

```
Phase1 MVP（現在）:
  └─ 全ユーザー FREE 扱い（回数制限なし）
       ↓ Phase1完成後 → FREE上限を3回/月に設定

Phase2 リリース時:
  └─ CREATOR プラン（¥980）解放
       ↓ ジャンルシード診断の精度差で自然にアップグレード

Phase2フル完成時:
  └─ PRO プラン（¥2,980）解放

Phase3 リリース時:
  └─ CHANNEL / AGENCY プラン解放
```

### 収益試算（Phase2以降 安定期）

```
FREE:    500ユーザー × ¥0     =    ¥0
CREATOR: 100ユーザー × ¥980   =  ¥98,000
PRO:      30ユーザー × ¥2,980 =  ¥89,400
CHANNEL:  10ユーザー × ¥5,980 =  ¥59,800
AGENCY:    2契約   × ¥19,800 =  ¥39,600
                               ───────────
合計:                          ¥286,800/月
APIコスト概算:              ¥20,000〜¥50,000/月
```

---

## 10. 完成条件

### MVP（Phase1）完成条件

以下をすべて満たした時点で Phase1 完成と判定する。

#### 機能要件チェックリスト

```
[基本動作]
  [ ] !diag コマンドが Discord で受け付けられる
  [ ] タイトル・説明文・タグの3フィールド入力を正しくパースできる
  [ ] ジャンル選択UIが動作する（ボタンまたはセレクトメニュー）
  [ ] youtube-diagnostic.js が診断結果を返せる（API呼び出しなし）
  [ ] 診断結果を Discord Embed 形式で返信できる

[スコアリング]
  [ ] 6軸スコアが 0〜100 の範囲で算出される
  [ ] 総合スコア（6軸の加重平均）が正しく計算される
  [ ] ランク（S〜D）が総合スコアから正しく判定される
  [ ] 改善提案が priority 順（high → medium → low）で TOP3 返される

[入力バリデーション]
  [ ] タイトル未入力時にエラーメッセージが返る
  [ ] タイトルが100文字超過時に警告またはトリムされる
  [ ] 不正なジャンル入力時に「その他」にフォールバックされる

[サムネイル対応]
  [ ] 画像添付付きの !diag メッセージでサムネイル診断が動作する
  [ ] 画像なしの場合は「サムネイルなし」として診断できる

[データ保存]
  [ ] 診断実行ごとに data/diagnostic/history/ に JSON が保存される
  [ ] !diag-history コマンドで直近5件の履歴が表示される

[設計方針の遵守]
  [ ] 診断結果に「〇万回再生される」「バズる」等の断言がない（再生数レンジ表示禁止）
  [ ] 全改善提案の expectedEffect が「〇〇スコアの改善が見込める」という表現になっている
  [ ] Embed 下部に「このスコアは投稿前の最適度を示します。実際の再生回数を予測するものではありません。」の注記が表示される
```

#### 非機能要件チェックリスト

```
[パフォーマンス]
  [ ] 診断完了まで30秒以内（通常10〜20秒）
  [ ] テキストのみ入力の場合15秒以内
  [ ] タイムアウト時に適切なエラーメッセージが表示される

[信頼性]
  [ ] 外部API障害時も診断が動作する（ローカル計算のみのため障害なし）

[コスト管理]
  [ ] 1診断あたりの外部APIコスト ¥0（ローカルMLモデルのみ使用）
```

#### 完成判定テストケース

```
テストケース1: 基本診断（テキストのみ）
  入力: タイトル="【初見】ゲーム名に挑戦！" / 説明文あり / タグ3個 / ジャンル=ゲーム実況
  期待: 6軸スコア + 改善提案TOP3が Embed で返る

テストケース2: サムネイル付き診断
  入力: テキストケース1 + PNG画像添付
  期待: サムネイルに対するコメントが診断結果に含まれる

テストケース3: タイトルのみ入力
  入力: タイトルのみ（説明文・タグなし）
  期待: 診断完了（説明文なしとして処理される）

テストケース4: タイトル未入力
  入力: !diag のみ
  期待: エラーメッセージ「タイトルが入力されていません」が返る

テストケース5: 断言表現の排除確認
  確認: レスポンスに「〇万回再生」「バズる」等の断言がない
  確認: Embed下部に免責注記が表示されている
```

### Phase2 完成条件（参考）

```
[ ] VTuberジャンルのシードデータ hit/miss 各100件が収集されている
[ ] 全5ジャンルのプロファイルJSONが生成されている
[ ] Chroma DB にジャンルプロファイルが格納されている
[ ] RAG注入により、Phase1より具体的なジャンル固有アドバイスが出力される
[ ] FREE/CREATOR プラン判定ロジックが動作する
[ ] 月次シード更新バッチが動作する
```

### Phase3 完成条件（参考）

```
[ ] !learn-channel コマンドでチャンネル学習が実行できる
[ ] チャンネルプロファイルが Vector DB に格納される
[ ] 診断結果にチャンネル適合スコアが追加される
[ ] CHANNEL プランのユーザーのみチャンネル診断が使用できる
```

---

*本ドキュメントは AI_WORKER YouTube投稿前診断AI MVP仕様書 v1.0*
*参照: [長期アーキテクチャ設計書](./youtube-diagnostic-ai-architecture.md)*
*次回更新タイミング: Phase1 MVP 実装開始時*
