// クレジットカード明細機能の再設計に伴う、過去データ(booking_costs.memoへの手打ち
// 「法人カード」「個人カード」)の新しいpayment_method構造への一括移行。
//
// 対象・判定方法(ユーザー確定分):
//   A. 法人カード変換候補: payment_methodが未設定(null) かつ memoに「カード」を含み、
//      「法人カード」を含み、かつ「個人カード」を含まない行。全件payment_methodを
//      'クレジットカード(法人)'に変換する。
//      card_holderは、memoに次の3つの固定文字列のいずれか1つだけが部分一致で
//      含まれる場合のみセットする(複数該当・非該当は空欄のまま。推測で埋めない):
//        memoに「今中」を含む   → card_holder = '法人カード(今中)'
//        memoに「竜石堂」を含む → card_holder = '法人カード(竜石堂)'
//        memoに「KUMAR」を含む  → card_holder = '法人カード(KUMAR)'
//   B. 個人カード変換候補: 以下4件のみ、payment_methodを
//      'クレジットカード(個人・要精算)'、personal_reimbursement_statusを'未精算'に変換する。
//      booking(ref_no末尾が62、かつpayment_method未設定)の中から、item_name・amountで
//      一意に特定する。
//        REF#62 チームラボ           15,200円
//        REF#62 ディズニーチケット    39,800円
//        REF#62 渋谷スカイ            2,200円
//        REF#62 Booking.com          56,748円
//   C. REF#122の渋谷スカイ(59,400円、法人か個人か担当者本人も未確定なメモ)は
//      自動変換の対象から明示的に除外する。A/Bいずれの対象集合にも含まれていない
//      ことを実行前に検証し、含まれていた場合は全体を中断する。
//
// 安全策(apply_restore_in_date.js / restore_f12_misjudged_invoices.jsと同じ設計):
//   1. UPDATEを1件でも実行する前に、対象全件(A+B、C除く)の現在の全カラムを
//      タイムスタンプ付きローカルJSON(scripts/data/cc_payment_method_migration_backup_<日時>.json)
//      へ保存する。
//   2. バックアップ保存後、件数の要約をコンソールに表示する。
//   3. REF#122がA/Bいずれの対象にも含まれていないことを検証し、含まれていたら中断する。
//   4. 1件でもUPDATEが失敗したら即座に停止する(以降は一切書き込まない)。
//   5. 実行後、実際にSupabaseから対象を再取得し、payment_method等が正しく反映されたか
//      件数ベースで自己検証する。
//   6. status以外の列(amount, item_name等)は一切変更しない。
//   7. PATCHのid=in.(...)にUUIDを一度に大量(637件)並べたところURL長が上限を超えて
//      400 Bad Requestになったため、PATCH_CHUNK_SIZE(100件)ずつに分割してPATCHする
//      (検証用の再取得GETも同様に分割する)。
//   8. 途中のチャンクで失敗して中断した場合に備え、対象行はA/Bともに毎回
//      「payment_methodが未設定(null)」の行だけを実行時に再取得して抽出する。
//      そのため、再実行時は既に変換済みの行(payment_methodが設定済み)は
//      自動的に対象から外れ、二重変換や重複UPDATEにはならない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/apply_cc_payment_method_migration.js [--yes]
//   --yesを付けない場合、対象件数を表示して確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CARD_HOLDER_RULES = [
  { keyword: '今中', card_holder: '法人カード(今中)' },
  { keyword: '竜石堂', card_holder: '法人カード(竜石堂)' },
  { keyword: 'KUMAR', card_holder: '法人カード(KUMAR)' },
];

const PERSONAL_TARGETS = [
  { refDigits: '62', itemKeyword: 'チームラボ', amount: 15200 },
  { refDigits: '62', itemKeyword: 'ディズニー', amount: 39800 },
  { refDigits: '62', itemKeyword: '渋谷スカイ', amount: 2200 },
  { refDigits: '62', itemKeyword: 'Booking', amount: 56748 },
];
const EXCLUDED_REF_DIGITS = '122';
const EXCLUDED_ITEM_KEYWORD = '渋谷スカイ';
const EXCLUDED_AMOUNT = 59400;

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

// id=in.(...)にUUIDを大量に並べるとURL長が上限(プロキシ/サーバー側の制限、実際に
// 637件でid句だけ約2.5万文字になり400 Bad Requestが発生した)を超えるため、
// PATCH_CHUNK_SIZE件ずつに分割して複数回に分けてPATCHする。
const PATCH_CHUNK_SIZE = 100;
async function sbPatchByIds(table, ids, fields) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += PATCH_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + PATCH_CHUNK_SIZE);
    const inList = chunk.map((id) => `"${id}"`).join(',');
    const r = await fetch(`${SB_URL}/rest/v1/${table}?id=in.(${inList})`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(fields),
    });
    if (!r.ok) {
      throw new Error(
        `UPDATE ${table} id in (${chunk.length}件、全${ids.length}件中${i}件目〜) failed: ${r.status} ${await r.text()}\n` +
          `このチャンクの手前(${i}件)までは反映済みの可能性があります。再実行時はpayment_method未設定の行のみを` +
          `再取得するため、既に反映済みの行は自動的に対象から外れます。`
      );
    }
  }
}

