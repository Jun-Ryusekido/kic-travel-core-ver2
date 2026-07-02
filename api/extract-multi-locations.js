export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { base64, mediaType } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'サーバー側にAPIキーが設定されていません' });
    }
    if (!base64) {
      return res.status(400).json({ error: '画像データがありません' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 }
            },
            {
              type: 'text',
              text: `この画像には複数の拠点（ホテル・バス会社・レストラン等の各支店や施設）の連絡先情報が記載されています。
各拠点の情報を1件ずつ読み取り、以下の形式でまとめてください。

出力形式（拠点ごとに「---」で区切る）：
---
拠点名：
住所：
電話番号：
FAX番号：
その他：
---

・記載がない項目は空欄のままにしてください
・拠点名が不明な場合は「（不明）」としてください
・日本語で出力してください
・コードブロックや余分な説明は不要です。上記フォーマットのテキストのみ返してください`
            }
          ]
        }]
      })
    });

    const data = await r.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'API error' });
    }
    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
