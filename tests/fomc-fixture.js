/**
 * Fed の会合日程ページを模した HTML。
 *
 * ここに書かれた 2027 年の日付は**パーサを試すための作り物**であって、
 * 実際に Fed が公表した日程ではありません。日程そのものの正しさは
 * src/02_meetings.js（手入力）と公式ページが担保します。
 */

function meetingRow(month, dates, starred) {
  return '<div class="row fomc-meeting">'
    + '<div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>'
    + month + '</strong></div>'
    + '<div class="fomc-meeting__date col-xs-4 col-sm-1 col-md-2">'
    + dates + (starred ? '<em>*</em>' : '') + '</div>'
    + '<div class="col-xs-3 col-sm-8 col-md-8">'
    + '<p><a href="/newsevents/pressreleases/monetary.htm">Statement:</a> '
    + '<a href="#">PDF</a> | <a href="#">HTML</a></p></div>'
    + '</div>';
}

function panel(year, rows) {
  return '<div class="panel panel-default">'
    + '<div class="panel-heading"><h4 class="panel-title">' + year
    + ' FOMC Meetings</h4></div>'
    + '<div class="panel-body">' + rows.join('\n') + '</div></div>';
}

/** 通常どおりの年（8回・うち4回に SEP のアスタリスク）。 */
const VALID_YEAR_HTML = panel(2027, [
  meetingRow('January', '26-27', false),
  meetingRow('March', '16-17', true),
  meetingRow('April', '27-28', false),
  meetingRow('June', '15-16', true),
  meetingRow('July', '27-28', false),
  meetingRow('September', '21-22', true),
  meetingRow('November', '2-3', false),
  meetingRow('December', '14-15', true),
]);

/**
 * 手入力（02_meetings.js）と**同じ年だが違う日付**の、検証を通る年。
 * これが無いと「手入力を上書きしない」保証を試せない
 * （検証に落ちる年を置いても、上書きされないのは当たり前になってしまう）。
 */
const CURATED_YEAR_HTML = panel(2026, [
  meetingRow('January', '20-21', false),
  meetingRow('March', '10-11', true),
  meetingRow('April', '14-15', false),
  meetingRow('June', '9-10', true),
  meetingRow('July', '14-15', false),
  meetingRow('September', '8-9', true),
  meetingRow('October', '20-21', false),
  meetingRow('December', '1-2', true),
]);

const PAGE_HTML = '<html><head><title>FOMC</title>'
  + '<style>.x{color:red}</style><script>var a=1;</script></head><body>'
  + '<h2>Meeting calendars and information</h2>'
  + CURATED_YEAR_HTML
  + VALID_YEAR_HTML
  + '<p>Historical Materials by Year</p></body></html>';

module.exports = { meetingRow, panel, VALID_YEAR_HTML, CURATED_YEAR_HTML, PAGE_HTML };
