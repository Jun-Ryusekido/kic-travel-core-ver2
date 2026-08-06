// ガイド口座情報の一括登録(本番反映・最終確定分)。
//
// scripts/data/guide_bank_accounts_final.csv (66件) のうち、以下の3グループに
// 分けて処理する:
//   1. 除外12名(EXCLUDED_NAMES) — guidesマスタに未登録と判断されたため、
//      今回は一切書き込まない(guidesマスタへの新規登録が先決)。
//   2. 手動確定11行(MANUAL_GUIDE_ID_OVERRIDES) — JUNさんが目視でguidesテーブル
//      全132件と突き合わせて確定した10名分(うちBHATT/ﾊﾞｯﾄさんは2口座あるため
//      CSV上2行に対応)。guide_idを直接指定する(自動突合ロジックは使わない)。
//   3. 残り43行 — scripts/import_guide_bank_accounts_dryrun.jsと全く同じ
//      正規化・突合ロジックで自動マッチする(初回ドライランで一意に
//      マッチ済みの行のため、通常は全件マッチするはずだが、万一
//      マッチしない/複数候補の行が出た場合は安全のため書き込みを中断する)。
//
// 安全対策:
//   - デフォルトはドライラン相当(--yesを付けない限り実際のINSERTは行わない)
//   - 実行前にguide_bank_accountsテーブルの既存データ全件をJSONバックアップする
//   - 除外12名分は対象外として明示的にスキップする
//   - 手動確定11行以外で自動突合が失敗(0件/複数件)した場合は、想定外の
//     状態としてその時点で処理を中断する(サイレントにスキップしない)
//   - 書き込み後、guide_bank_accountsテーブルから対象guide_idを再取得し、
//     「何件中何件が実際に反映されたか」を検証する
//
// 実行方法:
//   1. まず対象件数の確認(このスクリプトを--yesなしで実行するとサマリーのみ表示):
//      SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/import_guide_bank_accounts_apply.js
//   2. 内容に問題なければ本実行:
//      SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/import_guide_bank_accounts_apply.js --yes

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if(!SB_KEY){ console.error('SUPABASE_SERVICE_ROLE_KEYを指定してください'); process.exit(1); }

const CSV_PATH = path.join(__dirname, 'data', 'guide_bank_accounts_final.csv');
const DRY_RUN = process.argv.indexOf('--yes') === -1;

async function sbFetch(table, qs, opts={}){
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers||{}),
    },
  });
  const text = await res.text();
  if(!res.ok) throw new Error(`${table} ${opts.method||'GET'} failed: ${res.status} ${text}`);
  // Prefer: return=minimal等で成功時にレスポンスボディが空(204)になる場合、
  // res.json()相当の呼び出しで「Unexpected end of JSON input」により異常終了して
  // しまう不具合が別スクリプト(backfill_agent_id.js)の本番実行で過去に発生した。
  // 同じ轍を踏まないよう、空ボディはnullを返し、それ以外だけJSON.parseする。
  if(!text) return null;
  try{ return JSON.parse(text); }
  catch(e){ throw new Error(`${table} ${opts.method||'GET'} : レスポンスがJSONとして解析できません: ${text.slice(0,200)}`); }
}

// 簡易CSVパーサ(ダブルクォート囲み・カンマ・改行を考慮)。
function parseCsv(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else if(c === '\r'){ /* skip */ }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length>1 || (r.length===1 && r[0]!==''));
}

function loadCsvRows(csvPath){
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  const header = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h,i) => { obj[h] = (r[i]||'').trim(); });
    return obj;
  });
}

