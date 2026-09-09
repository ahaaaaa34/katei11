/** 依存ゼロの極小テストランナー。 */

const results = { passed: 0, failed: 0, failures: [] };
let current = '';

function suite(name, body) {
  current = name;
  body();
}

function test(name, body) {
  const label = current + ' › ' + name;
  try {
    body();
    results.passed++;
  } catch (err) {
    results.failed++;
    results.failures.push({ label, message: err.message });
  }
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
  console.log('\n' + results.passed + ' passed, ' + results.failed + ' failed');
  return results.failed === 0 ? 0 : 1;
}

module.exports = { suite, test, eq, ok, throws, report, results };
