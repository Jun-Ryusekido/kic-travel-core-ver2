// 【実行に必要な環境変数】SUPABASE_SERVICE_ROLE_KEY(必須。anonキーでは実行できない)
//   値の取得: Supabase管理画面 > Project Settings > API Keys > service_role(secret)
//   設定・実行(PowerShell): $env:SUPABASE_SERVICE_ROLE_KEY="<値>"; node scripts/audit_f12_invoice_agent_mismatch.js
//   設定・実行(bash):       SUPABASE_SERVICE_ROLE_KEY=<値> node scripts/audit_f12_invoice_agent_mismatch.js
//   キーはファイルに書かずコミットしないこと。未設定時はanonキーにフォールバックせずエラー終了する
//   (2026-09 RLS対応フェーズ1で全スクリプトをservice_role必須に統一)。
// F12(入金消込の誤paid判定)調査用スクリプト。
//
// 旧ロジック(index.htmlの保存処理内、修正前)は、予約全体(booking_sales全行)の
// 入金合計が予約全体の売上合計以上になった時点で、その予約に紐づく全Invoiceを
// 無条件にpaidにしていた(エージェント単位の区別なし)。
// このスクリプトは、現在status='paid'になっている各Invoiceについて、
// 修正後のロジック(invoices.agent_name / booking_sales.agent_nameによる
// エージェント単位の入金合計 vs 売上合計)で判定し直した場合に「本来はpaidに
// ならないはず」の候補を洗い出す(読み取りのみ。実際の更新は一切行わない)。
//
// 実行方法:
//   node scripts/audit_f12_invoice_agent_mismatch.js
//
// SUPABASE_SERVICE_ROLE_KEYが必須(冒頭の【実行に必要な環境変数】参照。anonキーでは実行できない)。

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
function requireServiceRoleKey(key) {
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEYが未設定です。anonでは実行できません(anonキーはRLS有効化・権限剥奪によりテーブルを読み書きできず、空の結果による誤判定や書き込み失敗の原因になるため)。ファイル冒頭の【実行に必要な環境変数】の手順で設定してから再実行してください。');
    process.exit(1);
  }
}
requireServiceRoleKey(SB_KEY);

async function sbSelect(table, query){
  const url = `${SB_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  if(!res.ok){
    throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main(){
  const [invoices, bookings, salesRows] = await Promise.all([
    sbSelect('invoices', 'select=id,booking_id,invoice_no,agent_name,status,amount,currency,created_at&status=eq.paid'),
    sbSelect('bookings', 'select=id,ref_no,agent_name'),
    sbSelect('booking_sales', 'select=booking_id,agent_name,amount,payments')
  ]);

  const bookingById = {};
  bookings.forEach(b => { bookingById[b.id] = b; });

  const salesByBooking = {};
  salesRows.forEach(row => {
    (salesByBooking[row.booking_id] = salesByBooking[row.booking_id] || []).push(row);
  });

  const noAgentInvoices = [];   // agent_nameが無く、そもそも自動判定の対象外にすべきだったInvoice
  const suspectInvoices = [];   // agent_name単位で見ると入金不足なのにpaidになっているInvoice

  for(const inv of invoices){
    const booking = bookingById[inv.booking_id];
    const rows = salesByBooking[inv.booking_id] || [];
    const invAgent = (inv.agent_name || '').trim();

    if(!invAgent){
      noAgentInvoices.push({
        invoice_no: inv.invoice_no, booking_ref: booking ? booking.ref_no : inv.booking_id,
        booking_id: inv.booking_id, amount: inv.amount, currency: inv.currency, created_at: inv.created_at
      });
      continue;
    }

    const bookingAgent = booking ? (booking.agent_name || '').trim() : '';
    let sales = 0, paid = 0;
    rows.forEach(r => {
      const agent = (r.agent_name && r.agent_name.trim()) ? r.agent_name.trim() : bookingAgent;
      if(agent !== invAgent) return;
      sales += Number(r.amount || 0);
      const rowPaid = (Array.isArray(r.payments) ? r.payments : []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      paid += rowPaid;
    });

    if(!(paid > 0 && paid >= sales)){
      suspectInvoices.push({
        invoice_no: inv.invoice_no, booking_ref: booking ? booking.ref_no : inv.booking_id,
        booking_id: inv.booking_id, agent_name: invAgent,
        agent_sales_total: sales, agent_paid_total: paid,
        invoice_amount: inv.amount, currency: inv.currency, created_at: inv.created_at
      });
    }
  }

  console.log(`\n=== agent_nameが無いためF12対象外(要手動確認)のpaid Invoice: ${noAgentInvoices.length}件 ===`);
  console.table(noAgentInvoices);

  console.log(`\n=== エージェント単位で見ると入金不足の疑いがあるpaid Invoice(要調査・要手動確認): ${suspectInvoices.length}件 ===`);
  console.table(suspectInvoices);

  console.log('\n※このスクリプトは読み取りのみ。実際の修正(status差し戻し等)は行っていません。');
}

main().catch(e => { console.error(e); process.exit(1); });
