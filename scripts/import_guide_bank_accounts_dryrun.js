// ガイド口座情報の一括登録(再実施・完全版) - ドライラン専用スクリプト。
//
// scripts/data/guide_bank_accounts_final.csv (65件) を正として、guidesテーブルと
// 突合し、マッチ件数・未マッチ件数・複数候補ヒット件数を集計する。
// このスクリプトはDBへの書き込みを一切行わない(SELECTのみ)。
//
// 突合ルール:
//   - category が「日本人(男性)」「女性」: nickname_or_kana列は読み仮名(カタカナ)。
//     guides.name_kana との一致を優先する。
//   - category が「外国人(日本在住)」「外国人(海外)」: nickname_or_kana列は本当の
//     ニックネーム。name_full(氏名本体)を guides.name と突合することを優先し、
//     nickname_or_kanaは補助的にのみ使う。
//   - 半角/全角カタカナ・スペースの表記ゆれを吸収したうえで、候補が一意に1件だけ
//     絞り込めた場合のみマッチとする。0件または複数件ヒットする場合は未マッチ扱いとし、
//     一覧に出力する(自動登録はしない)。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/import_guide_bank_accounts_dryrun.js

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if(!SB_KEY){ console.error('SUPABASE_SERVICE_ROLE_KEYを指定してください'); process.exit(1); }

const CSV_PATH = path.join(__dirname, 'data', 'guide_bank_accounts_final.csv');

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

// 半角カタカナ→全角カタカナ変換テーブル。
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
  for(let i=0;i<str.length;i++){
    const c = str[i];
    out += HALF_TO_FULL_KANA[c] || c;
  }
  // 濁点/半濁点の結合(全角化した後にまとめて処理)
  Object.keys(DAKUTEN_MAP).forEach(k => { out = out.split(k).join(DAKUTEN_MAP[k]); });
  return out;
}

// 突合用の正規化: 空白除去、半角カナ→全角カナ、全角英数→半角、大文字化。
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

// name_fullから「氏名(かな/ローマ字別名)」形式の括弧部分・カッコ外部分を候補として分離する。
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

async function main(){
  const csvRows = loadCsvRows(CSV_PATH);
  console.log(`CSV読み込み: ${csvRows.length}件 (${CSV_PATH})`);

  const guides = (await sbFetch('guides', '?select=id,name,name_kana,is_deleted&order=name')) || [];
  const activeGuides = guides.filter(g => !g.is_deleted);
  console.log(`guidesテーブル: 全${guides.length}件中、有効(is_deleted!=true) ${activeGuides.length}件`);

  const byName = new Map(); // normalized name -> [guide,...]
  const byKana = new Map(); // normalized name_kana -> [guide,...]
  activeGuides.forEach(g => {
    const n = normalizeForMatch(g.name);
    const k = normalizeForMatch(g.name_kana);
    if(n){ if(!byName.has(n)) byName.set(n, []); byName.get(n).push(g); }
    if(k){ if(!byKana.has(k)) byKana.set(k, []); byKana.get(k).push(g); }
  });

  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  csvRows.forEach((row, idx) => {
    const isKanaGroup = KANA_CATEGORIES.has(row.category);
    const attempts = [];
    let hit = null;

    if(isKanaGroup){
      // 優先: nickname_or_kana(読み仮名) vs guides.name_kana
      const kanaNorm = normalizeForMatch(row.nickname_or_kana);
      if(kanaNorm && byKana.has(kanaNorm)){
        attempts.push({by:'name_kana', key:kanaNorm, candidates:byKana.get(kanaNorm)});
      }
      // フォールバック: name_full vs guides.name
      const nameNorm = normalizeForMatch(row.name_full);
      if(nameNorm && byName.has(nameNorm)){
        attempts.push({by:'name', key:nameNorm, candidates:byName.get(nameNorm)});
      }
    } else {
      // 優先: name_full(の各候補) vs guides.name
      for(const cand of extractNameCandidates(row.name_full)){
        const n = normalizeForMatch(cand);
        if(n && byName.has(n)) attempts.push({by:'name', key:n, candidates:byName.get(n)});
      }
      // フォールバック: nickname_or_kana vs guides.name_kana / guides.name
      const nickNorm = normalizeForMatch(row.nickname_or_kana);
      if(nickNorm){
        if(byKana.has(nickNorm)) attempts.push({by:'name_kana(nickname)', key:nickNorm, candidates:byKana.get(nickNorm)});
        if(byName.has(nickNorm)) attempts.push({by:'name(nickname)', key:nickNorm, candidates:byName.get(nickNorm)});
      }
    }

    // 一意に1件だけ絞り込めた最初の試行を採用する。
    const uniqueHit = attempts.find(a => a.candidates.length === 1);
    if(uniqueHit){
      hit = uniqueHit.candidates[0];
      matched.push({ row, guide: hit, matchedBy: uniqueHit.by });
      return;
    }

    const anyMultiple = attempts.find(a => a.candidates.length > 1);
    if(anyMultiple){
      ambiguous.push({ row, attempts });
    } else {
      unmatched.push({ row, attempts });
    }
  });

  console.log('\n=== 突合結果サマリー ===');
  console.log(`マッチ: ${matched.length}件`);
  console.log(`未マッチ(候補0件): ${unmatched.length}件`);
  console.log(`複数候補ヒット(要確認): ${ambiguous.length}件`);

  if(unmatched.length){
    console.log('\n--- 未マッチ一覧 ---');
    unmatched.forEach(u => console.log(`  [${u.row.category}] ${u.row.name_full} (かな/ニックネーム: ${u.row.nickname_or_kana||'(なし)'})`));
  }
  if(ambiguous.length){
    console.log('\n--- 複数候補ヒット一覧 ---');
    ambiguous.forEach(a => {
      console.log(`  [${a.row.category}] ${a.row.name_full} (かな/ニックネーム: ${a.row.nickname_or_kana||'(なし)'})`);
      a.attempts.filter(x=>x.candidates.length>1).forEach(x => {
        console.log(`    候補(${x.by}, key=${x.key}): ${x.candidates.map(g=>`${g.name}[id=${g.id}]`).join(', ')}`);
      });
    });
  }

  // 大森基司さんの2口座がどちらもマッチしているか個別確認。
  const omoriRows = matched.filter(m => m.row.name_full.includes('大森') && m.row.name_full.includes('基司'));
  console.log(`\n--- 大森基司さんの口座マッチ状況 ---`);
  console.log(`  マッチした行数: ${omoriRows.length}件(期待値: 2件、GMO法人+三井住友個人)`);
  omoriRows.forEach(m => console.log(`    ${m.row.bank}/${m.row.branch} guide_id=${m.guide.id}`));

  const outPath = path.join(__dirname, 'data', `guide_bank_accounts_dryrun_result_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ matched: matched.map(m=>({...m.row, guide_id:m.guide.id, guide_name:m.guide.name, matchedBy:m.matchedBy})), unmatched: unmatched.map(u=>u.row), ambiguous: ambiguous.map(a=>a.row) }, null, 2));
  console.log(`\n詳細結果を保存しました: ${outPath}`);
}

main().catch(e => { console.error('エラー:', e); process.exit(1); });
