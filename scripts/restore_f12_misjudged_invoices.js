// F12(入金消込の誤paid判定)の是正: scripts/audit_f12_invoice_agent_mismatch.js で
// 「エージェント単位で見ると入金不足にも関わらずpaidになっている」と検出された
// Invoice 4件(INV-260612-698, INV-1160, INV-1160-2, INV-1160-3)のstatusを
// pendingに戻す。invoice_amount等、status以外の列は一切変更しない。
//
// apply_restore_in_date.js / backup_and_truncate_cc_statements.js と同じ安全設計:
//   1. UPDATEを1件でも実行する前に、対象4件の現在の全カラムをタイムスタンプ付き
//      ローカルJSON(scripts/data/restore_f12_invoices_backup_<実行日時>.json)へ保存する。
//   2. バックアップ保存後、その内容をコンソールに表示する。
//   3. 各対象について、booking_sales(該当bookingの全行)からエージェント単位の
//      入金合計/売上合計を再計算し、「本当に入金不足(paid<sales、またはpaid=0)」で
//      あることを再確認する。想定と異なる(=既に入金十分)対象が1件でもあれば、
//      その対象はUPDATE対象から除外し、理由を表示する(安全のため対象を広げない)。
//   4. 1件failした時点で即座に処理を停止する(以降のレコードには一切手を付けない)。
//   5. 実行後、実際にSupabaseから対象を再取得し、statusが'pending'に
//      なっているか自己検証する。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/restore_f12_misjudged_invoices.js [--yes]
//   --yesを付けない場合、対象件数を表示して確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 対象Invoice(監査スクリプトの結果に基づく。invoice_amount等の他列はチェックのみに使い、変更しない)
const TARGET_INVOICE_NOS = ['INV-260612-698', 'INV-1160', 'INV-1160-2', 'INV-1160-3'];
const NEW_STATUS = 'pending'; // invoicesの既存ステータス体系(pending/paid/overdue)に沿った「未確定に戻す」値

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

