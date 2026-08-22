export const config = { runtime: 'edge' };

// メール受信箱(index.html)向けのAI処理2種類をまとめたエンドポイント。
//
// 2026-08-22、Vercel Hobbyプランの関数数上限(12本)対策(フェーズ2)のため、旧
// api/classify-email-relevance.js(メールの関連性AI判定)と
// api/extract-email-refs.js(メール本文からのREF#/ツアー番号AI抽出)を1ファイルに
// 統合した。どちらもEdge runtime・Anthropic API呼び出し・メール受信箱1画面専用と
// いう同一グループのため(Edge runtimeはファイル単位の設定のため、Node runtimeの
// 関数とは混在できない=この2つ以外とは統合できない)。
//
// vercel.jsonのrewritesで旧URL(/api/classify-email-relevance, /api/extract-email-refs)
// をそのまま維持しており、index.html側の呼び出しは変更不要
// (?legacyModeクエリパラメータでこのファイル内の処理を振り分ける、
// api/table-crud.jsのlegacyTableと同じ方式)。

// ===== classify: メールの関連性AI判定(旧api/classify-email-relevance.js) =====
// 「このメールは宿泊/バス/レストラン等の手配業務に関する実務メールか」をバッチでAI判定する。
// REF#/ツアーコードを含むメールはクライアント側の正規表現で判定済みのため、ここに来るのは
// 番号を含まないメールのみ。
// 入力: {emails: [{id, subject, sender, excerpt}]}（最大50件程度）
// 出力: {results: [{id, category: "related"|"phishing_spam"|"other_irrelevant"}]}
//
// 2026-08-19: 従来はrelated:true/falseの2値だったが、Amazon等のブランドを騙る
// フィッシングメールが「related:false」というだけで、業務メール一覧に無害な無関係
// メール(観光施設のチケット購入通知等)と同列に表示されてしまう問題が起きた。
// 「見落としたくない無関係メール(other_irrelevant、隠さず一覧に残す)」と
// 「見せるべきでない危険なメール(phishing_spam、従来通り隠す)」を区別するため3値化した。
// 判定に迷った場合は最も安全側のrelatedにフォールバックする(誤って隠すより一覧に残す方が安全)。
async function handleClassify(req) {
  try {
    const body = await req.json();

    const { emails } = body;
    if (!Array.isArray(emails) || emails.length === 0) {
      return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } });
    }
    const list = emails.slice(0, 60).map((m, i) =>
      `--- メール${i + 1} (id: ${m.id}) ---\n送信者: ${String(m.sender || '').slice(0, 120)}\n件名: ${String(m.subject || '').slice(0, 200)}\n本文冒頭: ${String(m.excerpt || '').slice(0, 600)}`
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
              type: 'text', text: `あなたは訪日団体ツアーを扱う旅行会社(KIC Travel)の手配担当アシスタントです。
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

${list}`
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
    // AIの応答がcategory以外の想定外の値/欠落の場合は、安全側(related=表示する)にフォールバック。
    // 誤ってphishing_spam/other_irrelevantに倒して隠してしまうより、常に一覧に残す方を優先する。
    const results = (Array.isArray(parsed) ? parsed : [])
      .filter(r => r && r.id != null)
      .map(r => {
        const c = r.category;
        const category = (c === 'phishing_spam' || c === 'other_irrelevant') ? c : 'related';
        return { id: String(r.id), category };
      });
    return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// ===== extractRefs: メール本文からのREF#/ツアー番号AI抽出(旧api/extract-email-refs.js) =====
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

function stripHtmlToText(html) {
  return String(html || '')
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

function extractRedFlaggedSnippets(htmlBody) {
  const html = String(htmlBody || '');
  if (!html) return [];
  const snippets = [];
  const seen = new Set();
  RED_OPEN_TAG_RE.lastIndex = 0;
  let m;
  while ((m = RED_OPEN_TAG_RE.exec(html)) && snippets.length < MAX_SNIPPETS) {
    const tagName = m[1];
    const openEnd = RED_OPEN_TAG_RE.lastIndex;
    // 対応する終了タグを、直後5000文字の範囲内で探す(見つからなければその範囲を丸ごと
    // 中身とみなす。想定外に長いHTMLでの無限走査を避けるための上限)。
    const rest = html.slice(openEnd, openEnd + 5000);
    const closeMatch = new RegExp('</' + tagName + '\\s*>', 'i').exec(rest);
    const innerHtml = closeMatch ? rest.slice(0, closeMatch.index) : rest.slice(0, 500);
    const plain = stripHtmlToText(innerHtml);
    if (plain && plain.length >= 2 && !seen.has(plain)) {
      seen.add(plain);
      snippets.push(plain.slice(0, MAX_SNIPPET_LEN));
    }
  }
  return snippets;
}

async function handleExtractRefs(req) {
  // 長文メール(複数ツアーがまとめて書かれた本文等)ではAI応答が遅くなり、Vercel側の
  // 実行時間上限に達すると、このtry/catchを経由しないプラットフォームのエラーページ
  // (HTTP 504)がそのままクライアントに返ってしまう。それより先に自前でタイムアウトさせ、
  // 常に分かりやすいJSONエラーを返すことで、クライアント側の自動フォールバック(通常の
  // 単一送信)がスムーズに機能するようにする。
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const { subject, body, html_body } = await req.json();
    // 色抽出はAI呼び出しの前段でサーバー側の文字列処理だけで完結させる(HTML全体を
    // AIに渡すとコスト増・8000文字上限の問題があるため、渡すのは抽出済みの
    // 短いテキスト断片のみ)。html_bodyが無い(VBA更新前に取り込まれた古いメール等)
    // 場合はこの処理自体をスキップし、既存動作と完全互換にする。
    const redFlaggedSnippets = html_body ? extractRedFlaggedSnippets(html_body) : [];
    const flaggedContextText = redFlaggedSnippets.length
      ? `\n\n参考情報: このメールのHTML版で赤字・強調表示になっていた箇所を(正規表現による簡易抽出のため一部不正確な場合があります)以下に列挙します。各候補のexcerptの内容がこれらのいずれかと重なる場合は is_flagged を true にしてください。重ならない候補は is_flagged を false にしてください。\n${redFlaggedSnippets.map((s, i) => `(${i + 1}) ${s}`).join('\n')}`
      : `\n\n参考情報: 赤字・強調表示の情報はありません。すべての候補について is_flagged は false としてください。`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text', text: `以下は旅行会社宛のメール本文です。1通のメールに複数のツアー・予約についての連絡がまとめて書かれていることがあります。

本文中に含まれる、REF#表記（例: #1374, REF1374）またはKICから始まるツアー番号（例: KIC0879, KIC0879_TC, KIC-0879など表記ゆれを含む）のパターンを漏れなくすべて拾い出してください。
それぞれの番号について、本文中でその番号に対応するセクション（日程・宿泊先・人数・車両など）を、他の番号のセクションを含めないよう正確に区切って抜き出してください。

該当する番号が本文中に1つも見つからない場合は、空配列 [] を返してください。

各候補には、必ず is_flagged（true/false）のフィールドも含めてください。これは、その候補の
本文中に赤字・強調表示になっている箇所が含まれるかどうかを表します（下記の参考情報を
使って判定してください。参考情報が無い/空の場合は必ず false にしてください）。

JSON配列のみを返してください。他のテキストは一切含めないでください。マークダウンのコードブロック記法（\`\`\`）も不要です。

出力形式の例:
[{"ref_no":"KIC0879_TC","excerpt":"①11月13日 KIC0879_TC ...(該当箇所の本文そのまま)...","is_flagged":false},{"ref_no":"KIC0763_JK","excerpt":"②11月14日〜11月15日 KIC0763_JK ...","is_flagged":true}]

件名: ${subject || ''}

本文:
${body || ''}${flaggedContextText}`
            }
          ]
        }]
      })
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    if (!response.ok) {
      const errMsg = data?.error?.message || 'Anthropic APIエラー';
      return new Response(JSON.stringify({ error: errMsg }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const text = data.content?.[0]?.text || '';
    if (!text) {
      return new Response(JSON.stringify({ error: 'AIからの応答が空でした。もう一度お試しください。' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ text }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'AI応答がタイムアウトしました(本文が長すぎる可能性があります)。しばらく経ってから再度お試しください。' }), { status: 504, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  // 旧URL(/api/classify-email-relevance, /api/extract-email-refs)はvercel.jsonの
  // rewritesでlegacyModeクエリパラメータを付与してこのファイルへ転送される
  // (api/table-crud.jsのlegacyTableと同じ方式)。Edge runtimeのreqはFetch API標準の
  // Requestのため、req.urlをURLでパースしてクエリパラメータを取り出す。
  const legacyMode = new URL(req.url).searchParams.get('legacyMode');
  if (legacyMode === 'classify') return handleClassify(req);
  if (legacyMode === 'extractRefs') return handleExtractRefs(req);
  return new Response(JSON.stringify({ error: `不明なlegacyModeです: ${legacyMode}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}
