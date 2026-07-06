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
        max_tokens:4000,
        messages:[{
          role:'user',
          content:[
            {type:'image',source:{type:'base64',media_type:mediaType,data:imageBase64}},
            {type:'text',text:'この画像に写っている領収書を読み取ってください。各領収書について以下の情報を抽出し、JSON形式のみで返してください。他のテキストは一切含めないでください。\n\n【抽出ルール】\n番号(no)：領収書に印字または手書きで明記されている番号のみ。連番や推測は不可。書かれていない場合はnullにしてください。\n日付(date)：発行日をYYYY-MM-DD形式で。読み取れない場合はnullにしてください。\n内容(description)：発行元の会社名・店舗名、または購入した商品・サービスの具体的な内容を記載してください。「領収書」「receipt」「レシート」という単語は絶対に内容欄に入れてはいけません。発行元が不明な場合は購入内容を記載し、それも不明な場合は空文字にしてください。\nカテゴリ(category)：「食事代」「交通費」「駐車場代」「高速・有料道路代」「入場料・拝観料」「ガイド費」「宿泊代」「その他」のいずれかを内容から判断して選んでください。\n金額(amount)：合計金額（税込）を数値で。読み取れない場合は0にしてください。\n\n[{"no":"1","date":"2026-05-20","description":"〇〇レストラン 昼食","category":"食事代","amount":3500},{"no":null,"date":"2026-05-21","description":"〇〇駐車場","category":"駐車場代","amount":800}]'}
          ]
        }]
      })
    });
    const data = await response.json();
    if(!response.ok){
      const errMsg = data?.error?.message || 'Anthropic APIエラー';
      return new Response(JSON.stringify({error: errMsg}), {status: 502, headers:{'Content-Type':'application/json'}});
    }
    const text = data.content?.[0]?.text || '';
    if(!text){
      return new Response(JSON.stringify({error: 'AIからの応答が空でした。もう一度お試しください。'}), {status: 502, headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({text}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}