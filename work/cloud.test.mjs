import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { scanByDate, mergeDailyReport } from '../scan.mjs';
import { createSteamClient } from '../steam-network.mjs';
import { buildSite } from '../cloud/build.mjs';

test('pagination uses actual row count, continues past a short page and deduplicates', async () => {
  const starts = [];
  const result = await scanByDate(async start => {
    starts.push(start);
    return start === 0 ? { items: [{appid:1,releaseDate:'2026-10-13'},{appid:2,releaseDate:'2026-10-13'}],total:10 }
      : start === 2 ? { items: [{appid:2,releaseDate:'2026-10-13'},{appid:3,releaseDate:'2026-10-13'}],total:10 }
      : { items: [{appid:4,releaseDate:'2026-10-12'}],total:10 };
  }, '2026-10-13');
  assert.deepEqual(starts, [0,2,4]);
  assert.deepEqual(result.map(item => item.appid), [1,2,3]);
});
test('a repeated page and the protection limit cannot claim completion', async () => {
  await assert.rejects(scanByDate(async () => ({items:[{appid:1,releaseDate:'2026-10-13'}],total:10}), '2026-10-13'), /重复/);
  await assert.rejects(scanByDate(async start => ({items:[{appid:start+1,releaseDate:'2026-10-13'}],total:10}), '2026-10-13', {maxPages:2}), /上限/);
});
test('retry retains saved discoveries and resolves partial reports without duplicates', () => {
  const game = {id:1,name:'Game',releaseDate:'2026-10-13',isNew:true,demo:false};
  const first = mergeDailyReport(null, '2026-10-13', [game], {scanComplete:true,pendingIds:[2]});
  assert.equal(first.collection.state, 'partial');
  const second = mergeDailyReport(first, '2026-10-13', [{...game,isNew:true},{...game,id:2,isNew:false}], {scanComplete:true});
  assert.equal(second.collection.state, 'complete');
  assert.equal(second.sections[0].games.length, 2);
  assert.equal(second.sections[1].games.length, 1);
});
test('Steam requests are globally paced and rate limits stop further traffic', async () => {
  let instant = 0; const calls = [];
  const client = createSteamClient({ now:() => instant, sleep:async ms => {instant += ms;}, interval:1400, fetchImpl:async url => {
    calls.push({url,time:instant});
    return {ok:true,json:async () => ({ok:true})};
  }});
  await Promise.all([client('a'),client('b'),client('c')]);
  assert.deepEqual(calls.map(call => call.time), [0,1400,2800]);
  let requests = 0;
  const limited = createSteamClient({ now:() => instant, sleep:async ms => {instant += ms;}, fetchImpl:async () => {requests++; return {status:429};} });
  await assert.rejects(limited('a'), /429/);
  await assert.rejects(limited('b'), /限制/);
  assert.equal(requests, 1);
});
test('cloud build has no demo records or private operational cache', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-cloud-build-'));
  t.after(() => fs.rm(fixture, {recursive:true,force:true}));
  const input = path.join(fixture,'input');
  await fs.mkdir(input);
  await fs.writeFile(path.join(input,'state.json'), JSON.stringify({reports:[{date:'2026-10-13',sections:[]}],firstSeen:{secret:1},generatedAt:'test'}));
  await buildSite(path.join(fixture,'site'),input);
  const html = await fs.readFile(path.join(fixture,'site/index.html'),'utf8');
  assert.ok(html.includes('let reports = [];'));
  assert.ok(html.includes('window.STEAM_DAILY_STATIC = true'));
  assert.ok(html.includes("'./data/state.json'"));
  const saved = JSON.parse(await fs.readFile(path.join(fixture,'site/data/state.json'),'utf8'));
  assert.equal(saved.firstSeen, undefined);
  assert.equal(saved.reports[0].date, '2026-10-13');
});
test('durable data branch saves and restores state in a fresh checkout', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-cloud-git-'));
  t.after(() => fs.rm(fixture, {recursive:true,force:true}));
  const bare = path.join(fixture,'remote'); const checkout = path.join(fixture,'checkout');
  await fs.mkdir(checkout);
  function git(args) {
    const r=spawnSync('git',args,{cwd:checkout,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); return r.stdout;
  }
  git(['init','--bare',bare]); git(['init']); git(['remote','add','origin',bare]);
  await fs.mkdir(path.join(checkout,'cloud')); await fs.mkdir(path.join(checkout,'data'));
  await fs.copyFile(new URL('../cloud/state-branch.mjs',import.meta.url),path.join(checkout,'cloud/state-branch.mjs'));
  const expected = {reports:[{date:'2026-10-13',sections:[{key:'release',games:Array.from({length:600},(_,index)=>({id:index,name:`Game ${index}`,tags:['x'.repeat(2000)]}))}]}],firstSeen:{1:'2026-10-13'}};
  await fs.writeFile(path.join(checkout,'data/state.json'),JSON.stringify(expected));
  function run(mode) {
    const r=spawnSync(process.execPath,['cloud/state-branch.mjs',mode],{cwd:checkout,encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true'}});
    assert.equal(r.status,0,r.stderr); return r.stdout;
  }
  run('save');
  await fs.writeFile(path.join(checkout,'data/state.json'),'{}');
  run('load');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(checkout,'data/state.json'),'utf8')),expected);
  assert.match(run('save'), /无需保存/);
});

