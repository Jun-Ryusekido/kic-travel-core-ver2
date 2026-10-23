// 予約進捗判定(public/js/booking-progress.js)の単体テスト。実行: node scripts/test_booking_progress.js
const assert=require('assert');
const BP=require('../public/js/booking-progress.js');
const J=BP.judgeBookingProgress;
const base={booking:{status:'open'},hasEstimation:false,hotels:[],buses:[],activeInvoiceCount:0,salesTotal:0,paidTotal:0};
const t=(o)=>J({...base,...o});
// payment
assert.equal(t({salesTotal:5e6,paidTotal:5e6}).stages.payment.state,'done');
assert.equal(t({salesTotal:8256458.5,paidTotal:8256458}).stages.payment.state,'done'); // <1円差
assert.equal(t({salesTotal:5e6,paidTotal:3e6}).stages.payment.state,'progress');
assert.equal(t({salesTotal:5e6,paidTotal:0}).stages.payment.state,'todo');
let r=t({salesTotal:5e6,paidTotal:5000002});assert.equal(r.stages.payment.state,'alert');assert.equal(r.reasons[0].code,'overpaid');
r=t({salesTotal:0,paidTotal:1000});assert.equal(r.reasons[0].code,'sales_zero_with_payment');
assert.equal(t({salesTotal:0,paidTotal:0}).stages.payment.state,'todo');
assert.equal(t({salesTotal:-500,paidTotal:0}).reasons[0].code,'sales_negative');
// arrangement
const A=(h,b)=>t({hotels:(h||[]).map(s=>({status:s})),buses:(b||[]).map(s=>({status:s}))}).stages.arrangement;
assert.equal(A([],[]).state,'todo');
assert.equal(A(['手配OK','FNL済'],['確定']).text,'3/3件 OK');
assert.equal(A(['手配OK','問い合わせ中','回答待ち']).state,'progress');
assert.equal(A(['未予約','未予約']).state,'todo');
assert.equal(A(['手配OK','未予約']).state,'progress');
assert.equal(A(['手配OK','NG回答','問い合わせ中']).state,'alert');
assert.deepEqual(A(['キャンセル','手配OK']).reasons.map(x=>x.code),['arr_cancel']);
assert.deepEqual(A(['NG回答','キャンセル']).reasons.map(x=>x.code),['arr_ng','arr_cancel']);
assert.equal(A(['予約不要','手配OK']).text,'1/1件 OK');
assert.equal(A(['予約不要']).state,'todo');
assert.equal(A([null,'']).state,'todo');
assert.equal(BP.normalizeArrangementStatus('変な値'),null);
// invoice / estimate / document
assert.equal(t({activeInvoiceCount:1}).stages.invoice.state,'done');
assert.equal(t({}).stages.invoice.state,'todo');
assert.equal(t({hasEstimation:true}).stages.estimate.state,'done');
assert.equal(t({}).stages.estimate.state,'na');assert.equal(t({}).stages.document.text,'記録なし');
// cancelled
r=J({...base,booking:{status:'cancelled'},hotels:[{status:'NG回答'}],salesTotal:0,paidTotal:99});
assert.ok(BP.STAGE_KEYS.every(k=>r.stages[k].state==='na'));assert.equal(r.needsAttention,false);
assert.equal(t({salesRowCount:0,salesTotal:0,paidTotal:0}).stages.payment.text,'売上未入力');
assert.equal(t({salesRowCount:0}).needsAttention,false);
console.log('booking-progress: all tests passed');
