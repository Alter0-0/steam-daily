import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { resolveReleaseTime, parseReleaseDate } from '../release-time.mjs';
import { initialize, sweepPlan, runSweep, scanWindow, parseSearchPage, normalizeRecord, applyRecord, ingest } from '../phase1.mjs';

const latest='2026-10-18', now='2026-10-19T02:00:00.000Z';
const row=(id,date='2026-10-15')=>({appid:id,searchName:`Game ${id}`,releaseDate:date,releasedText:`${Number(date.slice(8))} Oct, 2026`});
const html=timestamp=>`<div data-props="{&quot;app_release_date&quot;:&quot;${timestamp}&quot;}"></div>`;
const detail=(id,extra={})=>({success:true,data:{name:`Game ${id}`,type:'game',is_free:false,price_overview:{final_formatted:'¥30',final:3000},genres:[{id:'23',description:'独立'}],release_date:{coming_soon:false,date:'2026 年 10 月 15 日'},...extra}});
const response=(id,timestamp=1792115973)=>({detail:detail(id),review:{query_summary:{total_reviews:10,total_positive:8}},html:html(timestamp)});
const emptyPage=async()=>({items:[],total:0});
const allGames=state=>state.reports.flatMap(r=>r.sections.flatMap(s=>s.games));

test('China dates use timestamps, retain raw Steam dates, and never blindly add a day',()=>{
  const alice=resolveReleaseTime({storeText:'2026 年 10 月 15 日',html:html(1792115973),now});
  assert.equal(alice.releaseDate,'2026-10-16');assert.equal(alice.releaseAt,'2026-10-16T01:59:33.000Z');assert.equal(alice.storeReleaseDate,'2026-10-15');
  const missing=resolveReleaseTime({storeText:'2026 年 10 月 15 日',now});
  assert.equal(missing.releaseDate,'2026-10-15');assert.equal(missing.timePrecision,'date-only');assert.match(missing.time,/未核实/);
  assert.equal(parseReleaseDate('32 Oct, 2026'),null);
  assert.equal(parseReleaseDate('2026年2月30日'),null);
});

test('full release cannot reuse old Early Access timestamp; announcement is explicitly labeled',()=>{
  const page=html(1763976609)+'<b>抢先体验发行日期:</b> 2025 年 11 月 24 日<br>'+String.raw`{"event_name":"[10.14] Nientum - Op.ZERO 正式版发布更新公告","rtime32_start_time":1791939600}`;
  const r=resolveReleaseTime({storeText:'2026 年 10 月 13 日',html:page,now});
  assert.equal(r.releaseDate,'2026-10-14');assert.equal(r.eventKind,'full-release');assert.equal(r.timePrecision,'announcement');assert.match(r.time,/公告/);
  const unknown=resolveReleaseTime({storeText:'2026 年 10 月 13 日',html:html(1763976609)+'<b>抢先体验发行日期:</b> 2025 年 11 月 24 日<br>',now});
  assert.equal(unknown.releaseDate,'2026-10-13');assert.equal(unknown.timePrecision,'date-only');
  assert.equal(resolveReleaseTime({storeText:'2026 年 10 月 13 日',html:html(1763976609),earlyAccess:true,now}).eventKind,'early-access');
  const closeEA=resolveReleaseTime({storeText:'2026 年 10 月 16 日',html:html(1792115973)+'<b>抢先体验发行日期:</b> 2026 年 10 月 15 日<br>',now});
  assert.equal(closeEA.timePrecision,'date-only');
});

test('weekly sweep starts at migration, then recent seven days keep being checked',()=>{
  const state={reports:[]};initialize(state,now);
  assert.equal(sweepPlan(state,now,latest).scanDays,30);
  state.phase1.lastWeeklyAt=now;
  const plan=sweepPlan(state,'2026-10-20T02:00:00Z','2026-10-19');
  assert.equal(plan.scanDays,7);assert.equal(plan.oldest,'2026-10-13');assert.equal(plan.searchCutoff,'2026-10-12');
  assert.equal(sweepPlan(state,'2026-10-27T02:00:00Z','2026-10-26').scanDays,30);
  assert.equal(sweepPlan(state,now,latest,true).scanDays,30);
});

