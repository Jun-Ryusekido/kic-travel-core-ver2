// 手配書Excel出力ロジックのNode向けテスト。
// public/tour_arrangement_template.xlsxを土台に、3日/11日/14日の合成データで出力し、
// scripts/tmp_template/out_*.xlsxに保存する。結合セルの重複等はscripts/verify_arrangement_excel.pyで検証する。
const fs = require('fs');
const path = require('path');
global.ExcelJS = require('exceljs');
require(path.join(__dirname, '..', 'arrangement_excel.js'));

function makeDays(n, startDate){
  const days = [];
  const d0 = new Date(startDate+'T00:00:00Z');
  for(let i=0;i<n;i++){
    const d = new Date(d0.getTime() + i*86400000);
    const iso = d.toISOString().slice(0,10);
    days.push({
      day_no: i+1,
      date: iso,
      bus_company_text: i%2===0 ? '輝岩商事' : '総企バス',
      itinerary_text: `Day${i+1} 9:00→10:00見学地A 12:00昼食 15:00→16:00見学地B 18:00夕食 20:00ホテル着`,
      others_text: i===0 ? '新幹線往路１号でOK' : '',
      hotel_name: i < n-1 ? `テストホテル${(i%3)+1}` : '',
      hotel_note: i < n-1 ? 'DRV同宿\nP:あり' : '',
      breakfast_text: i===0 ? 'X' : 'ホテル',
      breakfast_time: i===0 ? '' : '7:30',
      lunch_name: `テストレストラン${(i%2)+1}`,
      lunch_time: '12:00',
      lunch_phone: '03-0000-0000',
      dinner_name: i < n-1 ? `テストレストラン${(i%2)+3}` : '',
      dinner_time: i < n-1 ? '19:00' : '',
      dinner_phone: i < n-1 ? '03-1111-1111' : '',
    });
  }
  return days;
}

function makePayload(n){
  return {
    refNo: `TEST${n}D_KK`,
    header: {
      bus_signage_name: `TEST GROUP ${n}DAYS`,
      nationality: 'テスト国',
      pax_adult: 10, pax_child: 2, pax_note: '内:小1名',
      arr_date: '2026-06-15', arr_airport: 'NRT(T1)', arr_flight: 'NH830', arr_time: '7:25',
      dep_date: '2026-06-'+String(14+n).padStart(2,'0'), dep_airport: 'NRT(T1)', dep_flight: 'NH829', dep_time: '11:15',
    },
    guides: [
      { guide_name: 'テスト太郎', phone: '090-0000-0001' },
      { guide_name: 'テスト花子', phone: '090-0000-0002' },
    ],
    days: makeDays(n, '2026-06-15'),
  };
}

(async()=>{
  const templatePath = path.join(__dirname, '..', 'public', 'tour_arrangement_template.xlsx');
  const outDir = path.join(__dirname, 'tmp_template');
  for(const n of [3, 11, 14]){
    const templateBuf = fs.readFileSync(templatePath);
    const payload = makePayload(n);
    const wb = await ArrangementExcel.buildArrangementExcelWorkbook(templateBuf, payload);
    const outPath = path.join(outDir, `out_${n}days.xlsx`);
    await wb.xlsx.writeFile(outPath);
    console.log('wrote', outPath);
  }
})().catch(e=>{ console.error(e); process.exit(1); });
