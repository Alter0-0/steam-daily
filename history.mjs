// A missed snapshot cannot be recreated exactly. Historical recovery includes
// confirmed release dates only, with prices/reviews explicitly dated today.
export function shiftDate(date, offset) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

export function missingDates(reports, yesterday) {
  const existing = new Map(reports.map(report => [report.date, report]));
  const dates = reports.map(report => report.date).sort();
  if (!dates.length) return [];
  const first = dates[0] > shiftDate(yesterday, -29) ? dates[0] : shiftDate(yesterday, -29);
  const result = [];
  for (let date = first; date < yesterday; date = shiftDate(date, 1)) {
    if (!existing.has(date) || existing.get(date).recovery?.state === 'pending') result.push(date);
  }
  return result;
}

export function recoveryReport(date, games = [], recoveredAt = null, scanComplete = false) {
  const recovered = Boolean(recoveredAt);
  const note = recovered
    ? '补采记录：按 Steam 当前可核实的发售日期整理。价格、测评为补采时信息；当天新商品页及新增试玩按钮的历史无法还原。' + (scanComplete ? '' : ' 搜索未完整覆盖该日期，结果可能不全，后续会继续补查。')
    : '这天没有保存成功日报，正在等待补采。此处不表示当天没有新游戏；当天价格、测评和商品页首次出现历史无法还原。';
  const matching = [...new Map(games.filter(game => game.releaseDate === date).map(game => [game.id, game])).values()];
  return {
    date, label: recovered ? '补采日报' : '待补采', generatedAt: recoveredAt,
    recovery: { state: recovered && scanComplete ? 'recovered' : 'pending', recoveredAt, scanComplete, note },
    sections: [
      { key: 'release', title: '当日发售（补采）', tone: 'orange', games: matching.filter(game => !game.demo) },
      { key: 'new-page', title: '新发现商品页（历史不可还原）', tone: 'blue', games: [] },
      { key: 'demo', title: '当日发布 Demo（补采）', tone: 'mint', games: matching.filter(game => game.demo) }
    ]
  };
}

export async function recoverDates(dates, { getPage, getGame, now, maxPages = 80, onProgress = () => {} }) {
  const oldest = [...dates].sort()[0];
  const candidates = new Map(); const seenPages = new Set();
  let start = 0; let scanComplete = false; let olderPages = 0;
  for (let page = 0; page < maxPages; page++) {
    let payload;
    try { payload = await getPage(start); }
    catch (error) { if (!candidates.size) throw error; break; }
    const { items, total } = payload;
    if (!items.length) { scanComplete = true; break; }
    const fingerprint = items.map(item => item.appid).join(',');
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);
    items.filter(item => dates.includes(item.releaseDate)).forEach(item => candidates.set(item.appid, item));
    const dated = items.filter(item => item.releaseDate);
    olderPages = dated.length === items.length && dated.every(item => item.releaseDate < oldest) ? olderPages + 1 : 0;
    start += items.length;
    onProgress({ page: page + 1, start, candidates: candidates.size });
    if (olderPages >= 3 || (Number.isFinite(total) && start >= total)) { scanComplete = true; break; }
  }
  const games = []; let cursor = 0; let failures = 0;
  const queue = [...candidates.values()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      try {
        const game = await getGame(item);
        if (game) games.push({ ...game, recoveredAt: now });
      } catch { failures++; }
    }
  }));
  return dates.map(date => recoveryReport(date, games, now, scanComplete && failures === 0));
}
