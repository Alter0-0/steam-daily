import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {backlog} from '../phase1.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const qa=path.join(root,'qa-phase1/progress');await fs.mkdir(qa,{recursive:true});
function git(args){const r=spawnSync('D:/Git/cmd/git.exe',args,{cwd:root,encoding:'utf8',maxBuffer:96*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
git(['-c','http.proxy=http://127.0.0.1:7890','fetch','--depth=1','origin','refs/heads/daily-data']);
const state=JSON.parse(git(['show','FETCH_HEAD:data/state.json']));
const status=JSON.parse(git(['show','FETCH_HEAD:data/status.json']));
const mode=process.argv[2]||'baseline';
if(mode==='baseline'){
  await fs.writeFile(path.join(qa,'before.json'),JSON.stringify(state));
  await fs.writeFile(path.join(qa,'before-status.json'),JSON.stringify(status));
  console.log(JSON.stringify({status,backlog:backlog(state,{latest:status.reportDate},new Date().toISOString())}));
}else{
  const before=JSON.parse(await fs.readFile(path.join(qa,'before.json'),'utf8'));
  assert.ok(status.completedDetails>0);assert.equal(status.processed,21);
  const priorities=[3755350,3318210].map(id=>{
    const r=state.phase1.catalog[id];assert.ok(!r.snapshot.provisional);assert.ok(!r.snapshot.metadataPending.length);assert.equal(r.snapshot.releaseDate,'2026-10-16');
    assert.match(r.snapshot.name,/[\u4e00-\u9fff]/);return{id,name:r.snapshot.name,releaseDate:r.snapshot.releaseDate,time:r.snapshot.time,reviews:r.snapshot.reviews};
  });
  const completed=Object.values(state.phase1.catalog).filter(r=>r.verifiedAt===status.startedAt&&!r.excluded&&!priorities.some(p=>p.id===r.item.appid));
  // Reproducible pseudo-random sample of actual completions, excluding reports.
  let seed=20261019;for(let i=completed.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[completed[i],completed[j]]=[completed[j],completed[i]];}
  const sample=completed.slice(0,5).map(r=>{
    assert.ok(!r.snapshot.provisional&&!r.snapshot.metadataPending.length);assert.ok(r.snapshot.name&&r.snapshot.price&&r.snapshot.time);
    assert.ok(state.reports.some(report=>report.sections.some(section=>section.games.some(g=>g.id===r.item.appid))));
    return{id:r.item.appid,name:r.snapshot.name,demo:r.snapshot.demo,releaseDate:r.snapshot.releaseDate,reviews:r.snapshot.reviews};
  });assert.equal(sample.length,5);
  let pricePreserved=0,reviewPreserved=0;
  for(const report of before.reports)for(const section of report.sections)for(const game of section.games){
    if(game.provisional)continue;
    const nowReport=state.reports.find(r=>r.date===report.date);
    const current=nowReport?.sections.find(s=>s.key===section.key)?.games.find(g=>g.id===game.id)
      ||state.reports.flatMap(r=>r.sections.filter(s=>s.key===section.key).flatMap(s=>s.games)).find(g=>g.id===game.id);
    assert.ok(current,`historical record missing ${game.id}`);
    if(game.price&&!['未定价','待核实'].includes(game.price)){assert.equal(current.price,game.price);pricePreserved++;}
    if(!game.metadataPending?.includes('reviews')){assert.equal(current.rating,game.rating);assert.equal(current.reviews,game.reviews);reviewPreserved++;}
  }
  const result={checkedAt:new Date().toISOString(),status,priorities,randomSeed:20261019,sample,pricePreserved,reviewPreserved};
  await fs.writeFile(path.join(qa,'live-verification.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(qa,'after-status.json'),JSON.stringify(status,null,2));console.log(JSON.stringify(result,null,2));
}
