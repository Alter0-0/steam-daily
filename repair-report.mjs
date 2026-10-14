import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(root, 'data', 'state.json');
const BASE = 'https://store.steampowered.com';
const [reportDate, appArg] = process.argv.slice(2);
const appid = Number(appArg);
if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !Number.isInteger(appid)) {
  throw new Error('用法：node repair-report.mjs YYYY-MM-DD APPID');
}

async function getJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'SteamDailyBrief/1.0' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}
function dateText(date) {
  const match = String(date || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
}
function gameFrom(detail, review) {
  const d = detail.data;
  const positive = review?.query_summary?.total_positive ?? 0;
  const total = review?.query_summary?.total_reviews ?? 0;
  const tags = (d.genres || d.categories || []).filter(x => x.description).slice(0, 8).map(x => x.description);
  return {
    id: appid,
    name: d.name,
    en: d.name,
    cover: d.header_image || `${BASE}/public/images/game/default_header.jpg`,
    price: d.is_free ? '免费' : d.price_overview?.final_formatted || '未定价',
    priceValue: d.price_overview?.final / 100 || (d.is_free ? 0 : 999999),
    rating: total ? Math.round(positive / total * 100) : null,
    reviews: total.toLocaleString('en-US'),
    time: `${reportDate.slice(0, 4)} 年 ${Number(reportDate.slice(5, 7))} 月 ${Number(reportDate.slice(8, 10))} 日`,
    releaseDate: reportDate,
    status: ['正式版上线', '补录'],
    tags,
    studio: (d.developers || []).join(', ') || '未知',
    publisher: (d.publishers || []).join(', ') || '未知',
    demo: false,
    firstSeen: reportDate,
    isNew: true,
    source: 'manual-repair',
    storeUrl: `${BASE}/app/${appid}/`
  };
}

const detailPayload = await getJson(`${BASE}/api/appdetails?appids=${appid}&cc=cn&l=schinese`);
const entry = detailPayload[String(appid)];
if (!entry?.success || entry.data?.type !== 'game') throw new Error(`Steam 未返回有效游戏：${appid}`);
const review = await getJson(`${BASE}/appreviews/${appid}?json=1&language=all&purchase_type=all`).catch(() => null);
const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
const report = state.reports.find(item => item.date === reportDate);
if (!report) throw new Error(`找不到日报：${reportDate}`);
const release = report.sections.find(section => section.key === 'release');
if (!release) throw new Error(`日报缺少发售分区：${reportDate}`);
release.games = release.games.filter(game => game.id !== appid);
release.games.push(gameFrom(entry, review));
release.games.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.name.localeCompare(b.name, 'zh'));
const temporary = `${stateFile}.tmp`;
await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
await fs.rename(temporary, stateFile);
console.log(`已将 ${entry.data.name} (${appid}) 补录到 ${reportDate} 日报`);
