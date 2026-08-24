import XLSX from 'xlsx';
import { isPdfEncrypted, decryptPdfToBase64, isExcelEncrypted, decryptExcelToSheetsText } from './lib/protected-file.js';

// 既定のVercelサーバーレス関数タイムアウト(プランによっては10秒程度)では、行数の多い
// Excel/PDFの抽出でAnthropic APIの応答生成が終わる前に関数自体が強制終了してしまうため、
// 明示的に延長する。Hobbyプランでも指定可能な上限値。
export const maxDuration = 60;

// 1通のメールに複数日程・複数ツアー分の予約情報が混在しているケースで、今開いている予約と
// 無関係な行まで抽出されてしまうのを防ぐための日付絞り込み許容日数。
// 日付のズレ・表記ゆれを考慮した仮の値。調整する場合はこの値を変更する。
const DATE_FILTER_TOLERANCE_DAYS = 3;

// PDFがパスワード保護されている場合はpasswordで復号したBase64を返す（保護されていなければそのまま返す）。
// パスワード関連のエラー(PasswordRequiredError/InvalidPasswordError、lib/protected-file.js参照)は
// そのまま呼び出し元(ハンドラ末尾のcatch)に伝播させ、そこで{error:'password_required'}等に変換する。
async function resolvePdfBase64(pdfBase64, password) {
  const buffer = Buffer.from(pdfBase64, 'base64');
  if (!(await isPdfEncrypted(buffer))) return pdfBase64;
  return await decryptPdfToBase64(buffer, password);
}

