// 【実行に必要な環境変数】SUPABASE_SERVICE_ROLE_KEY(必須。anonキーでは実行できない)
//   値の取得: Supabase管理画面 > Project Settings > API Keys > service_role(secret)
//   設定・実行(PowerShell): $env:SUPABASE_SERVICE_ROLE_KEY="<実際のキー>"; node scripts/progress_dryrun.js
//   キーはファイルに書かずコミットしないこと。
// 予約の進捗判定(public/js/booking-progress.js)を全予約に適用するドライラン。
// 読み取り専用(GETのみ。INSERT/UPDATE/DELETEは一切発行しない)。DBスキーマ・データは変更しない。
// 出力: scripts/data/progress_dryrun_summary.json(件数とREF#のみ。個人名・金額明細は含めない)
//
// 取得は全テーブルを1000行ずつページング(offset/limit + order=id)し、Prefer: count=exact の総件数と
// 取得件数が一致することを検証する。1つでも不一致なら集計を出さず、理由を表示して終了する。

const fs = require('fs');
const path = require('path');
const BP = require('../public/js/booking-progress.js');

const SB_URL = process.env.SUPABASE_URL || 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SB_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEYが未設定です。ファイル冒頭の【実行に必要な環境変数】の手順で設定してから再実行してください。');
  process.exit(1);
}
const PAGE = 1000;
const MAX_REF_LIST = 30;

