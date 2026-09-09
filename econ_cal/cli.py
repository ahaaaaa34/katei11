"""Command line interface."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, time, timedelta

from . import __version__, render
from .catalog import load_catalog, load_meetings
from .collect import collect, window_dates
from .config import OFFLINE_ENV, Config
from .digest import digest_text, weekly_events
from .gcal import AuthError, CalendarClient, run_oauth_flow
from .health import ACTION, as_text, maintenance_report, needs_action
from .models import EconEvent
from .notify import send as send_webhook
from .providers import build_providers
from .sync import apply_plan, build_plan
from .util import FetchError, log, setup_logging

OK, WARN, BAD = "✅", "⚠️ ", "❌"


# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="econ_cal",
        description="ナスダックに効く経済指標を Google カレンダーへ自動同期します。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "例:\n"
            "  python -m econ_cal preview             # Google に触らず一覧を確認\n"
            "  python -m econ_cal auth                # 初回のブラウザ認可\n"
            "  python -m econ_cal sync --dry-run      # 差分だけ表示\n"
            "  python -m econ_cal sync                # 実際に同期\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"econ-calendar {__version__}")
    parser.add_argument("-c", "--config", help="設定ファイル (既定: ./config.yaml)")
    parser.add_argument("-v", "--verbose", action="store_true", help="詳細ログ")
    parser.add_argument("-q", "--quiet", action="store_true", help="警告以上のみ表示")
    parser.add_argument(
        "--offline", action="store_true",
        help="通信を伴う取得元(fred/investing/earnings)を無効にし、ルール計算だけで動かす",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    def add_window(p: argparse.ArgumentParser) -> None:
        p.add_argument("--days-ahead", type=int, help="何日先まで同期するか")
        p.add_argument("--days-back", type=int, help="何日前まで遡るか（結果の取り込み用）")
        p.add_argument("--min-impact", type=int, help="この影響度スコア未満は除外 (0-100)")
        p.add_argument("--tz", help="表示タイムゾーン (既定: Asia/Tokyo)")

    p_sync = sub.add_parser("sync", help="カレンダーへ同期する")
    add_window(p_sync)
    p_sync.add_argument("--dry-run", action="store_true", help="書き込まずに差分だけ表示")
    p_sync.add_argument("--calendar-id", help="同期先カレンダー ID を明示指定")
    p_sync.add_argument("--no-digest", action="store_true", help="週次まとめイベントを作らない")
    p_sync.add_argument("--notify", action="store_true", help="完了後に Webhook へ通知する")

    p_preview = sub.add_parser("preview", help="選抜結果を端末に表示する（Google 不要）")
    add_window(p_preview)
    p_preview.add_argument("--all", action="store_true", help="影響度フィルタを外して全件表示")

    p_digest = sub.add_parser("digest", help="今週のまとめを表示 / Webhook 送信")
    add_window(p_digest)
    p_digest.add_argument("--days", type=int, default=7, help="対象日数 (既定: 7)")
    p_digest.add_argument("--post", action="store_true", help="Webhook へ送信する")

    p_purge = sub.add_parser("purge", help="このツールが作ったイベントを削除する")
    add_window(p_purge)
    p_purge.add_argument("--yes", action="store_true", help="確認をスキップ")

    p_auth = sub.add_parser("auth", help="Google の認可を行い token.json を作る")
    p_auth.add_argument("--port", type=int, default=0, help="ローカルサーバのポート")
    p_auth.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")

    sub.add_parser("doctor", help="設定・認証・データ源の状態を点検する")
    p_maint = sub.add_parser(
        "maintenance", help="人手が要る項目だけを報告する（放置運用の見張り用）"
    )
    p_maint.add_argument(
        "--strict", action="store_true",
        help="情報レベルの指摘でも終了コード 3 を返す",
    )
    p_notify = sub.add_parser("notify", help="設定した Webhook に任意のメッセージを送る")
    p_notify.add_argument("text", help="送信する本文")

    sub.add_parser("calendars", help="アクセスできるカレンダー一覧を表示する")
    sub.add_parser("indicators", help="指標カタログを影響度順に表示する")
    return parser


def _apply_overrides(config: Config, args: argparse.Namespace) -> Config:
    """CLI flags win over the file, which wins over the defaults."""
    if getattr(args, "days_ahead", None) is not None:
        config.data["window"]["days_ahead"] = args.days_ahead
    if getattr(args, "days_back", None) is not None:
        config.data["window"]["days_back"] = args.days_back
    if getattr(args, "min_impact", None) is not None:
        config.data["filter"]["min_impact"] = args.min_impact
    if getattr(args, "tz", None):
        config.data["timezone"] = args.tz
    if getattr(args, "calendar_id", None):
        config.data["calendar"]["id"] = args.calendar_id
    if getattr(args, "no_digest", False):
        config.data["digest"]["weekly_event"] = False
    config.validate()
    return config


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_preview(config: Config, args: argparse.Namespace) -> int:
    if args.all:
        config.data["filter"]["min_impact"] = 0
    start, end = window_dates(config)
    events = collect(config, start, end)
    _print_table(events, config, start, end)
    return 0


def cmd_sync(config: Config, args: argparse.Namespace) -> int:
    start, end = window_dates(config)
    events = collect(config, start, end)
    events += weekly_events(events, config, start, end)
    if not events:
        log.warning("同期対象のイベントが 0 件でした。条件を確認してください。")
        return 1

    client = CalendarClient(config)
    plan = build_plan(client, config, events, start, end)

    print(f"カレンダー: {plan.calendar_id}")
    print(f"期間      : {start} 〜 {end}")
    print(f"差分      : {plan.summary()}")
    for label, rows in (("追加", plan.created), ("更新", plan.updated)):
        for event, _ in rows:
            print(f"  [{label}] {render.one_line(event, config)}")
    for item in plan.deleted:
        print(f"  [削除] {item.get('summary', item['id'])}")

    if args.dry_run:
        print("\n--dry-run のため書き込みは行いませんでした。")
        return 0

    apply_plan(client, plan)
    if args.notify:
        text = digest_text(
            [e for e in events if e.impact >= 75 and not e.all_day], config, start, end
        )
        if send_webhook(config, f"経済指標カレンダーを更新しました（{plan.summary()}）\n\n{text}"):
            print("Webhook に通知しました。")
    return 0


def cmd_digest(config: Config, args: argparse.Namespace) -> int:
    start = date.today()
    end = start + timedelta(days=args.days)
    events = collect(config, start, end)
    text = digest_text(events, config, start, end)
    print(text)
    if args.post and send_webhook(config, text):
        print("\nWebhook に送信しました。")
    return 0


def cmd_purge(config: Config, args: argparse.Namespace) -> int:
    start, end = window_dates(config)
    client = CalendarClient(config)
    calendar_id = client.ensure_calendar(create=False)
    tz = config.tz
    time_min = datetime.combine(start, time.min, tzinfo=tz).isoformat()
    time_max = datetime.combine(end + timedelta(days=1), time.min, tzinfo=tz).isoformat()
    items = list(client.list_managed(calendar_id, time_min, time_max))

    if not items:
        print("削除対象はありません。")
        return 0
    print(f"{calendar_id} の {start} 〜 {end} にある管理イベント {len(items)} 件を削除します。")
    if not args.yes:
        answer = input("本当に削除しますか？ [y/N]: ").strip().lower()
        if answer not in ("y", "yes"):
            print("中止しました。")
            return 1
    for item in items:
        client.delete(calendar_id, item["id"])
    print(f"{len(items)} 件を削除しました。")
    return 0


def cmd_auth(config: Config, args: argparse.Namespace) -> int:
    token = run_oauth_flow(config, port=args.port, open_browser=not args.no_browser)
    print(f"{OK} 認可が完了しました: {token}")
    print("   このファイルは秘密情報です。git にコミットしないでください。")
    print("   CI で使う場合は中身をそのまま GOOGLE_TOKEN_JSON シークレットに入れてください。")
    return 0


def cmd_notify(config: Config, args: argparse.Namespace) -> int:
    """CI の失敗通知などから使う汎用の送信口。"""
    if send_webhook(config, args.text):
        print("Webhook に送信しました。")
        return 0
    env = config.get("digest.webhook_url_env")
    print(f"{WARN} {env} が未設定のため送信しませんでした。")
    return 0


def cmd_calendars(config: Config, args: argparse.Namespace) -> int:
    client = CalendarClient(config)
    for item in client.list_calendars():
        primary = " (既定)" if item.get("primary") else ""
        print(f"{item.get('accessRole', '?'):10} {item['id']}{primary}")
        print(f"{'':10} {item.get('summary', '')}")
    return 0


def cmd_indicators(config: Config, args: argparse.Namespace) -> int:
    catalog = load_catalog()
    for ind in sorted(catalog, key=lambda i: (-i.impact, i.id)):
        flag = render.FLAGS.get(ind.country, "  ")
        rule = ind.schedule.get("type", "none")
        mark = "確定" if ind.rule_is_exact else ("推定" if rule != "none" else "外部")
        print(
            f"{render.TIER_EMOJI[ind.tier]}{flag} {ind.impact:3d} "
            f"{ind.id:26} {ind.name[:30]:32} {rule:16} {mark}"
        )
    print(f"\n合計 {len(catalog)} 指標")
    return 0


def cmd_maintenance(config: Config, args: argparse.Namespace) -> int:
    """CI から呼ぶ想定。手当てが要るときだけ終了コード 3 を返す。"""
    findings = maintenance_report(config)
    print(as_text(findings))
    if needs_action(findings) or (args.strict and findings):
        return 3
    return 0


def cmd_doctor(config: Config, args: argparse.Namespace) -> int:
    problems = 0
    print(f"econ-calendar {__version__}\n")

    print(f"{OK} 設定ファイル : {config.path or '（既定値のみ）'}")
    print(f"{OK} タイムゾーン : {config.get('timezone')}")
    start, end = window_dates(config)
    print(f"{OK} 同期期間     : {start} 〜 {end}")
    print(f"{OK} 選抜しきい値 : 影響度 {config.get('filter.min_impact')} 以上\n")

    catalog = load_catalog()
    print(f"{OK} 指標カタログ : {len(catalog)} 件（うちルール展開 {len(catalog.with_rules())} 件）")

    names = [p.name for p in build_providers(config)]
    print(f"{OK} 有効な取得元 : {', '.join(names) if names else 'なし'}"
          + ("（オフラインモード）" if config.offline else ""))

    meetings = load_meetings()
    for bank in ("fomc", "boj", "ecb"):
        entries = (meetings.get(bank) or {}).get("meetings") or []
        state = f"{max(m['date'] for m in entries)} まで登録済み" if entries else "未登録"
        print(f"{OK if entries else WARN} {bank.upper():5} 日程 : {state}")

    findings = maintenance_report(config)
    if findings:
        print()
        for finding in findings:
            marker = BAD if finding.severity == ACTION else WARN
            print(f"{marker} {finding.render()}")
        problems += sum(1 for f in findings if f.severity == ACTION)

    print()
    try:
        client = CalendarClient(config)
        calendar_id = client.ensure_calendar(create=False)
        print(f"{OK} Google 認証  : OK（同期先 {calendar_id}）")
    except AuthError as exc:
        problems += 1
        print(f"{BAD} Google 認証  : {exc}")
    except Exception as exc:  # noqa: BLE001 - doctor should report, not crash
        print(f"{WARN} Google 接続  : {exc}")

    print()
    if problems:
        print(f"{WARN} {problems} 件の要対応があります。")
    else:
        print(f"{OK} 問題は見つかりませんでした。")
    return 1 if problems else 0


# ---------------------------------------------------------------------------

def _print_table(events: list[EconEvent], config: Config, start: date, end: date) -> None:
    tz = config.tz
    print(f"期間 {start} 〜 {end}   タイムゾーン {config.get('timezone')}   {len(events)} 件\n")
    current: date | None = None
    for event in events:
        day = event.start.astimezone(tz).date()
        if day != current:
            current = day
            print()
        print("  " + render.one_line(event, config))
    counts: dict[str, int] = {}
    for event in events:
        counts[event.tier] = counts.get(event.tier, 0) + 1
    print("\n内訳: " + " / ".join(f"{t}:{counts.get(t,0)}" for t in ("S", "A", "B", "C")))
    print("~ 印は発表日が推定であることを示します。")


COMMANDS = {
    "sync": cmd_sync,
    "preview": cmd_preview,
    "digest": cmd_digest,
    "purge": cmd_purge,
    "auth": cmd_auth,
    "doctor": cmd_doctor,
    "maintenance": cmd_maintenance,
    "calendars": cmd_calendars,
    "notify": cmd_notify,
    "indicators": cmd_indicators,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    setup_logging(verbose=args.verbose, quiet=args.quiet)
    if args.offline:
        os.environ[OFFLINE_ENV] = "1"
    try:
        config = _apply_overrides(Config.load(args.config), args)
        return COMMANDS[args.command](config, args)
    except (AuthError, FetchError, FileNotFoundError, ValueError) as exc:
        print(f"{BAD} {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n中断しました。", file=sys.stderr)
        return 130
