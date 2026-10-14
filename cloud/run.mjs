import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { missingDates, shiftDate } from '../history.mjs';

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
  const pending = missingDates(state.reports, target);
  if (latest && !latest.recovery && latest.collection?.state !== 'partial' && !pending.length && !state.reports.some(r => r.collection?.state === 'partial')) {
    console.log(`${target} 日报已完成，不重复访问 Steam`);
  } else {
    const startedAt = now.toISOString();
    const result = spawnSync(process.execPath, ['collector.mjs'], { cwd: root, stdio: 'inherit', timeout: 35 * 60 * 1000, killSignal: 'SIGTERM' });
    if (result.error || result.signal) {
      await fs.mkdir(path.join(root, 'data'), { recursive: true });
      await fs.writeFile(path.join(root, 'data/status.json'), JSON.stringify({ state: 'error', startedAt, finishedAt: new Date().toISOString(), reportDate: target, message: '本轮达到运行时限或中断，已成功的请求已保存；下轮继续' }, null, 2));
    }
    process.exitCode = result.status ?? 1;
  }
}
