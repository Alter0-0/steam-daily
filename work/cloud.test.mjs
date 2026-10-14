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
  const expected = {reports:[{date:'2026-10-13',sections:[]}],firstSeen:{1:'2026-10-13'}};
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
