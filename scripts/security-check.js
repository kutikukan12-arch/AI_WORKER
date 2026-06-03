'use strict';

// =====================================================
// security-check.js — 公開境界チェック（🅷 Claude H / Learning Guardian）
//
// L-16 標準手順の実行版。機密パターンに該当する「追跡済み(git ls-files)」
// ファイルを検出し、各々の git check-ignore 状態を表示する。
// .gitignore に書いただけで安全と思い込む事故（.env.bak 追跡残り等）を防ぐ。
//
// 使い方:
//   npm run security-check
//   node scripts/security-check.js
//
// 終了コード: 機密パターンに該当する追跡済みファイルが1件でもあれば 1（CI連携可）。
//
// 禁止: ファイル本文・トークン値の表示はしない（ファイル名のみ扱う）。
// =====================================================

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 機密・内部資産とみなすファイル名パターン（必要に応じて追記）
const SECRET_PATTERNS = [
  { label: '.env / 環境変数',        re: /(^|\/)\.env(\..+)?$/i },
  { label: '.env バックアップ',       re: /\.env\.bak/i },
  { label: '.env を含む docs 等',     re: /\.env$/i },
  { label: 'モデル重み/学習モデル',    re: /(model|weights?)[^/]*\.json$/i },
  { label: 'seed データ',            re: /seed/i },
  { label: 'トークン/鍵/秘密',        re: /(token|secret|credential|apikey|api[-_]?key|private[-_]?key)/i },
];

// 検査対象外（パターンに当たっても誤検知になりやすいもの）
// ※ ソースコード内のハードコード秘密は別レイヤ（secret-guardian.js / 内容スキャン）で扱う。
//   本チェックはファイル名ベースの「公開境界」検査に限定する。
const ALLOWLIST = [
  /\.example$/i,            // .env.example 等の見本
  /node_modules\//,
  /\.(js|ts|mjs|cjs)$/i,    // ソースコード（*-model*.js, *seed*.js, secret-guardian.js 等）
  /\.md$/i,                 // ドキュメント本文（ガイド等）
  /youtube-model-export/i,  // export(weightsのみ・metadata除外済み)は公開可
];

function gitLsFiles() {
  try {
    return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.error('git ls-files 失敗:', e.message);
    process.exit(2);
  }
}

// .gitignore のルール自体が該当するか（--no-index でルールのみ判定）。
// 既に追跡済みのファイルはデフォルトの check-ignore では「ignoreされない」と
// 出るため、ルールの有無は --no-index で確認する（これが L-16 の核心）。
function ruleMatches(file) {
  try {
    execSync(`git check-ignore --no-index -q "${file}"`, { cwd: ROOT, stdio: 'pipe' });
    return true; // 終了0 = ignoreルールが該当
  } catch {
    return false; // 終了1 = 該当ルールなし
  }
}

function classify(file) {
  if (ALLOWLIST.some(re => re.test(file))) return null;
  const hit = SECRET_PATTERNS.find(p => p.re.test(file));
  return hit ? hit.label : null;
}

function main() {
  const tracked = gitLsFiles();
  const findings = [];
  for (const f of tracked) {
    const label = classify(f);
    if (label) findings.push({ file: f, label, hasRule: ruleMatches(f) });
  }

  console.log('🔒 Security Check — 公開境界（L-16）');
  console.log(`対象: 追跡済み ${tracked.length} 件 / 機密パターン該当 ${findings.length} 件`);
  console.log('');

  if (findings.length === 0) {
    console.log('✅ 機密パターンに該当する追跡済みファイルはありません。');
    process.exit(0);
  }

  console.log('⚠️ 機密の可能性があり、かつ追跡済みのファイル:');
  console.log('');
  for (const x of findings) {
    const flag = x.hasRule
      ? '🟡 .gitignoreルールはあるが追跡残り → git rm --cached が必要(L-16の典型)'
      : '🔴 .gitignoreルールなし & 追跡中 → 公開境界を要判断';
    console.log(`  [${x.label}] ${x.file}`);
    console.log(`      ${flag}`);
  }
  console.log('');
  console.log('対応: 非公開化するなら `git rm --cached <file>` で追跡解除しコミット。');
  console.log('      コミット済みの実トークンは無効化＋ローテーションも必須（L-16）。');
  process.exit(1);
}

main();
