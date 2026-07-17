// 1回限りのデータ反映スクリプト: 予約 #1153 (KIC1153_KK) の実データ入り手配書サンプル
// templates/tehaisho_sample.xlsx (シート「狩野(1)」＝共通の日毎明細として採用。
// ホテル名・バス会社・食事内容はガイド間でほぼ同一のため、共通ドラフトの投入時と同様に
// 狩野(1)を代表データとして使う) を読み込み、手配管理タブが実際に参照する本体データ
// (booking_hotels / booking_restaurants) に反映する。
//
// 反映対象:
//   - booking_hotels: 日毎明細のホテル名(R列)が連続している区間を1泊在庫として
//     まとめ、check_in/check_outを算出してinsertする(既存レコードは無かったため
//     upsertは行わずinsertのみ)。
//   - booking_restaurants: 既存の空テンプレート行(店名未入力、日付・食事種別のみ設定
//     済み)を日付+食事種別でマッチさせ、店名・時刻・電話番号(memoへ格納)をUPDATEする。
//     朝食は本体データ側にそもそも列が無い(昼食・夕食のみ管理する設計)ため対象外。
//
// booking_buses は反映しない: 既存レコードに「太陽交通株式会社」等、Excelには
// 出てこない実名の会社が既に登録されており、Excel側の記載(「Life」「狩野／Life」)
// と機械的に対応付けると、より正確な可能性がある既存データを壊すリスクがあるため。
// 対応関係を人が確認してから、必要なら手動で更新すること。
//
// 実行方法: node scripts/reflect_kic1153_to_booking_tables.js

