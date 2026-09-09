/**
 * 小さな共通部品：ログ、ハッシュ、HTTP、スクリプトプロパティ。
 */

/** GAS でも Node のテストでも動くログ。 */
function log_(message) {
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log(message);
  else if (typeof console !== 'undefined') console.log(message);
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(key, fallback) {
  try {
    const value = props_().getProperty(key);
    return value === null || value === '' ? (fallback || '') : value;
  } catch (err) {
    return fallback || '';
  }
}

// ---------------------------------------------------------------------------
// SHA-1（純 JS）
// ---------------------------------------------------------------------------
// GAS の Utilities.computeDigest でも同じ値が出るが、純 JS にしておくと
// Node 側のテストで既知のテストベクタと突き合わせられる。予定 ID の決め方が
// 変わると既存の予定が全部作り直しになるので、ここは検証できる形にしておく。

function sha1Bytes_(text) {
  const bytes = utf8Bytes_(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 長さは 64bit ビッグエンディアン。実用上 32bit で足りるので上位は 0。
  for (let i = 0; i < 4; i++) bytes.push(0);
  for (let i = 3; i >= 0; i--) bytes.push((bitLength >>> (i * 8)) & 0xff);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16) |
             (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl_(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotl_(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl_(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }

  const out = [];
  [h0, h1, h2, h3, h4].forEach(function (word) {
    for (let i = 3; i >= 0; i--) out.push((word >>> (i * 8)) & 0xff);
  });
  return out;
}

function rotl_(value, bits) {
  return (value << bits) | (value >>> (32 - bits));
}

function utf8Bytes_(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
               0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

function sha1Hex_(text) {
  return sha1Bytes_(text).map(function (b) {
    return (b < 16 ? '0' : '') + b.toString(16);
  }).join('');
}

/**
 * Google カレンダーの ID に使える文字は base32hex（0-9a-v）だけ。
 * SHA-1 をその文字集合に落として、指標と日付から一意な ID を作る。
 */
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

function base32hex_(bytes) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 取得できなければ null を返す（例外を投げない）。
 * ひとつの情報源が死んでも同期全体を止めないため。
 */
function fetchJson_(url, options) {
  const response = fetchText_(url, options);
  if (response === null) return null;
  try {
    return JSON.parse(response);
  } catch (err) {
    log_('JSON として読めませんでした: ' + url);
    return null;
  }
}

function fetchText_(url, options) {
  const params = Object.assign({
    muteHttpExceptions: true,
    followRedirects: true,
    validateHttpsCertificates: true,
  }, options || {});
  try {
    const response = UrlFetchApp.fetch(url, params);
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) return response.getContentText();
    log_('HTTP ' + code + ': ' + url);
    return null;
  } catch (err) {
    log_('接続できませんでした: ' + url + ' (' + err + ')');
    return null;
  }
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}
