import XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join } from 'path';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

async function sbGet(table, qs = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Supabase ${table}: ${r.statusText}`);
  return r.json();
}

// セルに値を書き込む（既存スタイルを保持）
function set(ws, addr, value) {
  const t = typeof value === 'number' ? 'n' : 's';
  const v = value == null ? '' : value;
  if (ws[addr]) {
    ws[addr].v = v;
    ws[addr].t = t;
    delete ws[addr].w;
  } else {
    ws[addr] = { v, t };
  }
}

// ISO日付 → Excelシリアル値
function toSerial(isoStr) {
  if (!isoStr) return null;
  const [y, m, d] = isoStr.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

// "7:25" / "07:25:00" → Excel時刻シリアル値 (0〜1の小数)
function toTimeSerial(timeStr) {
  if (!timeStr) return null;
  const match = String(timeStr).match(/(\d+):(\d+)/);
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2])) / 1440;
}

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// シート内の日程行（A列=DAY番号整数 かつ B列=日付シリアル）を検索
function findDayRows(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const rows = [];
  for (let r = 0; r <= range.e.r; r++) {
    const aCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    const bCell = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (!aCell || !bCell) continue;
    const aVal = typeof aCell.v === 'string' ? parseInt(aCell.v, 10) : aCell.v;
    const bVal = bCell.v;
    if (Number.isInteger(aVal) && aVal >= 1 && aVal <= 60 &&
        typeof bVal === 'number' && bVal > 40000) {
      rows.push(r + 1); // 1始まり行番号
    }
  }
  return rows;
}

// ── F シート書き込み ────────────────────────────────────────────
function fillF(ws, b, arr, days, hotels) {
  // ヘッダー
  set(ws, 'A2',  b.ref_no    || '');
  set(ws, 'G2',  arr.bus_signboard_name || arr.nationality || '');
  set(ws, 'O2',  b.pax != null ? Number(b.pax) : '');
  set(ws, 'S2',  [arr.arr_date, arr.arr_airport, arr.arr_flight, arr.arr_time].filter(Boolean).join('  '));
  set(ws, 'Z2',  arr.guide_name  || '');
  set(ws, 'G5',  arr.travel_agency_name || b.agent_name || '');
  set(ws, 'S6',  [arr.dep_date, arr.dep_airport, arr.dep_flight, arr.dep_time].filter(Boolean).join('  '));
  set(ws, 'Z7',  arr.guide_phone || '');

  // 日程行検索（テンプレートの実際の位置を使用）
  const dayRows = findDayRows(ws);

  days.forEach((d, i) => {
    if (i >= dayRows.length) return; // テンプレート行数を超えた場合はスキップ
    const r = dayRows[i]; // 1始まり行番号

    const h = hotels.find(
      (x) => x.check_in && x.check_out && x.check_in <= d.day_date && x.check_out > d.day_date
    );
    const hotelName = h ? (h.hotel_name       || '') : (d.hotel_name       || '');
    const hotelArea = h ? (h.hotel_area        || '') : (d.hotel_area       || '');
    const hotelTel  = h ? (h.hotel_area_phone  || '') : (d.hotel_area_phone || '');
    const dow = d.day_of_week || (d.day_date ? DOW_JA[new Date(d.day_date).getDay()] : '');
    const serial = toSerial(d.day_date);

    // Row +0: メインデータ行
    set(ws, `A${r}`,     i + 1);          // DAY番号（マージセル起点）
    if (serial) set(ws, `B${r}`, serial); // 日付シリアル（マージセル起点）
    set(ws, `C${r}`,     d.bus_company    || arr.bus_company_name || '');
    set(ws, `E${r}`,     d.itinerary      || '');
    set(ws, `O${r}`,     d.others_notes   || '');
    set(ws, `R${r}`,     hotelName);
    set(ws, `X${r}`,     d.driver_info    || '');
    set(ws, `Z${r}`,     d.breakfast_type ? `B:${d.breakfast_type}` : '');

    // Row +2: 昼食行
    set(ws, `Z${r + 2}`, d.lunch_restaurant
      ? `L:${d.lunch_restaurant}${d.lunch_time ? '  ' + d.lunch_time : ''}`
      : '');

    // Row +4: 曜日・ホテル詳細・夕食行（B列マージセル起点）
    set(ws, `B${r + 4}`, `(${dow})`);
    set(ws, `R${r + 4}`, hotelArea);
    set(ws, `S${r + 4}`, hotelTel);
    set(ws, `Z${r + 4}`, d.dinner_restaurant
      ? `D:${d.dinner_restaurant}${d.dinner_time ? '  ' + d.dinner_time : ''}`
      : '');
  });
}

// ── ENG シート書き込み ──────────────────────────────────────────
function fillEng(ws, b, arr, days) {
  // ヘッダー
  set(ws, 'D1',  `${b.agent_name || ''}`);
  set(ws, 'J3',  b.ref_no        || '');
  set(ws, 'D4',  b.pax != null ? `${b.pax} PAX` : '');
  set(ws, 'F5',  arr.guide_name  || '');
  set(ws, 'J5',  arr.guide_phone || '');

  // ARR便（行6）
  const arrSerial  = toSerial(arr.arr_date);
  const arrTimeSer = toTimeSerial(arr.arr_time);
  if (arrSerial)   set(ws, 'E6', arrSerial);
  if (arr.arr_date) set(ws, 'F6', DOW_EN[new Date(arr.arr_date).getDay()]);
  if (arrTimeSer !== null) set(ws, 'G6', arrTimeSer);
  set(ws, 'H6',  arr.arr_flight  || '');
  set(ws, 'I6',  arr.arr_airport || '');

  // DEP便（行7）
  const depSerial  = toSerial(arr.dep_date);
  const depTimeSer = toTimeSerial(arr.dep_time);
  if (depSerial)   set(ws, 'E7', depSerial);
  if (arr.dep_date) set(ws, 'F7', DOW_EN[new Date(arr.dep_date).getDay()]);
  if (depTimeSer !== null) set(ws, 'G7', depTimeSer);
  set(ws, 'H7',  arr.dep_flight  || '');
  set(ws, 'I7',  arr.dep_airport || '');

  // 日程行: DAY番号と日付のみ更新（英語行程テキストはテンプレートを保持）
  const dayRows = findDayRows(ws);
  days.forEach((d, i) => {
    if (i >= dayRows.length) return;
    const r = dayRows[i];
    set(ws, `A${r}`, i + 1);
    const serial = toSerial(d.day_date);
    if (serial) set(ws, `B${r}`, serial);
  });
}

// ── ハンドラー ───────────────────────────────────────────────────
export default async function handler(req, res) {
  const { booking_id } = req.query;
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  try {
    const bookings = await sbGet('bookings', `?id=eq.${booking_id}&select=*`);
    const b = bookings[0];
    if (!b) return res.status(404).json({ error: '予約が見つかりません' });

    const arrs = await sbGet(
      'tour_arrangements',
      `?booking_ref=eq.${encodeURIComponent(b.ref_no)}&select=*&order=created_at.desc&limit=1`
    );
    const arr = arrs[0] || {};

    const [rawDays, hotels] = await Promise.all([
      arr.id
        ? sbGet('tour_arrangement_days', `?arrangement_id=eq.${arr.id}&select=*&order=day_date.asc`)
        : Promise.resolve([]),
      sbGet('booking_hotels', `?booking_id=eq.${booking_id}&select=*&order=check_in.asc`),
    ]);

    // tour_arrangement_daysが空の場合、booking_hotelsから日付を生成
    let days = rawDays;
    if (!days.length && hotels.length) {
      const dateSet = new Set();
      hotels.forEach((h) => {
        if (h.check_in && h.check_out) {
          let d = new Date(h.check_in);
          const end = new Date(h.check_out);
          while (d < end) {
            dateSet.add(d.toISOString().slice(0, 10));
            d = new Date(d.getTime() + 86400000);
          }
        }
      });
      days = Array.from(dateSet).sort().map((dateStr) => ({ day_date: dateStr }));
    }

    // テンプレート読み込み
    const templatePath = join(process.cwd(), 'public', 'haichisho_template.xlsx');
    const wb = XLSX.read(readFileSync(templatePath), { type: 'buffer', cellStyles: true });

    // F シートに書き込み
    const fSheet = wb.Sheets['F'];
    if (fSheet) fillF(fSheet, b, arr, days, hotels);

    // ENG シートに書き込み
    const engSheet = wb.Sheets['ENG'];
    if (engSheet) fillEng(engSheet, b, arr, days);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
    const filename = `haichisho_${(b.ref_no || booking_id).replace(/[^A-Za-z0-9_-]/g, '_')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
