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
  for (const m of html.matchAll(/data-ds-appid="(\d+)"[\s\S]*?<span class="title">([\s\S]*?)<\/span>[\s\S]*?<div class="search_released[^\"]*">([\s\S]*?)<\/div>/g)) {
    const appid=Number(m[1]);if(ids.has(appid))continue;ids.add(appid);
    const clean = t => t.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
    items.push({appid,searchName:clean(m[2]),releasedText:clean(m[3]),releaseDate:parseReleaseDate(clean(m[3]))});
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
  for (const item of items) {
    const old=catalog[item.appid];
    catalog[item.appid]={...old,item:{...old?.item,...item,sources:[...new Set([...(old?.item.sources||[]),source])]},firstObservedAt:old?.firstObservedAt||now,lastSeenAt:now,attempts:old?.attempts||0};
  }
}
export function placeholder(record, now) {
  const item=record.item; const demo=item.sources?.includes('demo') && !item.sources?.includes('games');
  return { id:item.appid,name:item.searchName||`Steam 应用 ${item.appid}`,en:item.searchName||'',cover:`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`,
    price:'待核实',priceValue:999999,rating:null,reviews:'0',tags:[],status:[demo?'Demo':'信息待补充'],studio:'待核实',publisher:'待核实',demo,
    ...resolveReleaseTime({searchText:item.releasedText,demo,now}),firstObservedAt:record.firstObservedAt,snapshotAt:now,metadataPending:['detail','reviews','time'],provisional:true,source:'release-search',storeUrl:`https://store.steampowered.com/app/${item.appid}/` };
}
export function normalizeRecord(record, detail, review, html, now) {
  const d=detail.data;
  if(!['game','demo'].includes(d.type))return null;
  const total=review?.query_summary?.total_reviews; const positive=review?.query_summary?.total_positive;
  const tags=(d.genres||[]).map(g=>g.description).filter(Boolean).slice(0,8);
  const demo=d.type==='demo'; const earlyAccess=(d.genres||[]).some(g=>String(g.id)==='70'||/抢先体验|Early Access/i.test(g.description));
  const timing=resolveReleaseTime({storeText:d.release_date?.date,searchText:record.item.releasedText,html,demo,earlyAccess,comingSoon:!!d.release_date?.coming_soon,now});
  const stage=demo?'Demo':earlyAccess?'抢先体验':timing.eventKind==='full-release'?'正式版上线':'游戏发售';
  const pending=[];if(!review?.query_summary)pending.push('reviews');if(!html)pending.push('time');
  return { id:record.item.appid,name:d.name||record.item.searchName,en:record.item.searchName||d.name,cover:d.header_image||`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${record.item.appid}/header.jpg`,
    price:d.is_free?'免费':d.price_overview?.final_formatted||'未定价',priceValue:d.is_free?0:(d.price_overview?.final??99999900)/100,
    rating:total>0?Math.round(positive/total*100):null,reviews:(total||0).toLocaleString('en-US'),tags,status:[stage],studio:(d.developers||[]).join(', ')||'未知',publisher:(d.publishers||[]).join(', ')||'未知',demo,
    ...timing,firstObservedAt:record.firstObservedAt,snapshotAt:now,priceSnapshotAt:now,reviewSnapshotAt:review?.query_summary?now:null,metadataPending:pending,source:'release-search+appdetails+store-page',storeUrl:`https://store.steampowered.com/app/${record.item.appid}/` };
}
export function preserveSnapshot(old, fresh) {
  if(!old || old.provisional)return {...fresh,snapshotAt:old?.snapshotAt||fresh.snapshotAt};
  // Preserve every previously known price/review. Only fill fields that failed then.
  const pending=old.metadataPending||[];
  return {...old,...fresh,price:old.price,priceValue:old.priceValue,rating:pending.includes('reviews')?fresh.rating:old.rating,reviews:pending.includes('reviews')?fresh.reviews:old.reviews,
    snapshotAt:old.snapshotAt??null,firstObservedAt:old.firstObservedAt||fresh.firstObservedAt,
    priceSnapshotAt:old.priceSnapshotAt||old.snapshotAt||null,reviewSnapshotAt:pending.includes('reviews')?fresh.reviewSnapshotAt:old.reviewSnapshotAt||old.snapshotAt||null,
    metadataUpdatedAt:fresh.metadataUpdatedAt||fresh.snapshotAt,metadataPending:fresh.metadataPending,provisional:false};
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
  const oldest=shiftDate(latest,-29);
  // A correction can move the release section, while historical discoveries stay.
  if(!merged.comingSoon && date && date>=oldest && date<=latest) {
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
  state.reports=state.reports.filter(r=>r.date>=oldest).sort((a,b)=>b.date.localeCompare(a.date));
}
export function workQueue(state,plan,now) {
  const due = Object.values(state.phase1.catalog).filter(r=>!r.excluded && (!r.retryAfter||r.retryAfter<=now) &&
    (!r.verifiedAt || +new Date(now)-Date.parse(r.verifiedAt)>=(r.item.releaseDate>=shiftDate(plan.latest,-6)?DAY:7*DAY)));
  // Failed items cannot monopolize the front; unverified historical rows must progress.
  return due.sort((a,b)=>(a.attempts||0)-(b.attempts||0)||Number(!!a.verifiedAt)-Number(!!b.verifiedAt)||String(b.item.releaseDate||'').localeCompare(a.item.releaseDate||'')||a.item.appid-b.item.appid);
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
export async function runSweep(state,{now=new Date().toISOString(),latest,force30=false,getPage,getDetail,save=async()=>{},deadline=()=>false}) {
  initialize(state,now);const plan=sweepPlan(state,now,latest,force30);
  ensureReport(state,latest,now);
  let scansComplete=true;
  for(const filter of ['games','demo']) {
    const complete=await scanWindow(state,plan,filter,{getPage,save,now,deadline});
    scansComplete=complete&&scansComplete;
    if(deadline()){scansComplete=false;break;}
  }
  let processed=0;
  const queue=workQueue(state,plan,now);
  // Immediately show every newly discovered candidate, even on an interrupted run.
  for(const record of queue)if(!record.snapshot){applyRecord(state,record,placeholder(record,now),now,latest);}
  await save();
  for(const record of queue) {
    if(deadline())break;
    try {
      const result=await getDetail(record);
      const game=result===null?null:normalizeRecord(record,result.detail,result.review,result.html,now);
      applyRecord(state,record,game,now,latest);
      record.verifiedAt=now;record.attempts=0;delete record.lastError;delete record.retryAfter;
      if(game?.metadataPending?.length){record.verifiedAt=null;record.retryAfter=new Date(+new Date(now)+3600000).toISOString();record.attempts=1;}
    } catch(e) {
      record.lastError=e.message;record.attempts=(record.attempts||0)+1;record.retryAfter=new Date(+new Date(now)+3600000).toISOString();
    }
    processed++;await save();
  }
  const pending=Object.values(state.phase1.catalog).filter(r=>!r.excluded&&(!r.verifiedAt||r.snapshot?.metadataPending?.length));
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
  state.phase1.lastSummary={scanDays:plan.scanDays,scansComplete,processed,candidates:Object.keys(state.phase1.catalog).length,pending:pending.length};
  // Prune operational records outside retention only AFTER a successful full sweep.
  if(plan.weekly&&scansComplete&&weeklyQueueDone) {
    for(const [id,r]of Object.entries(state.phase1.catalog))if(r.snapshot?.releaseDate&&r.snapshot.releaseDate<plan.retentionOldest)delete state.phase1.catalog[id];
    state.phase1.scans=Object.fromEntries(Object.entries(state.phase1.scans).filter(([key])=>key.startsWith(plan.oldest)));
  }
  await save();
  const scanErrors=Object.fromEntries(Object.entries(state.phase1.scans).filter(([key,scan])=>key.startsWith(plan.oldest)&&scan.error).map(([key,scan])=>[key,scan.error]));
  return {state:pending.length||!scansComplete?'partial':'success',reportDate:latest,...state.phase1.lastSummary,scanErrors,message:'初版发布后持续补充；搜索复查通过不代表 Steam 全量覆盖'};
}
