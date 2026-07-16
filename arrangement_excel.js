// 手配書Excel出力ロジック。
//
// テンプレート(public/tour_arrangement_template.xlsx, シート"F")を土台に、
// 「通常日ブロック」(6行1セット)・「最終日ブロック」(6行、行程欄が2分割)・
// 「フッター」(固定テキスト)を、出力のたびにテンプレートから相対座標で抽出し、
// 行挿入(insertRow/spliceRows)を一切使わずに複製・再配置して組み立てる。
// (spliceRows等の行挿入は結合セルの範囲を正しく追従させないため使用しない)
//
// ブラウザ(index.html、グローバルにExcelJSが読み込まれている前提)・Node(exceljsをrequireして
// globalThis.ExcelJSにセットする)の両方で動くよう、globalThis経由でExcelJSを参照する。
(function(root){
  'use strict';

  const HEADER_ROWS = 10;          // 1〜10行目
  const NORMAL_BLOCK_START = 11;   // 元ファイルの通常日ブロック開始行
  const NORMAL_BLOCK_ROWS = 6;
  const FINAL_BLOCK_START = 71;    // 元ファイルの最終日ブロック開始行
  const FINAL_BLOCK_ROWS = 6;
  const FOOTER_START = 77;         // 元ファイルのフッター開始行
  const FOOTER_ROWS = 9;           // 77〜85
  const MAX_COL = 35;              // A〜AI

  function ExcelJSRef(){
    const E = root.ExcelJS || (typeof require === 'function' ? require('exceljs') : null);
    if(!E) throw new Error('ExcelJSが読み込まれていません');
    return E;
  }

  function cloneStyle(cell){
    return {
      font: cell.font ? JSON.parse(JSON.stringify(cell.font)) : undefined,
      alignment: cell.alignment ? JSON.parse(JSON.stringify(cell.alignment)) : undefined,
      border: cell.border ? JSON.parse(JSON.stringify(cell.border)) : undefined,
      fill: cell.fill ? JSON.parse(JSON.stringify(cell.fill)) : undefined,
      numFmt: cell.numFmt,
      protection: cell.protection ? JSON.parse(JSON.stringify(cell.protection)) : undefined,
    };
  }

  function applyStyle(cell, style){
    if(style.font !== undefined) cell.font = style.font;
    if(style.alignment !== undefined) cell.alignment = style.alignment;
    if(style.border !== undefined) cell.border = style.border;
    if(style.fill !== undefined) cell.fill = style.fill;
    if(style.numFmt !== undefined) cell.numFmt = style.numFmt;
    if(style.protection !== undefined) cell.protection = style.protection;
  }

  // 結合範囲文字列("A1:B2")を{r1,c1,r2,c2}(1-based, シート上の絶対座標)に変換
  function parseRange(ws, rangeStr){
    const [a,b] = rangeStr.split(':');
    const ca = ws.getCell(a);
    const cb = ws.getCell(b);
    return { r1: ca.row, c1: ca.col, r2: cb.row, c2: cb.col };
  }

  // ws内の[startRow, startRow+numRows-1]をブロックとして、セルの値/スタイルと
  // ブロック相対座標での結合範囲を抽出する
  function extractBlock(ws, startRow, numRows){
    const rowHeights = [];
    for(let r=0;r<numRows;r++){
      rowHeights.push(ws.getRow(startRow+r).height);
    }
    const cells = [];
    for(let r=0;r<numRows;r++){
      const row = ws.getRow(startRow+r);
      for(let c=1;c<=MAX_COL;c++){
        const cell = row.getCell(c);
        const isMaster = !cell.isMerged || cell.master === cell;
        let value;
        if(isMaster){
          const v = cell.value;
          if(v && typeof v === 'object' && v.formula){
            // テンプレートのformulaはブロック内相対参照・ブロック間相互参照が混在し
            // 複製時の追従が複雑なため使用しない。素の値(result)のみ引き継ぐ。
            value = (v.result !== undefined) ? v.result : null;
          } else {
            value = v;
          }
        } else {
          value = undefined; // 結合の非マスターセルは値を持たない
        }
        cells.push({ r, c, value, isMaster, style: cloneStyle(cell) });
      }
    }
    const merges = (ws.model.merges||[]).map(m=>parseRange(ws,m))
      .filter(m=> m.r1>=startRow && m.r2<=startRow+numRows-1)
      .map(m=>({ r1:m.r1-startRow, c1:m.c1, r2:m.r2-startRow, c2:m.c2 }));
    return { numRows, rowHeights, cells, merges };
  }

  // 既存の結合セルのうち、[fromRow,toRow]範囲内に完全に収まるものをすべて解除する
  function unmergeRowRange(ws, fromRow, toRow){
    const merges = (ws.model.merges||[]).slice();
    merges.forEach(m=>{
      const r = parseRange(ws, m);
      if(r.r1 >= fromRow && r.r2 <= toRow){
        ws.unMergeCells(r.r1, r.c1, r.r2, r.c2);
      }
    });
  }

  // 指定行から値/スタイルをすべてクリアする(結合は事前にunmergeRowRangeで解除しておくこと)
  function clearRowRange(ws, fromRow, toRow){
    for(let r=fromRow;r<=toRow;r++){
      const row = ws.getRow(r);
      for(let c=1;c<=MAX_COL;c++){
        const cell = row.getCell(c);
        cell.value = null;
        cell.style = {};
      }
      row.height = undefined;
    }
  }

  // ブロックをws上のtargetStartRowに配置する。cellValues(オプション)で
  // {r,c}→値 の上書きを指定できる(日毎明細等の動的データの書き込み用)。
  function placeBlock(ws, block, targetStartRow, cellValues){
    for(let r=0;r<block.numRows;r++){
      const h = block.rowHeights[r];
      if(h !== undefined) ws.getRow(targetStartRow+r).height = h;
    }
    block.cells.forEach(bc=>{
      const cell = ws.getRow(targetStartRow+bc.r).getCell(bc.c);
      applyStyle(cell, bc.style);
      if(bc.isMaster){
        const key = bc.r+':'+bc.c;
        const override = cellValues && Object.prototype.hasOwnProperty.call(cellValues, key) ? cellValues[key] : undefined;
        cell.value = override !== undefined ? override : (bc.value === undefined ? null : bc.value);
      }
    });
    block.merges.forEach(m=>{
      ws.mergeCellsWithoutStyle(targetStartRow+m.r1, m.c1, targetStartRow+m.r2, m.c2);
    });
  }

  function key(r,c){ return r+':'+c; }

  const WEEKDAY_JP = ['(日)','(月)','(火)','(水)','(木)','(金)','(土)'];
  function toDateOnly(v){
    if(!v) return null;
    if(v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function weekdayJP(v){
    const d = toDateOnly(v);
    return d ? WEEKDAY_JP[d.getUTCDay()] : '';
  }

  function buildDayCellValues(day){
    const v = {};
    // A: 日数
    v[key(0,1)] = day.day_no != null ? day.day_no : '';
    // B: 日付 / 曜日
    const dateVal = toDateOnly(day.date);
    v[key(0,2)] = dateVal || (day.date || '');
    v[key(4,2)] = weekdayJP(day.date);
    // C: バス会社
    v[key(0,3)] = day.bus_company_text || '';
    // O: OTHERS
    v[key(0,15)] = day.others_text || '';
    // R: ホテル名 / R(下段):エリア / S(下段):電話 ※エリア・電話はデータモデルに存在しないため
    // 常に空欄にする(テンプレート側に値が残っていても、他ツアーのデータが混入しないよう明示的にクリアする)
    v[key(0,18)] = day.hotel_name || '';
    v[key(4,18)] = '';
    v[key(4,19)] = '';
    // X: ホテル備考(自由記述)
    v[key(0,24)] = day.hotel_note || '';
    // Z/AC/AE: 朝食・昼食・夕食 ※朝食の電話欄(AE)はデータモデルに存在しないため常に空欄
    v[key(0,26)] = day.breakfast_text ? ('B:'+day.breakfast_text) : '';
    v[key(0,29)] = day.breakfast_time || '';
    v[key(0,31)] = '';
    v[key(2,26)] = day.lunch_name ? ('L:'+day.lunch_name) : '';
    v[key(2,29)] = day.lunch_time || '';
    v[key(2,31)] = day.lunch_phone || '';
    v[key(4,26)] = day.dinner_name ? ('D:'+day.dinner_name) : '';
    v[key(4,29)] = day.dinner_time || '';
    v[key(4,31)] = day.dinner_phone || '';
    // AF/AG/AH/AI: 右側「利用レストラン一覧」欄 ※住所欄(AH)はデータモデルに存在しないため常に空欄
    v[key(0,32)] = dateVal || (day.date || '');
    v[key(0,33)] = v[key(0,26)];
    v[key(0,34)] = '';
    v[key(0,35)] = '';
    v[key(2,33)] = v[key(2,26)];
    v[key(2,34)] = '';
    v[key(2,35)] = day.lunch_phone || '';
    v[key(4,33)] = v[key(4,26)];
    v[key(4,34)] = '';
    v[key(4,35)] = day.dinner_phone || '';
    return v;
  }

  function buildItineraryValuesNormal(day){
    const v = {};
    v[key(0,5)] = day.itinerary_text || ''; // E11:N16
    return v;
  }
  function buildItineraryValuesFinal(day){
    const v = {};
    v[key(0,5)] = day.itinerary_text || ''; // E71:N73
    // E74:N76(2段目)はテンプレートの固定文言をそのまま引き継ぐため、ここでは上書きしない
    return v;
  }

  function fmtHM(dateStr, timeStr){
    const parts = [];
    if(dateStr){
      const d = toDateOnly(dateStr);
      if(d) parts.push((d.getUTCMonth()+1)+'/'+d.getUTCDate());
    }
    return parts.join(' ');
  }

  function buildFlightLine(dateStr, airport, flight, time){
    const parts = [];
    if(dateStr){
      const d = toDateOnly(dateStr);
      if(d) parts.push((d.getUTCMonth()+1)+'/'+d.getUTCDate());
    }
    if(airport) parts.push(airport);
    if(flight) parts.push(flight);
    if(time) parts.push(time);
    return parts.join(' ');
  }

  function buildPaxText(header){
    const lines = [];
    const adult = Number(header.pax_adult)||0;
    const child = Number(header.pax_child)||0;
    let main = adult+'名';
    if(child>0) main += '+'+child;
    lines.push(main);
    if(header.pax_note) lines.push(header.pax_note);
    return lines.join('\n');
  }

  // 注意文言(tour_arrangement_notes)をフッターブロック内の対応セルに差し込むための
  // 上書きマップを作る。値は文字列または文字列配列(display_order順)を受け付け、
  // 配列は改行結合してから行単位で割り当てる。
  // フッター(元ファイル77〜85行目)のセル役割:
  //   A77〜A80 … 標準注意文言(fixed_template)。データが無ければテンプレートの文言を残す
  //   B81/J81/Q81/B82 … バス会社・ドライバー連絡先(driver_info)
  //   A83 … ツアー固有の申し送り(tour_specific)。元テンプレートに専用枠がないため空きセルを使用
  //   A84/A85 … ミネラルウォーター配布指示(mineral_water)
  //   W82/W83(お茶代・食事代)とAE85(KIC TRAVEL)はテンプレート固定文言のまま
  // データが存在しないnote_typeのセルには上書きキー自体を作らない(=テンプレートの値のまま)。
  function noteToLines(v){
    const joined = Array.isArray(v) ? v.filter(Boolean).join('\n') : String(v||'');
    return joined ? joined.split(/\r?\n/).filter(line=>line.trim()!=='') : [];
  }

  function buildFooterCellValues(notes){
    const n = notes || {};
    const v = {};

    const fixedLines = noteToLines(n.fixed_template);
    if(fixedLines.length){
      // A77〜A80の4行に行単位で配置。4行を超える分は最終行にまとめる。余った行は空欄にする
      const rows = fixedLines.slice(0,3);
      if(fixedLines.length>3) rows.push(fixedLines.slice(3).join(' '));
      for(let i=0;i<4;i++) v[key(i,1)] = rows[i] || '';
    }

    const driverLines = noteToLines(n.driver_info);
    if(driverLines.length){
      // 1〜3行目は81行目の3枠(B81/J81/Q81)、4行目以降はB82にまとめる
      v[key(4,2)]  = driverLines[0] || '';
      v[key(4,10)] = driverLines[1] || '';
      v[key(4,17)] = driverLines[2] || '';
      if(driverLines.length>3) v[key(5,2)] = driverLines.slice(3).join(' / ');
    }

    const specificLines = noteToLines(n.tour_specific);
    if(specificLines.length){
      v[key(6,1)] = specificLines.join('\n'); // A83
    }

    const waterLines = noteToLines(n.mineral_water);
    if(waterLines.length){
      v[key(7,1)] = waterLines[0];                                  // A84
      if(waterLines.length>1) v[key(8,1)] = waterLines.slice(1).join(' '); // A85
    }

    return v;
  }

  function buildHeaderCellValues(refNo, header, guides){
    const h = header||{};
    const v = {};
    v[key(1,1)] = refNo || ''; // A2:F9
    v[key(1,7)] = h.nationality ? ('国籍：'+h.nationality) : ''; // G2:N4
    v[key(4,7)] = h.bus_signage_name || ''; // G5:N9
    v[key(1,15)] = buildPaxText(h); // O2:Q9
    v[key(1,19)] = buildFlightLine(h.arr_date, h.arr_airport, h.arr_flight, h.arr_time); // S2:Y5
    v[key(5,19)] = buildFlightLine(h.dep_date, h.dep_airport, h.dep_flight, h.dep_time); // S6:Y9
    const names = (guides||[]).map(g=>g.guide_name||'').filter(Boolean);
    const phones = (guides||[]).map(g=>g.phone||'').filter(Boolean);
    v[key(1,26)] = names.join('\n'); // Z2:AE6
    v[key(6,26)] = phones.join('\n'); // Z7:AE9
    return v;
  }

  // メイン処理: テンプレートを読み込み、日数に応じて組み立てたワークブックを返す
  async function buildArrangementExcelWorkbook(templateData, payload){
    const ExcelJS = ExcelJSRef();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateData);
    const ws = wb.getWorksheet('F') || wb.worksheets[0];

    const normalBlock = extractBlock(ws, NORMAL_BLOCK_START, NORMAL_BLOCK_ROWS);
    const finalBlock = extractBlock(ws, FINAL_BLOCK_START, FINAL_BLOCK_ROWS);
    const footerBlock = extractBlock(ws, FOOTER_START, FOOTER_ROWS);

    const days = (payload.days||[]).slice();
    const dayCount = Math.max(days.length, 1);
    const normalCount = Math.max(dayCount-1, 0);

    const totalContentRows = normalCount*NORMAL_BLOCK_ROWS + FINAL_BLOCK_ROWS + FOOTER_ROWS;
    const lastRow = HEADER_ROWS + totalContentRows;
    const templateLastRow = FOOTER_START + FOOTER_ROWS - 1;
    const clearToRow = Math.max(lastRow, templateLastRow);

    // 11行目以降をすべて解除・クリアしてから組み立て直す(行挿入は使わない)
    unmergeRowRange(ws, NORMAL_BLOCK_START, ws.rowCount || templateLastRow);
    clearRowRange(ws, NORMAL_BLOCK_START, clearToRow);

    let row = HEADER_ROWS + 1;
    for(let i=0;i<normalCount;i++){
      const day = days[i] || {};
      const values = Object.assign({}, buildDayCellValues(day), buildItineraryValuesNormal(day));
      placeBlock(ws, normalBlock, row, values);
      row += NORMAL_BLOCK_ROWS;
    }
    {
      const finalDay = days[dayCount-1] || {};
      const values = Object.assign({}, buildDayCellValues(finalDay), buildItineraryValuesFinal(finalDay));
      placeBlock(ws, finalBlock, row, values);
      row += FINAL_BLOCK_ROWS;
    }
    placeBlock(ws, footerBlock, row, buildFooterCellValues(payload.notes));
    row += FOOTER_ROWS;

    // ヘッダー(1〜10行目)
    const headerValues = buildHeaderCellValues(payload.refNo, payload.header, payload.guides);
    Object.keys(headerValues).forEach(k=>{
      const [r,c] = k.split(':').map(Number);
      ws.getRow(r+1).getCell(c).value = headerValues[k];
    });

    return wb;
  }

  const api = {
    buildArrangementExcelWorkbook,
    // テスト用に内部関数も公開
    _internal: {
      extractBlock, placeBlock, unmergeRowRange, clearRowRange,
      buildDayCellValues, buildHeaderCellValues, buildFooterCellValues, buildFlightLine, buildPaxText, weekdayJP,
      NORMAL_BLOCK_START, NORMAL_BLOCK_ROWS, FINAL_BLOCK_START, FINAL_BLOCK_ROWS, FOOTER_START, FOOTER_ROWS, HEADER_ROWS, MAX_COL,
    }
  };
  root.ArrangementExcel = api;
  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
