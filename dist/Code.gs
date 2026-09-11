/**
 * 経済指標カレンダー — Google Apps Script 版（単一ファイル）
 *
 * このファイルは src/*.js を連結して生成されています。
 * 編集は src 側で行い、node tools/bundle.js で作り直してください。
 *
 * 使い方:
 *   1. script.google.com で新しいプロジェクトを作る
 *   2. コード.gs の中身をこのファイルで丸ごと置き換える
 *   3. 左メニューの [サービス] + から Calendar API を追加する
 *   4. 関数プルダウンで setup を選んで実行する
 */
// ═══════════════════════════════════════════════════════════
// 00_config.js
// ═══════════════════════════════════════════════════════════

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
  },

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
const PROP_CALENDAR_ID = '_calendarId';
const PROP_CALENDAR_NAME = '_calendarName';

/** カレンダーに書き込んだ予定の目印（これが付いた予定だけを管理する）。 */
const MANAGED_KEY = 'ecal';
const MANAGED_VALUE = '1';

// ═══════════════════════════════════════════════════════════
// 01_indicators.js
// ═══════════════════════════════════════════════════════════

/**
 * 経済指標カタログ
 *
 * 指標を足す・スコアを変える・解説を直すときはこのファイルを編集します。
 * 書式は tests/run.js の「指標カタログ」が検証しています。
 *
 * impact: ナスダック100への影響度 (0-100)。S>=90 / A>=75 / B>=55 / C<55
 * time  : 発表時刻 (America/New_York)。夏時間は自動で処理される。
 * schedule.exact: true なら規則が確定的、false なら概算（FRED が上書きする）
 */

const INDICATORS = [
  {
    id: "us_fomc_rate",
    name: "FOMC 政策金利発表",
    country: "US",
    category: "fed",
    impact: 100,
    time: "14:00",
    duration: 30,
    schedule: {
      type: "none"
    },
    url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    why: "ナスダックの実質的な主役。政策金利とドットチャートは長期金利を通じて 高PER・高デュレーション銘柄の割引率を直撃する。",
    match: ["fed interest rate decision", "fomc statement"]
  },
  {
    id: "us_fomc_presser",
    name: "FOMC 議長記者会見",
    country: "US",
    category: "fed",
    impact: 96,
    time: "14:30",
    duration: 60,
    schedule: {
      type: "none"
    },
    why: "声明文よりも会見のトーンで相場が反転することが多い。会見中の値動きが その日のナスダックの引け値を決めるケースが頻繁にある。",
    match: ["fomc press conference"]
  },
  {
    id: "us_fomc_minutes",
    name: "FOMC 議事要旨",
    country: "US",
    category: "fed",
    impact: 78,
    time: "14:00",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "会合3週間後に公表。委員のタカ/ハト分布が判明し利下げ織り込みが動く。",
    match: ["fomc meeting minutes"]
  },
  {
    id: "us_beige_book",
    name: "ベージュブック (地区連銀経済報告)",
    country: "US",
    category: "fed",
    impact: 56,
    time: "14:00",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "FOMC 2週間前公表。景況感の定性評価で会合前のポジション調整材料になる。",
    match: ["beige book"]
  },
  {
    id: "us_fed_speech",
    name: "FRB高官 発言",
    country: "US",
    category: "fed",
    impact: 76,
    time: "12:00",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "特に議長・副議長・NY連銀総裁の発言は会合間の織り込みを動かす。 ブラックアウト期間外は突発的に相場を動かす最大要因のひとつ。",
    match: ["fed .*(speaks|speech)", "powell speaks", "fomc member .* speaks"]
  },
  {
    id: "us_cpi",
    name: "米 消費者物価指数 (CPI)",
    country: "US",
    category: "inflation",
    impact: 98,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 12,
      exact: false
    },
    fred_release: "^Consumer Price Index$",
    url: "https://www.bls.gov/cpi/",
    why: "単日のナスダック変動幅が最も大きくなりやすい指標。コア前月比が予想を 0.1pt 外すだけで指数が 1-2% 動くことがある。特にコア CPI に注目。",
    match: ["core cpi", "^cpi \\(", "consumer price index"]
  },
  {
    id: "us_pce",
    name: "米 PCE デフレータ (個人所得・支出)",
    country: "US",
    category: "inflation",
    impact: 92,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 27,
      exact: false
    },
    fred_release: "^Personal Income and Outlays$",
    why: "FRB が政策判断で最重視するインフレ指標。コア PCE 前年比が 2% 目標へ どれだけ近づいたかで利下げ観測が動く。CPI/PPI から概ね推定できるため サプライズは小さめだが、乖離した時の反応は大きい。",
    match: ["core pce price index", "pce price index", "personal spending"]
  },
  {
    id: "us_ppi",
    name: "米 生産者物価指数 (PPI)",
    country: "US",
    category: "inflation",
    impact: 80,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 13,
      exact: false
    },
    fred_release: "Producer Price Index",
    why: "CPI の翌日前後に出る川上インフレ。PCE 算出に使われる項目を含むため、 CPI 後のコア PCE 予想を書き換えて二次的に相場を動かす。",
    match: ["^ppi", "core ppi", "producer price index"]
  },
  {
    id: "us_nfp",
    name: "米 雇用統計 (非農業部門雇用者数)",
    country: "US",
    category: "labor",
    impact: 96,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "nth_weekday",
      weekday: "fri",
      n: 1,
      exact: false
    },
    fred_release: "^Employment Situation$",
    url: "https://www.bls.gov/news.release/empsit.toc.htm",
    why: "CPI と並ぶ二大イベント。NFP・失業率・平均時給の3点セットで、賃金インフレ と景気減速の綱引きを同時に判定される。強すぎても弱すぎても売られる局面あり。",
    match: ["nonfarm payrolls", "unemployment rate", "average hourly earnings"]
  },
  {
    id: "us_jobless_claims",
    name: "米 新規失業保険申請件数",
    country: "US",
    category: "labor",
    impact: 75,
    time: "08:30",
    duration: 15,
    schedule: {
      type: "weekly",
      weekday: "thu",
      exact: true
    },
    fred_release: "Unemployment Insurance Weekly Claims",
    why: "唯一の週次高頻度雇用データ。労働市場の転換点をいち早く映すため、景気後退 懸念が高まる局面では月次指標より材料視される。",
    match: ["initial jobless claims", "continuing jobless claims"]
  },
  {
    id: "us_jolts",
    name: "米 JOLTS 求人件数",
    country: "US",
    category: "labor",
    impact: 75,
    time: "10:00",
    duration: 30,
    period_offset: -2,
    schedule: {
      type: "day_of_month",
      day: 9,
      exact: false
    },
    fred_release: "Job Openings and Labor Turnover",
    why: "求人/失業者比率は FRB が需給逼迫の判断に使う。労働需要の減速確認に有効。",
    match: ["jolts job openings"]
  },
  {
    id: "us_adp",
    name: "米 ADP 雇用統計",
    country: "US",
    category: "labor",
    impact: 68,
    time: "08:15",
    duration: 15,
    period_offset: -1,
    schedule: {
      type: "nth_weekday",
      weekday: "wed",
      n: 1,
      exact: false
    },
    why: "NFP の2日前に出る民間版。NFP との相関は高くないが、直後の NFP 予想を修正させるため短期のポジション調整を誘発する。",
    match: ["adp nonfarm employment"]
  },
  {
    id: "us_eci",
    name: "米 雇用コスト指数 (ECI)",
    country: "US",
    category: "labor",
    impact: 66,
    time: "08:30",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "fri",
      n: -1,
      months: [1, 4, 7, 10],
      exact: false
    },
    fred_release: "Employment Cost Index",
    why: "四半期ベースで最も精度の高い賃金指標。賃金インフレの粘着性判定に使われる。",
    match: ["employment cost index"]
  },
  {
    id: "us_ism_services",
    name: "米 ISM 非製造業景況指数",
    country: "US",
    category: "sentiment",
    impact: 82,
    time: "10:00",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "nth_business_day",
      n: 3,
      exact: true
    },
    why: "米国 GDP の約7割を占めるサービス業の体温計。支払価格指数がインフレの 先行指標として同時に注目される。50 割れは景気後退シグナル。",
    match: ["ism non-manufacturing", "ism services pmi"]
  },
  {
    id: "us_ism_mfg",
    name: "米 ISM 製造業景況指数",
    country: "US",
    category: "sentiment",
    impact: 80,
    time: "10:00",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "nth_business_day",
      n: 1,
      exact: true
    },
    why: "月初一番手の景況感指標で、その月の相場基調を作りやすい。半導体など ハイテク製造業の受注サイクルとも連動する。",
    match: ["ism manufacturing pmi"]
  },
  {
    id: "us_spglobal_pmi_flash",
    name: "米 S&P グローバル PMI 速報値",
    country: "US",
    category: "sentiment",
    impact: 72,
    time: "09:45",
    duration: 30,
    schedule: {
      type: "day_of_month",
      day: 23,
      exact: false
    },
    why: "当月分を月内に速報する唯一の景況感指標。ISM より2週間早く方向感が出る。",
    match: ["s&p global .*pmi", "manufacturing pmi", "services pmi"]
  },
  {
    id: "us_conf_board_confidence",
    name: "米 消費者信頼感指数 (コンファレンスボード)",
    country: "US",
    category: "sentiment",
    impact: 68,
    time: "10:00",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "tue",
      n: -1,
      exact: true
    },
    why: "雇用の「十分/不十分」判断が失業率の先行指標として機能する。個人消費の先読み材料。",
    match: ["cb consumer confidence"]
  },
  {
    id: "us_umich_prelim",
    name: "米 ミシガン大 消費者態度指数 速報値",
    country: "US",
    category: "sentiment",
    impact: 76,
    time: "10:00",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "fri",
      n: 2,
      exact: false
    },
    why: "本体よりも同時発表の「期待インフレ率(1年先/5-10年先)」が重要。 2022年6月のように、この数字だけで FRB の利上げ幅が変わった前例がある。",
    match: ["michigan consumer sentiment", "michigan .*expectations"]
  },
  {
    id: "us_umich_final",
    name: "米 ミシガン大 消費者態度指数 確報値",
    country: "US",
    category: "sentiment",
    impact: 58,
    time: "10:00",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "fri",
      n: -1,
      exact: false
    },
    why: "速報からの改定幅、特に期待インフレ率の修正が確認される。",
    match: ["michigan consumer sentiment"]
  },
  {
    id: "us_philly_fed",
    name: "米 フィラデルフィア連銀 製造業景況指数",
    country: "US",
    category: "sentiment",
    impact: 58,
    time: "08:30",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "thu",
      n: 3,
      exact: false
    },
    why: "ISM 製造業の先行指標として月中に方向感を与える地区連銀サーベイ。",
    match: ["philadelphia fed manufacturing"]
  },
  {
    id: "us_empire_state",
    name: "米 NY連銀 製造業景気指数",
    country: "US",
    category: "sentiment",
    impact: 55,
    time: "08:30",
    duration: 30,
    schedule: {
      type: "day_of_month",
      day: 15,
      exact: false
    },
    why: "月内で最初に出る地区連銀サーベイ。振れは大きいが方向感の初動を示す。",
    match: ["ny empire state manufacturing"]
  },
  {
    id: "us_chicago_pmi",
    name: "米 シカゴ購買部協会景気指数 (PMI)",
    country: "US",
    category: "sentiment",
    impact: 52,
    time: "09:45",
    duration: 30,
    schedule: {
      type: "nth_business_day",
      n: -1,
      exact: false
    },
    why: "翌営業日の ISM 製造業の先行指標。月末リバランスの日と重なりやすい。",
    match: ["chicago pmi"]
  },
  {
    id: "us_retail_sales",
    name: "米 小売売上高",
    country: "US",
    category: "growth",
    impact: 80,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 15,
      exact: false
    },
    fred_release: "Advance Monthly Sales for Retail",
    why: "GDP の7割を占める個人消費の実測値。アマゾンなど EC 関連の業績観にも 直結し、「消費は堅調 → 利下げ後退」という金利経路でも効く。",
    match: ["^retail sales", "core retail sales"]
  },
  {
    id: "us_gdp",
    name: "米 GDP (速報/改定/確報)",
    country: "US",
    category: "growth",
    impact: 78,
    time: "08:30",
    duration: 30,
    schedule: {
      type: "day_of_month",
      day: 26,
      exact: false
    },
    fred_release: "^Gross Domestic Product$",
    why: "同時発表のコア PCE 価格指数(四半期)がしばしば本体より材料視される。 速報値のインパクトが最大で、改定・確報の反応は限定的。",
    match: ["^gdp \\(", "gdp price index"]
  },
  {
    id: "us_durable_goods",
    name: "米 耐久財受注",
    country: "US",
    category: "growth",
    impact: 60,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 26,
      exact: false
    },
    fred_release: "Advance Report on Durable Goods",
    why: "コア資本財受注が企業設備投資の先行指標。半導体・産業機械の需要観に効く。",
    match: ["durable goods orders", "core durable goods"]
  },
  {
    id: "us_industrial_production",
    name: "米 鉱工業生産",
    country: "US",
    category: "growth",
    impact: 55,
    time: "09:15",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 16,
      exact: false
    },
    fred_release: "Industrial Production and Capacity Utilization",
    why: "製造業の実体活動。設備稼働率は供給側インフレ圧力の目安になる。",
    match: ["industrial production"]
  },
  {
    id: "us_trade_balance",
    name: "米 貿易収支",
    country: "US",
    category: "trade",
    impact: 45,
    time: "08:30",
    duration: 30,
    period_offset: -2,
    schedule: {
      type: "nth_business_day",
      n: 5,
      exact: false
    },
    fred_release: "U.S. International Trade in Goods and Services",
    why: "GDP 寄与度の修正材料。関税政策が焦点の局面では注目度が上がる。",
    match: ["trade balance"]
  },
  {
    id: "us_housing_starts",
    name: "米 住宅着工件数",
    country: "US",
    category: "housing",
    impact: 52,
    time: "08:30",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 17,
      exact: false
    },
    fred_release: "New Residential Construction",
    why: "住宅は金利感応度が最も高いセクター。利上げ/利下げの実体経済への波及を測る。",
    match: ["housing starts", "building permits"]
  },
  {
    id: "us_existing_home_sales",
    name: "米 中古住宅販売件数",
    country: "US",
    category: "housing",
    impact: 48,
    time: "10:00",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 21,
      exact: false
    },
    fred_release: "Existing Home Sales",
    why: "住宅市場全体の約9割を占める。住宅ローン金利の実需への影響を確認する。",
    match: ["existing home sales"]
  },
  {
    id: "us_new_home_sales",
    name: "米 新築住宅販売件数",
    country: "US",
    category: "housing",
    impact: 46,
    time: "10:00",
    duration: 30,
    period_offset: -1,
    schedule: {
      type: "day_of_month",
      day: 24,
      exact: false
    },
    fred_release: "New Residential Sales",
    why: "契約ベースのため中古住宅より足の速い住宅指標。",
    match: ["new home sales"]
  },
  {
    id: "us_construction_spending",
    name: "米 建設支出",
    country: "US",
    category: "growth",
    impact: 40,
    time: "10:00",
    duration: 30,
    period_offset: -2,
    schedule: {
      type: "nth_business_day",
      n: 1,
      exact: false
    },
    why: "データセンター投資を含む非住宅建設が AI 設備投資サイクルの参考になる。",
    match: ["construction spending"]
  },
  {
    id: "us_productivity",
    name: "米 労働生産性・単位労働コスト",
    country: "US",
    category: "labor",
    impact: 48,
    time: "08:30",
    duration: 30,
    schedule: {
      type: "day_of_month",
      day: 7,
      months: [2, 5, 8, 11],
      exact: false
    },
    fred_release: "Productivity and Costs",
    why: "単位労働コストは賃金インフレが企業に転嫁されるかの指標。AI による 生産性向上が本物かを検証する数字としても注目され始めている。",
    match: ["unit labor costs", "nonfarm productivity"]
  },
  {
    id: "us_treasury_auction_10y",
    name: "米 10年国債入札",
    country: "US",
    category: "rates",
    impact: 66,
    time: "13:00",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "wed",
      n: 2,
      exact: false
    },
    why: "2023年秋のように、入札の不調(テール拡大)が長期金利を跳ね上げて ナスダックを直接叩く場面がある。需給イベントとして無視できない。",
    match: ["10-year note auction"]
  },
  {
    id: "us_treasury_auction_30y",
    name: "米 30年国債入札",
    country: "US",
    category: "rates",
    impact: 62,
    time: "13:00",
    duration: 30,
    schedule: {
      type: "nth_weekday",
      weekday: "thu",
      n: 2,
      exact: false
    },
    why: "最も需給が緩みやすい年限。長期金利の期間プレミアム拡大の起点になりやすい。",
    match: ["30-year bond auction"]
  },
  {
    id: "jp_boj_decision",
    name: "日銀 金融政策決定会合 結果",
    country: "JP",
    category: "fed",
    impact: 58,
    // 発表は 11:30〜12:30 JST のあいだで揺れる。中央値として 12:00 を置く。
    time: "12:00",
    duration: 90,
    schedule: {
      type: "none"
    },
    tz: "Asia/Tokyo",
    why: "円キャリー取引の巻き戻しを通じてナスダックに波及する。2024年8月の 急落のように、日銀のサプライズは米ハイテク株の需給を直撃しうる。",
    match: ["boj interest rate decision", "boj policy rate"]
  },
  {
    id: "eu_ecb_decision",
    name: "ECB 政策金利発表",
    country: "EU",
    category: "fed",
    impact: 50,
    // 現地 14:15。米東部時間で持つと、米欧の夏時間切替がずれる春先に
    // 1時間ずれるので、必ず欧州のタイムゾーンで持つ。
    time: "14:15",
    tz: "Europe/Berlin",
    duration: 60,
    schedule: {
      type: "none"
    },
    why: "世界的な金融環境の方向感を左右する。FRB との政策金利差はドル需給に効く。",
    match: ["ecb .*rate decision", "deposit facility rate"]
  },
  {
    id: "cn_pmi",
    name: "中国 製造業 PMI (国家統計局)",
    country: "CN",
    category: "sentiment",
    impact: 42,
    time: "09:30",
    tz: "Asia/Shanghai",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "半導体・ハードウェアの最終需要と、アップルなどのサプライチェーン観に影響。",
    match: ["chinese manufacturing pmi", "caixin manufacturing pmi"]
  },
  {
    id: "market_holiday",
    name: "米国株式市場 休場",
    country: "US",
    category: "market",
    impact: 60,
    all_day: true,
    schedule: {
      type: "none"
    },
    why: "休場日は前後の流動性が落ち、ギャップが出やすい。日本時間の取引計画に必要。"
  },
  {
    id: "market_early_close",
    name: "米国株式市場 短縮取引",
    country: "US",
    category: "market",
    impact: 45,
    time: "13:00",
    duration: 15,
    schedule: {
      type: "none"
    },
    why: "出来高が細り値動きが荒くなる。指値の置き方を変えるべき日。"
  },
  {
    id: "market_quad_witching",
    name: "クアドラプル・ウィッチング (四半期 SQ)",
    country: "US",
    category: "market",
    impact: 70,
    time: "09:30",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "先物・オプションの同時清算で出来高が通常の2-3倍に膨らむ。指数の 需給が歪み、前後数日でトレンドが転換することがある。"
  },
  {
    id: "market_opex",
    name: "米 月例オプション満期 (OPEX)",
    country: "US",
    category: "market",
    impact: 45,
    time: "09:30",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "ガンマの剥落で満期週明けにボラティリティが上がりやすい。"
  },
  {
    id: "market_index_rebalance",
    name: "指数リバランス (S&P/Nasdaq-100)",
    country: "US",
    category: "market",
    impact: 58,
    time: "16:00",
    duration: 30,
    schedule: {
      type: "none"
    },
    why: "パッシブ資金の売買が引けに集中する。銘柄入替の思惑も出来高を押し上げる。"
  },
];

