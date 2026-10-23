import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSteamClient } from './steam-network.mjs';
import { runSweep, parseSearchPage } from './phase1.mjs';
import { cnDate, pageEvidence } from './release-time.mjs';
import { shiftDate } from './history.mjs';
import { createReviewService } from './review-service.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(root,'data');
await fs.mkdir(dataDir,{recursive:true});
const read=async(name,fallback)=>{try{return JSON.parse(await fs.readFile(path.join(dataDir,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=async(name,value)=>{const p=path.join(dataDir,name);await fs.writeFile(p+'.tmp',JSON.stringify(value,null,2));await fs.rename(p+'.tmp',p);};
const startedAt=new Date().toISOString();
const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
const latest=shiftDate(cnDate(),hour<4?-2:-1);
const lock=path.join(dataDir,'collector.lock');
let acquired=false;
try {
  try {const owner=await read('collector.lock',null);if(owner){let alive=true;try{process.kill(owner.pid,0);}catch(e){alive=e.code!=='ESRCH';}if(alive)throw new Error('另一个采集任务正在运行');await fs.unlink(lock);}}catch(e){if(e.code!=='ENOENT')throw e;}
  const handle=await fs.open(lock,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,startedAt}));await handle.close();acquired=true;
  const state=await read('state.json',{reports:[],firstSeen:{}});
  const cache=await read('detail-cache.json',{});
  // Cloud egress hit Steam's search limit with the former 1.4-second spacing.
  const client=createSteamClient({interval:5000});
  // A failure in the review API must not block the independent store service.
  const reviewClient=createSteamClient({interval:5000,timeoutMs:12000,maxAttempts:1});
  const reviews=createReviewService({request:reviewClient});
  let lastLoggedStage=null;
  const maxDetails=Number(process.env.MAX_DETAILS||0);
  if(!Number.isInteger(maxDetails)||maxDetails<0||maxDetails>1000)throw new Error('每轮条数必须为0至1000的整数');
  const priorityInput=process.env.PRIORITY_APP_IDS?.trim()||'';
  if(priorityInput&&!/^\d+(?:[\s,]+\d+)*$/.test(priorityInput))throw new Error('优先核验列表只能包含以逗号或空格分隔的 Steam AppID');
  const priorityIds=[...new Set(priorityInput.split(/[\s,]+/).filter(Boolean).map(Number))];
  if(priorityIds.length>20||priorityIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('每轮最多优先核验20个有效 AppID');
  let priorityRequests=[];
  try {priorityRequests=JSON.parse(await fs.readFile(path.join(root,'priority-games.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const budget=Date.now()+30*60*1000;
  const searchBudget=Date.now()+8*60*1000;
  let requestHalted=false;
  const request=async(url,options)=>{try{return await client(url,options);}catch(e){if(/403|429|限制请求|已暂停/.test(e.message))requestHalted=true;throw e;}};
  await write('status.json',{state:'running',startedAt,message:'正在复查近期发售并校正北京时间；已发布日报仍会补充'});
  const summary=await runSweep(state,{
    now:startedAt,latest,force30:process.argv.includes('--review-30'),
    maxDetails:maxDetails||Infinity,priorityIds,priorityRequests,
    deadline:()=>Date.now()>budget||requestHalted,
    scanDeadline:()=>Date.now()>searchBudget,
    stopReason:()=>requestHalted?'steam-limit':Date.now()>budget?'time-budget':null,
    save:()=>write('state.json',state),
    onProgress:async progress=>{
      await write('status.json',{state:'running',...progress,reviewService:reviews.stats(),message:'本轮采集中；网页显示最近已发布的进度快照'});
      if(progress.stage!==lastLoggedStage||progress.processed>0&&progress.processed%10===0){console.log(JSON.stringify({progress:progress.stage,processed:progress.processed,basicCompleted:progress.basicCompleted,completedDetails:progress.completedDetails,failed:progress.failed,reviewService:reviews.stats()}));lastLoggedStage=progress.stage;}
    },
    getPage:async(filter,start)=>{
      const params=new URLSearchParams({query:'',start:String(start),count:'100',sort_by:'Released_DESC',infinite:'1',cc:'cn',l:'schinese',category1:filter==='demo'?'10':'998'});
      const p=await request('https://store.steampowered.com/search/results/?'+params);
      if(p.success!==1||typeof p.results_html!=='string')throw new Error('Steam 搜索未返回有效数据');
      const page=parseSearchPage(p,start);const {items}=page;
      if(p.results_html.includes('data-ds-appid=')&&!items.length)throw new Error('Steam 搜索格式发生变化，等待核实');
      console.log(JSON.stringify({search:filter,start,nextStart:page.nextStart,received:items.length,total:Number(p.total_count),first:items[0]?.appid,last:items.at(-1)?.appid}));
      return page;
    },
    getDetail:async record=>{
      const id=record.item.appid;
      const cached=cache[id];
      let result,reviewError=null,pageError=null;
      if(cached?.result?.detail && Date.now()-Date.parse(cached.savedAt)<48*3600000)result=cached.result;
      else {
        const p=await request(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=cn&l=schinese`);
        const detail=p[id];
        if(!detail?.success)throw new Error(`详情 ${id} 暂不可用，已保留搜索记录`);
        if(!['game','demo'].includes(detail.data.type))return null;
        const d=detail.data;
        result={detail:{success:true,data:Object.fromEntries(['type','name','is_free','price_overview','header_image','genres','developers','publishers','release_date'].map(k=>[k,d[k]]))},review:null};
        cache[id]={...cached,savedAt:new Date().toISOString(),result};
        await write('detail-cache.json',cache);
      }
      let evidence=cached?.evidence&&Date.now()-Date.parse(cached.evidenceAt)<24*3600000?cached.evidence:null;
      if(!evidence&&!requestHalted) {
        const html=await request(`https://store.steampowered.com/app/${id}/?cc=cn&l=schinese`,{format:'text'}).catch(e=>{pageError=e.message;return null;});
        if(html){evidence=pageEvidence(html);cache[id]={...cache[id],evidence,evidenceAt:new Date().toISOString()};await write('detail-cache.json',cache);}
      }
      if(!result.review?.query_summary) {
        const response=await reviews.get(id);reviewError=response.error;
        if(response.review){result.review=response.review;cache[id]={...cache[id],result,reviewAt:new Date().toISOString()};await write('detail-cache.json',cache);}
      }
      return {...result,evidence,reviewError,pageError};
    }
  });
  await write('status.json',{...summary,reviewService:reviews.stats(),startedAt,finishedAt:new Date().toISOString()});
  console.log(JSON.stringify(summary));
  if(summary.stopReason==='steam-limit'||Object.keys(summary.scanErrors||{}).length||summary.failed)process.exitCode=1;
} catch(e) {
  if(acquired){const prior=await read('status.json',{});await write('status.json',{...(prior.startedAt===startedAt?prior:{}),state:'error',startedAt,finishedAt:new Date().toISOString(),stopReason:'error',reportDate:latest,message:e.message});}
  console.error(e);process.exitCode=1;
} finally {if(acquired)await fs.unlink(lock).catch(()=>{});}