test('upgrade retains old pending app identities that were never rendered',()=>{
  const state={reports:[{date:'2026-10-17',sections:[],collection:{pendingItems:[row(9,'2026-10-17')]}}]};
  initialize(state,now);assert.equal(state.phase1.catalog[9].item.appid,9);assert.equal(state.phase1.catalog[9].imported,true);
  const copy=structuredClone(state);initialize(state,'2026-10-20T02:00:00Z');assert.deepEqual(state,copy);
});

test('late release is added to an already complete old report with original snapshots intact',async()=>{
  const original={id:1,name:'Old',releaseDate:'2026-10-16',price:'¥12',priceValue:12,rating:60,reviews:'5',demo:false,snapshotAt:'2026-10-16T00:00:00Z'};
  const state={reports:[{date:'2026-10-16',generatedAt:'2026-10-16T22:00:00Z',collection:{state:'complete'},sections:[{key:'release',games:[original]}]}]};
  const summary=await runSweep(state,{now,latest,getPage:async filter=>({items:filter==='games'?[row(3755350),row(1,'2026-10-16')]:[],total:filter==='games'?2:0}),getDetail:async r=>response(r.item.appid)});
  const report=state.reports.find(r=>r.date==='2026-10-16');
  assert.deepEqual(report.sections.find(s=>s.key==='release').games.map(g=>g.id).sort((a,b)=>a-b),[1,3755350]);
  const saved=report.sections[0].games.find(g=>g.id===1);
  assert.equal(saved.price,'¥12');assert.equal(saved.rating,60);assert.equal(saved.reviews,'5');assert.equal(saved.snapshotAt,original.snapshotAt);
  assert.equal(report.sections[0].games.find(g=>g.id===3755350).recoveredAt,now);
  assert.equal(report.collection.state,'checked');assert.equal(summary.state,'success');
});

test('corrected dates move only release entries; discovery history and price snapshots survive',()=>{
  const game={id:1,name:'Penguin',releaseDate:'2026-10-16',price:'¥20',rating:80,reviews:'10',demo:false,isNew:true};
  const state={reports:[{date:'2026-10-16',generatedAt:'2026-10-17T00:00:00Z',sections:[{key:'release',games:[game]},{key:'new-page',games:[game]}]}]};
  initialize(state,now);const record=state.phase1.catalog[1];
  const fresh=normalizeRecord(record,detail(1,{release_date:{date:'2026 年 10 月 16 日'}}),response(1).review,html(1792169465),now);
  applyRecord(state,record,fresh,now,latest);
  assert.equal(state.reports.find(r=>r.date==='2026-10-17').sections[0].games[0].id,1);
  assert.equal(state.reports.find(r=>r.date==='2026-10-16').sections[0].games.length,0);
  assert.equal(state.reports.find(r=>r.date==='2026-10-16').sections[1].games[0].price,'¥20');
  applyRecord(state,record,fresh,now,latest);
  assert.equal(state.reports.find(r=>r.date==='2026-10-17').sections[0].games.length,1);
});