// ═══════════════════════════════════════════════════════════
// 02_meetings.js
// ═══════════════════════════════════════════════════════════

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
      { date: '2026-01-28', sep: false },
      { date: '2026-03-18', sep: true },
      { date: '2026-04-29', sep: false },
      { date: '2026-06-17', sep: true },
      { date: '2026-07-29', sep: false },
      { date: '2026-09-16', sep: true },
      { date: '2026-10-28', sep: false },
      { date: '2026-12-09', sep: true }
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

// ═══════════════════════════════════════════════════════════
// 03_util.js
// ═══════════════════════════════════════════════════════════

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
    // 対になっていないサロゲートは UTF-8 で表せない。標準の変換器と同じく
    // U+FFFD に置き換える（そのまま符号化すると他の実装と値がずれる）。
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
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

// ═══════════════════════════════════════════════════════════
// 04_schedule.js
// ═══════════════════════════════════════════════════════════

/**
 * 米国の休日カレンダーと、発表日の繰り返しルール。
 *
 * 日付は「UTC 深夜の Date」で持ち回る。実行環境のローカル時刻に一切
 * 依存させないための約束事で、時刻を持つのは zonedTime_ を通したあとだけ。
 * 曜日は Python 版に合わせて月曜=0 で扱う。
 */

const ET = 'America/New_York';
const WEEKDAY_NUM = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const WEEKDAY_JA = ['月', '火', '水', '木', '金', '土', '日'];

// ---------------------------------------------------------------------------
// 日付の基本操作
// ---------------------------------------------------------------------------

function ymd_(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey_(date) {
  return date.getUTCFullYear() + '-' + pad2_(date.getUTCMonth() + 1) + '-' + pad2_(date.getUTCDate());
}

function parseDateKey_(text) {
  const parts = String(text).slice(0, 10).split('-');
  return ymd_(+parts[0], +parts[1], +parts[2]);
}

function addDays_(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/** 月曜=0 の曜日番号。 */
function weekdayOf_(date) {
  return (date.getUTCDay() + 6) % 7;
}

function daysBetween_(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function lastDayOfMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// タイムゾーン
// ---------------------------------------------------------------------------

/**
 * ある瞬間における、そのタイムゾーンの UTC からのずれ（分）。
 * Intl を主経路にしているのは、Node のテストで検証できる形を保つため。
 */
function tzOffsetMinutes_(instant, timezone) {
  try {
    const parts = tzParts_(instant, timezone);
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day,
                           parts.hour, parts.minute, parts.second);
    return Math.round((asUTC - instant.getTime()) / 60000);
  } catch (err) {
    // Intl が使えない環境向けの保険（GAS 標準 API）。
    const text = Utilities.formatDate(instant, timezone, 'Z');  // 例 "-0400"
    const sign = text.charAt(0) === '-' ? -1 : 1;
    return sign * (parseInt(text.substr(1, 2), 10) * 60 + parseInt(text.substr(3, 2), 10));
  }
}

function tzParts_(instant, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  formatter.formatToParts(instant).forEach(function (part) {
    if (part.type !== 'literal') out[part.type] = parseInt(part.value, 10);
  });
  // ICU の版によっては真夜中を 24 時と返す。ここで 0 に寄せておかないと
  // 呼び出し側それぞれで % 24 を書く羽目になり、書き忘れが必ず起きる。
  out.hour = out.hour % 24;
  return out;
}

/**
 * 「その日の HH:MM（指定タイムゾーンの壁時計）」を実際の瞬間に変換する。
 * ずれの分だけ戻したあと、境界（夏時間の切替日）で答えが変わる場合に
 * もう一度補正するので、切替日でも正しい値になる。
 */
function zonedTime_(date, hhmm, timezone) {
  const bits = String(hhmm).split(':');
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
                        parseInt(bits[0], 10), parseInt(bits[1], 10));
  const first = tzOffsetMinutes_(new Date(wall), timezone);
  let instant = new Date(wall - first * 60000);
  const second = tzOffsetMinutes_(instant, timezone);
  if (second !== first) instant = new Date(wall - second * 60000);
  return instant;
}

/** ある瞬間を、指定タイムゾーンでの「日付（UTC深夜の Date）」に落とす。 */
function localDate_(instant, timezone) {
  const parts = tzParts_(instant, timezone);
  return ymd_(parts.year, parts.month, parts.day);
}

// ---------------------------------------------------------------------------
// 祝日
// ---------------------------------------------------------------------------

/** グレゴリオ暦の復活祭（Meeus のアルゴリズム）。グッドフライデーの算出用。 */
function easter_(year) {
  const a = year % 19;
  const b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd_(year, month, day);
}

/** 月の第 n 曜日。n が負なら最後から数える（-1 = 最終）。 */
function nthWeekday_(year, month, weekday, n) {
  if (n < 0) {
    let date = ymd_(year, month, lastDayOfMonth_(year, month));
    while (weekdayOf_(date) !== weekday) date = addDays_(date, -1);
    return date;
  }
  let date = ymd_(year, month, 1);
  date = addDays_(date, (weekday - weekdayOf_(date) + 7) % 7);
  return addDays_(date, (n - 1) * 7);
}

/** 連邦の振替ルール：土曜は前日の金曜、日曜は翌日の月曜。 */
function observed_(date) {
  const weekday = weekdayOf_(date);
  if (weekday === 5) return addDays_(date, -1);
  if (weekday === 6) return addDays_(date, 1);
  return date;
}

/** 統計局が閉まる連邦休日。 */
function federalHolidays_(year) {
  const out = {};
  out[dateKey_(observed_(ymd_(year, 1, 1)))] = '元日';
  out[dateKey_(nthWeekday_(year, 1, WEEKDAY_NUM.mon, 3))] = 'キング牧師記念日';
  out[dateKey_(nthWeekday_(year, 2, WEEKDAY_NUM.mon, 3))] = '大統領の日';
  out[dateKey_(nthWeekday_(year, 5, WEEKDAY_NUM.mon, -1))] = '戦没者追悼記念日';
  out[dateKey_(observed_(ymd_(year, 6, 19)))] = 'ジューンティーンス';
  out[dateKey_(observed_(ymd_(year, 7, 4)))] = '独立記念日';
  out[dateKey_(nthWeekday_(year, 9, WEEKDAY_NUM.mon, 1))] = 'レイバーデー';
  out[dateKey_(nthWeekday_(year, 10, WEEKDAY_NUM.mon, 2))] = 'コロンブスデー';
  out[dateKey_(observed_(ymd_(year, 11, 11)))] = 'ベテランズデー';
  out[dateKey_(nthWeekday_(year, 11, WEEKDAY_NUM.thu, 4))] = '感謝祭';
  out[dateKey_(observed_(ymd_(year, 12, 25)))] = 'クリスマス';
  return out;
}

/**
 * NYSE / ナスダックの終日休場。
 * 連邦休日とは違い、コロンブスデーとベテランズデーは取引があり、
 * 代わりにグッドフライデーが休みになる。元日が土曜のときは前日の金曜を
 * 休場にしない点も連邦ルールと異なる。
 */
function marketHolidays_(year) {
  const raw = {};
  raw[dateKey_(nthWeekday_(year, 1, WEEKDAY_NUM.mon, 3))] = 'キング牧師記念日';
  raw[dateKey_(nthWeekday_(year, 2, WEEKDAY_NUM.mon, 3))] = '大統領の日';
  raw[dateKey_(addDays_(easter_(year), -2))] = 'グッドフライデー';
  raw[dateKey_(nthWeekday_(year, 5, WEEKDAY_NUM.mon, -1))] = '戦没者追悼記念日';
  raw[dateKey_(observed_(ymd_(year, 6, 19)))] = 'ジューンティーンス';
  raw[dateKey_(observed_(ymd_(year, 7, 4)))] = '独立記念日';
  raw[dateKey_(nthWeekday_(year, 9, WEEKDAY_NUM.mon, 1))] = 'レイバーデー';
  raw[dateKey_(nthWeekday_(year, 11, WEEKDAY_NUM.thu, 4))] = '感謝祭';
  raw[dateKey_(observed_(ymd_(year, 12, 25)))] = 'クリスマス';

  const newYear = ymd_(year, 1, 1);
  if (weekdayOf_(newYear) !== 5) raw[dateKey_(observed_(newYear))] = '元日';

  const out = {};
  Object.keys(raw).forEach(function (key) {
    if (weekdayOf_(parseDateKey_(key)) < 5) out[key] = raw[key];
  });
  return out;
}

/** 13:00 ET で引ける半日。 */
function marketEarlyCloses_(year) {
  const raw = {};
  const july3 = ymd_(year, 7, 3);
  if (weekdayOf_(july3) < 5 && weekdayOf_(ymd_(year, 7, 4)) < 5) {
    raw[dateKey_(july3)] = '独立記念日前日';
  }
  raw[dateKey_(addDays_(nthWeekday_(year, 11, WEEKDAY_NUM.thu, 4), 1))] = '感謝祭翌日';
  const dec24 = ymd_(year, 12, 24);
  if (weekdayOf_(dec24) < 5) raw[dateKey_(dec24)] = 'クリスマスイブ';

  const holidays = marketHolidays_(year);
  const out = {};
  Object.keys(raw).forEach(function (key) {
    if (!holidays[key]) out[key] = raw[key];
  });
  return out;
}

function isBusinessDay_(date, holidays) {
  if (weekdayOf_(date) >= 5) return false;
  const table = holidays || federalHolidays_(date.getUTCFullYear());
  return !table[dateKey_(date)];
}

function nextBusinessDay_(date) {
  let out = date;
  while (!isBusinessDay_(out)) out = addDays_(out, 1);
  return out;
}

function businessDaysInMonth_(year, month) {
  const holidays = federalHolidays_(year);
  const out = [];
  const last = lastDayOfMonth_(year, month);
  for (let day = 1; day <= last; day++) {
    const date = ymd_(year, month, day);
    if (isBusinessDay_(date, holidays)) out.push(date);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 繰り返しルール
// ---------------------------------------------------------------------------

/**
 * ルールを [start, end] の範囲の具体的な日付に展開する。
 *
 *   nth_business_day  月の第 n 営業日（負なら末尾から。-1 = 最終営業日）
 *   nth_weekday       月の第 n 曜日（-1 = 最終）
 *   day_of_month      固定日。休日なら翌営業日へずらす
 *   weekly            毎週その曜日。祝日に当たる週は前倒し（失業保険の挙動）
 */
function ruleDates_(rule, start, end) {
  const kind = (rule && rule.type) || 'none';
  if (kind === 'none') return [];
  const months = rule.months || null;
  const seen = {};
  const out = [];

  function push(date) {
    if (!date) return;
    if (date.getTime() < start.getTime() || date.getTime() > end.getTime()) return;
    if (months && months.indexOf(date.getUTCMonth() + 1) === -1) return;
    const key = dateKey_(date);
    if (seen[key]) return;
    seen[key] = true;
    out.push(date);
  }

  if (kind === 'weekly') {
    const weekday = weekdayNumber_(rule.weekday || 'thu');
    let cursor = addDays_(start, (weekday - weekdayOf_(start) + 7) % 7);
    while (cursor.getTime() <= end.getTime()) {
      let candidate = cursor;
      // 週の中に祝日があると発表が前倒しになるので、休日なら手前へ寄せる。
      if (federalHolidays_(candidate.getUTCFullYear())[dateKey_(candidate)]) {
        candidate = addDays_(candidate, -1);
        while (!isBusinessDay_(candidate)) candidate = addDays_(candidate, -1);
      }
      push(candidate);
      cursor = addDays_(cursor, 7);
    }
    return sortDates_(out);
  }

  eachMonth_(start, end, function (year, month) {
    if (months && months.indexOf(month) === -1) return;
    if (kind === 'nth_business_day') {
      const days = businessDaysInMonth_(year, month);
      const n = rule.n === undefined ? 1 : rule.n;
      const index = n > 0 ? n - 1 : days.length + n;
      if (index >= 0 && index < days.length) push(days[index]);
    } else if (kind === 'nth_weekday') {
      const date = nthWeekday_(year, month, weekdayNumber_(rule.weekday || 'fri'),
                               rule.n === undefined ? 1 : rule.n);
      if (date.getUTCMonth() + 1 === month) push(date);
    } else if (kind === 'day_of_month') {
      push(businessDayNearDay_(year, month, Math.min(rule.day || 1, 28)));
    } else {
      throw new Error('未知のスケジュール種別: ' + kind);
    }
  });
  return sortDates_(out);
}

/**
 * 「その月の n 日ごろ」を、その月の中の営業日に落とす。
 *
 * 素直に翌営業日へ送ると、月末近くが週末に当たったときに翌月へはみ出し、
 * その月は0回・翌月は2回という並びになってしまう（PCE の 27 日など）。
 * 月をまたぐくらいなら手前の営業日に寄せる。
 */
function businessDayNearDay_(year, month, day) {
  const forward = nextBusinessDay_(ymd_(year, month, day));
  if (forward.getUTCMonth() + 1 === month) return forward;

  let backward = ymd_(year, month, day);
  while (!isBusinessDay_(backward) && backward.getUTCDate() > 1) {
    backward = addDays_(backward, -1);
  }
  return isBusinessDay_(backward) ? backward : forward;
}

/**
 * 曜日名を番号に直す。知らない名前は黙って0件にせず落とす。
 * 綴りを間違えたときに、その指標だけが何も言わずカレンダーから消えるのが
 * 一番たちが悪いので。
 */
function weekdayNumber_(name) {
  const value = WEEKDAY_NUM[String(name).toLowerCase()];
  if (value === undefined) {
    throw new Error('曜日の指定が不正です: ' + name
                    + '（mon/tue/wed/thu/fri/sat/sun のいずれか）');
  }
  return value;
}

function eachMonth_(start, end, callback) {
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    callback(year, month);
    if (month === 12) { year++; month = 1; } else { month++; }
  }
}

function sortDates_(dates) {
  return dates.slice().sort(function (a, b) { return a.getTime() - b.getTime(); });
}

// ═══════════════════════════════════════════════════════════
// 05_catalog.js
// ═══════════════════════════════════════════════════════════

/**
 * 指標カタログの照会。
 *
 * 外部の情報源はイベント名が自由文字列なので、カタログ側の正規表現で
 * 指標 id に名寄せする。長いパターンを先に試すことで "core cpi" が
 * 素の "cpi" より優先される。
 */

let CATALOG_CACHE_ = null;

function catalog_() {
  if (CATALOG_CACHE_) return CATALOG_CACHE_;
  const byId = {};
  const matchers = [];
  const fredMatchers = [];

  INDICATORS.forEach(function (indicator) {
    byId[indicator.id] = indicator;
    (indicator.match || []).forEach(function (pattern) {
      matchers.push({ re: new RegExp(pattern, 'i'), indicator: indicator, len: pattern.length });
    });
    if (indicator.fred_release) {
      fredMatchers.push({ re: new RegExp(indicator.fred_release, 'i'), indicator: indicator });
    }
  });
  matchers.sort(function (a, b) { return b.len - a.len; });

  CATALOG_CACHE_ = { byId: byId, matchers: matchers, fredMatchers: fredMatchers };
  return CATALOG_CACHE_;
}

function indicator_(id) {
  return catalog_().byId[id] || null;
}

function indicatorsWithRules_() {
  return INDICATORS.filter(function (indicator) {
    return indicator.schedule && indicator.schedule.type && indicator.schedule.type !== 'none';
  });
}

/**
 * 外部のイベント名を指標に名寄せする。
 *
 * 名前だけでは決められない組がある（ミシガン大の速報値と確報値は、
 * サイトによっては同じ「Michigan Consumer Sentiment」で出る）。
 * その場合は発表日で見分ける。速報は第2金曜、確報は最終金曜なので、
 * どちらの発表規則に近いかで確実に判別できる。
 *
 * @param {string} name  外部サイトのイベント名
 * @param {Date=} date   その発表の日付（UTC深夜）。あれば判別に使う
 */
function matchEventName_(name, date) {
  const matchers = catalog_().matchers;
  const hits = [];
  const seen = {};
  for (let i = 0; i < matchers.length; i++) {
    if (!matchers[i].re.test(name)) continue;
    const indicator = matchers[i].indicator;
    if (seen[indicator.id]) continue;
    seen[indicator.id] = true;
    hits.push(indicator);
  }
  if (!hits.length) return null;
  if (hits.length === 1 || !date) return hits[0];

  let best = null;
  let bestGap = Infinity;
  hits.forEach(function (indicator) {
    const gap = ruleDistanceDays_(indicator, date);
    if (gap !== null && gap < bestGap) {
      bestGap = gap;
      best = indicator;
    }
  });
  // 規則で見分けられなければ、より具体的なパターン（長い方）を採る。
  return best || hits[0];
}

function matchFredRelease_(name) {
  const matchers = catalog_().fredMatchers;
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].re.test(name)) return matchers[i].indicator;
  }
  return null;
}

function indicatorTimezone_(indicator) {
  return indicator.tz || ET;
}

function ruleIsExact_(indicator) {
  return !!(indicator.schedule && indicator.schedule.exact);
}