// --- 突合ロジック(scripts/import_guide_bank_accounts_dryrun.jsと同一) ---
const HALF_TO_FULL_KANA = {
  'ｦ':'ヲ','ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ','ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ',
  'ｰ':'ー','ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ','ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
  'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ','ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
  'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ','ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
  'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ','ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
  'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ','ﾜ':'ワ','ﾝ':'ン','ﾞ':'゛','ﾟ':'゜','ﾝﾞ':'ン゛',
};
const DAKUTEN_MAP = { 'カ゛':'ガ','キ゛':'ギ','ク゛':'グ','ケ゛':'ゲ','コ゛':'ゴ','サ゛':'ザ','シ゛':'ジ','ス゛':'ズ','セ゛':'ゼ','ソ゛':'ゾ',
  'タ゛':'ダ','チ゛':'ヂ','ツ゛':'ヅ','テ゛':'デ','ト゛':'ド','ハ゛':'バ','ヒ゛':'ビ','フ゛':'ブ','ヘ゛':'ベ','ホ゛':'ボ',
  'ウ゛':'ヴ','ハ゜':'パ','ヒ゜':'ピ','フ゜':'プ','ヘ゜':'ペ','ホ゜':'ポ' };

function halfKanaToFullKana(str){
  let out = '';
  for(let i=0;i<str.length;i++){ out += HALF_TO_FULL_KANA[str[i]] || str[i]; }
  Object.keys(DAKUTEN_MAP).forEach(k => { out = out.split(k).join(DAKUTEN_MAP[k]); });
  return out;
}

function normalizeForMatch(s){
  if(!s) return '';
  let str = String(s);
  str = str.replace(/[\s　]/g,'');
  str = halfKanaToFullKana(str);
  str = str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  str = str.toUpperCase();
  return str;
}

const KANA_CATEGORIES = new Set(['日本人(男性)', '女性']);

function extractNameCandidates(nameFull){
  if(!nameFull) return [];
  const candidates = new Set([nameFull]);
  const m = nameFull.match(/^(.*?)[\(（](.+?)[\)）]$/);
  if(m){
    const outer = m[1].trim();
    const inner = m[2].trim();
    if(outer) candidates.add(outer);
    if(inner) candidates.add(inner);
  }
  return Array.from(candidates).filter(Boolean);
}

function autoMatch(row, byName, byKana){
  const isKanaGroup = KANA_CATEGORIES.has(row.category);
  const attempts = [];
  if(isKanaGroup){
    const kanaNorm = normalizeForMatch(row.nickname_or_kana);
    if(kanaNorm && byKana.has(kanaNorm)) attempts.push({by:'name_kana', candidates:byKana.get(kanaNorm)});
    const nameNorm = normalizeForMatch(row.name_full);
    if(nameNorm && byName.has(nameNorm)) attempts.push({by:'name', candidates:byName.get(nameNorm)});
  } else {
    for(const cand of extractNameCandidates(row.name_full)){
      const n = normalizeForMatch(cand);
      if(n && byName.has(n)) attempts.push({by:'name', candidates:byName.get(n)});
    }
    const nickNorm = normalizeForMatch(row.nickname_or_kana);
    if(nickNorm){
      if(byKana.has(nickNorm)) attempts.push({by:'name_kana(nickname)', candidates:byKana.get(nickNorm)});
      if(byName.has(nickNorm)) attempts.push({by:'name(nickname)', candidates:byName.get(nickNorm)});
    }
  }
  const uniqueHit = attempts.find(a => a.candidates.length === 1);
  if(uniqueHit) return { ok:true, guide: uniqueHit.candidates[0] };
  const anyMultiple = attempts.find(a => a.candidates.length > 1);
  return { ok:false, ambiguous: !!anyMultiple, attempts };
}

// --- 除外12名(guidesマスタに未登録と判断。今回は書き込まない) ---
const EXCLUDED_NAMES = new Set([
  'Philip(ﾌｨﾘｯﾌﾟ)',
  'Aayush(ｷﾞﾘ ｱﾕｻ)',
  'Nupur(ｼﾞｬﾑﾃﾞ ﾇﾌﾟﾙ ﾗｼﾞｭ)',
  'ﾎｾ ｹﾈｴ(ﾏﾗﾘ ﾏﾘｱﾊﾟﾒﾗ)',
  'ｻﾙｳｨﾝﾀﾞ ｼﾝｸﾞ',
  'GURUNG ABHISHEK(ｸﾞﾙﾝ ｱﾋﾞｾｸ)',
  'LOPA TOSHIRO SHIGAKI(ｼｶﾞｷ ﾛﾊﾟ ﾄｼﾛｳ）',
  'SUSAN',
  'MENSHAWI FATHALLA ALI MOHAMED',
  'PANCHAL ADITYA',
  '山長 朋子',
  '鈴木 ｴﾚﾝ ｴﾙﾏ',
]);

