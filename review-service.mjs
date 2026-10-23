// Steam's replacement for the deprecated store /appreviews endpoint.
export function reviewUrl(appid) {
  const input={appid:Number(appid),languages:['all'],purchase_type:0,review_type:0,filter:1,cursor:'*',num_per_page:1,filter_offtopic_activity:true};
  return 'https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?'+new URLSearchParams({input_json:JSON.stringify(input)});
}
export function normalizeReviews(payload) {
  const summary=(payload?.response||payload)?.query_summary;
  if(!summary || summary.total_reviews==null || summary.total_positive==null)return null;
  const total=Number(summary.total_reviews),positive=Number(summary.total_positive),negative=summary.total_negative==null?total-positive:Number(summary.total_negative);
  if(![total,positive,negative].every(n=>Number.isSafeInteger(n)&&n>=0)||positive+negative!==total)return null;
  return {query_summary:{...summary,total_reviews:total,total_positive:positive,total_negative:negative}};
}
export function createReviewService({request,now=Date.now}) {
  let failures=0,pausedUntil=0,lastError=null,successes=0;
  const stats=()=>({state:now()<pausedUntil?'paused':failures?'degraded':'healthy',failures,successes,lastError,pausedUntil:pausedUntil?new Date(pausedUntil).toISOString():null});
  const get=async appid=>{
    if(now()<pausedUntil)return {review:null,error:lastError||'测评服务暂停重试'};
    try{
      const raw=await request(reviewUrl(appid));const review=normalizeReviews(raw);
      if(!review)throw new Error('测评接口缺少有效汇总字段');
      failures=0;lastError=null;successes++;return {review,error:null};
    }catch(e){
      failures++;lastError=e.message;
      // Protect useful detail work when this independent API is unavailable.
      if(/403|429|限制|暂停/.test(e.message)||failures>=3)pausedUntil=now()+15*60*1000;
      return {review:null,error:lastError};
    }
  };
  return {get,stats};
}
