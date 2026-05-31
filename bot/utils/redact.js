'use strict';

// =====================================================
// redact.js — 単一サニタイズ層（秘密情報マスク）
//
// 役割:
//   ログ・エラーメッセージ・Discord 表示・ディスク保存（lastError /
//   error.md）など、外部へ出る/永続化される文字列から秘密情報を除去する。
//
//   既存の github.js #maskSecret の方針を統合・拡張したもの。
//   github.js #maskSecret は後方互換のため本モジュールへ委譲する。
//
// マスク対象:
//   - PEM 秘密鍵ブロック（-----BEGIN ... PRIVATE KEY-----）
//   - JWT（eyJ....eyJ....署名）
//   - GitHub トークン（github_pat_* / ghp_*）
//   - Authorization: Basic/Bearer <値> / 単独 Bearer <値>
//   - http.extraheader の Authorization 値
//   - URL 埋め込み資格情報（https://token@host）
//   - KEY=VALUE 形式の *_TOKEN / *_KEY / *_SECRET / PASSWORD / API key
//   - 汎用: 40 文字以上の英数字列（トークンらしき値）
//
// 設計方針:
//   - 置換後の文字列は常に '[MASKED]' を含める（既存テスト互換）。
//   - 構文的に「代入形（= / :）」の秘密のみ値をマスクし、英語の
//     エラー文（"permission denied" 等）は壊さない（誤マスク抑制）。
//   - 非文字列入力はそのまま返す（既存 maskSecret 挙動互換）。
//   - 本モジュールは他の bot ユーティリティに依存しない（循環防止）。
// =====================================================

const MASK = '[MASKED]';

// ─────────────────────────────────────────────────────
// redact(input) — 秘密情報をマスクした文字列を返す
//
// 引数:  input  - 任意（非文字列はそのまま返す）
// 戻り値: マスク済み文字列 | input（非文字列時）
// ─────────────────────────────────────────────────────
function redact(input) {
  if (typeof input !== 'string') return input;
  let s = input;

  // 1. PEM 秘密鍵ブロック（複数行）
  s = s.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    MASK
  );

  // 2. JWT（header.payload.signature）
  s = s.replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MASK);

  // 3. GitHub トークン
  s = s.replace(/github_pat_[A-Za-z0-9_]+/gi, MASK);
  s = s.replace(/ghp_[A-Za-z0-9]+/gi, MASK);

  // 4. Authorization: Basic/Bearer <値>
  s = s.replace(
    /(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9+/=_\-.]+/gi,
    `$1${MASK}`
  );

  // 4b. 単独の Bearer <値>（Authorization: が付かないケース）
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9+/=_\-.]{8,}/gi, `$1${MASK}`);

  // 5. http.extraheader="Authorization: ..."
  s = s.replace(
    /(extraheader[="\s]*Authorization[^"]*?)[A-Za-z0-9+/=_\-]{8,}/gi,
    `$1${MASK}`
  );

  // 6. URL 埋め込み資格情報（https://TOKEN@host）
  s = s.replace(/(https?:\/\/)[^@\s/]+@/gi, `$1${MASK}@`);

  // 7. KEY=VALUE / KEY: VALUE 形式の秘密
  //    キー名が TOKEN / SECRET / PASSWORD / PASSWD / KEY で終わる、
  //    または API_KEY / APIKEY の場合に、その値だけをマスクする。
  //    値の囲い引用符は残し、中身だけ [MASKED] に置換する。
  s = s.replace(
    /((?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|[A-Za-z0-9_]*KEY))(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    `$1$2$3${MASK}`
  );

  // 8. 汎用: 40 文字以上の英数字列（トークンらしき値）
  s = s.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, MASK);

  return s;
}

module.exports = { redact, MASK };
