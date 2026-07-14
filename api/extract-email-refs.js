export const config = { runtime: 'edge' };

export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const {subject, body} = await req.json();
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
            {type:'text', text: `以下は旅行会社宛のメール本文です。1通のメールに複数のツアー・予約についての連絡がまとめて書かれていることがあります。

本文中に含まれる、REF#表記（例: #1374, REF1374）またはKICから始まるツアー番号（例: KIC0879, KIC0879_TC, KIC-0879など表記ゆれを含む）のパターンを漏れなくすべて拾い出してください。
それぞれの番号について、本文中でその番号に対応するセクション（日程・宿泊先・人数・車両など）を、他の番号のセクションを含めないよう正確に区切って抜き出してください。

該当する番号が本文中に1つも見つからない場合は、空配列 [] を返してください。

JSON配列のみを返してください。他のテキストは一切含めないでください。マークダウンのコードブロック記法（\`\`\`）も不要です。

出力形式の例:
[{"ref_no":"KIC0879_TC","excerpt":"①11月13日 KIC0879_TC ...(該当箇所の本文そのまま)..."},{"ref_no":"KIC0763_JK","excerpt":"②11月14日〜11月15日 KIC0763_JK ..."}]

件名: ${subject||''}

本文:
${body||''}`}
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