test('release snapshot retains its own price when an earlier discovery had another price',()=>{
  const discovery={id:1,name:'Game',releaseDate:'2026-10-16',price:'¥28.80',rating:60,reviews:'5',demo:false,snapshotAt:'2026-10-14T00:00:00Z'};
  const release={...discovery,price:'¥36.00',rating:80,reviews:'10',snapshotAt:'2026-10-16T00:00:00Z'};
  const state={reports:[{date:'2026-10-14',generatedAt:'2026-10-14T00:00:00Z',sections:[{key:'new-page',games:[discovery]}]},{date:'2026-10-16',generatedAt:'2026-10-16T00:00:00Z',sections:[{key:'release',games:[release]}]}]};
  initialize(state,now);const record=state.phase1.catalog[1];
  const fresh=normalizeRecord(record,detail(1),response(1).review,html(1792115973),now);
  applyRecord(state,record,fresh,now,latest);
  let saved=state.reports.find(r=>r.date==='2026-10-16').sections[0].games[0];
  assert.equal(saved.price,'¥36.00');assert.equal(saved.rating,80);assert.equal(saved.reviews,'10');assert.equal(saved.snapshotAt,release.snapshotAt);
  applyRecord(state,record,{...fresh,releaseDate:'2026-10-17'},now,latest);
  saved=state.reports.find(r=>r.date==='2026-10-17').sections[0].games[0];
  assert.equal(saved.price,'¥36.00');assert.equal(saved.rating,80);assert.equal(saved.reviews,'10');assert.equal(saved.snapshotAt,release.snapshotAt);
  assert.equal(state.reports.find(r=>r.date==='2026-10-14').sections[0].games[0].price,'¥28.80');
});

test('details failure still publishes discovered identity; later retry fills it without a false zero review',async()=>{
  const state={reports:[]};
  await runSweep(state,{now,latest,getPage:async filter=>({items:filter==='games'?[row(2)]:[],total:filter==='games'?1:0}),getDetail:async()=>{throw new Error('timeout');}});
  const provisional=allGames(state).find(g=>g.id===2);
  assert.equal(provisional.provisional,true);assert.equal(provisional.price,'待核实');assert.equal(provisional.rating,null);assert.ok(provisional.metadataPending.includes('reviews'));
  assert.equal(state.phase1.catalog[2].lastError,'timeout');
  await runSweep(state,{now:'2026-10-19T04:00:00.000Z',latest,getPage:emptyPage,getDetail:async()=>response(2)});
  const ready=state.reports.find(r=>r.date==='2026-10-16').sections[0].games.find(g=>g.id===2);
  assert.equal(ready.provisional,undefined);assert.equal(ready.price,'¥30');assert.equal(ready.rating,80);
  assert.equal(allGames(state).some(g=>g.id===2&&g.provisional),false);
});

test('missing reviews are later filled without changing the previously known price',async()=>{
  const state={reports:[]};
  await runSweep(state,{now,latest,getPage:async filter=>({items:filter==='games'?[row(3)]:[],total:filter==='games'?1:0}),getDetail:async()=>({...response(3),review:null})});
  await runSweep(state,{now:'2026-10-19T04:00:00.000Z',latest,getPage:emptyPage,getDetail:async()=>({...response(3),detail:detail(3,{price_overview:{final:9900,final_formatted:'¥99'}})})});
  const game=state.reports.find(r=>r.date==='2026-10-16').sections[0].games.find(g=>g.id===3);
  assert.equal(game.price,'¥30');assert.equal(game.rating,80);assert.equal(game.snapshotAt,now);assert.equal(game.metadataUpdatedAt,'2026-10-19T04:00:00.000Z');
});

test('saved pagination resumes after interruption; premature empty page is not complete',async()=>{
  const state={reports:[]};initialize(state,now);const plan=sweepPlan(state,now,latest);
  let saves=0;const starts=[];
  const getPage=async(filter,start)=>{starts.push(start);return start===0?{items:[row(1)],total:2}:{items:[row(2)],total:2};};
  assert.equal(await scanWindow(state,plan,'games',{getPage,now,save:async()=>{saves++;},deadline:()=>saves>=1}),false);
  assert.equal(state.phase1.catalog[1].item.appid,1);
  const restored=JSON.parse(JSON.stringify(state));
  assert.equal(await scanWindow(restored,plan,'games',{getPage,now,save:async()=>{}}),true);
  assert.deepEqual(starts,[0,1]);assert.equal(Object.keys(restored.phase1.catalog).length,2);
  const bad={reports:[]};initialize(bad,now);
  assert.equal(await scanWindow(bad,sweepPlan(bad,now,latest),'games',{getPage:async()=>({items:[],total:100}),now,save:async()=>{}}),false);
  assert.match(Object.values(bad.phase1.scans)[0].error,/空页/);
});

