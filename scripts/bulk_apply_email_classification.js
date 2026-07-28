// STEP5: email_import_queue全件(imported=false かつ ignored=false)に対し、
// classifyEmail(取り込みリスト方式・STEP3の年号ガード反映後)で再判定し、
// 現在のis_excluded/excluded_reasonと異なる場合のみ更新する。
// excluded_reason='手動で対象外に設定'の行は判定にかけずスキップ(保護)。
// 500件チャンクで分割実行。冪等(同じ状態のレコードは何度実行してもスキップされるだけ)。

const { classifyEmail } = require('./classify_email');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';
const MANUAL_REASON = '手動で対象外に設定';
const AUTO_EXCLUDE_REASON = '自動判定：取り込み条件に非該当';

async function fetchAll(table, select, filters = '') {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${filters}&order=id.asc`;
    const resp = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Range: `${from}-${from + pageSize - 1}` } });
    const data = await resp.json();
    if (!Array.isArray(data)) { throw new Error('unexpected response: ' + JSON.stringify(data)); }
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function patchChunk(ids, fields) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/email_import_queue?id=in.(${ids.join(',')})`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`PATCH失敗: ${err}`);
  }
}

async function main() {
  console.log('=== STEP5: 一括適用開始 ===');

  console.log('bookings.ref_no を取得中...');
  const bookings = await fetchAll('bookings', 'id,ref_no');
  const refSet = new Set(bookings.map(b => String(b.ref_no || '').replace(/^#/, '')).filter(Boolean));
  console.log('refSet件数:', refSet.size);

  console.log('email_import_queue(imported=false, ignored=false)を取得中...');
  const rows = await fetchAll('email_import_queue', 'id,subject,body,is_excluded,excluded_reason', '&imported=eq.false&ignored=eq.false');
  console.log('対象件数:', rows.length);

  let skippedManual = 0;
  let skippedNoChange = 0;
  const toExclude = []; // {id}
  const toInclude = []; // {id}

  for (const row of rows) {
    if (row.excluded_reason === MANUAL_REASON) {
      skippedManual++;
      continue;
    }
    const result = classifyEmail({ subject: row.subject, body: row.body, attachmentNames: [], refSet });
    const desiredIsExcluded = !result.isImport;
    const desiredReason = desiredIsExcluded ? AUTO_EXCLUDE_REASON : null;

    if (row.is_excluded === desiredIsExcluded && row.excluded_reason === desiredReason) {
      skippedNoChange++;
      continue;
    }

    if (desiredIsExcluded) toExclude.push(row.id);
    else toInclude.push(row.id);
  }

  console.log('\n=== 判定結果 ===');
  console.log('手動保護でスキップ:', skippedManual);
  console.log('変更不要でスキップ:', skippedNoChange);
  console.log('新たに対象外に設定(予定):', toExclude.length);
  console.log('新たに業務メールに戻す(予定):', toInclude.length);

  const CHUNK = 500;
  let updated = 0;
  const totalToUpdate = toExclude.length + toInclude.length;

  console.log('\n=== 対象外へ更新中 ===');
  for (let i = 0; i < toExclude.length; i += CHUNK) {
    const chunk = toExclude.slice(i, i + CHUNK);
    await patchChunk(chunk, { is_excluded: true, excluded_reason: AUTO_EXCLUDE_REASON });
    updated += chunk.length;
    console.log(`チャンク完了: ${chunk.length}件処理 / 累計 ${updated}/${totalToUpdate}`);
  }

  console.log('\n=== 業務メールへ更新中 ===');
  for (let i = 0; i < toInclude.length; i += CHUNK) {
    const chunk = toInclude.slice(i, i + CHUNK);
    await patchChunk(chunk, { is_excluded: false, excluded_reason: null });
    updated += chunk.length;
    console.log(`チャンク完了: ${chunk.length}件処理 / 累計 ${updated}/${totalToUpdate}`);
  }

  console.log('\n=== 完了 ===');
  console.log('総件数(判定対象):', rows.length);
  console.log('更新件数:', updated);
  console.log('スキップ件数(手動保護):', skippedManual);
  console.log('スキップ件数(変更不要):', skippedNoChange);
}

main().catch(e => {
  console.error('\n=== エラーで中断 ===');
  console.error(e.message);
  process.exit(1);
});