const path = require('path');
const ExcelJS = require('exceljs');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';
const REF_NO_LIKE = '%1153%';
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'tehaisho_sample.xlsx');
const SHEET = '狩野(1)';
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
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`INSERT ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbUpdate(table, id, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`UPDATE ${table} ${id} failed: ${r.status} ${await r.text()}`);
  return r.json();
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
function toPlainText(v) { const t = cellText(v); return t instanceof Date ? '' : String(t || '').trim(); }
function toDateOnlyStr(v) { const t = cellText(v); return t instanceof Date ? t.toISOString().slice(0, 10) : null; }
function toTimeStr(v) {
  const t = cellText(v);
  if (t instanceof Date) return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const s = String(t || '').trim();
  return (s === '' || s === '---') ? '' : s;
}
function stripMealPrefix(v) {
  const s = toPlainText(v);
  const m = s.match(/^[BLD]:(.*)$/);
  const name = m ? m[1].trim() : s;
  return (name === 'X' || name === '---' || name === '') ? '' : name;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('=== 予約#1153 手配書サンプル → 手配管理タブ本体データ反映 ===');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`シートが見つかりません: ${SHEET}`);

  const bookings = await sbSelect('bookings', `select=id,ref_no,tour_name&ref_no=ilike.${encodeURIComponent(REF_NO_LIKE)}`);
  if (bookings.length !== 1) throw new Error(`予約が一意に特定できません(${bookings.length}件)`);
  const booking = bookings[0];
  console.log(`対象予約: ${booking.ref_no} / ${booking.tour_name} / id=${booking.id}`);

  // 日毎明細をシートから読み取る
  const days = [];
  let row = BLOCK_START;
  while (true) {
    const dayNoRaw = ws.getCell(`A${row}`).value;
    if (typeof dayNoRaw !== 'number') break;
    const hotelRaw = toPlainText(ws.getCell(`R${row}`).value);
    days.push({
      day_no: dayNoRaw,
      date: toDateOnlyStr(ws.getCell(`B${row}`).value),
      hotel_name: (hotelRaw === 'DEP') ? '' : hotelRaw,
      lunch_name: stripMealPrefix(ws.getCell(`Z${row + 2}`).value),
      lunch_time: toTimeStr(ws.getCell(`AC${row + 2}`).value),
      lunch_phone: toPlainText(ws.getCell(`AE${row + 2}`).value),
      dinner_name: stripMealPrefix(ws.getCell(`Z${row + 4}`).value),
      dinner_time: toTimeStr(ws.getCell(`AC${row + 4}`).value),
      dinner_phone: toPlainText(ws.getCell(`AE${row + 4}`).value),
    });
    row += BLOCK_ROWS;
  }
  console.log(`日毎明細: ${days.length}日分`);

  // ── booking_hotels: ホテル名が連続している区間を1泊在庫としてまとめる ──
  const existingHotels = await sbSelect('booking_hotels', `select=id&booking_id=eq.${booking.id}`);
  if (existingHotels.length) {
    console.log(`booking_hotelsに既に${existingHotels.length}件あるため、ホテルの反映はスキップします(重複防止のため)。`);
  } else {
    const stays = [];
    let cur = null;
    for (const d of days) {
      if (!d.hotel_name) { cur = null; continue; }
      if (cur && cur.hotel_name === d.hotel_name) {
        cur.check_out = addDays(d.date, 1);
      } else {
        cur = { hotel_name: d.hotel_name, check_in: d.date, check_out: addDays(d.date, 1) };
        stays.push(cur);
      }
    }
    if (stays.length) {
      const rows = stays.map(s => ({
        booking_id: booking.id, hotel_name: s.hotel_name, check_in: s.check_in, check_out: s.check_out,
        room_type: '', rooms: 1, breakfast: false, unit_price: 0, amount: 0,
        confirmation_no: '', status: '手配OK', memo: '（手配書Excelから自動反映。部屋数・金額は要確認）',
      }));
      await sbInsert('booking_hotels', rows);
      console.log(`booking_hotelsに${rows.length}件反映しました:`);
      rows.forEach(r => console.log(`  - ${r.hotel_name}: ${r.check_in} 〜 ${r.check_out}`));
    }
  }

  // ── booking_restaurants: 既存の空テンプレート行を日付+食事種別でマッチしてUPDATE ──
  const existingRest = await sbSelect('booking_restaurants', `select=id,date,meal_type,restaurant_name&booking_id=eq.${booking.id}`);
  const findRow = (date, mealType) => existingRest.find(r => r.date === date && r.meal_type === mealType && !r.restaurant_name);
  let updated = 0, skippedNoMatch = 0, skippedNoData = 0;
  for (const d of days) {
    if (d.lunch_name) {
      const target = findRow(d.date, '昼食');
      if (target) {
        await sbUpdate('booking_restaurants', target.id, {
          restaurant_name: d.lunch_name, reservation_time: d.lunch_time || null, status: '手配OK',
          memo: d.lunch_phone ? `電話: ${d.lunch_phone}（手配書Excelから自動反映）` : '（手配書Excelから自動反映）',
        });
        updated++;
      } else { skippedNoMatch++; console.log(`  マッチする空行なし(昼食 ${d.date})`); }
    } else { skippedNoData++; }
    if (d.dinner_name) {
      const target = findRow(d.date, '夕食');
      if (target) {
        await sbUpdate('booking_restaurants', target.id, {
          restaurant_name: d.dinner_name, reservation_time: d.dinner_time || null, status: '手配OK',
          memo: d.dinner_phone ? `電話: ${d.dinner_phone}（手配書Excelから自動反映）` : '（手配書Excelから自動反映）',
        });
        updated++;
      } else { skippedNoMatch++; console.log(`  マッチする空行なし(夕食 ${d.date})`); }
    } else { skippedNoData++; }
  }
  console.log(`booking_restaurantsを${updated}件更新しました(データなしでスキップ: ${skippedNoData}件, マッチ行なし: ${skippedNoMatch}件)。`);

  console.log('');
  console.log('=== booking_buses は反映していません ===');
  console.log('既存レコードに「太陽交通株式会社」など、Excelの記載(「Life」「狩野／Life」)と');
  console.log('機械的に一致しない実名の会社が既に登録されています。より正確な可能性がある');
  console.log('既存データを誤って壊さないよう、対応関係を人が確認したうえで反映してください。');
  console.log('=== 完了 ===');
}

main().catch(e => { console.error('失敗:', e.message); process.exit(1); });