test('duplicate app IDs do not reduce the raw Steam pagination offset',async()=>{
  const raw=id=>`<a class="search_result_row" data-ds-appid="${id}"><span class="title">Game ${id}</span><div class="search_released">15 Oct, 2026</div></a>`;
  const page=parseSearchPage({start:1000,total_count:1101,results_html:raw(1)+raw(1)},1000);
  assert.equal(page.items.length,1);assert.equal(page.nextStart,1002);
  const state={reports:[]};initialize(state,now);const plan=sweepPlan(state,now,latest);
  state.phase1.scans[`${plan.oldest}:games`]={start:1000,pages:10,olderPages:0,signatures:[]};
  const starts=[];
  assert.equal(await scanWindow(state,plan,'games',{getPage:async(filter,start)=>{
    starts.push(start);return start===1000?page:{items:[row(2)],total:1003,nextStart:1003};
  },now,save:async()=>{}}),true);
  assert.deepEqual(starts,[1000,1002]);
  assert.equal(Object.keys(state.phase1.catalog).length,2);
});

test('repeated pages and deadline leave a resumable partial state',async()=>{
  const state={reports:[]};initialize(state,now);
  assert.equal(await scanWindow(state,sweepPlan(state,now,latest),'games',{getPage:async()=>({items:[row(1)],total:100}),now,save:async()=>{}}),false);
  assert.equal(Object.values(state.phase1.scans)[0].start,1);assert.ok(state.phase1.catalog[1]);
  const restored=JSON.parse(JSON.stringify(state));const starts=[];
  assert.equal(await scanWindow(restored,sweepPlan(restored,now,latest),'games',{getPage:async(filter,start)=>{starts.push(start);return {items:[row(2)],total:2};},now,save:async()=>{}}),true);
  assert.deepEqual(starts,[1]);assert.ok(restored.phase1.catalog[1]);assert.ok(restored.phase1.catalog[2]);
  const summary=await runSweep(state,{now,latest,getPage:emptyPage,getDetail:async()=>response(1),deadline:()=>true});
  assert.equal(summary.state,'partial');assert.equal(summary.scansComplete,false);
});

test('page budget continues beyond 80 pages in a later run and retries old detail failures after weekly scan',async()=>{
  const state={reports:[]};initialize(state,now);const plan=sweepPlan(state,now,latest);
  const starts=[];const getPage=async(filter,start)=>{starts.push(start);return {items:[row(start+1000)],total:81};};
  assert.equal(await scanWindow(state,plan,'games',{getPage,now,save:async()=>{}}),false);
  assert.equal(Object.values(state.phase1.scans)[0].start,80);
  assert.equal(await scanWindow(state,plan,'games',{getPage,now,save:async()=>{}}),true);
  assert.equal(starts.at(-1),80);
  const older={reports:[]};
  await runSweep(older,{now,latest,getPage:async filter=>({items:filter==='games'?[row(9,'2026-10-01')]:[],total:filter==='games'?1:0}),getDetail:async()=>{throw new Error('timeout');}});
  assert.equal(older.phase1.lastWeeklyAt,now);
  const summary=await runSweep(older,{now:'2026-10-19T04:00:00.000Z',latest,getPage:emptyPage,getDetail:async()=>({...response(9),detail:detail(9,{release_date:{date:'1 Oct, 2026'}}),html:'<html></html>'})});
  assert.equal(summary.scanDays,7);assert.ok(older.phase1.catalog[9].verifiedAt);assert.equal(summary.pending,0);
});

