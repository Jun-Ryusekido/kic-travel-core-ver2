import XLSX from 'xlsx';
import { isPdfEncrypted, decryptPdfToBase64, isExcelEncrypted, decryptExcelToSheetsText } from './lib/protected-file.js';

// 1通のメールに複数日程・複数ツアー分の予約情報が混在しているケースで、今開いている予約と
// 無関係な行まで抽出されてしまうのを防ぐための日付絞り込み許容日数。
// 日付のズレ・表記ゆれを考慮した仮の値。調整する場合はこの値を変更する。
const DATE_FILTER_TOLERANCE_DAYS = 3;

// PDFがパスワード保護されている場合はpasswordで復号したBase64を返す（保護されていなければそのまま返す）。
// パスワード関連のエラー(PasswordRequiredError/InvalidPasswordError、lib/protected-file.js参照)は
// そのまま呼び出し元(ハンドラ末尾のcatch)に伝播させ、そこで{error:'password_required'}等に変換する。
function resolvePdfBase64(pdfBase64, password) {
  const buffer = Buffer.from(pdfBase64, 'base64');
  if (!isPdfEncrypted(buffer)) return pdfBase64;
  return decryptPdfToBase64(buffer, password);
}

// クライアント側(SheetJS)でExcelのパスワード保護を検知して解析できなかった場合、
// ファイルの生データ(base64)がここに渡ってくる。パスワードで復号し、各シートをCSVテキスト化する。
// （暗号化されていないのに何らかの理由でクライアント側の解析に失敗していた場合の保険として、
// 実際には暗号化されていなければそのままサーバー側でパースする）
async function resolveExcelText(excelBase64, password) {
  const buffer = Buffer.from(excelBase64, 'base64');
  if (!isExcelEncrypted(buffer)) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map((name) => `[シート: ${name}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n');
  }
  return await decryptExcelToSheetsText(buffer, password);
}

// targetCheckIn/targetCheckOut（今開いている予約のIn-Date/Out-Date）が渡された場合、
// プロンプトに追記する絞り込み指示を組み立てる。どちらも空ならフィルタなし（従来通り全件抽出）。
function buildDateFilterInstruction(fieldLabel, targetCheckIn, targetCheckOut) {
  if (!targetCheckIn && !targetCheckOut) return '';
  const refDate = targetCheckIn || targetCheckOut;
  const periodNote = (targetCheckIn && targetCheckOut && targetCheckIn !== targetCheckOut)
    ? `（参考：この予約の対象期間は ${targetCheckIn} 〜 ${targetCheckOut} です）`
    : '';
  return `

重要（日程の絞り込み）: メール本文に複数の日程・複数の予約情報が含まれる場合、${fieldLabel}が${refDate}の前後${DATE_FILTER_TOLERANCE_DAYS}日以内に該当する行のみを抽出してください。それ以外の日程の行は無視してください。${periodNote}該当する行が1件も見つからない場合は、空のJSON配列 [] だけを返してください。`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { variants, mediaType, base64, hotelText, hotelPdfBase64, hotelExcelBase64, hotelImageBase64, hotelImageMediaType, facilityText, facilityPdfBase64, facilityExcelBase64, facilityImageBase64, facilityImageMediaType, busText, busPdfBase64, busExcelBase64, busImageBase64, busImageMediaType, restaurantText, restaurantPdfBase64, restaurantExcelBase64, restaurantImageBase64, restaurantImageMediaType, invoiceText, invoicePdfBase64, invoiceImageBase64, invoiceImageMediaType, targetCheckIn, targetCheckOut, password } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'サーバー側にAPIキーが設定されていません' });
    }

    const callClaude = async (content, maxTokens) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens || 1000,
          messages: [{ role: 'user', content }]
        })
      });
      const rawText = await r.text();
      let data;
      try{
        data = JSON.parse(rawText);
      }catch(_){
        throw new Error(`Anthropic APIからの応答を解析できませんでした（HTTP ${r.status}）: ${rawText.slice(0,200)}`);
      }
      if(!r.ok){
        throw new Error(data?.error?.message || `Anthropic APIエラー（HTTP ${r.status}）`);
      }
      return data;
    };

    // ホテルテキスト解析モード（クライアント側でパスワード保護されたExcelを検知できなかった場合、
    // hotelExcelBase64として生データが渡ってくるので、ここでサーバー側で復号してテキスト化する）
    const resolvedHotelText = hotelText || (hotelExcelBase64 ? await resolveExcelText(hotelExcelBase64, password) : '');
    if (resolvedHotelText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のホテル予約確認メールや文書からホテル情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo, status
ref_noは文書中のツアーコード・予約番号・REF#・KICから始まる番号等を探してください。見つからない場合は空文字にしてください。
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
重要: 出力は必ずJSON配列そのものだけにしてください。前置き・説明文・注釈・補足・コードブロック記号(\`\`\`)は一切含めないでください。日付形式の説明や注意書きなどの文章も絶対に出力しないでください。出力の最初の文字は必ず[、最後の文字は必ず]にしてください。${buildDateFilterInstruction('チェックイン日(check_in)', targetCheckIn, targetCheckOut)}

${resolvedHotelText}`
      }], 8000);
      return res.status(200).json(data);
    }
