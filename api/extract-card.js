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
    const promptText = 'この名刺画像から、会社名・拠点名/支店名・担当者名・役職・会社電話番号・担当者携帯番号・FAX番号・メール・住所・取引先の業種カテゴリを読み取り、以下のJSON形式のみで返答してください。\n\n重要な注意事項:\n- company_name・branch_name・contact_person・positionには、名刺に印字されている日本語表記を入れてください。\n- company_name_en・branch_name_en・contact_person_en・position_enには、名刺に印字されている英語（ローマ字）表記のみを入れてください。名刺に英語表記が無い場合は空文字にしてください。日本語から英語への翻訳や推測による生成は行わないでください。\n- 担当者名の英語表記がローマ字氏名として印字されている場合はそれを使ってください。\n- contact_personの読み取りは特に慎重に行ってください。一般的でよく見る日本人の苗字（例: 加藤、斎藤、佐藤など）に引きずられて読み間違えないよう、名刺に実際に印字されている文字の形を一画ずつ正確に確認してください。氏名は外国人名や珍しい姓である可能性も十分にあります。会社名・部署名・ロゴと個人名を混同しないでください。会社名は通常ロゴや見出し位置に、個人名は肩書（役職）の近くに記載されています。\n- address・address_enについても同様に、addressには日本語表記の住所を、address_enには英語（ローマ字）表記の住所を入れてください。名刺に片方しか無い場合は、ある方だけを埋め、もう片方は空文字にしてください。\n- categoryには、会社名・ロゴ・住所・記載内容から判断して、必ず次の4つのうちいずれか1つだけを入れてください: "ホテル", "レストラン", "バス・ハイヤー等", "その他"。ホテルチェーン名（Hilton, Marriott, Sheraton, Hyatt等）や宿泊施設はホテル、飲食店・カフェ・料理ジャンル名（インド料理、寿司、カレー等）はレストラン、運輸・交通・タクシー・バス会社はバス・ハイヤー等、それ以外や判断できない場合はその他としてください。\n- 情報が読み取れない項目は空文字にしてください。\n- 前置きや説明文、マークダウンのコードブロック記号は一切含めないでください。\n\n{"company_name":"","company_name_en":"","branch_name":"","branch_name_en":"","contact_person":"","contact_person_en":"","position":"","position_en":"","company_phone":"","phone":"","fax":"","email":"","address":"","address_en":"","category":""}';
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
            { type: 'text', text: promptText }
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