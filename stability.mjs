import {shiftDate} from './history.mjs';

export function reportTarget(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now));
  // Continue the previous issue overnight; open the next issue at 04:00.
  return shiftDate(date, hour < 4 ? -2 : -1);
}

export function collectionHealth(status = {}) {
  if (status.state === 'error' || ['steam-limit','interrupted','error'].includes(status.stopReason) || Object.keys(status.scanErrors || {}).length || status.processed > 0 && status.failed >= status.processed && !status.basicCompleted) return 'error';
  return status.state === 'success' ? 'complete' : 'partial';
}

export function sectionReadiness(report) {
  return Object.fromEntries(['release','demo'].map(key => {
    const games = [...new Map((report?.sections?.find(s=>s.key===key)?.games || []).map(g=>[g.id,g])).values()];
    const readable = games.filter(g=>!g.provisional && !g.metadataPending?.includes('detail')).length;
    return [key, {total:games.length,readable,pending:games.length-readable,percent:games.length ? Math.round(readable/games.length*1000)/10 : null}];
  }));
}

export function recentReadiness(reports, latest) {
  return reports.filter(r=>r.date<=latest && r.date>=shiftDate(latest,-6)).sort((a,b)=>b.date.localeCompare(a.date)).map(r=>({date:r.date,sections:sectionReadiness(r),scanComplete:r.collection?.scanComplete===true}));
}

// Record what was actually published before the deadline. Later backfills cannot
// retroactively turn a missed deadline into a pass.
export function recordAcceptance(ledger, run, reports) {
  const check = ledger.acceptance;
  if (!check || run.publication?.state !== 'success' || !run.collection?.attempted || run.collection.health === 'error') return;
  const publishedAt=Date.parse(run.publication.at),finishedAt=Date.parse(run.collection.finishedAt);
  if(!Number.isFinite(publishedAt)||!Number.isFinite(finishedAt)||publishedAt<finishedAt)return;
  for (const day of check.days) {
    const opens=Date.parse(`${shiftDate(day.date,1)}T04:00:00+08:00`);
    if(publishedAt<opens || publishedAt>Date.parse(day.deadline) || finishedAt>Date.parse(day.deadline))continue;
    const report = reports.find(r=>r.date===day.date);
    if (!report) continue;
    const snapshot = {at:run.publication.at,runId:run.id,automatic:run.event==='schedule'||run.automaticResume===true,sections:sectionReadiness(report),scanComplete:report.collection?.scanComplete===true};
    day.lastObserved = snapshot;
    // Keep the most recent automatic result even if a manual publication follows.
    if(snapshot.automatic)day.lastAutomatic = snapshot;
  }
}

export function acceptanceView(check, now = new Date().toISOString()) {
  if (!check) return null;
  return {...check, days:check.days.map(day=>{
    const sample = day.lastAutomatic;
    const sufficient = sample?.scanComplete && ['release','demo'].every(k=>sample.sections[k].total>0 && sample.sections[k].readable/sample.sections[k].total >= check.threshold);
    return {...day,state:Date.parse(now)<Date.parse(day.deadline)?'observing':sufficient?'passed':sample?'below-target':'no-evidence'};
  })};
}

export function newAcceptance(firstReportDate) {
  return {threshold:0.9,scope:'known-candidates-only',days:[0,1,2].map(offset=>{
    const date=shiftDate(firstReportDate,offset);
    return {date,deadline:`${shiftDate(date,2)}T04:00:00+08:00`};
  })};
}

export function shouldContinue(run, readiness) {
  return run.event==='schedule' && run.collection?.attempted===true && run.collection.health!=='error' && run.collection.processed>0 && run.publication?.state==='success' && readiness.some(day=>['release','demo'].some(key=>day.sections[key].pending>0));
}
