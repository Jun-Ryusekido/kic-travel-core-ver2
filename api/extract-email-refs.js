export const config = { runtime: 'edge' };

// html_body(Outlookから取り込んだメール本文のHTML版。埋め込み画像のdata:base64は
// VBA側で事前に除去され、50000文字で切り詰められている)から、赤字・強調表記に
// なっている部分のテキストをAIを使わない正規表現処理で抽出する。
// はやぶさ国際観光バスからの「手配不可の日を赤字で表示します」という注記付きメールで、
// 従来.Body(プレーンテキスト)のみの取り込みではこの色情報が完全に失われ、どの回が
// 手配不可なのか一切判別できなくなっていたことへの対応。
// Outlook/Word生成HTMLはstyle属性の書式に癖があり完全網羅は難しいため、赤系の色指定に
// 絞ってマッチさせる(検知漏れは許容する一方、無関係な文字列に誤って警告が付く方が
// 実害が大きいため、条件はやや厳しめ=falseに倒す)。
// 末尾の rgb(...) は ")" で終わるため \b (単語境界)では次がスペース等の非単語文字だと
// 判定できない(")"も非単語文字のため)。代わりに直後が英数字でないことを見る否定先読みを使う。
const RED_COLOR_ALT = '(?:red|#f00|#ff0000|#e00000|#c00000|#cc0000|#d0021b|rgb\\(\\s*(?:255|2[3-5]\\d)\\s*,\\s*0*\\s*,\\s*0*\\s*\\))';
const NOT_ALNUM_AFTER = '(?![a-zA-Z0-9])';
// 開始タグ自身が赤色指定を持つものだけを対象にする(タグ全体をまず捕まえてから中身を
// 判定する方式だと、色指定の無い外側のタグ(<p>等)がその中に入れ子の赤字<span>を含む
// 場合に、外側のタグとして丸ごと消費されてしまい内側の赤字が検出できなくなるため)。
//
// style属性の引用符は、ダブルクォートとシングルクォートの両方を受け付ける。
// Outlook/Wordが生成するHTMLは style='...' (シングルクォート)が既定であり、さらに
//   style='font-size:11.0pt;font-family:"Yu Gothic",sans-serif;color:red'
// のように値の中にダブルクォートを含むため、ダブルクォートのみを見る実装では実メールの
// 赤字がほとんど検知できなかった(2026-08-14の調査で、単独span・入れ子いずれも
// シングルクォートだと不検知になることを実際に確認した)。
// 引用符の種類ごとに分岐し、それぞれ「同じ種類の引用符が現れるまで」を属性値とみなす
// ([^"]* / [^']*)。両者を1つの文字クラスで済ませようとすると、値の中の別種の引用符で
// 属性値の終端を誤判定するため、必ず分けること。
const RED_OPEN_TAG_RE = new RegExp(
  '<(span|font|p|div|strong|b|em|u|td|li)\\b[^>]*?(?:' +
  'style\\s*=\\s*"[^"]*color\\s*:\\s*' + RED_COLOR_ALT + NOT_ALNUM_AFTER + '[^"]*"' +
  "|style\\s*=\\s*'[^']*color\\s*:\\s*" + RED_COLOR_ALT + NOT_ALNUM_AFTER + "[^']*'" +
  '|color\\s*=\\s*["\']?' + RED_COLOR_ALT + NOT_ALNUM_AFTER +
  ')[^>]*>',
  'gi'
);

