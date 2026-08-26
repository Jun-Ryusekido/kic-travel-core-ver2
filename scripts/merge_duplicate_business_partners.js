// scripts/find_duplicate_business_partners.jsが出力したCSV(グループ番号ごとに手動で
// "keep"列にYを入れたもの)を読み込み、各グループの「残す1件」以外を統合する。
//
// 統合の内容:
//   (a) 統合対象id(keepでない行)に紐づくbusiness_partner_contactsの
//       business_partner_idを、そのグループの残すidに一括で付け替える
//   (b) 統合対象idをbusiness_partners.is_deleted=trueに更新する
//       (deleted_by='merge_duplicate_partners_20260826'、物理削除はしない)
//
// 予約データ(booking_hotels/booking_buses/booking_facilities/booking_restaurants)側の
// 表記(hotel_name等)は一切変更しない(今回はbusiness_partners側の統合のみ)。
//
// 「どのidを残すか」は完全自動判定しない。同名だが実際には別会社のケースが紛れている
// 可能性があるため、必ず人がCSVの"keep"列にYを入れたグループのみを対象とする。
// - 1つのグループにYが0件、または2件以上ある場合は、そのグループを警告付きでスキップする
//   (曖昧な状態では絶対に自動判断しない)
// - "keep"列が空欄のグループはそもそも対象外として扱う(まだ判断待ちのグループとみなす)
//
// 実行方法:
//   デフォルトは必ずdry-run(何も書き込まない)。実際にDBを変更するには--applyが必須。
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/merge_duplicate_business_partners.js [--csv <path>] [--dry-run|--apply] [--yes]
//
//   例:
//     # 内容確認のみ(デフォルトのdry-run)
//     SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/merge_duplicate_business_partners.js
//     # 実際に反映する(確認プロンプトあり)
//     SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/merge_duplicate_business_partners.js --apply
//     # 確認プロンプトをスキップして反映する
//     SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/merge_duplicate_business_partners.js --apply --yes

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DELETED_BY = 'merge_duplicate_partners_20260826';
const DEFAULT_CSV = path.resolve(__dirname, 'data/duplicate_business_partners_report.csv');

function parseArgs(argv) {
  const csvIdx = argv.indexOf('--csv');
  return {
    csvPath: csvIdx !== -1 && argv[csvIdx + 1] ? path.resolve(argv[csvIdx + 1]) : DEFAULT_CSV,
    apply: argv.includes('--apply'),
    yes: argv.includes('--yes'),
  };
}

// scripts/import_guide_bank_accounts_dryrun.js等と同じ手書きCSVパーサー(RFC4180相当、
// ダブルクォート内のカンマ・改行・エスケープされた""に対応)。
function parseCsv(text) {
  // 呼び出し元(loadReportRows)で読み込み時に既にBOM除去しているが、parseCsv単体で
  // 直接呼ばれるケース(テスト等)にも備え、ここでも先頭のBOM(U+FEFF)を除去する。
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
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
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function loadReportRows(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSVが見つかりません: ${csvPath}\n先にscripts/find_duplicate_business_partners.jsを実行してください。`);
  }
  // Excelで「CSV UTF-8」形式で保存すると、ファイル先頭にBOM(U+FEFF)が付与され、
  // 1列目のヘッダー名の前に不可視文字として紛れ込む(例:「グループ番号」の前にBOMが
  // 付いて一致しなくなる)。読み込み時に先頭のBOMを除去してから解析する。
  let text = fs.readFileSync(csvPath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = parseCsv(text);
  // 同様にExcelでの編集・再保存で列名の前後に空白が入り込むことがあるため、
  // ヘッダーは必ずtrimしてから列を特定する(値側は元々trimしている箇所のみtrim対象)。
  const header = rows[0].map(h => String(h).trim());
  const idx = name => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSVに列「${name}」がありません(ヘッダー: ${header.join(', ')})`);
    return i;
  };
  const iGroup = idx('グループ番号'), iId = idx('id'), iName = idx('会社名(元表記)'), iKeep = idx('keep');
  return rows.slice(1).map(r => ({
    groupNo: r[iGroup],
    id: r[iId],
    companyName: r[iName],
    // Excelの自動変換で全角Ｙ(U+FF39)・全角ｙが入力されるケースがあるため、
    // NFKC正規化で全角英字を半角に統一してからtrim/小文字化する
    // (index.htmlのnormalizePartnerCompanyName等、他の正規化処理と同じ考え方)。
    keep: (r[iKeep] || '').normalize('NFKC').trim().toLowerCase(),
  }));
}

