/**
 * 設定。ここだけ書き換えれば動きます。
 *
 * APIキーや Webhook URL のような秘密情報はここに書かず、
 * スクリプト エディタの [プロジェクトの設定] → [スクリプト プロパティ] に
 * 入れてください（下の PROP_* が対応するキー名です）。
 */

const CONFIG = {
  // 予定を表示するタイムゾーン
  timezone: 'Asia/Tokyo',

  calendar: {
    // この名前のカレンダーを探し、無ければ自動で作ります
    name: '経済指標 (Nasdaq)',
    // 既存のカレンダーに入れたい場合はその ID を書く（name より優先）
    id: null,
    description: 'ナスダックに影響する経済指標を自動同期しています。',
  },

  window: {
    daysAhead: 60,  // 何日先まで登録するか
    daysBack: 5,    // 何日前まで遡って更新するか（発表後の結果を取り込むため）
  },

  filter: {
    // ナスダックへの影響度がこの値以上の指標だけを登録します。
    //   90+ 最重要 (CPI, 雇用統計, FOMC)  / 75+ 重要 / 55+ 注目
    minImpact: 55,
    countries: ['US', 'JP', 'EU', 'CN'],
    categories: [],   // 空 = 全カテゴリ
    include: [],      // スコアに関係なく必ず入れる指標 id
    exclude: [],      // 常に除外する指標 id
  },

  providers: {
    rules: true,     // 発表日のルール計算（通信不要）
    fomc: true,      // FOMC など中央銀行会合
    // 手入力の会合日程が尽きた先の年を、Fed の公式ページから補う。
    // 手入力がある年は絶対に上書きしません（false にすると手入力のみ）。
    fomcAutoFetch: true,
    market: true,    // 休場・短縮取引・SQ・指数リバランス
    // FRED は無料 API キーで発表日が公式の確定値になります。
    // https://fred.stlouisfed.org/docs/api/api_key.html
    // キーはスクリプト プロパティ FRED_API_KEY に入れてください（空なら自動で無効）。
    fred: true,
    // ナスダック100の主要銘柄の決算。
    earnings: true,
    // Investing.com（非公式・予想値と結果値が入る）。自己責任で true に。
    investing: false,
    // 統計を出す機関そのものの「発表予定表」。日付だけでなく
    // **発表時刻** が書いてある唯一の一次情報なので、既定で有効。
    officialTimes: true,
  },

  /**
   * 発表予定表の取得先（一次情報）。
   *
   * ここが取れているあいだ、発表時刻は機関の公表値そのものになります。
   * 取れなければ 01_indicators.js の暫定値に落ちますが、その予定には
   * 「未確認の暫定値」と書かれます（確かめていない値を、黙って
   * 確かな時刻のように見せることはしません）。
   *
   *   url : {{year}} は対象の年に置き換わります（年ごとの表のとき）
   *   tz  : その表に書かれている時刻のタイムゾーン
   *
   * ページの作りが変わって取れなくなったら checkOfficialTimes() が
   * 教えてくれます。URL だけ直せば復帰します。
   */
  officialSchedules: [
    { name: 'BLS（労働統計局）',
      url: 'https://www.bls.gov/schedule/news_release/{{year}}_sched.htm',
      tz: 'America/New_York' },
    { name: 'BEA（経済分析局）',
      url: 'https://www.bea.gov/news/schedule',
      tz: 'America/New_York' },
    { name: 'Census（センサス局）',
      url: 'https://www.census.gov/economic-indicators/',
      tz: 'America/New_York' },
  ],

  // investing を有効にしたとき、時刻がずれる場合だけ触ってください。
  // timezoneId はサイト内部の ID、assumeTz はそれが指すタイムゾーンです。
  investingTimezoneId: 55,
  investingAssumeTz: 'UTC',

  // 決算を拾う銘柄と、その影響度
  earningsTickers: {
    NVDA: 95, AAPL: 88, MSFT: 88, GOOGL: 85, AMZN: 85, META: 84,
    TSLA: 80, AVGO: 80, TSM: 70, AMD: 72, NFLX: 68, ORCL: 60,
    MU: 62, COST: 55, ADBE: 55, PLTR: 55,
  },

  display: {
    // true にすると時刻を持たない「終日の予定」になります。
    // 既定は false（発表時刻つき）。
    allDay: false,
    impactEmoji: true,      // 🔴🟠🟡⚪ を件名の先頭に付ける
    countryFlag: true,
    showScore: false,       // 件名にスコアを出す
  },

  // 通知。ランクごとに「何分前か」で指定します。
  //   時刻つき（既定）… 発表時刻から数えた分数（1440 = 前日の同時刻、30 = 30分前）
  //   display.allDay: true … その日の 0:00 から数えた分数（900 = 前日の朝9時）
  /**
   * 通知（発表の何分前に出すか）。ランクごとに変えられます。
   *
   * 空の配列にすると通知は出ません。カレンダーの既定の通知も出ません
   * （毎回 useDefault: false で書き込むため）。注目ランクの指標で
   * 一日中ポップアップが出る、ということにならないようにしています。
   *
   * display.allDay を true にしたときは意味が変わります。終日の予定では
   * Google が「その日の 0 時から何分前か」で測るので、30 は前夜 23:30、
   * 1440 は前日の 0 時になります。時刻を持たない以上こうなるので、
   * 終日で使うなら 1440 の倍数だけにしておくのが分かりやすいです。
   */
  reminders: { S: [1440, 30], A: [30], B: [], C: [] },

  // Google カレンダーの色 ID（11=赤 6=オレンジ 5=黄 8=グレー）
  colors: { S: '11', A: '6', B: '5', C: '8' },

  digest: {
    weeklyEvent: true,      // 月曜に「今週の注目指標」を終日予定として作る
    weeklyThreshold: 75,    // まとめに載せる影響度の下限
  },

  // 自動実行の時刻（スクリプトのタイムゾーン基準）
  triggers: {
    morningHour: 6,   // その日の予定を確定させる回
    eveningHour: 20,  // 発表結果を取り込む回
  },

  notify: {
    onFailure: true,        // 同期に失敗したら自分にメールする
    onMaintenance: true,    // 会合日程の期限が近づいたらメールする
    maintenanceCooldownDays: 7,  // 同じ内容のメールを送る間隔
  },
};

// スクリプト プロパティのキー名
const PROP_FRED_KEY = 'FRED_API_KEY';
const PROP_WEBHOOK_URL = 'WEBHOOK_URL';
const PROP_LAST_MAINTENANCE_MAIL = '_lastMaintenanceMail';
const PROP_LAST_DIGEST_WEEK = '_lastDigestWeek';
const PROP_CALENDAR_ID = '_calendarId';
const PROP_CALENDAR_NAME = '_calendarName';

/** カレンダーに書き込んだ予定の目印（これが付いた予定だけを管理する）。 */
const MANAGED_KEY = 'ecal';
const MANAGED_VALUE = '1';
