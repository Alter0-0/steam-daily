export async function scanByDate(getPage, cutoffDate, { maxPages = 80, onProgress = () => {} } = {}) {
  const candidates = new Map(); const signatures = new Set();
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const { items, total } = await getPage(start);
    if (!items.length) return [...candidates.values()];
    const signature = items.map(item => item.appid).join(',');
    if (signatures.has(signature)) throw new Error('Steam 搜索重复返回同一页，覆盖不完整，将重试');
    signatures.add(signature);
    for (const item of items) if (item.releaseDate && item.releaseDate >= cutoffDate) candidates.set(item.appid, item);
    start += items.length;
    onProgress({ page: page + 1, start, candidates: candidates.size });
    // Do not assume Steam honours count=100; it can return fewer rows per page.
    if (Number.isFinite(total) && start >= total) return [...candidates.values()];
    if (items.every(item => item.releaseDate && item.releaseDate < cutoffDate)) return [...candidates.values()];
  }
  throw new Error(`搜索达到 ${maxPages} 页保护上限，覆盖尚未完成，将重试`);
}

export function mergeDailyReport(previous, date, games, { generatedAt, scanComplete, pendingIds = [], scanError = null }) {
  const saved = new Map((previous?.sections || []).flatMap(section => section.games).map(game => [game.id, game]));
  games.forEach(game => saved.set(game.id, game));
  const all = [...saved.values()];
  const complete = scanComplete && pendingIds.length === 0;
  return {
    date, label: complete ? '日报' : '部分完成', generatedAt,
    collection: { state: complete ? 'complete' : 'partial', scanComplete, pendingIds, scanError },
    sections: [
      { key: 'release', title: '今日发售', tone: 'orange', games: all.filter(g => !g.demo && g.releaseDate === date) },
      { key: 'new-page', title: '新发现商品页', tone: 'blue', games: all.filter(g => !g.demo && g.isNew) },
      { key: 'demo', title: '新出现 Demo', tone: 'mint', games: all.filter(g => g.demo && (g.releaseDate === date || g.isNew)) }
    ]
  };
}
