import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {buildSite} from '../cloud/build.mjs';
const root=path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1')));
const qa=path.join(root,'qa-phase1/progress');await fs.mkdir(qa,{recursive:true});
await buildSite(path.join(qa,'site'));
let html=await fs.readFile(path.join(qa,'site/index.html'),'utf8');
if(process.argv.includes('--published')){
  const r=spawnSync('curl.exe',['-sS','--fail','--proxy','http://127.0.0.1:7890',`https://xbjy0713.github.io/steam-daily/?progress-qa=${Date.now()}`],{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);html=r.stdout;
}
const game={id:1,name:'测试游戏',en:'Sample',tags:['动作'],status:[],reviews:'10',rating:90,price:'免费',priceValue:0,time:'待核实',cover:'https://image.test/x'};
let payload={reports:[{date:'2026-10-18',sections:[{key:'release',title:'当日发售',games:[game]}]}]};
let status={state:'partial',startedAt:'2026-10-19T04:00:00Z',finishedAt:'2026-10-19T04:30:00Z',processed:21,completedDetails:15,verified:4,missingDetails:100,initialVerification:200,refreshDue:3,waitingRetry:2,scansComplete:true,stopReason:'time-budget'};
let fail=false;
const req=createRequire('C:/Users/xbjy2/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const browser=await req('playwright').chromium.launch({headless:true,executablePath:'C:/Users/xbjy2/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.origin!=='https://progress.test')return route.abort();
  if(u.pathname.endsWith('.json'))return fail?route.fulfill({status:503,body:'unavailable'}):route.fulfill({json:u.pathname.endsWith('status.json')?status:payload});
  return route.fulfill({body:html,contentType:'text/html;charset=utf-8'});
});
async function refresh(){await page.locator('#refreshProgress').click();await page.waitForFunction(()=>!document.querySelector('#refreshProgress').disabled);}
try{
  await page.goto('https://progress.test/');await page.waitForFunction(()=>document.querySelector('#progressProcessed').textContent==='21');
  assert.match(await page.locator('#progressReason').innerText(),/30分钟.*已保存/);
  await page.locator('#searchInput').fill('测试');await page.locator('#sortSelect').selectOption('reviews');
  await page.locator('#openGlobalSearch').click();await page.locator('#globalSearchInput').fill('测试');
  payload.reports.unshift({date:'2026-10-19',sections:[]});
  // A refresh while the dialog is open must preserve its query and selected date.
  await page.evaluate(()=>loadLiveReports());
  assert.equal(await page.locator('#globalSearchInput').inputValue(),'测试');assert.equal(await page.locator('#globalSearchDialog').evaluate(e=>e.open),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#searchInput').inputValue(),'测试');assert.equal(await page.locator('#sortSelect').inputValue(),'reviews');
  assert.match(await page.locator('.date-card.active').innerText(),/10.18/);
  status={state:'partial',processed:237};await refresh();assert.equal(await page.locator('#progressCompleted').innerText(),'—');
  for(const [reason,text] of [['steam-limit','限制访问'],['interrupted','中断'],['batch-limit','设定条数']]){
    status={...status,stopReason:reason};await refresh();assert.match(await page.locator('#progressReason').innerText(),new RegExp(text));
  }
  status={state:'running',updatedAt:'2026-10-18T00:00:00Z'};await refresh();assert.match(await page.locator('#progressReason').innerText(),/不代表云端此刻仍在运行/);assert.match(await page.locator('#progressTime').innerText(),/超过3小时/);
  status={state:'success',processed:4,completedDetails:2,verified:2,missingDetails:0,initialVerification:0,refreshDue:0};await refresh();assert.match(await page.locator('#progressReason').innerText(),/本轮检查完成/);
  fail=true;await refresh();assert.match(await page.locator('#progressReason').innerText(),/保留页面已有日报/);assert.equal(await page.locator('#progressProcessed').innerText(),'4');assert.equal(await page.locator('.game-card').count(),1);
  fail=false;await refresh();await page.screenshot({path:path.join(qa,'desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(qa,'mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(qa,'ui-verification.json'),JSON.stringify({passed:true,published:process.argv.includes('--published'),checks:14,errors},null,2));console.log('14项进度面板与搜索兼容检查通过');
}finally{await browser.close();}
