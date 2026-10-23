// All Steam requests share a queue, including review requests and backfills.
export function createSteamClient({ fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, interval = 1400, timeoutMs = 25000, maxAttempts = 3 } = {}) {
  let tail = Promise.resolve();
  let nextRequest = 0;
  let blockedUntil = 0;
  return function getJson(url, { format = 'json' } = {}) {
    const operation = tail.then(async () => {
      if (now() < blockedUntil) throw new Error('Steam 暂时限制请求，已暂停；下次任务将继续未完成项目');
      let lastError;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(Math.max(0, nextRequest - now()));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let retryDelay = 2000 * (attempt + 1);
        try {
          const response = await fetchImpl(url, { headers: { 'User-Agent': 'SteamDailyBrief/2.0' }, signal: controller.signal });
          if (response.status === 403 || response.status === 429) {
            blockedUntil = now() + 15 * 60 * 1000;
            throw new Error(`Steam 返回 ${response.status}，已暂停请求，避免继续触发限制`);
          }
          if (!response.ok) {
            const retryAfter = Number(response.headers?.get('retry-after'));
            if (retryAfter > 0) retryDelay = Math.min(60000, retryAfter * 1000);
            const error=new Error(`Steam 返回 HTTP ${response.status}`);error.permanent=response.status>=400&&response.status<500;throw error;
          }
          return await response[format === 'text' ? 'text' : 'json']();
        } catch (error) {
          lastError = error;
          if (blockedUntil > now() || error.permanent) throw error;
        } finally {
          clearTimeout(timeout);
          nextRequest = now() + interval;
        }
        if (attempt < maxAttempts-1) await sleep(retryDelay);
      }
      throw lastError;
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