/** 発表月から対象期間のラベル（「2026年8月分」）を作る。 */
function periodLabel_(date, offset) {
  if (!offset) return null;
  const index = date.getUTCMonth() + offset;
  const year = date.getUTCFullYear() + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12 + 1;
  return year + '年' + month + '月分';
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

const TIERS = ['S', 'A', 'B', 'C'];

/**
 * その予定の「日付の根拠」。カレンダーに嘘を書かないための型。
 *
 *   official  一次情報源が公表した日程そのもの
 *             （FRED の発表日、Fed 公式ページの会合日程、Nasdaq の決算日）
 *   reported  第三者が集計したもの（Investing.com）。実務上は正確だが一次ではない
 *   rule      確定的な発表規則からの算出
 *             （ISM＝第1営業日、失業保険＝毎週木曜、取引所の休場ルールなど）
 *   estimated 概算、または人が書いたまま公式と照合していないもの
 *
 * 数字が大きいほど確か。合成のときはこの順で日付を採る。
 */
const CONFIDENCE_RANK = { official: 4, reported: 3, rule: 2, estimated: 1 };
const CONFIDENCE_LABEL = {
  official: '公式発表の日程',
  reported: '集計サイトの日程',
  rule: '発表規則から算出',
  estimated: '概算（未確定）',
};

function confidenceRank_(name) {
  return CONFIDENCE_RANK[name] || 0;
}

/** 件名に「未確定」と出すのはこれだけ。 */
function isEstimated_(event) {
  return event.confidence === 'estimated';
}

/** 情報源の優先順位。数字が大きいほど、衝突したときに勝つ。 */
const SOURCE_PRIORITY = {
  rules: 10,
  market: 20,
  fomc: 30,
  earnings: 40,
  // investing は予想・結果の数値を持つ唯一の情報源だが、日付の確度は公式
  // カレンダーである FRED に劣るので一段下に置く。mergeEvents_ が
  // 「日時は上位・空欄の値は下位から」で合成するのでこれで両取りになる。
  investing: 50,
  fred: 60,
  digest: 70,
};

function tierFor_(impact) {
  if (impact >= 90) return 'S';
  if (impact >= 75) return 'A';
  if (impact >= 55) return 'B';
  return 'C';
}

function makeEvent_(fields) {
  const event = {
    indicatorId: fields.indicatorId,
    title: fields.title,
    start: fields.start,
    end: fields.end,
    impact: Math.max(0, Math.min(100, fields.impact | 0)),
    country: fields.country || 'US',
    category: fields.category || 'other',
    source: fields.source || 'rules',
    allDay: !!fields.allDay,
    // 日付の根拠。指定が無いものは「概算」に倒す（過大に言わないため）。
    confidence: CONFIDENCE_RANK[fields.confidence] ? fields.confidence : 'estimated',
    // その情報源が「実際の発表時刻」を持っているか。
    // false のものはカタログの慣例値（8:30 ET など）を当てているだけなので、
    // 本物の時刻を持つ情報源が現れたらそちらに譲る。
    exactTime: !!fields.exactTime,
    period: fields.period || null,
    actual: fields.actual || null,
    forecast: fields.forecast || null,
    previous: fields.previous || null,
    note: fields.note || '',
    url: fields.url || null,
    extra: fields.extra || {},
  };
  if (!(event.start instanceof Date) || !(event.end instanceof Date)) {
    throw new Error(event.indicatorId + ': start/end は Date である必要があります');
  }
  if (event.end.getTime() < event.start.getTime()) {
    throw new Error(event.indicatorId + ': end が start より前です');
  }
  return event;
}

function eventTier_(event) {
  return tierFor_(event.impact);
}

/**
 * そのイベントが同期範囲に入るか。
 *
 * 判定は必ず「表示タイムゾーンでの日付」で行う。予定 ID も一覧取得の範囲も
 * 表示タイムゾーン基準なので、生成側だけ米東部の日付で判定すると、窓の端の
 * イベントが一覧に出てこず、毎回作り直しになる。
 */
function inDisplayWindow_(instant, ctx) {
  const day = localDate_(instant, ctx.timezone);
  return day.getTime() >= ctx.start.getTime() && day.getTime() <= ctx.end.getTime();
}

/** 表示日基準の同一性。1指標・1日でひとつ。 */
function eventUid_(event, timezone) {
  return event.indicatorId + '@' + dateKey_(localDate_(event.start, timezone));
}

/** カレンダーの予定 ID。base32hex（0-9a-v）しか使えない制約に合わせる。 */
function eventCalendarId_(event, timezone) {
  return 'ec' + base32hex_(sha1Bytes_(eventUid_(event, timezone)));
}

/** 表示に使う値だけのハッシュ。変化がなければ API を叩かないために使う。 */
function eventContentHash_(event) {
  const payload = [
    event.title, event.start.toISOString(), event.end.toISOString(), event.impact,
    event.allDay, event.confidence, event.period, event.actual, event.forecast,
    event.previous, event.note, event.url, event.source,
  ].join('|');
  return sha1Hex_(payload).slice(0, 16);
}

/**
 * 同じ発表についての2つの報告を合成する。
 * 上位の情報源が日時と同一性を決め、下位は「上位が持っていない値」だけを埋める。
 */
function mergeEvent_(a, b) {
  let high = a, low = b;
  if ((SOURCE_PRIORITY[b.source] || 0) > (SOURCE_PRIORITY[a.source] || 0)) {
    high = b; low = a;
  }
  const merged = Object.assign({}, high);
  ['actual', 'forecast', 'previous', 'period', 'url'].forEach(function (name) {
    if (!merged[name] && low[name]) merged[name] = low[name];
  });
  if (!merged.note && low.note) merged.note = low.note;
  // 日付は、根拠の確かな方を採る。情報源の優先順位とは別の軸で決める。
  // 例: ルール計算(rule)より FRED の公式日(official)が勝つ。
  if (confidenceRank_(low.confidence) > confidenceRank_(merged.confidence)) {
    merged.confidence = low.confidence;
    merged.start = low.start;
    merged.end = low.end;
  }
  // 時刻も同じ考え方で、本物を持っている方に譲る。
  // 例: FRED は発表「日」しか返さないので時刻はカタログの慣例値になる。
  // そこに実時刻を持つ情報源が来たら、日付は FRED、時刻はそちらを採る。
  // （合成は同じ表示日のもの同士でしか起きないので、日付はずれない）
  if (!merged.exactTime && low.exactTime) {
    merged.exactTime = true;
    merged.start = low.start;
    merged.end = low.end;
  }
  merged.extra = Object.assign({}, low.extra, high.extra);
  return merged;
}

// ═══════════════════════════════════════════════════════════
// 06_providers.js
// ═══════════════════════════════════════════════════════════

/**
 * 情報源。上から順に「通信不要 → 通信あり」。
 *
 * どのプロバイダも、取得できなければ空配列を返して静かに諦める。
 * ひとつ死んでも同期全体は続く（ルール計算だけでも実用的な予定表が出る）。
 */

// ---------------------------------------------------------------------------
// rules — 発表日をローカルで計算する。通信も API キーも要らない土台。
// ---------------------------------------------------------------------------

function providerRules_(ctx) {
  const events = [];
  // 米東部の日付と表示タイムゾーンの日付は最大1日ずれる。取りこぼさない
  // よう数日ぶん広げて展開し、最後に表示日で絞る。
  const from = addDays_(ctx.start, -3);
  const to = addDays_(ctx.end, 3);

  indicatorsWithRules_().forEach(function (indicator) {
    ruleDates_(indicator.schedule, from, to).forEach(function (date) {
      const start = zonedTime_(date, indicator.time, indicatorTimezone_(indicator));
      if (!inDisplayWindow_(start, ctx)) return;
      events.push(makeEvent_({
        indicatorId: indicator.id,
        title: indicator.name,
        start: start,
        end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
        impact: indicator.impact,
        country: indicator.country,
        category: indicator.category,
        source: 'rules',
        confidence: ruleIsExact_(indicator) ? 'rule' : 'estimated',
        period: periodLabel_(date, indicator.period_offset || 0),
        note: indicator.why,
        url: indicator.url,
      }));
    });
  });
  return events;
}

// ---------------------------------------------------------------------------
// fomc — 会合日程から、記者会見・議事要旨・ベージュブックを導出する。
// ---------------------------------------------------------------------------

const MINUTES_LAG_DAYS = 21;      // 議事要旨は会合2日目の3週間後
const AUTO_ORIGIN_NOTE =
  '\n\n※ この会合日程は Fed の公式ページから取得したものです。';
const BEIGE_BOOK_LEAD_DAYS = 14;  // ベージュブックは会合の2週間前

function providerFomc_(ctx) {
  const banks = {
    fomc: { rate: 'us_fomc_rate', presser: 'us_fomc_presser' },
    boj: { rate: 'jp_boj_decision', presser: null },
    ecb: { rate: 'eu_ecb_decision', presser: null },
  };
  const events = [];

  Object.keys(banks).forEach(function (bank) {
    allMeetings_(bank).forEach(function (meeting) {
      const day = parseDateKey_(meeting.date);
      const sep = !!meeting.sep;
      // 自動取得ぶんは、どこから来た日程かを説明文に残す。
      const origin = meeting.auto ? AUTO_ORIGIN_NOTE : '';
      // 会合日そのものの確からしさ。議事要旨などの派生は、そこから
      // 「3週間後」という慣例で導いているので rule 止まりにする。
      const base = meeting.confidence || 'estimated';
      const derived = confidenceRank_(base) > confidenceRank_('rule') ? 'rule' : base;

      const rate = indicator_(banks[bank].rate);
      if (!rate) return;
      let note = rate.why;
      if (sep) {
        note += '\n【ドットチャート公表回】経済見通し(SEP)が同時発表される会合。' +
                '利下げ回数の織り込みが一気に書き換わるため、通常会合より値動きが大きい。';
      }
      events.push(fomcEvent_(rate, day, rate.impact, note + origin, null,
                             { sep: sep, bank: bank, auto: !!meeting.auto }, base));

      const presser = banks[bank].presser ? indicator_(banks[bank].presser) : null;
      if (presser) {
        events.push(fomcEvent_(presser, day, Math.min(100, presser.impact + (sep ? 2 : 0)),
                               presser.why + origin, null,
                               { sep: sep, auto: !!meeting.auto }));
      }

      if (bank === 'fomc') {
        const minutes = indicator_('us_fomc_minutes');
        if (minutes) {
          events.push(fomcEvent_(minutes, addDays_(day, MINUTES_LAG_DAYS), minutes.impact,
                                 minutes.why + origin,
                                 day.getUTCFullYear() + '年' + (day.getUTCMonth() + 1) + '月' +
                                 day.getUTCDate() + '日会合分', null, derived));
        }
        const beige = indicator_('us_beige_book');
        if (beige) {
          events.push(fomcEvent_(beige, addDays_(day, -BEIGE_BOOK_LEAD_DAYS), beige.impact,
                                 beige.why + origin, null, null, derived));
        }
      }
    });
  });

  return events.filter(function (event) { return inDisplayWindow_(event.start, ctx); });
}

function fomcEvent_(indicator, day, impact, note, period, extra, confidence) {
  const start = zonedTime_(day, indicator.time, indicatorTimezone_(indicator));
  return makeEvent_({
    indicatorId: indicator.id,
    title: indicator.name,
    start: start,
    end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
    impact: impact,
    country: indicator.country,
    category: indicator.category,
    source: 'fomc',
    confidence: confidence || 'estimated',
    period: period || null,
    note: note,
    url: indicator.url,
    extra: extra || {},
  });
}

// ---------------------------------------------------------------------------
// market — 休場・短縮取引・SQ・指数リバランス。取引所のルールから計算する。
// ---------------------------------------------------------------------------

const QUARTER_MONTHS = [3, 6, 9, 12];

function providerMarket_(ctx) {
  const events = [];
  for (let year = ctx.start.getUTCFullYear(); year <= ctx.end.getUTCFullYear(); year++) {
    pushClosures_(events, year, ctx);
    pushExpiries_(events, year);
    pushRebalance_(events, year);
  }
  return events.filter(function (event) { return inDisplayWindow_(event.start, ctx); });
}

function pushClosures_(events, year, ctx) {
  const holiday = indicator_('market_holiday');
  if (holiday) {
    const table = marketHolidays_(year);
    Object.keys(table).forEach(function (key) {
      // 終日予定は表示タイムゾーンの深夜に置く。どの時差の人が見ても
      // 「米国の休場日」がその日付として出るようにするため。
      const start = zonedTime_(parseDateKey_(key), '00:00', ctx.timezone);
      events.push(makeEvent_({
        indicatorId: holiday.id,
        title: holiday.name + ' (' + table[key] + ')',
        start: start,
        end: new Date(start.getTime() + 86400000),
        impact: holiday.impact,
        country: holiday.country,
        category: holiday.category,
        source: 'market',
        confidence: 'rule',
        allDay: true,
        note: table[key] + ' のため NYSE・ナスダックは終日休場。\n' + holiday.why,
      }));
    });
  }

  const early = indicator_('market_early_close');
  if (early) {
    const table = marketEarlyCloses_(year);
    Object.keys(table).forEach(function (key) {
      const start = zonedTime_(parseDateKey_(key), early.time, ET);
      events.push(makeEvent_({
        indicatorId: early.id,
        title: early.name + ' (' + table[key] + ')',
        start: start,
        end: new Date(start.getTime() + (early.duration || 30) * 60000),
        impact: early.impact,
        country: early.country,
        category: early.category,
        source: 'market',
        confidence: 'rule',
        note: table[key] + ' のため 13:00 ET で取引終了。\n' + early.why,
      }));
    });
  }
}

function pushExpiries_(events, year) {
  for (let month = 1; month <= 12; month++) {
    const thirdFriday = nthWeekday_(year, month, WEEKDAY_NUM.fri, 3);
    const quad = QUARTER_MONTHS.indexOf(month) !== -1;
    const indicator = indicator_(quad ? 'market_quad_witching' : 'market_opex');
    if (!indicator) continue;
    const start = zonedTime_(thirdFriday, indicator.time, ET);
    let note = indicator.why;
    if (quad) {
      note += '\n同日に S&P500 の四半期リバランスも執行され、引けの出来高が跳ね上がる。';
    }
    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'market',
      confidence: 'rule',
      note: note,
    }));
  }
}

function pushRebalance_(events, year) {
  const indicator = indicator_('market_index_rebalance');
  if (!indicator) return;
  // ナスダック100の年次入替は12月第2金曜の引け後に発表され、
  // 第3金曜の引けでパッシブ資金が執行される。
  const announce = nthWeekday_(year, 12, WEEKDAY_NUM.fri, 2);
  const start = zonedTime_(announce, indicator.time, ET);
  events.push(makeEvent_({
    indicatorId: indicator.id,
    title: 'Nasdaq-100 年次銘柄入替 発表',
    start: start,
    end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
    impact: indicator.impact,
    country: indicator.country,
    category: indicator.category,
    source: 'market',
    confidence: 'rule',
    note: '引け後に構成銘柄の入替が発表される。翌週の第3金曜の引けで' +
          'パッシブ資金が執行され、対象銘柄は前後で大きく動く。\n' + indicator.why,
  }));
}

// ═══════════════════════════════════════════════════════════
// 07_providers_net.js
// ═══════════════════════════════════════════════════════════

/**
 * 通信を伴う情報源。取得できなければ空配列を返し、同期そのものは続行する。
 */

// ---------------------------------------------------------------------------
// FRED — セントルイス連銀が公開している「公式の発表日」。
// 日付だけを返してくるので、時刻はカタログの標準発表時刻を当てる。
// 無料 API キー: https://fred.stlouisfed.org/docs/api/api_key.html
// ---------------------------------------------------------------------------

const FRED_API = 'https://api.stlouisfed.org/fred';
const FRED_PAGE = 1000;

// 対応付けの誤りを「規則からの距離」で検知しようとしたが、成立しなかった。
// 週次規則からはどんな日付も最大4日、月次規則からも最大16日しか離れられず、
// 誤対応を見分けられる幅が残らない（実測して確認した）。
// 代わりに「ひとつの指標に複数の release 名が当たっていないか」で見る。
// 規則の当たり具合そのものは measureRuleAccuracy_ で別途測る。

function providerFred_(ctx) {
  const apiKey = prop_(PROP_FRED_KEY);
  if (!apiKey) {
    log_('FRED: API キー未設定のためスキップ（スクリプト プロパティ ' + PROP_FRED_KEY + '）');
    return [];
  }

  // 米東部の発表日と表示タイムゾーンの日付は1日ずれることがあるので、
  // 前後1日ぶん広く取ってから表示日で絞る。
  const rows = fredReleaseDates_(apiKey, addDays_(ctx.start, -1), addDays_(ctx.end, 1));
  if (rows === null) {
    // つながらなかっただけ。既に書き込んである公式日程を消させない。
    markSourceDown_('fred', 'FRED に接続できませんでした');
    return [];
  }

  const events = [];
  // ひとつの指標に複数の release 名が当たったら、正規表現が緩すぎる合図。
  // 関係ない発表日が「公式の日付」として混ざるので、見つけたら知らせる。
  const matchedNames = {};
  const suspicious = [];

  rows.forEach(function (row) {
    const name = row.release_name || '';
    if (!name) return;
    const indicator = matchFredRelease_(name);
    if (!indicator) return;
    const day = parseDateKey_(row.date);
    matchedNames[indicator.id] = matchedNames[indicator.id] || {};
    matchedNames[indicator.id][name] = true;
    const start = zonedTime_(day, indicator.time, indicatorTimezone_(indicator));
    if (!inDisplayWindow_(start, ctx)) return;
    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'fred',
      confidence: 'official',   // 統計局の公表日程そのもの
      period: periodLabel_(day, indicator.period_offset || 0),
      note: indicator.why,
      url: indicator.url,
      extra: { fredRelease: name },
    }));
  });
  Object.keys(matchedNames).forEach(function (id) {
    const names = Object.keys(matchedNames[id]);
    if (names.length > 1) {
      suspicious.push(id + ' ← ' + names.length + ' 種類の release に一致: '
                      + names.join(' / '));
    }
  });
  if (suspicious.length) {
    log_('FRED の対応付けに疑いがあります:\n  ' + suspicious.join('\n  '));
  }
  FRED_LAST_WARNINGS_ = suspicious;

  log_('FRED: ' + rows.length + ' 件中 ' + events.length + ' 件が該当');
  return events;
}

/** 直近の取得で見つかった、対応付けの疑い（データ品質の点検で使う）。 */
let FRED_LAST_WARNINGS_ = [];

function fredMatchWarnings_() {
  return FRED_LAST_WARNINGS_.slice();
}

/**
 * その指標の発表規則が予想する日と、実際の日付との最小の隔たり（日）。
 * 規則を持たない指標は判定できないので null を返す。
 */
function ruleDistanceDays_(indicator, day) {
  if (!indicator.schedule || !indicator.schedule.type
      || indicator.schedule.type === 'none') {
    return null;
  }
  const predicted = ruleDates_(indicator.schedule,
                               addDays_(day, -45), addDays_(day, 45));
  if (!predicted.length) return null;
  let best = Infinity;
  predicted.forEach(function (date) {
    best = Math.min(best, Math.abs(daysBetween_(date, day)));
  });
  return best;
}

/**
 * 発表規則がどれだけ当たっているかを、FRED の実績で測る。
 *
 * 「第1営業日」「毎週木曜」といった規則は人が書いたものなので、
 * 当たっているかどうかは測らないと分からない。過去の実際の発表日と
 * 突き合わせて、指標ごとの的中率とずれを出す。
 */
