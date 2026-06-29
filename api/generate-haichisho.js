import XLSX from 'xlsx';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

async function sbGet(table, qs = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Supabase ${table}: ${r.statusText}`);
  return r.json();
}

const FONT = 'Meiryo';
const S_BOLD  = { font: { bold: true, name: FONT, sz: 10 } };
const S_LABEL = { font: { bold: true, name: FONT, sz: 9 }, fill: { patternType: 'solid', fgColor: { rgb: 'C5D9F1' } } };
const S_TH    = { font: { bold: true, name: FONT, sz: 9 }, fill: { patternType: 'solid', fgColor: { rgb: 'BDD7EE' } }, alignment: { horizontal: 'center', wrapText: true } };
const S_GRAY  = { font: { name: FONT, sz: 9 }, fill: { patternType: 'solid', fgColor: { rgb: 'EEEEEE' } }, alignment: { wrapText: true, vertical: 'top' } };
const S_WHITE = { font: { name: FONT, sz: 9 }, alignment: { wrapText: true, vertical: 'top' } };

function c(ws, addr, value, style) {
  const t = typeof value === 'number' ? 'n' : 's';
  const cell = { v: value == null ? '' : value, t };
  if (style) cell.s = style;
  ws[addr] = cell;
}

function flight(arr, type) {
  const f = type === 'arr'
    ? [arr.arr_flight, arr.arr_airport, arr.arr_date, arr.arr_time]
    : [arr.dep_flight, arr.dep_airport, arr.dep_date, arr.dep_time];
  return f.filter(Boolean).join('  ');
}

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

    const [days, hotels] = await Promise.all([
      arr.id
        ? sbGet('tour_arrangement_days', `?arrangement_id=eq.${arr.id}&select=*&order=day_date.asc`)
        : Promise.resolve([]),
      sbGet('booking_hotels', `?booking_id=eq.${booking_id}&select=*&order=check_in.asc`),
    ]);

    const ws = {};

    // ═══════════════════════════════════════════════════════════════
    // 行 1: ラベル行
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A1', 'Tour Code',          S_LABEL);
    c(ws, 'G1', 'バス看板名',          S_LABEL);
    c(ws, 'O1', 'No. PAX',            S_LABEL);
    c(ws, 'S1', 'Flight Information', S_LABEL);
    c(ws, 'Z1', 'Guide',              S_LABEL);

    // ═══════════════════════════════════════════════════════════════
    // 行 2: 値（ツアーコード / バス看板名 / PAX / ガイド名）
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A2', b.ref_no    || '',          S_BOLD);
    c(ws, 'B2', b.tour_name || '');
    c(ws, 'G2', arr.bus_company_name || '', S_BOLD);
    c(ws, 'O2', b.pax != null ? Number(b.pax) : '');
    c(ws, 'Z2', arr.guide_name || '',       S_BOLD);

    // ═══════════════════════════════════════════════════════════════
    // 行 3: ARR便 / ガイドTEL
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'R3', 'ARR:',              S_LABEL);
    c(ws, 'S3', flight(arr, 'arr'));
    c(ws, 'Y3', 'TEL:',              S_LABEL);
    c(ws, 'Z3', arr.guide_phone || '');

    // ═══════════════════════════════════════════════════════════════
    // 行 4: DEP便
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'R4', 'DEP:',              S_LABEL);
    c(ws, 'S4', flight(arr, 'dep'));

    // ═══════════════════════════════════════════════════════════════
    // 行 5: ツアー名 / エージェント / PAX内訳
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A5', b.agent_name || '');
    c(ws, 'O5', `Adult:${b.pax_adult || 0}  Child:${b.pax_child || 0}  Inf:${b.pax_infant || 0}`);
    c(ws, 'S5', `IN:${b.in_date || ''}  OUT:${b.out_date || ''}`);

    // ═══════════════════════════════════════════════════════════════
    // 行 7: テーブルヘッダー
    // ═══════════════════════════════════════════════════════════════
    const TH = 7;
    c(ws, `A${TH}`, 'DATE',      S_TH);
    c(ws, `B${TH}`, '',          S_TH);
    c(ws, `C${TH}`, 'BUS',       S_TH);
    c(ws, `D${TH}`, '',          S_TH);
    c(ws, `E${TH}`, 'ITINERARY', S_TH);
    // F-N: 空（ITINERARY列の幅で表現）
    for (const col of ['F','G','H','I','J','K','L','M','N']) {
      c(ws, `${col}${TH}`, '', S_TH);
    }
    c(ws, `O${TH}`, 'OTHERS',   S_TH);
    c(ws, `P${TH}`, '',         S_TH);
    c(ws, `Q${TH}`, 'HOTEL',    S_TH);
    c(ws, `R${TH}`, 'AREA',     S_TH);
    c(ws, `S${TH}`, 'TEL',      S_TH);
    c(ws, `T${TH}`, 'DRV',      S_TH);
    c(ws, `U${TH}`, 'B:',       S_TH);
    c(ws, `V${TH}`, 'L:',       S_TH);
    c(ws, `W${TH}`, 'TIME',     S_TH);
    c(ws, `X${TH}`, 'TEL',      S_TH);
    c(ws, `Y${TH}`, 'D:',       S_TH);
    c(ws, `Z${TH}`, 'TIME',     S_TH);
    c(ws, `AA${TH}`, 'TEL',     S_TH);

    // ═══════════════════════════════════════════════════════════════
    // 行 8〜: 日程データ
    // ═══════════════════════════════════════════════════════════════
    const DATA_START = TH + 1;
    days.forEach((d, i) => {
      const row = DATA_START + i;
      const s   = i % 2 === 0 ? S_GRAY : S_WHITE;

      const h = hotels.find(
        (x) => x.check_in && x.check_out && x.check_in <= d.day_date && x.check_out > d.day_date
      );
      const hotelName = h ? (h.hotel_name  || '') : (d.hotel_name  || '');
      const hotelArea = h ? (h.hotel_area  || '') : '';
      const hotelTel  = h ? (h.hotel_phone || '') : '';

      c(ws, `A${row}`,  d.day_date          || '', s);
      c(ws, `B${row}`,  d.day_of_week       || '', s);
      c(ws, `C${row}`,  d.bus_company       || arr.bus_company_name || '', s);
      c(ws, `D${row}`,  '',                        s);
      c(ws, `E${row}`,  d.itinerary         || '', s);
      for (const col of ['F','G','H','I','J','K','L','M','N']) {
        c(ws, `${col}${row}`, '', s);
      }
      c(ws, `O${row}`,  d.others_notes      || '', s);
      c(ws, `P${row}`,  '',                        s);
      c(ws, `Q${row}`,  hotelName,                 s);
      c(ws, `R${row}`,  hotelArea,                 s);
      c(ws, `S${row}`,  hotelTel,                  s);
      c(ws, `T${row}`,  d.driver_info       || '', s);
      c(ws, `U${row}`,  d.breakfast_type    || '', s);
      c(ws, `V${row}`,  d.lunch_restaurant  || '', s);
      c(ws, `W${row}`,  d.lunch_time        || '', s);
      c(ws, `X${row}`,  d.lunch_phone       || '', s);
      c(ws, `Y${row}`,  d.dinner_restaurant || '', s);
      c(ws, `Z${row}`,  d.dinner_time       || '', s);
      c(ws, `AA${row}`, d.dinner_phone      || '', s);
    });

    const lastRow = DATA_START + Math.max(days.length, 1);
    ws['!ref'] = `A1:AA${lastRow}`;

    // 列幅 (A〜AA = 27列)
    ws['!cols'] = [
      { wch: 12 }, // A: DATE
      { wch: 5  }, // B: 曜日
      { wch: 16 }, // C: BUS
      { wch: 4  }, // D
      { wch: 50 }, // E: ITINERARY (wide)
      { wch: 3  }, // F
      { wch: 3  }, // G
      { wch: 3  }, // H
      { wch: 3  }, // I
      { wch: 3  }, // J
      { wch: 3  }, // K
      { wch: 3  }, // L
      { wch: 3  }, // M
      { wch: 3  }, // N
      { wch: 20 }, // O: OTHERS
      { wch: 4  }, // P
      { wch: 22 }, // Q: HOTEL
      { wch: 14 }, // R: AREA
      { wch: 14 }, // S: TEL
      { wch: 16 }, // T: DRV
      { wch: 10 }, // U: B:
      { wch: 20 }, // V: L:
      { wch: 8  }, // W: TIME
      { wch: 14 }, // X: TEL
      { wch: 20 }, // Y: D:
      { wch: 8  }, // Z: TIME
      { wch: 14 }, // AA: TEL
    ];

    // 行高（ヘッダー＆データ行）
    ws['!rows'] = [
      { hpt: 18 }, // 行1
      { hpt: 18 }, // 行2
      { hpt: 16 }, // 行3
      { hpt: 16 }, // 行4
      { hpt: 14 }, // 行5
      { hpt: 6  }, // 行6 (空白)
      { hpt: 30 }, // 行7 ヘッダー
      ...Array(days.length).fill({ hpt: 60 }), // データ行（折り返し分）
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '手配書');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

    const filename = `haichisho_${(b.ref_no || booking_id).replace(/[^A-Za-z0-9_-]/g, '_')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
