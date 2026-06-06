# YouTube診断β — 運用者向け配布手順書

**対象:** 守谷CTO（Release Check） / 相沢CS（β配布担当）  
**更新:** 2026-06-07  
**バージョン:** β外部配布準備 Phase 4

---

## 1. サーバー起動方法

### ローカル起動（確認用）

```bash
# プロジェクトルートで実行
npm run start:web

# または直接
node web/youtube-diagnostic-server.js

# 起動確認 → http://localhost:3000 でアクセス
```

### Fly.io デプロイ（外部公開用）

```bash
# 初回のみ: Fly.io CLIインストール
# https://fly.io/docs/hands-on/install-flyctl/

# Fly.io ログイン
flyctl auth login

# デプロイ（初回）
flyctl launch --no-deploy   # fly.toml 読み込み確認
flyctl deploy

# デプロイ（2回目以降）
flyctl deploy

# 公開URL確認
flyctl info   # → https://youtube-diagnostic-beta.fly.dev
```

### 停止方法

```bash
# Fly.io: アプリを一時停止（課金は継続しないが設定は残る）
flyctl scale count 0

# 完全削除（β終了後）
flyctl apps destroy youtube-diagnostic-beta
```

---

## 2. URL共有方法

### Fly.io 公開URL（HTTPS）
```
https://youtube-diagnostic-beta.fly.dev
```

### βユーザーへの共有文（コピー用）
```
YouTube投稿前診断ツール（β版）

URL: https://youtube-diagnostic-beta.fly.dev

使い方:
1. URLを開く（スマホ・PCどちらでも可）
2. タイトルとジャンルを入力
3. 「診断する」を押す

詳細の使い方はこちら → [docs/youtube-diagnostic-ai-beta-user-guide.md の内容をコピーして添付]
```

---

## 3. 動作確認（Release Check 手順）

### 3-1. 基本動作確認

```bash
# Health check
curl https://youtube-diagnostic-beta.fly.dev/health
# → {"ok":true,"mode":"web"}

# 診断API確認
curl -X POST https://youtube-diagnostic-beta.fly.dev/diagnose \
  -H "Content-Type: application/json" \
  -d '{"title":"テスト投稿【初心者向け】Python3つの基本！","genre":"education","duration":600}'
# → {"ok":true,"totalScore":...,"rank":...,...}
```

### 3-2. 外部アクセス確認チェックリスト

- [ ] `https://youtube-diagnostic-beta.fly.dev` がブラウザで開ける
- [ ] 診断ボタンが機能する（タイトル入力→送信→結果表示）
- [ ] HTTPS（鍵マーク）が表示されている

### 3-3. スマホ確認

- [ ] iOS Safari でページが開ける
- [ ] Android Chrome でページが開ける
- [ ] 縦画面で6軸スコアが正常に表示される
- [ ] 「診断する」ボタンが押しやすいサイズ
- [ ] キーボード入力時にレイアウトが崩れない

### 3-4. 内部情報漏れ確認

| 確認項目 | 確認方法 | 期待値 |
|---|---|---|
| Discord情報の露出 | APIレスポンスを目視確認 | なし |
| 内部ファイルパス露出 | レスポンスJSON目視 | なし |
| 学習データの露出 | `/diagnose` レスポンスのmodelInfo | `{usedML, mlSamples, mlProb}` のみ（統計値。問題なし） |
| エラーメッセージのスタックトレース | 不正入力でのレスポンス確認 | `{"ok":false,"error":"Invalid request"}` のみ |

```bash
# 不正入力テスト（内部エラーが漏れないこと）
curl -X POST https://youtube-diagnostic-beta.fly.dev/diagnose \
  -H "Content-Type: application/json" \
  -d 'invalid-json'
# → {"ok":false,"error":"Invalid request"}
```

---

## 4. トラブル時の確認方法

### サーバーが応答しない

```bash
# Fly.io ステータス確認
flyctl status

# ログ確認（直近50行）
flyctl logs --lines 50

# マシン起動（スケールゼロの場合）
flyctl scale count 1

# 強制再デプロイ
flyctl deploy
```

### 診断が動かない（コールドスタートの可能性）

```bash
# Health check で確認
curl https://youtube-diagnostic-beta.fly.dev/health

# タイムアウトの場合、Fly.io が auto_stop している可能性
# → アクセスから数秒待つ（初回起動に5〜10秒かかる）
```

### ローカルで動かしてテストしたい

```bash
# ローカル起動
npm run start:web

# 動作確認
curl -X POST http://localhost:3000/diagnose \
  -H "Content-Type: application/json" \
  -d '{"title":"テストタイトル【】！","genre":"game"}'
```

### Fly.io 無料枠の確認

```bash
# 月次の使用量確認
flyctl billing show

# 現在のインスタンス状況
flyctl machines list
```

---

## 5. コスト情報

| 項目 | 金額 | 備考 |
|---|---|---|
| Fly.io shared-cpu-1x (256MB) | 無料〜$2/月 | 無料枠内で収まる見込み（β 5-8人規模） |
| 診断の変動費 | ¥0 | ローカル推論のため API コスト不要 |
| YouTube Data API | ¥0 | 診断実行時には呼び出さない |

**CFOシーリング: 月1,000円以内に収まる設計**（Fly.io 無料枠超過時でも $2-3/月）

---

## 6. β終了後の手順

```bash
# データ保全（ログのエクスポート）
flyctl ssh console -C "cat logs/yt-diagnostic-usage.jsonl"

# アプリ停止
flyctl scale count 0

# 完全削除（必要な場合）
flyctl apps destroy youtube-diagnostic-beta
```

---

*βユーザー向け説明文: `docs/youtube-diagnostic-ai-beta-user-guide.md`*  
*READY条件: `docs/youtube-diagnostic-ai-ready-criteria.md`*
