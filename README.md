# econ-calendar

ナスダックに効く経済指標だけを選抜して、**Google カレンダーに自動で入れる**ツールです。
一度セットアップすれば、あとは毎日勝手に更新されます。

```
09/14(月) 21:30 🔴🇺🇸 米 消費者物価指数 (CPI)          予想 0.3%
09/15(火) 21:30 🟠🇺🇸 米 小売売上高
09/17(木) 03:00 🔴🇺🇸 FOMC 政策金利発表
09/17(木) 03:30 🔴🇺🇸 FOMC 議長記者会見
09/18(金) 22:30 🟡🇺🇸 クアドラプル・ウィッチング (四半期 SQ)
09/28(月) 21:30 🔴🇺🇸 米 PCE デフレータ (個人所得・支出)
```

---

## 何ができるか

| | |
|---|---|
| **ナスダック影響度で選抜** | 全 42 指標に 0-100 のスコアを付け、しきい値以上だけを登録。CPI・雇用統計・FOMC は 90 以上、住宅系は 50 前後、といった具合に重み付けしてある |
| **日本時間で表示** | 発表時刻は米東部時間で管理し、夏時間も含めて自動変換。予定の詳細には現地時間も併記 |
| **重要度で色分け・通知** | 🔴 最重要 / 🟠 重要 / 🟡 注目 / ⚪ 参考。最重要だけ「前日 + 30分前」に通知、など段階を分けられる |
| **なぜ効くかを説明文に** | 「コア前月比が予想を 0.1pt 外すだけで指数が 1-2% 動く」といった解説を各予定に入れてある |
| **予想・前回・結果を表示** | 発表後は結果値を取り込んで件名に反映（Investing プロバイダ有効時） |
| **指標以外の重要日も** | 米国市場の休場・短縮取引・SQ・指数リバランス・主要ハイテク銘柄の決算日 |
| **週次まとめ** | 月曜に「今週の注目指標 6件（最重要 3件）」という終日予定を自動作成 |
| **毎日自動更新** | GitHub Actions で 1 日 2 回。予定の変更・追加・削除まで面倒を見る |
| **何度実行しても安全** | イベント ID を内容から決めているので、重複が絶対に増えない（冪等） |

---

## クイックスタート

### 1. 中身を見るだけなら、認証も通信も不要

```bash
git clone <このリポジトリ>
cd <このリポジトリ>
pip install -r requirements.txt

python -m econ_cal preview          # これから 60 日分の選抜結果を表示
python -m econ_cal indicators       # 指標カタログを影響度順に表示
```

`preview` はローカルの計算だけで動きます。まずこれで「どんな指標が入るか」を確認してください。

### 2. Google カレンダーにつなぐ

<details>
<summary><b>OAuth クライアントの作り方（初回だけ・5分）</b></summary>

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る（既存でも可）
2. 「API とサービス」→「ライブラリ」→ **Google Calendar API** を有効化
3. 「API とサービス」→「OAuth 同意画面」
   - User Type: **外部**
   - テストユーザーに**自分の Gmail アドレスを追加**（これを忘れると認可時に弾かれます）
4. 「認証情報」→「認証情報を作成」→ **OAuth クライアント ID**
   - アプリケーションの種類: **デスクトップアプリ**
5. JSON をダウンロードし、このディレクトリに `credentials.json` として保存

</details>

```bash
python -m econ_cal auth             # ブラウザが開くので許可する → token.json ができる
python -m econ_cal doctor           # 設定と認証の点検
python -m econ_cal sync --dry-run   # 何が登録されるか（まだ書き込まない）
python -m econ_cal sync             # 実際に登録
```

`経済指標 (Nasdaq)` という名前のカレンダーが自動で作られ、そこに入ります。
既存のカレンダーに入れたい場合は `config.yaml` の `calendar.id` を指定してください
（ID は `python -m econ_cal calendars` で確認できます）。

### 3. 自動更新を仕掛ける

**GitHub Actions（推奨・サーバ不要）**

リポジトリの Settings → Secrets and variables → Actions で登録します。

