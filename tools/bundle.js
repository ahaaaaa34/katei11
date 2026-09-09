/**
 * src/*.js をひとつのファイルにまとめる。
 *
 * clasp を使わず、スクリプト エディタに貼り付けたい人向け。
 * Apps Script はどのみち全ファイルを同じスコープで動かすので、
 * 連結しても挙動は変わらない。
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'dist', 'Code.gs');

const header = [
  '/**',
  ' * 経済指標カレンダー — Google Apps Script 版（単一ファイル）',
  ' *',
  ' * このファイルは src/*.js を連結して生成されています。',
  ' * 編集は src 側で行い、node tools/bundle.js で作り直してください。',
  ' *',
  ' * 使い方:',
  ' *   1. script.google.com で新しいプロジェクトを作る',
  ' *   2. コード.gs の中身をこのファイルで丸ごと置き換える',
  ' *   3. 左メニューの [サービス] + から Calendar API を追加する',
  ' *   4. 関数プルダウンで setup を選んで実行する',
  ' */',
  '',
].join('\n');

const files = fs.readdirSync(SRC).filter((name) => name.endsWith('.js')).sort();
const body = files.map((name) => {
  const source = fs.readFileSync(path.join(SRC, name), 'utf8').trimEnd();
  return '// ═══════════════════════════════════════════════════════════\n'
       + '// ' + name + '\n'
       + '// ═══════════════════════════════════════════════════════════\n\n'
       + source;
}).join('\n\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + body + '\n', 'utf8');

// 連結した結果が構文として通ることをここで確かめる。
new Function(fs.readFileSync(OUT, 'utf8'));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log('dist/Code.gs を生成しました（' + files.length + ' ファイル / ' + kb + ' KB）');
