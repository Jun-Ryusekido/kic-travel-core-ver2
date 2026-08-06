// F13フェーズ2: agent_idバックフィル - ドライラン専用スクリプト。
//
// bookings/booking_sales/invoicesのagent_name(自由入力テキスト)を、フェーズ0
// (scripts/check_agent_name_dedup_groups.js)と同じ正規化ロジックでagentsマスタの
// company_nameと突き合わせ、実際にUPDATEした場合の見込み件数をシミュレーションする。
// 読み取り専用。実データは一切変更しない(UPDATE文は発行しない)。
//
// 前提: bookings/booking_sales/invoicesにagent_id列がまだ存在しない場合でも、
// このスクリプトはagent_id列を参照しない(SELECTはagent_nameのみ)ため、そのまま
// 実行できる。列の追加は本番バックフィル実行の前提条件であり、このドライランの
// 前提条件ではない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/backfill_agent_id_dryrun.js
//   (任意) --csv scripts/data/agent_id_backfill_dryrun.csv で未マッチ一覧をCSV出力

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

// agent_name='0'は、過去の移行時に付与されたダミー値であることが判明している
// (F13事前調査時点で129件確認)。正規化しても意味のある値にならないため、
// バックフィル対象・未マッチ集計のどちらからも除外し、別枠でカウントする。
const DUMMY_AGENT_NAMES = new Set(['0']);

