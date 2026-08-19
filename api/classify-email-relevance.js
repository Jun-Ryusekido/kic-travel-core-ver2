export const config = { runtime: 'edge' };

// メール受信箱: 「このメールは宿泊/バス/レストラン等の手配業務に関する実務メールか」を
// バッチでAI判定する。REF#/ツアーコードを含むメールはクライアント側の正規表現で
// 判定済みのため、ここに来るのは番号を含まないメールのみ。
// 入力: {emails: [{id, subject, sender, excerpt}]}（最大50件程度）
// 出力: {results: [{id, category: "related"|"phishing_spam"|"other_irrelevant"}]}
//
// 2026-08-19: 従来はrelated:true/falseの2値だったが、Amazon等のブランドを騙る
// フィッシングメールが「related:false」というだけで、業務メール一覧に無害な無関係
// メール(観光施設のチケット購入通知等)と同列に表示されてしまう問題が起きた。
// 「見落としたくない無関係メール(other_irrelevant、隠さず一覧に残す)」と
// 「見せるべきでない危険なメール(phishing_spam、従来通り隠す)」を区別するため3値化した。
// 判定に迷った場合は最も安全側のrelatedにフォールバックする(誤って隠すより一覧に残す方が安全)。
export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  try{
    const body = await req.json();

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

各メールを「related」「phishing_spam」「other_irrelevant」のいずれか1つに分類してください。

「related」(手配業務に関する実務メール) の例:
- ホテル・旅館への宿泊予約の依頼/回答/変更/キャンセル
- バス会社との配車・見積・行程のやりとり
- レストランの予約・人数変更・メニュー確認
- 観光施設・駐車場・新幹線等の手配に関するやりとり
- ガイド・添乗員の手配ややりとり
- 上記に関する請求書・支払い・予約確認番号の連絡
（いずれも、KICが日本国内のサプライヤーに依頼し、サプライヤー側から回答が来る、またはKICから依頼するという関係）

「phishing_spam」(なりすまし/フィッシング等、実際に開くと危険なもの) の例。このカテゴリは
「明確に危険性がある」ものだけに限定し、単なる無関係メールはother_irrelevantにすること:
- Amazon・Apple・楽天・宅配業者(佐川急便・ヤマト運輸・日本郵便等)等の実在ブランドを名乗るが、
  送信者ドメインが名乗っている会社と食い違う、緊急性を煽ってアカウント確認・支払い情報の
  入力・リンククリックを要求する等、なりすまし/フィッシングの疑いが強いメール
- 実在の配送業者を名乗る再配達・不在通知メールで、送信者ドメインが食い違うもの
- その他、資格情報(パスワード・カード番号等)の入力を促す典型的なフィッシング文面

「other_irrelevant」(上記いずれにも該当しない、単に無関係なメール) の例:
- 社内の他部署とのやりとり・一般的な業務連絡
- 会議・打ち合わせの日程調整
- システム・決済サービス等からの障害通知・メンテナンス通知
- notifications@ / no-reply@ / noreply@ / alerts@ / do-not-reply@ 等の自動送信専用アドレスから届く、
  開発・インフラ・SaaSツール（Vercel・GitHub・AWS・Slack・Stripe等）由来のシステム通知全般
  （デプロイ結果・ビルド成功/失敗、エラー・障害アラート、請求書発行通知、利用量レポート等）。
  件名や本文に「production deployment」「build failed」「deployment failed」のような開発・インフラ
  用語や、数字を含むID・コミットハッシュ・請求書番号等が含まれていても、それらはKICの
  ツアーREF#/ツアーコードとは無関係であり、other_irrelevant として扱うこと
- パスワードの有効期限・アカウント・ログイン等のシステム通知（予約システムからの通知でも、特定のツアーの手配内容でなければ無関係。ただしフィッシングの疑いが強い場合はphishing_spam）
- 広告・メルマガ・セミナー案内（なりすましの疑いが無い、通常の商用配信）
- 商談会・展示会・説明会・イベントの案内や出欠確認（観光業界向けのものであっても、特定のツアーの手配実務でなければ無関係）
- ゴルフコンペ・懇親会・親睦会等のイベント案内
- 観光協会・業界団体等からの一般的なお知らせ・ニュースレター（特定の予約に紐づかないもの）
- 個人的な連絡
- 海外の現地旅行社・ランドオペレーター・OTA等の海外パートナーから、KICに対して見積り依頼・予約確認依頼・コスティング依頼が来ているメール（送信者ドメインが海外の旅行会社らしいもの、"Booking Confirmation Required"「Please share cost」等でKICに対して依頼・要求してくる内容のもの）。これはKICが「手配を依頼される側」の営業・パートナー間のやりとりであり、この受信箱が対象とする「KICが国内サプライヤーに手配を依頼するやりとり」とは方向が逆であるため無関係として扱う
- 実在の配送業者からの正規の再配達・不在通知メールで、なりすましの疑いが無いもの（手配業務とは無関係だが危険性も無いためother_irrelevant）
- pr@ / support@ / no-reply@ / news@ / newsletter@ 等、一斉配信専用のアドレスから送られた、製品・サービス・イベントの案内。ただし本文の内容が特定の取引先との具体的な予約・手配のやり取り（実在の担当者名・確認番号等を伴う）であれば related としてよい

重要: 「観光」「ホテル」「旅行」等の単語が含まれていても、それが日本国内サプライヤーとの具体的な手配のやりとりでなければrelatedではありません。判断基準は「このメールに対応しないと、実際のツアー運行に支障が出るか」、かつ「KICが国内サプライヤーに依頼する/サプライヤーから回答が来る、という向きのやりとりか」です。

迷った場合はrelatedにしてください（誤って実務メールを除外するより、一覧に残る方が安全です）。ただし、なりすまし/フィッシングの疑いが明確な場合はphishing_spamに、配送業者の正規の再配達通知・pr@やno-reply@等からの一斉配信・広告/セミナー案内であることが明確な場合はother_irrelevantにしてください。これらは「迷っている」には該当しません。phishing_spamは危険性が明確な場合のみに限定し、単なる広告等はother_irrelevantとすること。

JSON配列のみを返してください。他のテキストやマークダウンのコードブロック記法は一切不要です。
出力形式: [{"id":"...","category":"related"},{"id":"...","category":"phishing_spam"},{"id":"...","category":"other_irrelevant"}]

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
    // AIの応答がcategory以外の想定外の値/欠落の場合は、安全側(related=表示する)にフォールバック。
    // 誤ってphishing_spam/other_irrelevantに倒して隠してしまうより、常に一覧に残す方を優先する。
    const results = (Array.isArray(parsed) ? parsed : [])
      .filter(r=>r && r.id != null)
      .map(r=>{
        const c = r.category;
        const category = (c === 'phishing_spam' || c === 'other_irrelevant') ? c : 'related';
        return {id: String(r.id), category};
      });
    return new Response(JSON.stringify({results}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}
