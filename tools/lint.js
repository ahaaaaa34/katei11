/**
 * このプロジェクト専用の静的検査。
 *
 * デバッグで見つけた不具合には「型」があった。同じ型が他にも残っていないかを、
 * 実行せずに機械で一括して見る。汎用の lint ではなく、**ここで実際に起きた
 * 壊れ方**だけを狙う。
 *
 *   A 値を返す関数の中の、素の return
 *       → undefined が返り、呼び出し側は「問題なし」と解釈する。
 *         FOMC 日程の検査がこれで、壊れた日程を黙って通していた（6周目）。
 *   B 囲われていないスクリプト プロパティの書き込み
 *       → 例外が漏れて、カレンダーは正しく書けているのに同期が失敗扱いに
 *         なる（8周目）。
 *   C 表に出る文字列への、素の連結
 *       → verify_url を消すと「undefined を見て」と案内していた（8周目）。
 *   D 外から来た文字列での表引き
 *       → '__proto__' や 'toString' で Object の中身が返り、型外の値が
 *         素通りする（4周目）。
 *   E 囲われていない外部サービス呼び出し
 *       → ひとつの情報源が落ちただけで同期全体が止まる。
 *
 *   node tools/lint.js
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter((n) => n.endsWith('.js')).sort();

const findings = [];
function report(file, line, kind, text) {
  findings.push({ file: file, line: line, kind: kind, text: String(text).trim().slice(0, 110) });
}

/** トップレベルの `function name_(...) { ... }` を切り出す。 */
function topLevelFunctions(source) {
  const out = [];
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    out.push({
      name: match[1],
      body: source.slice(start + 1, i),
      startLine: source.slice(0, match.index).split('\n').length,
      bodyOffset: start + 1,
    });
  }
  return out;
}

/** その `/` が正規表現の始まりか（割り算ではないか）。 */
function isRegexStart(source, at) {
  for (let i = at - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') continue;
    return '(,=:[!&|?{};+-*%~^<>'.indexOf(ch) !== -1 || /return|typeof/.test(
      source.slice(Math.max(0, i - 6), i + 1));
  }
  return true;
}

