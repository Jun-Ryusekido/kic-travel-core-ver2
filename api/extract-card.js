export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { variants, mediaType, base64, hotelText, hotelPdfBase64 } = req.body;
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
      return r.json();
    };

    // ホテルテキスト解析モード
    if (hotelText) {
      const data = await callClaude([{
        type: 'text',
        text: `以下のホテル予約確認メールや文書からホテル情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
金額が不明な場合は0、部屋数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。

${hotelText}`
      }], 2000);
      return res.status(200).json(data);
    }
// ホテルPDF解析モード
    if (hotelPdfBase64) {
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: hotelPdfBase64 } },
        { type: 'text', text: `このPDFからホテル予約情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
金額が不明な場合は0、部屋数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 2000);
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