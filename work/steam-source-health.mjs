import {reviewUrl,normalizeReviews} from '../review-service.mjs';
const urls=[
  reviewUrl(3755350),
  'https://store.steampowered.com/appreviews/3755350?json=1&language=all&purchase_type=all&num_per_page=1',
  'https://store.steampowered.com/api/appdetails?appids=3755350&cc=cn&l=schinese',
  'https://store.steampowered.com/search/results/?query=&start=0&count=1&sort_by=Released_DESC&infinite=1&cc=cn&l=schinese&category1=998'
];
for(const url of urls){
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(15000)});const body=await r.text();let p;try{p=JSON.parse(body);}catch{}
    console.log(JSON.stringify({endpoint:new URL(url).pathname,status:r.status,keys:Object.keys(p||{}),responseKeys:Object.keys(p?.response||{}),summary:normalizeReviews(p),sample:p?.['3755350']?.data?.name||p?.results_html?.slice(0,10000)||(!p?body.slice(0,500):undefined)}));
  }catch(e){console.log(JSON.stringify({endpoint:new URL(url).pathname,error:e.message}));}
  await new Promise(r=>setTimeout(r,5000));
}