/** 文字列・コメント・正規表現を潰す（誤検出を減らすため）。 */
function strip(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (source[i] === '/' && isRegexStart(source, i)) {
      // 正規表現リテラル。中の { } を数えてしまうと、関数の切り出しが崩れる。
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const ch = source[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;
        j++;
      }
      out += source.slice(i, j + 1).replace(/[^\n]/g, 'x');
      i = j + 1;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      // 中身は x に置き換えるが、引用符は残す。空白に潰すと
      // `return '文字列';` が「素の return」に見えてしまう。
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') j++;
        j++;
      }
      out += quote + source.slice(i + 1, j).replace(/[^\n]/g, 'x') + (source[j] || '');
      i = j + 1;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

const lineOf = (source, offset) => source.slice(0, offset).split('\n').length;

// ---------------------------------------------------------------------------

files.forEach((name) => {
  const source = fs.readFileSync(path.join(SRC, name), 'utf8');
  const bare = strip(source);   // 文字列・コメントを潰したもの

  // --- A. 値を返す関数の中の、素の return -----------------------------------
  topLevelFunctions(bare).forEach((fn) => {
    const returnsValue = /\breturn\s+[^;\s]/.test(fn.body);
    if (!returnsValue) return;
    // 入れ子の関数（コールバックも、中で宣言した名前付き関数も）の中の
    // return は「その1件を飛ばす」意味なので対象外にする。
    const callbackRanges = [];
    const cbRe = /function\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{|function\s*\([^)]*\)\s*\{|\([^)]*\)\s*=>\s*\{/g;
    let cb;
    while ((cb = cbRe.exec(fn.body)) !== null) {
      let depth = 0;
      let i = cb.index + cb[0].length - 1;
      for (; i < fn.body.length; i++) {
        if (fn.body[i] === '{') depth++;
        else if (fn.body[i] === '}') { depth--; if (depth === 0) break; }
      }
      callbackRanges.push([cb.index, i]);
    }
    const inCallback = (at) => callbackRanges.some((r) => at > r[0] && at < r[1]);

    const bareRe = /\breturn\s*;/g;
    let hit;
    while ((hit = bareRe.exec(fn.body)) !== null) {
      if (inCallback(hit.index)) continue;
      report(name, lineOf(bare, fn.bodyOffset + hit.index), 'A 値を返す関数の素の return',
             fn.name + '() の中');
    }
  });

  // --- B. 囲われていないプロパティ書き込み -----------------------------------
  topLevelFunctions(bare).forEach((fn) => {
    const writeRe = /props_\(\)\s*\.\s*(setProperty|deleteProperty)\s*\(/g;
    let hit;
    while ((hit = writeRe.exec(fn.body)) !== null) {
      // その位置より手前に、まだ閉じていない try があるか
      const before = fn.body.slice(0, hit.index);
      const tries = (before.match(/\btry\s*\{/g) || []).length;
      const catches = (before.match(/\}\s*catch\b/g) || []).length;
      if (tries > catches) continue;
      report(name, lineOf(bare, fn.bodyOffset + hit.index), 'B 囲われていない設定の書き込み',
             fn.name + '() の中の ' + hit[1]);
    }
  });

  // --- D. 対応表を、リテラルでない鍵で引いている -----------------------------
  // 鍵が '__proto__' や 'toString' だと Object の中身が返り、型外の値が
  // 素通りする。オブジェクトの対応表は lookup_ / hasKey_ 経由で引く約束。
  const tables = [];
  const declRe = /\bconst\s+([A-Z][A-Z0-9_]{2,})\s*=\s*\{/g;
  let decl;
  while ((decl = declRe.exec(bare)) !== null) tables.push(decl[1]);
  tables.forEach((table) => {
    const re = new RegExp('\\b' + table + '\\s*\\[\\s*([^\\]\\n]+?)\\s*\\]', 'g');
    let hit;
    while ((hit = re.exec(bare)) !== null) {
      const key = hit[1];
      if (/^['"]/.test(key)) continue;                       // 文字列リテラル
      const around = bare.slice(Math.max(0, hit.index - 160), hit.index + 60);
      if (/hasKey_|hasOwnProperty|lookup_/.test(around)) continue;
      report(name, lineOf(bare, hit.index), 'D 対応表をリテラルでない鍵で引いている',
             table + '[' + key + ']');
    }
  });

  // --- E. 囲われていない外部サービス呼び出し ---------------------------------
  const WRAPPERS = ['fetchText_', 'fetchJson_', 'fetchAllJson_', 'calendarCall_',
                    'sendMail_', 'acquireLock_', 'releaseLock_', 'props_', 'prop_',
                    'log_', 'sleep_', 'requireCalendarService_'];
  topLevelFunctions(bare).forEach((fn) => {
    if (WRAPPERS.indexOf(fn.name) !== -1) return;
    const callRe = /\b(UrlFetchApp|MailApp|LockService|ScriptApp|Session)\s*\./g;
    let hit;
    while ((hit = callRe.exec(fn.body)) !== null) {
      const before = fn.body.slice(0, hit.index);
      const tries = (before.match(/\btry\s*\{/g) || []).length;
      const catches = (before.match(/\}\s*catch\b/g) || []).length;
      if (tries > catches) continue;
      // 失敗をそのまま知らせたい場所は、印を付けて外す。
      // 行が長いことがあるので、直前の行に書いてあっても認める。
      const lineNo = lineOf(bare, fn.bodyOffset + hit.index);
      const lines = source.split('\n');
      if (/lint-ok:/.test(lines[lineNo - 1] || '')
          || /lint-ok:/.test(lines[lineNo - 2] || '')) continue;
      report(name, lineNo, 'E 囲われていない外部サービス呼び出し',
             fn.name + '() の中の ' + hit[1]);
    }
  });
});

// --- C. 表に出る文字列への素の連結 -------------------------------------------
// 「無いかもしれない入れ物」＝ `const x = ... || {};` で作ったものの member を、
// 守らずに文字列へ繋いでいるところ。verify_url を消すと「undefined を見て」と
// 案内していたのが、ちょうどこの形だった。
//
// 「守られている」の判定は **同じ関数の中の、その行より手前** に限る。
// ファイルのどこかに三項があれば見逃す、では緩すぎる。
files.forEach((name) => {
  const source = fs.readFileSync(path.join(SRC, name), 'utf8');
  const bare = strip(source);
  topLevelFunctions(bare).forEach((fn) => {
    const holders = [];
    const holderRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\|\|\s*\{\s*\}/g;
    let holder;
    while ((holder = holderRe.exec(fn.body)) !== null) holders.push(holder[1]);
    if (!holders.length) return;

    const raw = source.slice(fn.bodyOffset, fn.bodyOffset + fn.body.length);
    raw.split('\n').forEach((line, index) => {
      if (!/(message|fix|title|summary)\s*:|throw new Error\(|log_\(|lines\.push\(/
          .test(line)) return;
      holders.forEach((root) => {
        // 直前が「.」なら別のもの（CONFIG.providers.x など）。
        const re = new RegExp('(^|[^.\\w$])' + root + '\\.([\\w$]+)\\b(?!\\s*\\()', 'g');
        let hit;
        while ((hit = re.exec(line)) !== null) {
          const expr = root + '.' + hit[2];
          const upto = raw.split('\n').slice(0, index + 1).join('\n');
          const guarded = new RegExp(
            expr.replace('.', '\\.') + '\\s*(\\?|\\|\\|)'
            + '|' + expr.replace('.', '\\.') + '\\s*\\)?\\s*$').test(upto)
            || new RegExp('\\?\\s*[^\\n]*' + expr.replace('.', '\\.')).test(line);
          if (guarded) continue;
          report(name, lineOf(bare, fn.bodyOffset) + index, 'C 表に出る文字列への素の連結',
                 expr);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------

const byKind = {};
findings.forEach((f) => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
const kinds = Object.keys(byKind).sort();

if (!kinds.length) {
  console.log('静的検査: 指摘なし（' + files.length + ' ファイル）');
  process.exit(0);
}
kinds.forEach((kind) => {
  console.log('\n■ ' + kind + '（' + byKind[kind].length + ' 件）');
  byKind[kind].forEach((f) => {
    console.log('   ' + f.file + ':' + f.line + '  ' + f.text);
  });
});
console.log('\n合計 ' + findings.length + ' 件');
process.exit(1);