function measureRuleAccuracy_(months) {
  const apiKey = prop_(PROP_FRED_KEY);
  if (!apiKey) return null;

  const today = localDate_(new Date(), CONFIG.timezone);
  const from = addDays_(today, -30 * (months || 12));
  const rows = fredReleaseDates_(apiKey, from, today);
  if (rows === null) return null;

  const stats = {};
  rows.forEach(function (row) {
    const name = row.release_name || '';
    const indicator = name ? matchFredRelease_(name) : null;
    if (!indicator) return;
    const gap = ruleDistanceDays_(indicator, parseDateKey_(row.date));
    if (gap === null) return;
    const entry = stats[indicator.id]
      || (stats[indicator.id] = { id: indicator.id, name: indicator.name,
                                  samples: 0, exact: 0, total: 0, worst: 0 });
    entry.samples++;
    entry.total += gap;
    if (gap === 0) entry.exact++;
    if (gap > entry.worst) entry.worst = gap;
  });

  return Object.keys(stats).map(function (id) {
    const entry = stats[id];
    entry.meanGap = Math.round((entry.total / entry.samples) * 10) / 10;
    entry.exactRate = Math.round((entry.exact / entry.samples) * 100);
    return entry;
  }).sort(function (a, b) { return b.meanGap - a.meanGap; });
}

function fredReleaseDates_(apiKey, start, end) {
  const rows = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard++) {
    const url = FRED_API + '/releases/dates?' + [
      'api_key=' + encodeURIComponent(apiKey),
      'file_type=json',
      'realtime_start=' + dateKey_(start),
      'realtime_end=' + dateKey_(end),
      'include_release_dates_with_no_data=true',
      'sort_order=asc',
      'limit=' + FRED_PAGE,
      'offset=' + offset,
    ].join('&');

    const payload = fetchJson_(url);
    if (payload === null) return rows.length ? rows : null;
    const page = payload.release_dates || [];
    page.forEach(function (row) { rows.push(row); });
    offset += FRED_PAGE;
    if (page.length < FRED_PAGE || offset >= (payload.count || 0)) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// earnings — ナスダック100の主要銘柄の決算日。
// 指標ではないが、NVDA や AAPL の1本は多くのマクロ指標より指数を動かす。
// ---------------------------------------------------------------------------

const NASDAQ_EARNINGS = 'https://api.nasdaq.com/api/calendar/earnings?date=';
const EARNINGS_BATCH = 15;   // 実行時間の上限があるのでまとめて取りに行く

const EARNINGS_SESSIONS = {
  'time-pre-market': { time: '07:00', label: '寄り前' },
  'time-after-hours': { time: '16:15', label: '引け後' },
  'time-not-supplied': { time: '16:15', label: '時刻未定' },
};

function providerEarnings_(ctx) {
  const tickers = CONFIG.earningsTickers || {};
  if (!Object.keys(tickers).length) return [];

  // 16:15 ET の引け後決算は日本時間だと翌朝になる。窓の初日ぶんを取りこぼさない
  // よう、米東部の日付では前後1日ぶん多めに見て、最後に表示日で絞る。
  const days = [];
  const from = addDays_(ctx.start, -1);
  const to = addDays_(ctx.end, 1);
  for (let day = from; day.getTime() <= to.getTime(); day = addDays_(day, 1)) {
    if (weekdayOf_(day) < 5 && !federalHolidays_(day.getUTCFullYear())[dateKey_(day)]) {
      days.push(day);
    }
  }

  const events = [];
  let failures = 0;
  for (let i = 0; i < days.length; i += EARNINGS_BATCH) {
    const chunk = days.slice(i, i + EARNINGS_BATCH);
    const responses = fetchAllJson_(chunk.map(function (day) {
      return NASDAQ_EARNINGS + dateKey_(day);
    }));
    responses.forEach(function (payload, index) {
      if (payload === null) {
        failures++;
        // 取れなかった日の決算は「無い」のではなく「分からない」。
        markSourceDown_('earnings', '決算カレンダーの一部を取得できませんでした');
        return;
      }
      const rows = (payload.data && payload.data.rows) || [];
      rows.forEach(function (row) {
        const event = earningsEvent_(chunk[index], row, tickers);
        if (event && inDisplayWindow_(event.start, ctx)) events.push(event);
      });
    });
    if (failures >= EARNINGS_BATCH) {
      log_('決算カレンダーに繰り返し接続できないため中止しました');
      return events;
    }
  }
  log_('earnings: ' + events.length + ' 件');
  return events;
}

function earningsEvent_(day, row, tickers) {
  const symbol = String(row.symbol || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(tickers, symbol)) return null;

  const session = EARNINGS_SESSIONS[row.time] || EARNINGS_SESSIONS['time-not-supplied'];
  const start = zonedTime_(day, session.time, ET);
  const company = String(row.name || symbol).trim();
  const estimate = String(row.epsForecast || '').trim();

  return makeEvent_({
    indicatorId: 'earnings_' + symbol,
    title: symbol + ' 決算発表 (' + session.label + ')',
    start: start,
    end: new Date(start.getTime() + 30 * 60000),
    impact: tickers[symbol],
    country: 'US',
    category: 'earnings',
    source: 'earnings',
    confidence: 'official',   // 取引所の決算カレンダー由来
    period: String(row.fiscalQuarterEnding || '').trim() || null,
    forecast: estimate ? 'EPS予想 ' + estimate : null,
    note: company + ' の四半期決算。\n' +
          'ナスダック100の時価総額上位銘柄の決算は、指数そのものを動かす。' +
          '特にガイダンスと設備投資計画が半導体・AI関連セクター全体に波及する。',
    url: 'https://www.nasdaq.com/market-activity/stocks/' + symbol.toLowerCase() + '/earnings',
    extra: { symbol: symbol },
  });
}

/** 複数 URL をまとめて取得する。1件ずつ待つと実行時間の上限に当たるため。 */
function fetchAllJson_(urls) {
  const requests = urls.map(function (url) {
    return { url: url, muteHttpExceptions: true, followRedirects: true,
             headers: { Accept: 'application/json' } };
  });
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    log_('一括取得に失敗しました: ' + err);
    return urls.map(function () { return null; });
  }
  return responses.map(function (response) {
    try {
      if (response.getResponseCode() !== 200) return null;
      return JSON.parse(response.getContentText());
    } catch (err) {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// investing — 予想値・前回値・結果値。公式 API ではないので既定では無効。
// 数値が入る唯一の情報源だが、サイト側の変更で壊れうる。
// ---------------------------------------------------------------------------

const INVESTING_ENDPOINT =
  'https://www.investing.com/economic-calendar/Service/getCalendarFilteredData';
const INVESTING_COUNTRY_IDS = { US: 5, JP: 35, EU: 72, CN: 37, GB: 4, DE: 17 };

function providerInvesting_(ctx) {
  const countries = (CONFIG.filter.countries || []).filter(function (code) {
    return INVESTING_COUNTRY_IDS[code];
  });
  const payload = [];
  (countries.length ? countries : ['US']).forEach(function (code) {
    payload.push('country%5B%5D=' + INVESTING_COUNTRY_IDS[code]);
  });
  [1, 2, 3].forEach(function (level) { payload.push('importance%5B%5D=' + level); });
  payload.push('dateFrom=' + dateKey_(addDays_(ctx.start, -1)));
  payload.push('dateTo=' + dateKey_(addDays_(ctx.end, 1)));
  payload.push('timeZone=' + (CONFIG.investingTimezoneId || 55));
  payload.push('timeFilter=timeRemain');
  payload.push('currentTab=custom');
  payload.push('limit_from=0');

  const text = fetchText_(INVESTING_ENDPOINT, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload.join('&'),
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.investing.com/economic-calendar/',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  });
  if (text === null) {
    markSourceDown_('investing', 'Investing.com に接続できませんでした');
    return [];
  }

  let fragment;
  try {
    fragment = JSON.parse(text).data || '';
  } catch (err) {
    log_('Investing.com の応答を解釈できませんでした');
    markSourceDown_('investing', '応答を解釈できませんでした');
    return [];
  }
  return investingRowsToEvents_(parseInvestingRows_(fragment), ctx);
}

/**
 * 返ってくる HTML 断片から1行ずつ値を拾う。
 * 想定外のマークアップは黙って飛ばす方針（例外にしない）。
 */
function parseInvestingRows_(html) {
  const rows = [];
  const rowRe = /<tr[^>]*data-event-datetime="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const body = match[2];
    const name = pickText_(body, /<td[^>]*class="[^"]*\bevent\b[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!name) continue;
    const href = /<a[^>]+href="([^"]+)"/.exec(body);
    rows.push({
      datetime: match[1],
      name: name,
      actual: pickText_(body, /id="eventActual_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      forecast: pickText_(body, /id="eventForecast_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      previous: pickText_(body, /id="eventPrevious_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      url: href ? 'https://www.investing.com' + href[1] : null,
    });
  }
  return rows;
}

function pickText_(html, regex) {
  const match = regex.exec(html);
  if (!match) return null;
  const text = match[1]
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text && text !== '-' ? text : null;
}

function investingRowsToEvents_(rows, ctx) {
  const assumeTz = CONFIG.investingAssumeTz || 'UTC';
  const events = [];
  rows.forEach(function (row) {
    const start = parseInvestingDate_(row.datetime, assumeTz);
    if (!start) return;
    // 名前が同じ指標があるので、発表日も渡して見分けてもらう。
    const indicator = matchEventName_(row.name, localDate_(start, ctx.timezone));
    if (!indicator) return;
    if (!inDisplayWindow_(start, ctx)) return;

    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'investing',
      confidence: 'reported',   // 一次情報ではなく第三者の集計
      exactTime: true,   // サイトが実際の発表時刻を持っている
      period: investingPeriod_(row.name),
      actual: row.actual,
      forecast: row.forecast,
      previous: row.previous,
      note: indicator.why,
      url: row.url || indicator.url,
      extra: { rawName: row.name },
    }));
  });
  log_('investing: ' + events.length + ' 件');
  return events;
}

function parseInvestingDate_(text, timezone) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(String(text).trim());
  if (!match) return null;
  return zonedTime_(ymd_(+match[1], +match[2], +match[3]),
                    match[4] + ':' + match[5], timezone);
}

/** 「CPI (YoY) (Aug)」の末尾から対象期間を取り出す。 */
function investingPeriod_(name) {
  const match = /\(([A-Z][a-z]{2}(?:\/[A-Z][a-z]{2})?|Q[1-4])\)\s*$/.exec(name);
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════
// 08_fomc_auto.js
// ═══════════════════════════════════════════════════════════

/**
 * FOMC 会合日程の自動取得。
 *
 * 会合日程だけは計算では出せず、Fed が公表したものを読むしかない。
 * ここでは公式ページを読みに行くが、**手入力の日程（02_meetings.js）を
 * 上書きすることは絶対にしない**。埋めるのは「手入力が尽きた先の年」だけ。
 *
 * 相手は HTML なので、いつ形が変わってもおかしくない。そこで
 *
 *   抽出はゆるく、採用は厳しく
 *
 * という方針を取る。取り出したものが「FOMC の年間日程として辻褄が合うか」
 * （年8回前後・すべて火〜木・間隔が5〜10週）を検査し、ひとつでも外れたら
 * 丸ごと捨てて、従来どおりメールで手入力を促す。
 * 間違った金利発表日が静かに入るくらいなら、何も入らない方がましなので。
 */

const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const PROP_FOMC_AUTO = '_fomcAuto';
const PROP_FOMC_AUTO_MAILED = '_fomcAutoMailed';
const PROP_FOMC_CONFLICT_MAILED = '_fomcConflictMailed';

/** 取得結果はこの日数だけ使い回す（毎回取りに行く必要はない）。 */
const FOMC_AUTO_TTL_DAYS = 7;

/** 何も採用できなかったときのキャッシュ期間。復旧に早く追随するため短くする。 */
const FOMC_AUTO_EMPTY_TTL_DAYS = 1;


/** 1回の実行のあいだは取得結果を使い回す（失敗も含めて1回で済ませる）。 */
let FOMC_AUTO_MEMO_ = null;

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** SEP（経済見通し）が公表される会合の月。アスタリスクが読めなかったときの当て。 */
const SEP_MONTHS = [3, 6, 9, 12];

// ---------------------------------------------------------------------------
// 手入力 ＋ 自動取得の合成
// ---------------------------------------------------------------------------

/**
 * その中央銀行の会合日程を返す。FOMC だけは、手入力が尽きた先の年を
 * 公式ページからの取得で補う。手入力がある年には一切手を触れない。
 */
function allMeetings_(bank) {
  const section = MEETINGS[bank] || {};
  const curated = (section.meetings || []).map(function (entry) {
    return {
      date: entry.date,
      sep: !!entry.sep,
      auto: false,
      // 人が書いたまま。公式と照合するまでは「未確定」として扱う。
      confidence: 'estimated',
    };
  });
  if (bank !== 'fomc' || !CONFIG.providers.fomcAutoFetch) return curated;
  return reconcileFomc_(curated, autoFomcMeetings_(curated));
}

/**
 * 手入力の日程を、公式ページから取った日程と突き合わせる。
 *
 *  一致した年   → その年は「公式で確認済み」に格上げする
 *  食い違った年 → **公式の方を採る**。手入力は人の記憶や写し間違いが入りうる
 *                 のに対し、こちらは検査を通った公式ページの記載だから。
 *                 そのうえで、どこがどう違うかをメールで知らせる。
 *  取れなかった年 → 手入力のまま（未確定の扱いを維持する）
 */
function reconcileFomc_(curated, auto) {
  const byYear = {};
  curated.forEach(function (entry) {
    const year = parseDateKey_(entry.date).getUTCFullYear();
    (byYear[year] = byYear[year] || []).push(entry);
  });

  const out = [];
  const conflicts = [];

  Object.keys(byYear).forEach(function (year) {
    const mine = byYear[year];
    const official = auto[year];
    if (!official || !official.length) {
      out.push.apply(out, mine);
      return;
    }
    const mineDates = mine.map(function (m) { return m.date; }).sort().join(',');
    const officialDates = official.map(function (m) { return m.date; }).sort().join(',');

    if (mineDates === officialDates) {
      mine.forEach(function (entry) {
        out.push({ date: entry.date, sep: entry.sep, auto: false, confidence: 'official' });
      });
      return;
    }
    conflicts.push({ year: year, mine: mineDates, official: officialDates });
    official.forEach(function (entry) {
      out.push({ date: entry.date, sep: entry.sep, auto: true, confidence: 'official' });
    });
  });

  // 手入力がまったく無い年は、そのまま自動取得ぶんを使う。
  Object.keys(auto).forEach(function (year) {
    if (byYear[year]) return;
    auto[year].forEach(function (entry) {
      out.push({ date: entry.date, sep: entry.sep, auto: true, confidence: 'official' });
    });
  });

  notifyFomcConflicts_(conflicts);
  return out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

/** 手入力と公式が食い違ったら、放置せずに知らせる（同じ内容は繰り返さない）。 */
function notifyFomcConflicts_(conflicts) {
  if (!conflicts.length) return false;
  const signature = conflicts.map(function (c) { return c.year + ':' + c.official; }).join('|');
  if (prop_(PROP_FOMC_CONFLICT_MAILED) === signature) return false;

  const body = [
    'FOMC の会合日程が、手入力（02_meetings.js）と Fed の公式ページで食い違いました。',
    'カレンダーには**公式ページの日程**を入れています。',
    '',
  ].concat(conflicts.map(function (c) {
    return [
      c.year + ' 年',
      '  手入力: ' + c.mine,
      '  公式  : ' + c.official,
    ].join('\n');
  })).concat([
    '',
    '02_meetings.js を公式に合わせて直してください。',
    '直すまでは毎回この照合が走り、公式の日程が使われます。',
    (MEETINGS.fomc.verify_url || ''),
  ]).join('\n');

  log_(body);
  sendMail_('[経済指標カレンダー] FOMC 日程が公式と食い違っています', body);
  postWebhook_(body);
  try {
    props_().setProperty(PROP_FOMC_CONFLICT_MAILED, signature);
  } catch (err) {
    log_('通知状態を保存できませんでした: ' + err);
  }
  return true;
}

/** 自動取得ぶんの会合日程（年 → 配列）。キャッシュ付き。 */
function autoFomcMeetings_(curated) {
  if (FOMC_AUTO_MEMO_) return FOMC_AUTO_MEMO_;
  const result = fetchAutoFomcMeetings_(curated);
  FOMC_AUTO_MEMO_ = result;
  return result;
}

function fetchAutoFomcMeetings_(curated) {
  const cached = readAutoCache_();
  const ttlDays = cached && !Object.keys(cached.years).length
    ? FOMC_AUTO_EMPTY_TTL_DAYS : FOMC_AUTO_TTL_DAYS;
  const fresh = cached && (Date.now() - cached.fetchedAt) < ttlDays * 86400000;
  if (fresh) return cached.years;

  const html = fetchText_(FOMC_CALENDAR_URL);
  if (html === null) {
    log_('FOMC 公式ページを取得できませんでした。手入力の日程だけで動きます。');
    markSourceDown_('fomc', 'Fed の公式ページに接続できませんでした');
    return cached ? cached.years : {};
  }

  let years;
  try {
    years = parseFomcCalendar_(html);
  } catch (err) {
    log_('FOMC 公式ページを解釈できませんでした: ' + err);
    markSourceDown_('fomc', '公式ページを解釈できませんでした');
    return cached ? cached.years : {};
  }

  const accepted = {};
  Object.keys(years).forEach(function (year) {
    const problem = validateFomcYear_(years[year], Number(year));
    if (problem) {
      log_('FOMC ' + year + ' 年の日程は検査に通らなかったので採用しません: ' + problem);
      return;
    }
    accepted[year] = years[year];
  });

  writeAutoCache_(accepted);
  maybeMailFomcSnippet_(accepted, curated);
  log_('FOMC 自動取得: ' + Object.keys(accepted).join(', ') + ' 年ぶんを採用');
  return accepted;
}

function readAutoCache_() {
  const raw = prop_(PROP_FOMC_AUTO);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.years ? parsed : null;
  } catch (err) {
    return null;
  }
}

function writeAutoCache_(years) {
  try {
    props_().setProperty(PROP_FOMC_AUTO,
                         JSON.stringify({ fetchedAt: Date.now(), years: years }));
  } catch (err) {
    log_('取得結果を保存できませんでした: ' + err);
  }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** タグを空白に潰して、日付らしき並びだけを拾える平文にする。 */
function htmlToText_(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, '-')
    .replace(/\s+/g, ' ');
}

/**
 * ページ全体から「YYYY 年の会合一覧」を取り出す。
 * クラス名には依存せず、"2027 FOMC Meetings" のような見出しを起点にする。
 */
function parseFomcCalendar_(html) {
  const text = htmlToText_(html);
  const headings = [];
  const headingRe = /(\d{4})\s+FOMC\s+Meetings/gi;
  let match;
  while ((match = headingRe.exec(text)) !== null) {
    headings.push({ year: Number(match[1]), index: match.index });
  }

  const out = {};
  headings.forEach(function (heading, i) {
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const meetings = parseFomcYear_(text.slice(heading.index, end), heading.year);
    if (meetings.length) out[heading.year] = meetings;
  });
  return out;
}

/**
 * 1年ぶんの "January 27-28" / "April/May 28-1*" のような並びを読む。
 * 政策金利が出るのは会合の最終日なので、範囲の後ろの日を採る。
 */
function parseFomcYear_(text, year) {
  const month = '(' + Object.keys(MONTH_NAMES).join('|') + ')';
  const re = new RegExp(
    month + '(?:\\s*/\\s*' + month + ')?\\s+(\\d{1,2})\\s*[-‐-―]\\s*(\\d{1,2})\\s*(\\*?)',
    'gi');

  const meetings = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const startMonth = MONTH_NAMES[match[1].toLowerCase()];
    const startDay = Number(match[3]);
    const endDay = Number(match[4]);
    let endMonth = match[2] ? MONTH_NAMES[match[2].toLowerCase()] : startMonth;
    // "April/May 28-1" のように月をまたぐ回。月名が1つしか無い場合でも
    // 終わりの日が始まりより小さければ翌月とみなす。
    if (!match[2] && endDay < startDay) endMonth = startMonth + 1;

    let endYear = year;
    if (endMonth > 12) { endMonth -= 12; endYear += 1; }

    meetings.push({
      date: dateKey_(ymd_(endYear, endMonth, endDay)),
      sep: match[5] === '*',
      starred: match[5] === '*',
      month: endMonth,
    });
  }

  // アスタリスクが読めていれば SEP はそれに従う。読めていなければ
  // 慣例（3/6/9/12月）で当てる。どちらでも注記の有無が変わるだけ。
  const starred = meetings.filter(function (m) { return m.starred; }).length;
  const trustStars = starred >= 3 && starred <= 5;
  return meetings.map(function (m) {
    return {
      date: m.date,
      sep: trustStars ? m.starred : SEP_MONTHS.indexOf(m.month) !== -1,
    };
  });
}

