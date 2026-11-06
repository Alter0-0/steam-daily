import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {encodeStorage,decodeStorage} from '../cloud/storage.mjs';
import {retryGit,pushSafely} from '../cloud/git-retry.mjs';

test('bounded chunks roundtrip catalog, archives, caches, Unicode, and source order without data loss',async()=>{
  const state={reports:Array.from({length:40},(_,i)=>({date:`2026-09-${i}`,sections:[{games:[{id:i,price:'¥20',rating:80}]}]})),phase1:{catalog:Object.fromEntries(Array.from({length:400},(_,i)=>[i,{name:'游戏😀'.repeat(30),sources:['featured-coming-soon','games'],firstObservedAt:'2026-11-01T17:00:00Z'}]))}};
  const docs=new Map([['state.json',state],['detail-cache.json',{huge:'汉😀'.repeat(1000)}],['operations.json',{runs:[{id:'1',publication:{state:'success'}}]}]]);
  const blobs=encodeStorage(docs,{maxBytes:1024});
  for(const [name,content]of blobs)if(name!=='manifest.json')assert.ok(content.length<=1024);
  assert.deepEqual(await decodeStorage(blobs.get('manifest.json'),name=>blobs.get(name)),docs);
  assert.deepEqual([...encodeStorage(docs,{maxBytes:1024}).keys()],[...blobs.keys()]);
  const changed=structuredClone(docs);changed.get('state.json').phase1.catalog[1].name='Updated';
  const after=encodeStorage(changed,{maxBytes:1024});
  assert.ok([...blobs.keys()].filter(k=>after.has(k)).length>blobs.size*.9,'one changed game must retain most stored chunks');
});

test('missing or tampered chunks and unknown formats cannot silently reset cloud history',async()=>{
  const blobs=encodeStorage(new Map([['state.json',{reports:[{date:'2026-09-01'}]}]]));
  await assert.rejects(decodeStorage(blobs.get('manifest.json'),()=>Buffer.from('{}')),/integrity/);
  await assert.rejects(decodeStorage(blobs.get('manifest.json'),()=>{throw new Error('missing chunk');}),/missing chunk/);
  await assert.rejects(decodeStorage('{"version":3,"files":{}}',()=>''),/manifest/);
});

const fast={sleep:async()=>{},log:()=>{}};
test('transient GitHub failures retry three times, auth failures stop immediately',async()=>{
  let calls=0;
  assert.equal(await retryGit(()=>{if(++calls<3)throw new Error('Internal Server Error');return 'saved';},fast),'saved');assert.equal(calls,3);
  calls=0;await assert.rejects(retryGit(()=>{calls++;throw new Error('503 unavailable');},fast));assert.equal(calls,3);
  calls=0;await assert.rejects(retryGit(()=>{calls++;throw new Error('unable to access: 403 permission denied');},fast));assert.equal(calls,1);
});

test('lost push acknowledgement is recognized; a concurrent update is never overwritten',async()=>{
  let calls=0;
  await pushSafely({parent:'old',commit:'new',push:()=>{calls++;throw new Error('connection reset');},remoteHead:async()=>'new',...fast});assert.equal(calls,1);
  calls=0;await assert.rejects(pushSafely({parent:'old',commit:'new',push:()=>{calls++;throw new Error('Internal Server Error');},remoteHead:async()=>'other',...fast}),/另一轮/);assert.equal(calls,1);
  calls=0;await pushSafely({parent:'old',commit:'new',push:()=>{if(++calls<3)throw new Error('Internal Server Error');},remoteHead:async()=>'old',...fast});assert.equal(calls,3);
});

