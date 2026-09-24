// 【実行に必要な環境変数】SUPABASE_SERVICE_ROLE_KEY(必須。anonキーでは実行できない)
//   値の取得: Supabase管理画面 > Project Settings > API Keys > service_role(secret)
//   設定・実行(PowerShell): $env:SUPABASE_SERVICE_ROLE_KEY="<値>"; node scripts/investigate_in_date_regression.js
//   設定・実行(bash):       SUPABASE_SERVICE_ROLE_KEY=<値> node scripts/investigate_in_date_regression.js
//   キーはファイルに書かずコミットしないこと。未設定時はanonキーにフォールバックせずエラー終了する
//   (2026-09 RLS対応フェーズ1で全スクリプトをservice_role必須に統一)。
// 読み取り専用の調査スクリプト。bookingsへの書き込みは一切行わない。
//
// 7/31のAccess移行(apply_access_booking_merge.js / insert_new_access_bookings.js)後、
// 「実日付だったin_dateが2099年プレースホルダに誤って上書きされた」ケースが、既知の6件
// (access_booking_merge_exclude_list.json記載分)以外にも無いかを調べる。
//
// パート1(UPDATE対象1185件): access_booking_merge_backup_20260731_110711.json の
//   before.in_date(移行直前の実際の値)と、現在のSupabase上のin_dateを比較する。
//   before.in_dateが2099年台以外(=実日付)で、現在値が2099-12-28〜31のいずれかなら
//   「逆行候補」として抽出する。
//
// パート2(INSERT対象170件): access_new_bookings_backup_20260801_040802.json (実際に
//   INSERTされた値)と、access_booking_reconcile.json のA/Bスナップショット("出発日")を
//   突合する。Aスナップショットの出発日が実日付なのに、実際に挿入されたin_dateが
//   2099-12-28〜31になっているものを「要確認候補」として抽出する。

const fs = require('fs');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
function requireServiceRoleKey(key) {
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEYが未設定です。anonでは実行できません(anonキーはRLS有効化・権限剥奪によりテーブルを読み書きできず、空の結果による誤判定や書き込み失敗の原因になるため)。ファイル冒頭の【実行に必要な環境変数】の手順で設定してから再実行してください。');
    process.exit(1);
  }
}
requireServiceRoleKey(SB_KEY);

const PLACEHOLDER_DATES = new Set(['2099-12-28', '2099-12-29', '2099-12-30', '2099-12-31']);

function isPlaceholder(v) {
  if (!v) return false;
  return PLACEHOLDER_DATES.has(String(v).slice(0, 10));
}
function isRealDate(v) {
  if (!v) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (isPlaceholder(s)) return false;
  // 2099年台(2099-**-**)は全てプレースホルダ扱いとみなす(28-31以外の日付も含め要注意だが、
  // 既知の6件は全て12-28。念のため2099年全体を非実日付として扱う)。
  if (/^2099-/.test(s)) return false;
  return true;
}

async function sbGet(pathAndQuery) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  const exclude = JSON.parse(fs.readFileSync('scripts/data/access_booking_merge_exclude_list.json', 'utf8'));
  const excludedInDateRefs = new Set(
    exclude.filter((e) => e.column === 'in_date').map((e) => e.ref_no)
  );
  console.log('既知の除外(in_date)件数:', excludedInDateRefs.size, [...excludedInDateRefs]);

  // ── パート1: UPDATE対象1185件 ──────────────────────────────────────
  const backup = JSON.parse(
    fs.readFileSync('scripts/data/access_booking_merge_backup_20260731_110711.json', 'utf8')
  );
  console.log('\nバックアップ(移行直前スナップショット)件数:', backup.length);

  const withInDate = backup.filter((r) => r.before && Object.prototype.hasOwnProperty.call(r.before, 'in_date'));
  console.log('うちin_dateが変更対象だった件数:', withInDate.length);

  const withRealBeforeInDate = withInDate.filter((r) => isRealDate(r.before.in_date));
  console.log('うちbefore.in_dateが実日付だった件数:', withRealBeforeInDate.length);

  // 現在値をSupabaseから一括取得(ref_noでin句、500件ずつに分割)
  const refNos = withRealBeforeInDate.map((r) => r.ref_no);
  const currentByRef = new Map();
  const chunkSize = 200;
  for (let i = 0; i < refNos.length; i += chunkSize) {
    const chunk = refNos.slice(i, i + chunkSize);
    const inList = chunk.map((r) => `"${encodeURIComponent(r)}"`).join(',');
    const rows = await sbGet(`bookings?select=ref_no,tour_name,in_date&ref_no=in.(${inList})`);
    rows.forEach((row) => currentByRef.set(row.ref_no, row));
  }
  console.log('現在値を取得できた件数:', currentByRef.size, '/', refNos.length);

  const part1Regressions = [];
  for (const r of withRealBeforeInDate) {
    const current = currentByRef.get(r.ref_no);
    if (!current) {
      console.warn('警告: 現在のbookingsに見つからないref_no(削除済み?):', r.ref_no);
      continue;
    }
    if (isPlaceholder(current.in_date)) {
      if (excludedInDateRefs.has(r.ref_no)) continue; // 既知の6件
      part1Regressions.push({
        ref_no: r.ref_no,
        tour_name: current.tour_name || '',
        before_in_date: r.before.in_date,
        current_in_date: current.in_date,
      });
    }
  }

  console.log('\n=== パート1結果: 新たに見つかった逆行ケース(UPDATE対象、既知6件除く) ===');
  console.log(JSON.stringify(part1Regressions, null, 2));
  console.log('件数:', part1Regressions.length);

  // ── パート2: INSERT対象170件 ──────────────────────────────────────
  const inserted = JSON.parse(
    fs.readFileSync('scripts/data/access_new_bookings_backup_20260801_040802.json', 'utf8')
  );
  console.log('\nINSERT対象件数:', inserted.length);

  const reconcile = JSON.parse(fs.readFileSync('scripts/data/access_booking_reconcile.json', 'utf8'));
  const reconcileById = new Map(reconcile.map((r) => [r.id, r]));

  const part2Candidates = [];
  for (const ins of inserted) {
    const rec = reconcileById.get(ins.ref_no);
    if (!rec) {
      console.warn('警告: reconcileにref_noが見つからない:', ins.ref_no);
      continue;
    }
    const aDate = rec.A ? rec.A['出発日'] : undefined;
    const bDate = rec.B ? rec.B['出発日'] : undefined;
    const insertedDate = ins.in_date;
    if (isPlaceholder(insertedDate) && (isRealDate(aDate) || isRealDate(bDate))) {
      part2Candidates.push({
        ref_no: ins.ref_no,
        tour_name: ins.tour_name || '',
        A_出発日: aDate,
        B_出発日: bDate,
        inserted_in_date: insertedDate,
      });
    }
  }

  console.log('\n=== パート2結果: INSERT対象で要確認のケース ===');
  console.log(JSON.stringify(part2Candidates, null, 2));
  console.log('件数:', part2Candidates.length);

  // ── 出力ファイル ──────────────────────────────────────
  const outPath = 'scripts/data/in_date_regression_investigation_result.json';
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        known_excluded_ref_nos: [...excludedInDateRefs],
        part1_update_regressions: part1Regressions,
        part2_insert_candidates: part2Candidates,
        part1_checked_count: withRealBeforeInDate.length,
        part2_checked_count: inserted.length,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log('\n結果を保存しました:', outPath);
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
