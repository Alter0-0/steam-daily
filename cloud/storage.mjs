// Local collector files stay unchanged. Only the durable Git representation is split.
import {createHash} from 'node:crypto';
export const DATA_FILES=['state.json','status.json','detail-cache.json','operations.json'];
export const CHUNK_BYTES=1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function encodeStorage(documents,{maxBytes=CHUNK_BYTES}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<256)throw new Error('Invalid chunk size');
  const blobs=new Map();
  function blob(bytes) {
    const sha256=digest(bytes),path=`chunks/${sha256}.part`;
    blobs.set(path,bytes);return {kind:'blob',path,bytes:bytes.length,sha256};
  }
  function pack(value,depth=0) {
    const bytes=Buffer.from(JSON.stringify(value));
    if(bytes.length<=maxBytes)return blob(bytes);
    if(Array.isArray(value)) {
      if(value.length<=64)return {kind:'array',parts:value.map(v=>pack(v))};
      const parts=[];
      for(let at=0;at<value.length;at+=64)parts.push(pack(value.slice(at,at+64)));
      return {kind:'array-parts',parts};
    }
    if(plain(value)) {
      const entries=Object.entries(value);
      // Hash buckets keep existing catalog/cache chunks stable when AppIDs are added.
      if(entries.length>16&&depth<64) {
        const groups=new Map();
        for(const entry of entries) {
          const bucket=digest(entry[0])[depth];
          if(!groups.has(bucket))groups.set(bucket,[]);
          groups.get(bucket).push(entry);
        }
        return {kind:'object-parts',parts:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([,rows])=>pack(Object.fromEntries(rows),depth+1))};
      }
      return {kind:'object',entries:entries.map(([key,v])=>[key,pack(v)])};
    }
    // Even one unusually large cached string cannot create a giant Git blob.
    const parts=[];
    for(let at=0;at<bytes.length;at+=maxBytes)parts.push(blob(bytes.subarray(at,at+maxBytes)));
    return {kind:'json-parts',parts};
  }
  const files={};
  for(const [name,value] of documents) {
    if(!DATA_FILES.includes(name))throw new Error('Unknown durable file');
    files[name]=pack(value);
  }
  if(!files['state.json'])throw new Error('Missing state.json');
  blobs.set('manifest.json',Buffer.from(JSON.stringify({version:2,files})));
  return blobs;
}

export async function decodeStorage(manifestText,readBlob) {
  const manifest=JSON.parse(manifestText);
  if(manifest.version!==2||!plain(manifest.files)||!manifest.files['state.json'])throw new Error('Invalid durable manifest');
  const loaded=new Map();
  async function bytes(node) {
    if(!/^chunks\/[a-f0-9]{64}\.part$/.test(node.path)||node.path!==`chunks/${node.sha256}.part`||!Number.isSafeInteger(node.bytes)||node.bytes<0)throw new Error('Invalid chunk reference');
    if(!loaded.has(node.path))loaded.set(node.path,Promise.resolve().then(()=>readBlob(node.path)).then(value=>{
      const content=Buffer.from(value);
      if(content.length!==node.bytes||digest(content)!==node.sha256)throw new Error(`Durable chunk integrity failed: ${node.path}`);
      return content;
    }));
    return loaded.get(node.path);
  }
  async function unpack(node) {
    if(node?.kind==='blob')return JSON.parse((await bytes(node)).toString('utf8'));
    if(node?.kind==='json-parts')return JSON.parse(Buffer.concat(await Promise.all(node.parts.map(bytes))).toString('utf8'));
    if(node?.kind==='array')return Promise.all(node.parts.map(unpack));
    if(node?.kind==='array-parts') {
      const parts=await Promise.all(node.parts.map(unpack));
      if(parts.some(part=>!Array.isArray(part)))throw new Error('Invalid durable array part');
      return parts.flat();
    }
    if(node?.kind==='object') {
      const entries=[];const keys=new Set();
      for(const [key,child] of node.entries) {
        if(typeof key!=='string'||keys.has(key))throw new Error('Duplicate durable key');
        keys.add(key);entries.push([key,await unpack(child)]);
      }
      return Object.fromEntries(entries);
    }
    if(node?.kind==='object-parts') {
      const entries=[],keys=new Set();
      for(const child of node.parts) {
        const part=await unpack(child);
        if(!plain(part))throw new Error('Invalid durable object part');
        for(const entry of Object.entries(part)) {
          if(keys.has(entry[0]))throw new Error('Duplicate durable key');
          keys.add(entry[0]);entries.push(entry);
        }
      }
      return Object.fromEntries(entries);
    }
    throw new Error('Unknown durable chunk type');
  }
  const documents=new Map();
  for(const [name,node] of Object.entries(manifest.files)) {
    if(!DATA_FILES.includes(name))throw new Error('Unknown durable file');
    documents.set(name,await unpack(node));
  }
  return documents;
}