async function sbSelectAll(table, select){
  let all = [], from = 0; const PAGE = 1000;
  while(true){
    const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&offset=${from}&limit=${PAGE}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if(!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all = all.concat(data);
    if(data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// index.htmlのtoHalfWidth()と同じロジック(全角英数記号→半角、全角スペース→半角スペース)。
// check_agent_name_dedup_groups.jsと完全に同一の正規化ロジックを使う(グループ検出時と
// バックフィル判定時で正規化結果がずれると、フェーズ0で確認したグループが本番実行時に
// 想定と異なる挙動になるため、必ず同じ関数を使うこと)。
function toHalfWidth(str){
  return String(str || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

const CORP_SUFFIX_PATTERNS = [
  /株式会社/g, /\(株\)/g, /（株）/g, /有限会社/g, /\(有\)/g, /（有）/g,
  /co\.?,?\s*ltd\.?/gi, /co\.?\s*limited/gi, /pvt\.?\s*ltd\.?/gi, /private\s*limited/gi,
  /inc\.?/gi, /corp\.?/gi, /corporation/gi, /llc/gi, /l\.l\.c\.?/gi, /gmbh/gi,
];

function normalizeAgentName(raw){
  let s = toHalfWidth(raw || '');
  s = s.normalize('NFKC');
  CORP_SUFFIX_PATTERNS.forEach(pat => { s = s.replace(pat, ''); });
  s = s.replace(/[.,、。・]/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

function toCsvRow(fields){
  return fields.map(f => {
    const s = String(f == null ? '' : f);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

async function main(){
  const [agents, bookings, salesRows, invoiceRows] = await Promise.all([
    sbSelectAll('agents', 'id,company_name'),
    sbSelectAll('bookings', 'id,agent_name'),
    sbSelectAll('booking_sales', 'id,agent_name'),
    sbSelectAll('invoices', 'id,agent_name'),
  ]);

  // agentsマスタ: 正規化キー -> {id, company_name}。正規化後に複数のagentsレコードが
  // 衝突する場合(マスタ側の表記ゆれ)は、どちらか一方に決め打ちせず「マスタ側が曖昧」
  // として別枠で報告し、バックフィル対象からは除外する(誤って別会社に紐付けるリスクを
  // 避けるため)。
  const agentNormMap = new Map(); // normKey -> {id, company_name}
  const agentNormCollisions = new Map(); // normKey -> [company_name...]
  agents.forEach(a => {
    const key = normalizeAgentName(a.company_name);
    if(!key) return;
    if(agentNormMap.has(key)){
      const list = agentNormCollisions.get(key) || [agentNormMap.get(key).company_name];
      list.push(a.company_name);
      agentNormCollisions.set(key, list);
    }else{
      agentNormMap.set(key, {id: a.id, company_name: a.company_name});
    }
  });

  const sources = [
    { label: 'bookings', rows: bookings },
    { label: 'booking_sales', rows: salesRows },
    { label: 'invoices', rows: invoiceRows },
  ];

  const csvRows = [['テーブル', '区分', 'agent_name', '件数', '正規化後マッチ先(agents.company_name)']];
  const overallSummary = [];

  for(const src of sources){
    let matched = 0, unmatched = 0, dummyExcluded = 0, ambiguousMaster = 0, blank = 0;
    const unmatchedCounts = {}; // agent_name(生) -> 件数
    const matchedByAgent = {}; // agents.company_name -> 件数(参考)

    src.rows.forEach(r => {
      const raw = (r.agent_name || '').trim();
      if(!raw){ blank++; return; }
      if(DUMMY_AGENT_NAMES.has(raw)){ dummyExcluded++; return; }
      const key = normalizeAgentName(raw);
      if(!key){ blank++; return; }
      if(agentNormCollisions.has(key)){ ambiguousMaster++; return; }
      const hit = agentNormMap.get(key);
      if(hit){
        matched++;
        matchedByAgent[hit.company_name] = (matchedByAgent[hit.company_name]||0) + 1;
      }else{
        unmatched++;
        unmatchedCounts[raw] = (unmatchedCounts[raw]||0) + 1;
        csvRows.push([src.label, '未マッチ', raw, 1, '']);
      }
    });

    const total = src.rows.length;
    console.log(`\n========== ${src.label} (全${total}件) ==========`);
    console.log(`  更新見込み(agent_id設定可能): ${matched}件`);
    console.log(`  未マッチ(新規登録が必要な可能性): ${unmatched}件`);
    console.log(`  対象外(ダミー値'0'): ${dummyExcluded}件`);
    console.log(`  空欄(agent_name未入力): ${blank}件`);
    if(ambiguousMaster>0) console.log(`  ⚠ agentsマスタ側が正規化後に複数一致(曖昧なため対象外): ${ambiguousMaster}件`);

    const unmatchedList = Object.entries(unmatchedCounts).sort((a,b)=>b[1]-a[1]);
    if(unmatchedList.length){
      console.log(`  --- 未マッチの代表例(件数の多い順、上位20種類) ---`);
      console.table(unmatchedList.slice(0,20).map(([name,count])=>({agent_name: name, 件数: count})));
    }

    overallSummary.push({
      テーブル: src.label, 全件数: total, 更新見込み: matched, 未マッチ: unmatched,
      'ダミー値除外': dummyExcluded, 空欄: blank, 'マスタ側曖昧': ambiguousMaster,
    });
  }

  if(agentNormCollisions.size){
    console.log(`\n⚠ agentsマスタ内で正規化後に複数レコードが一致するグループ: ${agentNormCollisions.size}件`);
    console.log('  (このグループに該当するagent_nameは、マスタ側の重複整理が先に必要なため今回はバックフィル対象外にしている)');
    console.table([...agentNormCollisions.entries()].map(([key, names])=>({正規化キー: key, 'agents.company_name(重複)': names.join(' / ')})));
  }

  console.log('\n========== サマリー ==========');
  console.table(overallSummary);

  const csvArgIdx = process.argv.indexOf('--csv');
  if(csvArgIdx !== -1 && process.argv[csvArgIdx + 1]){
    const csvPath = path.resolve(process.argv[csvArgIdx + 1]);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, csvRows.map(toCsvRow).join('\n'), 'utf8');
    console.log(`\n未マッチ一覧をCSVに保存しました: ${csvPath}`);
  }

  console.log('\n※このスクリプトは読み取りのみ。UPDATE文は一切発行していません。');
  console.log('※本番バックフィル実行時は scripts/backfill_agent_id.js (提示のみ、未実行) を使用してください。');
}

main().catch(e => { console.error(e); process.exit(1); });