// --- 手動確定11行(10名分。BHATT/ﾊﾞｯﾄさんは2口座あるためCSV上2行) ---
// name_full(CSVの値そのまま)をキーに、目視突合で確定したguide_idを直接指定する。
const MANUAL_GUIDE_ID_OVERRIDES = {
  '尾内 一義': '9f2f88c0-bf84-42bc-9c72-040c07879224',
  '杉本 ﾋﾛｼ': '00a3d482-0b0a-402e-b0f1-98c51fb0ead9',
  'Hitesh Jogani': 'c8326dfe-52bd-4773-9e0e-4c0490d341dd',
  'ｽﾃｨｰﾌﾞ湯(ｽﾃｨｰﾌﾞ ﾀﾝ)': 'a95f0a90-5151-46bd-bca0-b91456fd34b8',
  'ﾀﾞﾐ ﾛﾆ ｸﾏﾙ': '43f4ddf4-2d73-4ad0-9d35-6d37da7c0582',
  'VIJAY(ｻﾃﾞﾌﾞ ﾋﾞｼﾞｪｲ ｸﾏﾙ)': '090b70ce-50c8-4e2c-827d-7319244c2216',
  'ﾊﾞｯﾄ ｹﾕﾙ ﾀﾞﾅﾝｼﾞｬｲ': '2bec7504-dc4e-4134-868d-ead2da32409e',
  'BHATT KEYUR DHANANJAY': '2bec7504-dc4e-4134-868d-ead2da32409e',
  'Potphode Viraj(ﾎﾟｯﾄﾌｫｰﾃﾞ ｳﾞｨﾗｰｼﾞ）': 'd649ab49-3951-41b1-a9ea-f841eed02905',
  'ｼｭｳ ｼﾞｬﾊﾟｵ': '89c1bc0d-6f93-4be5-85d8-42d011b1b952',
  'ｼｬﾗﾝ ﾊﾞﾙﾃｨ': '8be9ca04-844f-4703-bdd6-c6470f3fd2a2',
};

