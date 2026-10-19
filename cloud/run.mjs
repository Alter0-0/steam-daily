import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { shiftDate } from '../history.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const now = new Date();
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(now));
if (hour < 4) {
  console.log('北京时间尚未到 04:00，等待日报时段');
} else {
  const target = shiftDate(date, -1);
  let state = { reports: [] };
  try { state = JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const latest = state.reports.find(report => report.date === target);
  const lastRunAt = state.phase1?.lastRunAt;
  if (lastRunAt && Date.now() - Date.parse(lastRunAt) < 45 * 60 * 1000 && latest && !process.argv.includes('--review-30')) {
    console.log('距离上次复查不足45分钟，等待下一轮；已发布日报仍会持续复查');
  } else {
    const startedAt = now.toISOString();
    // Each run resumes durable candidates and revisits recently published days.
    const args = ['phase1-collector.mjs', ...process.argv.slice(2)];
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 35 * 60 * 1000, killSignal: 'SIGTERM' });
    if (result.error || result.signal) {
      await fs.mkdir(path.join(root, 'data'), { recursive: true });
      await fs.writeFile(path.join(root, 'data/status.json'), JSON.stringify({ state: 'error', startedAt, finishedAt: new Date().toISOString(), reportDate: target, message: '本轮达到运行时限或中断，已成功的请求已保存；下轮继续' }, null, 2));
    }
    process.exitCode = result.status ?? 1;
  }
}
