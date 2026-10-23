import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publication,restoreMissingReports} from '../archive.mjs';
import {shiftDate} from '../history.mjs';
import {initialize,applyRecord,workQueue,sweepPlan,backlog,runSweep} from '../phase1.mjs';
import {buildSite} from '../cloud/build.mjs';

const now='2026-10-23T08:00:00Z',latest='2026-10-22';
const game=(id,date)=>({id,name:`历史游戏 ${id}`,en:`Game ${id}`,price:'¥20',priceValue:20,rating:80,reviews:'10',demo:false,tags:[],status:[],studio:'Studio',publisher:'Publisher',releaseDate:date,snapshotAt:'2026-09-01T00:00:00Z',metadataPending:[]});
const report=(date,id=1)=>({date,generatedAt:`${date}T12:00:00Z`,sections:[{key:'release',title:'当日发售',games:[game(id,date)]}]});

test('publication keeps storage intact and separates the recent calendar window from monthly archives',()=>{
  const reports=Array.from({length:65},(_,i)=>report(shiftDate('2027-01-03',-i),i+1));
  const before=JSON.stringify(reports),p=publication(reports,now);
  assert.equal(p.recent.length,30);assert.equal(p.history.dates.length,65);
  assert.equal(p.history.recentCutoff,'2026-12-05');assert.equal(p.history.retention,'permanent');
  assert.deepEqual([...p.months.keys()],['2026-12','2026-11','2026-10']);
  assert.equal(p.searchReports.length,35);assert.equal(JSON.stringify(reports),before);
  assert.equal(p.searchReports[0].sections[0].games[0].price,undefined);
  const gaps=publication([report('2026-10-22'),report('2026-09-01')]);assert.equal(gaps.recent.length,1);
  assert.equal(publication([]).history.dates.length,0);
});

test('rolling over and correcting old releases never drops older reports or their snapshots',async()=>{
  const state={reports:Array.from({length:45},(_,i)=>report(shiftDate(latest,-i),i+1))};initialize(state,now);
  const archivedBefore=structuredClone(state.reports.at(-1));
  const id=500,oldDate='2026-09-01',record={item:{appid:id,releaseDate:oldDate,sources:['games']},firstObservedAt:null,imported:true};
  state.phase1.catalog[id]=record;
  applyRecord(state,record,game(id,oldDate),now,latest);
  await runSweep(state,{now,latest:'2026-10-23',getPage:async()=>({items:[],total:0}),getDetail:async()=>{throw new Error('not used');},maxDetails:0});
  assert.deepEqual(state.reports.find(r=>r.date===archivedBefore.date),archivedBefore);
  assert.equal(state.reports.find(r=>r.date===oldDate).sections[0].games[0].price,'¥20');
  assert.ok(state.reports.some(r=>r.date==='2026-10-23'));assert.equal(state.reports.length,47);
});

test('complete archives stop routine rechecks while unfinished archives and explicit priorities remain eligible',()=>{
  const state={reports:[]};initialize(state,now);
  for(const id of [1,2,3,4])state.phase1.catalog[id]={item:{appid:id,releaseDate:id===4?latest:'2026-08-01'},snapshot:game(id,id===4?latest:'2026-08-01'),verifiedAt:'2026-08-02T00:00:00Z'};
  state.phase1.catalog[2].snapshot.metadataPending=['reviews'];
  state.phase1.catalog[3].priorityRequestedAt=now;
  const plan=sweepPlan(state,now,latest),ids=workQueue(state,plan,now).map(r=>r.item.appid);
  assert.ok(!ids.includes(1));assert.ok(ids.includes(2));assert.ok(ids.includes(3));assert.ok(ids.includes(4));
  assert.equal(backlog(state,plan,now).refreshDue,1);
});

test('historical restoration is idempotent and never replaces an existing date with an older version',()=>{
  const state={reports:[report(latest,1)]};
  const recovered={reports:[report(latest,999),report('2026-09-19',2)]};
  assert.equal(restoreMissingReports(state,recovered),1);assert.equal(restoreMissingReports(state,recovered),0);
  assert.equal(state.reports[0].sections[0].games[0].id,1);
  assert.equal(state.reports[1].sections[0].games[0].price,'¥20');
  state.reports[1].sections[0].games[0].price='¥10';assert.equal(recovered.reports[1].sections[0].games[0].price,'¥20');
});

test('cloud archive files preserve all historical cards, publish all names, and exclude operational state',async t=>{
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'steam-archive-'));t.after(()=>fs.rm(fixture,{recursive:true,force:true}));
  const data=path.join(fixture,'data'),site=path.join(fixture,'site');await fs.mkdir(data);
  const reports=Array.from({length:40},(_,i)=>report(shiftDate(latest,-i),i+1));
  await fs.writeFile(path.join(data,'state.json'),JSON.stringify({reports,generatedAt:now,firstSeen:{secret:true}}));
  await fs.writeFile(path.join(data,'recovered-reports.json'),JSON.stringify({reports:[report('2025-12-31',99)]}));
  await buildSite(site,data);
  const load=async name=>JSON.parse(await fs.readFile(path.join(site,'data',name),'utf8'));
  const home=await load('state.json'),manifest=await load('archive/index.json'),search=await load('archive/search.json');
  assert.equal(home.reports.length,30);assert.equal(home.history.dates.length,41);assert.deepEqual(home.history,manifest);assert.equal(search.reports.length,11);
  const archived=(await Promise.all(manifest.months.map(m=>load(`archive/${m.month}.json`)))).flatMap(p=>p.reports);
  assert.equal(archived.length,11);assert.equal(archived.find(r=>r.date==='2025-12-31').sections[0].games[0].reviews,'10');
  assert.deepEqual(archived.find(r=>r.date===reports[35].date),reports[35]);
  assert.equal(search.reports.find(r=>r.date===reports[35].date).sections[0].games[0].en,'Game 36');
  assert.equal(home.firstSeen,undefined);assert.equal(manifest.firstSeen,undefined);
});