test('product type filtering does not discard genuine games with soundtrack-like names',()=>{
  const record={item:row(4),firstObservedAt:now};
  assert.equal(normalizeRecord(record,detail(4,{name:'The Artbook Mystery'}),response(4).review,html(1792115973),now).id,4);
  assert.equal(normalizeRecord(record,detail(4,{type:'dlc'}),null,'',now),null);
});

test('web page labels unverified dates, partial metadata and preserved snapshot times',async()=>{
  const source=await fs.readFile(new URL('../outputs/steam-daily.html',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('    function gameCard('),source.indexOf('    function renderRail('));
  const game={id:1,name:'Example',en:'Example',rating:null,reviews:'0',tags:[],status:[],price:'待核实',time:'2026-10-15（Steam 标注，具体时刻未核实）',storeReleaseText:'2026 年 10 月 15 日',provisional:true,metadataPending:['reviews']};
  const output=vm.runInNewContext(fn+';gameCard(game)',{game});
  assert.match(output,/测评暂未取得/);assert.match(output,/具体时刻未核实/);assert.match(output,/商店原文/);assert.match(output,/详情待补充/);assert.doesNotMatch(output,/0 条测评/);
});

test('new cloud collector persists a raw candidate before a real child-process interruption',async t=>{
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'steam-phase1-process-'));
  t.after(()=>fs.rm(fixture,{recursive:true,force:true}));
  for(const name of ['phase1-collector.mjs','phase1.mjs','release-time.mjs','history.mjs','steam-network.mjs','review-service.mjs','stability.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(fixture,name));
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const target=new Date(date+'T12:00:00Z');target.setUTCDate(target.getUTCDate()-(hour<4?2:1));
  const releasedText=`${target.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][target.getUTCMonth()]}, ${target.getUTCFullYear()}`;
  const preload=`
    const timer=setTimeout;globalThis.setTimeout=(fn,ms,...a)=>timer(fn,Math.min(ms,1),...a);
    globalThis.fetch=async value=>{
      const u=new URL(value);let p;
      if(u.pathname==='/search/results/')p={success:1,total_count:u.searchParams.get('category1')==='10'?0:1,results_html:u.searchParams.get('category1')==='10'?'':'<a data-ds-appid="3755350"><span class="title">Alice Nation</span><div class="search_released">${releasedText}</div></a>'};
      else if(u.pathname==='/api/appdetails'){if(process.env.INTERRUPT==='true')process.exit(42);p={'3755350':${JSON.stringify(detail(3755350,{release_date:{date:releasedText}}))}};}
      else if(u.pathname.startsWith('/IUserReviewsService/'))p={response:{query_summary:{total_reviews:10,total_positive:8}}};
      else return {ok:true,text:async()=>'<html></html>'};
      return {ok:true,json:async()=>p};
    };
  `;
  await fs.writeFile(path.join(fixture,'preload.mjs'),preload);
  const run=interrupt=>spawnSync(process.execPath,['--import','./preload.mjs','phase1-collector.mjs'],{cwd:fixture,encoding:'utf8',timeout:15000,env:{...process.env,INTERRUPT:String(interrupt)}});
  assert.equal(run(true).status,42);
  const saved=JSON.parse(await fs.readFile(path.join(fixture,'data/state.json'),'utf8'));
  assert.ok(saved.phase1.catalog[3755350]);assert.ok(allGames(saved).find(g=>g.id===3755350)?.provisional);
  const resumed=run(false);assert.equal(resumed.status,0,resumed.stderr);
  const result=JSON.parse(await fs.readFile(path.join(fixture,'data/state.json'),'utf8'));
  assert.equal(result.phase1.catalog[3755350].snapshot.provisional,undefined);
  assert.equal(Object.keys(result.phase1.catalog).length,1);assert.ok(date);
});