// ref_noの末尾の数字部分だけを比較する(「#62」「62」等、表記ゆれを吸収するため)。
function refDigitsOf(refNo) {
  const m = String(refNo || '').match(/(\d+)\s*$/);
  return m ? m[1] : '';
}

function classifyCardHolder(memo) {
  const matched = CARD_HOLDER_RULES.filter((rule) => String(memo || '').includes(rule.keyword));
  if (matched.length === 1) return matched[0].card_holder;
  return null; // 非該当、または複数該当(曖昧)は空欄のまま
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }
  const yes = process.argv.includes('--yes');

  const bookings = await sbGet('bookings?select=id,ref_no');
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  // --- A. 法人カード候補の抽出(openCcPaymentMigrationPreview.jsと同じ条件) ---
  const rows = [];
  const PAGE_SIZE = 1000;
  for (let page = 0; page < 10; page++) {
    const data = await sbGet(
      `booking_costs?select=*&payment_method=is.null&memo=ilike.*カード*&order=id&offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`
    );
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  const corporateRows = rows.filter((r) => (r.memo || '').includes('法人カード') && !(r.memo || '').includes('個人カード'));

  // --- B. 個人カード候補4件の特定 ---
  const personalRows = [];
  for (const target of PERSONAL_TARGETS) {
    const candidates = rows.filter((r) => {
      const b = bookingById.get(r.booking_id);
      if (!b || refDigitsOf(b.ref_no) !== target.refDigits) return false;
      if (!(r.item_name || '').includes(target.itemKeyword)) return false;
      return Number(r.amount) === target.amount;
    });
    if (candidates.length !== 1) {
      console.error(
        `個人カード対象の特定に失敗しました(REF#${target.refDigits} / ${target.itemKeyword} / ${target.amount}円): ` +
          `${candidates.length}件ヒット(1件のはず)。処理を中止します。`
      );
      process.exit(1);
    }
    personalRows.push(candidates[0]);
  }

  // --- C. REF#122除外の検証 ---
  const excludedCandidates = rows.filter((r) => {
    const b = bookingById.get(r.booking_id);
    if (!b || refDigitsOf(b.ref_no) !== EXCLUDED_REF_DIGITS) return false;
    if (!(r.item_name || '').includes(EXCLUDED_ITEM_KEYWORD)) return false;
    return Number(r.amount) === EXCLUDED_AMOUNT;
  });
  const excludedInCorporate = corporateRows.some((r) => excludedCandidates.some((e) => e.id === r.id));
  const excludedInPersonal = personalRows.some((r) => excludedCandidates.some((e) => e.id === r.id));
  if (excludedInCorporate || excludedInPersonal) {
    console.error(`REF#${EXCLUDED_REF_DIGITS}の対象行が変換対象に含まれてしまっています。安全のため処理を中止します。`);
    process.exit(1);
  }
  console.log(
    `REF#${EXCLUDED_REF_DIGITS}(${EXCLUDED_ITEM_KEYWORD}、${EXCLUDED_AMOUNT}円)の除外検証: ` +
      `該当行${excludedCandidates.length}件、うち変換対象に混入0件を確認しました。`
  );

  // --- card_holderの判定 ---
  const corporateWithHolder = corporateRows.map((r) => ({ ...r, _newCardHolder: classifyCardHolder(r.memo) }));
  const holderCounts = { '法人カード(今中)': 0, '法人カード(竜石堂)': 0, '法人カード(KUMAR)': 0, 未判定: 0 };
  corporateWithHolder.forEach((r) => {
    if (r._newCardHolder) holderCounts[r._newCardHolder]++;
    else holderCounts['未判定']++;
  });

  console.log(`\n=== 対象件数 ===`);
  console.log(`法人カード変換候補: ${corporateRows.length}件`);
  console.log(`  card_holder判定内訳:`);
  Object.entries(holderCounts).forEach(([k, v]) => console.log(`    ${k}: ${v}件`));
  console.log(`個人カード変換候補: ${personalRows.length}件`);
  personalRows.forEach((r) => {
    const b = bookingById.get(r.booking_id);
    console.log(`  REF#${b ? b.ref_no : r.booking_id} / ${r.item_name} / ${Number(r.amount).toLocaleString()}円`);
  });

  if (!yes) {
    const ans = await ask(
      `\n法人${corporateRows.length}件・個人${personalRows.length}件、合計${corporateRows.length + personalRows.length}件をUPDATEします。よろしいですか？ (yes/no): `
    );
    if (ans.trim().toLowerCase() !== 'yes') {
      console.log('中止しました。');
      return;
    }
  }

  // --- バックアップ(変更前の全カラム)を先に保存 ---
  const ts = new Date();
  const tsStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
  const backupPath = path.resolve(`scripts/data/cc_payment_method_migration_backup_${tsStr}.json`);
  const backup = {
    generated_at: new Date().toISOString(),
    corporate: corporateWithHolder.map((r) => ({ before: r, after: { payment_method: 'クレジットカード(法人)', card_holder: r._newCardHolder || null } })),
    personal: personalRows.map((r) => ({ before: r, after: { payment_method: 'クレジットカード(個人・要精算)', personal_reimbursement_status: '未精算' } })),
  };
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\nバックアップを保存しました: ${backupPath}`);
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (reread.corporate.length !== corporateRows.length || reread.personal.length !== personalRows.length) {
    console.error('バックアップの読み戻し確認に失敗しました。処理を中止します。');
    process.exit(1);
  }
  console.log('バックアップの読み戻し確認OK。UPDATEを開始します。\n');

  // --- UPDATE実行(1件でも失敗したら即座に停止) ---
  try {
    // 法人カード: card_holderの値ごとに4グループ(今中/竜石堂/KUMAR/未判定=null)へ分けてPATCH
    const groups = new Map(); // card_holder(またはnull) -> ids
    corporateWithHolder.forEach((r) => {
      const key = r._newCardHolder || '__NULL__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.id);
    });
    for (const [key, ids] of groups) {
      const card_holder = key === '__NULL__' ? null : key;
      await sbPatchByIds('booking_costs', ids, { payment_method: 'クレジットカード(法人)', card_holder });
      console.log(`✓ 法人カード(card_holder=${card_holder || '(空欄)'}) ${ids.length}件 UPDATE完了`);
    }

    // 個人カード4件
    await sbPatchByIds(
      'booking_costs',
      personalRows.map((r) => r.id),
      { payment_method: 'クレジットカード(個人・要精算)', personal_reimbursement_status: '未精算' }
    );
    console.log(`✓ 個人カード ${personalRows.length}件 UPDATE完了`);
  } catch (e) {
    console.error(`\nUPDATE中にエラーが発生しました。以降の処理は行っていません: ${e.message}`);
    console.error(`バックアップ(${backupPath})を参照し、必要に応じて手動で復旧してください。`);
    process.exit(1);
  }

  // --- 自己検証: 実際に再取得し、反映されたか件数ベースで確認 ---
  console.log('\n再取得による検証中...');
  const allIds = [...corporateRows.map((r) => r.id), ...personalRows.map((r) => r.id)];
  const verifyRows = [];
  for (let i = 0; i < allIds.length; i += PATCH_CHUNK_SIZE) {
    const chunk = allIds.slice(i, i + PATCH_CHUNK_SIZE);
    const inList = chunk.map((id) => `"${id}"`).join(',');
    const data = await sbGet(`booking_costs?select=id,payment_method,card_holder,personal_reimbursement_status,amount&id=in.(${inList})`);
    verifyRows.push(...data);
  }
  const verifyById = new Map(verifyRows.map((r) => [r.id, r]));
  let corpOk = 0, corpMismatch = [];
  corporateWithHolder.forEach((r) => {
    const cur = verifyById.get(r.id);
    if (cur && cur.payment_method === 'クレジットカード(法人)' && (cur.card_holder || null) === (r._newCardHolder || null) && Number(cur.amount) === Number(r.amount)) {
      corpOk++;
    } else {
      corpMismatch.push({ id: r.id, expected: r._newCardHolder || null, actual: cur });
    }
  });
  let persOk = 0, persMismatch = [];
  personalRows.forEach((r) => {
    const cur = verifyById.get(r.id);
    if (cur && cur.payment_method === 'クレジットカード(個人・要精算)' && cur.personal_reimbursement_status === '未精算' && Number(cur.amount) === Number(r.amount)) {
      persOk++;
    } else {
      persMismatch.push({ id: r.id, actual: cur });
    }
  });
  console.log(`法人カード 検証OK: ${corpOk} / ${corporateRows.length}`);
  console.log(`個人カード 検証OK: ${persOk} / ${personalRows.length}`);
  if (corpMismatch.length) {
    console.log('\n=== 法人カード 検証で不一致だったもの ===');
    console.log(JSON.stringify(corpMismatch, null, 2));
  }
  if (persMismatch.length) {
    console.log('\n=== 個人カード 検証で不一致だったもの ===');
    console.log(JSON.stringify(persMismatch, null, 2));
  }

  const resultPath = 'scripts/data/cc_payment_method_migration_apply_result.json';
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        backup_path: backupPath,
        corporate_total: corporateRows.length,
        corporate_card_holder_counts: holderCounts,
        personal_total: personalRows.length,
        excluded_ref: EXCLUDED_REF_DIGITS,
        excluded_check_candidates: excludedCandidates.length,
        verify_corporate_ok: corpOk,
        verify_corporate_mismatch: corpMismatch,
        verify_personal_ok: persOk,
        verify_personal_mismatch: persMismatch,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\n結果を保存しました: ${resultPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
