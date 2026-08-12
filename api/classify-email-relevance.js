export const config = { runtime: 'edge' };

// メール受信箱: 「このメールは宿泊/バス/レストラン等の手配業務に関する実務メールか」を
// バッチでAI判定する。REF#/ツアーコードを含むメールはクライアント側の正規表現で
// 判定済みのため、ここに来るのは番号を含まないメールのみ。
// 入力: {emails: [{id, subject, sender, excerpt}]}（最大50件程度）
// 出力: {results: [{id, related: true|false}]}
export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const body = await req.json();

    // ─── mode:'facility-operating-info' ───────────────────────────────────────
    // 観光施設の営業情報(定休日・営業時間・臨時休業)をAIのweb検索で調べる。
    // Vercel Hobbyプランの関数数上限(12本)対策で、役割の近いAI呼び出し系の
    // このエンドポイントにmodeパラメータで同居させる(新規関数は作らない)。
    // 入力: {mode:'facility-operating-info', facilityName, targetDate?}
    // 出力: {info: {regular_closed_days, operating_hours, notes, source_url, confidence}}
    if(body.mode === 'facility-operating-info'){
      const facilityName = String(body.facilityName||'').trim().slice(0,100);
      if(!facilityName) return new Response(JSON.stringify({error:'施設名が指定されていません'}), {status:400, headers:{'Content-Type':'application/json'}});
      const targetDate = String(body.targetDate||'').trim().slice(0,20);
      const targetDateNote = targetDate ? `\n特に「${targetDate}」前後の臨時休業・特別営業の情報があれば必ずnotesに含めてください。` : '';
      const response = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version':'2023-06-01'
        },
        body: JSON.stringify({
          model:'claude-sonnet-4-6',
          max_tokens:2000,
          tools:[{type:'web_search_20250305', name:'web_search', max_uses:4}],
          messages:[{
            role:'user',
            content: `日本の観光施設「${facilityName}」の営業情報をweb検索で調べてください。公式サイトの情報を最優先してください。${targetDateNote}

以下のJSON形式のみで回答してください(マークダウンのコードブロック記法や前置きは一切不要):
{"regular_closed_days":"定休日(例:毎週月曜、年末年始12/29-1/3。無休なら「年中無休」)","operating_hours":"営業時間(例:9:00-17:00、入場は16:30まで)","notes":"臨時休業・改装・特記事項(なければ空文字)","source_url":"根拠にした公式サイト等のURL","confidence":"high または low(公式情報を確認できなければlow)"}

施設が特定できない・情報が見つからない場合は {"error":"情報が見つかりませんでした"} を返してください。`
          }]
        })
      });
      const data = await response.json();
      if(!response.ok){
        const errMsg = data?.error?.message || 'Anthropic APIエラー';
        return new Response(JSON.stringify({error: errMsg}), {status: 502, headers:{'Content-Type':'application/json'}});
      }
      // web検索ツール使用時、contentにはtool_use/tool_result等が混在するため、
      // typeがtextのブロックだけを結合してからJSONを取り出す。
      const text = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
      let parsed;
      try{
        // 応答テキスト中の最初の{...}ブロックを抽出してパースする(前置き文が混ざる場合への保険)
        const m = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse((m ? m[0] : text).replace(/```json|```/g,'').trim());
      }catch(e){
        return new Response(JSON.stringify({error: 'AIの応答を解析できませんでした'}), {status: 502, headers:{'Content-Type':'application/json'}});
      }
      if(parsed.error){
        return new Response(JSON.stringify({error: parsed.error}), {status: 404, headers:{'Content-Type':'application/json'}});
      }
      const info = {
        regular_closed_days: String(parsed.regular_closed_days||'').slice(0,500),
        operating_hours: String(parsed.operating_hours||'').slice(0,500),
        notes: String(parsed.notes||'').slice(0,1000),
        source_url: String(parsed.source_url||'').slice(0,500),
        confidence: parsed.confidence==='low' ? 'low' : 'high',
      };
      return new Response(JSON.stringify({info}), {headers:{'Content-Type':'application/json'}});
    }

    const {emails} = body;
    if(!Array.isArray(emails) || emails.length === 0){
      return new Response(JSON.stringify({results: []}), {headers:{'Content-Type':'application/json'}});
    }
    const list = emails.slice(0, 60).map((m,i)=>
      `--- メール${i+1} (id: ${m.id}) ---\n送信者: ${String(m.sender||'').slice(0,120)}\n件名: ${String(m.subject||'').slice(0,200)}\n本文冒頭: ${String(m.excerpt||'').slice(0,600)}`
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
            {type:'text', text: `あなたは訪日団体ツアーを扱う旅行会社(KIC Travel)の手配担当アシスタントです。
KICは、日本国内のホテル・バス会社・レストラン・観光施設等に対して「手配を依頼する側」です。
この受信箱は、その国内サプライヤーとのやりとりだけを対象としています。
以下の各メールが「手配業務に関する実務メール」かどうかを判定してください。

判定の最上位に置くべき基準: 「KICの実際の取引先(ホテル・バス会社・レストラン・観光施設・
新幹線・ガイド等)との、具体的な予約/手配のやり取りかどうか」。実在する取引先の担当者名や
やり取りの文脈（見積・予約・確認番号・変更・キャンセル等）が読み取れるかを重視してください。
逆に、実在の取引先を装っているだけで内容が一般的な宣伝・通知・なりすましの疑いがあるものは
無関係です。

「手配業務に関する実務メール」(related: true) の例:
- ホテル・旅館への宿泊予約の依頼/回答/変更/キャンセル
- バス会社との配車・見積・行程のやりとり
- レストランの予約・人数変更・メニュー確認
- 観光施設・駐車場・新幹線等の手配に関するやりとり
- ガイド・添乗員の手配ややりとり
- 上記に関する請求書・支払い・予約確認番号の連絡
（いずれも、KICが日本国内のサプライヤーに依頼し、サプライヤー側から回答が来る、またはKICから依頼するという関係）

「無関係」(related: false) の例:
- 社内の他部署とのやりとり・一般的な業務連絡
- 会議・打ち合わせの日程調整
- システム・決済サービス等からの障害通知・メンテナンス通知
- notifications@ / no-reply@ / noreply@ / alerts@ / do-not-reply@ 等の自動送信専用アドレスから届く、
  開発・インフラ・SaaSツール（Vercel・GitHub・AWS・Slack・Stripe等）由来のシステム通知全般
  （デプロイ結果・ビルド成功/失敗、エラー・障害アラート、請求書発行通知、利用量レポート等）。
  件名や本文に「production deployment」「build failed」「deployment failed」のような開発・インフラ
  用語や、数字を含むID・コミットハッシュ・請求書番号等が含まれていても、それらはKICの
  ツアーREF#/ツアーコードとは無関係であり、related: false として扱うこと
- パスワードの有効期限・アカウント・ログイン等のシステム通知（予約システムからの通知でも、特定のツアーの手配内容でなければ無関係）
- 広告・メルマガ・セミナー案内
- 商談会・展示会・説明会・イベントの案内や出欠確認（観光業界向けのものであっても、特定のツアーの手配実務でなければ無関係）
- ゴルフコンペ・懇親会・親睦会等のイベント案内
- 観光協会・業界団体等からの一般的なお知らせ・ニュースレター（特定の予約に紐づかないもの）
- 個人的な連絡
- 海外の現地旅行社・ランドオペレーター・OTA等の海外パートナーから、KICに対して見積り依頼・予約確認依頼・コスティング依頼が来ているメール（送信者ドメインが海外の旅行会社らしいもの、"Booking Confirmation Required"「Please share cost」等でKICに対して依頼・要求してくる内容のもの）。これはKICが「手配を依頼される側」の営業・パートナー間のやりとりであり、この受信箱が対象とする「KICが国内サプライヤーに手配を依頼するやりとり」とは方向が逆であるため無関係として扱う
- 配送業者(佐川急便・ヤマト運輸・日本郵便等)を名乗る再配達・不在通知メール。実在の配送業者からの正規の通知であっても手配業務とは無関係。送信者ドメインが名乗っている会社と食い違う場合はなりすまし/フィッシングの疑いが強く、なおのこと無関係
- pr@ / support@ / no-reply@ / news@ / newsletter@ 等、一斉配信専用のアドレスから送られた、製品・サービス・イベントの案内。ただし本文の内容が特定の取引先との具体的な予約・手配のやり取り（実在の担当者名・確認番号等を伴う）であれば related: true としてよい

重要: 「観光」「ホテル」「旅行」等の単語が含まれていても、それが日本国内サプライヤーとの具体的な手配のやりとりでなければ無関係です。判断基準は「このメールに対応しないと、実際のツアー運行に支障が出るか」、かつ「KICが国内サプライヤーに依頼する/サプライヤーから回答が来る、という向きのやりとりか」です。

迷った場合はrelated: trueにしてください（誤って実務メールを除外するより、無関係メールが一覧に残る方が安全です）。ただし、配送業者の再配達通知・pr@やno-reply@等からの一斉配信・広告/セミナー案内であることが明確な場合は、内容に「観光」「ホテル」等の単語が含まれていても、これは「迷っている」には該当しません。related: false としてください。

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
