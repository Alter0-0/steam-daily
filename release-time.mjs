// Keep Steam's date-only value separate from a verified event timestamp.
export function cnDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export function parseReleaseDate(value) {
  const text = String(value || '').trim();
  const cn = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const en = text.match(/(\d{1,2})\s+([A-Za-z]{3}),\s*(\d{4})/);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const result = cn ? `${cn[1]}-${cn[2].padStart(2,'0')}-${cn[3].padStart(2,'0')}`
    : en && months.includes(en[2]) ? `${en[3]}-${String(months.indexOf(en[2])+1).padStart(2,'0')}-${en[1].padStart(2,'0')}` : null;
  return result && Number.isFinite(Date.parse(result)) && new Date(result).toISOString().slice(0,10) === result ? result : null;
}
export function pageEvidence(html = '') {
  const decoded = html.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const timestamp = Number(decoded.match(/"app_release_date"\s*:\s*"?(\d{10})/)?.[1]);
  const early = decoded.match(/(?:抢先体验发行日期|Early Access Release Date):?<\/b>\s*([^<]+)/i)?.[1]?.trim() || null;
  // Announcements only supply an announced time, not proof of the exact unlock.
  const announcements = [...decoded.matchAll(/"event_name":"((?:\\.|[^"\\])*)"[\s\S]{0,500}?"rtime32_start_time":(\d+)/g)].flatMap(match => {
    try { return [{ title: JSON.parse(`"${match[1]}"`), timestamp: Number(match[2]) }]; } catch { return []; }
  });
  return { timestamp: timestamp || null, earlyAccessDate: parseReleaseDate(early), announcements };
}
export function resolveReleaseTime({ storeText, searchText, html = '', demo = false, earlyAccess = false, comingSoon = false, now = new Date() }) {
  const storeDate = parseReleaseDate(storeText) || parseReleaseDate(searchText);
  const evidence = pageEvidence(html);
  const withinDate = timestamp => storeDate && Number.isFinite(timestamp) && timestamp > 0 && timestamp * 1000 <= +new Date(now) && Math.abs(Date.parse(cnDate(timestamp * 1000)) - Date.parse(storeDate)) <= 2 * 86400000;
  const timestampMatches = withinDate(evidence.timestamp);
  let eventKind = demo ? 'demo' : earlyAccess ? 'early-access' : evidence.earlyAccessDate ? 'full-release' : 'release';
  let verifiedTimestamp = null; let announcedTimestamp = null;
  if (!comingSoon && timestampMatches && (!evidence.earlyAccessDate || earlyAccess)) verifiedTimestamp = evidence.timestamp;
  // The reviews timestamp can refer to the ORIGINAL Early Access launch.
  // Never reuse it for a much later full release.
  if (!comingSoon && !verifiedTimestamp && evidence.earlyAccessDate && !earlyAccess) {
    announcedTimestamp = evidence.announcements.find(event => withinDate(event.timestamp) && /正式版|正式发售|full release|1\.0|leave.*early access/i.test(event.title))?.timestamp || null;
  }
  const chosen = verifiedTimestamp || announcedTimestamp;
  const releaseAt = chosen ? new Date(chosen * 1000).toISOString() : null;
  const precision = verifiedTimestamp ? 'store-timestamp' : announcedTimestamp ? 'announcement' : 'date-only';
  const date = releaseAt ? cnDate(releaseAt) : storeDate;
  const time = releaseAt ? `${new Date(releaseAt).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false })}（北京时间${announcedTimestamp ? '，发布公告时间' : '，商店上线记录'}）`
    : `${storeText || searchText || '日期待定'}（Steam 标注，具体时刻未核实）`;
  return { releaseDate: date, releaseAt, storeReleaseDate: storeDate, storeReleaseText: storeText || searchText || null, time, timePrecision: precision, eventKind, earlyAccessDate: evidence.earlyAccessDate, comingSoon, timeEvidence: { pageTimestamp: evidence.timestamp, announcementTimestamp: announcedTimestamp } };
}