/**
 * 「FOMC の年間日程としてあり得る形か」を検査する。
 * 問題があれば理由の文字列を、無ければ null を返す。
 */
function validateFomcYear_(meetings, year) {
  if (meetings.length < 6 || meetings.length > 10) {
    return '会合数が ' + meetings.length + ' 回（通常は年8回）';
  }

  const seen = {};
  const dates = [];
  for (let i = 0; i < meetings.length; i++) {
    const key = meetings[i].date;
    if (seen[key]) return '同じ日付が重複: ' + key;
    seen[key] = true;

    const date = parseDateKey_(key);
    if (isNaN(date.getTime())) return '日付として読めない: ' + key;
    if (date.getUTCFullYear() !== year) return year + ' 年でない日付: ' + key;
    // 政策金利の発表は会合最終日で、実際には火〜木にしか来ない。
    const weekday = weekdayOf_(date);
    if (weekday < 1 || weekday > 3) return '平日中盤でない曜日: ' + key;
    dates.push(date);
  }

  dates.sort(function (a, b) { return a - b; });
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween_(dates[i], dates[i - 1]);
    if (gap < 25 || gap > 75) {
      return '会合間隔が ' + gap + ' 日（' + dateKey_(dates[i - 1])
           + ' → ' + dateKey_(dates[i]) + '）';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 人間側への引き継ぎ
// ---------------------------------------------------------------------------

/**
 * 自動取得で新しい年が埋まったら、02_meetings.js に貼れる形で1度だけ送る。
 * 自動取得はあくまで保険なので、最終的には手元の定義に載せてもらうのが確実。
 */
function maybeMailFomcSnippet_(accepted, curated) {
  let maxCurated = 0;
  curated.forEach(function (entry) {
    const year = parseDateKey_(entry.date).getUTCFullYear();
    if (year > maxCurated) maxCurated = year;
  });

  const newYears = Object.keys(accepted).filter(function (year) {
    return Number(year) > maxCurated;
  }).sort();
  if (!newYears.length) return false;

  const signature = newYears.join(',');
  if (prop_(PROP_FOMC_AUTO_MAILED) === signature) return false;

  const snippet = newYears.map(function (year) {
    return accepted[year].map(function (entry) {
      return "      { date: '" + entry.date + "', sep: " + entry.sep + ' },';
    }).join('\n');
  }).join('\n');

  const body = [
    'FOMC の会合日程を Fed の公式ページから自動取得し、' + signature + ' 年ぶんを取り込みました。',
    'カレンダーはこのまま動き続けるので、急ぎの対応は要りません。',
    '',
    'ただし自動取得は公式ページの作りに依存します。確実にしておきたい場合は、',
    '下記を src/02_meetings.js の fomc.meetings に貼り付けてください（貼れば以後は',
    '手入力が優先され、取得は行われません）。',
    '',
    snippet,
    '',
    '※ 上の日程は公式ページの記載をそのまま読み取ったものですが、',
    '　 念のため ' + (MEETINGS.fomc.verify_url || '') + ' で照合することをおすすめします。',
  ].join('\n');

  sendMail_('[経済指標カレンダー] FOMC 日程を自動取得しました（' + signature + '）', body);
  try {
    props_().setProperty(PROP_FOMC_AUTO_MAILED, signature);
  } catch (err) {
    log_('通知状態を保存できませんでした: ' + err);
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// 09_collect.js
// ═══════════════════════════════════════════════════════════

/**
 * 各情報源の突き合わせと、ナスダック影響度による選抜。
 */

/** 推定日と確定日がこの日数以内なら「同じ発表」とみなし、推定側を捨てる。 */
const SUPERSEDE_WINDOW_DAYS = 12;

/**
 * 同期範囲の上限。設定を書き間違えて 9999 などにすると、何十年ぶんもの
 * 発表日を展開しようとして実行時間の上限に当たり、毎回失敗するようになる。
 * 設定の検証でも弾いているが、ここでも頭を押さえておく。
 */
const MAX_WINDOW_DAYS = 400;

function syncWindow_(today) {
  const base = today || localDate_(new Date(), CONFIG.timezone);
  const config = CONFIG.window || {};
  const ahead = clampDays_(config.daysAhead, 60, 'window.daysAhead');
  const back = clampDays_(config.daysBack, 5, 'window.daysBack');
  return {
    start: addDays_(base, -back),
    end: addDays_(base, ahead),
    timezone: CONFIG.timezone,
  };
}

function clampDays_(value, fallback, label) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return fallback;
  if (value > MAX_WINDOW_DAYS) {
    log_(label + ' が大きすぎるため ' + MAX_WINDOW_DAYS + ' 日に抑えました: ' + value);
    return MAX_WINDOW_DAYS;
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// 情報源の生死
//
// 「今回は出てこなかった」には2つの意味がある。本当に無くなった（発表日が
// 動いた・しきい値を上げた）のと、その情報源に今回つながらなかっただけ、の
// 2つ。後者を消してしまうと、通信が不調な日だけカレンダーから決算や CPI が
// 消える。区別できるように、落ちた情報源をここに控えておく。
// ---------------------------------------------------------------------------

let SOURCE_DOWN_ = {};

function resetSourceHealth_() { SOURCE_DOWN_ = {}; }

function markSourceDown_(name, why) {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_DOWN_, name)) {
    log_('情報源 ' + name + ' は今回使えませんでした（既存の予定は残します）'
         + (why ? ': ' + why : ''));
  }
  SOURCE_DOWN_[name] = why || '取得できませんでした';
}

function sourceIsDown_(name) {
  return Object.prototype.hasOwnProperty.call(SOURCE_DOWN_, name || '');
}

/** 今回落ちていた情報源の名前（実行結果の報告に使う）。 */
function downSources_() { return Object.keys(SOURCE_DOWN_); }

/**
 * 有効な情報源すべてから集めて、重複を解消し、条件で絞る。
 * ひとつの情報源が落ちても同期全体は止めない。
 */
function collectEvents_(ctx) {
  resetSourceHealth_();
  const providers = [];
  if (CONFIG.providers.rules) providers.push({ name: 'rules', run: providerRules_ });
  if (CONFIG.providers.fomc) providers.push({ name: 'fomc', run: providerFomc_ });
  if (CONFIG.providers.market) providers.push({ name: 'market', run: providerMarket_ });
  if (CONFIG.providers.fred) providers.push({ name: 'fred', run: providerFred_ });
  if (CONFIG.providers.earnings) providers.push({ name: 'earnings', run: providerEarnings_ });
  if (CONFIG.providers.investing) providers.push({ name: 'investing', run: providerInvesting_ });

  let raw = [];
  providers.forEach(function (provider) {
    let found;
    try {
      found = provider.run(ctx) || [];
    } catch (err) {
      log_('情報源 ' + provider.name + ' でエラー（スキップします）: ' + err);
      markSourceDown_(provider.name, String(err));
      return;
    }
    log_(provider.name + ': ' + found.length + ' 件');
    raw = raw.concat(found);
  });

  const merged = dropSupersededEstimates_(mergeEvents_(raw, ctx.timezone), ctx.timezone);
  const selected = applyFilter_(merged);
  return selected.sort(function (a, b) {
    if (a.start.getTime() !== b.start.getTime()) return a.start - b.start;
    if (a.impact !== b.impact) return b.impact - a.impact;
    return a.indicatorId < b.indicatorId ? -1 : 1;
  });
}

/**
 * 同じ発表を報告しているものをひとつにまとめる。
 *
 * まとめる基準は2段構え。
 *
 *  1. **指標の地元の日付**（米 CPI なら米東部の 1/11）。
 *     情報源によって発表時刻の申告が少し違う（FRED＋カタログは 8:30 ET、
 *     集計サイトは 7:45 ET など）と、表示タイムゾーンによっては真夜中を
 *     またいで「別の日の別の発表」に見えてしまう。実際に起きた例：
 *     シドニー表示だと 1/11 12:45Z が 1/11、1/11 13:30Z が 1/12 になり、
 *     同じ CPI がカレンダーに2つ並んだ。地元の日付なら、どちらも 1/11。
 *
 *  2. **表示日**。予定 ID は表示日から決まるので、ここが重なったままだと
 *     同じ ID の予定を2つ作ろうとして、片方が黙って消える。
 */
function mergeEvents_(events, timezone) {
  const byRelease = groupMerge_(events, function (event) {
    return releaseKey_(event, timezone);
  });
  return groupMerge_(byRelease, function (event) {
    return eventUid_(event, timezone);
  });
}

/** 同じ鍵になったものを mergeEvent_ でまとめる（最初に現れた順は保つ）。 */
function groupMerge_(events, keyOf) {
  const byKey = {};
  const order = [];
  events.forEach(function (event) {
    const key = keyOf(event);
    if (Object.prototype.hasOwnProperty.call(byKey, key)) {
      byKey[key] = mergeEvent_(byKey[key], event);
      return;
    }
    byKey[key] = event;
    order.push(key);
  });
  return order.map(function (key) { return byKey[key]; });
}

/**
 * 「どの発表か」を表す鍵。指標の地元のタイムゾーンで日付を取る。
 *
 * 終日の予定（休場日など）は、表示タイムゾーンのその日そのものが中身なので
 * 地元の日付に直すとかえってずれる。表示日で見る。
 */
function releaseKey_(event, timezone) {
  if (event.allDay) return eventUid_(event, timezone);
  const indicator = indicator_(event.indicatorId);
  const tz = indicator ? indicatorTimezone_(indicator) : ET;
  return event.indicatorId + '@' + dateKey_(localDate_(event.start, tz));
}

/**
 * 確定日が出たら、その近くにある推定日を捨てる。
 *
 * ルール計算は CPI を12日に置き、FRED は11日だと言う。同じ発表なのに
 * 日が違うので mergeEvents_ では別物として残ってしまう。ここで消さないと
 * カレンダーに重複が出る。
 */
function dropSupersededEstimates_(events, timezone) {
  const confirmed = {};
  events.forEach(function (event) {
    if (isEstimated_(event)) return;
    const key = event.indicatorId;
    (confirmed[key] = confirmed[key] || []).push(localDate_(event.start, timezone));
  });

  return events.filter(function (event) {
    if (!isEstimated_(event)) return true;
    const known = confirmed[event.indicatorId] || [];
    const day = localDate_(event.start, timezone);
    for (let i = 0; i < known.length; i++) {
      if (Math.abs(daysBetween_(day, known[i])) <= SUPERSEDE_WINDOW_DAYS) return false;
    }
    return true;
  });
}

/** ナスダック影響度その他の条件で選抜する。 */
function applyFilter_(events) {
  const filter = CONFIG.filter || {};
  // 設定を消してしまったときに「全部消える」のが一番まずいので、
  // しきい値が読めなければ既定値に落とす。
  const minImpact = typeof filter.minImpact === 'number' ? filter.minImpact : 55;
  const include = filter.include || [];
  const exclude = filter.exclude || [];
  const countries = filter.countries || [];
  const categories = filter.categories || [];

  return events.filter(function (event) {
    if (exclude.indexOf(event.indicatorId) !== -1) return false;
    if (include.indexOf(event.indicatorId) !== -1) return true;
    if (countries.length && countries.indexOf(event.country) === -1) return false;
    if (categories.length && categories.indexOf(event.category) === -1) return false;
    return event.impact >= minImpact;
  });
}

// ═══════════════════════════════════════════════════════════
// 10_render.js
// ═══════════════════════════════════════════════════════════

/**
 * 件名と説明文の組み立て。
 */

const TIER_EMOJI = { S: '🔴', A: '🟠', B: '🟡', C: '⚪' };
const TIER_LABEL = { S: '最重要', A: '重要', B: '注目', C: '参考' };
const FLAGS = { US: '🇺🇸', JP: '🇯🇵', EU: '🇪🇺', CN: '🇨🇳', GB: '🇬🇧', DE: '🇩🇪' };
const MARKER = 'econ-calendar';

const CATEGORY_LABEL = {
  fed: '金融政策', inflation: '物価', labor: '雇用', growth: '景気',
  sentiment: '景況感', housing: '住宅', trade: '貿易', rates: '金利・債券',
  market: '市場イベント', earnings: '決算', other: 'その他',
};

function stars_(impact) {
  const filled = Math.max(1, Math.min(5, Math.round(impact / 20)));
  return new Array(filled + 1).join('★') + new Array(5 - filled + 1).join('☆');
}

function renderTitle_(event) {
  const parts = [];
  const tier = eventTier_(event);
  if (CONFIG.display.impactEmoji) parts.push(TIER_EMOJI[tier]);
  if (CONFIG.display.countryFlag && FLAGS[event.country]) parts.push(FLAGS[event.country]);
  parts.push(event.title);
  if (CONFIG.display.showScore) parts.push('[' + event.impact + ']');
  if (event.actual) parts.push('→ ' + event.actual);
  else if (isEstimated_(event)) parts.push('(予定日未確定)');
  return parts.join(' ');
}

function formatClock_(instant, timezone) {
  const parts = tzParts_(instant, timezone);
  const date = ymd_(parts.year, parts.month, parts.day);
  return {
    date: parts.year + '/' + pad2_(parts.month) + '/' + pad2_(parts.day),
    time: pad2_(parts.hour) + ':' + pad2_(parts.minute),
    weekday: WEEKDAY_JA[weekdayOf_(date)],
    short: pad2_(parts.month) + '/' + pad2_(parts.day),
  };
}

function renderDescription_(event) {
  const tier = eventTier_(event);
  const local = formatClock_(event.start, CONFIG.timezone);
  const lines = [];

  lines.push('影響度  ' + stars_(event.impact) + '  ' + event.impact + '/100 '
             + '（' + tier + 'ランク・' + TIER_LABEL[tier] + '）');
  lines.push('分類    ' + (CATEGORY_LABEL[event.category] || event.category));
  if (event.allDay || CONFIG.display.allDay) {
    // 米東部時間の午後に出るもの（FOMC など）は日本時間だと翌日になる。
    // どちらの日付を指しているのか分かるよう、ずれるときだけ併記する。
    const eastern = formatClock_(event.start, ET);
    const shifted = eastern.date !== local.date && !event.allDay
      ? '   （米国時間 ' + eastern.date + ' の発表）' : '';
    lines.push('日付    ' + local.date + '(' + local.weekday + ')' + shifted);
  } else {
    const eastern = formatClock_(event.start, ET);
    lines.push('日時    ' + local.date + '(' + local.weekday + ') ' + local.time
               + '  (現地 ' + eastern.time + ' ET)');
  }
  if (event.period) lines.push('対象期間 ' + event.period);
  // 「この日付はどこから来たのか」を必ず書く。カレンダーを見た人が、
  // どこまで信じてよいかを判断できるようにするため。
  lines.push('日付の根拠 ' + (CONFIDENCE_LABEL[event.confidence] || event.confidence));

  const figures = [['予想', event.forecast], ['前回', event.previous], ['結果', event.actual]]
    .filter(function (pair) { return !!pair[1]; });
  if (figures.length) {
    lines.push('');
    figures.forEach(function (pair) { lines.push('　' + pair[0] + '  ' + pair[1]); });
  }

  if (event.note) {
    lines.push('');
    lines.push('── ナスダックへの効き方 ──');
    lines.push(String(event.note).trim());
  }

  lines.push('');
  if (isEstimated_(event)) {
    lines.push('⚠️ この日付は過去の慣例から推定したものです。'
               + '公式発表で前後する可能性があります。');
  }
  if (event.url) lines.push('🔗 ' + event.url);
  // どのモジュールが勝ったかは書かない。情報源が一時的に落ちて別の経路から
  // 同じ予定が組み立てられただけで説明文が変わり、更新が走ってしまうため。
  // 利用者にとって意味があるのは「日付の根拠」と「時刻が実測かどうか」で、
  // どちらも上に書いてある。
  const timeNote = (event.allDay || CONFIG.display.allDay || event.exactTime)
    ? '' : '（発表時刻は慣例値）';
  lines.push('自動同期: ' + MARKER + timeNote);
  return lines.join('\n');
}

/** 実行ログやダイジェスト用の1行表示。 */
function renderLine_(event) {
  const local = formatClock_(event.start, CONFIG.timezone);
  const when = local.short + '(' + local.weekday + ')'
             + (event.allDay || CONFIG.display.allDay ? '' : ' ' + local.time);
  const flag = FLAGS[event.country] || '  ';
  const mark = isEstimated_(event) ? '~' : ' ';
  let figures = '';
  if (event.actual) {
    figures = '  結果 ' + event.actual + (event.forecast ? ' / 予想 ' + event.forecast : '');
  } else if (event.forecast) {
    figures = '  予想 ' + event.forecast;
  }
  return when + ' ' + TIER_EMOJI[eventTier_(event)] + flag + ' ' + event.title + mark + figures;
}

// ═══════════════════════════════════════════════════════════
// 11_sync.js
// ═══════════════════════════════════════════════════════════

/**
 * カレンダーとの差分計算と反映。
 *
 * 拡張サービスの Calendar API（v3）を使う。CalendarApp ではなく v3 なのは、
 * 予定 ID を自分で決められるから。ID を「指標 id + 表示日」のハッシュに
 * しておけば、何度実行しても同じ予定を上書きするだけで重複しない。
 */

const MAX_REMINDERS = 5;   // Google 側の上限

/** 一時的な失敗を何回まで待って試し直すか。 */
const CALENDAR_RETRIES = 4;

/**
 * カレンダー API をひとつ呼ぶ。
 *
 * 初回同期では 60〜130 件をまとめて書き込むので、レート制限や
 * 一時的なバックエンドエラーに当たることがある。そこで落として同期全体を
 * 失敗させると、その日のカレンダーが丸ごと古いままになるため、
 * 待って試し直す。恒久的な失敗（権限不足、ID 重複など）はそのまま投げる。
 */
function calendarCall_(action) {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      if (attempt >= CALENDAR_RETRIES || !isRetriableError_(err)) throw err;
      log_('カレンダー API が一時的に失敗（' + attempt + '回目）。'
           + (delay / 1000) + '秒待って試し直します。');
      sleep_(delay);
      delay *= 2;
    }
  }
}

function isRetriableError_(err) {
  const text = String(err && err.message ? err.message : err);
  return /rate limit|rateLimit|quota|backend error|internal error|try again|timed? ?out|\b(429|500|502|503|504)\b/i
    .test(text);
}

function sleep_(ms) {
  try {
    Utilities.sleep(ms);
  } catch (err) {
    // テスト環境などで sleep が無くても、再試行そのものは続ける。
  }
}

function toCalendarResource_(event) {
  const timezone = CONFIG.timezone;
  const tier = eventTier_(event);
  const resource = {
    id: eventCalendarId_(event, timezone),
    summary: renderTitle_(event),
    description: renderDescription_(event),
    // 指標は「予定」ではないので、空き時間検索の邪魔をしないようにする。
    transparency: 'transparent',
    reminders: {
      useDefault: false,
      overrides: (CONFIG.reminders[tier] || []).slice(0, MAX_REMINDERS).map(function (minutes) {
        return { method: 'popup', minutes: minutes };
      }),
    },
    extendedProperties: {
      private: {
        ecal: MANAGED_VALUE,
        uid: eventUid_(event, timezone),
        indicator: event.indicatorId,
        impact: String(event.impact),
        source: event.source,
        confidence: event.confidence,
        // 次回の判断材料として、失いたくない中身を残しておく。
        // 情報源が一時的に落ちても、実測の時刻や発表された数値が
        // カレンダーから消えないようにするため。
        exact: event.exactTime ? '1' : '0',
        at: event.start.toISOString(),
        a: event.actual || '',
        f: event.forecast || '',
        p: event.previous || '',
      },
    },
  };

  if (event.allDay || CONFIG.display.allDay) {
    const day = localDate_(event.start, timezone);
    resource.start = { date: dateKey_(day) };
    resource.end = { date: dateKey_(addDays_(day, 1)) };
  } else {
    resource.start = { dateTime: event.start.toISOString(), timeZone: timezone };
    resource.end = { dateTime: event.end.toISOString(), timeZone: timezone };
  }

  const color = CONFIG.colors[tier];
  if (color) resource.colorId = String(color).trim();
  if (event.url && event.url.indexOf('http') === 0) {
    resource.source = { title: event.title.slice(0, 60), url: event.url };
  }

  resource.extendedProperties.private.hash = resourceContentHash_(resource);
  return resource;
}

/**
 * 実際にカレンダーへ書き込む内容そのもののハッシュ。
 *
 * イベントの生データではなく組み立て後の姿を見るのがだいじで、そうしないと
 * 表示設定（終日にする・絵文字をやめる等）を変えても「変化なし」と判定され、
 * 既存の予定が古い見た目のまま残り続ける。
 */
function resourceContentHash_(resource) {
  const payload = JSON.stringify([
    resource.summary, resource.description, resource.start, resource.end,
    resource.colorId || null, resource.reminders, resource.transparency,
    resource.source || null,
  ]);
  return sha1Hex_(payload).slice(0, 16);
}

// ---------------------------------------------------------------------------
// カレンダーの解決
// ---------------------------------------------------------------------------

function resolveCalendarId_(create) {
  if (CONFIG.calendar.id) return CONFIG.calendar.id;

  const name = CONFIG.calendar.name;
  // 名前を変えたのに古いカレンダーへ書き続けないよう、
  // キャッシュは「そのとき探した名前」とセットで持つ。
  const cached = prop_(PROP_CALENDAR_ID);
  if (cached && prop_(PROP_CALENDAR_NAME) === name) return cached;
  if (cached) forgetCalendarId_();

  let pageToken = null;
  do {
    const page = calendarCall_(function () {
      return Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
    });
    const items = page.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].summary === name) {
        rememberCalendarId_(items[i].id, name);
        return items[i].id;
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (create === false) {
    throw new Error('カレンダー「' + name + '」が見つかりません');
  }

  log_('カレンダー「' + name + '」を作成します');
  const created = calendarCall_(function () {
    return Calendar.Calendars.insert({
      summary: name,
      description: CONFIG.calendar.description || '',
      timeZone: CONFIG.timezone,
    });
  });
  rememberCalendarId_(created.id, name);
  return created.id;
}

function rememberCalendarId_(id, name) {
  try {
    props_().setProperty(PROP_CALENDAR_ID, id);
    props_().setProperty(PROP_CALENDAR_NAME, name);
  } catch (err) {
    log_('カレンダー ID を保存できませんでした（動作には影響しません）: ' + err);
  }
}

function forgetCalendarId_() {
  try {
    props_().deleteProperty(PROP_CALENDAR_ID);
    props_().deleteProperty(PROP_CALENDAR_NAME);
  } catch (err) {
    log_('カレンダー ID を消せませんでした: ' + err);
  }
}

/**
 * 覚えていたカレンダーが消されていた場合に、一度だけ探し直して やり直す。
 * これが無いと、カレンダーを削除した瞬間から毎日失敗し続ける。
 */
function withCalendarRecovery_(action) {
  try {
    return action();
  } catch (err) {
    if (!isMissingError_(err) || !prop_(PROP_CALENDAR_ID)) throw err;
    log_('覚えていたカレンダーが見つかりません。探し直します。');
    forgetCalendarId_();
    return action();
  }
}

/** このツールが作った予定だけを列挙する。 */
function listManagedEvents_(calendarId, start, end) {
  const out = [];
  let pageToken = null;
  do {
    const page = calendarCall_(function () {
      return Calendar.Events.list(calendarId, {
        timeMin: zonedTime_(start, '00:00', CONFIG.timezone).toISOString(),
        timeMax: zonedTime_(addDays_(end, 1), '00:00', CONFIG.timezone).toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        privateExtendedProperty: MANAGED_KEY + '=' + MANAGED_VALUE,
        pageToken: pageToken,
      });
    });
    (page.items || []).forEach(function (item) { if (item.id) out.push(item); });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// ---------------------------------------------------------------------------
// 差分
// ---------------------------------------------------------------------------

/**
 * カレンダー上の予定が「表示日ベースで何日のものか」を返す。
 *
 * 同期のときに記録した uid（指標id@表示日）が正。無ければ開始時刻から求める。
 */
function resourceDisplayDate_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  const uid = props.uid || '';
  const match = /@(\d{4}-\d{2}-\d{2})$/.exec(uid);
  if (match) return parseDateKey_(match[1]);
  if (item.start && item.start.date) return parseDateKey_(item.start.date);
  if (item.start && item.start.dateTime) {
    return localDate_(new Date(item.start.dateTime), CONFIG.timezone);
  }
  return null;
}

/**
 * すでにカレンダーにある中身を引き継ぐ。
 *
 * 情報源が一時的に落ちただけで、実測の発表時刻や、すでに出た結果の数値が
 * 消えてしまうのはおかしい。同じ発表（同じ予定 ID）について、前回書いた方が
 * 詳しいなら、その部分を引き継ぐ。
 * 今回の方が詳しければ今回が勝つので、値の更新は妨げない。
 */
function inheritFromExisting_(events, existing) {
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });

  return events.map(function (event) {
    const item = byId[eventCalendarId_(event, CONFIG.timezone)];
    if (!item) return event;
    const props = (item.extendedProperties && item.extendedProperties.private) || {};

    const patch = {};
    if (!event.actual && props.a) patch.actual = props.a;
    if (!event.forecast && props.f) patch.forecast = props.f;
    if (!event.previous && props.p) patch.previous = props.p;
    if (confidenceRank_(props.confidence) > confidenceRank_(event.confidence)) {
      // 同じ日付なので、根拠だけ引き継いでよい。
      patch.confidence = props.confidence;
    }
    if (!event.exactTime && props.exact === '1' && props.at) {
      const remembered = new Date(props.at);
      if (!isNaN(remembered.getTime())) {
        patch.exactTime = true;
        patch.start = remembered;
        patch.end = new Date(remembered.getTime() + (event.end - event.start));
      }
    }
    if (!Object.keys(patch).length) return event;

    const merged = {};
    Object.keys(event).forEach(function (key) { merged[key] = event[key]; });
    Object.keys(patch).forEach(function (key) { merged[key] = patch[key]; });
    return merged;
  });
}