// keep列が空欄のグループは「まだ判断待ち」として全体を対象外にする。Yが無い/複数ある
// グループは警告してスキップする。曖昧な状態では絶対に自動判断しない。
function resolveGroups(reportRows) {
  const byGroup = new Map();
  reportRows.forEach(r => {
    if (!byGroup.has(r.groupNo)) byGroup.set(r.groupNo, []);
    byGroup.get(r.groupNo).push(r);
  });

  const plans = []; // { groupNo, keepId, mergeAwayIds: [...] }
  const skipped = []; // { groupNo, reason }

  byGroup.forEach((rows, groupNo) => {
    const anyKeepFilled = rows.some(r => r.keep !== '');
    if (!anyKeepFilled) {
      skipped.push({ groupNo, reason: 'keep列が未記入(判断待ち)のためスキップ' });
      return;
    }
    const keepRows = rows.filter(r => r.keep === 'y' || r.keep === 'yes');
    if (keepRows.length !== 1) {
      skipped.push({ groupNo, reason: `keep=Yの行が${keepRows.length}件(1件である必要があります)のためスキップ` });
      return;
    }
    const keepId = keepRows[0].id;
    const mergeAwayIds = rows.filter(r => r.id !== keepId).map(r => r.id);
    plans.push({ groupNo, keepId, keepName: keepRows[0].companyName, mergeAwayIds, mergeAwayRows: rows.filter(r => r.id !== keepId) });
  });

  return { plans, skipped };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function sbFetch(table, qs, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${table} ${opts.method || 'GET'} failed: ${res.status} ${await res.text()}`);
  return res.json().catch(() => null);
}

async function main() {
  if (!SB_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const applyMode = args.apply; // --apply指定が無ければ常にdry-run

  console.log(`CSVを読み込み中: ${args.csvPath}`);
  const reportRows = loadReportRows(args.csvPath);
  const { plans, skipped } = resolveGroups(reportRows);

  console.log(`\n統合対象グループ: ${plans.length}グループ`);
  console.log(`スキップしたグループ: ${skipped.length}グループ`);
  skipped.forEach(s => console.log(`  グループ${s.groupNo}: ${s.reason}`));

  if (plans.length === 0) {
    console.log('\n統合対象がありません。処理を終了します。');
    return;
  }

  console.log('\n--- 統合計画 ---');
  let totalMergeAway = 0;
  plans.forEach(p => {
    totalMergeAway += p.mergeAwayIds.length;
    console.log(`グループ${p.groupNo}: 残す id=${p.keepId} (${p.keepName})`);
    p.mergeAwayRows.forEach(r => console.log(`  → 統合(is_deleted=true化) id=${r.id} (${r.companyName})`));
  });
  console.log(`\n合計: ${plans.length}グループ、統合(is_deleted=true化)対象 ${totalMergeAway}件`);

  if (!applyMode) {
    console.log('\n※--dry-run(デフォルト)のため、DBへの書き込みは一切行っていません。');
    console.log('  実際に反映するには --apply を付けて再実行してください。');
    return;
  }

  if (!args.yes) {
    const ans = await ask(`\n上記${totalMergeAway}件を本番business_partnersでis_deleted=trueにし、business_partner_contactsを付け替えます。よろしいですか? (yes と入力): `);
    if (ans.trim() !== 'yes') {
      console.log('中止しました。書き込みは行っていません。');
      return;
    }
  }

  // ── バックアップ(書き込み前に必ず保存し、読み戻し確認してから先に進む) ──────────
  const allMergeAwayIds = plans.flatMap(p => p.mergeAwayIds);
  const allKeepIds = plans.map(p => p.keepId);
  const allTargetIds = [...new Set([...allMergeAwayIds, ...allKeepIds])];
  console.log('\nバックアップ対象行を取得中...');
  const idList = allTargetIds.map(encodeURIComponent).join(',');
  const backupPartners = await sbFetch('business_partners', `?select=*&id=in.(${idList})`);
  const backupContacts = await sbFetch(
    'business_partner_contacts',
    `?select=*&business_partner_id=in.(${allMergeAwayIds.map(encodeURIComponent).join(',')})&is_deleted=eq.false`
  );

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const backupDir = path.resolve(__dirname, 'data');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `merge_backup_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ plans, business_partners: backupPartners, business_partner_contacts: backupContacts }, null, 2), 'utf8');

  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!reread.business_partners || reread.business_partners.length !== backupPartners.length) {
    console.error(`バックアップの書き込み確認に失敗しました(${backupPath})。処理を中止します。`);
    process.exit(1);
  }
  console.log(`バックアップを保存しました: ${backupPath}`);
  console.log(`  business_partners: ${backupPartners.length}件, business_partner_contacts: ${backupContacts.length}件`);

  // ── 実処理: グループごとに (a) 担当者の付け替え → (b) 統合元の論理削除 ─────────
  const nowIso = new Date().toISOString();
  for (const p of plans) {
    // (a) business_partner_contactsのbusiness_partner_idを、統合対象の各idから
    //     残すidへ1件ずつ付け替える(1件ずつなのはPostgRESTのUPDATEで「異なる複数の
    //     旧idから1つの新idへ」を1クエリでは表現できないため、対象idごとに実行する)。
    for (const oldId of p.mergeAwayIds) {
      await sbFetch(
        'business_partner_contacts',
        `?business_partner_id=eq.${encodeURIComponent(oldId)}`,
        {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ business_partner_id: p.keepId, updated_by: DELETED_BY, updated_at: nowIso }),
        }
      );
    }
    // (b) 統合対象idをbusiness_partners.is_deleted=trueに更新(論理削除、物理削除はしない)。
    const mergeAwayIdList = p.mergeAwayIds.map(encodeURIComponent).join(',');
    await sbFetch(
      'business_partners',
      `?id=in.(${mergeAwayIdList})`,
      {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ is_deleted: true, deleted_at: nowIso, deleted_by: DELETED_BY }),
      }
    );
    console.log(`グループ${p.groupNo}: 完了(残す id=${p.keepId}、統合 ${p.mergeAwayIds.length}件)`);
  }

  // ── 実行後の検証 ─────────────────────────────────────────────
  const afterPartners = await sbFetch('business_partners', `?select=id,is_deleted&id=in.(${allMergeAwayIds.map(encodeURIComponent).join(',')})`);
  const stillActive = (afterPartners || []).filter(p => !p.is_deleted);
  const afterContacts = await sbFetch(
    'business_partner_contacts',
    `?select=id,business_partner_id&business_partner_id=in.(${allMergeAwayIds.map(encodeURIComponent).join(',')})&is_deleted=eq.false`
  );

  console.log('\n=== 実行結果 ===');
  console.log(`バックアップファイル: ${backupPath}`);
  console.log(`統合(is_deleted=true化)対象: ${allMergeAwayIds.length}件`);
  console.log(`統合後もis_deleted=trueになっていない行: ${stillActive.length}件`);
  console.log(`統合後も旧idを参照したままのbusiness_partner_contacts: ${(afterContacts || []).length}件`);
  if (stillActive.length === 0 && (afterContacts || []).length === 0) {
    console.log('統合が正しく反映されたことを確認しました。');
  } else {
    console.log('⚠ 一部反映されていない可能性があります。手動で確認してください。');
  }
}

module.exports = { parseCsv, loadReportRows, resolveGroups, main };

if (require.main === module) {
  main().catch(e => { console.error('エラーが発生しました:', e.message); process.exit(1); });
}
