'use strict';
// =====================================================
// youtube-diagnostic-server.js — YouTube診断 最小Webサーバー
//
// 使い方:
//   node web/youtube-diagnostic-server.js
//   → http://localhost:3000 でアクセス
//
// 依存: Node.js 標準ライブラリのみ（追加 npm install 不要）
//
// 禁止事項:
//   ❌ ログイン / 課金 / 履歴
//   ❌ SNS連携 / 管理画面
//   ❌ AI_WORKER Discord 接続
//   ❌ Claude API 呼び出し
// =====================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');

const yd   = require('../bot/utils/youtube-diagnostic');

const PORT      = Number(process.env.PORT) || 3000;
const HTML_FILE = path.join(__dirname, 'youtube-diagnostic.html');
const LOG_FILE  = path.join(__dirname, '..', 'logs', 'yt-diagnostic-usage.jsonl');

function appendLog(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* non-fatal: log dir may not exist */ }
}

// ─────────────────────────────────────────────────────
// リクエストハンドラー
// ─────────────────────────────────────────────────────
function handler(req, res) {
  // GET / → HTML を返す
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
    return;
  }

  // POST /diagnose → 診断 JSON を返す
  if (req.method === 'POST' && req.url === '/diagnose') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        const raw = JSON.parse(body);

        // サニタイズ（API として信頼しない入力として扱う）
        const input = {
          title:           String(raw.title           || '').slice(0, 200),
          genre:           String(raw.genre           || '').slice(0, 50),
          description:     String(raw.description     || '').slice(0, 5000),
          tags:            Array.isArray(raw.tags)
                             ? raw.tags.slice(0, 30).map(t => String(t).slice(0, 100))
                             : [],
          duration:        Math.max(0, Math.min(Number(raw.duration)        || 0, 86400)),
          subscriberCount: Math.max(0, Math.min(Number(raw.subscriberCount) || 0, 1e9)),
          publishedAt:     raw.publishedAt ? String(raw.publishedAt).slice(0, 30) : null,
        };

        const result = yd.diagnose(input);

        if (result.ok) {
          appendLog({
            event: 'diagnose',
            genre: input.genre || '',
            score: result.totalScore,
            usedML: result.modelInfo?.usedML ?? false,
          });
        }

        res.writeHead(200, {
          'Content-Type':                'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
      }
    });
    return;
  }

  // POST /feedback → フィードバック記録（1-5評価）
  if (req.method === 'POST' && req.url === '/feedback') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        const raw    = JSON.parse(body);
        const rating = Math.max(1, Math.min(5, Math.round(Number(raw.rating) || 0)));
        const genre  = String(raw.genre  || '').slice(0, 50);
        const score  = Math.max(0, Math.min(100, Number(raw.score) || 0));
        if (!rating) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'rating required' }));
          return;
        }
        appendLog({ event: 'feedback', rating, genre, score });
        res.writeHead(200, {
          'Content-Type':                'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
      }
    });
    return;
  }

  // OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

// ─────────────────────────────────────────────────────
// サーバー起動
// ─────────────────────────────────────────────────────
const server = http.createServer(handler);
server.listen(PORT, () => {
  console.log(`🎬 YouTube診断サーバー起動: http://localhost:${PORT}`);
  console.log(`   停止: Ctrl+C`);
});