/**
 * すでにカレンダーにある、より確かな予定を「記憶」として使う。
 *
 * FRED が一時的に落ちただけで、公式の発表日で置いた予定が概算の日付に
 * 戻ってしまうと、利用者のカレンダー上で予定が行ったり来たりする。
 * 回線の不調で日付が動くようでは、そこに書いてある日付を信じられない。
 *
 * そこで、同じ指標の近い日付に、より確かな根拠の予定がすでにあるなら、
 * 今回の弱い予定は捨てて、あるものをそのまま残す。
 * 公式の日付が本当に変わったときは、新しい方も official なので置き換わる。
 */
function keepStrongerExisting_(events, existing) {
  const anchors = {};
  existing.forEach(function (item) {
    const props = (item.extendedProperties && item.extendedProperties.private) || {};
    if (!props.indicator || !props.confidence) return;
    const day = resourceDisplayDate_(item);
    if (!day) return;
    (anchors[props.indicator] = anchors[props.indicator] || []).push({
      id: item.id, day: day, rank: confidenceRank_(props.confidence),
    });
  });

  const keptIds = {};
  const replaced = [];
  const kept = events.filter(function (event) {
    const nearby = anchors[event.indicatorId];
    if (!nearby) return true;
    const day = localDate_(event.start, CONFIG.timezone);
    const mine = confidenceRank_(event.confidence);
    for (let i = 0; i < nearby.length; i++) {
      if (nearby[i].rank <= mine) continue;
      if (Math.abs(daysBetween_(day, nearby[i].day)) > SUPERSEDE_WINDOW_DAYS) continue;
      log_(event.indicatorId + ': より確かな予定が既にあるので、'
           + dateKey_(day) + ' の弱い予定は作りません');
      keptIds[nearby[i].id] = true;
      replaced.push(nearby[i].id);
      return false;
    }
    return true;
  });
  return { events: kept, keptIds: keptIds, replaced: replaced };
}

/**
 * カレンダーに保存してある予定を、表示用のイベントとして読み戻す。
 *
 * 週次まとめは「その週に何があるか」の一覧なので、今回計算したものではなく
 * **実際にカレンダーに入っているもの**から作らないと、情報源が揺れるたびに
 * まとめだけが書き換わる。差分計算には使わない（復元がわずかに違っても
 * 毎回更新が走ってしまうため、用途を表示に限る）。
 */
function eventFromResource_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  const indicator = indicator_(props.indicator);
  const allDay = !!(item.start && item.start.date);
  const start = allDay
    ? zonedTime_(parseDateKey_(item.start.date), '00:00', CONFIG.timezone)
    : new Date(item.start.dateTime);
  if (isNaN(start.getTime())) return null;
  const end = allDay ? new Date(start.getTime() + 86400000)
                     : new Date(new Date(item.end.dateTime).getTime());

  return makeEvent_({
    indicatorId: props.indicator || 'unknown',
    title: indicator ? indicator.name : String(item.summary || '').replace(/^[^ ]+ /, ''),
    start: start,
    end: isNaN(end.getTime()) ? new Date(start.getTime() + 1800000) : end,
    impact: Number(props.impact) || (indicator ? indicator.impact : 0),
    country: indicator ? indicator.country : 'US',
    // 決算はカタログに無いが、カテゴリで絞っている人のために復元しておく。
    category: indicator ? indicator.category
      : (String(props.indicator || '').indexOf('earnings_') === 0 ? 'earnings' : 'other'),
    source: props.source || 'rules',
    confidence: props.confidence || 'estimated',
    allDay: allDay,
    exactTime: props.exact === '1',
    actual: props.a || null,
    forecast: props.f || null,
    previous: props.p || null,
  });
}

/** 表示用に、「今回の予定 ＋ 据え置いた既存の予定」をそろえる。 */
function displayEvents_(events, existing) {
  const guarded = keepStrongerExisting_(inheritFromExisting_(events, existing), existing);
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });
  const restored = [];
  guarded.replaced.forEach(function (id) {
    const event = byId[id] ? eventFromResource_(byId[id]) : null;
    if (event) restored.push(event);
  });
  return guarded.events.concat(restored);
}

function buildPlan_(calendarId, events, existing, ctx) {
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });

  const plan = { calendarId: calendarId, created: [], updated: [], unchanged: [], deleted: [] };
  const guarded = keepStrongerExisting_(inheritFromExisting_(events, existing), existing);
  const seen = guarded.keptIds;
  events = guarded.events;

  events.forEach(function (event) {
    const resource = toCalendarResource_(event);
    seen[resource.id] = true;
    const current = byId[resource.id];
    if (!current) {
      plan.created.push({ event: event, resource: resource });
    } else if (storedHash_(current) === resource.extendedProperties.private.hash) {
      plan.unchanged.push(event);
    } else {
      plan.updated.push({ event: event, resource: resource });
    }
  });

  // この期間に前回書き込んだのに今回は選ばれなかったもの＝
  // 発表日が動いた、あるいはしきい値を上げた、のどちらか。
  //
  // ただし削除してよいのは、同期範囲の中の日付の予定だけ。
  // 日をまたぐ予定（23:45 開始など）は、範囲の外の日のものでも
  // 時間帯が重なるせいで一覧に出てくる。それを消すと、範囲から外れた
  // 過去の記録が「たまたま日付をまたいでいたから」という理由で消える。
  existing.forEach(function (item) {
    if (seen[item.id]) return;
    if (ctx && !inPruneRange_(item, ctx)) return;
    if (keepThroughOutage_(item)) return;
    plan.deleted.push(item);
  });
  return plan;
}

/**
 * その予定を、情報源が落ちているという理由だけで消さずに残すか。
 *
 * 「今回は出てこなかった」には2つの意味がある。本当に無くなった（発表日が
 * 動いた・しきい値を上げた）のと、その情報源に今回つながらなかっただけ、の
 * 2つ。後者で消すと、通信が不調な日だけカレンダーから決算や CPI が消えて
 * しまう。消してよいのは、その情報源がちゃんと動いた上で「もう無い」と
 * 言っているときだけ。
 *
 * ただし設定で対象外になったもの（しきい値を上げた・exclude に入れた）は、
 * 情報源の生死に関係なく整理する。人が明示的に外したものだから。
 */
function keepThroughOutage_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  if (!sourceIsDown_(props.source)) return false;
  const restored = eventFromResource_(item);
  if (!restored) return true;   // 読み戻せないものは、判断がつくまで触らない
  return applyFilter_([restored]).length > 0;
}

function inPruneRange_(item, ctx) {
  const day = resourceDisplayDate_(item);
  if (!day) return true;   // 判定できないものは従来どおり整理対象にする
  return day.getTime() >= ctx.start.getTime() && day.getTime() <= ctx.end.getTime();
}

function storedHash_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  return props.hash || null;
}

function planSummary_(plan) {
  return '新規 ' + plan.created.length + ' / 更新 ' + plan.updated.length
       + ' / 削除 ' + plan.deleted.length + ' / 変更なし ' + plan.unchanged.length;
}

function planChanges_(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}

// ---------------------------------------------------------------------------
// 反映
// ---------------------------------------------------------------------------

function applyPlan_(plan) {
  plan.created.forEach(function (row) {
    try {
      calendarCall_(function () {
        return Calendar.Events.insert(row.resource, plan.calendarId);
      });
    } catch (err) {
      // ID が既にある（期間外にあった、削除済みで残っていた等）場合は
      // 作り直さず更新して ID を使い回す。
      if (!isDuplicateIdError_(err)) throw err;
      calendarCall_(function () {
        return Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
      });
    }
  });

  plan.updated.forEach(function (row) {
    calendarCall_(function () {
      return Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
    });
  });

  plan.deleted.forEach(function (item) {
    try {
      calendarCall_(function () { return Calendar.Events.remove(plan.calendarId, item.id); });
    } catch (err) {
      if (!isMissingError_(err)) throw err;   // 既に無いなら成功と同じ
    }
  });

  log_('同期完了: ' + planSummary_(plan));
  return plan;
}

function isDuplicateIdError_(err) {
  const text = String(err && err.message ? err.message : err);
  return /duplicate|already exists|409/i.test(text);
}

function isMissingError_(err) {
  const text = String(err && err.message ? err.message : err);
  return /not found|deleted|404|410|Resource has been deleted/i.test(text);
}

// ═══════════════════════════════════════════════════════════
// 12_digest.js
// ═══════════════════════════════════════════════════════════

/**
 * 週次ダイジェスト：月曜に「今週の注目指標」を終日予定として置く。
 *
 * カレンダーをめくれば各日の予定は分かるが、「どの週が山場か」は分からない。
 * 普通のイベントとして出力するので、同期の冪等性はそのまま効く。
 */

const DIGEST_ID = 'digest_weekly';

function weeklyDigestEvents_(events, ctx) {
  if (!CONFIG.digest.weeklyEvent) return [];
  const threshold = CONFIG.digest.weeklyThreshold || 75;
  const timezone = ctx.timezone;
  const out = [];

  // 範囲に含まれる月曜を列挙する（範囲が週の途中から始まる週は作らない）。
  let monday = addDays_(ctx.start, -weekdayOf_(ctx.start));
  for (; monday.getTime() <= ctx.end.getTime(); monday = addDays_(monday, 7)) {
    if (monday.getTime() < ctx.start.getTime()) continue;
    const sunday = addDays_(monday, 6);

    const week = events.filter(function (event) {
      if (event.impact < threshold) return false;
      const day = localDate_(event.start, timezone);
      return day.getTime() >= monday.getTime() && day.getTime() <= sunday.getTime();
    }).sort(function (a, b) { return a.start - b.start; });
    if (!week.length) continue;

    const top = week.filter(function (event) { return eventTier_(event) === 'S'; });
    const headline = (top.length ? top : [week[0]]).map(function (event) {
      return event.title;
    }).join('・');
    const anchor = zonedTime_(monday, '00:00', timezone);

    out.push(makeEvent_({
      indicatorId: DIGEST_ID,
      title: '今週の注目指標 ' + week.length + '件'
           + (top.length ? '（最重要 ' + top.length + '件）' : ''),
      start: anchor,
      end: new Date(anchor.getTime() + 86400000),
      impact: 1,          // 通知を出さず、色も控えめにする
      country: 'US',
      category: 'market',
      source: 'digest',
      allDay: true,
      note: '今週の山場: ' + headline + '\n\n'
          + week.map(renderLine_).join('\n'),
    }));
  }
  return out;
}

