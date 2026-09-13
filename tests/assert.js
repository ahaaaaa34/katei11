/** 依存ゼロの極小テストランナー。 */

const results = { passed: 0, failed: 0, failures: [], times: [] };
let current = '';

function suite(name, body) {
  current = name;
  body();
}

function test(name, body) {
  const label = current + ' › ' + name;
  const began = Date.now();
  try {
    body();
    results.passed++;
  } catch (err) {
    results.failed++;
    results.failures.push({ label, message: err.message });
  }
  // 遅いテストは、変異テスト（テスト一式を何十回も回す）でそのまま
  // 効いてくる。SLOW_TESTS=1 で、かかった時間の多い順に出す。
  results.times.push({ label: label, ms: Date.now() - began });
}

function eq(actual, expected, hint) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((hint ? hint + ': ' : '') + '期待 ' + b + ' / 実際 ' + a);
  }
}

function ok(value, hint) {
  if (!value) throw new Error(hint || '真であるべき値が偽でした');
}

function throws(fn, pattern, hint) {
  try {
    fn();
  } catch (err) {
    if (pattern && !new RegExp(pattern).test(String(err.message))) {
      throw new Error((hint || '') + ' 例外メッセージが一致しません: ' + err.message);
    }
    return;
  }
  throw new Error((hint || '') + ' 例外が投げられませんでした');
}

function report() {
  if (results.failed) {
    console.log('');
    results.failures.forEach((f) => console.log('  ✗ ' + f.label + '\n      ' + f.message));
  }
  if (process.env.SLOW_TESTS) {
    console.log('\n──── かかった時間の多い順 ────');
    results.times.slice().sort((a, b) => b.ms - a.ms).slice(0, 15)
      .forEach((t) => console.log('  ' + String(t.ms).padStart(6) + ' ms  ' + t.label));
  }
  console.log('\n' + results.passed + ' passed, ' + results.failed + ' failed');
  return results.failed === 0 ? 0 : 1;
}

module.exports = { suite, test, eq, ok, throws, report, results };