// ホテルPDF解析モード
    if (hotelPdfBase64) {
      const resolvedHotelPdfBase64 = resolvePdfBase64(hotelPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedHotelPdfBase64 } },
{ type: 'text', text: `このPDFからホテル予約情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
ref_noは文書中のツアーコード・予約番号・REF#・KICから始まる番号等を探してください。見つからない場合は空文字にしてください。
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
重要: 出力は必ずJSON配列そのものだけにしてください。前置き・説明文・注釈・補足・コードブロック記号(\`\`\`)は一切含めないでください。日付形式の説明や注意書きなどの文章も絶対に出力しないでください。出力の最初の文字は必ず[、最後の文字は必ず]にしてください。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // ホテル画像解析モード
    if (hotelImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: hotelImageMediaType || 'image/jpeg', data: hotelImageBase64 } },
        { type: 'text', text: `この画像からホテル予約情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
ref_noは文書中のツアーコード・予約番号・REF#・KICから始まる番号等を探してください。見つからない場合は空文字にしてください。
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
重要: 出力は必ずJSON配列そのものだけにしてください。前置き・説明文・注釈・補足・コードブロック記号(\`\`\`)は一切含めないでください。日付形式の説明や注意書きなどの文章も絶対に出力しないでください。出力の最初の文字は必ず[、最後の文字は必ず]にしてください。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 観光施設テキスト解析モード
    const resolvedFacilityText = facilityText || (facilityExcelBase64 ? await resolveExcelText(facilityExcelBase64, password) : '');
    if (resolvedFacilityText) {
      const data = await callClaude([{
        type: 'text',
text: `以下の観光施設・バス駐車場等の手配確認書やメールから情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。${buildDateFilterInstruction('日付(date)', targetCheckIn, targetCheckOut)}

${resolvedFacilityText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // 観光施設PDF解析モード
    if (facilityPdfBase64) {
      const resolvedFacilityPdfBase64 = resolvePdfBase64(facilityPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedFacilityPdfBase64 } },
        { type: 'text', text: `このPDFから観光施設・バス駐車場等の手配情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 観光施設画像解析モード
    if (facilityImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: facilityImageMediaType || 'image/jpeg', data: facilityImageBase64 } },
        { type: 'text', text: `この画像から観光施設・バス駐車場等の手配情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // レストランテキスト解析モード
    const resolvedRestaurantText = restaurantText || (restaurantExcelBase64 ? await resolveExcelText(restaurantExcelBase64, password) : '');
    if (resolvedRestaurantText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のレストラン手配確認書やメールからレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), reservation_time(予約時刻・HH:MM形式、不明は空文字), pax(人数・数値), amount(金額・数値・円), status, memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。${buildDateFilterInstruction('日付(date)', targetCheckIn, targetCheckOut)}

${resolvedRestaurantText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // レストランPDF解析モード
    if (restaurantPdfBase64) {
      const resolvedRestaurantPdfBase64 = resolvePdfBase64(restaurantPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedRestaurantPdfBase64 } },
        { type: 'text', text: `このPDFからレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), reservation_time(予約時刻・HH:MM形式、不明は空文字), pax(人数・数値), amount(金額・数値・円), status, memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // レストラン画像解析モード
    if (restaurantImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: restaurantImageMediaType || 'image/jpeg', data: restaurantImageBase64 } },
        { type: 'text', text: `この画像からレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), reservation_time(予約時刻・HH:MM形式、不明は空文字), pax(人数・数値), amount(金額・数値・円), status, memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // バステキスト解析モード
    const resolvedBusText = busText || (busExcelBase64 ? await resolveExcelText(busExcelBase64, password) : '');
    if (resolvedBusText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のバス手配確認書やメール（バス手配とドライバー宿泊予約の両方が含まれる場合があります）からバス手配情報を抽出してJSON配列で返してください。
各バス手配を1つのオブジェクトとして配列に含めてください。

フィールド一覧：
- bus_company: バス会社名
- bus_type: バスタイプ・車種等
- buses: 台数（数値）
- start_date: バスの運行開始日（YYYY-MM-DD）
- end_date: バスの運行終了日（YYYY-MM-DD）
- amount: バス代金（数値・円）
- status: 「手配OK」または「問い合わせ中」
- confirmation_no: 確認番号
- driver_hotel_name: ドライバーの宿泊施設名・ホテル名（記載がなければ空文字）
- driver_hotel_phone: 宿泊施設の電話番号（記載がなければ空文字）
- driver_hotel_address: 宿泊施設の住所（記載がなければ空文字）
- driver_check_in: 宿泊のチェックイン日（YYYY-MM-DD、記載がなければ空文字）
- driver_check_out: 宿泊のチェックアウト日（YYYY-MM-DD、記載がなければ空文字）
- driver_hotel_amount: 宿泊料金・支払い金額（数値・円、記載がなければ0）
- memo: 備考

抽出ルール（重要・必ず守ってください）：
1. 文書内に「チェックイン」「IN」「宿泊日」「泊」等の記載や、「チェックアウト」「OUT」「退室日」等の記載があれば、それは必ずdriver_check_in / driver_check_outに入れてください。宿泊施設名・電話番号・住所を抽出できているのに、記載があるチェックイン/アウト日だけを空欄のままにすることは禁止です。
2. バスの運行日(start_date/end_date)と、宿泊のチェックイン/アウト日(driver_check_in/driver_check_out)は別の概念です。文書に両方が記載されている場合は混同せず、それぞれ対応するフィールドに正しく振り分けてください（宿泊日をバスの運行日欄に入れたり、逆にバスの運行日を宿泊日欄に入れたりしないでください）。
3. 日付に年が明記されていない場合は、同じ文書内の他の日付（バス運行日等）と同じ年を採用して補ってください。年が分からないという理由だけで空文字にしないでください。
4. 宿泊料金はdriver_hotel_amountに入れ、バス自体の金額(amount)とは明確に区別してください。
5. 宿泊予約情報が同じメール内の一つのバス手配に対応する場合は同じオブジェクトにまとめ、対応するバス情報が見当たらない場合でも宿泊情報のみのオブジェクトとして1件返してください（その場合bus_company等バス関連フィールドは空文字/デフォルト値で構いません）。

statusは予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。${buildDateFilterInstruction('バスの運行開始日(start_date)', targetCheckIn, targetCheckOut)}

${resolvedBusText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // バスPDF解析モード
    if (busPdfBase64) {
      const resolvedBusPdfBase64 = resolvePdfBase64(busPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedBusPdfBase64 } },
        { type: 'text', text: `このPDFからバス手配情報を抽出してJSON配列で返してください（バス手配とドライバー宿泊予約の両方が含まれる場合があります）。
各バス手配を1つのオブジェクトとして配列に含めてください。

フィールド一覧：
- bus_company: バス会社名
- bus_type: バスタイプ・車種等
- buses: 台数（数値）
- start_date: バスの運行開始日（YYYY-MM-DD）
- end_date: バスの運行終了日（YYYY-MM-DD）
- amount: バス代金（数値・円）
- status: 「手配OK」または「問い合わせ中」
- confirmation_no: 確認番号
- driver_hotel_name: ドライバーの宿泊施設名（記載がなければ空文字）
- driver_hotel_phone: 宿泊施設の電話番号（記載がなければ空文字）
- driver_hotel_address: 宿泊施設の住所（記載がなければ空文字）
- driver_check_in: 宿泊のチェックイン日（YYYY-MM-DD、記載がなければ空文字）
- driver_check_out: 宿泊のチェックアウト日（YYYY-MM-DD、記載がなければ空文字）
- driver_hotel_amount: 宿泊料金・支払い金額（数値・円、記載がなければ0）
- memo: 備考

抽出ルール（重要・必ず守ってください）：
1. 文書内にチェックイン・チェックアウトに相当する記載があれば、必ずdriver_check_in / driver_check_outに入れてください。宿泊施設名・電話番号・住所を抽出できているのに、記載があるチェックイン/アウト日だけを空欄のままにすることは禁止です。
2. バスの運行日(start_date/end_date)と宿泊のチェックイン/アウト日(driver_check_in/driver_check_out)は別の概念です。混同せずそれぞれ正しいフィールドに振り分けてください。
3. 日付に年が明記されていない場合は、同じ文書内の他の日付と同じ年を採用して補ってください。
4. 宿泊料金はdriver_hotel_amountに入れ、バス自体の金額(amount)とは区別してください。
statusは予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // バス画像解析モード
    if (busImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: busImageMediaType || 'image/jpeg', data: busImageBase64 } },
        { type: 'text', text: `この画像からバス手配情報を抽出してJSON配列で返してください（バス手配とドライバー宿泊予約の両方が含まれる場合があります）。
各バス手配を1つのオブジェクトとして配列に含めてください。

フィールド一覧：
- bus_company: バス会社名
- bus_type: バスタイプ・車種等
- buses: 台数（数値）
- start_date: バスの運行開始日（YYYY-MM-DD）
- end_date: バスの運行終了日（YYYY-MM-DD）
- amount: バス代金（数値・円）
- status: 「手配OK」または「問い合わせ中」
- confirmation_no: 確認番号
- driver_hotel_name: ドライバーの宿泊施設名（記載がなければ空文字）
- driver_hotel_phone: 宿泊施設の電話番号（記載がなければ空文字）
- driver_hotel_address: 宿泊施設の住所（記載がなければ空文字）
- driver_check_in: 宿泊のチェックイン日（YYYY-MM-DD、記載がなければ空文字）
- driver_check_out: 宿泊のチェックアウト日（YYYY-MM-DD、記載がなければ空文字）
- driver_hotel_amount: 宿泊料金・支払い金額（数値・円、記載がなければ0）
- memo: 備考

抽出ルール（重要・必ず守ってください）：
1. 文書内にチェックイン・チェックアウトに相当する記載があれば、必ずdriver_check_in / driver_check_outに入れてください。宿泊施設名・電話番号・住所を抽出できているのに、記載があるチェックイン/アウト日だけを空欄のままにすることは禁止です。
2. バスの運行日(start_date/end_date)と宿泊のチェックイン/アウト日(driver_check_in/driver_check_out)は別の概念です。混同せずそれぞれ正しいフィールドに振り分けてください。
3. 日付に年が明記されていない場合は、同じ文書内の他の日付と同じ年を採用して補ってください。
4. 宿泊料金はdriver_hotel_amountに入れ、バス自体の金額(amount)とは区別してください。
statusは予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 仕入明細（請求書）テキスト解析モード
    if (invoiceText) {
      const data = await callClaude([{
        type: 'text',
        text: `以下の請求書・仕入明細書から費用明細を抽出してJSON配列で返してください。
各費用項目を1つのオブジェクトとして配列に含めてください。
フィールド：supplier_name(請求書の発行元・支払先の会社名、不明は空文字), ref_no(ツアー番号・REF#・KICコード等、行またはブロックに記載があれば抽出、なければ空文字), expense_date(費用日付・YYYY-MM-DD形式、不明は空文字), content(費用内容・品目名), category(区分：「D（ドライバー）」「ゲスト」「ゲスト・TG」「その他」のいずれか), unit_price(単価・数値・円、不明は0), qty(数量・数値、不明は1), amount(合計金額・数値・円、不明は0), payment_method(支払方法：「現地払い」「前振込み」「後請求」「全旅クーポン」のいずれか、請求書の場合は「後請求」)
ツアーコードは「KIC1154」「#1154」の形式が多いですが、「852_KK」のような「数字_英字」形式（KICプレフィックスが省略された短縮形）で記載される場合もあります。こうした短縮形も必ずref_noとして抽出してください。
categoryは費用内容から推測してください（ドライバー関連費用は「D（ドライバー）」、入場料・食事等のゲスト費用は「ゲスト」等）。
出力は配列ではなく、以下の形式のJSONオブジェクトとしてください：
{"items": [各費用項目の配列（フィールドは上記の通り）], "invoice_total_amount": 請求書に記載されている合計の振込金額・お支払い金額（数値、見当たらなければ0）}
invoice_total_amountには、個々の明細の合計ではなく、請求書自体に印字されている「合計金額」「お振込金額」「TOTAL AMOUNT」等の総額の数字を、そのまま抽出してください（コミッション控除後の金額があればその総額を使用）。
JSONのみ返し、説明文・コードブロック記号は不要です。

${invoiceText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // 仕入明細（請求書）PDF解析モード
    if (invoicePdfBase64) {
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: invoicePdfBase64 } },
        { type: 'text', text: `このPDFから費用明細を抽出してJSON配列で返してください。
各費用項目を1つのオブジェクトとして配列に含めてください。
フィールド：supplier_name(請求書の発行元・支払先の会社名、不明は空文字), ref_no(ツアー番号・REF#・KICコード等、行またはブロックに記載があれば抽出、なければ空文字), expense_date(費用日付・YYYY-MM-DD形式、不明は空文字), content(費用内容・品目名), category(区分：「D（ドライバー）」「ゲスト」「ゲスト・TG」「その他」のいずれか), unit_price(単価・数値・円、不明は0), qty(数量・数値、不明は1), amount(合計金額・数値・円、不明は0), payment_method(支払方法：「現地払い」「前振込み」「後請求」「全旅クーポン」のいずれか、請求書の場合は「後請求」)
ツアーコードは「KIC1154」「#1154」の形式が多いですが、「852_KK」のような「数字_英字」形式（KICプレフィックスが省略された短縮形）で記載される場合もあります。こうした短縮形も必ずref_noとして抽出してください。
categoryは費用内容から推測してください。
出力は配列ではなく、以下の形式のJSONオブジェクトとしてください：
{"items": [各費用項目の配列（フィールドは上記の通り）], "invoice_total_amount": 請求書に記載されている合計の振込金額・お支払い金額（数値、見当たらなければ0）}
invoice_total_amountには、個々の明細の合計ではなく、請求書自体に印字されている「合計金額」「お振込金額」「TOTAL AMOUNT」等の総額の数字を、そのまま抽出してください（コミッション控除後の金額があればその総額を使用）。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 仕入明細（請求書）画像解析モード
    if (invoiceImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: invoiceImageMediaType || 'image/jpeg', data: invoiceImageBase64 } },
        { type: 'text', text: `この請求書画像から費用明細を抽出してJSON配列で返してください。
各費用項目を1つのオブジェクトとして配列に含めてください。
フィールド：supplier_name(請求書の発行元・支払先の会社名、不明は空文字), ref_no(ツアー番号・REF#・KICコード等、行またはブロックに記載があれば抽出、なければ空文字), expense_date(費用日付・YYYY-MM-DD形式、不明は空文字), content(費用内容・品目名), category(区分：「D（ドライバー）」「ゲスト」「ゲスト・TG」「その他」のいずれか), unit_price(単価・数値・円、不明は0), qty(数量・数値、不明は1), amount(合計金額・数値・円、不明は0), payment_method(支払方法：「現地払い」「前振込み」「後請求」「全旅クーポン」のいずれか、請求書の場合は「後請求」)
ツアーコードは「KIC1154」「#1154」の形式が多いですが、「852_KK」のような「数字_英字」形式（KICプレフィックスが省略された短縮形）で記載される場合もあります。こうした短縮形も必ずref_noとして抽出してください。
categoryは費用内容から推測してください。
出力は配列ではなく、以下の形式のJSONオブジェクトとしてください：
{"items": [各費用項目の配列（フィールドは上記の通り）], "invoice_total_amount": 請求書に記載されている合計の振込金額・お支払い金額（数値、見当たらなければ0）}
invoice_total_amountには、個々の明細の合計ではなく、請求書自体に印字されている「合計金額」「お振込金額」「TOTAL AMOUNT」等の総額の数字を、そのまま抽出してください（コミッション控除後の金額があればその総額を使用）。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 名刺OCRモード
    const images = Array.isArray(variants) && variants.length > 0 ? variants : (base64 ? [base64] : []);
    if (images.length === 0) {
      return res.status(400).json({ error: '画像データがありません' });
    }

    // Stage0: 向き判定
    const orientationResults = await Promise.all(images.map(async (b64) => {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: b64 } },
        { type: 'text', text: 'この画像は正しい向きで表示されていますか？テキストが読める正立した状態であれば「はい」、そうでなければ「いいえ」とだけ答えてください。' }
      ], 10);
      const txt = (data.content?.[0]?.text || '').toLowerCase();
      return txt.includes('はい') || txt.includes('yes');
    }));

    let selectedBase64 = images[0];
    const correctIdx = orientationResults.findIndex(v => v);
    if (correctIdx >= 0) selectedBase64 = images[correctIdx];

    // Stage1: テキスト書き起こし
    const stage1 = await callClaude([
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: selectedBase64 } },
      { type: 'text', text: `この名刺画像に書かれているテキストをすべてそのまま書き出してください。
- 日本語・英語・数字・記号をすべて含めてください
- レイアウトや改行も可能な限り再現してください
- 読み取れない文字は「?」としてください
- 余計な説明は不要です` }
    ], 1000);
    const rawText = stage1.content?.[0]?.text || '';

    // Stage2: JSON整形
    const stage2 = await callClaude([{
      type: 'text',
      text: `以下の名刺テキストからJSON形式で情報を抽出してください。
テキスト：
${rawText}

抽出するフィールド：
- company_name: 会社名（日本語）
- company_name_en: 会社名（英語）
- branch_name: 支店・部署名
- contact_person: 担当者名（日本語）
- contact_person_en: 担当者名（英語）
- position: 役職（日本語）
- position_en: 役職（英語）
- company_phone: 会社電話番号
- phone: 携帯電話番号
- fax: FAX番号
- email: メールアドレス
- address: 住所（日本語）
- address_en: 住所（英語）
- category: ホテル/レストラン/バス・ハイヤー等/その他 のいずれか

ルール：
- 日本語表記が名刺上に存在しない場合はcompany_nameは空文字にし、company_name_enにのみ英語表記を入れること
- JSONのみ返し、説明文・コードブロック記号は不要`
    }], 1000);

    return res.status(200).json(stage2);

  } catch (e) {
    // PasswordRequiredError / InvalidPasswordError（lib/protected-file.js）はここで検知し、
    // フロントエンドがパスワード入力欄を出し分けられる専用のエラーコードとして返す。
    // パスワードの値自体はここでもログに出力しない。
    if (e && (e.code === 'password_required' || e.code === 'invalid_password')) {
      return res.status(400).json({ error: e.code });
    }
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}