test('legacy branch migrates losslessly; saved receipt, fresh restore, corruption and concurrent saves are checked',async t=>{
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'steam-storage-migration-'));t.after(()=>fs.rm(fixture,{recursive:true,force:true}));
  const checkout=path.join(fixture,'checkout'),remote=path.join(fixture,'remote');
  await fs.mkdir(path.join(checkout,'cloud'),{recursive:true});await fs.mkdir(path.join(checkout,'data'));
  function git(args,input) {
    const result=spawnSync('git',args,{cwd:checkout,input,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  }
  git(['init','--bare',remote]);git(['init']);git(['remote','add','origin',remote]);
  for(const name of ['state-branch.mjs','storage.mjs','git-retry.mjs'])await fs.copyFile(new URL('../cloud/'+name,import.meta.url),path.join(checkout,'cloud',name));
  for(const name of ['archive.mjs','history.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(checkout,name));
  const state={reports:[{date:'2026-09-01',sections:[{key:'release',games:[{id:1,price:'¥20',reviews:'5'}]}]}],phase1:{catalog:{1:{snapshot:{name:'游戏😀'},item:{sources:['featured-new-releases','games']}}}}};
  const operations={runs:[{id:'receipt-test',publication:{state:'success'}}]};
  const blob=git(['hash-object','-w','--stdin'],JSON.stringify(state)),ops=git(['hash-object','-w','--stdin'],JSON.stringify(operations));
  const data=git(['mktree'],`100644 blob ${blob}\tstate.json\n100644 blob ${ops}\toperations.json\n`),tree=git(['mktree'],`040000 tree ${data}\tdata\n`);
  const commit=git(['-c','user.name=Test','-c','user.email=test@example.com','commit-tree',tree],'legacy');git(['push','origin',`${commit}:refs/heads/daily-data`]);
  function run(mode,...args) {
    return spawnSync(process.execPath,['cloud/state-branch.mjs',mode,...args],{cwd:checkout,encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'receipt-test'}});
  }
  assert.equal(run('load').status,0);assert.deepEqual(JSON.parse(await fs.readFile(path.join(checkout,'data/state.json'))),state);
  const save=run('save','--receipt');assert.equal(save.status,0,save.stderr);
  const migrated=git(['ls-remote','origin','refs/heads/daily-data']).split(/\s/)[0];
  assert.equal(git(['rev-parse',`${migrated}^`]),commit,'legacy history remains recoverable');
  assert.match(git(['ls-tree','-r','--name-only',migrated]),/data\/manifest.json/);
  assert.doesNotMatch(git(['ls-tree','-r','--name-only',migrated]),/data\/state.json/);
  await fs.writeFile(path.join(checkout,'data/state.json'),'{}');assert.equal(run('load').status,0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(checkout,'data/state.json'))),state);
  assert.equal(JSON.parse(await fs.readFile(path.join(checkout,'data/operations.json'))).runs[0].receipt.state,'saved');
  assert.match(run('save').stdout,/无需保存/);
  // A new remote commit after load must not accept local stale state as its child.
  const other=git(['-c','user.name=Test','-c','user.email=test@example.com','commit-tree',tree,'-p',migrated],'concurrent');git(['push','origin',`${other}:refs/heads/daily-data`]);
  const stale=run('save');assert.notEqual(stale.status,0);assert.match(stale.stderr,/另一轮/);
  // A manifest referencing absent objects must not replace even the first local file.
  const manifest=encodeStorage(new Map([['state.json',state]])).get('manifest.json');
  const badBlob=git(['hash-object','-w','--stdin'],manifest),badData=git(['mktree'],`100644 blob ${badBlob}\tmanifest.json\n`),badTree=git(['mktree'],`040000 tree ${badData}\tdata\n`);
  const badCommit=git(['-c','user.name=Test','-c','user.email=test@example.com','commit-tree',badTree,'-p',other],'corrupt');git(['push','origin',`${badCommit}:refs/heads/daily-data`]);
  await fs.writeFile(path.join(checkout,'data/state.json'),'{"local":"keep"}');assert.notEqual(run('load').status,0);
  assert.equal(await fs.readFile(path.join(checkout,'data/state.json'),'utf8'),'{"local":"keep"}');
});
