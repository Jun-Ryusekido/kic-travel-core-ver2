// progressSummary(api/table-crud.js)のサーバー側テスト。Supabaseへのfetchをモックし、ロール別の金額の有無・5分キャッシュ・書き込みでの破棄・認証・取得量を確認する。実行: node scripts/test_progress_summary.mjs
import assert from 'assert';
import crypto from 'crypto';
process.env.SUPABASE_SERVICE_ROLE_KEY='SECRET-TEST-KEY';
const { issueSessionToken } = await import('../api/lib/session-token.js');
const { default: handler } = await import('../api/table-crud.js');
const uuid=()=>crypto.randomUUID();
const B=[];for(let i=0;i<1300;i++)B.push({id:uuid(),status:i%25===0?'cancelled':'open'});
const pick=()=>B[Math.floor(Math.random()*B.length)].id;
const T={booking_sales:[],invoices:[],booking_hotels:[],booking_buses:[],estimations:[],bookings:B};
const banks=['三菱UFJ銀行','三井住友銀行','みずほ銀行','SMBC'];
for(let i=0;i<2300;i++){const n=i%3; T.booking_sales.push({id:uuid(),booking_id:i<1300?B[i].id:pick(),amount:(1000000+Math.floor(Math.random()*9e6))+(i%7?0:0.5),
  payments:Array.from({length:n},(_,j)=>({date:'2026-03-0'+(1+j),amount:500000+j*1000,bank:banks[j%4],remark:'12/03 SMBC入金分'}))});}
for(let i=0;i<1500;i++)T.invoices.push({id:uuid(),booking_id:pick(),status:['pending','paid','void'][i%3]});
for(let i=0;i<3000;i++)T.booking_hotels.push({id:uuid(),booking_id:pick(),status:['手配OK','問い合わせ中','FNL済','未予約','NG回答'][i%5]});
for(let i=0;i<1000;i++)T.booking_buses.push({id:uuid(),booking_id:pick(),status:['手配OK','問い合わせ中','FNL済'][i%3]});
for(let i=0;i<300;i++)T.estimations.push({id:uuid(),converted_booking_id:pick()});
let fetchCalls=0;const log=[];
globalThis.fetch=async(url,opts={})=>{
  const u=new URL(url);const tb=u.pathname.split('/').pop();const m=opts.method||'GET';
  if(m==='GET'&&u.searchParams.has('offset')){
    fetchCalls++;
    let rows=T[tb];
    // emulate select projection & cancelled filter
    const sel=u.searchParams.get('select').split(',');
    if(tb==='bookings'&&u.searchParams.get('status')==='ilike.cancelled')rows=rows.filter(r=>r.status==='cancelled');
    rows=rows.map(r=>Object.fromEntries(sel.filter(c=>c in r).map(c=>[c,r[c]])));
    const off=+u.searchParams.get('offset'),lim=+u.searchParams.get('limit');
    const page=rows.slice(off,off+lim);
    return new Response(JSON.stringify(page),{status:200,headers:{'content-range':`${off}-${off+page.length-1}/${rows.length}`}});
  }
  log.push(m+' '+tb);
  return new Response(JSON.stringify([{id:'x'}]),{status:200,headers:{'content-range':'0-0/1'}});
};
function call(body,headers={}){return new Promise(r=>{const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(b){this.body=b;r(this);return this}};handler({method:'POST',body,headers,query:{}},res);});}
const tok=(email,role)=>issueSessionToken({email,role});
const admin=tok('admin@kictravel.jp','admin'), kanri=tok('kanri@kictravel.jp','staff'), staff=tok('s@kictravel.jp','staff'), view=tok('v@kictravel.jp','view');
const ra=await call({action:'progressSummary',token:admin});
assert.equal(ra.statusCode,200,JSON.stringify(ra.body));
const firstCalls=fetchCalls;
const rk=await call({action:'progressSummary',token:kanri});
const rs=await call({action:'progressSummary',token:staff});
const rv=await call({action:'progressSummary',token:view});
assert.equal(fetchCalls,firstCalls,'cache must be reused for other roles/users');
assert.equal(ra.body.__progress.cached,false);assert.equal(rs.body.__progress.cached,true);
const dump=r=>JSON.stringify(Object.values(r.body.items));
const yenRe=/\d{1,3}(,\d{3})+|\d{5,}/;
console.log('admin  canView',ra.body.canViewAmounts,'amount text in items:',yenRe.test(dump(ra)));
console.log('kanri  canView',rk.body.canViewAmounts,'amount text in items:',yenRe.test(dump(rk)));
console.log('staff  canView',rs.body.canViewAmounts,'amount text in items:',yenRe.test(dump(rs)));
console.log('view   canView',rv.body.canViewAmounts,'amount text in items:',yenRe.test(dump(rv)));
assert.equal(ra.body.canViewAmounts,true);assert.equal(rk.body.canViewAmounts,true);assert.equal(rs.body.canViewAmounts,false);assert.equal(rv.body.canViewAmounts,false);
assert.ok(yenRe.test(dump(ra)));assert.ok(!yenRe.test(dump(rs)));assert.ok(!yenRe.test(dump(rv)));
// raw total keys never present for anyone
for(const r of [ra,rk,rs,rv]){ const t=JSON.stringify(r.body); assert.ok(!/"(st|pt)":\d/.test(t)); assert.ok(!('salesTotal' in r.body)); }
// no leaks of raw numbers: compute a few actual sums and ensure not in staff body
const sample=T.booking_sales[0].amount;assert.ok(!JSON.stringify(rs.body).includes(String(sample)));
// same states for all roles (only text differs)
const st=(r)=>Object.fromEntries(Object.entries(r.body.items).map(([k,v])=>[k,v.c?'c':v.st.map(x=>x[0]).join()]));
assert.deepEqual(st(ra),st(rs));
const sample1=Object.entries(ra.body.items).find(([k,v])=>v.rs&&v.rs.some(x=>x[1]==='overpaid'));
if(sample1){console.log('admin overpaid sample:',JSON.stringify(sample1[1].rs.find(x=>x[1]==='overpaid')));console.log('staff same booking :',JSON.stringify(rs.body.items[sample1[0]].rs.find(x=>x[1]==='overpaid')));}
// sizes
const bytes=ra.body.__progress.bytes;const sum=Object.values(bytes).reduce((a,b)=>a+b,0);
console.log('Supabase bytes per refresh',JSON.stringify(bytes),'TOTAL',sum,'=',(sum/1024).toFixed(0)+'KB');
console.log('client response bytes admin',JSON.stringify(ra.body).length,'staff',JSON.stringify(rs.body).length,'fetch calls',firstCalls);
// invalidation on write (invoices deleteById, valid version header)
const rw=await call({action:'deleteById',table:'invoices',id:'x',token:admin},{'x-app-version':'2026092801'});
console.log('write status',rw.statusCode,log.slice(-3));
const before=fetchCalls;const rn=await call({action:'progressSummary',token:admin});
assert.equal(rn.body.__progress.cached,false,'cache must be dropped after write');assert.ok(fetchCalls>before);
// non-related write must not drop cache
const cacheAt=globalThis.__progressRawCache.at;
await call({action:'deleteById',table:'guide_settlements',id:'x',token:admin},{'x-app-version':'2026092801'});
assert.equal(globalThis.__progressRawCache&&globalThis.__progressRawCache.at,cacheAt);
// reads do not drop
await call({action:'progressSummary',token:admin});assert.equal(globalThis.__progressRawCache.at,cacheAt);
// auth
assert.equal((await call({action:'progressSummary'})).statusCode,401);
console.log('server tests 2 passed');
