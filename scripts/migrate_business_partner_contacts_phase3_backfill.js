// business_partner_contacts フェーズ3: 一括バックフィル移行スクリプト。
//
// 背景: business_partner_contacts(フェーズ1で新設)には、フェーズ2で編集モーダル等の
// 参照箇所を一本化したが、既存のbusiness_partnersレコードのうち、担当者情報
// (contact_person/position/branch_name/phone/department_phone等)が入っているのに
// business_partner_contacts側にまだ1件も行が無い(=business_partner_contacts_table
// 新設前からの古いデータ、またはmigrate_business_partner_contacts_phase2.sql未対象の
// レコード)が残っている。これらを、代表担当者(is_primary:true)として
// business_partner_contactsへ1件ずつ新規作成する。
//
// 対象の判定: is_deleted(論理削除)の有無を問わずbusiness_partners全件を対象にする
// (削除済み会社の担当者情報も、列削除(フェーズ4)で失われる前に確実に移行しておくため)。
// 「対象」とは、(1) is_deleted=falseのbusiness_partner_contacts行が1件も無く、かつ
// (2) branch_name/branch_name_en/contact_person/contact_person_en/position/position_en/
// phone/department_phoneのいずれか1つでも値が入っているレコード。
//
// 安全策:
//   - 実行前に必ずbusiness_partners/business_partner_contacts全件のバックアップJSONを
//     取得すること(scripts/backups/。取得方法はREADME参照、本スクリプトはバックアップを
//     取得しない)。
//   - --dry-run(既定)ではINSERTを行わず、対象件数・内容のプレビューのみ出力する。
//   - --apply を付けた場合のみ実際にINSERTを行う。
//   - INSERT後、対象レコードを再取得して実際に反映されたか自己検証する。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/migrate_business_partner_contacts_phase3_backfill.js --dry-run
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/migrate_business_partner_contacts_phase3_backfill.js --apply

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY環境変数が設定されていません。処理を中断します。');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const CONTACT_KEYS = [
  'branch_name', 'branch_name_en', 'contact_person', 'contact_person_en',
  'position', 'position_en', 'phone', 'department_phone',
  'show_contact_phone', 'show_department_phone',
];
const CONTENT_KEYS = [
  'branch_name', 'branch_name_en', 'contact_person', 'contact_person_en',
  'position', 'position_en', 'phone', 'department_phone',
];

async function sbGet(path) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${offset}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function sbInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`INSERT ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function hasContent(p) {
  return CONTENT_KEYS.some((k) => p[k]);
}

async function main() {
  console.log(`===== フェーズ3バックフィル ${APPLY ? '(本実行)' : '(--dry-run プレビューのみ)'} =====`);

  const partners = await sbGet('business_partners?select=*');
  const contacts = await sbGet('business_partner_contacts?select=business_partner_id,is_deleted');
  const activeContactIds = new Set(contacts.filter((c) => !c.is_deleted).map((c) => c.business_partner_id));

  const targets = partners.filter((p) => !activeContactIds.has(p.id) && hasContent(p));

  console.log(`business_partners総数: ${partners.length}`);
  console.log(`business_partner_contactsが0件の対象(担当者情報あり): ${targets.length}件`);
  console.log(`  うち有効(is_deleted=false): ${targets.filter((p) => !p.is_deleted).length}件`);
  console.log(`  うち削除済み(is_deleted=true): ${targets.filter((p) => p.is_deleted).length}件`);

  if (targets.length === 0) {
    console.log('移行対象がありません。終了します。');
    return;
  }

  const rowsToInsert = targets.map((p) => {
    const fields = {};
    CONTACT_KEYS.forEach((k) => { fields[k] = p[k] != null ? p[k] : null; });
    return {
      business_partner_id: p.id,
      ...fields,
      is_primary: true,
      created_by: 'system_migration_phase3',
    };
  });

  console.log('\n--- プレビュー(先頭10件) ---');
  targets.slice(0, 10).forEach((p, i) => {
    console.log(`[${i + 1}] ${p.company_name}(id=${p.id}, is_deleted=${p.is_deleted}) 担当者=${p.contact_person || ''} 拠点=${p.branch_name || ''} 電話=${p.phone || ''}`);
  });

  if (!APPLY) {
    console.log('\n--dry-run のため、INSERTは実行していません。内容を確認の上、--apply を付けて再実行してください。');
    return;
  }

  console.log(`\n${rowsToInsert.length}件をbusiness_partner_contactsへINSERTします...`);
  const inserted = [];
  const failed = [];
  // 1件ずつ実行し、途中で失敗しても原因の行が特定できるようにする(一括INSERTで一部だけ
  // 失敗すると原因の特定が難しくなるため)。
  for (const row of rowsToInsert) {
    try {
      const result = await sbInsert('business_partner_contacts', [row]);
      inserted.push({ business_partner_id: row.business_partner_id, id: result[0]?.id });
    } catch (e) {
      failed.push({ business_partner_id: row.business_partner_id, error: e.message });
      console.error(`  失敗: business_partner_id=${row.business_partner_id} -- ${e.message}`);
    }
  }

  console.log(`\n挿入成功: ${inserted.length}件 / 失敗: ${failed.length}件`);
  if (failed.length) {
    console.log('失敗一覧:');
    failed.forEach((f) => console.log(`  ${f.business_partner_id}: ${f.error}`));
  }

  // 自己検証: 挿入したidを再取得し、本当に反映されたか確認する
  console.log('\n--- 自己検証 ---');
  const insertedIds = inserted.map((r) => r.id).filter(Boolean);
  if (insertedIds.length) {
    const chunkSize = 50;
    let verifiedCount = 0;
    for (let i = 0; i < insertedIds.length; i += chunkSize) {
      const chunk = insertedIds.slice(i, i + chunkSize);
      const list = chunk.map((id) => `"${id}"`).join(',');
      const rowsBack = await sbGet(`business_partner_contacts?select=id&id=in.(${list})`);
      verifiedCount += rowsBack.length;
    }
    console.log(`再取得で確認できた件数: ${verifiedCount} / ${insertedIds.length}`);
    if (verifiedCount !== insertedIds.length) {
      console.error('!!!!! 警告: 挿入したはずの行の一部が再取得で見つかりませんでした !!!!!');
    }
  }

  console.log('\n===== 完了 =====');
}

main().catch((e) => { console.error('致命的エラー:', e); process.exit(1); });