/** Webhook や実行ログに流す用のテキスト。 */
function digestText_(events, ctx) {
  const lines = ['📊 経済指標 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end), ''];
  let current = null;
  events.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (event) {
    const local = formatClock_(event.start, ctx.timezone);
    if (local.date !== current) {
      current = local.date;
      lines.push('*' + local.short + '(' + local.weekday + ')*');
    }
    lines.push('  ' + renderLine_(event));
  });
  if (lines.length === 2) lines.push('（該当なし）');
  return lines.join('\n');
}

/** Slack / Discord のどちらでも受け取れる形で送る。 */
function postWebhook_(text) {
  const url = prop_(PROP_WEBHOOK_URL);
  if (!url) return false;
  const body = text.length <= 3500 ? text : text.slice(0, 3497) + '...';
  const response = fetchText_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: body, content: body }),
  });
  return response !== null;
}

// ═══════════════════════════════════════════════════════════
// 13_health.js
// ═══════════════════════════════════════════════════════════

/**
 * 放置運用のための自己点検。
 *
 * 無人ツールの一番怖い壊れ方は「静かに古くなること」なので、
 * 手当てが要る状態になったら外から見える形（メール）で知らせる。
 */

const SEVERITY_ACTION = 'action';   // 人が手を動かす必要がある
const SEVERITY_INFO = 'info';       // 設定すればもっと良くなる、程度

/** 会合日程は、同期範囲の先端からこの日数先まで埋まっていてほしい。 */
const MEETING_HEADROOM_DAYS = 90;

function maintenanceReport_(ctx) {
  const findings = [];
  const deadline = addDays_(ctx.end, MEETING_HEADROOM_DAYS);
  const today = localDate_(new Date(), CONFIG.timezone);

  [['fomc', 'FOMC'], ['boj', '日銀'], ['ecb', 'ECB']].forEach(function (pair) {
    const section = MEETINGS[pair[0]] || {};
    const entries = allMeetings_(pair[0]);
    if (!entries.length) {
      // 未登録は既定の状態なので、FOMC 以外は騒がない。
      if (pair[0] === 'fomc') {
        findings.push({
          key: 'meetings:fomc',
          severity: SEVERITY_ACTION,
          message: pair[1] + ' の会合日程が1件も登録されていません。',
          fix: section.verify_url + ' を見て 02_meetings.js に追記してください。',
        });
      }
      return;
    }

    let last = parseDateKey_(entries[0].date);
    let auto = false;
    entries.forEach(function (entry) {
      const date = parseDateKey_(entry.date);
      if (date.getTime() > last.getTime()) { last = date; auto = !!entry.auto; }
    });

    if (last.getTime() < deadline.getTime()) {
      const days = daysBetween_(last, today);
      const when = days >= 0 ? 'あと ' + days + ' 日' : (-days) + ' 日前に期限切れ';
      findings.push({
        key: 'meetings:' + pair[0],
        severity: last.getTime() < ctx.end.getTime() ? SEVERITY_ACTION : SEVERITY_INFO,
        message: pair[1] + ' の会合日程が ' + dateKey_(last) + ' で切れます（'
               + when + ' / 同期範囲の末尾は ' + dateKey_(ctx.end) + '）。',
        fix: section.verify_url + ' を見て 02_meetings.js に翌年分を追記してください。',
      });
    } else if (auto) {
      // 公式ページからの自動取得で足りている状態。動いてはいるが、
      // 取得はページの作りに依存するので、転記を促しておく。
      findings.push({
        key: 'meetings:' + pair[0] + ':auto',
        severity: SEVERITY_INFO,
        message: pair[1] + ' の会合日程は ' + dateKey_(last)
               + ' まで自動取得で埋まっています（手入力ではありません）。',
        fix: '確実にするなら、届いたメールの内容を 02_meetings.js に貼り付けてください。',
      });
    }
  });

  if (CONFIG.providers.fred && !prop_(PROP_FRED_KEY)) {
    findings.push({
      key: 'provider:fred',
      severity: SEVERITY_INFO,
      message: 'FRED の API キーが未設定のため、発表日の一部が推定のままです。',
      fix: 'https://fred.stlouisfed.org/docs/api/api_key.html で無料キーを取得し、'
         + '[プロジェクトの設定] → [スクリプト プロパティ] に '
         + PROP_FRED_KEY + ' として登録してください。',
    });
  }
  return findings;
}

function needsAction_(findings) {
  return findings.some(function (finding) { return finding.severity === SEVERITY_ACTION; });
}

function maintenanceText_(findings) {
  if (!findings.length) return '手当てが必要な項目はありません。';
  return findings.map(function (finding) {
    return (finding.severity === SEVERITY_ACTION ? '❗ ' : '・ ')
         + finding.message + '\n    → ' + finding.fix;
  }).join('\n');
}

/**
 * 要対応が出たら知らせる。同じ内容を毎日送っても仕方ないので、
 * 一定期間は送り直さない。
 */
function notifyMaintenance_(findings) {
  if (!CONFIG.notify.onMaintenance) return false;
  const actionable = findings.filter(function (f) { return f.severity === SEVERITY_ACTION; });
  if (!actionable.length) return false;

  const signature = actionable.map(function (f) { return f.key; }).join(',');
  const cooldownMs = (CONFIG.notify.maintenanceCooldownDays || 7) * 86400000;
  const last = prop_(PROP_LAST_MAINTENANCE_MAIL);
  if (last) {
    const parts = last.split('|');
    if (parts[0] === signature && Date.now() - Number(parts[1]) < cooldownMs) return false;
  }

  const body = '経済指標カレンダーの自動同期は動いていますが、'
             + 'このままだと予定が欠けます。\n\n'
             + maintenanceText_(actionable) + '\n\n'
             + '直したあとは何もしなくて構いません。次の実行から反映されます。';
  sendMail_('[経済指標カレンダー] メンテナンスが必要です', body);
  props_().setProperty(PROP_LAST_MAINTENANCE_MAIL, signature + '|' + Date.now());
  postWebhook_(body);
  return true;
}

function notifyFailure_(error) {
  if (!CONFIG.notify.onFailure) return;
  const body = '経済指標カレンダーの自動同期が失敗しました。'
             + 'カレンダーは更新されていません。\n\n'
             + String(error && error.stack ? error.stack : error) + '\n\n'
             + 'スクリプト エディタの [実行数] から詳しいログを確認できます。';
  sendMail_('[経済指標カレンダー] 同期に失敗しました', body);
  postWebhook_('⚠️ ' + body);
}

function sendMail_(subject, body) {
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
  } catch (err) {
    log_('メールを送れませんでした: ' + err);
  }
}

// ═══════════════════════════════════════════════════════════
// 14_main.js
// ═══════════════════════════════════════════════════════════

/**
 * 入口。エディタ上部のプルダウンから選んで実行する関数はここにあります。
 *
 *   setup()             ← 最初に1回だけ実行する（これだけで全自動になります）
 *   syncCalendar()      自動実行の本体。手で押しても構いません
 *   preview()           カレンダーに書き込まず、選抜結果をログに出す
 *   showStatus()        設定・情報源・メンテナンス状況の確認
 *   removeAllEvents()   このツールが作った予定を削除する
 *   uninstall()         自動実行を止める（予定は残ります）
 *   dataQuality()       いま入っているデータがどれだけ確かかを点検する
 *   verifyRules()       発表規則の当たり具合を、FRED の実績で測る
 *   checkFomcAutoFetch() FOMC 日程の自動取得が今どう動くかを確かめる
 *   runTests()          日付計算などの自己テスト
 */

const TRIGGER_HANDLER = 'syncCalendar';

/** 同時実行を待つ上限。これを超えたらこの回は諦める（次の回で追いつく）。 */
const LOCK_WAIT_MS = 30000;

/**
 * 設定を読んで、おかしければ「どこがどうおかしいか」を言って止まる。
 *
 * CONFIG は利用者が直接書き換える場所なので、消し方によっては
 * 「Cannot read properties of undefined」のような、原因の分からない
 * エラーになる。それだと放置運用では手の打ちようがない。
 */
function validateConfig_() {
  const problems = [];

  try {
    tzParts_(new Date(), CONFIG.timezone);
  } catch (err) {
    problems.push('timezone が不正です: ' + CONFIG.timezone
                  + '（例: Asia/Tokyo）');
  }

  const window = CONFIG.window;
  if (!window || typeof window !== 'object') {
    problems.push('window の設定がありません（daysAhead / daysBack）');
  } else {
    ['daysAhead', 'daysBack'].forEach(function (key) {
      const value = window[key];
      if (typeof value !== 'number' || value < 0 || value !== Math.floor(value)) {
        problems.push('window.' + key + ' は 0 以上の整数にしてください: ' + value);
      }
    });
    if (window.daysAhead > 400) problems.push('window.daysAhead は 400 日以内にしてください');
  }

  const calendar = CONFIG.calendar;
  if (!calendar || typeof calendar !== 'object') {
    problems.push('calendar の設定がありません（name か id）');
  } else if (!calendar.id && !calendar.name) {
    problems.push('calendar.name か calendar.id のどちらかは必要です');
  }

  const impact = CONFIG.filter && CONFIG.filter.minImpact;
  if (typeof impact !== 'number' || impact < 0 || impact > 100) {
    problems.push('filter.minImpact は 0〜100 の数値にしてください: ' + impact);
  }

  TIERS.forEach(function (tier) {
    const list = (CONFIG.reminders || {})[tier];
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      problems.push('reminders.' + tier + ' は配列にしてください');
      return;
    }
    list.forEach(function (minutes) {
      if (typeof minutes !== 'number' || minutes < 0 || minutes > 40320) {
        problems.push('reminders.' + tier + ' は 0〜40320 分の数値にしてください: ' + minutes);
      }
    });
  });

  TIERS.forEach(function (tier) {
    const color = (CONFIG.colors || {})[tier];
    if (color === undefined || color === null || color === '') return;
    const number = Number(color);
    if (!Number.isInteger(number) || number < 1 || number > 11
        || String(number) !== String(color).trim()) {
      // Google が受け付けるのは 1〜11 だけ。ここで弾かないと、同期のたびに
      // 予定の作成が失敗して原因が分からなくなる。
      problems.push('colors.' + tier + ' は "1"〜"11" にしてください: ' + color);
    }
  });

  problems.push.apply(problems, catalogProblems_());

  const triggers = CONFIG.triggers;
  if (!triggers || typeof triggers !== 'object') {
    problems.push('triggers の設定がありません（morningHour / eveningHour）');
  } else {
    ['morningHour', 'eveningHour'].forEach(function (key) {
      const hour = triggers[key];
      if (typeof hour !== 'number' || hour < 0 || hour > 23) {
        problems.push('triggers.' + key + ' は 0〜23 にしてください: ' + hour);
      }
    });
  }

  if (problems.length) {
    throw new Error('設定に問題があります（00_config.js を確認してください）:\n  - '
                    + problems.join('\n  - '));
  }
}

/**
 * 指標カタログの書式を点検する。利用者が 01_indicators.js を触ったときに、
 * その指標が黙ってカレンダーから消えるのを防ぐ。
 */
function catalogProblems_() {
  const validTypes = ['nth_business_day', 'nth_weekday', 'day_of_month', 'weekly', 'none'];
  const problems = [];
  const seen = {};

  INDICATORS.forEach(function (indicator) {
    const id = indicator.id || '(id なし)';
    if (!indicator.id) problems.push('id の無い指標があります: ' + indicator.name);
    if (seen[id]) problems.push('指標 id が重複しています: ' + id);
    seen[id] = true;

    if (typeof indicator.impact !== 'number' || indicator.impact < 0 || indicator.impact > 100) {
      problems.push(id + ': impact は 0〜100 の数値にしてください');
    }

    const schedule = indicator.schedule || {};
    const type = schedule.type || 'none';
    if (validTypes.indexOf(type) === -1) {
      problems.push(id + ': schedule.type が不正です（' + type + '）');
    }
    if (schedule.weekday !== undefined
        && WEEKDAY_NUM[String(schedule.weekday).toLowerCase()] === undefined) {
      problems.push(id + ': schedule.weekday が不正です（' + schedule.weekday + '）');
    }
    // time は schedule.type が none の指標でも使う（FOMC や外部取得ぶんの
    // 時刻になる）ので、書いてあるなら必ず検査する。
    if (indicator.time !== undefined && indicator.time !== null) {
      const parts = /^(\d{1,2}):(\d{2})$/.exec(String(indicator.time));
      if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59) {
        problems.push(id + ': time が不正です（' + indicator.time + '）');
      }
    } else if (type !== 'none' && !indicator.all_day) {
      problems.push(id + ': 発表日を計算する指標には time が必要です');
    }
    if (indicator.tz) {
      try {
        tzParts_(new Date(), indicator.tz);
      } catch (err) {
        problems.push(id + ': tz が不正です（' + indicator.tz + '）');
      }
    }

    if (indicator.duration !== undefined
        && (typeof indicator.duration !== 'number' || indicator.duration <= 0
            || indicator.duration > 24 * 60)) {
      problems.push(id + ': duration は 1〜1440 分にしてください（' + indicator.duration + '）');
    }
    if (indicator.period_offset !== undefined
        && (typeof indicator.period_offset !== 'number'
            || Math.abs(indicator.period_offset) > 12)) {
      problems.push(id + ': period_offset が不正です（' + indicator.period_offset + '）');
    }
    // 解説の出典は一次情報であってほしい。せめて https だけは確かめる。
    if (indicator.url && String(indicator.url).indexOf('https://') !== 0) {
      problems.push(id + ': url は https にしてください（' + indicator.url + '）');
    }
    // 名寄せに使う文字列。空や重複があると、別の指標の数値が入りこむ。
    (indicator.match || []).forEach(function (pattern) {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        problems.push(id + ': match に空の項目があります');
      }
    });
    if (indicator.fred_release !== undefined) {
      try {
        new RegExp(indicator.fred_release, 'i');
      } catch (err) {
        problems.push(id + ': fred_release が正規表現として不正です（'
                      + indicator.fred_release + '）');
      }
    }
  });

  problems.push.apply(problems, fredReleaseOverlaps_());
  return problems;
}

/**
 * ひとつの FRED release 名が2つ以上の指標に当たっていないか。
 *
 * 当たってしまうと、関係ない発表日が「公式の日付」として別の指標に
 * 入りこむ。実際の release 名は取ってこないと分からないので、ここでは
 * カタログどうしを突き合わせ、「A の名前が B の正規表現にも当たる」
 * という書き方の重なりだけを見る。
 */
