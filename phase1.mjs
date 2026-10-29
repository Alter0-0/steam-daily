import { shiftDate } from './history.mjs';
import { cnDate, parseReleaseDate, resolveReleaseTime } from './release-time.mjs';

export const PHASE_VERSION = 1;
const DAY = 86400000;
const emptySections = () => [
  { key:'release',title:'当日发售',tone:'orange',games:[] },
  { key:'new-page',title:'新发现商品页',tone:'blue',games:[] },
  { key:'demo',title:'新出现 Demo',tone:'mint',games:[] }
];
export function initialize(state, now) {
  state.reports ||= []; state.firstSeen ||= {};
  if (state.phase1?.version === PHASE_VERSION) return;
  const catalog = {};
  for (const report of state.reports) for (const section of report.sections || []) for (const game of section.games || []) {
    const key = String(game.id);
    const saved = catalog[key];
    if (!saved || (report.generatedAt || '') < (saved.snapshotAt || '')) catalog[key] = {
      item:{ appid:game.id,searchName:game.name,releasedText:game.time,releaseDate:game.releaseDate || report.date,sources:[game.demo?'demo':'games'] },
      snapshot:{...game,snapshotAt:game.snapshotAt || game.recoveredAt || report.generatedAt || null},snapshotAt:game.snapshotAt || game.recoveredAt || report.generatedAt || null,
      firstObservedAt:game.firstObservedAt || null, imported:true, attempts:0
    };
  }
  // Pending candidates from the old collector may have no rendered game yet.
  for(const report of state.reports)for(const item of report.collection?.pendingItems||[])if(!catalog[item.appid]) {
    catalog[item.appid]={item,firstObservedAt:null,imported:true,attempts:0};
  }
  state.phase1 = { version:PHASE_VERSION, initializedAt:now, catalog, scans:{}, lastWeeklyAt:null };
}
export function sweepPlan(state, now, latest, force30 = false) {
  const p = state.phase1;
  const weekly = force30 || !p.lastWeeklyAt || +new Date(now)-Date.parse(p.lastWeeklyAt) >= 7*DAY;
  const scanDays = weekly ? 30 : 7;
  return { latest, weekly, scanDays, oldest:shiftDate(latest, -(scanDays-1)),
    // One extra day on either side accommodates Steam's date-only offset.
    searchCutoff:shiftDate(latest, -scanDays), retentionOldest:shiftDate(latest,-29) };
}
export function parseSearchRows(html) {
  const items=[];const ids=new Set();
  const matches=[...html.matchAll(/data-ds-appid="(\d+)"[\s\S]*?<span class="title">([\s\S]*?)<\/span>[\s\S]*?<div class="search_released[^\"]*">([\s\S]*?)<\/div>/g)];
  for (const [index,m] of matches.entries()) {
    const appid=Number(m[1]);if(ids.has(appid))continue;ids.add(appid);
    const clean = t => t.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
    const body=html.slice(m.index,matches[index+1]?.index??html.length);
    const priceText=body.match(/class="discount_final_price"[^>]*>([^<]+)/)?.[1];
    const cents=body.match(/data-price-final="(\d+)"/)?.[1];
    const cover=body.match(/<img\b[^>]*src="([^"]+)"/)?.[1];
    const tooltip=body.match(/data-tooltip-html="([^"]+)"/)?.[1];
    const cnReview=tooltip?.match(/([\d,，]+)\s*篇用户评测中有\s*(\d+)%/);
    const enReview=tooltip?.match(/(\d+)%[^\d]+([\d,]+)\s+user reviews/i);
    const listingReview=cnReview?{total:Number(cnReview[1].replace(/[,，]/g,'')),rating:Number(cnReview[2])}:enReview?{total:Number(enReview[2].replace(/,/g,'')),rating:Number(enReview[1])}:null;
    items.push({appid,searchName:clean(m[2]),releasedText:clean(m[3]),releaseDate:parseReleaseDate(clean(m[3])),
      ...(cents!=null&&priceText?{searchPrice:clean(priceText),searchPriceValue:Number(cents)/100}:{}),
      ...(cover&&/^https:\/\/(shared\.[\w.]*steamstatic\.com|cdn\.[\w.]*steamstatic\.com)\//.test(cover)?{searchCover:cover}:{}),
      ...(listingReview&&listingReview.rating<=100&&listingReview.total>0?{listingReview}:{})});
  }
  return items;
}
export function parseSearchPage(payload, requestedStart) {
  const items=parseSearchRows(payload.results_html);
  // Pagination counts raw result rows, including repeated IDs discarded above.
  // Using unique app IDs as the offset can land inside the same Steam page.
  const rawRows=[...payload.results_html.matchAll(/<a\b[^>]*\bclass=["'][^"']*\bsearch_result_row\b[^"']*["']/g)].length;
  const rowCount=rawRows||[...payload.results_html.matchAll(/data-ds-appid=/g)].length;
  const responseStart=Number(payload.start);
  const start=Number.isInteger(responseStart)&&responseStart>=0?responseStart:requestedStart;
  return {items,total:Number(payload.total_count),nextStart:start+(rowCount||items.length)};
}
export function ingest(state, items, source, now) {
  const catalog=state.phase1.catalog;
  const updatedCards=new Map();
  for (const item of items) {
    const old=catalog[item.appid];
    catalog[item.appid]={...old,item:{...old?.item,...item,sources:[...new Set([...(old?.item.sources||[]),source])]},firstObservedAt:old?.firstObservedAt||now,lastSeenAt:now,attempts:old?.attempts||0};
    // Refresh search-only cards with real names/prices/covers, while retaining
    // prior names for global search and leaving known historical snapshots alone.
    if(old?.snapshot?.provisional){
      const updated=placeholder(catalog[item.appid],now);
      updatedCards.set(item.appid,updated);
      catalog[item.appid].snapshot={...old.snapshot,...updated,en:old.snapshot.en||old.snapshot.name};
    }
  }
  if(updatedCards.size)for(const report of state.reports)for(const section of report.sections||[])section.games=section.games.map(g=>g.provisional&&updatedCards.has(g.id)?{...g,...updatedCards.get(g.id),en:g.en||g.name}:g);
}
export function placeholder(record, now) {
  const item=record.item; const demo=item.sources?.includes('demo') && !item.sources?.includes('games');
  return { id:item.appid,name:item.searchName||`Steam 应用 ${item.appid}`,en:item.searchName||'',cover:item.searchCover||`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`,
    price:demo?'Demo 试玩':item.searchPrice||'待核实',priceValue:demo?0:item.searchPriceValue??999999,rating:item.listingReview?.rating??null,reviews:item.listingReview?item.listingReview.total.toLocaleString('en-US'):'0',tags:[],status:[demo?'Demo':'信息待补充'],studio:'待核实',publisher:'待核实',demo,
    ...resolveReleaseTime({searchText:item.releasedText,demo,now}),firstObservedAt:record.firstObservedAt,snapshotAt:now,priceSnapshotAt:item.searchPrice?now:null,reviewSnapshotAt:item.listingReview?now:null,reviewSource:item.listingReview?'store-search':null,metadataPending:['detail',...(!item.listingReview?['reviews']:[]),'time'],provisional:true,source:'release-search',storeUrl:`https://store.steampowered.com/app/${item.appid}/` };
}
export function normalizeRecord(record, detail, review, html, now, evidence) {
  const d=detail.data;
  if(!['game','demo'].includes(d.type))return null;
  const summary=review?.query_summary;
  const listingReview=!summary?record.item.listingReview:null;
  const total=summary?.total_reviews??listingReview?.total; const positive=summary?.total_positive;
  const tags=(d.genres||[]).map(g=>g.description).filter(Boolean).slice(0,8);
  const demo=d.type==='demo'; const earlyAccess=(d.genres||[]).some(g=>String(g.id)==='70'||/抢先体验|Early Access/i.test(g.description));
  const timing=resolveReleaseTime({storeText:d.release_date?.date,searchText:record.item.releasedText,html,evidence,demo,earlyAccess,comingSoon:!!d.release_date?.coming_soon,now});
  const stage=demo?'Demo':earlyAccess?'抢先体验':timing.eventKind==='full-release'?'正式版上线':'游戏发售';
  const pending=[];if(!summary&&!listingReview)pending.push('reviews');if(!html&&!evidence)pending.push('time');
  return { id:record.item.appid,name:d.name||record.item.searchName,en:record.snapshot?.en||record.item.searchName||d.name,cover:d.header_image||`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${record.item.appid}/header.jpg`,
    price:demo?'Demo 试玩':d.is_free?'免费':d.price_overview?.final_formatted||(d.release_date?.coming_soon?'尚未公布售价':'国区暂无售价'),priceValue:demo||d.is_free?0:(d.price_overview?.final??99999900)/100,
    rating:listingReview?listingReview.rating:total>0?Math.round(positive/total*100):null,reviews:(total||0).toLocaleString('en-US'),tags,status:[stage],studio:(d.developers||[]).join(', ')||'未知',publisher:(d.publishers||[]).join(', ')||'未知',demo,
    ...timing,firstObservedAt:record.firstObservedAt,snapshotAt:now,priceSnapshotAt:now,reviewSnapshotAt:summary?now:listingReview?record.lastSeenAt||now:null,reviewSource:listingReview?'store-search':summary?'reviews-api':null,metadataPending:pending,source:'release-search+appdetails+store-page',storeUrl:`https://store.steampowered.com/app/${record.item.appid}/` };
}
export function preserveSnapshot(old, fresh) {
  if(!old || old.provisional)return {...fresh,snapshotAt:old?.snapshotAt||fresh.snapshotAt};
  // Preserve every previously known price/review. Only fill fields that failed then.
  const pending=old.metadataPending||[];
  const missingPrice=old.price==null||['待核实','未定价','国区暂无售价','尚未公布售价'].includes(old.price);
  const freshPending=[...new Set(fresh.metadataPending||[])].filter(key=>key!=='reviews'||pending.includes('reviews'));
  const sameStoreDate=old.storeReleaseDate&&old.storeReleaseDate===fresh.storeReleaseDate;
  const keepTime=old.releaseAt&&!fresh.releaseAt&&sameStoreDate&&!pending.includes('time')&&
    (old.eventKind===fresh.eventKind||freshPending.includes('time')&&fresh.eventKind==='release');
  const timing=keepTime?Object.fromEntries(['releaseDate','releaseAt','time','timePrecision','eventKind','earlyAccessDate','timeEvidence','status'].map(key=>[key,old[key]])):{};
  return {...old,...fresh,price:missingPrice?fresh.price:old.price,priceValue:missingPrice?fresh.priceValue:old.priceValue,rating:pending.includes('reviews')?fresh.rating:old.rating,reviews:pending.includes('reviews')?fresh.reviews:old.reviews,
    snapshotAt:old.snapshotAt??null,firstObservedAt:old.firstObservedAt||fresh.firstObservedAt,
    priceSnapshotAt:missingPrice?fresh.priceSnapshotAt:old.priceSnapshotAt||old.snapshotAt||null,reviewSnapshotAt:pending.includes('reviews')?fresh.reviewSnapshotAt:old.reviewSnapshotAt||old.snapshotAt||null,
    reviewSource:pending.includes('reviews')?fresh.reviewSource:old.reviewSource||null,
    ...timing,metadataUpdatedAt:fresh.metadataUpdatedAt||fresh.snapshotAt,metadataPending:keepTime?freshPending.filter(key=>key!=='time'):freshPending,provisional:false};
}
function ensureReport(state,date,now) {
  let report=state.reports.find(r=>r.date===date);
  if(!report){report={date,label:'初版日报',generatedAt:now,sections:emptySections()};state.reports.push(report);}
  for(const template of emptySections())if(!report.sections.some(s=>s.key===template.key))report.sections.push(template);
  return report;
}
export function applyRecord(state, record, fresh, now, latest) {
  if(fresh===null) {
    record.excluded=true;
    for(const report of state.reports)for(const section of report.sections||[])section.games=section.games.filter(g=>g.id!==record.item.appid||!g.provisional);
    return;
  }
  const old=record.snapshot;
  const merged=preserveSnapshot(old,fresh);
  record.snapshot=merged;
  const date=merged.releaseDate;
  // A correction can move the release section, while historical discoveries stay.
  if(!merged.comingSoon && date && date<=latest) {
    const priorRelease=state.reports.flatMap(r=>(r.sections||[]).filter(s=>s.key==='release'||s.key==='demo').flatMap(s=>s.games)).find(g=>g.id===merged.id);
    for(const report of state.reports)for(const section of report.sections||[]) {
      if(section.key==='release'||section.key==='demo')section.games=section.games.filter(g=>g.id!==merged.id||report.date===date);
    }
    const report=ensureReport(state,date,now);
    const section=report.sections.find(s=>s.key===(merged.demo?'demo':'release'));
    const previous=section.games.find(g=>g.id===merged.id);
    const correction=old?.releaseDate&&old.releaseDate!==date?{previousReleaseDate:old.releaseDate,dateCorrectedAt:now}:{};
    const late=!previous && report.generatedAt && report.generatedAt!==now ? {recoveredAt:now} : {};
    const entry={...preserveSnapshot(previous||priorRelease,merged),...correction,...late};
    section.games=[...section.games.filter(g=>g.id!==merged.id),entry];
    record.snapshot=entry;
  }
  // Keep old discovery snapshots and update only timing/identity, never their price/review.
  for(const report of state.reports) for(const section of report.sections||[])if(section.key==='new-page') {
    section.games=section.games.map(g=>g.id===merged.id?{...preserveSnapshot(g,merged),isNew:g.isNew,firstSeen:g.firstSeen}:g);
  }
  // A historical backfill must not invent a page creation/first-discovery date.
  if(!record.imported && !record.newPageAdded && !merged.demo && cnDate(record.firstObservedAt)===shiftDate(latest,1) && (!merged.provisional || !date || date>latest)) {
    const report=ensureReport(state,cnDate(record.firstObservedAt),now);
    report.label='今日发现（持续收集）';
    const section=report.sections.find(s=>s.key==='new-page');
    if(!section.games.some(g=>g.id===merged.id))section.games.push({...merged,isNew:true,firstSeen:cnDate(record.firstObservedAt),discoveryNote:'采集器首次发现，不代表页面创建时间'});
    record.newPageAdded=true;
  }
  // Published reports never expire. The 30-day window controls work, not storage.
  state.reports.sort((a,b)=>b.date.localeCompare(a.date));
}
export function needsDetails(record) {
  return !record.snapshot || !!record.snapshot.provisional || !!record.snapshot.metadataPending?.length;
}
export function needsBasics(record){return !record.snapshot||!!record.snapshot.provisional||record.snapshot.metadataPending?.includes('detail');}
export function reconcileReports(state,now,latest) {
  const catalog=state.phase1?.catalog;
  if(!catalog)return {apps:0,removedPlaceholders:0};
  const releases=new Map(),updates=new Set();let removedPlaceholders=0;
  for(const report of state.reports)for(const section of report.sections||[]) {
    if(section.key==='release'||section.key==='demo') {
      section.games=section.games.filter(game=>{
        const record=catalog[game.id];
        // A timestamp correction may point into the next, not-yet-open issue.
        // Keep the verified snapshot in the catalog, but remove the stale dated
        // placeholder now instead of leaving it to a later network refresh.
        const remove=game.provisional&&record&&(record.excluded||!needsBasics(record)&&(record.snapshot.comingSoon||record.snapshot.releaseDate>latest));
        if(remove){removedPlaceholders++;return false;}
        if(!releases.has(game.id))releases.set(game.id,[]);
        releases.get(game.id).push({date:report.date,key:section.key,game});return true;
      });
    }else if(section.key==='new-page') {
      for(const game of section.games)if(game.provisional&&catalog[game.id]&&!catalog[game.id].excluded&&!needsBasics(catalog[game.id]))updates.add(game.id);
    }
  }
  for(const record of Object.values(catalog)) {
    if(record.excluded||needsBasics(record))continue;
    const game=record.snapshot,date=game.releaseDate,key=game.demo?'demo':'release';
    if(!date||date>latest||game.comingSoon)continue;
    const existing=releases.get(game.id)||[];
    if(!existing.some(entry=>entry.date===date&&entry.key===key)||existing.some(entry=>entry.date!==date||entry.key!==key||entry.game.provisional))updates.add(game.id);
  }
  for(const id of updates){const record=catalog[id];applyRecord(state,record,{...record.snapshot},now,latest);}
  const result={apps:updates.size,removedPlaceholders};
  if(updates.size||removedPlaceholders)state.phase1.lastReconciliation={...result,at:now};
  return result;
}
function routineEligible(record,plan){
  const date=record.snapshot?.releaseDate||record.item.releaseDate;
  return !date || date>=shiftDate(plan.latest,-29) || record.snapshot?.comingSoon;
}
export function backlog(state,plan,now) {
  const active=Object.values(state.phase1.catalog).filter(r=>!r.excluded);
  const due=r=>!r.retryAfter || r.retryAfter<=now;
  const refresh=r=>r.verifiedAt && +new Date(now)-Date.parse(r.verifiedAt)>=(r.item.releaseDate>=shiftDate(plan.latest,-6)?DAY:7*DAY);
  return {missingDetails:active.filter(needsDetails).length,
    initialVerification:active.filter(r=>routineEligible(r,plan)&&!needsDetails(r)&&!r.verifiedAt).length,
    refreshDue:active.filter(r=>routineEligible(r,plan)&&!needsDetails(r)&&refresh(r)).length,
    waitingRetry:active.filter(r=>!due(r)).length};
}
// Twelve of sixteen slots go to unreadable recent releases/Demos. The other
// four guarantee progress for explicit requests, older basics and enrichment.
const QUEUE_SLOTS=['priority','recent','recent','recent','recent','history','recent','recent','recent','enrich','recent','recent','recent','verify','recent','recent'];
export function workQueue(state,plan,now) {
  const due = Object.values(state.phase1.catalog).filter(r=>!r.excluded && (!r.retryAfter||r.retryAfter<=now) &&
    (needsDetails(r) || r.priorityRequestedAt>(r.priorityAttemptedAt||'') || routineEligible(r,plan)&&(!r.verifiedAt || +new Date(now)-Date.parse(r.verifiedAt)>=(r.item.releaseDate>=shiftDate(plan.latest,-6)?DAY:7*DAY))));
  const lanes=Object.fromEntries([...new Set([...QUEUE_SLOTS,'refresh'])].map(k=>[k,[]]));
  for(const r of due) {
    // An undated future page first seen today must not precede yesterday's
    // releases simply because its observation date is newer.
    const recent=r.item.releaseDate>=shiftDate(plan.latest,-3)&&r.item.releaseDate<=shiftDate(plan.latest,1);
    const lane=r.priorityRequestedAt>(r.priorityAttemptedAt||'')?'priority':needsBasics(r)?(recent?'recent':'history'):needsDetails(r)?'enrich':!r.verifiedAt?'verify':'refresh';
    lanes[lane].push(r);
  }
  // Old untouched rows precede retried rows. Separate shares prevent either
  // Demo volume or routine rechecks from blocking initial detail completion.
  for(const [key,lane] of Object.entries(lanes))lane.sort((a,b)=>{
    // Within recent work, give the newest issue its first usable cards promptly.
    const recentOrder=key==='recent'?String(b.item.releaseDate||b.firstObservedAt||'').slice(0,10).localeCompare(String(a.item.releaseDate||a.firstObservedAt||'').slice(0,10)):0;
    return recentOrder||String(a.lastAttemptAt||a.firstObservedAt||state.phase1.initializedAt||'').localeCompare(b.lastAttemptAt||b.firstObservedAt||state.phase1.initializedAt||'')||String(a.item.releaseDate||'').localeCompare(b.item.releaseDate||'')||a.item.appid-b.item.appid;
  });
  const recentIds=new Set(lanes.recent.map(r=>r.item.appid));
  const days=new Map();for(const r of lanes.recent){const date=r.item.releaseDate;if(!days.has(date))days.set(date,[]);days.get(date).push(r);}
  // Alternate game and Demo candidates within each day, independently of AppID.
  // Persist the chosen kind so one-item resumptions remain fair as well.
  for(const [date,rows] of days) {
    const isDemo=r=>r.snapshot?.demo??(r.item.sources?.includes('demo')&&!r.item.sources?.includes('games'));
    const groups=[rows.filter(r=>!isDemo(r)),rows.filter(isDemo)];
    const ordered=[];let kind=state.phase1.recentKinds?.[date]||0;
    while(ordered.length<rows.length){const group=groups[kind++%2];ordered.push((group.length?group:groups.find(g=>g.length)).shift());}
    days.set(date,ordered);
  }
  const dateSlots=[plan.latest,plan.latest,shiftDate(plan.latest,-1),plan.latest,shiftDate(plan.latest,-2),shiftDate(plan.latest,-3)];
  const balanced=[];let dateTurn=state.phase1.recentTurn||0;
  while(balanced.length<lanes.recent.length){
    const preferred=days.get(dateSlots[dateTurn++%dateSlots.length]);
    const lane=preferred?.length?preferred:[...days.values()].find(rows=>rows.length);
    balanced.push(lane.shift());
  }
  lanes.recent=balanced;
  const maintenanceIds=new Set([...lanes.verify,...lanes.refresh].map(r=>r.item.appid));
  const queue=[];let turn=state.phase1.queueTurn||0,maintenanceTurn=state.phase1.maintenanceTurn||0;
  while(queue.length<due.length) {
    const preferred=QUEUE_SLOTS[turn++%QUEUE_SLOTS.length];
    const chosen=preferred==='verify'?['verify','refresh'][maintenanceTurn++%2]:preferred;
    const maintenance=preferred==='verify'?[lanes[chosen],lanes[chosen==='verify'?'refresh':'verify']].find(items=>items.length):null;
    const lane=maintenance|| (lanes[chosen]?.length?lanes[chosen]:Object.values(lanes).find(items=>items.length));
    queue.push(lane.shift());
  }
  Object.defineProperty(queue,'recentIds',{value:recentIds});
  Object.defineProperty(queue,'maintenanceIds',{value:maintenanceIds});
  return queue;
}
export async function scanWindow(state,plan,filter,{getPage,save,now,deadline=()=>false}) {
  const key=`${plan.oldest}:${filter}`;
  let scan=state.phase1.scans[key];
  if(scan?.completeAt && +new Date(now)-Date.parse(scan.completeAt)<6*3600000)return true;
  if(!scan || scan.completeAt)scan=state.phase1.scans[key]={start:0,pages:0,olderPages:0,signatures:[]};
  let pagesThisRun=0;
  while(!deadline()) {
    if(pagesThisRun>=80) { scan.error='本轮扫描达到80页，已保存游标，下轮从此处继续'; await save();return false; }
    let payload;
    try {payload=await getPage(filter,scan.start);}catch(e){scan.error=e.message;await save();return false;}
    const {items,total}=payload;
    if(!items.length) {
      if(Number.isFinite(total)&&scan.start<total){scan.error='搜索提前返回空页，等待重试';await save();return false;}
      scan.completeAt=now;delete scan.error;await save();return true;
    }
    const signature=items.map(i=>i.appid).join(',');
    if(scan.signatures.includes(signature)){scan.error=`搜索在偏移 ${scan.start} 返回重复页，保留已确认游标待复查`;await save();return false;}
    scan.signatures.push(signature);
    const relevant=items.filter(i=>!i.releaseDate||i.releaseDate>=plan.searchCutoff);
    ingest(state,relevant,filter,now);
    // Persist identity BEFORE attempting app details or review requests.
    const nextStart=payload.nextStart??scan.start+items.length;
    if(!Number.isInteger(nextStart)||nextStart<=scan.start){scan.error='搜索偏移未前进，保留游标等待复查';await save();return false;}
    scan.start=nextStart;scan.pages++;pagesThisRun++;
    scan.olderPages=items.every(i=>i.releaseDate&&i.releaseDate<plan.searchCutoff)?scan.olderPages+1:0;
    if(scan.olderPages>=3||(Number.isFinite(total)&&scan.start>=total)){scan.completeAt=now;delete scan.error;await save();return true;}
    await save();
  }
  return false;
}
export async function runSweep(state,{now=new Date().toISOString(),latest,force30=false,getPage,getDetail,save=async()=>{},deadline=()=>false,scanDeadline=deadline,stopReason=()=>null,maxDetails=Infinity,priorityIds=[],priorityRequests=[],onProgress=async()=>{}}) {
  initialize(state,now);reconcileReports(state,now,latest);const plan=sweepPlan(state,now,latest,force30);
  for(const id of priorityIds)if(state.phase1.catalog[id])state.phase1.catalog[id].priorityRequestedAt=now;
  ensureReport(state,latest,now);
  let processed=0,completedDetails=0,basicCompleted=0,verified=0,failed=0,excluded=0,scansComplete=false;
  const checkpoint=async stage=>{
    state.phase1.progress={startedAt:now,updatedAt:new Date().toISOString(),reportDate:latest,stage,scanDays:plan.scanDays,scansComplete,processed,completedDetails,basicCompleted,verified,failed,excluded,...backlog(state,plan,now)};
    await save();await onProgress(state.phase1.progress);
  };
  await checkpoint('search');
  scansComplete=true;
  for(const filter of ['games','demo']) {
    const complete=await scanWindow(state,plan,filter,{getPage,save,now,deadline:()=>deadline()||scanDeadline()});
    scansComplete=complete&&scansComplete;
    if(deadline()){scansComplete=false;break;}
  }
  for(const request of priorityRequests) {
    const record=state.phase1.catalog[request.appid];
    if(record&&request.requestedAt>(record.priorityRequestedAt||''))record.priorityRequestedAt=request.requestedAt;
  }
  for(const id of priorityIds)if(state.phase1.catalog[id])state.phase1.catalog[id].priorityRequestedAt=now;
  const queue=workQueue(state,plan,now);
  // Immediately show every newly discovered candidate, even on an interrupted run.
  for(const record of queue)if(!record.snapshot){applyRecord(state,record,placeholder(record,now),now,latest);}
  await checkpoint('details');
  for(const record of queue) {
    if(deadline()||processed>=maxDetails)break;
    const wasMissing=needsDetails(record);
    const wasBasic=needsBasics(record);
    record.lastAttemptAt=now;
    if(record.priorityRequestedAt)record.priorityAttemptedAt=now;
    state.phase1.queueTurn=((state.phase1.queueTurn||0)+1)%QUEUE_SLOTS.length;
    if(queue.maintenanceIds.has(record.item.appid))state.phase1.maintenanceTurn=((state.phase1.maintenanceTurn||0)+1)%2;
    if(queue.recentIds.has(record.item.appid)){
      state.phase1.recentTurn=((state.phase1.recentTurn||0)+1)%6;
      state.phase1.recentKinds||={};
      const demo=record.snapshot?.demo??(record.item.sources?.includes('demo')&&!record.item.sources?.includes('games'));
      state.phase1.recentKinds[record.item.releaseDate]=demo?0:1;
    }
    try {
      const result=await getDetail(record);
      const game=result===null?null:normalizeRecord(record,result.detail,result.review,result.html,now,result.evidence);
      applyRecord(state,record,game,now,latest);
      record.verifiedAt=now;record.attempts=0;delete record.lastError;delete record.retryAfter;
      if(game&&record.snapshot?.metadataPending?.length){record.verifiedAt=null;record.retryAfter=new Date(+new Date(now)+3600000).toISOString();record.attempts=1;record.lastError=result.reviewError||result.pageError||'部分补充资料尚未取得';}
      if(game&&wasBasic&&!needsBasics(record))basicCompleted++;
      if(game===null)excluded++;
      else if(!needsDetails(record)){if(wasMissing)completedDetails++;else verified++;}
      else failed++;
    } catch(e) {
      record.lastError=e.message;record.attempts=(record.attempts||0)+1;record.retryAfter=new Date(+new Date(now)+3600000).toISOString();
      failed++;
    }
    processed++;await checkpoint('details');
  }
  const pending=Object.values(state.phase1.catalog).filter(r=>!r.excluded&&(needsDetails(r)||routineEligible(r,plan)&&!r.verifiedAt));
  const weeklyQueueDone=!queue.some(r=>!r.verifiedAt || r.verifiedAt<now);
  // The 30-day search has its own cadence. Unresolved detail records remain in
  // the durable queue even after switching back to the recent seven-day scan.
  if(plan.weekly&&scansComplete)state.phase1.lastWeeklyAt=now;
  for(const report of state.reports) {
    const ids=new Set(report.sections.flatMap(s=>s.games.map(g=>g.id)));
    const waiting=pending.filter(r=>ids.has(r.item.appid));
    if(report.date>=plan.oldest&&report.date<=latest){
      report.label='持续复查';
      report.collection={...report.collection,state:waiting.length||!scansComplete?'partial':'checked',coverage:'search-window-only',scanComplete:scansComplete,pendingIds:waiting.map(r=>r.item.appid),lastCheckedAt:now,windowDays:plan.scanDays};
      delete report.collection.pendingItems;
      if(report.recovery)report.recovery={...report.recovery,state:scansComplete&&!waiting.length?'recovered':'pending'};
    }
  }
  state.generatedAt=now;state.phase1.lastRunAt=now;
  const reason=stopReason() || (processed<queue.length&&processed>=maxDetails?'batch-limit':deadline()?'time-budget':!scansComplete?'search-incomplete':failed?'request-failed':pending.length?'backlog':null);
  await checkpoint('finished');
  state.phase1.lastSummary={...state.phase1.progress,stopReason:reason,candidates:Object.keys(state.phase1.catalog).length,pending:pending.length};
  // Prune operational records outside retention only AFTER a successful full sweep.
  if(plan.weekly&&scansComplete&&weeklyQueueDone) {
    for(const [id,r]of Object.entries(state.phase1.catalog))if(r.snapshot?.releaseDate&&r.snapshot.releaseDate<plan.retentionOldest)delete state.phase1.catalog[id];
    state.phase1.scans=Object.fromEntries(Object.entries(state.phase1.scans).filter(([key])=>key.startsWith(plan.oldest)));
  }
  await save();
  const scanErrors=Object.fromEntries(Object.entries(state.phase1.scans).filter(([key,scan])=>key.startsWith(plan.oldest)&&scan.error).map(([key,scan])=>[key,scan.error]));
  return {state:pending.length||!scansComplete||failed||processed<queue.length?'partial':'success',reportDate:latest,...state.phase1.lastSummary,scanErrors,message:'初版发布后持续补充；搜索复查通过不代表 Steam 全量覆盖'};
}
