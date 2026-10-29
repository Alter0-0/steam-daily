import test from 'node:test';
import assert from 'node:assert/strict';
import {initialize,runSweep,workQueue,sweepPlan,preserveSnapshot} from '../phase1.mjs';
import {pageEvidence,resolveReleaseTime} from '../release-time.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {buildSite} from '../cloud/build.mjs';
const now='2026-10-19T05:00:00.000Z',latest='2026-10-18';
const emptyPage=async()=>({items:[],total:0});
function fixture(){const state={reports:[]};initialize(state,now);return state;}
function add(state,id,kind='missing-game',extra={}){
  const demo=kind==='missing-demo';
  state.phase1.catalog[id]={item:{appid:id,searchName:'Game '+id,releasedText:'16 Oct, 2026',releaseDate:'2026-10-16',sources:[demo?'demo':'games']},firstObservedAt:'2026-10-18T00:00:00.000Z',
    ...(kind.startsWith('missing')?{}:{snapshot:{id,name:'Old '+id,releaseDate:'2026-10-16',price:'¥10',reviews:'10',rating:80,metadataPending:[],demo:false}}),
    ...(kind==='refresh'?{verifiedAt:'2026-10-17T00:00:00.000Z'}:{}),...extra};
}
const response=r=>({detail:{success:true,data:{type:r.item.sources.includes('demo')?'demo':'game',name:'中文游戏 '+r.item.appid,is_free:true,release_date:{date:'16 Oct, 2026'},genres:[]}},review:{query_summary:{total_reviews:10,total_positive:8}},html:'<html></html>'});
test('unknown price can be completed while a previously known price remains historical',()=>{
  const fresh={price:'¥30',priceValue:30,priceSnapshotAt:now};
  assert.equal(preserveSnapshot({price:'未定价',priceValue:999999},fresh).price,'¥30');
  assert.equal(preserveSnapshot({price:'¥10',priceValue:10},fresh).price,'¥10');
});
test('one-item resumptions give recent basics 75 percent while preserving other work',async()=>{
  let state=fixture();
  for(let i=1;i<=30;i++)add(state,i,i<=10?'missing-game':i<=20?'missing-demo':i<=25?'verify':'refresh',i>10&&i<=20?{item:{appid:i,releaseDate:'2026-10-01',releasedText:'1 Oct, 2026',sources:['demo']},firstObservedAt:'2026-10-01T00:00:00.000Z'}:{});
  for(let i=200;i<240;i++)add(state,i);
  add(state,90,'verify');state.phase1.catalog[90].snapshot.metadataPending=['reviews'];
  add(state,100,'verify',{priorityRequestedAt:now});
  const ids=[];
  for(let i=0;i<32;i++){
    await runSweep(state,{now:new Date(Date.parse(now)+i*3600000).toISOString(),latest,getPage:emptyPage,getDetail:async r=>{ids.push(r.item.appid);return response(r);},maxDetails:1});
    state=JSON.parse(JSON.stringify(state));
  }
  assert.equal(ids[0],100);assert.ok(ids.filter(id=>id<=10||id>=200).length>=24);assert.ok(ids.filter(id=>id>10&&id<=20).length>=2);
  assert.ok(ids.includes(90));assert.ok(ids.some(id=>id>=21&&id<=25));assert.ok(ids.some(id=>id>=26&&id<=30));assert.equal(new Set(ids).size,32);
});
test('backoff is obeyed and older retries precede later arrivals',()=>{
  const state=fixture();add(state,1,'missing-game',{lastAttemptAt:'2026-10-18T01:00:00.000Z',retryAfter:'2026-10-19T06:00:00.000Z'});
  add(state,2,'missing-game',{firstObservedAt:'2026-10-19T04:00:00.000Z'});
  assert.deepEqual(workQueue(state,sweepPlan(state,now,latest),now).map(r=>r.item.appid),[2]);
  const later='2026-10-19T07:00:00.000Z';
  assert.deepEqual(workQueue(state,sweepPlan(state,later,latest),later).map(r=>r.item.appid),[1,2]);
});
test('a failed older game is eventually retried despite new arrivals every run',async()=>{
  let state=fixture();add(state,1,'missing-game',{lastAttemptAt:'2026-10-18T01:00:00.000Z'});
  const processed=[];
  for(let run=0;run<5;run++){
    for(let i=0;i<8;i++)add(state,100+run*8+i,'missing-game',{firstObservedAt:new Date(Date.parse(now)+run*3600000).toISOString()});
    await runSweep(state,{now:new Date(Date.parse(now)+run*3600000).toISOString(),latest,getPage:emptyPage,getDetail:async r=>{processed.push(r.item.appid);return response(r);},maxDetails:1});
    state=JSON.parse(JSON.stringify(state));
  }
  assert.equal(processed[0],1);
});
test('one-time reported priority does not repeatedly refill its lane',async()=>{
  const state=fixture();add(state,1);add(state,2);const requested=[{appid:2,requestedAt:now}];const order=[];
  await runSweep(state,{now,latest,priorityRequests:requested,getPage:emptyPage,getDetail:async r=>{order.push(r.item.appid);return response(r);},maxDetails:1});
  const result=await runSweep(state,{now:'2026-10-19T06:00:00.000Z',latest,priorityRequests:requested,getPage:emptyPage,getDetail:async r=>{order.push(r.item.appid);return response(r);},maxDetails:1});
  assert.deepEqual(order,[2,1]);assert.equal(result.missingDetails,0);assert.equal(state.phase1.catalog[2].priorityAttemptedAt,now);
});
test('split counters and checkpoints count completions rather than successful requests',async()=>{
  const state=fixture();add(state,1);add(state,2);add(state,3,'verify');add(state,4,'refresh');add(state,5);
  const updates=[];
  const result=await runSweep(state,{now,latest,getPage:emptyPage,getDetail:async r=>r.item.appid===5?null:r.item.appid===2?{...response(r),review:null}:response(r),onProgress:async p=>updates.push(structuredClone(p))});
  assert.equal(result.processed,5);assert.equal(result.completedDetails,1);assert.equal(result.verified,2);assert.equal(result.excluded,1);assert.equal(result.failed,1);
  assert.equal(result.missingDetails,1);assert.equal(result.initialVerification,0);assert.equal(result.waitingRetry,1);assert.equal(result.stopReason,'request-failed');
  assert.equal(updates.at(-1).stage,'finished');assert.equal(updates.filter(p=>p.stage==='details').length,6);
  assert.equal(updates.at(-1).processed,state.phase1.lastSummary.processed);
});
test('budget, network limit and batch stop are distinguishable and resume work',async()=>{
  for(const reason of ['time-budget','steam-limit']){
    const state=fixture();add(state,1);let halt=false;
    const result=await runSweep(state,{now,latest,getPage:emptyPage,getDetail:async()=>{halt=true;throw new Error('429');},deadline:()=>halt,stopReason:()=>halt?reason:null});
    assert.equal(result.stopReason,reason);assert.equal(result.processed,1);assert.equal(result.state,'partial');assert.equal(result.missingDetails,1);
  }
  const state=fixture();add(state,1);add(state,2);
  const result=await runSweep(state,{now,latest,getPage:emptyPage,getDetail:response,maxDetails:1});
  assert.equal(result.stopReason,'batch-limit');assert.equal(result.processed,1);assert.equal(result.missingDetails,1);
});
test('cached compact page evidence produces the same Beijing time as the page',()=>{
  const html='{"app_release_date":1792115973}';
  const args={storeText:'15 Oct, 2026',now};
  assert.deepEqual(resolveReleaseTime({...args,html}),resolveReleaseTime({...args,evidence:pageEvidence(html)}));
});
test('a long search leaves a reserved detail window and does not claim search completion',async()=>{
  const state=fixture();add(state,1);
  const summary=await runSweep(state,{now,latest,getPage:()=>{throw new Error('must not request');},scanDeadline:()=>true,getDetail:response});
  assert.equal(summary.processed,1);assert.equal(summary.completedDetails,1);assert.equal(summary.scansComplete,false);assert.equal(summary.stopReason,'search-incomplete');
});
test('unfinished routine refreshes cannot be labeled fully complete',async()=>{
  const state=fixture();add(state,1,'refresh');add(state,2,'refresh');
  const result=await runSweep(state,{now,latest,getPage:emptyPage,getDetail:response,maxDetails:1});
  assert.equal(result.missingDetails,0);assert.equal(result.state,'partial');assert.equal(result.stopReason,'batch-limit');
});
test('parent timeout preserves checkpoint counters and provides a visible interruption reason',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steam-progress-timeout-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'cloud'));await fs.mkdir(path.join(dir,'data'));
  await fs.copyFile(new URL('../cloud/run.mjs',import.meta.url),path.join(dir,'cloud/run.mjs'));
  await fs.copyFile(new URL('../cloud/health.mjs',import.meta.url),path.join(dir,'cloud/health.mjs'));
  await fs.copyFile(new URL('../stability.mjs',import.meta.url),path.join(dir,'stability.mjs'));
  for(const name of ['phase1.mjs','release-time.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(dir,name));
  await fs.copyFile(new URL('../history.mjs',import.meta.url),path.join(dir,'history.mjs'));
  await fs.writeFile(path.join(dir,'data/status.json'),JSON.stringify({processed:7,completedDetails:5,missingDetails:20}));
  await fs.writeFile(path.join(dir,'preload.mjs'),`
    import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    cp.spawnSync=()=>({error:new Error('ETIMEDOUT'),status:null,signal:'SIGTERM'});syncBuiltinESMExports();
    const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...a){super(...(a.length?a:['2026-10-19T05:00:00Z']));}static now(){return OriginalDate.parse('2026-10-19T05:00:00Z');}};
  `);
  const r=spawnSync(process.execPath,['--import','./preload.mjs','cloud/run.mjs'],{cwd:dir,encoding:'utf8',timeout:10000});assert.equal(r.status,1,r.stderr);
  const status=JSON.parse(await fs.readFile(path.join(dir,'data/status.json')));assert.equal(status.processed,7);assert.equal(status.completedDetails,5);assert.equal(status.missingDetails,20);assert.equal(status.state,'error');assert.equal(status.stopReason,'interrupted');
});
test('old status publication derives backlog without inventing historical completed counts',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steam-progress-build-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const state=fixture();add(state,1);add(state,2,'verify');add(state,3,'refresh');
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
  await fs.writeFile(path.join(dir,'status.json'),JSON.stringify({state:'partial',reportDate:latest,processed:237}));
  await buildSite(path.join(dir,'site'),dir);
  const status=JSON.parse(await fs.readFile(path.join(dir,'site/data/status.json')));
  assert.equal(status.missingDetails,1);assert.equal(status.initialVerification,1);assert.equal(status.processed,237);assert.equal(status.completedDetails,undefined);
  const published=JSON.parse(await fs.readFile(path.join(dir,'site/data/state.json')));assert.equal(published.phase1,undefined);
});
test('collector reuses successful detail, review and page evidence across retries',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steam-progress-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const name of ['phase1-collector.mjs','phase1.mjs','release-time.mjs','history.mjs','steam-network.mjs','review-service.mjs','stability.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(dir,name));
  await fs.writeFile(path.join(dir,'preload.mjs'),`
    const timer=setTimeout;globalThis.setTimeout=(f,ms,...a)=>timer(f,Math.min(ms,1),...a);
    globalThis.fetch=async value=>{const u=new URL(value);console.log('FETCH '+u.pathname);let p;
      if(u.pathname==='/search/results/')p={success:1,total_count:u.searchParams.get('category1')==='10'?0:1,results_html:u.searchParams.get('category1')==='10'?'':'<a data-ds-appid="1"><span class="title">One</span><div class="search_released">16 Oct, 2026</div></a>'};
      else if(u.pathname==='/api/appdetails')p={'1':{success:true,data:{type:'game',name:'One',is_free:true,release_date:{date:'16 Oct, 2026'}}}};
      else if(u.pathname.startsWith('/IUserReviewsService/'))p=process.env.FAIL_REVIEW==='true'?{}:{response:{query_summary:{total_reviews:1,total_positive:1}}};
      else return {ok:true,text:async()=>'<html></html>'};return{ok:true,json:async()=>p};};
  `);
  const collect=fail=>spawnSync(process.execPath,['--import','./preload.mjs','phase1-collector.mjs'],{cwd:dir,encoding:'utf8',timeout:15000,env:{...process.env,FAIL_REVIEW:String(fail)}});
  const first=collect(true);assert.equal(first.status,0,first.stderr);
  const partial=JSON.parse(await fs.readFile(path.join(dir,'data/status.json')));assert.equal(partial.state,'partial');assert.equal(partial.failed,1);assert.equal(partial.basicCompleted,1);
  assert.equal((first.stdout.match(/FETCH \/IUserReviewsService\//g)||[]).length,1);
  const statePath=path.join(dir,'data/state.json');const state=JSON.parse(await fs.readFile(statePath));state.phase1.catalog[1].retryAfter=null;await fs.writeFile(statePath,JSON.stringify(state));
  const second=collect(false);assert.equal(second.status,0,second.stderr);
  assert.doesNotMatch(second.stdout,/FETCH \/api\/appdetails|FETCH \/app\/1/);assert.match(second.stdout,/FETCH \/IUserReviewsService\//);
  const status=JSON.parse(await fs.readFile(path.join(dir,'data/status.json')));assert.equal(status.completedDetails,1);assert.equal(status.missingDetails,0);
});