// クライアント側(SheetJS)でExcelのパスワード保護を検知して解析できなかった場合、
// ファイルの生データ(base64)がここに渡ってくる。パスワードで復号し、各シートをCSVテキスト化する。
// （暗号化されていないのに何らかの理由でクライアント側の解析に失敗していた場合の保険として、
// 実際には暗号化されていなければそのままサーバー側でパースする）
async function resolveExcelText(excelBase64, password) {
  const buffer = Buffer.from(excelBase64, 'base64');
  if (!isExcelEncrypted(buffer)) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map((name) => `[シート: ${name}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n');
  }
  return await decryptExcelToSheetsText(buffer, password);
}

// ホテル/観光施設読み取りプロンプト(text/pdf/image、計6箇所)で同一文言がコピペされて
// いたref_no抽出ルールを1箇所に集約したもの。観光施設側のみ「852_KK」のような
// KICプレフィックス省略の短縮ツアーコードにも対応する追加文が必要なため、
// includeShortCode引数で出し分ける(ホテル側は現状この短縮形への対応文言を含めない、
// 既存プロンプトの挙動をそのまま維持する)。
function buildRefNoExtractionRule(includeShortCode) {
  const base = 'ref_noは文書中のツアーコード・予約番号・REF#・KICから始まる番号等を探してください。集客表等では「団体名」列に「KIC967_TC/SOTC」のような「KIC＋数字＋_＋任意の文字列」形式で記載されることがあり、その場合は数字部分のみをref_noとしてください（例:「KIC967_TC/SOTC」→ref_no:「967」）。';
  const shortCode = includeShortCode ? '「852_KK」のような「数字_英字」形式（KICプレフィックス省略の短縮形）もref_noとして抽出してください。' : '';
  return `${base}${shortCode}見つからない場合は空文字にしてください。`;
}

// YYYY-MM-DD文字列に日数を加減算する(タイムゾーンのズレを避けるためUTCの年月日で計算する)。
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// targetCheckIn/targetCheckOut（今開いている予約のIn-Date/Out-Date）が渡された場合、
// プロンプトに追記する絞り込み指示を組み立てる。どちらも空ならフィルタなし（従来通り全件抽出）。
//
// 以前は基準日(targetCheckIn優先の1点)からの前後DATE_FILTER_TOLERANCE_DAYS日の「近さ」でしか
// 判定しておらず、長期ツアー(例:8日間)の後半区間だけを扱うメール(IN-DATEから離れた日程)が
// 「対象日程に一致しない」として誤って除外され、読み取り自体が失敗する不具合があった
// (2026-08-21、バスタブのテキスト読み取りで実際に発生。ホテル/観光施設/レストランの各
// テキスト読み取りも同じ関数を使っているため同様に影響していた)。targetCheckIn〜
// targetCheckOutの期間そのもの(前後にDATE_FILTER_TOLERANCE_DAYS日の遊びを持たせる)を
// 範囲として明示することで、区間ごとに手配・確認が分かれる長期ツアーにも対応する。
// 片方しか無い場合は、rangeStart/rangeEndの計算式が両方ともtargetCheckIn||targetCheckOutを
// 使うため、自然に「その1点の前後◯日」(従来の点判定)に縮退する。
function buildDateFilterInstruction(fieldLabel, targetCheckIn, targetCheckOut) {
  if (!targetCheckIn && !targetCheckOut) return '';
  const rangeStart = addDaysToDateStr(targetCheckIn || targetCheckOut, -DATE_FILTER_TOLERANCE_DAYS);
  const rangeEnd = addDaysToDateStr(targetCheckOut || targetCheckIn, DATE_FILTER_TOLERANCE_DAYS);
  const periodNote = (targetCheckIn && targetCheckOut && targetCheckIn !== targetCheckOut)
    ? `（この予約自体の対象期間は ${targetCheckIn} 〜 ${targetCheckOut} です。長期ツアーの一部区間だけを扱うメールも対象に含めるため、前後に${DATE_FILTER_TOLERANCE_DAYS}日の余裕を持たせた範囲で判定してください）`
    : '';
  return `

重要（日程の絞り込み）: メール本文に複数の日程・複数の予約情報が含まれる場合、${fieldLabel}が${rangeStart} 〜 ${rangeEnd}の範囲に該当する行のみを抽出してください。${periodNote}それ以外の日程の行は無視してください。該当する行が1件も見つからない場合は、空のJSON配列 [] だけを返してください。`;
}

// ホテル・バス(ドライバー宿泊)のcheck_in/check_outのような「チェックイン・チェックアウトの
// ペア」で日付を抽出するプロンプト(計6箇所: ホテルtext/pdf/image、バスtext/pdf/imageの
// driver_check_in/driver_check_out)で共通して必要な指示。「2026年10月21日〜1泊」のように
// 終了日が明記されず開始日+泊数のみが記載されたテキストで、check_in/check_outが両方
// 空欄のまま抽出されてしまう不具合(2026-08判明)への対策として追加した。バス側は元々
// 「チェックイン/アウト日だけを空欄のままにすることは禁止」という指示はあったが、開始日+
// 泊数から終了日を計算する具体的な方法までは指示されていなかったため、同じ不具合が起き
// 得た。フィールド名は呼び出し元ごとに異なるため引数で受け取る。
function buildStayDurationInstruction(checkInField, checkOutField) {
  return `重要（「開始日＋泊数」形式への対応・必ず守ってください）: 「2026年10月21日〜1泊」「10/21から2泊」のように、終了日が明記されず開始日と泊数(泊)だけが記載されている場合は、${checkOutField} = ${checkInField}の日付に泊数の日数を足した日付、として計算してください（例:「2026年10月21日〜1泊」なら${checkInField}は2026-10-21、${checkOutField}はその1日後の2026-10-22。「10/21から2泊」なら${checkOutField}は2026-10-23）。開始日は読み取れているのに、終了日が「〜YYYY年MM月DD日」のような明記形式で書かれていないという理由だけで${checkInField}・${checkOutField}を空欄のままにすることは禁止です。`;
}

// 観光施設・レストラン・請求書等、単一の日付フィールド(date/expense_date)のみを持つ
// プロンプトで共通して必要な指示。「10月21日〜2日間」のような期間・泊数表記が単一の日付欄に
// 対応する箇所にある場合、開始日・終了日のどちらを採用すべきか曖昧にならないよう、
// 開始日を採用する方針を明記する(buildStayDurationInstructionと同じ不具合調査を踏まえ、
// 単一日付フィールドのプロンプトにも同種の空欄化リスクがあるため追加)。
function buildSingleDateInstruction(dateFieldLabel) {
  return `重要（期間・泊数表記の${dateFieldLabel}欄への反映・必ず守ってください）: 「10月21日〜2日間」「10/21から3泊」のように単一の${dateFieldLabel}に対応する箇所に期間や泊数が記載されている場合は、その期間の開始日を${dateFieldLabel}として採用してください（例:「10月21日〜2日間」なら${dateFieldLabel}は2026-10-21）。終了日が明記されていない、あるいは複数日にまたがるという理由だけで${dateFieldLabel}を空欄のままにすることは禁止です。`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { variants, mediaType, base64, hotelText, hotelPdfBase64, hotelExcelBase64, hotelImageBase64, hotelImageMediaType, facilityText, facilityPdfBase64, facilityExcelBase64, facilityImageBase64, facilityImageMediaType, busText, busPdfBase64, busExcelBase64, busImageBase64, busImageMediaType, restaurantText, restaurantPdfBase64, restaurantExcelBase64, restaurantImageBase64, restaurantImageMediaType, invoiceText, invoicePdfBase64, invoiceExcelBase64, invoiceImageBase64, invoiceImageMediaType, targetCheckIn, targetCheckOut, password,
      bankbookImageBase64, bankbookMediaType, bankbookPdfBase64, bankbookText,
      cardstatementImageBase64, cardstatementMediaType, cardstatementPdfBase64, cardstatementText,
      receiptImageBase64, receiptMediaType,
      multiLocBase64, multiLocMediaType, multiLocReturnJson,
      partnerText } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'サーバー側にAPIキーが設定されていません' });
    }

    // ─── mode:'facility-operating-info'（観光施設の営業情報をAI web検索で調べる） ───
    // 当初はEdgeランタイムのclassify-email-relevance.jsに実装したが、web検索付きの
    // AI呼び出しはEdge関数のタイムアウト(約25秒)を超過することがあり
    // FUNCTION_INVOCATION_TIMEOUTで落ちたため、maxDuration=60を設定済みの
    // このNode.jsランタイム関数へ移動した(2026-08-12)。
    if (req.body.mode === 'facility-operating-info') {
      const facilityName = String(req.body.facilityName || '').trim().slice(0, 100);
      if (!facilityName) return res.status(400).json({ error: '施設名が指定されていません' });
      const targetDate = String(req.body.targetDate || '').trim().slice(0, 20);
      const targetDateNote = targetDate ? `\n特に「${targetDate}」前後の臨時休業・特別営業の情報があれば必ずnotesに含めてください。` : '';
      const opRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
          messages: [{
            role: 'user',
            content: `日本の観光施設「${facilityName}」の営業情報をweb検索で調べてください。公式サイトの情報を最優先してください。${targetDateNote}

以下のJSON形式のみで回答してください(マークダウンのコードブロック記法や前置きは一切不要):
{"regular_closed_days":"定休日(例:毎週月曜、年末年始12/29-1/3。無休なら「年中無休」)","operating_hours":"営業時間(例:9:00-17:00、入場は16:30まで)","notes":"臨時休業・改装・特記事項(なければ空文字)","source_url":"根拠にした公式サイト等のURL","confidence":"high または low(公式情報を確認できなければlow)"}

施設が特定できない・情報が見つからない場合は {"error":"情報が見つかりませんでした"} を返してください。`
          }]
        })
      });
      const opData = await opRes.json().catch(() => null);
      if (!opRes.ok || !opData) {
        return res.status(502).json({ error: opData?.error?.message || 'Anthropic APIエラー' });
      }
      // web検索ツール使用時、contentにはtool_use等が混在するためtextブロックのみ結合
      const opText = (opData.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      let parsed;
      try {
        const m = opText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse((m ? m[0] : opText).replace(/```json|```/g, '').trim());
      } catch (e) {
        return res.status(502).json({ error: 'AIの応答を解析できませんでした' });
      }
      if (parsed.error) return res.status(404).json({ error: parsed.error });
      return res.status(200).json({
        info: {
          regular_closed_days: String(parsed.regular_closed_days || '').slice(0, 500),
          operating_hours: String(parsed.operating_hours || '').slice(0, 500),
          notes: String(parsed.notes || '').slice(0, 1000),
          source_url: String(parsed.source_url || '').slice(0, 500),
          confidence: parsed.confidence === 'low' ? 'low' : 'high',
        }
      });
    }

    const callClaude = async (content, maxTokens) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens || 1000,
          messages: [{ role: 'user', content }]
        })
      });
      const rawText = await r.text();
      let data;
      try{
        data = JSON.parse(rawText);
      }catch(_){
        throw new Error(`Anthropic APIからの応答を解析できませんでした（HTTP ${r.status}）: ${rawText.slice(0,200)}`);
      }
      if(!r.ok){
        throw new Error(data?.error?.message || `Anthropic APIエラー（HTTP ${r.status}）`);
      }
      return data;
    };

    // ─── 通帳OCRモード（旧 /api/extract-bankbook.js を統合。Vercel Hobbyプランの
    // サーバーレス関数数上限(12個)対策で、役割の近いAI抽出系エンドポイントを1つに集約した） ───
    const resolvedBankbookContent = bankbookPdfBase64
      ? {type:'document', source:{type:'base64', media_type:'application/pdf', data:bankbookPdfBase64}}
      : bankbookText
      ? {type:'text', text: bankbookText}
      : bankbookImageBase64
      ? {type:'image', source:{type:'base64', media_type:bankbookMediaType, data:bankbookImageBase64}}
      : null;
    if (resolvedBankbookContent) {
      const data = await callClaude([
        resolvedBankbookContent,
        {type:'text', text:'この通帳または銀行明細から入金（振込入金・着金）の記録のみを読み取ってください。出金・引き出しは除外してください。各入金について日付・金額・振込元または取引内容を読み取り、以下のJSON形式のみで返してください。日付はYYYY-MM-DD形式。読み取れない項目はnullにしてください。他のテキストは一切含めないでください。\n[{"date":"2026-05-20","amount":1000000,"bank":"〇〇株式会社"},{"date":"2026-05-25","amount":500000,"bank":null}]'}
      ], 1000);
      const text = data.content?.[0]?.text || '';
      return res.status(200).json({ text });
    }

    // ─── クレジットカード明細OCRモード（旧 /api/extract-cardstatement.js を統合） ───
    const resolvedCardstatementContent = cardstatementPdfBase64
      ? {type:'document', source:{type:'base64', media_type:'application/pdf', data:cardstatementPdfBase64}}
      : cardstatementText
      ? {type:'text', text: cardstatementText}
      : cardstatementImageBase64
      ? {type:'image', source:{type:'base64', media_type:cardstatementMediaType, data:cardstatementImageBase64}}
      : null;
    if (resolvedCardstatementContent) {
      const todayJstStr = new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Tokyo'}); // YYYY-MM-DD
      const data = await callClaude([
        resolvedCardstatementContent,
        {type:'text', text:`このクレジットカード利用明細から、各取引（利用日・利用店舗名・利用金額）をすべて読み取ってください。複数の取引行がある場合はすべて抽出してください。

【重要な前提】本日は${todayJstStr}です。カード利用日の性質上、この日付より未来の日付が取引日になることは業務上あり得ません（年の判断に迷う場合の参考にしてください）。

【日付の読み取りルール（最重要・厳守）】
このセクションで求めるのは「年・月・日それぞれの生の数字を正しく特定して報告すること」だけです。
和暦から西暦への変換計算（+2018等）は絶対に行わないでください。変換はこの後プログラム側で機械的に
行うため、AIが暗算する必要はありません。暗算はむしろ誤りの原因になるため行わないこと。
- 明細の「ご利用日」欄は「5/21」「05 21」のように月/日のみで年が書かれていないことが多い。この場合、行ごとに実際に印字されている月・日をそのまま読み取り、絶対に他の行と同じ日付を使い回さないこと。1行ごとに個別に読み取ること。
- 【3つの数字が並んでいる場合（重要）】「ご利用日」欄（またはそれに準ずる日付欄）に、区切られた
  数字が2つではなく3つ並んでいる場合（例:「8 6 12」「8/6/12」のように、縦や横に3つの数字が
  近接して印字されている場合）は、それらは[和暦年数][月][日]の3つを表している可能性が高いと
  最優先で疑うこと。3つのうち2つだけを拾って[月][日]と解釈し、残りの1つ（多くの場合は本来の
  「月」）を読み飛ばして無視することは絶対にしてはならない（誤例:「8 6 12」の1つ目の「8」だけを
  月と誤認識してmonth=8, day=12とし、本来の月「6」を失うのは誤り。正しくはera_year_raw=8
  （和暦年数）、month=6、day=12と、3つとも別々の数値として報告すること）。
  - 3つの数字が見つかった場合の対応順序は、原則として[年(和暦想定)]→[月]→[日]とすること。
    ただし明細のヘッダーの表記や他の行・他の列の並び方から、明確に別の順序（例: 年が末尾にある等）
    であると判断できる場合は、その並びに従うこと。
  - この3数字ルールは、下記【和暦/西暦の判別】で説明している「年欄の『8』と月日欄の『5 21』を
    混同して『8521』のような無意味な数値を作らない」という禁止事項とは別のケースである。あちらは
    「年」と「月日」が別々のセル・別々の位置にあるものを安易に連結してはならないという注意であり、
    今回のケースは同じ日付欄の中に3つの数字が実際に年・月・日それぞれとして近接印字されている
    場合を指す。数字が3つ以上並んでいる日付欄では、どの数字を採用しどれを捨てるかを安易に
    判断せず、必ず全ての数字の意味（年・月・日のどれに対応するか）を特定してから、それぞれ
    era_year_raw・month・dayの別々のフィールドに報告すること。
- 年が明記されていない場合は、明細書のヘッダー等に記載された発行年月・請求年月・対象年月（例:「2026年6月分」「ご請求予定日 2026/07/10」等）を探し、そこから各取引の年を推定すること。請求月より後の月（例: 請求が7月分で取引が12月）の場合は前年と判断すること。
- 【和暦/西暦の判別（重要）】クレジットカード会社によっては、年の表記が西暦（2026、桁数4桁）ではなく
  和暦（令和8年、または元号を省略して単に「8」とだけ印字）になっている場合がある。明細ヘッダーの
  発行年月・請求年月の表記（「令和」の文字の有無、年の桁数が1〜2桁か4桁か等）を手がかりに、
  西暦・和暦のどちらの形式で書かれた明細かを最初に判断し、"era_type"に"reiwa"（和暦・令和と判断
  した場合）または"western"（西暦と判断した場合）を入れること。「令和」の文字がなくても、ヘッダーに
  単独で1〜2桁の数字（例:「8」）が年として印字され、他に4桁の西暦表記が見当たらない明細は、
  和暦（元号省略）の可能性が高いと判断してよい（この場合もera_type="reiwa"とする）。
  - 【西暦への変換計算は一切行わないこと（最重要）】"era_year_raw"には、読み取った年の生の数字を
    そのまま入れること。和暦（令和）と判断した場合でも、令和の年数（例:「令和8年」なら8）を
    そのままera_year_rawに入れ、西暦への変換（+2018等の計算）は絶対に行わないこと。西暦と判断
    した場合も、印字されている桁数のまま（2桁なら2桁の数値、4桁なら4桁の数値）era_year_rawに
    入れること。年を西暦の実際の値に変換する処理は全てプログラム側で機械的に行うため、AIは
    「どの数字が年で、それが和暦か西暦か」を判断して報告するところまでで役割は終わりです。
  - 【年・月・日は必ず独立した3つの数値として扱うこと（重要）】「令和8年2月19日」のような表記は、
    必ず「era_year_raw=8」「month=2」「day=19」という3つの別々の数値として抽出すること。年の
    数字と月・日の数字を混ぜたり、逆に月の値を年の数字から流用したりしてはならない
    （誤例:「令和8年2月19日」でmonth=8（元号年数をそのまま流用）としてしまうのは重大な誤り。
    正しくはera_year_raw=8、month=2、day=19と、それぞれ独立に報告すること）。
  - 表のレイアウトによっては「年」の列と「月日」の列が別々のセル・別々の位置に分かれて印字されて
    いることがある。この場合、隣接する数字を安易にそのまま連結してはならない
    （例: 年欄の「8」と月日欄の「5 21」を混同して「8521」のような無意味な数値を作らないこと）。
    必ず表全体の列構造・ヘッダー行（「ご利用日」が年月日のうちどこまでを含む列なのか等）を踏まえて、
    era_year_raw・month・dayを正しく特定すること
- 和暦・西暦のどちらとも判断がつかない場合や、年の数字自体が読み取れない・確信が持てない場合は、
  era_typeを"unknown"にすること。era_year_raw・month・dayも確信の持てる範囲でよく、無理に確定
  させず、確信が持てないものはnullにしてよい。"date_raw"に実際に印字されていた文字列をそのまま
  入れ（列が分かれている場合はそれぞれの値を「/」区切り等で分かる形にして、例:"8/5 21"のように）、
  "needs_review"をtrueにすること。
- 全ての行に同一の年月日を返すことは、明細の実態と一致しない限り誤りである可能性が非常に高い。行ごとに異なる日付が印字されている場合は、それぞれ正確に区別して抽出すること。

【印字かすれ等で年だけ読み取りづらい行の補完（重要）】
- 同一の明細書内であれば、対象期間の年は通常すべての行で共通である。まず明細内の全取引行を
  読み取り、年が明確に確定できた行（ヘッダーの発行年月・請求年月、または鮮明に印字された年数字
  から確信を持って判断できた行）が1件以上あれば、そのera_type・era_year_rawをこの明細書全体の
  「基準年」として扱う。
- 個別の行だけコピー機の印字かすれ・文字欠け等で年の数字（西暦4桁、または和暦の元号年数）が
  薄い・一部欠けている等により確信が持てない場合、その行のmonth・dayは印字されている通りにそのまま
  読み取り、era_type・era_year_rawについてのみ上記の基準年で補完してよい。
- ただし、その行の月が基準年の他の行の月から半年以上離れている場合（年をまたいでいる可能性が
  あるため）は、機械的な年の補完をせず、従来通りera_type・era_year_rawをnull、"needs_review"を
  trueにすること。
- 基準年で補完した行は、era_type・era_year_rawに補完後の値を入れ、"date_raw"には実際に印字されて
  いた通りの文字列（欠けていた年の部分も含め、見えたままの形）を残し、"needs_review"はfalseに
  してよいが、必ず"year_supplemented"をtrueにして、年を基準年から補完したことが分かるようにする
  こと。年の補完を行っていない行は"year_supplemented"をfalseにすること。
- 基準年となる行が1件も明確に判断できない場合（明細内の全行で年が読み取りづらい等）は、
  無理に補完せず、従来通り該当行を個別に"needs_review"true・era_type/era_year_raw共にnullとして
  扱うこと。

【手書き文字の仕分け（最重要・厳守。hint_tour_codeとmemoを取り違えないこと）】
- 明細の各取引行、またはその行の左右・上下の余白に、担当者が手書きで書き込んだ文字が
  存在する場合がある（印字された明細の文字とは筆跡が異なるもの）。この手書き文字は、
  必ず以下の2種類のどちらか一方に厳密に仕分けて出力すること。両方の性質を併せ持つ
  ことはなく、絶対にどちらかである。
  (a) ツアーコード（hint_tour_code）: 「数字＋区切り文字＋英字（ローマ字アルファベット）」
      の形式のみ。区切り文字はアンダースコア(_)・ハイフン(-)・スペースのいずれか
      （例: "851-KK"、"1044-DP"、"961_TC"、"870 TU"）。
  (b) 手書きメモ（memo）: 上記(a)の形式に当てはまらない、ひらがな・カタカナ・漢字を
      含む日本語の走り書き（例:「交通費」「食事代」「倉庫代」「立替」等）。
- 判定手順（この順番を必ず守ること）:
  1. まず、手書き文字にひらがな・カタカナ・漢字が1文字でも含まれていないか確認する。
     1文字でも含まれていれば、それは日本語の手書きメモであり、絶対にhint_tour_codeに
     入れてはならない。必ずmemoに入れること。
  2. 日本語を含まず、数字と英字と区切り文字のみで構成されている場合に限り、
     hint_tour_codeの候補として扱う。
  3. hint_tour_codeに入れる前に、実際に「数字＋区切り文字＋英字」の並びになっているか
     （英字の位置に日本語の崩し字を英字と誤読していないか）を再確認すること。特に、
     読み取りに自信が持てない崩し字・当て字を、無理にアルファベットとして解釈して
     hint_tour_codeへ押し込むことは絶対にしてはならない（誤読の余地がある場合は
     memoへ、あるいは判読不能としてmemoに読み取れた範囲の文字をそのまま入れること）。
- 各取引行について、その行に対応する手書きツアーコードが(a)の形式で読み取れた場合は
  "hint_tour_code"にそのまま（大文字のまま）入れ、その行に対応する日本語の手書きメモが
  (b)として読み取れた場合は"memo"にそのまま（判読できた通りの文字列で）入れること。
  1つの取引行に(a)と(b)の両方が別々に書き込まれている場合は、両方をそれぞれ対応する
  フィールドに入れて構わない。
- 該当する手書きが無い、または薄い・かすれている等で確信が持てない場合は、無理に
  埋めずそれぞれnullにすること（hint_tour_code・memoともに、確信の持てない推測値を
  入れるくらいなら空にする方を優先する）。

【日付読み取りの自信度（date_confidence・重要）】
- 上記で読み取ったera_year_raw/month/dayの数字について、印字のかすれ・折れ・裏写り・手書きでの
  訂正線・数字の一部が他の文字や罫線に隠れている等、読み取りに少しでも迷い・不確実さがあった場合は、
  たとえ最終的にどれかの数字を選んで報告したとしても、必ず"date_confidence"を"low"にすること。
  はっきりくっきりと印字されており、読み違えようがないと確信できる場合のみ"high"にすること。
  （date_confidenceは、era_typeが"reiwa"/"western"のどちらであるか判定できたかどうかとは別の
  軸である。和暦か西暦かは明確に判断できても、肝心の数字自体の読み取りに自信が持てない場合は
  date_confidenceを"low"にすること）
- 基準年からの補完（year_supplemented=true）を行った行のmonth・dayは、実際に印字されている
  月日そのものなので、月日の印字自体がはっきり読めていればdate_confidenceは"high"のままでよい
  （年の補完自体はdate_confidenceを下げる理由にはしない）

【出力ルール（JSON構文が壊れると読み取り自体が全件失敗するため厳守）】
- 金額は数値のみ（カンマ・円記号なし）
- 店舗名が読み取れない場合はnullにする
- "date_confidence"は"high"または"low"を必ず入れること（上記【日付読み取りの自信度】のルールに従う）
- "year_supplemented"は、上記【印字かすれ等で年だけ読み取りづらい行の補完】のルールに従い年を
  基準年から補完した行のみtrue、それ以外（年が最初から明確・needs_review=true等）は必ずfalseにする
- "date_raw"や"merchant"の値に、二重引用符(")・バックスラッシュ(\\)・改行がそのまま含まれる場合は、
  必ずJSON文字列として正しくエスケープすること（例: 引用符は\\"、改行は\\nにする）。生の改行文字を
  そのまま値の中に含めてはならない
- 出力は有効なJSON配列そのものだけとし、説明文・注釈・コードブロック記号(\`\`\`)は一切含めないこと
- 他のテキストは一切含めず、以下のJSON形式のみで返すこと

[{"era_type":"western","era_year_raw":2026,"month":5,"day":20,"date_confidence":"high","date_raw":null,"needs_review":false,"year_supplemented":false,"merchant":"〇〇株式会社","amount":15000,"hint_tour_code":"851_KK","memo":null},{"era_type":"reiwa","era_year_raw":8,"month":6,"day":12,"date_confidence":"high","date_raw":"8 6 12","needs_review":false,"year_supplemented":false,"merchant":"◇◇商店","amount":9800,"hint_tour_code":null,"memo":null},{"era_type":"western","era_year_raw":2026,"month":5,"day":25,"date_confidence":"high","date_raw":"?/5 25","needs_review":false,"year_supplemented":true,"merchant":"□□商事","amount":8400,"hint_tour_code":null,"memo":"交通費"},{"era_type":"reiwa","era_year_raw":8,"month":3,"day":2,"date_confidence":"low","date_raw":"かすれて8?32","needs_review":true,"year_supplemented":false,"merchant":"◎◎ストア","amount":1200,"hint_tour_code":null,"memo":null},{"era_type":"unknown","era_year_raw":null,"month":null,"day":null,"date_confidence":"low","date_raw":"5/25","needs_review":true,"year_supplemented":false,"merchant":"△△商店","amount":3200,"hint_tour_code":null,"memo":null}]`}
      ], 2000);
      const text = data.content?.[0]?.text || '';
      return res.status(200).json({ text });
    }

    // ─── レシートOCRモード（旧 /api/extract-receipt.js を統合。guide.htmlのガイド精算画面から使用） ───
    if (receiptImageBase64) {
      const data = await callClaude([
        {type:'image', source:{type:'base64', media_type:receiptMediaType||'image/jpeg', data:receiptImageBase64}},
        {type:'text', text:'この画像に写っている領収書を読み取ってください。各領収書について以下の情報を抽出し、JSON形式のみで返してください。他のテキストは一切含めないでください。\n\n【抽出ルール】\n番号(no)：領収書に印字または手書きで明記されている番号のみ。連番や推測は不可。書かれていない場合はnullにしてください。\n日付(date)：発行日をYYYY-MM-DD形式で。読み取れない場合はnullにしてください。\n内容(description)：発行元の会社名・店舗名、または購入した商品・サービスの具体的な内容を記載してください。「領収書」「receipt」「レシート」という単語は絶対に内容欄に入れてはいけません。発行元が不明な場合は購入内容を記載し、それも不明な場合は空文字にしてください。\nカテゴリ(category)：「食事代」「交通費」「駐車場代」「高速・有料道路代」「入場料・拝観料」「ガイド費」「宿泊代」「その他」のいずれかを内容から判断して選んでください。\n金額(amount)：合計金額（税込）を数値で。読み取れない場合は0にしてください。\n\n[{"no":"1","date":"2026-05-20","description":"〇〇レストラン 昼食","category":"食事代","amount":3500},{"no":null,"date":"2026-05-21","description":"〇〇駐車場","category":"駐車場代","amount":800}]'}
      ], 4000);
      const text = data.content?.[0]?.text || '';
      if (!text) return res.status(502).json({ error: 'AIからの応答が空でした。もう一度お試しください。' });
      return res.status(200).json({ text });
    }

    // ─── 複数拠点抽出モード（旧 /api/extract-multi-locations.js を統合。取引先マスタ画面から使用） ───
    if (multiLocBase64) {
      const multiLocPrompt = multiLocReturnJson
        ? `この画像には複数の拠点（ホテル・バス会社・レストラン等の各支店や施設）の連絡先情報が記載されています。
各拠点の情報を抽出してJSON配列で返してください。
フィールド：company_name（会社名・拠点名。日本語表記）, company_name_en（会社名・拠点名の英語表記、なければ空文字）, branch_name（支店名・フロア名等、なければ空文字）, address（住所）, company_phone（電話番号）, fax（FAX番号）
・記載がない項目は空文字にしてください
・company_nameは日本語表記のみを入れてください。「チームラボ（Team Lab Borderless)」のように日本語名の後ろに
  英語名が括弧書きで併記されている場合は、括弧内の英語部分をcompany_nameに含めず、company_name_enへ分離してください
  （例：company_name「チームラボボーダレス」、company_name_en「teamLab Borderless」）
・英語表記しか記載が無い場合はcompany_nameを空文字にし、company_name_enに入れてください
・JSONのみ返し、コードブロック記号・説明文は不要です`
        : `この画像には複数の拠点（ホテル・バス会社・レストラン等の各支店や施設）の連絡先情報が記載されています。
各拠点の情報を1件ずつ読み取り、以下の形式でまとめてください。

出力形式（拠点ごとに「---」で区切る）：
---
拠点名：
住所：
電話番号：
FAX番号：
その他：
---

・記載がない項目は空欄のままにしてください
・拠点名が不明な場合は「（不明）」としてください
・日本語で出力してください
・コードブロックや余分な説明は不要です。上記フォーマットのテキストのみ返してください`;
      const data = await callClaude([
        {type:'image', source:{type:'base64', media_type:multiLocMediaType||'image/jpeg', data:multiLocBase64}},
        {type:'text', text: multiLocPrompt}
      ], 2000);
      const raw = data.content?.[0]?.text || '';
      if (multiLocReturnJson) {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        let locations;
        try { locations = JSON.parse(cleaned); } catch { locations = []; }
        if (!Array.isArray(locations)) locations = [];
        return res.status(200).json({ locations });
      }
      return res.status(200).json({ text: raw });
    }

    // ─── 取引先マスタ抽出モード（旧 /api/extract-partner.js を統合。メール本文/Excel/Wordのテキストから） ───
    if (partnerText) {
      const data = await callClaude([{
        type: 'text',
        text: `以下はホテル・バス会社・レストラン等の取引先(仕入先)からの連絡メールです。
このメールの送信元・署名欄等から、取引先マスタに登録するための情報を抽出してください。

フィールド：
company_name（会社名。日本語表記）
company_name_en（会社名の英語表記、なければ空文字）
branch_name（支店名・営業所名等、なければ空文字）
branch_name_en（支店名の英語表記、なければ空文字）
contact_person（担当者名、なければ空文字）
contact_person_en（担当者名の英語表記、なければ空文字）
position（担当者の役職、なければ空文字）
position_en（役職の英語表記、なければ空文字）
company_phone（会社の代表電話番号、なければ空文字）
phone（担当者の直通・携帯電話番号、なければ空文字）
fax（FAX番号、なければ空文字）
email（担当者またはメール送信元のメールアドレス、なければ空文字）
address（住所。日本語表記、なければ空文字）
address_en（住所の英語表記、なければ空文字）
notes（その他、業種・取扱商品等の参考情報、なければ空文字）
category（取引先の業種。会社名・署名・本文の内容から「ホテル」「レストラン」
  「バス・ハイヤー等」のいずれかが明確に読み取れる場合のみその値を、
  判断材料が乏しい・複数の業種にまたがる・確信が持てない場合は
  必ず「その他」にしてください。この4つの文字列以外は返さないこと）

・記載がない項目は空文字にしてください（推測で埋めないでください）
・categoryだけは例外で、必ず「ホテル」「レストラン」「バス・ハイヤー等」「その他」の
  いずれかを入れてください（空文字にしないこと。確信がなければ「その他」）
・重要: メール本文中に自社(KIC Travel、株式会社KIC、ドメインkictravel.jp)の担当者・
  署名が含まれていても、それは取引先ではなく自社スタッフの情報です。取引先として
  抽出すべきなのは、あくまで送信元のホテル・バス会社・レストラン等の相手方企業の
  情報のみです。メール本文が自社スタッフ間のやり取りや自社の署名のみで、取引先と
  呼べる相手方企業の情報が見当たらない場合は、company_name等は全て空文字にしてください
・重要: contact_person/contact_person_en/position/position_enは、メールの送信者自身の
  署名ブロック(本文の末尾付近にある、送信者本人の氏名・役職・連絡先がまとまった箇所)から
  読み取れた場合のみ入力してください。以下は担当者名として絶対に使わないこと:
  (a) 引用返信の宛先表記(「○○様」「Dear ○○」等の宛名)、(b) 本文中で第三者として
  言及されているだけの人名、(c) 過去に引用された別の送信者の署名。判断に迷う場合は
  空文字にしてください（本人の署名かどうか確信が持てないのに推測で人名を埋めないこと）
・phone(携帯番号)・address_en(英語住所)も同様に、送信者本人の署名ブロックに明記
  されている場合のみ入力し、記載がなければ空文字にしてください（他の項目から推測しない）
・JSON1件分のオブジェクトのみ返してください（配列にしない）
・JSONのみ返し、コードブロック記号・説明文は不要です

メール本文:
"""
${partnerText}
"""`
      }], 1500);
      const raw = data.content?.[0]?.text || '';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      let partner;
      try { partner = JSON.parse(cleaned); } catch { partner = null; }
      if (!partner || typeof partner !== 'object' || Array.isArray(partner)) {
        return res.status(500).json({ error: 'AIの応答を解析できませんでした' });
      }
      return res.status(200).json({ partner });
    }

    // ホテルテキスト解析モード（クライアント側でパスワード保護されたExcelを検知できなかった場合、
    // hotelExcelBase64として生データが渡ってくるので、ここでサーバー側で復号してテキスト化する）
    const resolvedHotelText = hotelText || (hotelExcelBase64 ? await resolveExcelText(hotelExcelBase64, password) : '');
    if (resolvedHotelText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のホテル予約確認メールや文書からホテル情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo, status
${buildRefNoExtractionRule(false)}
${buildStayDurationInstruction('check_in', 'check_out')}
Excelから変換されたテキストの場合、「No」「IN」「OUT」「部屋数」等の列名がそのまま並んでいるだけの見出し行や、日付・金額等の実データが一切ない空の行は、ホテル情報として抽出しないでください。
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
重要: 出力は必ずJSON配列そのものだけにしてください。前置き・説明文・注釈・補足・コードブロック記号(\`\`\`)は一切含めないでください。日付形式の説明や注意書きなどの文章も絶対に出力しないでください。出力の最初の文字は必ず[、最後の文字は必ず]にしてください。${buildDateFilterInstruction('チェックイン日(check_in)', targetCheckIn, targetCheckOut)}

${resolvedHotelText}`
      }], 8000);
      return res.status(200).json(data);
    }
