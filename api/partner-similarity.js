export const config = { runtime: 'edge' };

// 取引先マスタの類似検出(findDuplicatePartner、完全一致。index.html参照)で見つからなかった
// 場合に、AI(Claude API)で「表記は違うが同一会社の可能性が高い」候補を判定する補助エンドポイント。
// api/ai-inbox.js の handleClassify(メール関連性判定)と同じ「バッチ・JSON入出力・
// 軽量モデル」パターンに準拠している。
//
// 重要: このエンドポイントはDBへの書き込みを一切行わない。判定結果はあくまで
// index.html側が候補提示にのみ使い、実際のマージは必ず人間の確認・確定操作
// (マージボタン)を経てから別途行われる(findSimilarPartnerWithAi/recordPartnerMergeLearning
// 参照)。
//
// コスト・レイテンシ対策として、呼び出し元(index.html側のgetAiSimilarityCandidates、
// bigram Jaccard類似度による絞り込み)で数件〜十数件程度に絞り込んだ候補のみを
// ここに渡す想定(このエンドポイント自体もoptionsを最大20件に強制的に切り詰める)。
//
// 入力: { candidate: {companyName, companyNameEn, category}, options: [{id, companyName, companyNameEn, category}, ...] }
// 出力: { results: [{id, same: true|false}] }（inputのoptions全件について必ず1件ずつ返す。
//        AIの応答に欠落・不備がある候補はsame:falseにフォールバックする）
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  try {
    const body = await req.json();
    const candidate = body && body.candidate;
    const options = Array.isArray(body && body.options) ? body.options.slice(0, 20) : [];
    if (!candidate || !options.length) {
      return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    const optionsText = options.map((o, i) =>
      `--- 候補${i + 1} (id: ${o.id}) ---\n会社名: ${String(o.companyName || '').slice(0, 200)}\n会社名(英語): ${String(o.companyNameEn || '').slice(0, 200)}\n種別: ${String(o.category || '').slice(0, 60)}`
    ).join('\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text', text: `あなたは旅行会社の取引先マスタ(ホテル・バス会社・レストラン・観光施設等)の重複登録を
防ぐアシスタントです。これから新規登録しようとしている会社と、既存の登録候補一覧を渡します。
それぞれの候補について、新規登録しようとしている会社と「実在する同一の会社(法人格の有無・
日本語/英語表記の違い・略称・語順違い等の表記ゆれのみ)」を指しているかどうかを判定してください。

重要な注意点:
- 「Hotel」「Bus」「Tour」等の業種を表す一般的な単語が共通しているだけでは同一会社とは
  判定しないでください。あくまで固有の会社名・ブランド名・チェーン名が実質的に同一かどうかで
  判断してください(例:「HOTバス」と「〇〇ホテル」はどちらも英字表記に"hot"やHotelを含み
  ますが全くの別会社です。一方、「本四バス開発株式会社」と「本四バス開発」は法人格の
  有無だけの違いで同一会社です)。
- 種別(ホテル/バス・ハイヤー等/レストラン等)が明らかに異なる場合は、通常は別会社と
  判定してください。
- 迷う場合は false(別会社)にしてください。誤って別会社を「同一」と判定すると、無関係な
  取引先データへの誤ったマージ操作をユーザーに促してしまうため、安全側(false)に倒すことを
  最優先してください。

新規登録しようとしている会社:
会社名: ${String(candidate.companyName || '').slice(0, 200)}
会社名(英語): ${String(candidate.companyNameEn || '').slice(0, 200)}
種別: ${String(candidate.category || '').slice(0, 60)}

既存の登録候補一覧:
${optionsText}

JSON配列のみを返してください。他のテキストやマークダウンのコードブロック記法は一切不要です。
出力形式: [{"id":"...","same":true},{"id":"...","same":false}]`
            }
          ]
        }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const errMsg = data?.error?.message || 'Anthropic APIエラー';
      return new Response(JSON.stringify({ error: errMsg }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const text = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
      return new Response(JSON.stringify({ error: 'AIの応答を解析できませんでした' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    // AIの応答に欠落・不備がある候補は安全側(same=false)にフォールバックする。誤って
    // falseの候補をtrueにしてしまう(=無関係な会社をマージ候補として提示してしまう)
    // 事故を避けるため。
    const byId = {};
    (Array.isArray(parsed) ? parsed : []).forEach(r => { if (r && r.id != null) byId[String(r.id)] = r.same === true; });
    const results = options.map(o => ({ id: String(o.id), same: byId[String(o.id)] === true }));
    return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
