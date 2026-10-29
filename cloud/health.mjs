import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reportTarget,collectionHealth,recentReadiness,recordAcceptance,newAcceptance,shouldContinue} from '../stability.mjs';
import {shiftDate} from '../history.mjs';
import {reconcileReports} from '../phase1.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function readData(root,name,fallback) {
  try{return JSON.parse(await fs.readFile(path.join(root,'data',name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
}
export async function writeData(root,name,value) {
  await fs.mkdir(path.join(root,'data'),{recursive:true});
  const file=path.join(root,'data',name);
  await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2));await fs.rename(file+'.tmp',file);
}
export async function updateRun(root,patch={}) {
  const ledger=await readData(root,'operations.json',{version:1,runs:[]});
  const id=process.env.GITHUB_RUN_ID||'local';
  let run=ledger.runs.find(r=>r.id===id);
  if(!run){run={id,event:process.env.GITHUB_EVENT_NAME||'local',automaticResume:process.env.AUTO_RESUME==='true',startedAt:new Date().toISOString(),target:reportTarget(),commit:process.env.GITHUB_SHA||null};ledger.runs.push(run);}
  Object.assign(run,patch);ledger.runs=ledger.runs.slice(-160);
  await writeData(root,'operations.json',ledger);return {ledger,run};
}
async function main() {
  const mode=process.argv[2];
  if(mode==='begin'){
    const state=await readData(root,'state.json',{reports:[]});
    const synchronization=reconcileReports(state,new Date().toISOString(),reportTarget());
    if(synchronization.apps||synchronization.removedPlaceholders)await writeData(root,'state.json',state);
    await updateRun(root,{synchronization});return;
  }
  const {ledger,run}=await updateRun(root);
  if(mode==='finalize') {
    run.finishedAt=new Date().toISOString();
    run.publication={state:process.env.PUBLISH_OUTCOME==='success'?'success':'failed',at:run.finishedAt};
    const state=await readData(root,'state.json',{reports:[]});
    run.readiness=recentReadiness(state.reports,run.target);
    if(!ledger.acceptance)ledger.acceptance=newAcceptance(shiftDate(run.target,1));
    recordAcceptance(ledger,run,state.reports);
    await writeData(root,'operations.json',ledger);
    const status=await readData(root,'status.json',{});
    console.log(JSON.stringify({publication:run.publication,collection:run.collection||{attempted:false,reason:'publish-only'},readiness:run.readiness}));
    if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`\n### 本轮状态\n\n- 网页发布：${run.publication.state}\n- 采集：${run.collection?.attempted?collectionHealth(status):'本轮未采集'}\n- 具体记录：data/operations.json（daily-data 分支）\n\n${run.readiness.map(d=>`${d.date}：发售 ${d.sections.release.readable}/${d.sections.release.total}，Demo ${d.sections.demo.readable}/${d.sections.demo.total}`).join('\n\n')}\n\n可读比例只针对已发现候选，不代表 Steam 全量覆盖。\n`);
    return;
  }
  if(mode==='continue') {
    if(!shouldContinue(run,run.readiness||[])||run.continuation){console.log('本轮无需追加续采');return;}
    const token=process.env.GH_TOKEN,repository=process.env.GITHUB_REPOSITORY;
    if(!token||!repository)throw new Error('缺少 GitHub 云端续采授权');
    // Only schedule events can create one continuation. The dispatched child
    // cannot dispatch another child, even when the queue remains unfinished.
    let response;
    try{
      response=await fetch(`https://api.github.com/repos/${repository}/actions/workflows/daily.yml/dispatches`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:JSON.stringify({ref:'main',inputs:{auto_resume:true}}),signal:AbortSignal.timeout(20000)});
    }catch(error){
      run.continuation={at:new Date().toISOString(),state:'failed',message:'GitHub 续采请求未取得响应'};
      await writeData(root,'operations.json',ledger);throw new Error('GitHub 续采请求未取得响应',{cause:error});
    }
    run.continuation={at:new Date().toISOString(),state:response.ok?'requested':'failed',httpStatus:response.status};
    await writeData(root,'operations.json',ledger);
    if(!response.ok)throw new Error(`追加续采请求失败：HTTP ${response.status}`);
    console.log('已追加一轮有限续采，不会无限触发');return;
  }
  throw new Error('Unknown health command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
