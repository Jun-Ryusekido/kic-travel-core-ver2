export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { base64, mediaType } = req.body;

    if (!base64) {
      return res.status(400).json({ error: '画像データがありません' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'サーバー側にAPIキーが設定されていません' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'この名刺画像から、会社名・拠点名/支店名・担当者名・役職・会社電話番号・担当者携帯番号・FAX番号・メール・住所を読み取り、以下のJSON形式のみで返答してください。情報が読み取れない項目は空文字にしてください。前置きや説明文、マークダウンのコードブロック記号は一切含めないでください。\n{"company_name":"","branch_name":"","contact_person":"","position":"","company_phone":"","phone":"","fax":"","email":"","address":""}' }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return res.status(response.status).json({ error: 'Anthropic APIエラー: ' + errText });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (e) {
    console.error('extract-card error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}