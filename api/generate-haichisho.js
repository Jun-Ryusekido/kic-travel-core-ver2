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

// ── スタイル定義 ──────────────────────────────────────────────────
const F = { name: 'MS Pゴシック', sz: 9 };
const FB = { name: 'MS Pゴシック', sz: 9, bold: true };

const S = {
  normal:    { font: F },
  bold:      { font: FB },
  th:        { font: FB, fill: { patternType: 'solid', fgColor: { rgb: 'CCCCCC' } },
               alignment: { horizontal: 'center', vertical: 'center' } },
  // データ行（白背景）
  data:      { font: F, alignment: { vertical: 'top' } },
  dataWrap:  { font: F, alignment: { vertical: 'top', wrapText: true } },
  // データ行（グレー背景）
  gray:      { font: F, fill: { patternType: 'solid', fgColor: { rgb: 'EEEEEE' } },
               alignment: { vertical: 'top' } },
  grayWrap:  { font: F, fill: { patternType: 'solid', fgColor: { rgb: 'EEEEEE' } },
               alignment: { vertical: 'top', wrapText: true } },
  // スペーサー行（常にグレー）
  spacer:    { font: F, fill: { patternType: 'solid', fgColor: { rgb: 'EEEEEE' } } },
};

function c(ws, addr, value, style) {
  const t = typeof value === 'number' ? 'n' : 's';
  const cell = { v: value == null ? '' : value, t };
  if (style) cell.s = style;
  ws[addr] = cell;
}

function flightStr(arr, type) {
  const fields = type === 'arr'
    ? [arr.arr_flight, arr.arr_airport, arr.arr_date, arr.arr_time]
    : [arr.dep_flight, arr.dep_airport, arr.dep_date, arr.dep_time];
  return fields.filter(Boolean).join('  ');
}

