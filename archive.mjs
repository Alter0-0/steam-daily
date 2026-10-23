import {shiftDate} from './history.mjs';

// Storage lifetime, the home page window, and routine rechecks are independent.
export function publication(reports = [], generatedAt = null) {
  const sorted = [...reports].sort((a,b)=>b.date.localeCompare(a.date));
  const cutoff = sorted.length ? shiftDate(sorted[0].date,-29) : null;
  const recent = sorted.filter(r=>r.date>=cutoff);
  const older = sorted.filter(r=>r.date<cutoff);
  const months = new Map();
  for(const report of older) {
    const month=report.date.slice(0,7);
    if(!months.has(month))months.set(month,[]);
    months.get(month).push(report);
  }
  const history={version:1,retention:'permanent',generatedAt,recentCutoff:cutoff,
    dates:sorted.map(r=>({date:r.date,archived:r.date<cutoff})),
    months:[...months.keys()].map(month=>({month,url:`./data/archive/${month}.json`})),
    searchUrl:older.length?'./data/archive/search.json':null};
  // Names and occurrences are enough for search; full historical cards load on demand.
  const searchReports=older.map(r=>({date:r.date,sections:(r.sections||[]).map(s=>({key:s.key,title:s.title,
    games:(s.games||[]).map(g=>({id:g.id,name:g.name,en:g.en,provisional:!!g.provisional}))}))}));
  return {recent,months,searchReports,history};
}

export function restoreMissingReports(state, recovered) {
  state.reports ||= [];
  const dates=new Set(state.reports.map(r=>r.date));
  let added=0;
  for(const report of recovered?.reports||[]) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(report.date)||dates.has(report.date))continue;
    state.reports.push(structuredClone(report));dates.add(report.date);added++;
  }
  state.reports.sort((a,b)=>b.date.localeCompare(a.date));
  return added;
}
