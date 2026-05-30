# AI_WORKER Bot - Phase 1

スマホの Discord から指示を送ると、Windows PC 上で Claude Code が動いてコードを作ってくれるシステムです。

---

## これで何ができる？

```
スマホ → Discord に !claude コマンドを送る
          ↓
        PC で Claude Code が自動で動く
          ↓
        結果が Discord に届く
          ↓
        次に何をするか（Codex/ChatGPT/Claude Code）も教えてくれる
```

---

## セットアップ手順（初めての方向け）

### 必要なもの

| ツール | 説明 | 入手先 |
|--------|------|--------|
| Node.js 18以上 | Bot を動かすための基盤 | https://nodejs.org → LTS版をダウンロード |
| Claude Code | AIがコードを書くツール | `npm install -g @anthropic-ai/claude-code` |
| Discord Bot | DiscordとPCをつなぐ橋 | 下の手順で作成 |

---

### STEP 1: Node.js をインストール

1. https://nodejs.org を開く
2. **「LTS」と書かれたボタン**をクリックしてダウンロード
3. ダウンロードしたファイルをダブルクリックしてインストール
4. インストール完了後、PowerShell を開いて確認：
   ```
   node --version
   ```
   `v18.x.x` のような表示が出ればOK

---

### STEP 2: Claude Code をインストール

PowerShell を開いて以下を実行：

```powershell
npm install -g @anthropic-ai/claude-code
```

完了後、ログインします：

```powershell
claude
```

（初回は Anthropic のサイトでログインが求められます）

---

### STEP 3: Discord Bot を作る

**3-1. Discord Developer Portal を開く**

ブラウザで https://discord.com/developers/applications を開く

**3-2. アプリを作る**

1. 右上の「New Application」をクリック
2. 名前を入力（例: `AI-Worker-Bot`）
3. 「Create」をクリック

**3-3. Bot を有効にする**

1. 左メニューの「Bot」をクリック
2. 「Add Bot」をクリック → 「Yes, do it!」
3. 「MESSAGE CONTENT INTENT」を**オン**にする（重要！）
4. 「Save Changes」をクリック

**3-4. トークンをコピーする**

1. 「Bot」ページの「Reset Token」をクリック
2. 表示されたトークンをコピー（**絶対に他人に見せないこと**）

**3-5. Bot をサーバーに招待する**

1. 左メニューの「OAuth2」→「URL Generator」をクリック
2. 「SCOPES」で `bot` にチェック
3. 「BOT PERMISSIONS」で以下にチェック：
   - `Send Messages`
   - `Read Messages/View Channels`
   - `Embed Links`
   - `Read Message History`
4. 生成された URL をブラウザで開いてサーバーに招待

---

### STEP 4: 環境変数を設定する

**4-1. .env ファイルを作る**

AI_WORKER フォルダで PowerShell を開いて：

```powershell
Copy-Item .env.example .env
```

**4-2. .env をメモ帳で開いて設定する**

```powershell
notepad .env
```

以下の3つを設定してください：

| 設定名 | 説明 | 取得方法 |
|--------|------|----------|
| `DISCORD_TOKEN` | BotのID | STEP 3-4 でコピーしたもの |
| `ALLOWED_CHANNEL_IDS` | 監視するチャンネルのID | 下記参照 |
| `DISCORD_OWNER_ID` | あなた自身のユーザーID | 下記参照 |

**チャンネルID の取得方法：**
1. Discord の設定 → 詳細設定 → 「開発者モード」をオンにする
2. 監視したいチャンネルを右クリック
3. 「IDをコピー」をクリック

**ユーザーID の取得方法：**
1. 開発者モードをオンにする（上記参照）
2. Discord 上の自分のアイコンを右クリック
3. 「IDをコピー」をクリック

---

### STEP 5: 起動する

```powershell
.\scripts\start.ps1
```

または：

```powershell
npm start
```

以下のような表示が出たら成功です：

```
✅ AI_WORKER Bot がオンラインになりました
   Bot 名: AI-Worker-Bot#1234
   監視チャンネル: 1234567890123456789
   コマンド: !claude <やりたいこと>
```

---

## 使い方

### 基本コマンド

Discord の監視チャンネルに以下を送信：

```
!claude <Claude Code への指示>
```

### 例

```
!claude Hello Worldを出力するPythonスクリプトを作ってください
```

```
!claude シンプルなTODOアプリのHTMLを作ってください
```

```
!claude package.jsonのひな形を作ってください
```

### 結果の見方

Bot から以下のように返信が来ます：

1. `⏳ 処理中...` → Claude Code が作業中
2. `✅ 完了！` → 作業が終わった。`workspace/task_XXX/` フォルダに成果物がある
3. `📋 次の依頼文` → 次に誰のAIへ依頼するか（コピーして使える形式）

---

## フォルダの説明

| フォルダ | 役割 |
|---------|------|
| `bot/` | Bot本体のプログラム |
| `workspace/` | Claude Code の作業場所（成果物はここに保存される） |
| `logs/` | Bot の実行ログ（何かあった時に確認する） |
| `docs/` | 仕様書・次タスク情報 |
| `prompts/` | よく使うプロンプトのテンプレート（自由に追加可能） |
| `reviews/` | AIレビューの記録（Phase2以降） |
| `temp/` | 一時ファイル |
| `scripts/` | 起動スクリプト |

---

## よくあるエラーと対処法

### 「DISCORD_TOKEN が設定されていません」

→ `.env` ファイルに `DISCORD_TOKEN` を設定してください

### 「MESSAGE CONTENT INTENT」エラー

→ Discord Developer Portal → Bot → 「MESSAGE CONTENT INTENT」をオンにしてください

### 「Claude Code が見つかりません」

→ `npm install -g @anthropic-ai/claude-code` を実行してください

### Bot がオフラインのまま

→ `DISCORD_TOKEN` が正しいか確認してください（スペースが入っていないか注意）

### 「セキュリティチェックで拒否されました」

→ 危険なコマンド（ファイル削除など）を含む指示は実行できません。指示を変えてください

---

## セキュリティについて

- **workspace フォルダ以外には触れません**（Claude Code の作業はここだけ）
- **危険なコマンドは事前にブロック**されます（rm -rf 等）
- **トークンは .env で管理**し、Git には含まれません
- **タイムアウト**があるため、Bot が無限に動き続けることはありません

---

## 次のフェーズ（Phase2 予定）

- Codex との自動連携
- GitHub への自動コミット
- タスクのキュー管理（複数タスクを順番に処理）
- タスク履歴の検索

---

## ファイル構成

```
AI_WORKER/
├─ bot/
│   ├─ index.js           Bot本体
│   └─ utils/
│       ├─ logger.js      ログ管理
│       ├─ security.js    セキュリティチェック
│       ├─ claude-runner.js  Claude Code 実行
│       └─ next-task.js   次タスク判断
├─ workspace/             成果物の保存場所
├─ logs/                  実行ログ
├─ prompts/               プロンプトテンプレート
├─ docs/                  仕様書・履歴
├─ reviews/               レビュー記録
├─ temp/                  一時ファイル
├─ scripts/
│   └─ start.ps1          起動スクリプト
├─ .env.example           環境変数テンプレート
├─ .gitignore
├─ package.json
└─ README.md              ← このファイル
```
