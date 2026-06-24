export const config = { runtime: 'edge' };

export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const {imageBase64, mediaType} = await req.json();
    const response = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body: JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens:1000,
        messages:[{
          role:'user',
          content:[
            {type:'image',source:{type:'base64',media_type:mediaType,data:imageBase64}},
            {type:'text',text:'この画像に写っている領収書を読み取ってください。各領収書について番号・日付・内容・カテゴリ・金額を読み取り。番号は領収書に手書きで明記されている場合のみ読み取り、書かれていない場合はnullにしてください、以下のJSON形式のみで返してください。日付はYYYY-MM-DD形式で返してください。日付が読み取れない場合はnullにしてください。日付が読み取れない場合はnullにしてください。日付が読み取れない場合はnullにしてください。カテゴリは「食事代」「交通費」「駐車場代」「高速・有料道路代」「入場料・拝観料」「チップ」「ガイド費」「その他」のいずれかを選んでください。他のテキストは一切含めないでください。\n[{"no":"1","date":"2026-05-20","description":"内容","category":"交通費","amount":1000},{"no":"2","date":null,"description":"内容","category":"その他","amount":2000}]'}
          ]
        }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    return new Response(JSON.stringify({text}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}