async function sbUpdateById(table, id, fields) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`UPDATE ${table} id=${id} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }
  const yes = process.argv.includes('--yes');

  const orFilter = TARGET_INVOICE_NOS.map((n) => `invoice_no.eq.${n}`).join(',');
  const invoices = await sbGet(`invoices?select=*&or=(${orFilter})`);
  if (invoices.length !== TARGET_INVOICE_NOS.length) {
    console.error(
      `対象${TARGET_INVOICE_NOS.length}件のはずが${invoices.length}件しか見つかりませんでした。見つかったinvoice_no: ` +
        invoices.map((i) => i.invoice_no).join(', ')
    );
    console.error('想定外のため処理を中止します(部分実行はしない)。');
    process.exit(1);
  }

  console.log(`対象${invoices.length}件を取得しました:`);
  invoices.forEach((inv) => {
    console.log(`  ${inv.invoice_no} (id=${inv.id}, booking_id=${inv.booking_id}, agent_name=${inv.agent_name}, status=${inv.status}, amount=${inv.amount})`);
  });

  // ── 再確認: booking_salesからエージェント単位の入金合計/売上合計を再計算 ──
  const bookingIds = [...new Set(invoices.map((i) => i.booking_id))];
  const bookings = await sbGet(`bookings?select=id,ref_no,agent_name&id=in.(${bookingIds.map((id) => `"${id}"`).join(',')})`);
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const salesRows = await sbGet(`booking_sales?select=booking_id,agent_name,amount,payments&booking_id=in.(${bookingIds.map((id) => `"${id}"`).join(',')})`);

  const recheck = [];
  const updatable = [];
  const skipped = [];
  for (const inv of invoices) {
    const booking = bookingById.get(inv.booking_id);
    const bookingAgent = booking ? (booking.agent_name || '').trim() : '';
    const invAgent = (inv.agent_name || '').trim();
    let sales = 0, paid = 0;
    salesRows
      .filter((r) => r.booking_id === inv.booking_id)
      .forEach((r) => {
        const agent = (r.agent_name && r.agent_name.trim()) ? r.agent_name.trim() : bookingAgent;
        if (agent !== invAgent) return;
        sales += Number(r.amount || 0);
        paid += (Array.isArray(r.payments) ? r.payments : []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      });
    const insufficientAsExpected = !(paid > 0 && paid >= sales);
    recheck.push({
      invoice_no: inv.invoice_no, booking_ref: booking ? booking.ref_no : inv.booking_id,
      agent_name: invAgent, agent_sales_total: sales, agent_paid_total: paid,
      insufficientAsExpected,
    });
    if (insufficientAsExpected) updatable.push(inv);
    else skipped.push(inv);
  }

  console.log('\n=== 再確認結果(agent_sales_total / agent_paid_total) ===');
  console.table(recheck);

  if (skipped.length) {
    console.log(`\n⚠ ${skipped.length}件は再確認の結果、想定(入金不足)と異なっていたためUPDATE対象から除外します:`);
    skipped.forEach((inv) => console.log(`  ${inv.invoice_no}`));
  }

  if (updatable.length === 0) {
    console.log('\nUPDATE対象がありません。処理を終了します。');
    return;
  }

  if (!yes) {
    const ans = await ask(`\n${updatable.length}件のstatusを '${NEW_STATUS}' にUPDATEします。よろしいですか？ (yes/no): `);
    if (ans.trim().toLowerCase() !== 'yes') {
      console.log('中止しました。');
      return;
    }
  }

  // ── バックアップ(変更前の全カラム)を先に保存 ──
  const ts = new Date();
  const tsStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
  const backupPath = path.resolve(`scripts/data/restore_f12_invoices_backup_${tsStr}.json`);
  const backup = updatable.map((inv) => ({ before: inv, after_status: NEW_STATUS }));
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\nバックアップを保存しました: ${backupPath}`);

  // 読み戻し確認
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (reread.length !== updatable.length) {
    console.error('バックアップの読み戻し確認に失敗しました。処理を中止します。');
    process.exit(1);
  }
  console.log('バックアップの読み戻し確認OK。内容:');
  console.log(JSON.stringify(reread, null, 2));
  console.log('\nUPDATEを開始します。\n');

  const succeeded = [];
  const failed = [];
  for (const inv of updatable) {
    try {
      await sbUpdateById('invoices', inv.id, { status: NEW_STATUS });
      succeeded.push(inv);
      process.stdout.write('.');
    } catch (e) {
      failed.push({ invoice_no: inv.invoice_no, id: inv.id, error: e.message });
      console.error(`\n失敗: ${inv.invoice_no} (${inv.id}): ${e.message}`);
      break; // 1件failした時点で即座に停止
    }
  }
  console.log(`\n\nUPDATE完了: 成功 ${succeeded.length}件 / 失敗 ${failed.length}件 / 未実行 ${updatable.length - succeeded.length - failed.length}件`);

  if (failed.length) {
    console.log('\n=== 失敗詳細 ===');
    console.log(JSON.stringify(failed, null, 2));
  }

  // ── 自己検証: 実際に再取得し、statusがNEW_STATUSになっているか確認 ──
  console.log('\n再取得による検証中...');
  const succeededIds = succeeded.map((inv) => inv.id);
  let verifyOk = 0;
  const verifyMismatch = [];
  if (succeededIds.length) {
    const rows = await sbGet(`invoices?select=id,invoice_no,status,amount&id=in.(${succeededIds.map((id) => `"${id}"`).join(',')})`);
    const currentById = new Map(rows.map((r) => [r.id, r]));
    for (const inv of succeeded) {
      const cur = currentById.get(inv.id);
      if (!cur) {
        verifyMismatch.push({ invoice_no: inv.invoice_no, id: inv.id, reason: '再取得できず' });
        continue;
      }
      if (cur.status === NEW_STATUS && Number(cur.amount) === Number(inv.amount)) {
        verifyOk++;
      } else {
        verifyMismatch.push({ invoice_no: inv.invoice_no, id: inv.id, expected_status: NEW_STATUS, actual: cur });
      }
    }
  }
  console.log(`検証OK: ${verifyOk} / ${succeeded.length}(amountが変更されていないことも確認)`);
  if (verifyMismatch.length) {
    console.log('\n=== 検証で不一致だったもの ===');
    console.log(JSON.stringify(verifyMismatch, null, 2));
  }

  const resultPath = 'scripts/data/restore_f12_invoices_apply_result.json';
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        backup_path: backupPath,
        target_invoice_nos: TARGET_INVOICE_NOS,
        new_status: NEW_STATUS,
        recheck,
        skipped_invoice_nos: skipped.map((inv) => inv.invoice_no),
        succeeded_count: succeeded.length,
        failed_count: failed.length,
        not_executed_count: updatable.length - succeeded.length - failed.length,
        failed,
        verify_ok_count: verifyOk,
        verify_mismatch: verifyMismatch,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\n結果を保存しました: ${resultPath}`);
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