// 1テーブルを全件取得する。戻り値 { rows, total }。取得件数 != total ならthrow。
async function fetchAll(table, select, extraQuery) {
  let rows = [];
  let total = null;
  let offset = 0;
  while (true) {
    const url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${extraQuery ? '&' + extraQuery : ''}&order=id.asc&offset=${offset}&limit=${PAGE}`;
    const res = await fetch(url, {
      method: 'GET', // 読み取り専用
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact' },
    });
    if (!res.ok) throw new Error(`${table} の取得に失敗: HTTP ${res.status} ${await res.text()}`);
    const cr = res.headers.get('content-range'); // 例: "0-999/1234" または "*/0"
    const m = /\/(\d+)$/.exec(cr || '');
    if (!m) throw new Error(`${table}: content-range から総件数を読み取れません(${cr})`);
    const t = Number(m[1]);
    if (total !== null && t !== total) throw new Error(`${table}: 取得中に総件数が変化しました(${total} → ${t})。再実行してください`);
    total = t;
    const data = await res.json();
    rows = rows.concat(data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  if (rows.length !== total) {
    throw new Error(`${table}: 取得件数(${rows.length})が総件数 count=exact(${total})と一致しません`);
  }
  return { rows, total };
}

function groupBy(rows, key) {
  const m = new Map();
  rows.forEach(r => { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return m;
}
function inc(obj, k, n) { obj[k] = (obj[k] || 0) + (n === undefined ? 1 : n); }

async function main() {
  const checks = {};
  const load = async (name, table, select, extra) => {
    const r = await fetchAll(table, select, extra);
    checks[name] = { table, fetched: r.rows.length, count_exact: r.total, match: r.rows.length === r.total };
    console.log(`取得 ${table}: ${r.rows.length}件 (count=exact ${r.total})`);
    return r.rows;
  };
  let bookings, sales, invoices, hotels, buses, estimations, headers, docs;
  try {
    bookings = await load('bookings', 'bookings', 'id,ref_no,status');
    sales = await load('booking_sales', 'booking_sales', 'id,booking_id,amount,payments');
    invoices = await load('invoices', 'invoices', 'id,booking_id,status');
    hotels = await load('booking_hotels', 'booking_hotels', 'id,booking_id,status');
    buses = await load('booking_buses', 'booking_buses', 'id,booking_id,status');
    estimations = await load('estimations', 'estimations', 'id,converted_booking_id', 'converted_booking_id=not.is.null');
    headers = await load('tour_arrangement_headers', 'tour_arrangement_headers', 'id,booking_id');
    docs = await load('arrangement_documents', 'arrangement_documents', 'id,booking_id,status');
  } catch (e) {
    console.error('\n[中止] ' + e.message);
    console.error('件数が合わないため集計は出力しません。上のメッセージをClaudeに貼ってください。');
    process.exit(2);
  }

  const salesBy = groupBy(sales, 'booking_id');
  const invBy = groupBy(invoices, 'booking_id');
  const hotelBy = groupBy(hotels, 'booking_id');
  const busBy = groupBy(buses, 'booking_id');
  const estSet = new Set(estimations.map(e => e.converted_booking_id));
  const headerSet = new Set(headers.map(h => h.booking_id));
  const docBy = groupBy(docs, 'booking_id');

  const bookingIds = new Set(bookings.map(b => b.id));
  const orphan = {
    booking_sales: sales.filter(r => !bookingIds.has(r.booking_id)).length,
    invoices: invoices.filter(r => !bookingIds.has(r.booking_id)).length,
    booking_hotels: hotels.filter(r => !bookingIds.has(r.booking_id)).length,
    booking_buses: buses.filter(r => !bookingIds.has(r.booking_id)).length,
  };

  const stageStates = {};
  BP.STAGE_KEYS.forEach(k => { stageStates[k] = { done: 0, progress: 0, todo: 0, alert: 0, na: 0 }; });
  const reasonCounts = {};
  const reasonRefs = {};
  const addRef = (code, ref) => {
    if (!reasonRefs[code]) reasonRefs[code] = [];
    if (reasonRefs[code].length < MAX_REF_LIST) reasonRefs[code].push(ref);
  };
  let cancelled = 0, needsAttention = 0, cancelOnlyArrangement = 0;
  let arrNgPresent = 0, arrCancelPresent = 0;
  let overpaidTotalYen = 0;
  const hotelStatusHist = {}, busStatusHist = {}, unknownStatuses = {};
  let invoiceStatusHist = {};
  // 参考: 10/6点検(キャンセル予約を除外しない集計)と比べるため、キャンセルを除外しない入金判定も数える
  const refCompare = { overpaid: 0, sales_zero_with_payment: 0 };

  invoices.forEach(i => inc(invoiceStatusHist, i.status == null ? '(null)' : i.status));
  hotels.forEach(h => inc(hotelStatusHist, h.status == null ? '(null)' : h.status));
  buses.forEach(b => inc(busStatusHist, b.status == null ? '(null)' : b.status));
  [...hotels, ...buses].forEach(r => {
    if (BP.normalizeArrangementStatus(r.status) === null) inc(unknownStatuses, r.status);
  });

  bookings.forEach(b => {
    const salesRows = salesBy.get(b.id) || [];
    const salesTotal = salesRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const paidTotal = salesRows.reduce((s, r) =>
      s + (Array.isArray(r.payments) ? r.payments.reduce((x, p) => x + (Number(p && p.amount) || 0), 0) : 0), 0);
    const activeInvoiceCount = (invBy.get(b.id) || []).filter(i => i.status !== 'void').length;
    const input = {
      booking: { status: b.status },
      hasEstimation: estSet.has(b.id),
      hotels: (hotelBy.get(b.id) || []).map(r => ({ status: r.status })),
      buses: (busBy.get(b.id) || []).map(r => ({ status: r.status })),
      activeInvoiceCount, salesTotal, paidTotal,
    };
    const res = BP.judgeBookingProgress(input);

    // 参考比較用(キャンセルを除外せず入金だけ判定)
    const payNoCancel = BP.judgePayment(salesTotal, paidTotal);
    payNoCancel.reasons.forEach(r => { if (r.code in refCompare) refCompare[r.code]++; });

    if (res.cancelled) { cancelled++; }
    BP.STAGE_KEYS.forEach(k => { stageStates[k][res.stages[k].state]++; });
    if (res.needsAttention) needsAttention++;
    res.reasons.forEach(r => {
      inc(reasonCounts, r.code);
      addRef(r.code, b.ref_no);
    });
    const codes = res.reasons.map(r => r.code);
    if (codes.includes('arr_ng')) arrNgPresent++;
    if (codes.includes('arr_cancel')) arrCancelPresent++;
    if (codes.includes('arr_cancel') && !codes.includes('arr_ng')) { cancelOnlyArrangement++; addRef('arr_cancel_only', b.ref_no); }
    if (codes.includes('overpaid')) overpaidTotalYen += Math.max(0, paidTotal - salesTotal);
    // 複数理由を持つ予約(要確認が2種類以上)の件数も把握する
    if (res.reasons.length > 1) inc(reasonCounts, '_multiple_reasons');
  });

  const docCandidates = {
    bookings_with_tour_arrangement_headers: bookings.filter(b => headerSet.has(b.id)).length,
    bookings_with_arrangement_documents: bookings.filter(b => docBy.has(b.id)).length,
    // 参考: arrangement_documents.status = 'final'(確定) の予約数
    bookings_with_arrangement_documents_final: bookings.filter(b => (docBy.get(b.id) || []).some(d => d.status === 'final')).length,
    arrangement_documents_status_histogram: (() => { const h = {}; docs.forEach(d => inc(h, d.status == null ? '(null)' : d.status)); return h; })(),
  };

  const summary = {
    generated_at: new Date().toISOString(),
    note: '読み取り専用ドライラン。件数とREF#のみ(個人名・金額明細なし)。',
    fetch_verification: { all_match: Object.values(checks).every(c => c.match), tables: checks },
    totals: { bookings: bookings.length, cancelled, needs_attention: needsAttention },
    stage_states: stageStates,
    attention_reason_counts: reasonCounts,
    attention_reason_notes: {
      arr_ng: '手配: NG回答あり', arr_cancel: '手配: キャンセルあり(NG回答との併発を含む)',
      arr_cancel_only: '手配: キャンセル行だけが理由(NG回答なし)の予約',
      overpaid: '入金が売上を超過', sales_zero_with_payment: '売上0円で入金あり', sales_negative: '売上がマイナス',
      _multiple_reasons: '要確認の理由を2種類以上持つ予約',
    },
    arrangement_requires_attention_breakdown: {
      ng_present: arrNgPresent, cancel_present: arrCancelPresent, cancel_only: cancelOnlyArrangement,
    },
    overpaid_total_yen: Math.round(overpaidTotalYen),
    reference_10_06_comparable_without_cancel_exclusion: refCompare,
    reference_10_06: { overpaid_bookings_approx: 56, overpaid_total_yen_approx: 105000000, sales_zero_with_payment_approx: 30 },
    ref_numbers_by_reason: reasonRefs,
    document_candidates: docCandidates,
    data_quality: {
      orphan_rows_without_booking: orphan,
      hotel_status_histogram: hotelStatusHist,
      bus_status_histogram: busStatusHist,
      unknown_arrangement_status_values: unknownStatuses,
      invoice_status_histogram: invoiceStatusHist,
    },
  };

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'progress_dryrun_summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n出力しました: ' + outPath);
  console.log(JSON.stringify({ totals: summary.totals, stage_states: stageStates, attention_reason_counts: reasonCounts }, null, 2));
}

main().catch(e => { console.error('[エラー] ' + e.message); process.exit(1); });
