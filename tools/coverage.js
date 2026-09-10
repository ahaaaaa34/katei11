/**
 * 関数レベルの実行カバレッジ。
 *
 * ソースの各関数の先頭に印を差し込んでからテストを走らせ、
 * 一度も呼ばれなかった関数を挙げる。テストが通っていても、
 * 呼ばれていない関数は何も保証されていない。
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'tests', 'harness.js');

const hits = new Set();
const declared = new Map();   // 関数名 → ファイル名

function instrument(source, file) {
  return source.replace(
    /^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm,
    (whole, indent, name, args) => {
      declared.set(name, file);
      return `${indent}function ${name}(${args}) { __hit(${JSON.stringify(name)});`;
    });
}

// harness の readSource を差し替えて、計装済みのソースを返させる。
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const text = originalRead.call(fs, file, ...rest);
  if (typeof file === 'string' && file.includes(`${path.sep}src${path.sep}`)
      && file.endsWith('.js') && typeof text === 'string') {
    return instrument(text, path.basename(file));
  }
  return text;
};

global.__hit = (name) => hits.add(name);

// harness の loadGas は new Function を使うので、__hit をグローバルから見せる。
const harness = require(HARNESS);
const originalLoad = harness.loadGas;
harness.loadGas = (overrides) => originalLoad(overrides);

require(path.join(ROOT, 'tests', 'run.js'));

process.on('exit', () => {
  const never = [...declared.keys()].filter((name) => !hits.has(name)).sort();
  console.log('\n──────── 関数カバレッジ ────────');
  console.log(`定義 ${declared.size} / 実行 ${hits.size} / 未実行 ${never.length}`);
  if (never.length) {
    console.log('\n一度も呼ばれていない関数:');
    never.forEach((name) => console.log(`  ${name}  (${declared.get(name)})`));
  }
});
