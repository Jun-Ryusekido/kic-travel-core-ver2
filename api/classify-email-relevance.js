export const config = { runtime: 'edge' };

// メール受信箱: 「このメールは宿泊/バス/レストラン等の手配業務に関する実務メールか」を
// バッチでAI判定する。REF#/ツアーコードを含むメールはクライアント側の正規表現で
// 判定済みのため、ここに来るのは番号を含まないメールのみ。
// 入力: {emails: [{id, subject, excerpt}]}（最大50件程度）
// 出力: {results: [{id, related: true|false}]}
export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const {emails} = await req.json();
    if(!Array.isArray(emails) || emails.length === 0){
      return new Response(JSON.stringify({results: []}), {headers:{'Content-Type':'application/json'}});
    }
    const list = emails.slice(0, 60).map((m,i)=>
      `--- メール${i+1} (id: ${m.id}) ---\n件名: ${String(m.subject||'').slice(0,200)}\n本文冒頭: ${String(m.excerpt||'').slice(0,600)}`
    ).join('\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body: JSON.stringify({
        model:'claude-haiku-4-5',
        max_tokens:2000,
        messages:[{
          role:'user',
          content:[
            {type:'text', text: `あなたは訪日団体ツアーを扱う旅行会社の手配担当アシスタントです。
以下の各メールが「手配業務に関する実務メール」かどうかを判定してください。

「手配業務に関する実務メール」(related: true) の例:
- ホテル・旅館への宿泊予約の依頼/回答/変更/キャンセル
- バス会社との配車・見積・行程のやりとり
- レストランの予約・人数変更・メニュー確認
- 観光施設・駐車場・新幹線等の手配に関するやりとり
- ガイド・添乗員の手配ややりとり
- 上記に関する請求書・支払い・予約確認番号の連絡

「無関係」(related: false) の例:
- 社内の他部署とのやりとり・一般的な業務連絡
- 会議・打ち合わせの日程調整
- システム・決済サービス等からの障害通知・メンテナンス通知
- パスワードの有効期限・アカウント・ログイン等のシステム通知（予約システムからの通知でも、特定のツアーの手配内容でなければ無関係）
- 広告・メルマガ・セミナー案内
- 商談会・展示会・説明会・イベントの案内や出欠確認（観光業界向けのものであっても、特定のツアーの手配実務でなければ無関係）
- ゴルフコンペ・懇親会・親睦会等のイベント案内
- 観光協会・業界団体等からの一般的なお知らせ・ニュースレター（特定の予約に紐づかないもの）
- 個人的な連絡

重要: 「観光」「ホテル」「旅行」等の単語が含まれていても、それが特定のツアー・予約の手配のやりとりでなければ無関係です。判断基準は「このメールに対応しないと、実際のツアー運行に支障が出るか」です。

迷った場合はrelated: trueにしてください（誤って実務メールを除外するより、無関係メールが一覧に残る方が安全です）。

JSON配列のみを返してください。他のテキストやマークダウンのコードブロック記法は一切不要です。
出力形式: [{"id":"...","related":true},{"id":"...","related":false}]

${list}`}
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
    let parsed;
    try{
      parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
    }catch(e){
      return new Response(JSON.stringify({error: 'AIの応答を解析できませんでした'}), {status: 502, headers:{'Content-Type':'application/json'}});
    }
    const results = (Array.isArray(parsed) ? parsed : [])
      .filter(r=>r && r.id != null)
      .map(r=>({id: String(r.id), related: r.related !== false}));
    return new Response(JSON.stringify({results}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}