| Secret | 必須 | 中身 |
|---|---|---|
| `GOOGLE_TOKEN_JSON` | ✅ | 手順 2 で作った `token.json` の中身をそのまま貼る |
| `FRED_API_KEY` | 任意 | [FRED の無料 API キー](https://fred.stlouisfed.org/docs/api/api_key.html)。発表日が公式の確定値になる |
| `ECON_CAL_WEBHOOK_URL` | 任意 | Slack / Discord の Webhook URL。月曜に今週のまとめが飛ぶ |

これだけで `.github/workflows/econ-calendar.yml` が **毎朝 6:00 JST**（その日の予定確定）と
**平日 20:00 JST**（発表結果の取り込み）に動きます。
Actions タブから手動実行（`--dry-run` 付き）もできます。

**自分のマシンで cron を回す場合**

```cron
0 6 * * *  cd /path/to/econ-calendar && /usr/bin/python3 -m econ_cal sync --quiet
```

---

## データ源

3 層構造になっていて、**下に行くほど正確**、**上だけでも動く**のが設計方針です。

| 取得元 | キー | 何を提供するか |
|---|---|---|
| `rules` | 不要 | 発表日の**ルール計算**。「ISM 製造業＝第1営業日」「失業保険＝毎週木曜」など。通信ゼロで一通りのカレンダーができる |
| `fomc` | 不要 | FOMC 会合（`econ_cal/data/meetings.yaml` に手入力）。記者会見・議事要旨・ベージュブックは会合日から自動で導出 |
| `market` | 不要 | 休場・短縮取引・SQ・指数リバランス。取引所のルールから計算 |
| `fred` | 無料キー | **公式の発表日**。セントルイス連銀が各統計局の予定を公開しているので、`rules` の推定を確定値で上書きする |
| `earnings` | 不要 | Nasdaq の決算カレンダーから、設定した主要銘柄だけを抽出 |
| `investing` | 不要 | **予想値・前回値・結果値**。公式 API ではないので既定で無効（下記の注意を参照） |

**推定日には `~` が付きます。** `preview` の一覧でも、カレンダーの件名（`(予定日未確定)`）と
説明文でも明示されるので、確定日と取り違えることはありません。
`FRED_API_KEY` を設定すると、FRED がカバーする指標は自動的に確定日に置き換わります。

<details>
<summary><b>予想値・結果値も欲しい場合（investing プロバイダ）</b></summary>

`config.yaml`:

```yaml
providers:
  investing:
    enabled: true
```

Investing.com の公開エンドポイントを読みます。**公式 API ではない**ため、
サイト側の変更で動かなくなる可能性があります（その場合も他の取得元は生き続けます）。
利用は各サイトの利用規約を確認のうえ、自己責任でお願いします。

時刻がずれる場合は `timezone_id` と `assume_tz` を調整してください。

</details>

---

## 設定

`config.example.yaml` を `config.yaml` にコピーして編集します。全項目に既定値があるので、
変えたいところだけ書けば OK です。

```yaml
timezone: Asia/Tokyo

filter:
  min_impact: 55        # このスコア以上だけ登録（75 にすると重要指標のみ）
  exclude: [us_housing_starts, us_new_home_sales]   # 個別に外す
  include: [us_trade_balance]                        # スコアに関係なく入れる

reminders:
  S: [1440, 30]         # 最重要は前日と30分前に通知
  A: [30]
  B: []                 # 注目ランクは通知なし（カレンダーに載るだけ）
```

**しきい値の目安**

| `min_impact` | 60日あたり | 内容 |
|---|---|---|
| 90 | 10 件 | CPI・雇用統計・PCE・FOMC だけ |
| 75 | 34 件 | ＋ PPI・ISM・小売売上高・失業保険・ミシガン大 |
| 55（既定） | 57 件 | ＋ 地区連銀サーベイ・住宅・国債入札・SQ・休場 |
| 0 | 70 件 | 全部 |

（`--offline` 相当・決算なしでの実測値。`earnings` を有効にすると決算シーズンはこれに
主要銘柄の決算日が加わります。件数は `python -m econ_cal preview --min-impact N` で確認できます）

---

## コマンド

```bash
python -m econ_cal preview       # 選抜結果を表示（Google 不要）
python -m econ_cal preview --all # フィルタを外して全件表示
python -m econ_cal indicators    # 指標カタログを影響度順に表示
python -m econ_cal sync          # カレンダーへ同期
python -m econ_cal sync --dry-run# 差分だけ表示して書き込まない
python -m econ_cal digest        # 今週のまとめを表示（--post で Webhook 送信）
python -m econ_cal doctor        # 設定・認証・データ源の点検
python -m econ_cal calendars     # アクセスできるカレンダー一覧
python -m econ_cal purge         # このツールが作った予定を削除
python -m econ_cal auth          # Google の認可
```

主なオプション: `--days-ahead` `--days-back` `--min-impact` `--tz` `--offline` `-c config.yaml`

`--offline` を付けると通信を伴う取得元を全部止めて、ルール計算だけで動きます。

---

## メンテナンス

**年に一度、FOMC の日程を追記してください。**
[Fed の公式ページ](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)を見て
`econ_cal/data/meetings.yaml` に足すだけです。登録が同期期間より手前で切れていると
`doctor` と同期実行時に警告が出ます。

同じファイルで日銀・ECB の会合日程も登録できます（既定は空。investing プロバイダを
有効にすれば自動で入ります）。

指標を足したい・スコアを変えたいときは `econ_cal/data/indicators.yaml` を編集します。
`tests/test_catalog.py` が書式を検証しているので、`python -m pytest` を通せば安心です。

---

## 開発

```bash
pip install -r requirements-dev.txt
python -m pytest        # 146 テスト・ネットワーク不要
ruff check econ_cal tests
```

```
econ_cal/
  catalog.py        指標カタログの読み込みと名寄せ
  schedule.py       米国の休日カレンダーと繰り返しルール
  collect.py        各取得元の突き合わせ・重複排除・選抜
  render.py         件名と説明文の組み立て
  sync.py           カレンダーとの差分計算
  gcal.py           Google Calendar API
  digest.py         週次まとめ
  providers/        rules / fomc / market / fred / investing / earnings
  data/
    indicators.yaml 指標カタログ（影響度・発表時刻・解説）
    meetings.yaml   中央銀行の会合日程
```

**重複しない仕組み**: 各予定の ID を `sha1(指標ID + 表示日)` から決めているので、
同じ指標の同じ日は必ず同じ ID になります。内容のハッシュも一緒に保存していて、
変化がなければ API を叩きません。ツールが作った予定には目印が付いているので、
手動で足した予定を消してしまうこともありません。

---

## 注意

- 発表日程・時刻・数値は各データ源に依存します。**投資判断は必ず一次情報で確認してください。**
- `credentials.json` と `token.json` は認証情報です。`.gitignore` 済みですが、
  絶対にコミット・共有しないでください。
- `purge` は取り消せません。実行前に対象件数を確認してください。
