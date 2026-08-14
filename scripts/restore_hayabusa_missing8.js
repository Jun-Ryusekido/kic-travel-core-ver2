// はやぶさ国際観光バスの30件横断メール(email_import_queue id=8e849036-a3b0-498d-a17b-8ef28fac9a49、
// 2026-08-12受信)のうち、AI抽出(/api/extract-email-refs)が候補に挙げられず、どのテーブルにも
// 書き込まれないまま失われた8件を、元のメール本文からbooking_busesのドラフト行として復旧する。
//
// 経緯:
//   本文には「団体名：KICxxxx」が30件含まれていたが、確認モーダルに並んだ候補は18件のみだった。
//   その18件は全て送信に成功したため submitEmailSplit が imported=true を立ててメールを受信箱から
//   消してしまい、残り12件は取りこぼされた(index.htmlの当該不具合は 73098f6 で修正済み)。
//   12件のうち4件(KIC1303/1305/1307/1314)は催行未定でbookings自体が存在しないため対象外とし、
//   bookingsが実在する8件のみをここで復旧する。
//
// 事前確認済み(2026-08-14、読み取りのみ):
//   - 対象7予約(#1172/#1304/#1311/#1313/#1315/#1318/#1322)はいずれもbookingsに実在する
//   - 7予約すべてbooking_busesが0件(重複の心配がない)
//   - booking_hotels/booking_busesの両テーブルをmemo横断検索しても8コードとも該当なし
//
// 安全策:
//   1. 追加前に、対象予約のbooking_busesに同じ団体名コードを含む行が既に無いか毎回確認し、
//      あればその行はスキップする(再実行しても二重登録にならない)。
//   2. 追加したIDは scripts/data/hayabusa_missing8_restore_result_<timestamp>.json に記録し、
//      後から一括で特定・削除できるようにする(created_byにも専用の目印を入れる)。
//   3. 1件failした時点で停止し、それまでの結果を書き出す。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/restore_hayabusa_missing8.js [--yes]

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CREATED_BY = 'script:restore_hayabusa_missing8';
// memoに付ける復旧の注記。元のメール抜粋の下に1行足すだけで、抜粋本文自体は改変しない。
const RESTORE_NOTE = '※2026-08-14 メール取りこぼし分を復旧（2026-08-12受信のはやぶさ国際観光バス30件メールで、AI抽出漏れによりメール受信時に作成されなかった分）';

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function sbGet(q) {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${q}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, fields) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`INSERT ${table}: ${r.status} ${await r.text()}`);
  return (await r.json())[0];
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }
  const yes = process.argv.includes('--yes');
  const excerpts = JSON.parse(fs.readFileSync(path.resolve('scripts/data/hayabusa_missing8_excerpts.json'), 'utf8'));
  console.log(`復旧対象: ${excerpts.length}件\n`);

  // ── 1. 対象予約の実在確認と、既存booking_busesの重複チェック ────────────────
  const plan = [];
  for (const e of excerpts) {
    const bk = await sbGet(`bookings?select=id,ref_no,tour_code&ref_no=eq.${encodeURIComponent(e.ref)}`);
    if (!bk.length) { console.error(`★ ${e.ref} がbookingsに存在しません。中止します。`); process.exit(1); }
    const existing = await sbGet(`booking_buses?select=id,memo&booking_id=eq.${bk[0].id}`);
    const dup = existing.find(x => String(x.memo || '').includes(e.code));
    plan.push({ ...e, booking_id: bk[0].id, tour_code: bk[0].tour_code, skip: !!dup, dupId: dup ? dup.id : null });
    console.log(`  ${e.ref.padEnd(6)} ${e.code.padEnd(14)} booking_id=${bk[0].id} 既存バス行=${existing.length}件 ${dup ? '★同じ団体名の行が既にあるためスキップ' : ''}`);
  }

  const targets = plan.filter(p => !p.skip);
  console.log(`\n実際に追加するのは ${targets.length}件 (スキップ ${plan.length - targets.length}件)`);
  if (!targets.length) { console.log('追加対象がありません。終了します。'); return; }
  if (!yes) { console.log('\n--yes を付けて実行してください(確認のため実行しません)。'); return; }

  // ── 2. 1件ずつINSERT。失敗したら即停止 ───────────────────────────────
  const results = [];
  for (const t of targets) {
    try {
      const row = await sbInsert('booking_buses', {
        booking_id: t.booking_id,
        bus_company: '',
        bus_type: '',
        buses: 1,
        // date型のため空欄はnull(''を渡すと 22007 invalid input syntax for type date になる)
        start_date: null,
        end_date: null,
        amount: 0,
        status: '問い合わせ中',
        confirmation_no: '',
        memo: `${t.excerpt}\n${RESTORE_NOTE}`,
        created_by: CREATED_BY,
        updated_by: CREATED_BY,
      });
      results.push({ ...t, new_id: row.id, status: 'ok' });
      console.log(`OK: ${t.ref} ${t.code} → booking_buses#${row.id}`);
    } catch (err) {
      results.push({ ...t, status: 'error', error: err.message });
      console.error(`\nエラーのため停止します(それ以前の${results.filter(r => r.status === 'ok').length}件は反映済み): ${err.message}`);
      break;
    }
  }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const outPath = path.resolve(`scripts/data/hayabusa_missing8_restore_result_${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n結果を保存しました: ${outPath}`);

  // ── 3. 再取得検証 ──────────────────────────────────────────────
  console.log('\n再取得検証中...');
  const ok = results.filter(r => r.status === 'ok');
  const rows = await sbGet(`booking_buses?select=id,booking_id,memo,start_date,status,amount&created_by=eq.${encodeURIComponent(CREATED_BY)}`);
  console.log(`created_by='${CREATED_BY}' の行: ${rows.length}件 (期待値: ${ok.length})`);
  const byBooking = {};
  rows.forEach(r => { byBooking[r.booking_id] = (byBooking[r.booking_id] || 0) + 1; });
  for (const p of plan) {
    const n = byBooking[p.booking_id] || 0;
    console.log(`  ${p.ref.padEnd(6)} ${p.code.padEnd(14)} → ${n}件`);
  }
  const allNoteOk = rows.every(r => String(r.memo).includes(RESTORE_NOTE));
  const allDraft = rows.every(r => r.start_date === null && r.status === '問い合わせ中' && Number(r.amount) === 0);
  console.log(`memoに復旧注記が入っているか: ${allNoteOk ? 'OK' : 'NG'}`);
  console.log(`ドラフト行の体裁(日付null/問い合わせ中/¥0): ${allDraft ? 'OK' : 'NG'}`);
  console.log(rows.length === ok.length && allNoteOk && allDraft ? '\n検証OK' : '\n★検証で期待値と一致しない項目があります');
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
