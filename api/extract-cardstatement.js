export const config = { runtime: 'edge' };

export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const { imageBase64, mediaType, pdfBase64, text: inputText } = await req.json();
    const contentItem = pdfBase64
      ? {type:'document', source:{type:'base64', media_type:'application/pdf', data:pdfBase64}}
      : inputText
      ? {type:'text', text: inputText}
      : {type:'image', source:{type:'base64', media_type:mediaType, data:imageBase64}};
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            contentItem,
            {type:'text', text:'このクレジットカード利用明細から、各取引（利用日・利用店舗名・利用金額）をすべて読み取ってください。複数の取引行がある場合はすべて抽出してください。以下のJSON形式のみで返してください。日付はYYYY-MM-DD形式。金額は数値のみ（カンマ・円記号なし）。読み取れない項目はnullにしてください。他のテキストは一切含めないでください。\n[{"date":"2026-05-20","merchant":"〇〇株式会社","amount":15000},{"date":"2026-05-25","merchant":"△△商店","amount":3200}]'}
          ]
        }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    return new Response(JSON.stringify({text}), {headers:{'Content-Type':'application/json'}});
  } catch(e) {
    return new Response(JSON.stringify({error:e.message}), {status:500, headers:{'Content-Type':'application/json'}});
  }
}
