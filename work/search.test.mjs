import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html = await fs.readFile(new URL('../outputs/steam-daily.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function normalizeSearch('), html.indexOf('    // End global search core.'));
const { buildGlobalSearchIndex, searchAllReports } = vm.runInNewContext(source + ';({buildGlobalSearchIndex,searchAllReports})');
const report = (date, sections) => ({date, sections});
const section = (key, games) => ({key, title:key, games});
const game = (id, name, en, extra={}) => ({id, name, en, ...extra});

test('global search merges AppIDs across dates and sections and retains every name and occurrence', () => {
  const input = [
    report('2026-10-16', [section('release', [game(3755350, '爱丽丝与彼岸', 'Alice Nation')])]),
    report('2026-10-15', [section('release', [game(3755350, 'Alice Nation', 'Alice Nation', {provisional:true})]), section('new-page', [game(3755350, '旧中文名', 'Alice Nation')])])
  ];
  const before = JSON.stringify(input);
  const index = buildGlobalSearchIndex(input);
  assert.equal(index.length, 1);
  assert.equal(index[0].occurrences.length, 3);
  assert.equal(searchAllReports(index, '爱丽丝')[0].id, '3755350');
  assert.equal(searchAllReports(index, 'ALICE nation')[0].id, '3755350');
  assert.equal(searchAllReports(index, '旧中文名')[0].id, '3755350');
  assert.equal(searchAllReports(index, '3755350')[0].id, '3755350');
  assert.equal(JSON.stringify(input), before);
});

test('global search normalizes full-width characters, case, repeated spaces, and word order', () => {
  const index = buildGlobalSearchIndex([report('2026-10-15', [section('release', [game(1, 'Doomed Otaku', 'Doomed Otaku')])])]);
  assert.equal(searchAllReports(index, '  ＯＴＡＫＵ   doomed  ').length, 1);
  assert.equal(searchAllReports(index, ' ').length, 0);
  assert.equal(searchAllReports(index, 'Otaku absent').length, 0);
});

test('exact names precede prefixes and substring matches; no results are silently truncated', () => {
  const games = [game(1, 'Alice Nation', ''), game(2, 'Alice Nation Demo', ''), game(3, 'The Alice Nation Story', '')];
  const index = buildGlobalSearchIndex([report('2026-10-16', [section('release', games.concat(Array.from({length:67}, (_,i)=>game(i+10, `Alice sample ${i}`, ''))))])]);
  assert.equal(searchAllReports(index, 'Alice').length, 70);
  assert.equal(searchAllReports(index, 'Alice Nation').map(e=>e.id).join(','), '1,2,3');
});

test('missing details and empty reports are searchable without assuming a Chinese translation', () => {
  const input = [report('2026-10-18', []), report('2026-10-15', [section('release', [game(3318210, 'Doomed Otaku', '', {provisional:true})])])];
  const index = buildGlobalSearchIndex(input);
  assert.equal(searchAllReports(index, 'Doomed')[0].occurrences[0].date, '2026-10-15');
  assert.equal(searchAllReports(index, '破灭的御宅族').length, 0);
  assert.equal(searchAllReports(buildGlobalSearchIndex([]), 'Alice').length, 0);
});
