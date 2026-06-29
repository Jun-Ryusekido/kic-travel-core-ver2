import * as XLSX from 'xlsx';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

async function sbGet(table, qs = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Supabase ${table}: ${r.statusText}`);
  return r.json();
}

function cell(ws, addr, value) {
  const t = typeof value === 'number' ? 'n' : 's';
  ws[addr] = { v: value == null ? '' : value, t };
}

export default async function handler(req, res) {
  const { booking_id, type = 'initial' } = req.query;
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  try {
    // ── 1. booking ──────────────────────────────────────────────
    const bookings = await sbGet('bookings', `?id=eq.${booking_id}&select=*`);
    const b = bookings[0];
    if (!b) return res.status(404).json({ error: '予約が見つかりません' });

    // ── 2. tour_arrangements (最新1件) ──────────────────────────
    const arrs = await sbGet(
      'tour_arrangements',
      `?booking_ref=eq.${encodeURIComponent(b.ref_no)}&select=*&order=created_at.desc&limit=1`
    );
    const arr = arrs[0] || {};

    // ── 3. tour_arrangement_days ─────────────────────────────────
    let days = [];
    if (arr.id) {
      days = await sbGet(
        'tour_arrangement_days',
        `?arrangement_id=eq.${arr.id}&select=*&order=day_date.asc`
      );
    }

    // ── 4. booking_hotels ────────────────────────────────────────
    const hotels = await sbGet(
      'booking_hotels',
      `?booking_id=eq.${booking_id}&select=*&order=check_in.asc`
    );

    // ── Excel 構築 ───────────────────────────────────────────────
    const ws = {};

    // ヘッダー行
    const typeLabel = type === 'final' ? '【FINAL】' : '【INITIAL】';
    cell(ws, 'A1', `手配書 ${typeLabel}`);

    // 固定セル
    cell(ws, 'A2', b.ref_no || '');               // ツアーコード
    cell(ws, 'G3', arr.bus_company_name || '');    // バス看板名
    cell(ws, 'O2', b.pax != null ? Number(b.pax) : ''); // PAX数
    cell(ws, 'S2', arr.arr_flight || '');          // ARRフライト
    cell(ws, 'S6', arr.dep_flight || '');          // DEPフライト
    cell(ws, 'Z2', arr.guide_name || '');          // ガイド名
    cell(ws, 'Z5', arr.guide_phone || '');         // ガイド電話番号

    // 補足ヘッダー情報（参考）
    cell(ws, 'A3', `ツアー名: ${b.tour_name || ''}`);
    cell(ws, 'A4', `エージェント: ${b.agent_name || ''}`);
    cell(ws, 'A5', `PAX: ${b.pax || ''}名 (大人:${b.pax_adult||0} 子供:${b.pax_child||0} 乳幼児:${b.pax_infant||0})`);
    cell(ws, 'A6', `IN: ${b.in_date || ''}`);
    cell(ws, 'A7', `OUT: ${b.out_date || ''}`);
    cell(ws, 'A8', `ARR便: ${arr.arr_flight||''} ${arr.arr_airport||''} ${arr.arr_date||''} ${arr.arr_time||''}`);
    cell(ws, 'A9', `DEP便: ${arr.dep_flight||''} ${arr.dep_airport||''} ${arr.dep_date||''} ${arr.dep_time||''}`);
    cell(ws, 'A10', `バス会社: ${arr.bus_company_name||''} ${arr.bus_company_contact||''}`);
    cell(ws, 'A11', `ガイド: ${arr.guide_name||''} ${arr.guide_phone||''}`);

    // 日程行（14行目以降）
    const DAY_START = 14;
    cell(ws, `A${DAY_START - 1}`, '日付');
    cell(ws, `B${DAY_START - 1}`, '曜日');
    cell(ws, `C${DAY_START - 1}`, 'バス会社');
    cell(ws, `D${DAY_START - 1}`, '行程');
    cell(ws, `R${DAY_START - 1}`, 'ホテル');
    cell(ws, `S${DAY_START - 1}`, 'エリア');
    cell(ws, `T${DAY_START - 1}`, '朝食');

    days.forEach((d, i) => {
      const row = DAY_START + i;
      // booking_hotelsからその日に該当するホテルを照合（check_in<=day_date && check_out>day_date）
      const hForDay = hotels.find(h => h.check_in && h.check_out && h.check_in <= d.day_date && h.check_out > d.day_date);
      const hotelName = hForDay ? hForDay.hotel_name : (d.hotel_name || '');

      cell(ws, `A${row}`, d.day_date || '');
      cell(ws, `B${row}`, d.day_of_week || '');
      // C列: バス会社 (finalのみ入力。initialは空欄)
      cell(ws, `C${row}`, type === 'final' ? (d.bus_company || arr.bus_company_name || '') : '');
      cell(ws, `D${row}`, d.itinerary || '');
      cell(ws, `R${row}`, hotelName);                // R列: ホテル名
      cell(ws, `S${row}`, d.hotel_area || '');
      cell(ws, `T${row}`, d.breakfast_type || '');
    });

    // シート範囲
    const lastRow = Math.max(DAY_START + days.length, DAY_START);
    ws['!ref'] = `A1:Z${lastRow}`;

    // 列幅設定
    ws['!cols'] = [
      { wch: 12 }, // A
      { wch: 4 },  // B
      { wch: 18 }, // C バス会社
      { wch: 30 }, // D 行程
      ...Array(13).fill({ wch: 6 }),  // E-Q
      { wch: 22 }, // R ホテル
      { wch: 12 }, // S
      { wch: 8 },  // T
      { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, // U-Y
      { wch: 16 }, // Z
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '手配書');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `haichisho_${(b.ref_no || booking_id).replace(/[^A-Za-z0-9_-]/g, '_')}_${type}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
