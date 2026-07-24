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
            {type:'text', text:`このクレジットカード利用明細から、各取引（利用日・利用店舗名・利用金額）をすべて読み取ってください。複数の取引行がある場合はすべて抽出してください。

【日付の抽出ルール（最重要・厳守）】
- 明細の「ご利用日」欄は「5/21」「05 21」のように月/日のみで年が書かれていないことが多い。この場合、行ごとに実際に印字されている月・日をそのまま読み取り、絶対に他の行と同じ日付を使い回さないこと。1行ごとに個別に読み取ること。
- 年が明記されていない場合は、明細書のヘッダー等に記載された発行年月・請求年月・対象年月（例:「2026年6月分」「ご請求予定日 2026/07/10」等）を探し、そこから各取引の年を推定すること。請求月より後の月（例: 請求が7月分で取引が12月）の場合は前年と判断すること。
- ヘッダーにも年月の手がかりが全く見つからない場合や、年の推定に確信が持てない場合は、絶対に無関係な年（現在の年など）や固定の日付を埋めないこと。その場合は "date" を null にし、"date_raw" に実際に印字されていた文字列（例:"5/21"）をそのまま入れ、"needs_review" を true にすること。
- 全ての行に同一の日付を返すことは、明細の実態と一致しない限り誤りである可能性が非常に高い。行ごとに異なる日付が印字されている場合は、それぞれ正確に区別して抽出すること。

【出力ルール（JSON構文が壊れると読み取り自体が全件失敗するため厳守）】
- 金額は数値のみ（カンマ・円記号なし）
- 店舗名が読み取れない場合はnullにする
- 日付が確実に分かる場合は"date"をYYYY-MM-DD形式にし、"date_raw"はnull、"needs_review"はfalseにする
- "date_raw"や"merchant"の値に、二重引用符(")・バックスラッシュ(\\)・改行がそのまま含まれる場合は、
  必ずJSON文字列として正しくエスケープすること（例: 引用符は\\"、改行は\\nにする）。生の改行文字を
  そのまま値の中に含めてはならない
- 出力は有効なJSON配列そのものだけとし、説明文・注釈・コードブロック記号(\`\`\`)は一切含めないこと
- 他のテキストは一切含めず、以下のJSON形式のみで返すこと

[{"date":"2026-05-20","date_raw":null,"needs_review":false,"merchant":"〇〇株式会社","amount":15000},{"date":null,"date_raw":"5/25","needs_review":true,"merchant":"△△商店","amount":3200}]`}
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
