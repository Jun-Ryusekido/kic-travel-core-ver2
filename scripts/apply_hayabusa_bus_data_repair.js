// scripts/dry_run_hayabusa_bus_data_repair.js が出力した実行計画(--plan)を使って、
// はやぶさ国際観光バスの30件メール由来の誤った書き込み(booking_hotelsに hotel_name=''・
// memoにメール抜粋だけが入ったドラフト行)を、正しい予約のbooking_busesへ移動する。
//
// 実行前提: 必ず dry_run_hayabusa_bus_data_repair.js の結果(バックアップJSON・実行計画)を
// JUNさんが確認し、承認を得てから実行すること。実行にはservice_roleキーが必要
// (booking_hotels/booking_busesへの直接書き込みはservice_role経由に限定済み)。
//
// 安全策:
//   1. 移動対象行の「削除前の内容」(全カラム)を、DELETE/INSERTを1件でも実行する前に
//      必ずローカルJSON(scripts/data/hayabusa_bus_repair_backup_apply_<実行日時>.json)へ
//      再保存する(dry run時点のバックアップとは別に、実行直前の最新状態をもう一度控える)。
//   2. 各行について、まずbooking_busesへのINSERTを行い、それが成功した場合のみ
//      booking_hotelsの該当行をDELETEする(INSERT失敗時に元データを失わないため、
//      削除より先に挿入する順序にしている)。
//   3. 1件failした時点で即座に処理を停止する(以降のレコードには一切手を付けない)。
//   4. 処理件数・成功件数・失敗件数を必ずログ出力し、完了後に再取得検証を行う
//      (booking_hotels側に対象行が残っていないこと、booking_buses側に正しい
//      booking_idで入っていることを確認する)。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/apply_hayabusa_bus_data_repair.js --plan <path> [--yes]
//   --yes を付けない場合、実行前に対象件数を表示し、確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SB_URL } = require('./dry_run_hayabusa_bus_data_repair');

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function parseArgs(argv) {
  const args = { plan: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') args.plan = argv[++i];
    if (argv[i] === '--yes') args.yes = true;
  }
  return args;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function sbGet(pathAndQuery) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, fields) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`INSERT ${table} failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0];
}

async function sbDeleteById(table, id) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`DELETE ${table} id=${id} failed: ${r.status} ${await r.text()}`);
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    console.error('booking_hotels/booking_busesへの書き込みはservice_roleキーが必須です。');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.plan) {
    console.error('--plan <path> で dry_run_hayabusa_bus_data_repair.js が出力した実行計画JSONを指定してください。');
    process.exit(1);
  }
  const planPath = path.resolve(args.plan);
  if (!fs.existsSync(planPath)) {
    console.error(`実行計画JSONが見つかりません: ${planPath}`);
    process.exit(1);
  }
  const { moves, unmatched, unrecognized } = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  console.log(`=== 実行計画の内容 ===`);
  console.log(`moves(booking_busesへ移動): ${(moves || []).length}件`);
  console.log(`unmatched(処理保留・未処理リスト): ${(unmatched || []).length}件 ※このスクリプトでは一切変更しません`);
  console.log(`unrecognized(要手動確認): ${(unrecognized || []).length}件 ※このスクリプトでは一切変更しません`);

  if (!moves || !moves.length) {
    console.log('moves対象が0件のため、書き込みは行いません。');
    return;
  }

  if (!args.yes) {
    console.log('\n--- 移動対象の内訳 ---');
    moves.forEach((m) => console.log(`  booking_hotels#${m.booking_hotels_id} (現在booking_id=${m.current_booking_id}) → ${m.target_ref_no} (booking_id=${m.target_booking_id}) ${m.moved_correctly_would_have_been.startsWith('different') ? '★保存先修正あり' : ''}`));
    const ans = await ask(`\n上記${moves.length}件を、booking_hotelsから削除しbooking_busesへドラフト行として挿入します。よろしいですか? (yes と入力): `);
    if (ans.trim() !== 'yes') {
      console.log('中止しました。書き込みは行っていません。');
      return;
    }
  }

  // ── 1. 実行直前の最新状態をもう一度バックアップする ──────────────────────
  console.log('\n削除対象行の最新状態を再取得してバックアップ中...');
  const ids = moves.map((m) => m.booking_hotels_id);
  const currentRows = await sbGet(`booking_hotels?select=*&id=in.(${ids.join(',')})`);

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const backupDir = path.resolve('scripts/data');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `hayabusa_bus_repair_backup_apply_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(currentRows, null, 2));
  console.log(`バックアップを保存しました: ${backupPath}`);

  if (currentRows.length !== moves.length) {
    console.error(`警告: 実行計画は${moves.length}件だが、現在booking_hotelsに実在するのは${currentRows.length}件だった。`);
    console.error('dry runの後にデータが変化した可能性があるため、内容を確認してから再度dry runをやり直してください。処理を中止します。');
    process.exit(1);
  }

  // ── 2. 1件ずつ、INSERT成功後にDELETEする。1件failしたら即座に停止する ──────
  let successCount = 0;
  const results = [];
  for (const m of moves) {
    try {
      const inserted = await sbInsert('booking_buses', {
        booking_id: m.target_booking_id,
        bus_company: '',
        bus_type: '',
        buses: 1,
        // start_date/end_date/driver_check_in/driver_check_outはdate型のため、空欄は''ではなく
        // nullを入れる(''を渡すとPostgresが 22007 invalid input syntax for type date を返す)。
        // index.htmlのbuildBusRowsもsanitizeDateFieldで同様にnull化している。
        start_date: null,
        end_date: null,
        amount: 0,
        status: '問い合わせ中',
        confirmation_no: '',
        driver_hotel_name: '',
        driver_hotel_phone: '',
        driver_hotel_address: '',
        driver_check_in: null,
        driver_check_out: null,
        driver_hotel_amount: 0,
        memo: m.memo,
        created_by: 'script:apply_hayabusa_bus_data_repair',
        updated_by: 'script:apply_hayabusa_bus_data_repair',
      });
      await sbDeleteById('booking_hotels', m.booking_hotels_id);
      successCount++;
      results.push({ ...m, new_booking_buses_id: inserted.id, status: 'ok' });
      console.log(`OK: booking_hotels#${m.booking_hotels_id} → booking_buses#${inserted.id} (${m.target_ref_no})`);
    } catch (e) {
      results.push({ ...m, status: 'error', error: e.message });
      console.error(`\nエラー発生。ここで処理を停止します(それ以前に成功した${successCount}件はそのまま反映済みです):`);
      console.error(`  booking_hotels#${m.booking_hotels_id} (${m.target_ref_no}): ${e.message}`);
      const resultsPath = path.join(backupDir, `hayabusa_bus_repair_results_${timestamp}.json`);
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      console.error(`途中経過を保存しました: ${resultsPath}`);
      process.exit(1);
    }
  }

  const resultsPath = path.join(backupDir, `hayabusa_bus_repair_results_${timestamp}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\n全${moves.length}件を処理しました(成功: ${successCount}件)。結果を保存しました: ${resultsPath}`);

  // ── 3. 再取得検証 ──────────────────────────────────────────────
  console.log('\n再取得検証中...');
  const remainingHotelsRows = await sbGet(`booking_hotels?select=id&id=in.(${ids.join(',')})`);
  console.log(`booking_hotels側に残っている対象行: ${remainingHotelsRows.length}件 (期待値: 0)`);

  const newBusIds = results.filter((r) => r.status === 'ok').map((r) => r.new_booking_buses_id);
  const insertedBusRows = await sbGet(`booking_buses?select=id,booking_id,memo&id=in.(${newBusIds.join(',')})`);
  console.log(`booking_buses側に新規挿入された行: ${insertedBusRows.length}件 (期待値: ${successCount})`);

  const byBookingId = {};
  insertedBusRows.forEach((r) => { byBookingId[r.booking_id] = (byBookingId[r.booking_id] || 0) + 1; });
  console.log('booking_idごとの挿入件数:');
  Object.entries(byBookingId).forEach(([bid, n]) => console.log(`  booking_id=${bid}: ${n}件`));

  if (remainingHotelsRows.length === 0 && insertedBusRows.length === successCount) {
    console.log('\n検証OK: booking_hotels側に対象行は残っておらず、booking_buses側に正しい件数が入っています。');
  } else {
    console.error('\n警告: 検証結果が期待値と一致しません。上記の結果ファイルを確認してください。');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('エラー:', e.message);
    process.exit(1);
  });
}
