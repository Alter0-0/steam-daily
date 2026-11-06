import {setTimeout as delay} from 'node:timers/promises';
export const transientGitError=error=>/Internal Server Error|\b50[0234]\b|timed? out|timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET|could not resolve|connection (?:reset|closed|refused)|remote end hung up|unexpected disconnect|RPC failed|TLS|SSL|unable to access|empty reply|failed to connect/i.test(error.message)&&!/authentication failed|permission denied|not authorized|\b40[13]\b|repository not found/i.test(error.message);
export async function retryGit(action,{attempts=3,sleep=delay,log=console.warn}={}) {
  for(let attempt=1;;attempt++) {
    try{return await action();}catch(error){
      if(attempt>=attempts||!transientGitError(error))throw error;
      log(`GitHub 临时连接失败，准备第 ${attempt+1}/${attempts} 次尝试`);
      await sleep(1500*attempt*attempt);
    }
  }
}
export async function pushSafely({push,remoteHead,parent,commit,...options}) {
  return retryGit(async()=>{
    try{await push();}catch(error){
      if(!transientGitError(error))throw error;
      // A lost response may follow a successful push. Never force-push stale data.
      const head=await remoteHead();
      if(head===commit)return;
      if(head!==parent)throw new Error('云端数据已被另一轮更新，请重新载入后重试');
      throw error;
    }
  },options);
}
