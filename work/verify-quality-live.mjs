import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),qa=path.join(root,'qa-phase1/quality');
function git(args){const r=spawnSync('D:/Git/cmd/git.exe',args,{cwd:root,encoding:'utf8',maxBuffer:120*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
git(['-c','http.proxy=http://127.0.0.1:7890','fetch','--depth=1','origin','refs/heads/daily-data']);
const state=JSON.parse(git(['show','FETCH_HEAD:data/state.json'])),status=JSON.parse(git(['show','FETCH_HEAD:data/status.json']));
const before=JSON.parse(await fs.readFile(path.join(qa,'before-state.json'),'utf8'));
assert.ok(status.startedAt>'2026-10-23T06:50:00Z');assert.ok(status.completedDetails>0);assert.ok(status.basicCompleted>0);assert.ok(status.reviewService?.successes>0);
const games=s=>s.reports.flatMap(r=>r.sections.flatMap(section=>section.games));
const index=new Map();for(const r of state.reports)for(const s of r.sections)for(const g of s.games)index.set(`${r.date}:${s.key}:${g.id}`,g);
let pricePreserved=0,reviewPreserved=0;
for(const r of before.reports)for(const s of r.sections)for(const g of s.games){
  if(g.provisional)continue;
  const current=index.get(`${r.date}:${s.key}:${g.id}`)||state.reports.flatMap(r=>r.sections.filter(section=>section.key===s.key).flatMap(s=>s.games)).find(candidate=>candidate.id===g.id);
  assert.ok(current,`missing history ${g.id}`);
  if(g.price&&!['待核实','未定价','国区暂无售价','尚未公布售价'].includes(g.price)){assert.equal(current.price,g.price);pricePreserved++;}
  if(!g.metadataPending?.includes('reviews')){assert.equal(current.rating,g.rating);assert.equal(current.reviews,g.reviews);reviewPreserved++;}
}
function reportStats(s,date){const r=s.reports.find(r=>r.date===date);const all=[...new Map((r?.sections||[]).flatMap(s=>s.games).map(g=>[g.id,g])).values()];return{total:all.length,readable:all.filter(g=>!g.provisional).length,complete:all.filter(g=>!g.provisional&&!g.metadataPending?.length).length,priceKnown:all.filter(g=>g.price&&!['待核实','未定价'].includes(g.price)).length};}
const comparison=['2026-10-23','2026-10-22','2026-10-21','2026-10-20'].map(date=>({date,before:reportStats(before,date),after:reportStats(state,date)}));
assert.ok(reportStats(state,'2026-10-22').readable>reportStats(before,'2026-10-22').readable);
let seed=20261023;const completed=Object.values(state.phase1.catalog).filter(r=>r.lastAttemptAt===status.startedAt&&!r.snapshot?.provisional&&r.snapshot);
for(let i=completed.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[completed[i],completed[j]]=[completed[j],completed[i]];}
const sample=completed.slice(0,6).map(r=>({id:r.item.appid,name:r.snapshot.name,date:r.snapshot.releaseDate,demo:r.snapshot.demo,price:r.snapshot.price,reviews:r.snapshot.reviews,rating:r.snapshot.rating,pending:r.snapshot.metadataPending}));
assert.equal(sample.length,6);const result={checkedAt:new Date().toISOString(),status,comparison,pricePreserved,reviewPreserved,sample,randomSeed:20261023,passed:true};
await fs.writeFile(path.join(qa,'live-verification.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(qa,'after-status.json'),JSON.stringify(status,null,2));
console.log(JSON.stringify(result,null,2));
if(process.argv.includes('--published')){
  function get(file){const r=spawnSync('curl.exe',['-sS','--fail','--max-time','45','--proxy','http://127.0.0.1:7890',`https://xbjy0713.github.io/steam-daily/${file}?quality=${Date.now()}`],{encoding:'utf8',maxBuffer:80*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
  const html=get(''),publicState=JSON.parse(get('data/state.json')),publicStatus=JSON.parse(get('data/status.json'));
  assert.equal(publicStatus.startedAt,status.startedAt);assert.ok(html.includes('id="historyDate"'));assert.ok(html.includes('id="collectionMetrics"'));
  const req=createRequire('C:/Users/xbjy2/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');const browser=await req('playwright').chromium.launch({headless:true,executablePath:'C:/Users/xbjy2/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='https://live-quality.test')return route.abort();return route.fulfill(u.pathname.endsWith('state.json')?{json:publicState}:u.pathname.endsWith('status.json')?{json:publicStatus}:{body:html,contentType:'text/html;charset=utf-8'});});
  try{
    await page.goto('https://live-quality.test/');await page.waitForFunction(()=>document.querySelectorAll('.game-card:where(:not(.nonexistent))').length>0);
    assert.match(await page.locator('.date-card.active').innerText(),/10月22日/);assert.ok(await page.locator('.game-card:visible').count()>0);assert.ok(await page.locator('.date-card').count()<=7);
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(qa,'production-desktop.png')});
    const target=publicState.reports.find(r=>r.date===status.reportDate).sections.find(s=>s.games.some(g=>!g.provisional));const game=target.games.find(g=>!g.provisional);
    await page.locator('#openGlobalSearch').click();await page.locator('#globalSearchInput').fill(String(game.id));await page.getByRole('button',{name:`${status.reportDate} · ${target.title}`,exact:true}).click();assert.equal(await page.locator('.search-target').getAttribute('data-game-id'),String(game.id));
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(qa,'production-mobile.png')});assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(qa,'production-verification.json'),JSON.stringify({passed:true,checkedAt:new Date().toISOString(),source:'Actual published HTML and JSON, external covers blocked for layout QA',status:publicStatus,defaultDate:status.reportDate,visibleCards:await page.locator('.game-card:visible').count(),testedGame:game.id,errors},null,2));
    console.log('Actual published report and search verification passed');
  }finally{await browser.close();}
}
