'use strict';

// =====================================================
// redact.js — 単一サニタイズ層（秘密情報 + PII マスク）
//
// 役割:
//   ログ・エラーメッセージ・Discord 表示・ディスク保存（lastError /
//   error.md / client-tracker ノート）など、外部へ出る/永続化される
//   文字列から秘密情報・個人情報（PII）を除去する。
//
// マスク対象（秘密情報）:
//   - PEM 秘密鍵ブロック（-----BEGIN ... PRIVATE KEY-----）
//   - JWT（eyJ....eyJ....署名）
//   - GitHub トークン（github_pat_* / ghp_*）
//   - OpenAI API Key（sk-proj-* / sk-*）
//   - Discord Bot Token（MTU... 形式）
//   - Authorization: Basic/Bearer <値> / 単独 Bearer <値>
//   - http.extraheader の Authorization 値
//   - URL 埋め込み資格情報（https://token@host）
//   - KEY=VALUE 形式の *_TOKEN / *_KEY / *_SECRET / PASSWORD / API key
//   - 汎用: 40 文字以上の英数字列（トークンらしき値）
//
// マスク対象（PII — 顧客案件記録用に追加）:
//   - メールアドレス（xxx@yyy.zzz）
//   - 電話番号（日本の形式）
//   - 郵便番号（〒xxx-xxxx）
//   - 住所っぽい表現（都道府県・市区町村・丁目番地）
//   - 顧客名っぽい表現（顧客 / 依頼者 / お客様 + 名前）
//
// 設計方針:
//   - 置換後の文字列は常に '[MASKED]' を含める（既存テスト互換）。
//   - PII は誤検知を許容（顧客記憶系では安全側を優先）。
//   - 非文字列入力はそのまま返す（既存 maskSecret 挙動互換）。
//   - 本モジュールは他の bot ユーティリティに依存しない（循環防止）。
//
// 関数:
//   redact(input)          — 秘密情報 + PII をマスク（保存用）
//   redactSecretOnly(input) — 秘密情報のみマスク（旧来の動作・後方互換）
// =====================================================

const MASK = '[MASKED]';
const PII_MASK = '[PII]';

// ─────────────────────────────────────────────────────
// _redactSecrets(s) — 秘密情報のみマスク（内部ヘルパー）
// ─────────────────────────────────────────────────────
function _redactSecrets(s) {
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
  // 4. OpenAI API Key
  s = s.replace(/sk-proj-[A-Za-z0-9_\-]{20,}/gi, MASK);
  s = s.replace(/\bsk-[A-Za-z0-9]{48}\b/g, MASK);
  // 5. Discord Bot Token（MTU... 形式）
  s = s.replace(/\bMT[A-Za-z0-9]{18,32}\.[A-Za-z0-9_-]{4,8}\.[A-Za-z0-9_-]{20,}\b/g, MASK);
  // 6. Authorization: Basic/Bearer <値>
  s = s.replace(
    /(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9+/=_\-.]+/gi,
    `$1${MASK}`
  );
  // 6b. 単独の Bearer <値>
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9+/=_\-.]{8,}/gi, `$1${MASK}`);
  // 7. http.extraheader="Authorization: ..."
  s = s.replace(
    /(extraheader[="\s]*Authorization[^"]*?)[A-Za-z0-9+/=_\-]{8,}/gi,
    `$1${MASK}`
  );
  // 8. URL 埋め込み資格情報（https://TOKEN@host）
  s = s.replace(/(https?:\/\/)[^@\s/]+@/gi, `$1${MASK}@`);
  // 9. KEY=VALUE / KEY: VALUE 形式の秘密
  s = s.replace(
    /((?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|[A-Za-z0-9_]*KEY))(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    `$1$2$3${MASK}`
  );
  // 10. 汎用: 40 文字以上の英数字列（トークンらしき値）
  s = s.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, MASK);
  return s;
}

// ─────────────────────────────────────────────────────
// _redactPII(s) — PII（個人情報）マスク（顧客案件記録用）
// 誤検知を許容して安全側に倒す設計
// ─────────────────────────────────────────────────────
function _redactPII(s) {
  // A. メールアドレス（xxx@yyy.zzz）
  s = s.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, PII_MASK);

  // B. 日本の電話番号（固定・携帯・フリーダイヤル）
  s = s.replace(
    /(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4}|0\d{10}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4})/g,
    PII_MASK
  );

  // C. 郵便番号
  s = s.replace(/〒?\d{3}[-\s]?\d{4}/g, PII_MASK);

  // D. 住所っぽい表現（都道府県 + 市区町村 + 番地）
  s = s.replace(
    /(?:北海道|[東西南北]?[京大][都府]|[A-Z一-龥]{2,4}[都道府県])[^\s、。]{1,50}(?:\d+丁目|\d+番|\d+号)/g,
    PII_MASK
  );
  // 住所の一部（市区町村 + 番地のみ）
  s = s.replace(
    /[一-龥]{2,6}(?:市|区|町|村)[一-龥\d\-\s]+(?:\d+番地|\d+丁目)/g,
    PII_MASK
  );

  // E. 「顧客 山田太郎」「依頼者:田中」「お客様 佐藤様」など氏名っぽい表現
  //    「顧客/依頼者/クライアント/お客様」+ スペース + 漢字2〜5文字（姓名）
  s = s.replace(
    /(?:顧客|依頼者|クライアント|お客様|発注者)[\s:：]+[一-龥ぁ-ん]{2,5}(?:[\s　][一-龥ぁ-ん]{1,5})?(?:様|さん|氏)?/g,
    (m) => `${m.match(/^[^\s:：]+/)[0]}:${PII_MASK}`
  );

  return s;
}

// ─────────────────────────────────────────────────────
// redact(input) — 秘密情報 + PII をマスク（保存用・完全版）
//
// 用途: client-tracker ノート・プロジェクト名・review 出力など
//       ディスクに永続化されるすべての文字列に適用する。
//
// 引数:  input  - 任意（非文字列はそのまま返す）
// 戻り値: マスク済み文字列 | input（非文字列時）
// ─────────────────────────────────────────────────────
function redact(input) {
  if (typeof input !== 'string') return input;
  let s = input;
  s = _redactSecrets(s);
  s = _redactPII(s);
  return s;
}

// ─────────────────────────────────────────────────────
// redactSecretOnly(input) — 秘密情報のみマスク（後方互換）
//
// 用途: ログ・エラーメッセージなど従来の用途（PII マスクは不要）
// ─────────────────────────────────────────────────────
function redactSecretOnly(input) {
  if (typeof input !== 'string') return input;
  return _redactSecrets(input);
}

module.exports = { redact, redactSecretOnly, MASK, PII_MASK };
