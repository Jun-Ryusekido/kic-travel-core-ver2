// 1回限りのデータ移行スクリプト: 予約 #1153 (KIC1153_KK) の実データ入り手配書サンプル
// templates/tehaisho_sample.xlsx (シート「狩野(1)」=津﨑美帆担当分、「狩野(2)」=SAHDEV VIJAY KUMAR担当分。
// 「Life(1)/Life(2)」「1(1)/1(2)」は内容が同一の重複コピーのため使用しない) を読み込み、
// 以下の2箇所にデータを投入する。
//
//   1. 共通ドラフト(tour_arrangement_headers/tour_guides/tour_day_itinerary/tour_arrangement_notes)
//      … 狩野(1)（津﨑美帆担当分）の内容をベースに投入する。
//   2. ガイド別手配書(arrangement_documents/arrangement_document_days/arrangement_document_notes)
//      … booking_guides に既に登録済みの津﨑美帆・SAHDEV VIJAY KUMARの各行に対して、
//        それぞれのシート(狩野(1)/狩野(2))の内容をそのまま投入する。
//        (2日目終盤〜最終日の行程・食事時刻は両ガイドで実際に異なるため、
//         共通ドラフトの単純コピーでは再現できず、シートごとに個別投入する必要がある)
//
// 前提:
//   - scripts/create_arrangement_documents_tables.sql を実行済みであること
//   - Supabase側でテーブル作成後、PostgRESTのスキーマキャッシュがリロードされていること
//     (リロードされていない場合、arrangement_documents等へのアクセスで
//      "Could not find the table ... in the schema cache" エラーになる。
//      SQL Editorで `NOTIFY pgrst, 'reload schema';` を実行するか、
//      ダッシュボードの Settings → API → Reload schema cache を押すこと)
//   - booking_guides に対象予約(#1153)の津﨑美帆・SAHDEV VIJAY KUMARの行が
//     既に登録済みであること(担当ガイドタブから登録済みの前提)
//
// 冪等性: 既にtour_day_itinerary/arrangement_documentsにデータがある場合は
//   二重投入を避けるため、対象ごとにスキップする(--force で強制上書き可能)。
//
// 実行方法: node scripts/import_kic1153_tehaisho.js [--force]

const path = require('path');
const ExcelJS = require('exceljs');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';
const FORCE = process.argv.includes('--force');

const REF_NO_LIKE = '%1153%';
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'tehaisho_sample.xlsx');
const SHEET_GUIDE1 = '狩野(1)'; // 津﨑美帆
const SHEET_GUIDE2 = '狩野(2)'; // SAHDEV VIJAY KUMAR
const GUIDE1_NAME_HINT = '津﨑';
const GUIDE2_NAME_HINT = 'VIJAY';

const HEADER_ROWS = 10;
const BLOCK_START = 11;
const BLOCK_ROWS = 6;

