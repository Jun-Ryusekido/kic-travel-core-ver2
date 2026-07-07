export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { variants, mediaType, base64, hotelText, hotelPdfBase64, hotelImageBase64, hotelImageMediaType, facilityText, facilityPdfBase64, facilityImageBase64, facilityImageMediaType, busText, busPdfBase64, busImageBase64, busImageMediaType, restaurantText, restaurantPdfBase64, restaurantImageBase64, restaurantImageMediaType, invoiceText, invoicePdfBase64, invoiceImageBase64, invoiceImageMediaType } = req.body;
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

    // ホテルテキスト解析モード
    if (hotelText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のホテル予約確認メールや文書からホテル情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo, status
ref_noは文書中のツアーコード・予約番号・REF#・KICから始まる番号等を探してください。見つからない場合は空文字にしてください。
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。

${hotelText}`
      }], 8000);
      return res.status(200).json(data);
    }
// ホテルPDF解析モード
    if (hotelPdfBase64) {
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: hotelPdfBase64 } },
{ type: 'text', text: `このPDFからホテル予約情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
ref_noは文書中のツアーコード・予約番号・REF#・KICから始まる番号等を探してください。見つからない場合は空文字にしてください。
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
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
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 観光施設テキスト解析モード
    if (facilityText) {
      const data = await callClaude([{
        type: 'text',
text: `以下の観光施設・バス駐車場等の手配確認書やメールから情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。

${facilityText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // 観光施設PDF解析モード
    if (facilityPdfBase64) {
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: facilityPdfBase64 } },
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
    if (restaurantText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のレストラン手配確認書やメールからレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。

${restaurantText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // レストランPDF解析モード
    if (restaurantPdfBase64) {
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: restaurantPdfBase64 } },
        { type: 'text', text: `このPDFからレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
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
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // バステキスト解析モード
    if (busText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のバス手配確認書やメールからバス手配情報を抽出してJSON配列で返してください。
各バス手配を1つのオブジェクトとして配列に含めてください。
フィールド：bus_company(バス会社名), bus_type(バスタイプ・車種等), buses(台数・数値), start_date(開始日・YYYY-MM-DD), end_date(終了日・YYYY-MM-DD), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。

${busText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // バスPDF解析モード
    if (busPdfBase64) {
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: busPdfBase64 } },
        { type: 'text', text: `このPDFからバス手配情報を抽出してJSON配列で返してください。
各バス手配を1つのオブジェクトとして配列に含めてください。
フィールド：bus_company(バス会社名), bus_type(バスタイプ・車種等), buses(台数・数値), start_date(開始日・YYYY-MM-DD), end_date(終了日・YYYY-MM-DD), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // バス画像解析モード
    if (busImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: busImageMediaType || 'image/jpeg', data: busImageBase64 } },
        { type: 'text', text: `この画像からバス手配情報を抽出してJSON配列で返してください。
各バス手配を1つのオブジェクトとして配列に含めてください。
フィールド：bus_company(バス会社名), bus_type(バスタイプ・車種等), buses(台数・数値), start_date(開始日・YYYY-MM-DD), end_date(終了日・YYYY-MM-DD), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。日付が不明な場合は空文字にしてください。
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
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}