test('an interrupted collector saves a partial report and resumes without false discoveries', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-checkpoint-'));
  t.after(() => fs.rm(fixture, {recursive:true,force:true}));
  for (const name of ['collector.mjs','history.mjs','scan.mjs','steam-network.mjs']) {
    await fs.copyFile(new URL(`../${name}`,import.meta.url),path.join(fixture,name));
  }
  const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const hour = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const target = new Date(`${date}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() - (hour < 4 ? 2 : 1));
  const reportDate = target.toISOString().slice(0,10);
  const releasedText = `${target.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][target.getUTCMonth()]}, ${target.getUTCFullYear()}`;
  const preload = `
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, Math.min(ms, 1), ...args);
    globalThis.fetch = async value => {
      const url = new URL(value);
      let payload;
      if (url.pathname === '/search/results/') {
        const demo = url.searchParams.get('category1') === '10';
        const rows = Array.from({length:51}, (_, i) => '<a data-ds-appid="'+(i+1)+'"><span class="title">Game '+(i+1)+'</span><div class="search_released">${releasedText}</div></a>').join('');
        payload = {success:1,total_count:demo?0:51,results_html:demo?'':rows};
      } else if (url.pathname === '/api/appdetails') {
        const id = url.searchParams.get('appids');
        if (id === '26' && process.env.INTERRUPT_FIXTURE === 'true') process.exit(42);
        payload = {[id]:{success:true,data:{type:'game',name:'Game '+id,is_free:true,genres:[{description:'独立'}],release_date:{date:'${releasedText}'}}}};
      } else if (url.pathname.startsWith('/appreviews/')) {
        payload = {query_summary:{total_reviews:10,total_positive:8}};
      } else throw new Error('Unexpected fixture URL: '+value);
      return {ok:true,json:async()=>payload};
    };
  `;
  await fs.writeFile(path.join(fixture,'preload.mjs'),preload);
  function collect(interrupt) {
    return spawnSync(process.execPath,['--import','./preload.mjs','collector.mjs','--latest-only'],{
      cwd:fixture,encoding:'utf8',timeout:10000,env:{...process.env,INTERRUPT_FIXTURE:String(interrupt)}
    });
  }
  assert.equal(collect(true).status,42);
  const partial = JSON.parse(await fs.readFile(path.join(fixture,'data/state.json'),'utf8'));
  assert.equal(partial.reports[0].date,reportDate);
  assert.equal(partial.reports[0].collection.state,'partial');
  assert.equal(partial.reports[0].sections[0].games.length,25);
  assert.equal(partial.reports[0].collection.pendingIds.length,26);
  const resumed = collect(false);
  assert.equal(resumed.status,0,resumed.stderr);
  const complete = JSON.parse(await fs.readFile(path.join(fixture,'data/state.json'),'utf8'));
  assert.equal(complete.reports[0].collection.state,'complete');
  assert.equal(complete.reports[0].sections[0].games.length,51);
  assert.equal(complete.reports[0].sections[1].games.length,0);
});
