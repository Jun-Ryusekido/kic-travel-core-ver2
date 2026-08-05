// F13事前調査(フェーズ0: 名寄せ調査)。bookings/booking_sales/invoicesのagent_nameを
// 正規化(全角/半角統一・大文字小文字統一・法人格表記の除去・前後空白除去)した上で
// グループ化し、表記ゆれの実態と、agentsマスタに存在しない可能性が高い表記を洗い出す
// 読み取り専用スクリプト。実際の変更は一切行わない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/check_agent_name_dedup_groups.js
//   (任意) --csv scripts/data/agent_name_dedup_groups.csv を付けるとCSVも出力する

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

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
function toHalfWidth(str){
  return String(str || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

// 法人格表記(日本語・英語双方)を除去する。前方一致・後方一致・カッコ書きいずれにも対応。
const CORP_SUFFIX_PATTERNS = [
  /株式会社/g, /\(株\)/g, /（株）/g, /有限会社/g, /\(有\)/g, /（有）/g,
  /co\.?,?\s*ltd\.?/gi, /co\.?\s*limited/gi, /pvt\.?\s*ltd\.?/gi, /private\s*limited/gi,
  /inc\.?/gi, /corp\.?/gi, /corporation/gi, /llc/gi, /l\.l\.c\.?/gi, /gmbh/gi,
];

function normalizeAgentName(raw){
  let s = toHalfWidth(raw || '');
  s = s.normalize('NFKC');
  CORP_SUFFIX_PATTERNS.forEach(pat => { s = s.replace(pat, ''); });
  s = s.replace(/[.,、。・]/g, ''); // 残った句読点・ピリオド類も除去
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

function collectCounts(rows){
  const counts = {};
  rows.forEach(r => {
    const v = (r.agent_name || '').trim();
    if(!v) return;
    counts[v] = (counts[v] || 0) + 1;
  });
  return counts;
}

function buildGroups(counts){
  const groups = {}; // normKey -> { variants: {raw: count}, total }
  Object.entries(counts).forEach(([raw, count]) => {
    const key = normalizeAgentName(raw);
    if(!key) return;
    if(!groups[key]) groups[key] = { variants: {}, total: 0 };
    groups[key].variants[raw] = count;
    groups[key].total += count;
  });
  return groups;
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
    sbSelectAll('bookings', 'agent_name'),
    sbSelectAll('booking_sales', 'agent_name'),
    sbSelectAll('invoices', 'agent_name'),
  ]);

  const agentNormMap = new Map(); // normKey -> company_name(代表表記)
  agents.forEach(a => {
    const key = normalizeAgentName(a.company_name);
    if(key && !agentNormMap.has(key)) agentNormMap.set(key, a.company_name);
  });

  const sources = [
    { label: 'bookings.agent_name', rows: bookings },
    { label: 'booking_sales.agent_name', rows: salesRows },
    { label: 'invoices.agent_name', rows: invoiceRows },
  ];

  const csvRows = [['列', '正規化グループ', 'グループ内表記(件数)', '合計件数', 'agentsマスタ候補']];

  for(const src of sources){
    const counts = collectCounts(src.rows);
    const distinctCount = Object.keys(counts).length;
    const groups = buildGroups(counts);
    const groupList = Object.entries(groups)
      .map(([key, g]) => ({
        key,
        variants: g.variants,
        variantList: Object.entries(g.variants).sort((a,b)=>b[1]-a[1]),
        total: g.total,
        masterMatch: agentNormMap.get(key) || null,
      }))
      .sort((a,b) => b.total - a.total);

    const reducedGroups = groupList.length;
    const multiVariantGroups = groupList.filter(g => Object.keys(g.variants).length > 1);

    console.log(`\n========== ${src.label} ==========`);
    console.log(`distinct表記数: ${distinctCount}件 → 正規化後グループ数: ${reducedGroups}件`);
    console.log(`(表記ゆれにより${distinctCount - reducedGroups}件分が同一グループに統合される見込み)`);
    console.log(`複数バリエーションを持つグループ(=表記ゆれの疑いが強い): ${multiVariantGroups.length}グループ`);

    if(multiVariantGroups.length){
      console.log('\n--- 表記ゆれ候補グループ(件数の多い順、上位30) ---');
      console.table(multiVariantGroups.slice(0, 30).map(g => ({
        正規化キー: g.key,
        バリエーション: g.variantList.map(([name, c]) => `${name}(${c}件)`).join(' / '),
        合計件数: g.total,
        agentsマスタ候補: g.masterMatch || '(一致なし)',
      })));
    }

    const noMasterMatch = groupList.filter(g => !g.masterMatch);
    console.log(`\nagentsマスタに正規化一致しないグループ(=新規登録候補): ${noMasterMatch.length}グループ / 合計${noMasterMatch.reduce((s,g)=>s+g.total,0)}件`);
    if(noMasterMatch.length){
      console.log('--- 新規登録候補(件数の多い順、上位30) ---');
      console.table(noMasterMatch.slice(0, 30).map(g => ({
        正規化キー: g.key,
        バリエーション: g.variantList.map(([name, c]) => `${name}(${c}件)`).join(' / '),
        合計件数: g.total,
      })));
    }

    groupList.forEach(g => {
      csvRows.push([
        src.label,
        g.key,
        g.variantList.map(([name, c]) => `${name}(${c})`).join(' / '),
        g.total,
        g.masterMatch || '',
      ]);
    });
  }

  const csvArgIdx = process.argv.indexOf('--csv');
  if(csvArgIdx !== -1 && process.argv[csvArgIdx + 1]){
    const csvPath = path.resolve(process.argv[csvArgIdx + 1]);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, csvRows.map(toCsvRow).join('\n'), 'utf8');
    console.log(`\nCSVを保存しました: ${csvPath}`);
  }

  console.log('\n※このスクリプトは読み取りのみ。実際の変更は一切行っていません。');
  console.log('※正規化ロジック(法人格表記の除去等)は機械的な近似のため、実際に同一企業かは目視確認が必要です。');
}

main().catch(e => { console.error(e); process.exit(1); });
