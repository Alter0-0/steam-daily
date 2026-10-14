import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingDates, recoveryReport, recoverDates } from './history.mjs';
import { createSteamClient } from './steam-network.mjs';
import { scanByDate, mergeDailyReport } from './scan.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');
const statusFile = path.join(dataDir, 'status.json');
const lockFile = path.join(dataDir, 'collector.lock');
const cacheFile = path.join(dataDir, 'detail-cache.json');
const BASE = 'https://store.steampowered.com';
const writers = new Map();

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function writeJson(file, value) {
  const operation = (writers.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporary, file);
  });
  writers.set(file, operation);
  return operation;
}
async function acquireLock() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const handle = await fs.open(lockFile, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const info = await fs.stat(lockFile);
      const owner = await readJson(lockFile, {});
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (!Number.isInteger(owner.pid) || !alive) {
        await fs.unlink(lockFile);
        return acquireLock();
      }
    } catch { return acquireLock(); }
    return false;
  }
}
async function releaseLock() { await fs.unlink(lockFile).catch(() => {}); }
const getJson = createSteamClient();
let detailCache = {};
function cnDate(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function dateOffset(date, offset) { const d = new Date(`${date}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + offset); return cnDate(d); }
function parseSearch(html) {
  const seen = new Set(); const items = [];
  const row = /data-ds-appid="(\d+)"[\s\S]*?<span class="title">([\s\S]*?)<\/span>[\s\S]*?<div class="search_released[^\"]*">([\s\S]*?)<\/div>/g;
  for (const match of html.matchAll(row)) {
    const appid = Number(match[1]); if (seen.has(appid)) continue; seen.add(appid);
    items.push({ appid, searchName: match[2].replace(/<[^>]+>/g, '').trim(), releasedText: match[3].replace(/<[^>]+>/g, '').trim() });
  }
  return items;
}
async function searchPage({ sort = 'Released_DESC', filter = 'games', count = 100, start = 0 } = {}) {
  // filter=games/demo is ignored by Steam; category1 selects the product type.
  const params = new URLSearchParams({ query: '', start: String(start), count: String(count), sort_by: sort, infinite: '1', cc: 'cn', l: 'english' });
  if (filter === 'games') params.set('category1', '998');
  if (filter === 'demo') params.set('category1', '10');
  const url = `${BASE}/search/results/?${params}`;
  const payload = await getJson(url);
  if (payload.success !== 1 || typeof payload.results_html !== 'string') throw new Error('Steam 搜索未返回有效数据');
  const items = parseSearch(payload.results_html).map(item => ({ ...item, releaseDate: releaseIso(item.releasedText) }));
  if (payload.results_html.includes('data-ds-appid=') && !items.length) throw new Error('Steam 搜索格式变化，无法解析历史页面');
  return { items, total: Number(payload.total_count) };
}
async function searchThroughDate({ filter, cutoffDate } = {}) {
  return scanByDate(start => searchPage({ filter, start }), cutoffDate, {
    onProgress: progress => console.log(`${filter}: page ${progress.page}; ${progress.candidates} candidates`)
  });
}
function textDate(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function releaseIso(value) {
  const chinese = String(value || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (chinese) return `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`;
  const match = String(value || '').match(/(\d{1,2})\s+([A-Za-z]{3}),\s*(\d{4})/);
  if (!match) return null;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${match[3]}-${months[match[2]] || '01'}-${match[1].padStart(2, '0')}`;
}
function normalize(item, detail, review, firstSeen, source, observedDate, isNew) {
  const d = detail.data || {}; const appid = item.appid;
  const positive = review?.query_summary?.total_positive ?? 0; const total = (review?.query_summary?.total_reviews ?? 0);
  const price = d.is_free ? '免费' : d.price_overview?.final_formatted || '未定价';
  const tags = (d.genres || d.categories || []).filter(x => x.description).slice(0, 8).map(x => x.description);
  const demo = d.type === 'demo';
  const status = demo ? ['Demo'] : tags.includes('抢先体验') ? ['抢先体验'] : releaseIso(item.releasedText) === observedDate ? ['正式版上线'] : [isNew ? '新商品页' : '商品页'];
  const release = textDate(d.release_date?.date || item.releasedText) || '日期待定';
  return { id: appid, name: d.name || item.searchName, en: d.name || item.searchName, cover: d.header_image || `${BASE}/public/images/game/default_header.jpg`, price, priceValue: d.price_overview?.final / 100 || (d.is_free ? 0 : 999999), rating: total ? Math.round(positive / total * 100) : null, reviews: total.toLocaleString('en-US'), time: release, releaseDate: releaseIso(item.releasedText), status, tags, studio: (d.developers || []).join(', ') || '未知', publisher: (d.publishers || []).join(', ') || '未知', demo, firstSeen, isNew, source, storeUrl: `${BASE}/app/${appid}/` };
}
async function detailFor(item) {
  const cached = detailCache[String(item.appid)];
  if (cached && Date.now() - Date.parse(cached.savedAt) < 48 * 3600 * 1000) return cached.result;
  const [detailPayload, reviewPayload] = await Promise.all([
    getJson(`${BASE}/api/appdetails?appids=${item.appid}&cc=cn&l=schinese`),
    getJson(`${BASE}/appreviews/${item.appid}?json=1&language=all&purchase_type=all`).catch(() => null)
  ]);
  const entry = detailPayload[String(item.appid)];
  if (!entry?.success) throw new Error(`Steam 未返回 ${item.appid} 的详情，留待重试`);
  const name = entry.data?.name || item.searchName || '';
  const excluded = (entry.data?.type !== 'game' && entry.data?.type !== 'demo') || /\b(soundtrack|supporter pack|artbook|content pack|dlc)\b|原声|支持者包|艺术设定集|扩展包/i.test(name);
  const d = entry.data;
  const result = excluded ? null : {
    detail: { success: true, data: Object.fromEntries(['type', 'name', 'is_free', 'price_overview', 'header_image', 'genres', 'categories', 'developers', 'publishers', 'release_date'].map(key => [key, d[key]])) },
    review: reviewPayload ? { query_summary: reviewPayload.query_summary } : null
  };
  // Checkpoint each success; a timeout or stopped runner does not lose progress.
  detailCache[String(item.appid)] = { savedAt: new Date().toISOString(), result };
  await writeJson(cacheFile, detailCache);
  return result;
}
async function collectDaily(state, reportDate, startedAt) {
  const previous = state.reports.find(report => report.date === reportDate);
  if (previous && !previous.recovery && previous.collection?.state !== 'partial') return;
  const candidates = new Map((previous?.collection?.pendingItems || []).map(item => [item.appid, item]));
  const errors = [];
  for (const filter of ['games', 'demo']) {
    try {
      const items = await searchThroughDate({ filter, cutoffDate: reportDate });
      for (const item of items) {
        const earlier = candidates.get(item.appid);
        candidates.set(item.appid, { ...item, sources: [...new Set([...(earlier?.sources || []), filter])] });
      }
    } catch (error) { errors.push(error.message); }
  }
  const games = []; const pendingItems = []; const baseline = previous?.collection?.baseline ?? !state.initialized;
  async function saveProgress(remaining) {
    const report = mergeDailyReport(previous, reportDate, games, {
      generatedAt: startedAt, scanComplete: errors.length === 0,
      pendingIds: remaining.map(item => item.appid), scanError: errors.join('；') || null
    });
    report.collection.pendingItems = remaining;
    report.collection.baseline = baseline;
    state.reports = [report, ...state.reports.filter(r => r.date !== reportDate)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
    if (games.length) state.initialized = true;
    state.generatedAt = startedAt;
    state.source = 'Steam public store API';
    await writeJson(stateFile, state);
  }
  const queue = [...candidates.values()];
  // Serial requests plus shared spacing avoid bursts that trigger 429s.
  for (const [index, item] of queue.entries()) {
    try {
      const result = await detailFor(item);
      if (!result) {
        if ((index + 1) % 25 === 0) await saveProgress([...pendingItems, ...queue.slice(index + 1)]);
        continue;
      }
      const id = String(item.appid);
      const existing = state.firstSeen[id];
      const firstSeen = existing || reportDate;
      const game = normalize(item, result.detail, result.review, firstSeen, item.sources?.join('+') || 'release-search', reportDate, !existing && !baseline);
      // An earlier failed attempt can already have recorded firstSeen.
      game.isNew = !baseline && firstSeen === reportDate;
      state.firstSeen[id] = firstSeen;
      games.push(game);
    } catch (error) {
      pendingItems.push(item);
      console.warn(`pending app ${item.appid}: ${error.message}`);
    }
    if ((index + 1) % 25 === 0) {
      await saveProgress([...pendingItems, ...queue.slice(index + 1)]);
      console.log(`${reportDate}: checkpoint ${index + 1}/${queue.length}; ${games.length} successful records saved`);
    }
  }
  await saveProgress(pendingItems);
  console.log(`${reportDate}: saved ${games.length} games; ${pendingItems.length} pending; scanComplete=${!errors.length}`);
}
async function main() {
  if (!(await acquireLock())) {
    console.log('Another Steam collector is already running; this retry will exit safely.');
    return;
  }
  const startedAt = new Date().toISOString(); const today = cnDate();
  try {
    const state = await readJson(stateFile, { reports: [], firstSeen: {}, records: {} });
    state.reports ||= []; state.firstSeen ||= {};
    detailCache = await readJson(cacheFile, {});
    for (const [id, entry] of Object.entries(detailCache)) if (Date.now() - Date.parse(entry.savedAt) > 48 * 3600 * 1000) delete detailCache[id];
    await writeJson(statusFile, { state: 'running', startedAt, message: '正在采集 Steam 公开数据' });
    const requested = process.argv.find(arg => arg.startsWith('--backfill='));
    const cnHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const yesterday = dateOffset(today, cnHour < 4 ? -2 : -1);
    // Prioritize the latest daily report before slower historical recovery.
    if (!requested) {
      await collectDaily(state, yesterday, startedAt);
      for (const report of [...state.reports]) {
        if (report.date !== yesterday && report.collection?.state === 'partial') await collectDaily(state, report.date, startedAt);
      }
    }
    const dates = requested ? requested.slice(11).split(',') : missingDates(state.reports || [], yesterday);
    if (dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= today || !Number.isFinite(Date.parse(date)))) throw new Error('补采日期必须为已过去的 YYYY-MM-DD');
    if (dates.length) {
      for (const date of dates) {
        if (!state.reports.some(report => report.date === date)) state.reports.push(recoveryReport(date));
      }
      state.reports.sort((a, b) => b.date.localeCompare(a.date));
      await writeJson(stateFile, state);
      await writeJson(statusFile, { state: 'running', startedAt, message: `正在补查缺失日报：${dates.join('、')}` });
      try {
        const recovered = await recoverDates(dates, {
          now: new Date().toISOString(),
          getPage: start => searchPage({ start, filter: '', count: 100 }),
          getGame: async item => {
            const result = await detailFor(item);
            if (!result || result.detail.data.release_date?.coming_soon) return null;
            const confirmedDate = releaseIso(result.detail.data.release_date?.date);
            if (!dates.includes(confirmedDate)) return null;
            const game = normalize({ ...item, releasedText: `${Number(confirmedDate.slice(8))} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(confirmedDate.slice(5,7))-1]}, ${confirmedDate.slice(0,4)}` }, result.detail, result.review, state.firstSeen[String(item.appid)] || null, 'historical-search', confirmedDate, false);
            return game;
          },
          onProgress: progress => console.log(`Backfill page ${progress.page}; ${progress.candidates} dated candidates`)
        });
        for (const report of recovered) {
          const index = state.reports.findIndex(saved => saved.date === report.date);
          // Never replace a genuine saved daily snapshot with reconstructed data.
          if (index < 0) state.reports.push(report);
          else if (state.reports[index].recovery) state.reports[index] = report;
        }
        state.reports.sort((a,b) => b.date.localeCompare(a.date));
        await writeJson(stateFile, state);
        if (requested) {
          const pending = recovered.some(report => report.recovery.state === 'pending');
          await writeJson(statusFile, { state: pending ? 'error' : 'success', startedAt, finishedAt: new Date().toISOString(), message: pending ? '历史补采未完成，将在下次运行继续' : `已补采：${dates.join('、')}` });
          if (pending) process.exitCode = 1;
          return;
        }
      } catch (error) {
        if (requested) throw error;
        console.warn(`Backfill deferred: ${error.message}`);
      }
    }
    const pendingDates = [...new Set([...missingDates(state.reports, yesterday), ...state.reports.filter(report => report.collection?.state === 'partial').map(report => report.date)])];
    const latest = state.reports.find(report => report.date === yesterday);
    const partial = latest?.collection?.state === 'partial';
    await writeJson(statusFile, {
      state: partial ? 'partial' : pendingDates.length ? 'error' : 'success',
      startedAt, finishedAt: new Date().toISOString(), reportDate: yesterday, pendingDates,
      message: partial ? '最新日报已保存成功条目，未完成项目将在下次任务继续' : pendingDates.length ? `最新日报已保存；仍待补采：${pendingDates.join('、')}` : '日报采集完成'
    });
    if (pendingDates.length) process.exitCode = 1;
  } catch (error) {
    await writeJson(statusFile, { state: 'error', startedAt, finishedAt: new Date().toISOString(), message: error.message });
    console.error(error); process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}
main();