function fredReleaseOverlaps_() {
  const withRelease = INDICATORS.filter(function (i) { return i.fred_release; });
  const problems = [];
  const reported = {};
  withRelease.forEach(function (a) {
    withRelease.forEach(function (b) {
      if (a.id === b.id) return;
      let re;
      try { re = new RegExp(b.fred_release, 'i'); } catch (err) { return; }
      // a の正規表現から「素の名前らしき部分」を作って b に当ててみる。
      const plain = String(a.fred_release).replace(/[\^$]/g, '');
      if (!/^[\w .,&'()-]+$/.test(plain)) return;   // 込み入った式は対象外
      if (!re.test(plain)) return;
      const pair = [a.id, b.id].sort().join(' と ');
      if (reported[pair]) return;   // 同じ組を2回言わない
      reported[pair] = true;
      problems.push('FRED の対応付けが重なっています: 「' + plain + '」は '
                    + pair + ' の両方に当たります');
    });
  });
  return problems;
}

/**
 * 拡張サービスの Calendar API が有効かを確かめる。
 * 有効化を忘れると "Calendar is not defined" としか出ず、原因に辿り着けない。
 */
function requireCalendarService_() {
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    throw new Error(
      'Calendar API が有効になっていません。\n'
      + 'エディタ左の [サービス] の ＋ から Calendar API を追加してください'
      + '（識別子は Calendar のまま）。');
  }
}

/**
 * 最初の1回。カレンダーを用意し、自動実行を仕掛け、初回同期まで済ませます。
 * 2回目以降に実行しても安全です（トリガーは重複しません）。
 */
function setup() {
  validateConfig_();
  requireCalendarService_();
  const calendarId = resolveCalendarId_(true);
  installTriggers();
  const plan = syncCalendar();

  const lines = [
    '─────────────────────────────',
    ' セットアップ完了',
    '─────────────────────────────',
    'カレンダー : ' + CONFIG.calendar.name,
    'ID         : ' + calendarId,
    '同期結果   : ' + (plan ? planSummary_(plan) : '(別の実行中だったのでスキップ)'),
    '自動実行   : 毎日 ' + CONFIG.triggers.morningHour + '時ごろ / '
                 + CONFIG.triggers.eveningHour + '時ごろ',
    '',
    'このあとやることはありません。Google カレンダーを開いて確認してください。',
  ];
  log_(lines.join('\n'));
  return lines.join('\n');
}

/** 自動実行の本体。 */
function syncCalendar() {
  validateConfig_();
  requireCalendarService_();

  // 手動実行と自動実行がぶつかっても、同じ書き込みを二重に投げないようにする。
  // 取れなければ既に別の実行が同じ仕事をしているので、この回は何もしない。
  const lock = acquireLock_();
  if (!lock) {
    log_('別の同期が実行中のため、この回はスキップします。');
    return null;
  }

  const ctx = syncWindow_();
  try {
    const collected = collectEvents_(ctx);
    if (!collected.length) {
      throw new Error('同期対象が 0 件でした。条件か情報源の状態を確認してください。');
    }
    // 週次ダイジェストの通知に使うため、実際に入る姿を外へ持ち出す。
    let shownEvents = collected;

    // カレンダーを消されていた場合に一度だけ探し直す。
    const plan = withCalendarRecovery_(function () {
      const calendarId = resolveCalendarId_(true);
      const existing = listManagedEvents_(calendarId, ctx.start, ctx.end);
      // 週次まとめは各予定の一覧を本文に持つので、実際にカレンダーへ入る
      // 姿から作る。そうしないと、情報源が揺れるたびにまとめだけが変わる。
      const enriched = inheritFromExisting_(collected, existing);
      shownEvents = displayEvents_(collected, existing);
      const events = enriched.concat(weeklyDigestEvents_(shownEvents, ctx));
      return applyPlan_(buildPlan_(calendarId, events, existing, ctx));
    });

    const down = downSources_();
    log_('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
         + ' / ' + planSummary_(plan)
         + (down.length ? ' / 今回つながらなかった情報源: ' + down.join(', ')
                          + '（その予定はそのまま残しました）' : ''));

    notifyMaintenance_(maintenanceReport_(ctx));
    maybeSendWeeklyDigest_(shownEvents, ctx);
    return plan;
  } catch (error) {
    log_('同期に失敗しました: ' + error);
    notifyFailure_(error);
    throw error;   // 実行履歴にも失敗として残す
  } finally {
    releaseLock_(lock);
  }
}

function acquireLock_() {
  try {
    const lock = LockService.getScriptLock();
    return lock.tryLock(LOCK_WAIT_MS) ? lock : null;
  } catch (err) {
    // ロックが使えない環境でも、同期そのものは冪等なので続行する。
    log_('排他ロックを使えませんでした（処理は続行します）: ' + err);
    return { releaseLock: function () {} };
  }
}

function releaseLock_(lock) {
  try {
    if (lock && lock.releaseLock) lock.releaseLock();
  } catch (err) {
    log_('ロックを解放できませんでした: ' + err);
  }
}

/** 月曜の朝の回だけ、今週のまとめを Webhook に流す。 */
function maybeSendWeeklyDigest_(events, ctx) {
  if (!prop_(PROP_WEBHOOK_URL)) return;
  const now = tzParts_(new Date(), CONFIG.timezone);
  const today = ymd_(now.year, now.month, now.day);
  if (weekdayOf_(today) !== 0 || now.hour >= 12) return;

  const week = { start: today, end: addDays_(today, 6), timezone: ctx.timezone };
  const inWeek = events.filter(function (event) {
    if (event.allDay || event.impact < (CONFIG.digest.weeklyThreshold || 75)) return false;
    const day = localDate_(event.start, ctx.timezone);
    return day.getTime() >= week.start.getTime() && day.getTime() <= week.end.getTime();
  });
  postWebhook_(digestText_(inWeek, week));
}

/** カレンダーに触らず、何が登録されるかをログに出す。 */
function preview() {
  validateConfig_();
  const ctx = syncWindow_();
  const events = collectEvents_(ctx);
  const counts = { S: 0, A: 0, B: 0, C: 0 };
  const lines = ['期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
                 + '   ' + events.length + ' 件', ''];
  events.forEach(function (event) {
    counts[eventTier_(event)]++;
    lines.push('  ' + renderLine_(event));
  });
  lines.push('');
  lines.push('内訳: ' + TIERS.map(function (t) { return t + ':' + counts[t]; }).join(' / '));
  lines.push('~ 印は発表日が推定であることを示します。');
  const text = lines.join('\n');
  log_(text);
  return text;
}

/** 設定と情報源の状態、手当てが要る項目を表示する。 */
function showStatus() {
  const ctx = syncWindow_();
  // fomcAutoFetch は情報源ではなく fomc の挙動スイッチなので、ここには並べない。
  const enabled = Object.keys(CONFIG.providers).filter(function (name) {
    return CONFIG.providers[name] && name !== 'fomcAutoFetch';
  });
  const lines = [
    'タイムゾーン : ' + CONFIG.timezone,
    '同期期間     : ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end),
    '選抜しきい値 : 影響度 ' + CONFIG.filter.minImpact + ' 以上',
    '指標カタログ : ' + INDICATORS.length + ' 件（うちルール展開 '
                    + indicatorsWithRules_().length + ' 件）',
    '有効な情報源 : ' + enabled.join(', '),
    'FOMC 日程    : ' + meetingCoverage_(),
    'FRED キー    : ' + (prop_(PROP_FRED_KEY) ? '設定済み' : '未設定'),
    'Webhook      : ' + (prop_(PROP_WEBHOOK_URL) ? '設定済み' : '未設定'),
    '自動実行     : ' + countTriggers_() + ' 件',
    '',
    maintenanceText_(maintenanceReport_(ctx)),
  ];
  const text = lines.join('\n');
  log_(text);
  return text;
}

function meetingCoverage_() {
  const meetings = allMeetings_('fomc');
  if (!meetings.length) return '未登録';
  let last = '';
  let verified = 0;
  meetings.forEach(function (meeting) {
    if (meeting.date > last) last = meeting.date;
    if (meeting.confidence === 'official') verified++;
  });
  return last + ' まで / 公式と照合済み ' + verified + ' 件中 ' + meetings.length + ' 件';
}

/**
 * FOMC 日程の自動取得が実際にどう動くかを見る。
 * 公式ページの作りが変わっていないか、たまに確認するのに使う。
 */
function checkFomcAutoFetch() {
  const lines = ['取得先: ' + FOMC_CALENDAR_URL, ''];
  const html = fetchText_(FOMC_CALENDAR_URL);
  if (html === null) {
    lines.push('❌ ページを取得できませんでした（手入力の日程だけで動きます）');
    const text = lines.join('\n');
    log_(text);
    return text;
  }

  let years = {};
  try {
    years = parseFomcCalendar_(html);
  } catch (err) {
    lines.push('❌ 解釈できませんでした: ' + err);
  }

  const found = Object.keys(years).sort();
  if (!found.length) {
    lines.push('❌ 会合日程を見つけられませんでした（ページの作りが変わった可能性）');
  }
  found.forEach(function (year) {
    const problem = validateFomcYear_(years[year], Number(year));
    lines.push((problem ? '❌ ' : '✅ ') + year + ' 年  ' + years[year].length + ' 回'
               + (problem ? '  → 採用しません: ' + problem : ''));
    lines.push('     ' + years[year].map(function (m) {
      return m.date + (m.sep ? '*' : '');
    }).join('  '));
  });

  lines.push('');
  lines.push('* 印は経済見通し(SEP)が同時公表される回。');
  lines.push('現在の状態: ' + meetingCoverage_());
  lines.push('手入力（02_meetings.js）がある年は、取得結果があっても使いません。');

  const text = lines.join('\n');
  log_(text);
  return text;
}

/**
 * いまカレンダーに入る予定が、どれだけ確かな根拠に基づいているかを出す。
 *
 * 「正しいデータが入っているか」を自分で確かめられるようにするための関数。
 * 数えるだけでなく、確かにするために何をすればよいかまで書く。
 */
function dataQuality() {
  validateConfig_();
  const ctx = syncWindow_();
  const events = collectEvents_(ctx);

  const counts = { official: 0, reported: 0, rule: 0, estimated: 0 };
  const estimatedBy = {};
  events.forEach(function (event) {
    counts[event.confidence] = (counts[event.confidence] || 0) + 1;
    if (isEstimated_(event)) {
      estimatedBy[event.indicatorId] = (estimatedBy[event.indicatorId] || 0) + 1;
    }
  });

  const lines = [];
  lines.push('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
             + ' / ' + events.length + ' 件');
  lines.push('');
  lines.push('■ 日付の根拠');
  ['official', 'reported', 'rule', 'estimated'].forEach(function (key) {
    const bar = new Array(Math.round((counts[key] || 0) / 2) + 1).join('■');
    lines.push('   ' + (CONFIDENCE_LABEL[key] + '          ').slice(0, 10)
               + String(counts[key] || 0).padStart(3) + ' 件 ' + bar);
  });

  const estimatedIds = Object.keys(estimatedBy);
  if (estimatedIds.length) {
    lines.push('');
    lines.push('■ 日付が未確定のもの（件名に「(予定日未確定)」と出ます）');
    estimatedIds.sort().forEach(function (id) {
      const indicator = indicator_(id);
      lines.push('   ' + (indicator ? indicator.name : id)
                 + ' × ' + estimatedBy[id] + '回');
    });
  }

  const down = downSources_();
  if (down.length) {
    lines.push('');
    lines.push('■ 今つながらない情報源');
    down.forEach(function (name) { lines.push('   ' + name); });
    lines.push('   → この点検結果は、その情報源ぶんが抜けた状態のものです。');
    lines.push('      （同期では、落ちた情報源ぶんの予定はカレンダーに残します）');
  }

  lines.push('');
  lines.push('■ FOMC 会合日程');
  lines.push('   ' + fomcVerificationStatus_());

  const warnings = fredMatchWarnings_();
  if (warnings.length) {
    lines.push('');
    lines.push('■ FRED の対応付けに疑いあり');
    warnings.forEach(function (text) { lines.push('   ' + text); });
  }

  lines.push('');
  lines.push('■ 確かさを上げるには');
  if (!prop_(PROP_FRED_KEY)) {
    lines.push('   1. FRED の無料キーを取得して、スクリプト プロパティ '
               + PROP_FRED_KEY + ' に入れる');
    lines.push('      → 主要10指標の発表日が公式の確定値になります');
    lines.push('      https://fred.stlouisfed.org/docs/api/api_key.html');
  } else {
    lines.push('   ✅ FRED キーは設定済み');
  }
  if (!CONFIG.providers.investing) {
    lines.push('   2. 00_config.js の providers.investing を true にする');
    lines.push('      → 発表時刻が実測値になり、予想値・前回値・結果値が入ります');
  } else {
    lines.push('   ✅ Investing は有効（時刻と数値が入ります）');
  }
  lines.push('   3. verifyRules() を実行すると、発表規則の当たり具合が測れます');

  lines.push('');
  lines.push('※ 影響度スコアと解説文は、データではなく作成者の判断です。');

  const text = lines.join('\n');
  log_(text);
  return text;
}

function fomcVerificationStatus_() {
  const meetings = allMeetings_('fomc');
  if (!meetings.length) return '未登録';
  const byConfidence = {};
  meetings.forEach(function (meeting) {
    byConfidence[meeting.confidence] = (byConfidence[meeting.confidence] || 0) + 1;
  });
  if (byConfidence.official === meetings.length) {
    return '公式ページと照合済み（' + meetings.length + ' 回ぶん）';
  }
  if (!byConfidence.official) {
    return '未照合（' + meetings.length + ' 回ぶん）'
         + ' — 公式ページを取得できていません。checkFomcAutoFetch() で確認してください';
  }
  return '一部だけ照合済み（照合 ' + byConfidence.official + ' / 未照合 '
       + (meetings.length - byConfidence.official) + '）';
}

/**
 * 発表規則がどれだけ当たっているかを、FRED の過去の実績で測って表示する。
 * 「第1営業日」「12日ごろ」といった規則は人が書いたものなので、
 * 信じてよいかどうかは測らないと分からない。
 */
function verifyRules() {
  validateConfig_();
  if (!prop_(PROP_FRED_KEY)) {
    const message = 'FRED のキーが必要です。スクリプト プロパティ ' + PROP_FRED_KEY
                  + ' に設定してください。\n'
                  + 'https://fred.stlouisfed.org/docs/api/api_key.html';
    log_(message);
    return message;
  }

  const stats = measureRuleAccuracy_(12);
  if (stats === null) {
    const message = 'FRED から過去の発表日を取得できませんでした。';
    log_(message);
    return message;
  }
  if (!stats.length) {
    const message = '突き合わせられる実績がありませんでした。';
    log_(message);
    return message;
  }

  const lines = ['過去12か月の実際の発表日と、発表規則の予想を突き合わせた結果', '',
                 '  ずれ(平均)  的中率  最大ずれ  指標', ''];
  stats.forEach(function (entry) {
    lines.push('  ' + (entry.meanGap + ' 日').padStart(8)
               + (entry.exactRate + '%').padStart(8)
               + (entry.worst + ' 日').padStart(10)
               + '  ' + entry.name + '（' + entry.samples + '件）');
  });
  lines.push('');
  lines.push('ずれが大きい指標は、01_indicators.js の schedule を見直す価値があります。');
  lines.push('なお FRED が扱う指標は、実際の同期では公式の発表日が使われるので、');
  lines.push('規則のずれはカレンダーには出ません。ここで効くのは FRED が扱わない指標です。');

  const text = lines.join('\n');
  log_(text);
  return text;
}

// ---------------------------------------------------------------------------
// トリガー
// ---------------------------------------------------------------------------

function installTriggers() {
  uninstall();
  [CONFIG.triggers.morningHour, CONFIG.triggers.eveningHour].forEach(function (hour) {
    ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(hour).create();
  });
  log_('自動実行を設定しました（毎日 '
       + CONFIG.triggers.morningHour + '時 / ' + CONFIG.triggers.eveningHour + '時ごろ）');
}

function uninstall() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  if (removed) log_('既存の自動実行 ' + removed + ' 件を解除しました');
  return removed;
}

function countTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === TRIGGER_HANDLER;
  }).length;
}

// ---------------------------------------------------------------------------
// 後始末
// ---------------------------------------------------------------------------

/** このツールが作った予定を、同期期間の範囲で削除する。 */
function removeAllEvents() {
  const ctx = syncWindow_();
  const items = withCalendarRecovery_(function () {
    const calendarId = resolveCalendarId_(false);
    const found = listManagedEvents_(calendarId, ctx.start, ctx.end);
    found.forEach(function (item) {
      try {
        calendarCall_(function () { return Calendar.Events.remove(calendarId, item.id); });
      } catch (err) {
        if (!isMissingError_(err)) throw err;
      }
    });
    return found;
  });
  const message = items.length + ' 件を削除しました。';
  log_(message);
  return message;
}

// ═══════════════════════════════════════════════════════════
// 15_tests.js
// ═══════════════════════════════════════════════════════════

/**
 * GAS 上での自己テスト。エディタで runTests を選んで実行してください。
 *
 * 開発用の網羅的なテストは tests/run.js（Node）にあります。ここにあるのは
 * 「この Google アカウント・この実行環境で本当に動くか」を確かめるための
 * 最小限。特に Intl（夏時間の計算）と Calendar 拡張サービスの有無を見ます。
 */

function runTests() {
  const results = [];

  function check(name, body) {
    try {
      body();
      results.push('✅ ' + name);
    } catch (err) {
      results.push('❌ ' + name + '\n     ' + err.message);
    }
  }

  function eq(actual, expected, hint) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error((hint ? hint + ' / ' : '') +
        '期待 ' + JSON.stringify(expected) + ' 実際 ' + JSON.stringify(actual));
    }
  }

  check('実行環境が Intl のタイムゾーンを扱える', function () {
    const parts = tzParts_(new Date(Date.UTC(2026, 8, 10, 12, 30)), ET);
    eq([parts.hour, parts.minute], [8, 30]);
  });

  check('夏時間が正しく処理される', function () {
    eq(zonedTime_(ymd_(2026, 7, 10), '08:30', ET).toISOString(), '2026-07-10T12:30:00.000Z');
    eq(zonedTime_(ymd_(2026, 12, 10), '08:30', ET).toISOString(), '2026-12-10T13:30:00.000Z');
  });

  check('8:30 ET が 21:30 JST になる', function () {
    eq(formatClock_(zonedTime_(ymd_(2026, 9, 10), '08:30', ET), 'Asia/Tokyo').time, '21:30');
  });

  check('SHA-1 が既知のテストベクタと一致する', function () {
    eq(sha1Hex_('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    eq(sha1Hex_('米 消費者物価指数'), '3564fa5ab71da9d9d4871a305429a3667313b8e5');
  });

  check('予定 ID が固定値どおりに出る（既存予定を作り直さないため）', function () {
    const start = new Date(Date.UTC(2026, 8, 10, 12, 30));
    const event = makeEvent_({ indicatorId: 'us_cpi', title: 'CPI', start: start,
                               end: new Date(start.getTime() + 1800000), impact: 98 });
    eq(eventCalendarId_(event, 'UTC'), 'ec74voedqjm1fii6oh3gegok6lm7bf8smv');
  });

  check('祝日カレンダー', function () {
    eq(!!marketHolidays_(2026)['2026-04-03'], true, 'グッドフライデーは休場');
    eq(!!federalHolidays_(2026)['2026-04-03'], false, '役所は開いている');
    eq(marketEarlyCloses_(2026)['2026-11-27'], '感謝祭翌日');
  });

  check('繰り返しルール', function () {
    eq(ruleDates_({ type: 'nth_business_day', n: 1 }, ymd_(2026, 11, 1), ymd_(2026, 11, 30))
       .map(dateKey_), ['2026-11-02']);
    eq(ruleDates_({ type: 'weekly', weekday: 'thu' }, ymd_(2026, 11, 20), ymd_(2026, 11, 30))
       .map(dateKey_), ['2026-11-25'], '感謝祭の週は木曜から水曜へ前倒し');
  });

  check('指標カタログが読める', function () {
    eq(INDICATORS.length > 30, true);
    eq(indicator_('us_cpi').impact >= 90, true);
    eq(matchEventName_('Core CPI (MoM) (Aug)').id, 'us_cpi');
  });

  check('指標カタログの書式に誤りがない', function () {
    const problems = catalogProblems_();
    if (problems.length) throw new Error(problems.join(' / '));
  });

  check('根拠を偽っている予定が無い', function () {
    // 外部から何も取っていない状態で「公式」を名乗る予定があってはならない。
    const saved = JSON.parse(JSON.stringify(CONFIG.providers));
    CONFIG.providers.fred = false;
    CONFIG.providers.earnings = false;
    CONFIG.providers.investing = false;
    CONFIG.providers.fomcAutoFetch = false;
    try {
      const events = collectEvents_({ start: ymd_(2026, 9, 1), end: ymd_(2026, 10, 31),
                                      timezone: CONFIG.timezone });
      const lying = events.filter(function (e) { return e.confidence === 'official'; });
      eq(lying.length, 0, lying.map(function (e) { return e.indicatorId; }).join(','));
    } finally {
      Object.keys(saved).forEach(function (k) { CONFIG.providers[k] = saved[k]; });
    }
  });

  check('通信なしで1か月ぶんの予定が組める', function () {
    const saved = JSON.parse(JSON.stringify(CONFIG.providers));
    CONFIG.providers.fred = false;
    CONFIG.providers.earnings = false;
    CONFIG.providers.investing = false;
    try {
      const events = collectEvents_({ start: ymd_(2026, 9, 1), end: ymd_(2026, 9, 30),
                                      timezone: 'Asia/Tokyo' });
      eq(events.length >= 20, true, '件数 ' + events.length);
      const ids = events.map(function (e) { return e.indicatorId; });
      ['us_cpi', 'us_nfp', 'us_fomc_rate'].forEach(function (id) {
        eq(ids.indexOf(id) !== -1, true, id + ' が無い');
      });
    } finally {
      Object.keys(saved).forEach(function (k) { CONFIG.providers[k] = saved[k]; });
    }
  });

  check('設定に矛盾がない', function () {
    validateConfig_();
  });

  check('Calendar 拡張サービスが有効になっている', function () {
    requireCalendarService_();
    Calendar.CalendarList.list({ maxResults: 1 });
  });

  check('多重実行の排他が使える', function () {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new Error('ロックを取得できませんでした');
    lock.releaseLock();
  });

  check('タイムゾーン設定が CONFIG と一致している', function () {
    const scriptTz = Session.getScriptTimeZone();
    if (scriptTz !== CONFIG.timezone) {
      throw new Error('スクリプトのタイムゾーンは ' + scriptTz + ' ですが CONFIG は '
                      + CONFIG.timezone + ' です。トリガーの実行時刻がずれます。'
                      + '[プロジェクトの設定] で合わせてください。');
    }
  });

  const text = results.join('\n');
  log_(text);
  return text;
}
