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

    const step1Lines = [
      '最優先事項: あなたは名刺の文字を一字一句正確に読み取る専門家です。',
      'この名刺画像に印字されている内容を、見えたとおりにそのまま書き出してください。',
      '',
      '手順:',
      '1. まず名刺のレイアウト全体を確認してください。',
      '会社名・ロゴは通常上部や目立つ位置、個人名は役職の近く、',
      '住所・電話番号は下部や端に記載されることが多いです。',
      '2. 会社名（日本語・英語/ローマ字の両方があれば両方）、拠点名/支店名、',
      '担当者氏名（日本語・ローマ字）、役職、会社電話番号、携帯電話番号、',
      'FAX番号、メールアドレス、住所（日本語・英語）を、見える範囲でそのまま書き出してください。',
      '3. 文字が不鮮明、または判読に自信が持てない箇所は「読み取り不可」と明記してください。',
      '似ていそうな実在の会社名・人名・施設名を推測で当てはめることは絶対にしないでください。',
      '特に担当者氏名は、よくある日本人の苗字（加藤、斎藤、佐藤等）に引きずられず、',
      '実際に見える字形を正確に書き写してください。',
      '4. 最後に、この名刺の業種（ホテル/宿泊施設、レストラン/飲食店、',
      'バス・タクシー・運輸会社、その他のいずれか）を、ロゴ・会社名・住所等から判断して記載してください。',
      '',
      '前置きや結論は不要です。書き出した内容のみ出力してください。'
    ];
    const step1Prompt = step1Lines.join('\n');

    const step1Response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: step1Prompt }
          ]
        }]
      })
    });

    if (!step1Response.ok) {
      const errText1 = await step1Response.text();
      console.error('Anthropic API error step1:', errText1);
      const msg1 = 'Anthropic APIエラー(読み取り): ' + errText1;
      return res.status(step1Response.status).json({ error: msg1 });
    }

    const step1Data = await step1Response.json();
    const step1Blocks = step1Data.content || [];
    let transcription = '';
    for (let i = 0; i < step1Blocks.length; i++) {
      if (step1Blocks[i].type === 'text') {
        transcription = step1Blocks[i].text;
        break;
      }
    }

    const step2Lines = [
      '以下は、ある名刺画像から読み取った内容の書き出しです。',
      'この内容のみを使って、以下のJSON形式に整形してください。',
      '書き出しに含まれていない情報は絶対に補完・推測せず、空文字にしてください。',
      '書き出しの中で「読み取り不可」とされている項目も空文字にしてください。',
      '',
      '重要な注意事項:',
      '- company_name・branch_name・contact_person・positionには日本語表記を、',
      'company_name_en・branch_name_en・contact_person_en・position_enには英語(ローマ字)表記を入れてください。',
      '- address・address_enも同様に日本語表記と英語表記を区別してください。',
      '- categoryには、書き出し内容の業種判定をもとに、必ず次の4つのうちいずれか1つだけを入れてください:',
      '"ホテル", "レストラン", "バス・ハイヤー等", "その他"。',
      '- 前置きや説明文、マークダウンのコードブロック記号は一切含めないでください。',
      'JSON以外は何も出力しないでください。',
      '',
      '---読み取り内容---',
      transcription,
      '---読み取り内容ここまで---',
      '',
      '{"company_name":"","company_name_en":"","branch_name":"","branch_name_en":"","contact_person":"","contact_person_en":"","position":"","position_en":"","company_phone":"","phone":"","fax":"","email":"","address":"","address_en":"","category":""}'
    ];
    const step2Prompt = step2Lines.join('\n');

    const step2Response = await fetch('https://api.anthropic.com/v1/messages', {
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
          content: [{ type: 'text', text: step2Prompt }]
        }]
      })
    });

    if (!step2Response.ok) {
      const errText2 = await step2Response.text();
      console.error('Anthropic API error step2:', errText2);
      const msg2 = 'Anthropic APIエラー(整形): ' + errText2;
      return res.status(step2Response.status).json({ error: msg2 });
    }

    const step2Data = await step2Response.json();
    return res.status(200).json(step2Data);

  } catch (e) {
    console.error('extract-card error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}