export const config = { runtime: 'edge' };

export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const { imageBase64, mediaType, pdfBase64 } = await req.json();
    const contentItem = pdfBase64
      ? {type:'document', source:{type:'base64', media_type:'application/pdf', data:pdfBase64}}
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
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            contentItem,
            {type:'text', text:'この通帳または銀行明細から入金（振込入金・着金）の記録のみを読み取ってください。出金・引き出しは除外してください。各入金について日付・金額・振込元または取引内容を読み取り、以下のJSON形式のみで返してください。日付はYYYY-MM-DD形式。読み取れない項目はnullにしてください。他のテキストは一切含めないでください。\n[{"date":"2026-05-20","amount":1000000,"bank":"〇〇株式会社"},{"date":"2026-05-25","amount":500000,"bank":null}]'}
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