function sbHeaders(extra) {
  return Object.assign({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, extra || {});
}
async function sbSelect(table, qs) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`SELECT ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(table, rows) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`INSERT ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbUpsert(table, rows, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`UPSERT ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbDelete(table, qs) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { method: 'DELETE', headers: sbHeaders() });
  if (!r.ok) throw new Error(`DELETE ${table} failed: ${r.status} ${await r.text()}`);
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.result !== undefined) return cellText(v.result);
  }
  return v;
}
function toPlainText(v) {
  const t = cellText(v);
  return t instanceof Date ? '' : String(t || '').trim();
}
function toDateOnlyStr(v) {
  const t = cellText(v);
  if (t instanceof Date) return t.toISOString().slice(0, 10);
  return null;
}
function toTimeStr(v) {
  const t = cellText(v);
  if (t instanceof Date) {
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  const s = String(t || '').trim();
  return (s === '' || s === '---') ? '' : s;
}
function parsePax(raw) {
  const s = toPlainText(raw).replace(/[\s　]/g, '');
  const m = s.match(/^(\d+)名(?:\+(\d+))?/);
  return { adult: m ? Number(m[1]) : 0, child: m && m[2] ? Number(m[2]) : 0 };
}
function parseFlightLine(raw, refYear) {
  const s = toPlainText(raw);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\S+)\s+(\S+)\s+([\d:]+)$/);
  if (!m) return { date: null, airport: '', flight: '', time: '' };
  const [, mo, da, airport, flight, time] = m;
  const date = `${refYear}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  return { date, airport, flight, time };
}
function stripMealPrefix(raw) {
  const s = toPlainText(raw);
  const m = s.match(/^[BLD]:(.*)$/);
  const name = m ? m[1].trim() : s;
  return (name === 'X' || name === '---' || name === '') ? '' : name;
}

// シート1枚から、共通ドラフト/ガイド別手配書の両方に使える形の
// {header, days:[...], notes:{...}} を抽出する。
function parseSheet(ws, refYear) {
  const g = (col, row) => ws.getCell(`${col}${row}`).value;

  const nationality = toPlainText(g('G', 2)).replace(/^国籍：/, '');
  const bus_signage_name = toPlainText(g('G', 5));
  const pax = parsePax(g('O', 2));
  const arr = parseFlightLine(g('S', 2), refYear);
  const dep = parseFlightLine(g('S', 6), refYear);

  const days = [];
  let row = BLOCK_START;
  // A列が数値(Day番号)である間、6行ブロックとして読み進める。フッター(A列がテキスト見出し)に来たら終了。
  while (true) {
    const dayNoRaw = g('A', row);
    if (typeof dayNoRaw !== 'number') break;
    const hotelNameRaw = toPlainText(g('R', row));
    days.push({
      day_no: dayNoRaw,
      date: toDateOnlyStr(g('B', row)),
      bus_company_text: toPlainText(g('C', row)),
      itinerary_text: toPlainText(g('E', row)),
      others_text: toPlainText(g('O', row)),
      hotel_name: (hotelNameRaw === 'DEP') ? '' : hotelNameRaw,
      hotel_phone: '',
      hotel_note: toPlainText(g('X', row)).replace(/\t/g, '').trim(),
      breakfast_text: stripMealPrefix(g('Z', row)),
      breakfast_time: toTimeStr(g('AC', row)),
      breakfast_phone: toPlainText(g('AE', row)),
      lunch_text: stripMealPrefix(g('Z', row + 2)),
      lunch_time: toTimeStr(g('AC', row + 2)),
      lunch_phone: toPlainText(g('AE', row + 2)),
      dinner_text: stripMealPrefix(g('Z', row + 4)),
      dinner_time: toTimeStr(g('AC', row + 4)),
      dinner_phone: toPlainText(g('AE', row + 4)),
      departure_time: '',
    });
    row += BLOCK_ROWS;
  }
  const footerStart = row;
  const fixedLines = [];
  for (let i = 0; i < 4; i++) {
    const t = toPlainText(g('A', footerStart + i));
    if (t) fixedLines.push(t);
  }
  const driverParts = [];
  const busCompanyCell = toPlainText(g('C', footerStart + 4));
  const secondCompanyCell = toPlainText(g('J', footerStart + 4));
  if (busCompanyCell) driverParts.push(busCompanyCell);
  if (secondCompanyCell) driverParts.push(secondCompanyCell);
  const waterLines = [];
  for (let i = 7; i <= 8; i++) {
    const t = toPlainText(g('A', footerStart + i));
    if (t) waterLines.push(t);
  }

  return {
    header: {
      bus_signage_name, nationality,
      pax_adult: pax.adult, pax_child: pax.child, pax_note: '',
      arr_date: arr.date, arr_airport: arr.airport, arr_flight: arr.flight, arr_time: arr.time,
      dep_date: dep.date, dep_airport: dep.airport, dep_flight: dep.flight, dep_time: dep.time,
    },
    days,
    notes: {
      fixed_template: fixedLines.join('\n'),
      driver_info: driverParts.join(' / '),
      tour_specific: '',
      mineral_water: waterLines.join('\n'),
    },
  };
}

async function main() {
  console.log('=== 予約#1153 手配書サンプルインポート ===');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws1 = wb.getWorksheet(SHEET_GUIDE1);
  const ws2 = wb.getWorksheet(SHEET_GUIDE2);
  if (!ws1 || !ws2) throw new Error(`シートが見つかりません: ${SHEET_GUIDE1} / ${SHEET_GUIDE2}`);

  const bookings = await sbSelect('bookings', `select=id,ref_no,tour_name,in_date&ref_no=ilike.${encodeURIComponent(REF_NO_LIKE)}`);
  if (bookings.length !== 1) throw new Error(`予約が一意に特定できません(${bookings.length}件): ${JSON.stringify(bookings)}`);
  const booking = bookings[0];
  const refYear = booking.in_date ? Number(booking.in_date.slice(0, 4)) : new Date().getFullYear();
  console.log(`対象予約: ${booking.ref_no} / ${booking.tour_name} / id=${booking.id}`);

  const guideRows = await sbSelect('booking_guides', `select=id,guide_id,guide_name_freetext&booking_id=eq.${booking.id}`);
  const guideIds = guideRows.filter(r => r.guide_id).map(r => r.guide_id);
  const guidesMaster = guideIds.length
    ? await sbSelect('guides', `select=id,name,phone&id=in.(${guideIds.join(',')})`)
    : [];
  const resolveGuide = (row) => {
    if (row.guide_id) {
      const m = guidesMaster.find(x => x.id === row.guide_id);
      return { name: m ? m.name : '', phone: m ? (m.phone || '') : '' };
    }
    return { name: row.guide_name_freetext || '', phone: '' };
  };
  const guide1Row = guideRows.find(r => resolveGuide(r).name.includes(GUIDE1_NAME_HINT));
  const guide2Row = guideRows.find(r => resolveGuide(r).name.includes(GUIDE2_NAME_HINT));
  if (!guide1Row || !guide2Row) {
    throw new Error(`booking_guidesに対象の2名が見つかりません（担当ガイドタブで登録済みか確認してください）。取得件数=${guideRows.length}`);
  }
  console.log(`ガイド1(${SHEET_GUIDE1}): ${resolveGuide(guide1Row).name} (booking_guide_id=${guide1Row.id})`);
  console.log(`ガイド2(${SHEET_GUIDE2}): ${resolveGuide(guide2Row).name} (booking_guide_id=${guide2Row.id})`);

  const data1 = parseSheet(ws1, refYear);
  const data2 = parseSheet(ws2, refYear);
  console.log(`日毎明細: ガイド1=${data1.days.length}日分, ガイド2=${data2.days.length}日分`);

  // tour_day_itinerary(共通ドラフト)には hotel_name というテキスト列が無く、代わりに
  // hotel_booking_id(booking_hotelsへのFK)を使う設計になっている。今回はFKで結び付けられる
  // 実データが無い(自由記述のホテル名しか無い)ため、ホテル名はhotel_noteの先頭に
  // テキストとして書き添える(hotel_booking_idはnullのまま)。
  // ※ arrangement_document_days側は元々hotel_nameという専用のテキスト列を持つため、
  //   この変換は不要(data1.days/data2.daysをそのまま使う)。
  function toCommonDraftDay(d) {
    const hotelLine = d.hotel_name ? `[ホテル: ${d.hotel_name}]` : '';
    const hotel_note = [hotelLine, d.hotel_note].filter(Boolean).join(' ');
    return {
      day_no: d.day_no, date: d.date, bus_company_text: d.bus_company_text,
      itinerary_text: d.itinerary_text, others_text: d.others_text,
      hotel_booking_id: null, hotel_note,
      breakfast_text: d.breakfast_text, breakfast_time: d.breakfast_time, breakfast_phone: d.breakfast_phone,
      lunch_restaurant_booking_id: null, lunch_text: d.lunch_text, lunch_time: d.lunch_time, lunch_phone: d.lunch_phone,
      dinner_restaurant_booking_id: null, dinner_text: d.dinner_text, dinner_time: d.dinner_time, dinner_phone: d.dinner_phone,
      departure_time: d.departure_time || null,
    };
  }

  // ── 1. 共通ドラフトへの投入(狩野(1)＝津﨑美帆担当分をベースにする) ──
  const existingHeader = await sbSelect('tour_arrangement_headers', `select=id&booking_id=eq.${booking.id}`);
  const existingDays = await sbSelect('tour_day_itinerary', `select=id&booking_id=eq.${booking.id}`);
  if ((existingHeader.length || existingDays.length) && !FORCE) {
    console.log('共通ドラフトに既存データがあるためスキップします(--forceで上書き可能)。');
  } else {
    if (FORCE) {
      if (existingDays.length) await sbDelete('tour_day_itinerary', `booking_id=eq.${booking.id}`);
      if (existingHeader.length) await sbDelete('tour_arrangement_headers', `booking_id=eq.${booking.id}`);
      await sbDelete('tour_guides', `booking_id=eq.${booking.id}`);
      await sbDelete('tour_arrangement_notes', `booking_id=eq.${booking.id}`);
    }
    await sbInsert('tour_arrangement_headers', [Object.assign({ booking_id: booking.id, status: 'draft', revision_no: 0 }, data1.header)]);
    await sbInsert('tour_guides', [guide1Row, guide2Row].map((row, i) => {
      const gi = resolveGuide(row);
      return { booking_id: booking.id, guide_id: row.guide_id || null, guide_name_freetext: row.guide_id ? '' : gi.name, phone: gi.phone, start_date: null, display_order: i };
    }));
    await sbInsert('tour_day_itinerary', data1.days.map(d => Object.assign({ booking_id: booking.id }, toCommonDraftDay(d))));
    await sbInsert('tour_arrangement_notes', [
      { booking_id: booking.id, note_type: 'fixed_template', content: data1.notes.fixed_template, display_order: 0 },
      { booking_id: booking.id, note_type: 'mineral_water', content: data1.notes.mineral_water, display_order: 1 },
      { booking_id: booking.id, note_type: 'driver_info', content: data1.notes.driver_info, display_order: 2 },
      { booking_id: booking.id, note_type: 'tour_specific', content: data1.notes.tour_specific, display_order: 3 },
    ]);
    console.log('共通ドラフトに投入しました。');
  }

  // ── 2. ガイド別手配書への投入(ガイドごとに実データを個別投入) ──
  // 要 arrangement_documents 系テーブルのPostgRESTスキーマキャッシュのリロード。
  const guideDocTargets = [
    { guideRow: guide1Row, data: data1 },
    { guideRow: guide2Row, data: data2 },
  ];
  for (const { guideRow, data } of guideDocTargets) {
    const gi = resolveGuide(guideRow);
    const existingDoc = await sbSelect('arrangement_documents', `select=id&booking_guide_id=eq.${guideRow.id}`).catch(e => {
      throw new Error(`arrangement_documentsへのアクセスに失敗しました。PostgRESTのスキーマキャッシュがリロードされていない可能性があります: ${e.message}`);
    });
    let docId;
    if (existingDoc.length && !FORCE) {
      console.log(`${gi.name}: 手配書が既に存在するためスキップします(--forceで上書き可能)。`);
      continue;
    }
    if (existingDoc.length && FORCE) {
      docId = existingDoc[0].id;
      await sbDelete('arrangement_document_days', `arrangement_document_id=eq.${docId}`);
      await sbDelete('arrangement_document_notes', `arrangement_document_id=eq.${docId}`);
      await sbSelect('arrangement_documents', `id=eq.${docId}`); // no-op just to keep flow readable
      await fetch(`${SB_URL}/rest/v1/arrangement_documents?id=eq.${docId}`, {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(Object.assign({ guide_name_snapshot: gi.name, guide_phone_snapshot: gi.phone }, data.header)),
      });
    } else {
      const inserted = await sbInsert('arrangement_documents', [Object.assign({
        booking_id: booking.id, booking_guide_id: guideRow.id,
        guide_name_snapshot: gi.name, guide_phone_snapshot: gi.phone,
        status: 'draft', revision_no: 0,
      }, data.header)]);
      docId = inserted[0].id;
    }
    await sbInsert('arrangement_document_days', data.days.map(d => Object.assign({ arrangement_document_id: docId }, d)));
    await sbInsert('arrangement_document_notes', [
      { arrangement_document_id: docId, note_type: 'fixed_template', content: data.notes.fixed_template, display_order: 0 },
      { arrangement_document_id: docId, note_type: 'mineral_water', content: data.notes.mineral_water, display_order: 1 },
      { arrangement_document_id: docId, note_type: 'driver_info', content: data.notes.driver_info, display_order: 2 },
      { arrangement_document_id: docId, note_type: 'tour_specific', content: data.notes.tour_specific, display_order: 3 },
    ]);
    console.log(`${gi.name}: ガイド別手配書を作成しました(id=${docId})。`);
  }

  console.log('=== 完了 ===');
}

main().catch(e => { console.error('失敗:', e.message); process.exit(1); });
