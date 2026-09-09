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

  // 決算を拾う銘柄と、その影響度
  earningsTickers: {
    NVDA: 95, AAPL: 88, MSFT: 88, GOOGL: 85, AMZN: 85, META: 84,
    TSLA: 80, AVGO: 80, TSM: 70, AMD: 72, NFLX: 68, ORCL: 60,
    MU: 62, COST: 55, ADBE: 55, PLTR: 55,
  },

  display: {
    impactEmoji: true,      // 🔴🟠🟡⚪ を件名の先頭に付ける
    countryFlag: true,
    showScore: false,       // 件名にスコアを出す
  },

  // 通知（イベント開始の何分前か）。ランクごとに指定します。
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
    time: "23:00",
    duration: 60,
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
    time: "08:15",
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
    time: "21:00",
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
                           parts.hour % 24, parts.minute, parts.second);
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
    const weekday = WEEKDAY_NUM[rule.weekday || 'thu'];
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
      const date = nthWeekday_(year, month, WEEKDAY_NUM[rule.weekday || 'fri'],
                               rule.n === undefined ? 1 : rule.n);
      if (date.getUTCMonth() + 1 === month) push(date);
    } else if (kind === 'day_of_month') {
      push(nextBusinessDay_(ymd_(year, month, Math.min(rule.day || 1, 28))));
    } else {
      throw new Error('未知のスケジュール種別: ' + kind);
    }
  });
  return sortDates_(out);
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

