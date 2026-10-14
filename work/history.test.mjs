import test from 'node:test';
import assert from 'node:assert/strict';
import { missingDates, recoveryReport, recoverDates } from '../history.mjs';

test('finds gaps and incomplete recovery without inventing pre-baseline history', () => {
  const reports = [{date:'2026-10-06'}, {date:'2026-10-09'}, recoveryReport('2026-10-08')];
  assert.deepEqual(missingDates(reports, '2026-10-10'), ['2026-10-07','2026-10-08']);
  assert.deepEqual(missingDates([], '2026-10-10'), []);
});
test('recovery separates dated demos, deduplicates games and cannot invent new-page history', () => {
  const r = recoveryReport('2026-10-07', [{id:1, releaseDate:'2026-10-07', demo:false}, {id:1, releaseDate:'2026-10-07',demo:false}, {id:2, releaseDate:'2026-10-08',demo:true}], '2026-10-11T00:00:00Z', true);
  assert.equal(r.sections[0].games.length,1);
  assert.equal(r.sections[1].games.length,0);
  assert.equal(r.sections[2].games.length,0);
  assert.equal(r.recovery.state, 'recovered');
});
test('scans beyond first page and marks failed details incomplete', async () => {
  const pages = [[{appid:1,releaseDate:'2026-10-10'}], [{appid:2,releaseDate:'2026-10-07'}]];
  const reports = await recoverDates(['2026-10-07'], {now:'2026-10-11T00:00:00Z', getPage:async start => ({items:pages[start]||[],total:2}), getGame:async item => ({id:item.appid,releaseDate:item.releaseDate,demo:true})});
  assert.equal(reports[0].recovery.state,'recovered');
  assert.equal(reports[0].sections[2].games[0].id,2);
  const failed = await recoverDates(['2026-10-07'], {now:'2026-10-11T00:00:00Z',getPage:async () => ({items:[{appid:2,releaseDate:'2026-10-07'}],total:1}),getGame:async () => {throw new Error('timeout');}});
  assert.equal(failed[0].recovery.state,'pending');
});
test('repeated search page retains partial recovery without claiming completeness', async () => {
  const result = await recoverDates(['2026-10-07'], {now:'2026-10-11T00:00:00Z',getPage:async () => ({items:[{appid:2,releaseDate:'2026-10-07'}],total:100}),getGame:async item => ({id:item.appid,releaseDate:item.releaseDate,demo:false})});
  assert.equal(result[0].recovery.state,'pending');
  assert.equal(result[0].sections[0].games.length,1);
});
