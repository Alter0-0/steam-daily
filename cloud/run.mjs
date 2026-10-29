import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {reportTarget,collectionHealth} from '../stability.mjs';
import {readData,updateRun} from './health.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const now = new Date();
  const target = reportTarget(now);
  let state = { reports: [] };
  try { state = JSON.parse(await fs.readFile(path.join(root, 'data/state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const latest = state.reports.find(report => report.date === target);
  const lastRunAt = state.phase1?.lastRunAt;
  if (lastRunAt && Date.now() - Date.parse(lastRunAt) < 45 * 60 * 1000 && latest && !process.argv.includes('--review-30') && !process.env.PRIORITY_APP_IDS?.trim() && !Number(process.env.MAX_DETAILS) && process.env.AUTO_RESUME!=='true') {
    await updateRun(root,{target,collection:{attempted:false,reason:'cooldown',at:now.toISOString(),lastAttemptAt:lastRunAt}});
    console.log('距离上次复查不足45分钟，等待下一轮；已发布日报仍会持续复查');
  } else {
    const startedAt = now.toISOString();
    await updateRun(root,{target,collection:{attempted:true,startedAt,health:'running'}});
    // Each run resumes durable candidates and revisits recently published days.
    const args = ['phase1-collector.mjs', ...process.argv.slice(2)];
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 35 * 60 * 1000, killSignal: 'SIGTERM' });
    if (result.error || result.signal) {
      await fs.mkdir(path.join(root, 'data'), { recursive: true });
      let checkpoint={};
      try{checkpoint=JSON.parse(await fs.readFile(path.join(root,'data/status.json'),'utf8'));}catch{}
      await fs.writeFile(path.join(root, 'data/status.json'), JSON.stringify({ ...checkpoint,state: 'error', startedAt, finishedAt: new Date().toISOString(), reportDate: target,stopReason:'interrupted',message: '本轮达到运行时限或中断，已成功的请求已保存；下轮继续' }, null, 2));
    }
    const status=await readData(root,'status.json',{});
    await updateRun(root,{collection:{attempted:true,startedAt,finishedAt:new Date().toISOString(),health:result.status===0?collectionHealth(status):'error',processed:status.processed||0,basicCompleted:status.basicCompleted||0,failed:status.failed||0,stopReason:status.stopReason||null,exitCode:result.status??1}});
    process.exitCode = result.status ?? 1;
  }
