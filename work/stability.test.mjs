import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {reportTarget,collectionHealth,sectionReadiness,newAcceptance,recordAcceptance,acceptanceView,shouldContinue} from '../stability.mjs';
import {initialize,runSweep} from '../phase1.mjs';
import {buildSite} from '../cloud/build.mjs';

test('overnight resumes keep the previous issue until exactly Beijing 04:00',()=>{
  assert.equal(reportTarget(new Date('2026-10-29T19:59:59Z')),'2026-10-28');
  assert.equal(reportTarget(new Date('2026-10-29T20:00:00Z')),'2026-10-29');
  assert.equal(reportTarget(new Date('2026-10-29T16:40:00Z')),'2026-10-28');
});

test('early morning wrapper actually invokes collection; cooldown is recorded separately',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steam-overnight-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'cloud'));await fs.mkdir(path.join(dir,'data'));
  for(const name of ['cloud/run.mjs','cloud/health.mjs','stability.mjs','history.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(dir,name));
  await fs.writeFile(path.join(dir,'preload.mjs'),`
    import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';
    cp.spawnSync=()=>{fs.writeFileSync('data/called.json','true');return {status:0};};syncBuiltinESMExports();
    const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...a){super(...(a.length?a:['2026-10-29T16:40:00Z']));}static now(){return OriginalDate.parse('2026-10-29T16:40:00Z');}};
  `);
  const run=()=>spawnSync(process.execPath,['--import','./preload.mjs','cloud/run.mjs'],{cwd:dir,encoding:'utf8',env:{...process.env,GITHUB_RUN_ID:'overnight-test',AUTO_RESUME:'false',MAX_DETAILS:'0',PRIORITY_APP_IDS:''}});
  assert.equal(run().status,0);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'data/called.json'))),true);
  await fs.unlink(path.join(dir,'data/called.json'));
  await fs.writeFile(path.join(dir,'data/state.json'),JSON.stringify({reports:[{date:'2026-10-28'}],phase1:{lastRunAt:'2026-10-29T16:30:00Z'}}));
  assert.equal(run().status,0);
  await assert.rejects(fs.stat(path.join(dir,'data/called.json')),{code:'ENOENT'});
  const ledger=JSON.parse(await fs.readFile(path.join(dir,'data/operations.json')));
  assert.equal(ledger.runs[0].collection.attempted,false);assert.equal(ledger.runs[0].collection.reason,'cooldown');
});

test('partial metadata does not hide fatal source outages or all-failed batches',()=>{
  assert.equal(collectionHealth({state:'partial',processed:100,basicCompleted:80,failed:2,stopReason:'time-budget'}),'partial');
  assert.equal(collectionHealth({state:'partial',processed:3,failed:3,basicCompleted:0}),'error');
  assert.equal(collectionHealth({state:'partial',stopReason:'steam-limit'}),'error');
  assert.equal(collectionHealth({state:'partial',scanErrors:{games:'offline'}}),'error');
  assert.equal(collectionHealth({state:'error'}),'error');
});

test('recent games and demos alternate even when old refreshes dominate, across saved resumptions',async()=>{
  let state={reports:[]};const now='2026-10-29T04:00:00Z';initialize(state,now);
  for(let id=1;id<=100;id++)state.phase1.catalog[id]={item:{appid:id,releaseDate:'2026-10-28',sources:['games']},firstObservedAt:now};
  for(let id=1001;id<=1100;id++)state.phase1.catalog[id]={item:{appid:id,releaseDate:'2026-10-28',sources:['demo']},firstObservedAt:now};
  for(let id=2001;id<=3000;id++)state.phase1.catalog[id]={item:{appid:id,releaseDate:'2026-10-01',sources:['games']},snapshot:{id,metadataPending:[]},verifiedAt:'2026-10-01T00:00:00Z'};
  const seen=[];
  for(let run=0;run<16;run++){
    await runSweep(state,{now:new Date(Date.parse(now)+run*60000).toISOString(),latest:'2026-10-28',getPage:async()=>({items:[],total:0}),maxDetails:1,getDetail:async r=>{seen.push(r.item.appid);return {detail:{data:{type:r.item.sources[0]==='demo'?'demo':'game',name:'Game',is_free:true,release_date:{date:'28 Oct, 2026'}}},review:{query_summary:{total_reviews:0,total_positive:0}},html:'<html></html>'};}});
    state=JSON.parse(JSON.stringify(state));
  }
  const games=seen.filter(id=>id<=100).length,demos=seen.filter(id=>id>=1001&&id<=1100).length;
  assert.ok(games+demos>=12);assert.ok(Math.abs(games-demos)<=1);assert.ok(seen.some(id=>id>2000));
});

const report=(date='2026-10-29',ready=9)=>({date,collection:{scanComplete:true},sections:['release','demo'].map(key=>({key,games:Array.from({length:10},(_,id)=>({id,provisional:id>=ready}))}))});
const successfulRun=(at,event='schedule')=>({id:'123',event,collection:{attempted:true,health:'partial',finishedAt:at,processed:100},publication:{state:'success',at}});

test('release and demo readiness exclude discovery pages and deduplicate IDs',()=>{
  const r=report();r.sections.push({key:'new-page',games:Array.from({length:1000},(_,id)=>({id}))});r.sections[0].games.push({id:0});
  assert.deepEqual(sectionReadiness(r).release,{total:10,readable:9,pending:1,percent:90});
  assert.equal(sectionReadiness(null).demo.percent,null);
});

