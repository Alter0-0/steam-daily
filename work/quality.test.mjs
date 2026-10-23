import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewUrl,normalizeReviews,createReviewService} from '../review-service.mjs';
import {initialize,workQueue,sweepPlan,parseSearchRows,ingest,placeholder,preserveSnapshot,normalizeRecord,runSweep} from '../phase1.mjs';
import {createSteamClient} from '../steam-network.mjs';
import {resolveReleaseTime} from '../release-time.mjs';
const now='2026-10-23T06:00:00.000Z',latest='2026-10-22';
test('reviews use the replacement endpoint with a structured all-language request',()=>{
  const url=new URL(reviewUrl(3755350));assert.equal(url.hostname,'api.steampowered.com');assert.match(url.pathname,/IUserReviewsService\/GetAppReviews\/v1/);
  const input=JSON.parse(url.searchParams.get('input_json'));assert.equal(input.appid,3755350);assert.deepEqual(input.languages,['all']);assert.equal(input.purchase_type,0);
});
test('replacement summary handles string counts, known zero, and invalid responses distinctly',()=>{
  assert.equal(normalizeReviews({response:{query_summary:{total_reviews:'273',total_positive:'268',total_negative:'5'}}}).query_summary.total_reviews,273);
  assert.equal(normalizeReviews({response:{query_summary:{total_reviews:'0',total_positive:'0'}}}).query_summary.total_reviews,0);
  for(const p of [{response:{}},{response:{query_summary:{}}},{response:{query_summary:{total_reviews:5,total_positive:6}}},'<html>Welcome</html>'])assert.equal(normalizeReviews(p),null);
});
test('a broken review source pauses after three failures and recovers later',async()=>{
  let clock=0,calls=0,ok=false;const service=createReviewService({now:()=>clock,request:async()=>{calls++;if(!ok)throw new Error('invalid JSON');return{response:{query_summary:{total_reviews:2,total_positive:1}}};}});
  for(let i=0;i<10;i++)await service.get(i+1);assert.equal(calls,3);assert.equal(service.stats().state,'paused');assert.match(service.stats().lastError,/JSON/);
  clock=16*60*1000;ok=true;assert.equal((await service.get(20)).review.query_summary.total_reviews,2);assert.equal(service.stats().state,'healthy');
});
test('review source rate limits do not stop the separate store client',async()=>{
  const service=createReviewService({request:async()=>{throw new Error('Steam 返回 429');}});await service.get(1);assert.equal(service.stats().state,'paused');
  const store=createSteamClient({sleep:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({success:true})})});assert.equal((await store('store')).success,true);
});
test('permanent HTTP errors are not pointlessly retried',async()=>{
  let calls=0;const client=createSteamClient({sleep:async()=>{},fetchImpl:async()=>{calls++;return{status:410,ok:false};}});
  await assert.rejects(client('old-source'),/410/);assert.equal(calls,1);
});
test('a recent issue is serviced even with thousands of old candidates and future pages',()=>{
  const s={reports:[]};initialize(s,now);
  for(let id=1;id<=1000;id++)s.phase1.catalog[id]={item:{appid:id,releaseDate:'2026-09-25',sources:['games']},firstObservedAt:'2026-10-19T00:00:00Z'};
  s.phase1.catalog[1001]={item:{appid:1001,releaseDate:null,sources:['games']},firstObservedAt:now};
  for(const id of [2001,2002,2003])s.phase1.catalog[id]={item:{appid:id,releaseDate:'2026-10-22',sources:['games']},firstObservedAt:now};
  const ids=workQueue(s,sweepPlan(s,now,latest),now).slice(0,7).map(r=>r.item.appid);assert.ok(ids.filter(id=>id>=2001).length>=3);assert.ok(ids.some(id=>id<=1000));
});
const raw=(id,title,extra='')=>`<a data-ds-appid="${id}"><img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/hash/capsule.jpg"><span class="title">${title}</span><div class="search_released">2026 年 10 月 22 日</div>${extra}</a>`;
test('discovery rows retain real Chinese names, covers, prices and store review summaries',()=>{
  const [item]=parseSearchRows(raw(1,'三国义','<span data-tooltip-html="特别好评&lt;br&gt;此游戏的 1,075 篇用户评测中有 97% 为好评。"></span><div data-price-final="3519"><div class="discount_final_price">¥35.19</div></div>'));
  assert.equal(item.searchName,'三国义');assert.equal(item.searchPrice,'¥35.19');assert.equal(item.searchPriceValue,35.19);assert.deepEqual(item.listingReview,{total:1075,rating:97});assert.match(item.searchCover,/hash/);
  const g=placeholder({item:{...item,sources:['games']}},now);assert.equal(g.rating,97);assert.equal(g.reviews,'1,075');assert.ok(g.metadataPending.includes('detail'));assert.ok(!g.metadataPending.includes('reviews'));
});
test('search data does not leak from one row into its neighbor or invent empty review counts',()=>{
  const items=parseSearchRows(raw(1,'Empty')+raw(2,'Priced','<div data-price-final="900"><div class="discount_final_price">¥9</div></div>'));
  assert.equal(items[0].searchPrice,undefined);assert.equal(items[0].listingReview,undefined);assert.equal(items[1].searchPrice,'¥9');
});
test('rescanning search improves provisional entries without replacing historical known snapshots',()=>{
  const s={reports:[{date:latest,sections:[{key:'release',games:[{id:1,name:'Old English',en:'Old English',provisional:true},{id:2,name:'Known',price:'¥10',rating:50,reviews:'2'}]}]}]};initialize(s,now);
  ingest(s,[{appid:1,searchName:'新中文名',searchPrice:'¥20',searchPriceValue:20},{appid:2,searchName:'Changed',searchPrice:'¥99'}],'games',now);
  const games=s.reports[0].sections[0].games;assert.equal(games[0].name,'新中文名');assert.equal(games[0].en,'Old English');assert.equal(games[0].price,'¥20');assert.equal(games[1].price,'¥10');
});
test('a later failed review lookup cannot invalidate a previously verified review snapshot',()=>{
  const old={name:'Known',price:'¥10',rating:80,reviews:'10',metadataPending:[],reviewSnapshotAt:'2026-10-19T00:00:00Z'};
  const g=preserveSnapshot(old,{name:'Known',price:'¥20',rating:null,reviews:'0',metadataPending:['reviews'],snapshotAt:now});
  assert.equal(g.rating,80);assert.equal(g.reviews,'10');assert.deepEqual(g.metadataPending,[]);assert.equal(g.reviewSnapshotAt,old.reviewSnapshotAt);
});
test('known date with no published timestamp is distinguished from a failed page lookup',()=>{
  const withPage=resolveReleaseTime({storeText:'2026 年 10 月 22 日',evidence:{timestamp:null,earlyAccessDate:null,announcements:[]},now});assert.match(withPage.time,/未公开/);assert.doesNotMatch(withPage.time,/未核实/);
  assert.match(resolveReleaseTime({storeText:'2026 年 10 月 22 日',now}).time,/未核实/);
});
test('demos and unpublished prices do not masquerade as missing details',()=>{
  const record={item:{appid:1,releasedText:'22 Oct, 2026',sources:['demo']}};
  const normalize=data=>normalizeRecord(record,{data},{query_summary:{total_reviews:0,total_positive:0}},'<html></html>',now);
  assert.equal(normalize({type:'demo',is_free:false}).price,'Demo 试玩');
  assert.equal(normalize({type:'game',release_date:{coming_soon:true}}).price,'尚未公布售价');
  assert.equal(normalize({type:'game'}).price,'国区暂无售价');
});
test('base detail progress remains visible when the review API is unavailable',async()=>{
  const s={reports:[]};const summary=await runSweep(s,{now,latest,getPage:async filter=>({items:filter==='games'?[{appid:1,releaseDate:latest,releasedText:'22 Oct, 2026',searchName:'Game'}]:[],total:filter==='games'?1:0}),getDetail:async()=>({detail:{data:{type:'game',name:'中文',is_free:true,release_date:{date:'22 Oct, 2026'}}},review:null,html:'<html></html>',reviewError:'new reviews unavailable'})});
  assert.equal(summary.basicCompleted,1);assert.equal(summary.completedDetails,0);assert.equal(s.phase1.catalog[1].snapshot.provisional,undefined);assert.match(s.phase1.catalog[1].lastError,/reviews/);
});