// ホテルPDF解析モード
    if (hotelPdfBase64) {
      const resolvedHotelPdfBase64 = await resolvePdfBase64(hotelPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedHotelPdfBase64 } },
{ type: 'text', text: `このPDFからホテル予約情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
${buildRefNoExtractionRule(false)}
${buildStayDurationInstruction('check_in', 'check_out')}
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
重要: 出力は必ずJSON配列そのものだけにしてください。前置き・説明文・注釈・補足・コードブロック記号(\`\`\`)は一切含めないでください。日付形式の説明や注意書きなどの文章も絶対に出力しないでください。出力の最初の文字は必ず[、最後の文字は必ず]にしてください。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // ホテル画像解析モード
    if (hotelImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: hotelImageMediaType || 'image/jpeg', data: hotelImageBase64 } },
        { type: 'text', text: `この画像からホテル予約情報を抽出してJSON配列で返してください。
各ホテルの情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), hotel_name, check_in(YYYY-MM-DD), check_out(YYYY-MM-DD), room_type, rooms(数値), breakfast(true/false), unit_price(数値・円), confirmation_no, memo
${buildRefNoExtractionRule(false)}
${buildStayDurationInstruction('check_in', 'check_out')}
金額が不明な場合は0、部屋数不明は1としてください。
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
重要: 出力は必ずJSON配列そのものだけにしてください。前置き・説明文・注釈・補足・コードブロック記号(\`\`\`)は一切含めないでください。日付形式の説明や注意書きなどの文章も絶対に出力しないでください。出力の最初の文字は必ず[、最後の文字は必ず]にしてください。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 観光施設テキスト解析モード
    const resolvedFacilityText = facilityText || (facilityExcelBase64 ? await resolveExcelText(facilityExcelBase64, password) : '');
    if (resolvedFacilityText) {
      const data = await callClaude([{
        type: 'text',
text: `以下の観光施設・バス駐車場等の手配確認書やメールから情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
${buildRefNoExtractionRule(true)}
${buildSingleDateInstruction('日付(date)')}
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。${buildDateFilterInstruction('日付(date)', targetCheckIn, targetCheckOut)}

${resolvedFacilityText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // 観光施設PDF解析モード
    if (facilityPdfBase64) {
      const resolvedFacilityPdfBase64 = await resolvePdfBase64(facilityPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedFacilityPdfBase64 } },
        { type: 'text', text: `このPDFから観光施設・バス駐車場等の手配情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
${buildRefNoExtractionRule(true)}
${buildSingleDateInstruction('日付(date)')}
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 観光施設画像解析モード
    if (facilityImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: facilityImageMediaType || 'image/jpeg', data: facilityImageBase64 } },
        { type: 'text', text: `この画像から観光施設・バス駐車場等の手配情報を抽出してJSON配列で返してください。
各施設・駐車場等の情報を1つのオブジェクトとして配列に含めてください。
フィールド：ref_no(ツアー番号・予約番号・REF#等), facility_name(施設名・駐車場名等), date(YYYY-MM-DD), pax(人数・数値), amount(金額・数値・円), status, confirmation_no(確認番号), memo(備考)
${buildRefNoExtractionRule(true)}
${buildSingleDateInstruction('日付(date)')}
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // レストランテキスト解析モード
    const resolvedRestaurantText = restaurantText || (restaurantExcelBase64 ? await resolveExcelText(restaurantExcelBase64, password) : '');
    if (resolvedRestaurantText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のレストラン手配確認書やメールからレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), reservation_time(予約時刻・HH:MM形式、不明は空文字), pax(人数・数値), amount(金額・数値・円), status, memo(備考)
${buildSingleDateInstruction('日付(date)')}
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。${buildDateFilterInstruction('日付(date)', targetCheckIn, targetCheckOut)}

${resolvedRestaurantText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // レストランPDF解析モード
    if (restaurantPdfBase64) {
      const resolvedRestaurantPdfBase64 = await resolvePdfBase64(restaurantPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedRestaurantPdfBase64 } },
        { type: 'text', text: `このPDFからレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), reservation_time(予約時刻・HH:MM形式、不明は空文字), pax(人数・数値), amount(金額・数値・円), status, memo(備考)
${buildSingleDateInstruction('日付(date)')}
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // レストラン画像解析モード
    if (restaurantImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: restaurantImageMediaType || 'image/jpeg', data: restaurantImageBase64 } },
        { type: 'text', text: `この画像からレストラン手配情報を抽出してJSON配列で返してください。
各レストランを1つのオブジェクトとして配列に含めてください。
フィールド：restaurant_name(店名), meal_type(食事種別：「朝食」「昼食」「夕食」のいずれか), date(日付・YYYY-MM-DD), reservation_time(予約時刻・HH:MM形式、不明は空文字), pax(人数・数値), amount(金額・数値・円), status, memo(備考)
${buildSingleDateInstruction('日付(date)')}
statusは「手配OK」または「問い合わせ中」のいずれかを入れてください。予約確定・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、人数不明は0としてください。日付が不明な場合は空文字にしてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // バステキスト解析モード
    const resolvedBusText = busText || (busExcelBase64 ? await resolveExcelText(busExcelBase64, password) : '');
    if (resolvedBusText) {
      const data = await callClaude([{
        type: 'text',
text: `以下のバス手配確認書やメール（バス手配とドライバー宿泊予約の両方が含まれる場合があります）からバス手配情報を抽出してJSON配列で返してください。
各バス手配を1つのオブジェクトとして配列に含めてください。

フィールド一覧：
- bus_company: バス会社名
- bus_type: バスタイプ・車種等
- buses: 台数（数値）
- start_date: バスの運行開始日（YYYY-MM-DD）
- end_date: バスの運行終了日（YYYY-MM-DD）
- amount: バス代金（数値・円）
- status: 「手配OK」または「問い合わせ中」
- confirmation_no: 確認番号
- driver_hotel_name: ドライバーの宿泊施設名・ホテル名（記載がなければ空文字）
- driver_hotel_phone: 宿泊施設の電話番号（記載がなければ空文字）
- driver_hotel_address: 宿泊施設の住所（記載がなければ空文字）
- driver_check_in: 宿泊のチェックイン日（YYYY-MM-DD、記載がなければ空文字）
- driver_check_out: 宿泊のチェックアウト日（YYYY-MM-DD、記載がなければ空文字）
- driver_hotel_amount: 宿泊料金・支払い金額（数値・円、記載がなければ0）
- memo: 備考

抽出ルール（重要・必ず守ってください）：
1. 文書内に「チェックイン」「IN」「宿泊日」「泊」等の記載や、「チェックアウト」「OUT」「退室日」等の記載があれば、それは必ずdriver_check_in / driver_check_outに入れてください。宿泊施設名・電話番号・住所を抽出できているのに、記載があるチェックイン/アウト日だけを空欄のままにすることは禁止です。
2. バスの運行日(start_date/end_date)と、宿泊のチェックイン/アウト日(driver_check_in/driver_check_out)は別の概念です。文書に両方が記載されている場合は混同せず、それぞれ対応するフィールドに正しく振り分けてください（宿泊日をバスの運行日欄に入れたり、逆にバスの運行日を宿泊日欄に入れたりしないでください）。
3. 日付に年が明記されていない場合は、同じ文書内の他の日付（バス運行日等）と同じ年を採用して補ってください。年が分からないという理由だけで空文字にしないでください。
4. 宿泊料金はdriver_hotel_amountに入れ、バス自体の金額(amount)とは明確に区別してください。
5. 宿泊予約情報が同じメール内の一つのバス手配に対応する場合は同じオブジェクトにまとめ、対応するバス情報が見当たらない場合でも宿泊情報のみのオブジェクトとして1件返してください（その場合bus_company等バス関連フィールドは空文字/デフォルト値で構いません）。
6. 文書内にバス自体の情報(バス会社名・車種・運行日・金額)が一切無く、宿泊情報のみが記載されている場合は、driver_check_in/driver_check_out/driver_hotel_amountに入れた値を、それぞれstart_date/end_date/amountにも同じ値でコピーして入れてください（画面の主要な日付・金額欄が空欄のままだと見落とされるため、両方に入れることが重要です）。
7. 「開始日＋泊数」（例:「2026年10月21日〜1泊」）のように終了日が明記されず開始日と泊数のみが記載されている場合は、driver_check_out = driver_check_inの日付に泊数の日数を足した日付、として計算してください。開始日は読み取れているのに、終了日が明記形式で書かれていないという理由だけでdriver_check_in・driver_check_outを空欄のままにすることは禁止です。

statusは予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。${buildDateFilterInstruction('バスの運行開始日(start_date)', targetCheckIn, targetCheckOut)}

${resolvedBusText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // バスPDF解析モード
    if (busPdfBase64) {
      const resolvedBusPdfBase64 = await resolvePdfBase64(busPdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedBusPdfBase64 } },
        { type: 'text', text: `このPDFからバス手配情報を抽出してJSON配列で返してください（バス手配とドライバー宿泊予約の両方が含まれる場合があります）。
各バス手配を1つのオブジェクトとして配列に含めてください。

フィールド一覧：
- bus_company: バス会社名
- bus_type: バスタイプ・車種等
- buses: 台数（数値）
- start_date: バスの運行開始日（YYYY-MM-DD）
- end_date: バスの運行終了日（YYYY-MM-DD）
- amount: バス代金（数値・円）
- status: 「手配OK」または「問い合わせ中」
- confirmation_no: 確認番号
- driver_hotel_name: ドライバーの宿泊施設名（記載がなければ空文字）
- driver_hotel_phone: 宿泊施設の電話番号（記載がなければ空文字）
- driver_hotel_address: 宿泊施設の住所（記載がなければ空文字）
- driver_check_in: 宿泊のチェックイン日（YYYY-MM-DD、記載がなければ空文字）
- driver_check_out: 宿泊のチェックアウト日（YYYY-MM-DD、記載がなければ空文字）
- driver_hotel_amount: 宿泊料金・支払い金額（数値・円、記載がなければ0）
- memo: 備考

抽出ルール（重要・必ず守ってください）：
1. 文書内にチェックイン・チェックアウトに相当する記載があれば、必ずdriver_check_in / driver_check_outに入れてください。宿泊施設名・電話番号・住所を抽出できているのに、記載があるチェックイン/アウト日だけを空欄のままにすることは禁止です。
2. バスの運行日(start_date/end_date)と宿泊のチェックイン/アウト日(driver_check_in/driver_check_out)は別の概念です。混同せずそれぞれ正しいフィールドに振り分けてください。
3. 日付に年が明記されていない場合は、同じ文書内の他の日付と同じ年を採用して補ってください。
4. 宿泊料金はdriver_hotel_amountに入れ、バス自体の金額(amount)とは区別してください。
5. 文書内にバス自体の情報(バス会社名・車種・運行日・金額)が一切無く、宿泊情報のみが記載されている場合は、driver_check_in/driver_check_out/driver_hotel_amountに入れた値を、それぞれstart_date/end_date/amountにも同じ値でコピーして入れてください。
6. 「開始日＋泊数」（例:「2026年10月21日〜1泊」）のように終了日が明記されず開始日と泊数のみが記載されている場合は、driver_check_out = driver_check_inの日付に泊数の日数を足した日付、として計算してください。開始日は読み取れているのに、終了日が明記形式で書かれていないという理由だけでdriver_check_in・driver_check_outを空欄のままにすることは禁止です。
statusは予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // バス画像解析モード
    if (busImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: busImageMediaType || 'image/jpeg', data: busImageBase64 } },
        { type: 'text', text: `この画像からバス手配情報を抽出してJSON配列で返してください（バス手配とドライバー宿泊予約の両方が含まれる場合があります）。
各バス手配を1つのオブジェクトとして配列に含めてください。

フィールド一覧：
- bus_company: バス会社名
- bus_type: バスタイプ・車種等
- buses: 台数（数値）
- start_date: バスの運行開始日（YYYY-MM-DD）
- end_date: バスの運行終了日（YYYY-MM-DD）
- amount: バス代金（数値・円）
- status: 「手配OK」または「問い合わせ中」
- confirmation_no: 確認番号
- driver_hotel_name: ドライバーの宿泊施設名（記載がなければ空文字）
- driver_hotel_phone: 宿泊施設の電話番号（記載がなければ空文字）
- driver_hotel_address: 宿泊施設の住所（記載がなければ空文字）
- driver_check_in: 宿泊のチェックイン日（YYYY-MM-DD、記載がなければ空文字）
- driver_check_out: 宿泊のチェックアウト日（YYYY-MM-DD、記載がなければ空文字）
- driver_hotel_amount: 宿泊料金・支払い金額（数値・円、記載がなければ0）
- memo: 備考

抽出ルール（重要・必ず守ってください）：
1. 文書内にチェックイン・チェックアウトに相当する記載があれば、必ずdriver_check_in / driver_check_outに入れてください。宿泊施設名・電話番号・住所を抽出できているのに、記載があるチェックイン/アウト日だけを空欄のままにすることは禁止です。
2. バスの運行日(start_date/end_date)と宿泊のチェックイン/アウト日(driver_check_in/driver_check_out)は別の概念です。混同せずそれぞれ正しいフィールドに振り分けてください。
3. 日付に年が明記されていない場合は、同じ文書内の他の日付と同じ年を採用して補ってください。
4. 宿泊料金はdriver_hotel_amountに入れ、バス自体の金額(amount)とは区別してください。
5. 文書内にバス自体の情報(バス会社名・車種・運行日・金額)が一切無く、宿泊情報のみが記載されている場合は、driver_check_in/driver_check_out/driver_hotel_amountに入れた値を、それぞれstart_date/end_date/amountにも同じ値でコピーして入れてください。
6. 「開始日＋泊数」（例:「2026年10月21日〜1泊」）のように終了日が明記されず開始日と泊数のみが記載されている場合は、driver_check_out = driver_check_inの日付に泊数の日数を足した日付、として計算してください。開始日は読み取れているのに、終了日が明記形式で書かれていないという理由だけでdriver_check_in・driver_check_outを空欄のままにすることは禁止です。
statusは予約確定・確認番号あり・手配完了等の表現があれば「手配OK」、見積もり・問い合わせ・検討中等であれば「問い合わせ中」としてください。
金額が不明な場合は0、台数不明は1としてください。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 仕入明細（請求書）テキスト解析モード（Excel由来のテキスト化データもここに合流する）
    const resolvedInvoiceText = invoiceText || (invoiceExcelBase64 ? await resolveExcelText(invoiceExcelBase64, password) : '');
    if (resolvedInvoiceText) {
      const data = await callClaude([{
        type: 'text',
        text: `以下の請求書・仕入明細書から費用明細を抽出してJSON配列で返してください。
各費用項目を1つのオブジェクトとして配列に含めてください。
フィールド：supplier_name(請求書の発行元・支払先の会社名、不明は空文字), ref_no(ツアー番号・REF#・KICコード等、行またはブロックに記載があれば抽出、なければ空文字), expense_date(費用日付・YYYY-MM-DD形式、不明は空文字), content(費用内容・品目名), invoice_no(請求書番号・Invoice No.、記載があれば抽出、なければ空文字), category(区分：「D（ドライバー）」「ゲスト」「ゲスト・TG」「その他」のいずれか), unit_price(単価・数値・円、不明は0), qty(数量・数値、不明は1), amount(合計金額・数値・円、不明は0), payment_method(支払方法：「現地払い」「前振込み」「後請求」「全旅クーポン」のいずれか、請求書の場合は「後請求」)
${buildSingleDateInstruction('費用日付(expense_date)')}
ツアーコードは「KIC1154」「#1154」の形式が多いですが、「852_KK」のような「数字_英字」形式（KICプレフィックスが省略された短縮形）で記載される場合もあります。こうした短縮形も必ずref_noとして抽出してください。
【明細の網羅性・最重要】1枚の請求書に複数の費用行が含まれる場合、絶対に一部の行だけを拾って残りを読み飛ばしてはいけません。特に次のパターンに注意してください：
- 往路・復路や複数区間の運賃がそれぞれ別行で記載されている場合、1行にまとめて合算せず、それぞれ個別のitemsの1要素として抽出してください（例：往路運賃と復路運賃は別々の項目）。
- 本体の運賃とは別に、発券手数料・保管料・送料・消費税等の付随費用が記載されている場合も、可能な限りそれぞれ個別のitemsの1要素として抽出してください。
- 1つの請求書に複数の日付・複数の乗車便（列車番号・区間等）・複数の費用種別が記載されている場合、content欄にそれらを区別できる情報（例：「のぞみ1号 新大阪→広島 往路」「発券手数料」等）を含め、後から見てどの行が何を指すか分かるようにしてください。
- 請求書に記載されている行数・費用種別の総数を数え、抽出したitemsの件数がそれと一致しているか自分で確認してから出力してください。
categoryは費用内容から推測してください（ドライバー関連費用は「D（ドライバー）」、入場料・食事等のゲスト費用は「ゲスト」等）。
出力は配列ではなく、以下の形式のJSONオブジェクトとしてください：
{"items": [各費用項目の配列（フィールドは上記の通り）], "invoice_total_amount": 請求書に記載されている合計の振込金額・お支払い金額（数値、見当たらなければ0）}
invoice_total_amountには、個々の明細の合計ではなく、請求書自体に印字されている「合計金額」「お振込金額」「TOTAL AMOUNT」等の総額の数字を、そのまま抽出してください（コミッション控除後の金額があればその総額を使用）。
JSONのみ返し、説明文・コードブロック記号は不要です。

${resolvedInvoiceText}`
      }], 8000);
      return res.status(200).json(data);
    }

    // 仕入明細（請求書）PDF解析モード
    if (invoicePdfBase64) {
      const resolvedInvoicePdfBase64 = await resolvePdfBase64(invoicePdfBase64, password);
      const data = await callClaude([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resolvedInvoicePdfBase64 } },
        { type: 'text', text: `このPDFから費用明細を抽出してJSON配列で返してください。
各費用項目を1つのオブジェクトとして配列に含めてください。
フィールド：supplier_name(請求書の発行元・支払先の会社名、不明は空文字), ref_no(ツアー番号・REF#・KICコード等、行またはブロックに記載があれば抽出、なければ空文字), expense_date(費用日付・YYYY-MM-DD形式、不明は空文字), content(費用内容・品目名), invoice_no(請求書番号・Invoice No.、記載があれば抽出、なければ空文字), category(区分：「D（ドライバー）」「ゲスト」「ゲスト・TG」「その他」のいずれか), unit_price(単価・数値・円、不明は0), qty(数量・数値、不明は1), amount(合計金額・数値・円、不明は0), payment_method(支払方法：「現地払い」「前振込み」「後請求」「全旅クーポン」のいずれか、請求書の場合は「後請求」)
${buildSingleDateInstruction('費用日付(expense_date)')}
ツアーコードは「KIC1154」「#1154」の形式が多いですが、「852_KK」のような「数字_英字」形式（KICプレフィックスが省略された短縮形）で記載される場合もあります。こうした短縮形も必ずref_noとして抽出してください。
【明細の網羅性・最重要】1枚の請求書に複数の費用行が含まれる場合、絶対に一部の行だけを拾って残りを読み飛ばしてはいけません。特に次のパターンに注意してください：
- 往路・復路や複数区間の運賃がそれぞれ別行で記載されている場合、1行にまとめて合算せず、それぞれ個別のitemsの1要素として抽出してください（例：往路運賃と復路運賃は別々の項目）。
- 本体の運賃とは別に、発券手数料・保管料・送料・消費税等の付随費用が記載されている場合も、可能な限りそれぞれ個別のitemsの1要素として抽出してください。
- 1つの請求書に複数の日付・複数の乗車便（列車番号・区間等）・複数の費用種別が記載されている場合、content欄にそれらを区別できる情報（例：「のぞみ1号 新大阪→広島 往路」「発券手数料」等）を含め、後から見てどの行が何を指すか分かるようにしてください。
- 請求書に記載されている行数・費用種別の総数を数え、抽出したitemsの件数がそれと一致しているか自分で確認してから出力してください。
categoryは費用内容から推測してください。
出力は配列ではなく、以下の形式のJSONオブジェクトとしてください：
{"items": [各費用項目の配列（フィールドは上記の通り）], "invoice_total_amount": 請求書に記載されている合計の振込金額・お支払い金額（数値、見当たらなければ0）}
invoice_total_amountには、個々の明細の合計ではなく、請求書自体に印字されている「合計金額」「お振込金額」「TOTAL AMOUNT」等の総額の数字を、そのまま抽出してください（コミッション控除後の金額があればその総額を使用）。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 仕入明細（請求書）画像解析モード
    if (invoiceImageBase64) {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: invoiceImageMediaType || 'image/jpeg', data: invoiceImageBase64 } },
        { type: 'text', text: `この請求書画像から費用明細を抽出してJSON配列で返してください。
各費用項目を1つのオブジェクトとして配列に含めてください。
フィールド：supplier_name(請求書の発行元・支払先の会社名、不明は空文字), ref_no(ツアー番号・REF#・KICコード等、行またはブロックに記載があれば抽出、なければ空文字), expense_date(費用日付・YYYY-MM-DD形式、不明は空文字), content(費用内容・品目名), invoice_no(請求書番号・Invoice No.、記載があれば抽出、なければ空文字), category(区分：「D（ドライバー）」「ゲスト」「ゲスト・TG」「その他」のいずれか), unit_price(単価・数値・円、不明は0), qty(数量・数値、不明は1), amount(合計金額・数値・円、不明は0), payment_method(支払方法：「現地払い」「前振込み」「後請求」「全旅クーポン」のいずれか、請求書の場合は「後請求」)
${buildSingleDateInstruction('費用日付(expense_date)')}
ツアーコードは「KIC1154」「#1154」の形式が多いですが、「852_KK」のような「数字_英字」形式（KICプレフィックスが省略された短縮形）で記載される場合もあります。こうした短縮形も必ずref_noとして抽出してください。
【明細の網羅性・最重要】1枚の請求書に複数の費用行が含まれる場合、絶対に一部の行だけを拾って残りを読み飛ばしてはいけません。特に次のパターンに注意してください：
- 往路・復路や複数区間の運賃がそれぞれ別行で記載されている場合、1行にまとめて合算せず、それぞれ個別のitemsの1要素として抽出してください（例：往路運賃と復路運賃は別々の項目）。
- 本体の運賃とは別に、発券手数料・保管料・送料・消費税等の付随費用が記載されている場合も、可能な限りそれぞれ個別のitemsの1要素として抽出してください。
- 1つの請求書に複数の日付・複数の乗車便（列車番号・区間等）・複数の費用種別が記載されている場合、content欄にそれらを区別できる情報（例：「のぞみ1号 新大阪→広島 往路」「発券手数料」等）を含め、後から見てどの行が何を指すか分かるようにしてください。
- 請求書に記載されている行数・費用種別の総数を数え、抽出したitemsの件数がそれと一致しているか自分で確認してから出力してください。
categoryは費用内容から推測してください。
出力は配列ではなく、以下の形式のJSONオブジェクトとしてください：
{"items": [各費用項目の配列（フィールドは上記の通り）], "invoice_total_amount": 請求書に記載されている合計の振込金額・お支払い金額（数値、見当たらなければ0）}
invoice_total_amountには、個々の明細の合計ではなく、請求書自体に印字されている「合計金額」「お振込金額」「TOTAL AMOUNT」等の総額の数字を、そのまま抽出してください（コミッション控除後の金額があればその総額を使用）。
JSONのみ返し、説明文・コードブロック記号は不要です。` }
      ], 8000);
      return res.status(200).json(data);
    }

    // 名刺OCRモード
    const images = Array.isArray(variants) && variants.length > 0 ? variants : (base64 ? [base64] : []);
    if (images.length === 0) {
      return res.status(400).json({ error: '画像データがありません' });
    }

    // Stage0: 向き判定
    const orientationResults = await Promise.all(images.map(async (b64) => {
      const data = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: b64 } },
        { type: 'text', text: 'この画像は正しい向きで表示されていますか？テキストが読める正立した状態であれば「はい」、そうでなければ「いいえ」とだけ答えてください。' }
      ], 10);
      const txt = (data.content?.[0]?.text || '').toLowerCase();
      return txt.includes('はい') || txt.includes('yes');
    }));

    let selectedBase64 = images[0];
    const correctIdx = orientationResults.findIndex(v => v);
    if (correctIdx >= 0) selectedBase64 = images[correctIdx];

    // Stage1: テキスト書き起こし
    const stage1 = await callClaude([
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: selectedBase64 } },
      { type: 'text', text: `この名刺画像に書かれているテキストをすべてそのまま書き出してください。
- 日本語・英語・数字・記号をすべて含めてください
- レイアウトや改行も可能な限り再現してください
- 読み取れない文字は「?」としてください
- 余計な説明は不要です` }
    ], 1000);
    const rawText = stage1.content?.[0]?.text || '';

    // Stage2: JSON整形
    const stage2 = await callClaude([{
      type: 'text',
      text: `以下の名刺テキストからJSON形式で情報を抽出してください。
テキスト：
${rawText}

抽出するフィールド：
- company_name: 会社名（日本語）
- company_name_en: 会社名（英語）
- branch_name: 支店・部署名（日本語）
- branch_name_en: 支店・部署名（英語）
- contact_person: 担当者名（日本語）
- contact_person_en: 担当者名（英語）
- position: 役職（日本語）
- position_en: 役職（英語）
- company_phone: 会社電話番号
- phone: 携帯電話番号
- fax: FAX番号
- email: メールアドレス
- address: 住所（日本語）
- address_en: 住所（英語）
- category: ホテル/レストラン/バス・ハイヤー等/その他 のいずれか

ルール：
- 名刺が英語表記のみの面(日本語のひらがな・カタカナ・漢字を含まない)の場合、
  company_name/branch_name/contact_person/position/addressは全て空文字にし、
  英語の内容は必ずcompany_name_en/branch_name_en/contact_person_en/position_en/address_en
  側にのみ入れること。日本語欄に英語表記を入れてはならない
- 逆に日本語表記のみの面の場合は、英語欄(_en)は全て空文字にし、日本語欄にのみ入れること
- JSONのみ返し、説明文・コードブロック記号は不要`
    }], 1000);

    return res.status(200).json(stage2);

  } catch (e) {
    // PasswordRequiredError / InvalidPasswordError（lib/protected-file.js）はここで検知し、
    // フロントエンドがパスワード入力欄を出し分けられる専用のエラーコードとして返す。
    // パスワードの値自体はここでもログに出力しない。
    if (e && (e.code === 'password_required' || e.code === 'invalid_password')) {
      return res.status(400).json({ error: e.code });
    }
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}