// dry_run_access_booking_merge.js が「新規追加候補(本番に存在しないref_no)」として出した
// access_booking_merge_dryrun_new_candidates.csv の180件について、本当に本番bookingsに
// 存在しないのか、表記ゆれ(前後空白・全角/半角・大文字小文字・KIC等の接頭辞違い)で
// 単純一致検索に引っかからなかっただけなのかを機械的に検証する。
//
// このスクリプトはSupabaseへの読み取り(SELECT)のみを行う。UPDATE/INSERT/DELETEに相当する
// コードは一切存在しない(sbGetAllはGETのみを発行する)。
//
// 実行方法: node scripts/verify_new_candidates.js [--input <path>] [--out <path>]
//   環境変数 SUPABASE_SERVICE_ROLE_KEY があればそれを使う(読み取りのみなのでanonキーでも
//   結果は同じだが、本番運用時はservice_roleキー経由に統一する)。無ければ既定のanonキーに
//   フォールバックする(このリポジトリの他の読み取り専用スクリプトと同じ慣行)。

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

function parseArgs(argv) {
  const args = {
    input: 'scripts/data/access_booking_merge_dryrun_new_candidates.csv',
    out: 'scripts/data/verify_new_candidates_result.csv',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function sbGetAll(table, select) {
  const pageSize = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&order=id&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!r.ok) throw new Error(`Supabase GET ${table}: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// ── 正規化関数群(緩い順に段階的に適用する) ──────────────────────────────
function normTrim(s) {
  return String(s ?? '').trim();
}
// 全角英数字・記号を半角に統一する(NFKC正規化)。前後空白も併せて除去する。
function normWidth(s) {
  return normTrim(s).normalize('NFKC');
}
function normCase(s) {
  return normWidth(s).toLowerCase();
}
// "KIC"等の接頭辞・"#"・空白・記号を全て取り除き、数字部分だけを残して先頭の0を落とす
// (例: "KIC0005" → "5", "#0005" → "5")。数字が全く無い場合は空文字を返す。
function normNumericCore(s) {
  const digits = normCase(s).replace(/[^\d]/g, '');
  if (!digits) return '';
    return String(Number(digits)); // 先頭の0を落とす(Number変換で自然に処理される)
}

// bookingsの全ref_noから、各正規化レベルごとのlookupマップを1回だけ構築する。
function buildLookups(bookings) {
  const levels = ['exact', 'trim', 'width', 'case', 'numericCore'];
  const normFns = { exact: (s) => s, trim: normTrim, width: normWidth, case: normCase, numericCore: normNumericCore };
  const maps = {};
  levels.forEach((level) => { maps[level] = new Map(); });
  for (const b of bookings) {
    if (!b.ref_no) continue;
    for (const level of levels) {
      const key = normFns[level](b.ref_no);
      if (!key) continue;
      if (!maps[level].has(key)) maps[level].set(key, []);
      maps[level].get(key).push(b);
    }
  }
  return { maps, normFns, levels };
}

// 1件のref_noを緩い順に照合し、最初にヒットした段階の結果を返す。
// 戻り値: { matchStatus, method, matched } (matched=null なら本当に見つからなかった)
function matchOne(refNo, lookups) {
  const { maps, normFns, levels } = lookups;
  for (const level of levels) {
    const key = normFns[level](refNo);
    if (!key) continue;
    const hit = maps[level].get(key);
    if (hit && hit.length) {
      const matchStatus = level === 'exact' ? 'exact_match_found' : 'fuzzy_match_found';
      return { matchStatus, method: level, matched: hit[0] };
    }
  }
  return { matchStatus: 'true_new', method: null, matched: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`入力CSVが見つかりません: ${inputPath}`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(inputPath, 'utf8')).filter((r) => r.length >= 2 && r[0] !== 'ref_no');
  console.log(`入力候補件数: ${rows.length}`);

  console.log('bookings全件を読み込み中(読み取りのみ)...');
  const bookings = await sbGetAll('bookings', 'id,ref_no');
  console.log(`bookings総件数: ${bookings.length}`);

  const lookups = buildLookups(bookings);

  const results = rows.map(([refNo, jsonStatus]) => {
    const { matchStatus, method, matched } = matchOne(refNo, lookups);
    return {
      ref_no: refNo,
      json_status: jsonStatus,
      match_status: matchStatus,
      match_method: method || '',
      matched_booking_ref_no: matched ? matched.ref_no : '',
      matched_booking_id: matched ? matched.id : '',
    };
  });

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const header = ['ref_no', 'json_status', 'match_status', 'match_method', 'matched_booking_ref_no', 'matched_booking_id'];
  const csv = [header.join(',')]
    .concat(results.map((r) => header.map((h) => toCsvField(r[h])).join(',')))
    .join('\n');
  fs.writeFileSync(outPath, csv, 'utf8');

  const byStatus = { true_new: 0, fuzzy_match_found: 0, exact_match_found: 0 };
  results.forEach((r) => { byStatus[r.match_status] = (byStatus[r.match_status] || 0) + 1; });

  console.log('=== 検証結果(bookingsへの書き込みは一切行っていません) ===');
  console.log(`総件数: ${results.length}`);
  console.log(`true_new(本当に新規): ${byStatus.true_new}`);
  console.log(`fuzzy_match_found(表記ゆれで既存レコードあり、要人間確認): ${byStatus.fuzzy_match_found}`);
  if (byStatus.exact_match_found > 0) {
    console.log(`\n!!!!! exact_match_found(完全一致で既存=矛盾): ${byStatus.exact_match_found} !!!!!`);
    console.log('!!!!! dry_run側の判定ロジックに問題がある可能性があります。要調査 !!!!!\n');
  } else {
    console.log('exact_match_found(完全一致で既存=矛盾): 0');
  }
  console.log(`出力: ${outPath}`);
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
