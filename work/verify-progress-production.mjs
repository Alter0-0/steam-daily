import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),qa=path.join(root,'qa-phase1/progress');
function get(file){const r=spawnSync('curl.exe',['-sS','--fail','--max-time','45','--proxy','http://127.0.0.1:7890',`https://xbjy0713.github.io/steam-daily/${file}?live-check=${Date.now()}`],{encoding:'utf8',maxBuffer:40*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
const html=get(''),state=JSON.parse(get('data/state.json')),status=JSON.parse(get('data/status.json'));
assert.equal(status.processed,21);assert.ok(status.completedDetails>0);assert.ok(!('phase1' in state));
const req=createRequire('C:/Users/xbjy2/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const browser=await req('playwright').chromium.launch({headless:true,executablePath:'C:/Users/xbjy2/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.origin!=='https://live-progress.test')return route.abort();
  if(u.pathname.endsWith('state.json'))return route.fulfill({json:state});if(u.pathname.endsWith('status.json'))return route.fulfill({json:status});
  return route.fulfill({body:html,contentType:'text/html;charset=utf-8'});
});
try{
  await page.goto('https://live-progress.test/');await page.waitForFunction(()=>document.querySelector('#progressProcessed').textContent==='21');
  assert.equal(await page.locator('#progressMissing').innerText(),status.missingDetails.toLocaleString('zh-CN'));
  await page.screenshot({path:path.join(qa,'production-desktop.png')});
  for(const [id,name] of [[3755350,'爱丽丝与彼岸'],[3318210,'破灭的御宅族']]){
    await page.locator('#openGlobalSearch').click();await page.locator('#globalSearchInput').fill(name);
    const result=page.locator('.global-search-result').filter({has:page.getByRole('heading',{name,exact:true})});await result.waitFor();
    const report=state.reports.find(r=>r.date==='2026-10-16'),title=report.sections.find(s=>s.key==='release').title;
    const hit=result.getByRole('button',{name:`2026-10-16 · ${title}`,exact:true});
    await hit.click();const card=page.locator(`.game-card[data-game-id="${id}"][data-section-key="release"]`);
    assert.match(await card.innerText(),new RegExp(name));assert.doesNotMatch(await card.innerText(),/详情待补充/);
  }
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(qa,'production-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  const result={checkedAt:new Date().toISOString(),source:'Actual published HTML, reports and status rendered with external images blocked',passed:true,reports:state.reports.length,status,verifiedGames:[3755350,3318210],errors};
  await fs.writeFile(path.join(qa,'production-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
