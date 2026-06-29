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

// テンプレートのセルに値を書き込む（既存スタイルを保持）
function setCell(ws, addr, value) {
  const t = typeof value === 'number' ? 'n' : 's';
  const v = value == null ? '' : value;
  if (ws[addr]) {
    ws[addr].v = v;
    ws[addr].t = t;
    delete ws[addr].w; // キャッシュ済みフォーマット文字列を削除
  } else {
    ws[addr] = { v, t };
  }
}

// 列インデックス（0始まり）からA1形式のセルアドレスを返す
function ca(colIndex, row1Based) {
  return XLSX.utils.encode_cell({ r: row1Based - 1, c: colIndex });
}

const COL = {
  A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9,
  K:10, L:11, M:12, N:13, O:14, P:15, Q:16, R:17, S:18, T:19,
  U:20, V:21, W:22, X:23, Y:24, Z:25, AA:26, AB:27,
};

function flightStr(arr, type) {
  const fields = type === 'arr'
    ? [arr.arr_date, arr.arr_airport, arr.arr_flight, arr.arr_time]
    : [arr.dep_date, arr.dep_airport, arr.dep_flight, arr.dep_time];
  return fields.filter(Boolean).join('  ');
}

function fmtDate(s) {
  return s ? s.replace(/-/g, '/') : '';
}

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

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

    // ── テンプレート読み込み ───────────────────────────────────────
    const templatePath = join(process.cwd(), 'public', 'haichisho_template.xlsx');
    const wb = XLSX.read(readFileSync(templatePath), { type: 'buffer', cellStyles: true });
    const ws = wb.Sheets[wb.SheetNames[0]];

    // ── ヘッダーセル書き込み ──────────────────────────────────────
    setCell(ws, 'A2', b.ref_no    || '');
    setCell(ws, 'G2', arr.bus_signboard_name || arr.bus_company_name || '');
    setCell(ws, 'O2', b.pax != null ? Number(b.pax) : '');
    setCell(ws, 'Z2', arr.guide_name || '');

    setCell(ws, 'A3', b.agent_name || '');
    setCell(ws, 'R3', flightStr(arr, 'arr'));
    setCell(ws, 'Z3', arr.guide_phone || '');

    setCell(ws, 'R4', flightStr(arr, 'dep'));

    // ── 日程データ（8行目〜、1日=2行）────────────────────────────
    const DATA_START = 8;

    days.forEach((d, i) => {
      const row = DATA_START + i * 2;

      const h = hotels.find(
        (x) => x.check_in && x.check_out && x.check_in <= d.day_date && x.check_out > d.day_date
      );
      const hotelName = h ? (h.hotel_name       || '') : (d.hotel_name       || '');
      const hotelArea = h ? (h.hotel_area        || '') : (d.hotel_area       || '');
      const hotelTel  = h ? (h.hotel_area_phone  || '') : (d.hotel_area_phone || '');

      const dow = d.day_of_week || (d.day_date
        ? DOW_JA[new Date(d.day_date).getDay()]
        : '');

      setCell(ws, ca(COL.A,  row), i + 1);
      setCell(ws, ca(COL.B,  row), `${fmtDate(d.day_date)} ${dow}`.trim());
      setCell(ws, ca(COL.C,  row), d.bus_company || arr.bus_company_name || '');
      setCell(ws, ca(COL.E,  row), d.itinerary         || '');
      setCell(ws, ca(COL.O,  row), d.others_notes      || '');
      setCell(ws, ca(COL.R,  row), hotelName);
      setCell(ws, ca(COL.S,  row), hotelArea);
      setCell(ws, ca(COL.T,  row), hotelTel);
      setCell(ws, ca(COL.U,  row), d.driver_info       || '');
      setCell(ws, ca(COL.V,  row), d.breakfast_type    || '');
      setCell(ws, ca(COL.W,  row), d.lunch_restaurant  || '');
      setCell(ws, ca(COL.X,  row), d.lunch_time        || '');
      setCell(ws, ca(COL.Y,  row), d.lunch_phone       || '');
      setCell(ws, ca(COL.Z,  row), d.dinner_restaurant || '');
      setCell(ws, ca(COL.AA, row), d.dinner_time       || '');
      setCell(ws, ca(COL.AB, row), d.dinner_phone      || '');
    });

    // シート範囲を必要に応じて拡張
    const lastDataRow = DATA_START + days.length * 2;
    const currentRef  = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    if (lastDataRow - 1 > currentRef.e.r) {
      currentRef.e.r = lastDataRow - 1;
      ws['!ref'] = XLSX.utils.encode_range(currentRef);
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
    const filename = `haichisho_${(b.ref_no || booking_id).replace(/[^A-Za-z0-9_-]/g, '_')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