function matchEventName_(name) {
  const matchers = catalog_().matchers;
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].re.test(name)) return matchers[i].indicator;
  }
  return null;
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
    estimated: !!fields.estimated,
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
    event.allDay, event.estimated, event.period, event.actual, event.forecast,
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
  // 確定日は、どの情報源から来たものでも推定日に勝つ。
  if (merged.estimated && !low.estimated) {
    merged.estimated = false;
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
  // ルールが範囲の端に落ちても取りこぼさないよう、前後1か月ぶん広げて展開する。
  const from = addDays_(ctx.start, -31);
  const to = addDays_(ctx.end, 31);

  indicatorsWithRules_().forEach(function (indicator) {
    ruleDates_(indicator.schedule, from, to).forEach(function (date) {
      if (date.getTime() < ctx.start.getTime() || date.getTime() > ctx.end.getTime()) return;
      const start = zonedTime_(date, indicator.time, indicatorTimezone_(indicator));
      events.push(makeEvent_({
        indicatorId: indicator.id,
        title: indicator.name,
        start: start,
        end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
        impact: indicator.impact,
        country: indicator.country,
        category: indicator.category,
        source: 'rules',
        estimated: !ruleIsExact_(indicator),
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
const BEIGE_BOOK_LEAD_DAYS = 14;  // ベージュブックは会合の2週間前

function providerFomc_(ctx) {
  const banks = {
    fomc: { rate: 'us_fomc_rate', presser: 'us_fomc_presser' },
    boj: { rate: 'jp_boj_decision', presser: null },
    ecb: { rate: 'eu_ecb_decision', presser: null },
  };
  const events = [];

  Object.keys(banks).forEach(function (bank) {
    const section = MEETINGS[bank] || {};
    (section.meetings || []).forEach(function (meeting) {
      const day = parseDateKey_(meeting.date);
      const sep = !!meeting.sep;

      const rate = indicator_(banks[bank].rate);
      if (!rate) return;
      let note = rate.why;
      if (sep) {
        note += '\n【ドットチャート公表回】経済見通し(SEP)が同時発表される会合。' +
                '利下げ回数の織り込みが一気に書き換わるため、通常会合より値動きが大きい。';
      }
      events.push(fomcEvent_(rate, day, rate.impact, note, null, { sep: sep, bank: bank }));

      const presser = banks[bank].presser ? indicator_(banks[bank].presser) : null;
      if (presser) {
        events.push(fomcEvent_(presser, day, Math.min(100, presser.impact + (sep ? 2 : 0)),
                               presser.why, null, { sep: sep }));
      }

      if (bank === 'fomc') {
        const minutes = indicator_('us_fomc_minutes');
        if (minutes) {
          events.push(fomcEvent_(minutes, addDays_(day, MINUTES_LAG_DAYS), minutes.impact,
                                 minutes.why,
                                 day.getUTCFullYear() + '年' + (day.getUTCMonth() + 1) + '月' +
                                 day.getUTCDate() + '日会合分'));
        }
        const beige = indicator_('us_beige_book');
        if (beige) {
          events.push(fomcEvent_(beige, addDays_(day, -BEIGE_BOOK_LEAD_DAYS), beige.impact,
                                 beige.why));
        }
      }
    });
  });

  return events.filter(function (event) {
    const day = localDate_(event.start, indicatorTimezone_(indicator_(event.indicatorId)));
    return day.getTime() >= ctx.start.getTime() && day.getTime() <= ctx.end.getTime();
  });
}

function fomcEvent_(indicator, day, impact, note, period, extra) {
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
    estimated: false,
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
  return events.filter(function (event) {
    const day = localDate_(event.start, ctx.timezone);
    return day.getTime() >= ctx.start.getTime() && day.getTime() <= ctx.end.getTime();
  });
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

function providerFred_(ctx) {
  const apiKey = prop_(PROP_FRED_KEY);
  if (!apiKey) {
    log_('FRED: API キー未設定のためスキップ（スクリプト プロパティ ' + PROP_FRED_KEY + '）');
    return [];
  }

  const rows = fredReleaseDates_(apiKey, ctx.start, ctx.end);
  if (rows === null) return [];

  const events = [];
  rows.forEach(function (row) {
    const name = row.release_name || '';
    if (!name) return;
    const indicator = matchFredRelease_(name);
    if (!indicator) return;
    const day = parseDateKey_(row.date);
    if (day.getTime() < ctx.start.getTime() || day.getTime() > ctx.end.getTime()) return;

    const start = zonedTime_(day, indicator.time, indicatorTimezone_(indicator));
    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'fred',
      estimated: false,
      period: periodLabel_(day, indicator.period_offset || 0),
      note: indicator.why,
      url: indicator.url,
      extra: { fredRelease: name },
    }));
  });
  log_('FRED: ' + rows.length + ' 件中 ' + events.length + ' 件が該当');
  return events;
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

  const days = [];
  for (let day = ctx.start; day.getTime() <= ctx.end.getTime(); day = addDays_(day, 1)) {
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
      if (payload === null) { failures++; return; }
      const rows = (payload.data && payload.data.rows) || [];
      rows.forEach(function (row) {
        const event = earningsEvent_(chunk[index], row, tickers);
        if (event) events.push(event);
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
    estimated: row.time === 'time-not-supplied',
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
  payload.push('dateFrom=' + dateKey_(ctx.start));
  payload.push('dateTo=' + dateKey_(ctx.end));
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
  if (text === null) return [];

  let fragment;
  try {
    fragment = JSON.parse(text).data || '';
  } catch (err) {
    log_('Investing.com の応答を解釈できませんでした');
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
    const indicator = matchEventName_(row.name);
    if (!indicator) return;
    const start = parseInvestingDate_(row.datetime, assumeTz);
    if (!start) return;
    const day = localDate_(start, ctx.timezone);
    if (day.getTime() < ctx.start.getTime() || day.getTime() > ctx.end.getTime()) return;

    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'investing',
      estimated: false,
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
// 08_collect.js
// ═══════════════════════════════════════════════════════════

/**
 * 各情報源の突き合わせと、ナスダック影響度による選抜。
 */

/** 推定日と確定日がこの日数以内なら「同じ発表」とみなし、推定側を捨てる。 */
const SUPERSEDE_WINDOW_DAYS = 12;

function syncWindow_(today) {
  const base = today || localDate_(new Date(), CONFIG.timezone);
  return {
    start: addDays_(base, -(CONFIG.window.daysBack || 0)),
    end: addDays_(base, CONFIG.window.daysAhead || 60),
    timezone: CONFIG.timezone,
  };
}

/**
 * 有効な情報源すべてから集めて、重複を解消し、条件で絞る。
 * ひとつの情報源が落ちても同期全体は止めない。
 */
function collectEvents_(ctx) {
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

/** 同じ発表を同じ日に報告しているものをひとつにまとめる。 */
function mergeEvents_(events, timezone) {
  const byUid = {};
  events.forEach(function (event) {
    const uid = eventUid_(event, timezone);
    byUid[uid] = byUid[uid] ? mergeEvent_(byUid[uid], event) : event;
  });
  return Object.keys(byUid).map(function (uid) { return byUid[uid]; });
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
    if (event.estimated) return;
    const key = event.indicatorId;
    (confirmed[key] = confirmed[key] || []).push(localDate_(event.start, timezone));
  });

  return events.filter(function (event) {
    if (!event.estimated) return true;
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
  const filter = CONFIG.filter;
  const include = filter.include || [];
  const exclude = filter.exclude || [];
  const countries = filter.countries || [];
  const categories = filter.categories || [];

  return events.filter(function (event) {
    if (exclude.indexOf(event.indicatorId) !== -1) return false;
    if (include.indexOf(event.indicatorId) !== -1) return true;
    if (countries.length && countries.indexOf(event.country) === -1) return false;
    if (categories.length && categories.indexOf(event.category) === -1) return false;
    return event.impact >= filter.minImpact;
  });
}

// ═══════════════════════════════════════════════════════════
// 09_render.js
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
  else if (event.estimated) parts.push('(予定日未確定)');
  return parts.join(' ');
}

function formatClock_(instant, timezone) {
  const parts = tzParts_(instant, timezone);
  const date = ymd_(parts.year, parts.month, parts.day);
  return {
    date: parts.year + '/' + pad2_(parts.month) + '/' + pad2_(parts.day),
    time: pad2_(parts.hour % 24) + ':' + pad2_(parts.minute),
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
  if (event.allDay) {
    lines.push('日時    ' + local.date + '(' + local.weekday + ') 終日');
  } else {
    const eastern = formatClock_(event.start, ET);
    lines.push('日時    ' + local.date + '(' + local.weekday + ') ' + local.time
               + '  (現地 ' + eastern.time + ' ET)');
  }
  if (event.period) lines.push('対象期間 ' + event.period);

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
  if (event.estimated) {
    lines.push('⚠️ この日付は過去の慣例から推定したものです。'
               + '公式発表で前後する可能性があります。');
  }
  if (event.url) lines.push('🔗 ' + event.url);
  lines.push('情報源: ' + event.source + ' / 自動同期: ' + MARKER);
  return lines.join('\n');
}

/** 実行ログやダイジェスト用の1行表示。 */
function renderLine_(event) {
  const local = formatClock_(event.start, CONFIG.timezone);
  const when = local.short + '(' + local.weekday + ') '
             + (event.allDay ? '終日  ' : local.time);
  const flag = FLAGS[event.country] || '  ';
  const mark = event.estimated ? '~' : ' ';
  let figures = '';
  if (event.actual) {
    figures = '  結果 ' + event.actual + (event.forecast ? ' / 予想 ' + event.forecast : '');
  } else if (event.forecast) {
    figures = '  予想 ' + event.forecast;
  }
  return when + ' ' + TIER_EMOJI[eventTier_(event)] + flag + ' ' + event.title + mark + figures;
}

// ═══════════════════════════════════════════════════════════
// 10_sync.js
// ═══════════════════════════════════════════════════════════

/**
 * カレンダーとの差分計算と反映。
 *
 * 拡張サービスの Calendar API（v3）を使う。CalendarApp ではなく v3 なのは、
 * 予定 ID を自分で決められるから。ID を「指標 id + 表示日」のハッシュに
 * しておけば、何度実行しても同じ予定を上書きするだけで重複しない。
 */

const MAX_REMINDERS = 5;   // Google 側の上限

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
        hash: eventContentHash_(event),
        indicator: event.indicatorId,
        impact: String(event.impact),
        source: event.source,
      },
    },
  };

  if (event.allDay) {
    const day = localDate_(event.start, timezone);
    resource.start = { date: dateKey_(day) };
    resource.end = { date: dateKey_(addDays_(day, 1)) };
  } else {
    resource.start = { dateTime: event.start.toISOString(), timeZone: timezone };
    resource.end = { dateTime: event.end.toISOString(), timeZone: timezone };
  }

  const color = CONFIG.colors[tier];
  if (color) resource.colorId = String(color);
  if (event.url && event.url.indexOf('http') === 0) {
    resource.source = { title: event.title.slice(0, 60), url: event.url };
  }
  return resource;
}

// ---------------------------------------------------------------------------
// カレンダーの解決
// ---------------------------------------------------------------------------

function resolveCalendarId_(create) {
  if (CONFIG.calendar.id) return CONFIG.calendar.id;

  const cached = prop_(PROP_CALENDAR_ID);
  if (cached) return cached;

  const name = CONFIG.calendar.name;
  let pageToken = null;
  do {
    const page = Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
    const items = page.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].summary === name) {
        props_().setProperty(PROP_CALENDAR_ID, items[i].id);
        return items[i].id;
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (create === false) {
    throw new Error('カレンダー「' + name + '」が見つかりません');
  }

  log_('カレンダー「' + name + '」を作成します');
  const created = Calendar.Calendars.insert({
    summary: name,
    description: CONFIG.calendar.description || '',
    timeZone: CONFIG.timezone,
  });
  props_().setProperty(PROP_CALENDAR_ID, created.id);
  return created.id;
}

/** このツールが作った予定だけを列挙する。 */
function listManagedEvents_(calendarId, start, end) {
  const out = [];
  let pageToken = null;
  do {
    const page = Calendar.Events.list(calendarId, {
      timeMin: zonedTime_(start, '00:00', CONFIG.timezone).toISOString(),
      timeMax: zonedTime_(addDays_(end, 1), '00:00', CONFIG.timezone).toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      privateExtendedProperty: MANAGED_KEY + '=' + MANAGED_VALUE,
      pageToken: pageToken,
    });
    (page.items || []).forEach(function (item) { if (item.id) out.push(item); });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// ---------------------------------------------------------------------------
// 差分
// ---------------------------------------------------------------------------

function buildPlan_(calendarId, events, existing) {
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });

  const plan = { calendarId: calendarId, created: [], updated: [], unchanged: [], deleted: [] };
  const seen = {};

  events.forEach(function (event) {
    const resource = toCalendarResource_(event);
    seen[resource.id] = true;
    const current = byId[resource.id];
    if (!current) {
      plan.created.push({ event: event, resource: resource });
    } else if (storedHash_(current) === eventContentHash_(event)) {
      plan.unchanged.push(event);
    } else {
      plan.updated.push({ event: event, resource: resource });
    }
  });

  // この期間に前回書き込んだのに今回は選ばれなかったもの＝
  // 発表日が動いた、あるいはしきい値を上げた、のどちらか。
  existing.forEach(function (item) {
    if (!seen[item.id]) plan.deleted.push(item);
  });
  return plan;
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
      Calendar.Events.insert(row.resource, plan.calendarId);
    } catch (err) {
      // ID が既にある（期間外にあった、削除済みで残っていた等）場合は
      // 作り直さず更新して ID を使い回す。
      if (isDuplicateIdError_(err)) {
        Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
      } else {
        throw err;
      }
    }
  });

  plan.updated.forEach(function (row) {
    Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
  });

  plan.deleted.forEach(function (item) {
    try {
      Calendar.Events.remove(plan.calendarId, item.id);
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
// 11_digest.js
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
// 12_health.js
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
    const entries = section.meetings || [];
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
    entries.forEach(function (entry) {
      const date = parseDateKey_(entry.date);
      if (date.getTime() > last.getTime()) last = date;
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
// 13_main.js
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
 *   runTests()          日付計算などの自己テスト
 */

const TRIGGER_HANDLER = 'syncCalendar';

/**
 * 最初の1回。カレンダーを用意し、自動実行を仕掛け、初回同期まで済ませます。
 * 2回目以降に実行しても安全です（トリガーは重複しません）。
 */
function setup() {
  const calendarId = resolveCalendarId_(true);
  installTriggers();
  const plan = syncCalendar();

  const lines = [
    '─────────────────────────────',
    ' セットアップ完了',
    '─────────────────────────────',
    'カレンダー : ' + CONFIG.calendar.name,
    'ID         : ' + calendarId,
    '同期結果   : ' + (plan ? planSummary_(plan) : '(失敗)'),
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
  const ctx = syncWindow_();
  try {
    let events = collectEvents_(ctx);
    if (!events.length) {
      throw new Error('同期対象が 0 件でした。条件か情報源の状態を確認してください。');
    }
    events = events.concat(weeklyDigestEvents_(events, ctx));

    const calendarId = resolveCalendarId_(true);
    const existing = listManagedEvents_(calendarId, ctx.start, ctx.end);
    const plan = applyPlan_(buildPlan_(calendarId, events, existing));

    log_('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
         + ' / ' + planSummary_(plan));

    notifyMaintenance_(maintenanceReport_(ctx));
    maybeSendWeeklyDigest_(events, ctx);
    return plan;
  } catch (error) {
    log_('同期に失敗しました: ' + error);
    notifyFailure_(error);
    throw error;   // 実行履歴にも失敗として残す
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
  const enabled = Object.keys(CONFIG.providers).filter(function (name) {
    return CONFIG.providers[name];
  });
  const lines = [
    'タイムゾーン : ' + CONFIG.timezone,
    '同期期間     : ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end),
    '選抜しきい値 : 影響度 ' + CONFIG.filter.minImpact + ' 以上',
    '指標カタログ : ' + INDICATORS.length + ' 件（うちルール展開 '
                    + indicatorsWithRules_().length + ' 件）',
    '有効な情報源 : ' + enabled.join(', '),
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
  const calendarId = resolveCalendarId_(false);
  const items = listManagedEvents_(calendarId, ctx.start, ctx.end);
  items.forEach(function (item) {
    try {
      Calendar.Events.remove(calendarId, item.id);
    } catch (err) {
      if (!isMissingError_(err)) throw err;
    }
  });
  const message = items.length + ' 件を削除しました。';
  log_(message);
  return message;
}

// ═══════════════════════════════════════════════════════════
// 14_tests.js
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

  check('Calendar 拡張サービスが有効になっている', function () {
    if (typeof Calendar === 'undefined' || !Calendar.Events) {
      throw new Error('エディタ左の [サービス] から Calendar API を追加してください');
    }
    Calendar.CalendarList.list({ maxResults: 1 });
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