// ISO date → YYYY/MM/DD
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
      days = Array.from(dateSet)
        .sort()
        .map((dateStr) => ({ day_date: dateStr }));
    }

    const ws = {};

    // ═══════════════════════════════════════════════════════════════
    // 行1: ラベル（太字）
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A1', 'Tour Code',          S.bold);
    c(ws, 'G1', 'バス看板名',          S.bold);
    c(ws, 'O1', 'No. PAX',            S.bold);
    c(ws, 'R1', 'Flight Information', S.bold);
    c(ws, 'Z1', 'Guide',              S.bold);

    // ═══════════════════════════════════════════════════════════════
    // 行2: 値
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A2', b.ref_no    || '',                                          S.normal);
    c(ws, 'G2', arr.bus_signboard_name || arr.bus_company_name || '',        S.normal);
    c(ws, 'O2', b.pax != null ? Number(b.pax) : '',                         S.normal);
    c(ws, 'Z2', arr.guide_name || '',                                        S.normal);

    // ═══════════════════════════════════════════════════════════════
    // 行3: エージェント / PAX内訳 / ARR便 / ガイドTEL
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A3', b.agent_name || '',                                          S.normal);
    c(ws, 'G3', arr.travel_agency_name || '',                                S.normal);
    c(ws, 'O3', `大人:${b.pax_adult||0}  子供:${b.pax_child||0}  乳児:${b.pax_infant||0}`, S.normal);
    c(ws, 'R3', flightStr(arr, 'arr'),                                       S.normal);
    c(ws, 'Z3', arr.guide_phone || '',                                       S.normal);

    // ═══════════════════════════════════════════════════════════════
    // 行4: DEP便
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'R4', flightStr(arr, 'dep'), S.normal);

    // ═══════════════════════════════════════════════════════════════
    // 行5: IN/OUT日程
    // ═══════════════════════════════════════════════════════════════
    c(ws, 'A5', `IN: ${fmtDate(b.in_date)}    OUT: ${fmtDate(b.out_date)}`, S.normal);

    // 行6: 空白（スペーサー）

    // ═══════════════════════════════════════════════════════════════
    // 行7: テーブルヘッダー（太字、背景CCCCCC）
    // ═══════════════════════════════════════════════════════════════
    const TH = 7;
    [
      ['A','DATE'],['B',''],['C','BUS'],['D',''],
      ['E','ITINERARY'],
      ['F',''],['G',''],['H',''],['I',''],['J',''],['K',''],['L',''],['M',''],['N',''],
      ['O','OTHERS'],['P',''],['Q',''],
      ['R','HOTEL'],['S','AREA'],['T','TEL'],['U','DRV'],
      ['V','B:'],['W','L:'],['X','TIME'],['Y','TEL'],
      ['Z','D:'],['AA','TIME'],['AB','TEL'],
    ].forEach(([col, label]) => c(ws, `${col}${TH}`, label, S.th));

    // ═══════════════════════════════════════════════════════════════
    // 行8〜: 日程データ（1日=2行）
    // ═══════════════════════════════════════════════════════════════
    const DATA_START = 8;
    const rowHeights = [
      { hpt: 16 }, // 行1
      { hpt: 16 }, // 行2
      { hpt: 16 }, // 行3
      { hpt: 14 }, // 行4
      { hpt: 14 }, // 行5
      { hpt: 6  }, // 行6 空白
      { hpt: 22 }, // 行7 ヘッダー
    ];

    const ALL_COLS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N',
                      'O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB'];

    days.forEach((d, i) => {
      const dataRow   = DATA_START + i * 2;
      const spacerRow = dataRow + 1;

      // 奇数日程（i=0,2,4...）→ 白背景、偶数日程（i=1,3,5...）→ グレー背景
      const useGray = i % 2 === 1;
      const sNorm = useGray ? S.gray     : S.data;
      const sWrap = useGray ? S.grayWrap : S.dataWrap;

      // ホテル照合
      const h = hotels.find(
        (x) => x.check_in && x.check_out && x.check_in <= d.day_date && x.check_out > d.day_date
      );
      const hotelName = h ? (h.hotel_name       || '') : (d.hotel_name       || '');
      const hotelArea = h ? (h.hotel_area        || '') : (d.hotel_area       || '');
      const hotelTel  = h ? (h.hotel_area_phone  || '') : (d.hotel_area_phone || '');

      // A: DAY番号\n日付
      const dow = d.day_of_week || (d.day_date
        ? DOW_JA[new Date(d.day_date).getDay()]
        : '');
      c(ws, `A${dataRow}`,  `${i + 1}`,              sWrap);
      c(ws, `B${dataRow}`,  `${fmtDate(d.day_date)}\n${dow}`, sWrap);
      c(ws, `C${dataRow}`,  d.bus_company || arr.bus_company_name || '', sNorm);
      c(ws, `D${dataRow}`,  '',                       sNorm);
      c(ws, `E${dataRow}`,  d.itinerary         || '', sWrap);
      for (const col of ['F','G','H','I','J','K','L','M','N']) {
        c(ws, `${col}${dataRow}`, '', sNorm);
      }
      c(ws, `O${dataRow}`,  d.others_notes      || '', sWrap);
      c(ws, `P${dataRow}`,  '',                        sNorm);
      c(ws, `Q${dataRow}`,  '',                        sNorm);
      c(ws, `R${dataRow}`,  hotelName,                 sNorm);
      c(ws, `S${dataRow}`,  hotelArea,                 sNorm);
      c(ws, `T${dataRow}`,  hotelTel,                  sNorm);
      c(ws, `U${dataRow}`,  d.driver_info       || '', sNorm);
      c(ws, `V${dataRow}`,  d.breakfast_type    || '', sNorm);
      c(ws, `W${dataRow}`,  d.lunch_restaurant  || '', sNorm);
      c(ws, `X${dataRow}`,  d.lunch_time        || '', sNorm);
      c(ws, `Y${dataRow}`,  d.lunch_phone       || '', sNorm);
      c(ws, `Z${dataRow}`,  d.dinner_restaurant || '', sNorm);
      c(ws, `AA${dataRow}`, d.dinner_time       || '', sNorm);
      c(ws, `AB${dataRow}`, d.dinner_phone      || '', sNorm);

      // スペーサー行（常にグレー）
      ALL_COLS.forEach((col) => c(ws, `${col}${spacerRow}`, '', S.spacer));

      rowHeights.push({ hpt: 45 }); // データ行
      rowHeights.push({ hpt: 15 }); // スペーサー行
    });

    // ═══════════════════════════════════════════════════════════════
    // フッター（最終行の3行下）
    // ═══════════════════════════════════════════════════════════════
    const footerRow = DATA_START + days.length * 2 + 3;
    c(ws, `A${footerRow}`,  arr.footer_notes || arr.notes || '', S.normal);
    c(ws, `AB${footerRow}`, 'KIC TRAVEL',                        S.bold);

    ws['!ref']  = `A1:AB${footerRow + 1}`;
    ws['!rows'] = rowHeights;

    // ── 列幅（A〜AB 計28列）────────────────────────────────────────
    ws['!cols'] = [
      { wch: 4  }, // A: DAY#
      { wch: 4  }, // B: 日付/曜日
      { wch: 12 }, // C: BUS
      { wch: 4  }, // D
      { wch: 45 }, // E: ITINERARY
      { wch: 3  }, // F
      { wch: 3  }, // G
      { wch: 3  }, // H
      { wch: 3  }, // I
      { wch: 3  }, // J
      { wch: 3  }, // K
      { wch: 3  }, // L
      { wch: 3  }, // M
      { wch: 3  }, // N
      { wch: 15 }, // O: OTHERS
      { wch: 3  }, // P
      { wch: 3  }, // Q
      { wch: 15 }, // R: HOTEL
      { wch: 10 }, // S: AREA
      { wch: 12 }, // T: TEL
      { wch: 12 }, // U: DRV
      { wch: 8  }, // V: B:
      { wch: 15 }, // W: L:
      { wch: 6  }, // X: TIME
      { wch: 12 }, // Y: TEL
      { wch: 15 }, // Z: D:
      { wch: 6  }, // AA: TIME
      { wch: 12 }, // AB: TEL
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