test('three day acceptance requires an automatic publication before deadline; late repairs cannot rewrite it',()=>{
  const ledger={acceptance:newAcceptance('2026-10-29')};
  const deadline=ledger.acceptance.days[0].deadline;
  recordAcceptance(ledger,successfulRun('2026-10-30T18:00:00Z'),[report()]);
  assert.equal(acceptanceView(ledger.acceptance,'2026-10-30T19:00:00Z').days[0].state,'observing');
  assert.equal(acceptanceView(ledger.acceptance,deadline).days[0].state,'passed');
  recordAcceptance(ledger,successfulRun('2026-10-31T00:00:00Z'),[report('2026-10-29',0)]);
  assert.equal(acceptanceView(ledger.acceptance,deadline).days[0].state,'passed');
  assert.equal(acceptanceView(ledger.acceptance,'2026-11-03T00:00:00Z').days[2].state,'no-evidence');
  const manual={acceptance:newAcceptance('2026-10-29')};
  recordAcceptance(manual,successfulRun('2026-10-30T18:00:00Z','workflow_dispatch'),[report()]);
  assert.equal(acceptanceView(manual.acceptance,deadline).days[0].state,'no-evidence');
  const failed={acceptance:newAcceptance('2026-10-29')};
  recordAcceptance(failed,{...successfulRun('2026-10-30T18:00:00Z'),publication:{state:'failed',at:'2026-10-30T18:00:00Z'}},[report()]);
  assert.equal(acceptanceView(failed.acceptance,deadline).days[0].state,'no-evidence');
});

test('zero Demo candidates or an incomplete search cannot be a passing observation',()=>{
  for(const kind of ['no-demo','incomplete','low']){
    const ledger={acceptance:newAcceptance('2026-10-29')},r=report();
    if(kind==='no-demo')r.sections[1].games=[];
    if(kind==='incomplete')r.collection.scanComplete=false;
    if(kind==='low')r.sections[1].games[0].provisional=true;
    recordAcceptance(ledger,successfulRun('2026-10-30T18:00:00Z'),[r]);
    assert.equal(acceptanceView(ledger.acceptance,'2026-11-01T00:00:00Z').days[0].state,'below-target');
  }
});

test('continuations are bounded: children, skipped collections, outages and publication failures cannot dispatch',()=>{
  const readiness=[{sections:{release:{pending:5},demo:{pending:0}}}];
  const run=successfulRun('2026-10-30T18:00:00Z');
  assert.equal(shouldContinue(run,readiness),true);
  for(const patch of [{event:'workflow_dispatch'},{collection:{attempted:false}},{collection:{attempted:true,health:'error',processed:2}},{publication:{state:'failed'}}])assert.equal(shouldContinue({...run,...patch},readiness),false);
  assert.equal(shouldContinue(run,[{sections:{release:{pending:0},demo:{pending:0}}}]),false);
});

test('a build shows the actual last publication outcome independently of healthy collection',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steam-health-build-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({reports:[report()],generatedAt:'2026-10-30T18:00:00Z'}));
  await fs.writeFile(path.join(dir,'status.json'),JSON.stringify({state:'success',reportDate:'2026-10-29'}));
  await fs.writeFile(path.join(dir,'operations.json'),JSON.stringify({runs:[{id:'123',publication:{state:'failed',at:'2026-10-30T18:00:00Z'}}]}));
  await buildSite(path.join(dir,'site'),dir);
  const status=JSON.parse(await fs.readFile(path.join(dir,'site/data/status.json')));
  assert.equal(status.health.collection,'complete');assert.equal(status.health.lastPublication.state,'failed');
  assert.equal(status.health.readiness[0].sections.release.percent,90);
});

test('cloud continuation sends one bounded dispatch and persists failed network attempts',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'steam-continuation-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'cloud'));await fs.mkdir(path.join(dir,'data'));
  for(const name of ['cloud/health.mjs','stability.mjs','history.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(dir,name));
  await fs.writeFile(path.join(dir,'preload.mjs'),`
    import fs from 'node:fs';globalThis.fetch=async (url,options)=>{
      if(process.env.FAIL_NETWORK==='true')throw new Error('network unavailable');
      fs.appendFileSync('data/requests.jsonl',JSON.stringify({url,body:JSON.parse(options.body)})+'\\n');return {ok:true,status:204};
    };
  `);
  const initial={...successfulRun('2026-10-30T18:00:00Z'),readiness:[{sections:{release:{pending:5},demo:{pending:1}}}]};
  const reset=()=>fs.writeFile(path.join(dir,'data/operations.json'),JSON.stringify({runs:[initial]}));
  const run=fail=>spawnSync(process.execPath,['--import','./preload.mjs','cloud/health.mjs','continue'],{cwd:dir,encoding:'utf8',env:{...process.env,GITHUB_RUN_ID:'123',GITHUB_EVENT_NAME:'schedule',GITHUB_REPOSITORY:'fixture/steam-daily',GH_TOKEN:'fixture-no-real-credential',FAIL_NETWORK:String(fail)}});
  await reset();assert.equal(run(false).status,0);assert.equal(run(false).status,0);
  const requests=(await fs.readFile(path.join(dir,'data/requests.jsonl'),'utf8')).trim().split('\n');assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(requests[0]).body,{ref:'main',inputs:{auto_resume:true}});
  await reset();assert.equal(run(true).status,1);
  const ledger=JSON.parse(await fs.readFile(path.join(dir,'data/operations.json')));assert.equal(ledger.runs[0].continuation.state,'failed');
  assert.ok(!JSON.stringify(ledger).includes('fixture-no-real-credential'));
});
