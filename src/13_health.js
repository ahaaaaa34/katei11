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
