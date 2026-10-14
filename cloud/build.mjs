import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const site = path.join(root, 'site');
export async function buildSite(destination = site, dataRoot = path.join(root, 'data')) {
  let html = await fs.readFile(path.join(root, 'outputs/steam-daily.html'), 'utf8');
  const demoStart = html.indexOf('    let reports = [');
  const demoEnd = html.indexOf('    const state =', demoStart);
  if (demoStart < 0 || demoEnd < 0) throw new Error('网页结构变化，无法移除演示数据');
  html = html.slice(0, demoStart) + '    let reports = [];\n\n' + html.slice(demoEnd);
  html = html.replace('</head>', '<script>window.STEAM_DAILY_STATIC = true;</script></head>');
  html = html.replace('<strong>演示数据</strong> · 等待本地采集器', '<strong>云端日报</strong> · 正在载入已保存日报');
  html = html.replace('当前显示内置演示日报 · <strong>V1</strong>', '正在连接云端日报');
  await fs.mkdir(path.join(destination, 'data'), { recursive: true });
  for (const name of ['index.html', 'steam-daily.html']) await fs.writeFile(path.join(destination, name), html);
  let saved = { reports: [], generatedAt: null };
  let status = { state: 'never-run', message: '等待首次云端采集' };
  try { saved = JSON.parse(await fs.readFile(path.join(dataRoot, 'state.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { status = JSON.parse(await fs.readFile(path.join(dataRoot, 'status.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Publish report fields only. Detail cache and operational metadata stay out.
  await fs.writeFile(path.join(destination, 'data/state.json'), JSON.stringify({ reports: saved.reports || [], generatedAt: saved.generatedAt || null }));
  await fs.writeFile(path.join(destination, 'data/status.json'), JSON.stringify(status));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
  console.log('已生成 site/ 云端网页（真实日报，无演示游戏）');
}