async function main(){
  console.log(DRY_RUN ? '=== ドライラン(--yes無し。DBへの書き込みは行いません) ===' : '=== 本番実行(--yes指定) ===');

  const csvRows = loadCsvRows(CSV_PATH);
  console.log(`CSV読み込み: ${csvRows.length}件 (${CSV_PATH})`);

  const guides = (await sbFetch('guides', '?select=id,name,name_kana,is_deleted&order=name')) || [];
  const activeGuides = guides.filter(g => !g.is_deleted);
  console.log(`guidesテーブル: 全${guides.length}件中、有効(is_deleted!=true) ${activeGuides.length}件`);

  const byName = new Map();
  const byKana = new Map();
  activeGuides.forEach(g => {
    const n = normalizeForMatch(g.name);
    const k = normalizeForMatch(g.name_kana);
    if(n){ if(!byName.has(n)) byName.set(n, []); byName.get(n).push(g); }
    if(k){ if(!byKana.has(k)) byKana.set(k, []); byKana.get(k).push(g); }
  });

  const targets = []; // {row, guide_id, source}
  const excluded = [];
  const failedAuto = [];

  csvRows.forEach(row => {
    if(EXCLUDED_NAMES.has(row.name_full)){
      excluded.push(row);
      return;
    }
    if(Object.prototype.hasOwnProperty.call(MANUAL_GUIDE_ID_OVERRIDES, row.name_full)){
      targets.push({ row, guide_id: MANUAL_GUIDE_ID_OVERRIDES[row.name_full], source: 'manual' });
      return;
    }
    const m = autoMatch(row, byName, byKana);
    if(m.ok){
      targets.push({ row, guide_id: m.guide.id, source: 'auto' });
    } else {
      failedAuto.push({ row, ambiguous: m.ambiguous });
    }
  });

  console.log('\n=== サマリー ===');
  console.log(`CSV全体: ${csvRows.length}件`);
  console.log(`除外(guidesマスタ未登録と判断): ${excluded.length}件`);
  console.log(`反映対象: ${targets.length}件 (手動確定: ${targets.filter(t=>t.source==='manual').length}件 / 自動突合: ${targets.filter(t=>t.source==='auto').length}件)`);

  const omoriTargets = targets.filter(t => t.row.name_full.includes('大森') && t.row.name_full.includes('基司'));
  console.log(`  うち大森基司さんの口座: ${omoriTargets.length}件(期待値2件、GMO法人+三井住友個人)`);

  if(failedAuto.length){
    console.log(`\n【想定外】自動突合が失敗した行が${failedAuto.length}件あります(初回ドライランでは全て一意にマッチしていたはずの行です)。`);
    failedAuto.forEach(f => console.log(`  [${f.row.category}] ${f.row.name_full} — ${f.ambiguous ? '複数候補ヒット' : '候補0件'}`));
    console.log('guidesマスタが初回ドライラン後に変更された可能性があります。原因を確認するまで処理を中断します。');
    process.exit(1);
  }

  if(excluded.length !== 12){
    console.log(`\n【警告】除外件数が想定(12件)と異なります(実際: ${excluded.length}件)。EXCLUDED_NAMESの内容を確認してください。`);
  }
  if(targets.length !== 54){
    console.log(`\n【警告】反映対象件数が想定(54件)と異なります(実際: ${targets.length}件)。`);
  }

  if(DRY_RUN){
    console.log('\nドライランのため、ここで終了します。内容に問題なければ --yes を付けて再実行してください。');
    return;
  }

  if(!confirmProceedSync()){
    console.log('中断しました。');
    return;
  }

  // 1. 既存データの全件バックアップ
  const existingAll = (await sbFetch('guide_bank_accounts', '?select=*')) || [];
  const backupPath = path.join(__dirname, 'data', `guide_bank_accounts_backup_${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existingAll, null, 2));
  console.log(`\n既存データ(${existingAll.length}件)をバックアップしました: ${backupPath}`);

  // 2. INSERT実行
  const rowsToInsert = targets.map(t => ({
    guide_id: t.guide_id,
    bank_name: t.row.bank || null,
    branch_name: t.row.branch || null,
    account_type: t.row.acct_type || null,
    account_number: t.row.acct_no || null,
    account_holder_name: t.row.acct_holder || null,
    holder_type: t.row.honnin_kaisha || null,
    affiliation_memo: t.row.note || null,
  }));

  let inserted = [];
  try{
    inserted = await sbFetch('guide_bank_accounts', '', {
      method: 'POST',
      body: JSON.stringify(rowsToInsert),
      headers: { Prefer: 'return=representation' },
    }) || [];
  }catch(e){
    console.error('\nINSERTに失敗しました:', e.message);
    console.error('バックアップは保存済みです:', backupPath);
    process.exit(1);
  }
  console.log(`\nINSERT完了: ${inserted.length}件`);

  // 3. 再取得検証
  const afterAll = (await sbFetch('guide_bank_accounts', '?select=*')) || [];
  const newCount = afterAll.length - existingAll.length;
  console.log('\n=== 再取得検証 ===');
  console.log(`実行前の総件数: ${existingAll.length}件`);
  console.log(`実行後の総件数: ${afterAll.length}件`);
  console.log(`差分(新規追加分): ${newCount}件 (対象${targets.length}件中)`);
  if(newCount !== targets.length){
    console.log(`【警告】差分が対象件数と一致しません。バックアップ(${backupPath})と実際のテーブル内容を確認してください。`);
  } else {
    console.log('対象件数と一致しました。');
  }
}

function confirmProceedSync(){
  // Node標準入力から同期的にy/N確認を取る(readline-syncが無い環境のため、
  // execSyncでの簡易実装。既存スクリプト(backfill_agent_id.js等)は
  // 事前確認は呼び出し手順の説明で担保する方針だったため、ここでは
  // コマンドライン引数--yesの指定自体を「確認済み」の意思表示として扱う
  // (対話プロンプトは環境によっては動作しないため)。
  return true;
}

main().catch(e => { console.error('エラー:', e); process.exit(1); });
