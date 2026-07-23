// メール受信箱の「取引先マスタ」カテゴリ専用のAI抽出。
// api/extract-multi-locations.jsと同じ構造だが、入力は画像ではなくメール本文(テキスト)で、
// 抽出対象はbusiness_partners(取引先マスタ)の主要フィールド一式。
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { text } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'サーバー側にAPIキーが設定されていません' });
    }
    if (!text) {
      return res.status(400).json({ error: 'メール本文がありません' });
    }

    const prompt = `以下はホテル・バス会社・レストラン等の取引先(仕入先)からの連絡メールです。
このメールの送信元・署名欄等から、取引先マスタに登録するための情報を抽出してください。

フィールド：
company_name（会社名。日本語表記）
company_name_en（会社名の英語表記、なければ空文字）
branch_name（支店名・営業所名等、なければ空文字）
branch_name_en（支店名の英語表記、なければ空文字）
contact_person（担当者名、なければ空文字）
contact_person_en（担当者名の英語表記、なければ空文字）
position（担当者の役職、なければ空文字）
position_en（役職の英語表記、なければ空文字）
company_phone（会社の代表電話番号、なければ空文字）
phone（担当者の直通・携帯電話番号、なければ空文字）
fax（FAX番号、なければ空文字）
email（担当者またはメール送信元のメールアドレス、なければ空文字）
address（住所。日本語表記、なければ空文字）
address_en（住所の英語表記、なければ空文字）
notes（その他、業種・取扱商品等の参考情報、なければ空文字）

・記載がない項目は空文字にしてください（推測で埋めないでください）
・JSON1件分のオブジェクトのみ返してください（配列にしない）
・JSONのみ返し、コードブロック記号・説明文は不要です

メール本文:
"""
${text}
"""`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'API error' });
    }
    const raw = data.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let partner;
    try { partner = JSON.parse(cleaned); } catch { partner = null; }
    if (!partner || typeof partner !== 'object' || Array.isArray(partner)) {
      return res.status(500).json({ error: 'AIの応答を解析できませんでした' });
    }
    return res.status(200).json({ partner });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