function stripHtmlToText(html){
  return String(html||'')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 抽出件数・1件あたりの長さは、AIへの追加コンテキストとしてプロンプトに埋め込む際の
// サイズ(コスト・20秒タイムアウトへの影響)を抑えるため控えめに絞る(30件×200文字。
// はやぶさ国際観光バスの想定ケースのように「30件中の一部だけ赤字」という規模であれば
// 十分カバーできる)。
const MAX_SNIPPETS = 30;
const MAX_SNIPPET_LEN = 200;

function extractRedFlaggedSnippets(htmlBody){
  const html = String(htmlBody || '');
  if(!html) return [];
  const snippets = [];
  const seen = new Set();
  RED_OPEN_TAG_RE.lastIndex = 0;
  let m;
  while((m = RED_OPEN_TAG_RE.exec(html)) && snippets.length < MAX_SNIPPETS){
    const tagName = m[1];
    const openEnd = RED_OPEN_TAG_RE.lastIndex;
    // 対応する終了タグを、直後5000文字の範囲内で探す(見つからなければその範囲を丸ごと
    // 中身とみなす。想定外に長いHTMLでの無限走査を避けるための上限)。
    const rest = html.slice(openEnd, openEnd + 5000);
    const closeMatch = new RegExp('</' + tagName + '\\s*>', 'i').exec(rest);
    const innerHtml = closeMatch ? rest.slice(0, closeMatch.index) : rest.slice(0, 500);
    const plain = stripHtmlToText(innerHtml);
    if(plain && plain.length >= 2 && !seen.has(plain)){
      seen.add(plain);
      snippets.push(plain.slice(0, MAX_SNIPPET_LEN));
    }
  }
  return snippets;
}

export default async function handler(req) {
  if(req.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  // 長文メール(複数ツアーがまとめて書かれた本文等)ではAI応答が遅くなり、Vercel側の
  // 実行時間上限に達すると、このtry/catchを経由しないプラットフォームのエラーページ
  // (HTTP 504)がそのままクライアントに返ってしまう。それより先に自前でタイムアウトさせ、
  // 常に分かりやすいJSONエラーを返すことで、クライアント側の自動フォールバック(通常の
  // 単一送信)がスムーズに機能するようにする。
  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), 20000);
  try{
    const {subject, body, html_body} = await req.json();
    // 色抽出はAI呼び出しの前段でサーバー側の文字列処理だけで完結させる(HTML全体を
    // AIに渡すとコスト増・8000文字上限の問題があるため、渡すのは抽出済みの
    // 短いテキスト断片のみ)。html_bodyが無い(VBA更新前に取り込まれた古いメール等)
    // 場合はこの処理自体をスキップし、既存動作と完全互換にする。
    const redFlaggedSnippets = html_body ? extractRedFlaggedSnippets(html_body) : [];
    const flaggedContextText = redFlaggedSnippets.length
      ? `\n\n参考情報: このメールのHTML版で赤字・強調表示になっていた箇所を(正規表現による簡易抽出のため一部不正確な場合があります)以下に列挙します。各候補のexcerptの内容がこれらのいずれかと重なる場合は is_flagged を true にしてください。重ならない候補は is_flagged を false にしてください。\n${redFlaggedSnippets.map((s,i)=>`(${i+1}) ${s}`).join('\n')}`
      : `\n\n参考情報: 赤字・強調表示の情報はありません。すべての候補について is_flagged は false としてください。`;
    const response = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01'
      },
      signal: controller.signal,
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

各候補には、必ず is_flagged（true/false）のフィールドも含めてください。これは、その候補の
本文中に赤字・強調表示になっている箇所が含まれるかどうかを表します（下記の参考情報を
使って判定してください。参考情報が無い/空の場合は必ず false にしてください）。

JSON配列のみを返してください。他のテキストは一切含めないでください。マークダウンのコードブロック記法（\`\`\`）も不要です。

出力形式の例:
[{"ref_no":"KIC0879_TC","excerpt":"①11月13日 KIC0879_TC ...(該当箇所の本文そのまま)...","is_flagged":false},{"ref_no":"KIC0763_JK","excerpt":"②11月14日〜11月15日 KIC0763_JK ...","is_flagged":true}]

件名: ${subject||''}

本文:
${body||''}${flaggedContextText}`}
          ]
        }]
      })
    });
    clearTimeout(timeoutId);
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
    clearTimeout(timeoutId);
    if(e.name === 'AbortError'){
      return new Response(JSON.stringify({error:'AI応答がタイムアウトしました(本文が長すぎる可能性があります)。しばらく経ってから再度お試しください。'}), {status: 504, headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}
