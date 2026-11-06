// Dedicated data branch survives runner replacement and ordinary cache expiry.
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {restoreMissingReports} from '../archive.mjs';
import { fileURLToPath } from 'node:url';
import {DATA_FILES,encodeStorage,decodeStorage} from './storage.mjs';
import {retryGit,pushSafely} from './git-retry.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('此脚本仅供 GitHub Actions 保存云端状态');
const mode = process.argv[2];
if (!['load', 'save'].includes(mode)) throw new Error('mode must be load or save');
function git(args, input, raw=false) {
  const result = spawnSync('git', args, { cwd: root, input, timeout:120000, encoding: raw?undefined:'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return raw?result.stdout:result.stdout.trim();
}
const files = DATA_FILES;
const branch = 'daily-data';
const remoteHead=()=>retryGit(()=>git(['ls-remote','--heads','origin',`refs/heads/${branch}`]).split(/\s/)[0]||null);
const found = await remoteHead();
if (found) await retryGit(()=>git(['fetch', '--depth=1', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]));
const parent = found ? git(['rev-parse', `origin/${branch}`]) : null;
const baseFile=path.join(root,'data','.durable-base');
if (mode === 'load') {
  if (parent) {
    const tracked = new Set(git(['ls-tree', '-r', '--name-only', parent]).split('\n'));
    let documents;
    if(tracked.has('data/manifest.json')) {
      const names=[...tracked].filter(name=>/^data\/chunks\/[a-f0-9]{64}\.part$/.test(name));
      const packed=git(['cat-file','--batch'],names.map(name=>`${parent}:${name}`).join('\n')+'\n',true);
      const chunks=new Map();let at=0;
      for(const name of names) {
        const end=packed.indexOf(10,at),header=packed.subarray(at,end).toString('utf8');
        const match=header.match(/^[a-f0-9]{40,64} blob (\d+)$/);
        if(end<0||!match)throw new Error(`无法读取存档数据块：${name}`);
        const length=Number(match[1]);at=end+1;
        if(at+length>=packed.length||packed[at+length]!==10)throw new Error('存档数据块读取不完整');
        chunks.set(name.slice(5),packed.subarray(at,at+length));at+=length+1;
      }
      documents=await decodeStorage(git(['show',`${parent}:data/manifest.json`]),name=>{
        if(!chunks.has(name))throw new Error(`存档缺少数据块：${name}`);return chunks.get(name);
      });
    }
    else {
      // Read the previous format once. The next successful save migrates it.
      documents=new Map();
      for(const name of files)if(tracked.has(`data/${name}`))documents.set(name,JSON.parse(git(['show',`${parent}:data/${name}`])));
      if(!documents.has('state.json'))throw new Error('云端存档缺少 state.json，停止恢复');
    }
    // Validate every chunk before replacing any local collector file.
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    for(const [name,value] of documents)await fs.writeFile(path.join(root,'data',name),JSON.stringify(value));
    console.log('已恢复持久化日报和请求缓存');
  } else console.log('首次云端运行，使用项目自带的历史日报');
  try {
    const recovered=JSON.parse(await fs.readFile(path.join(root,'data/recovered-reports.json'),'utf8'));
    const state=JSON.parse(await fs.readFile(path.join(root,'data/state.json'),'utf8'));
    const added=restoreMissingReports(state,recovered);
    if(added)await fs.writeFile(path.join(root,'data/state.json'),JSON.stringify(state));
    console.log(`已恢复 ${added} 期缺失的历史日报，已有日期不覆盖`);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.mkdir(path.join(root,'data'),{recursive:true});
  await fs.writeFile(baseFile,JSON.stringify(parent));
} else {
  try {
    const loaded=JSON.parse(await fs.readFile(baseFile,'utf8'));
    if(loaded!==parent)throw new Error('云端数据已被另一轮更新，请重新载入后重试');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const documents = new Map();
  for (const name of files) {
    try {
      documents.set(name,JSON.parse(await fs.readFile(path.join(root, 'data', name), 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // A saved receipt is true only if the containing commit reaches GitHub.
  const ledger=documents.get('operations.json');
  const run=ledger?.runs?.find(r=>r.id===process.env.GITHUB_RUN_ID);
  if(process.argv.includes('--receipt')&&run)run.receipt={state:'saved',at:new Date().toISOString()};
  const blobs=encodeStorage(documents);
  // Hash all chunks in one Git invocation; hundreds of child processes are slow
  // on Windows and unnecessary on cloud runners too.
  const staging=await fs.mkdtemp(path.join(os.tmpdir(),'steam-durable-'));
  const hashes=new Map();
  try {
    const names=[...blobs.keys()],paths=names.map((name,i)=>path.join(staging,String(i)));
    for(let at=0;at<names.length;at+=16)await Promise.all(names.slice(at,at+16).map((name,i)=>fs.writeFile(paths[at+i],blobs.get(name))));
    const values=git(['hash-object','-w','--stdin-paths'],paths.map(p=>JSON.stringify(p.replaceAll('\\','/'))).join('\n')+'\n').split('\n');
    if(values.length!==names.length)throw new Error('Chunk hashing incomplete');
    names.forEach((name,i)=>hashes.set(name,values[i]));
  }finally{await fs.rm(staging,{recursive:true,force:true});}
  function makeTree(entries) {
    const rows=[],folders=new Map();
    for(const [name,content] of entries) {
      const slash=name.indexOf('/');
      if(slash<0)rows.push(`100644 blob ${content}\t${name}\n`);
      else {
        const folder=name.slice(0,slash);
        if(!folders.has(folder))folders.set(folder,[]);
        folders.get(folder).push([name.slice(slash+1),content]);
      }
    }
    for(const [name,children] of folders)rows.push(`040000 tree ${makeTree(children)}\t${name}\n`);
    return git(['mktree'],rows.join(''));
  }
  const dataTree = makeTree(hashes);
  const tree = git(['mktree'], `040000 tree ${dataTree}\tdata\n`);
  if (parent && tree === git(['rev-parse', `${parent}^{tree}`])) {
    console.log('状态未变，无需保存');
    await fs.writeFile(baseFile,JSON.stringify(parent));
  } else {
    const args = ['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit-tree', tree];
    if (parent) args.push('-p', parent);
    const commit = git(args, `Save Steam daily progress ${new Date().toISOString()}\n`);
    await pushSafely({push:()=>git(['push','origin',`${commit}:refs/heads/${branch}`]),remoteHead,parent,commit});
    await fs.writeFile(baseFile,JSON.stringify(commit));
    console.log(`日报与进度已分块保存到 daily-data 分支（${blobs.size} 个文件，最大 ${Math.max(...[...blobs.values()].map(b=>b.length))} 字节）`);
  }
}
