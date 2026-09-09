/**
 * 中央銀行の会合日程
 *
 * 指標を足す・スコアを変える・解説を直すときはこのファイルを編集します。
 * 書式は tests/run.js の「指標カタログ」が検証しています。
 *
 * 中央銀行の会合日程。年に一度、公式ページを見て追記すること。
 * 期限が近づくと自動でメール通知が飛ぶ。
 */

const MEETINGS = {
  fomc: {
    verify_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    meetings: [
      {
        date: "2026-01-28",
        sep: false
      },
      {
        date: "2026-03-18",
        sep: true
      },
      {
        date: "2026-04-29",
        sep: false
      },
      {
        date: "2026-06-17",
        sep: true
      },
      {
        date: "2026-07-29",
        sep: false
      },
      {
        date: "2026-09-16",
        sep: true
      },
      {
        date: "2026-10-28",
        sep: false
      },
      {
        date: "2026-12-09",
        sep: true
      }
    ]
  },
  boj: {
    verify_url: "https://www.boj.or.jp/mopo/mpmsche_minu/index.htm",
    meetings: []
  },
  ecb: {
    verify_url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html",
    meetings: []
  }
};
