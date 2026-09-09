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
