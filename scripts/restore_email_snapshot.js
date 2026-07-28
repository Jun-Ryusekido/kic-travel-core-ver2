// email_import_queue の is_excluded/excluded_reason を、指定したスナップショットCSVの
// 内容へ復元する(ロールバック用)。実行時のみ実際にUPDATEを行う。
//
// 使い方: node scripts/restore_email_snapshot.js _dryrun/snapshot_before_bulk_20260728.csv [--dry-run]
//   --dry-run を付けると実際のUPDATEは行わず、復元対象件数と内容のみ表示する。
//
// 500件チャンクでの分割実行、既存の一括適用(index.html: runEmailExclusionBulkUpdate)と
// 同じ考え方。id/is_excluded/excluded_reasonの3列のみを対象とし、他列・削除は一切行わない。

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB'; // anonキー(email_import_queueは書き込み可能)

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim().length);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // 単純なCSVパーサ(excluded_reasonはダブルクォート囲み・""エスケープのみを想定)
    const m = line.match(/^([^,]+),([^,]+),(.*)$/);
    if (!m) continue;
    const [, id, isExcludedStr, reasonRaw] = m;
    let reason = reasonRaw.trim();
    if (reason.startsWith('"') && reason.endsWith('"')) {
      reason = reason.slice(1, -1).replace(/""/g, '"');
    }
    rows.push({ id: id.trim(), is_excluded: isExcludedStr.trim() === 'true', excluded_reason: reason || null });
  }
  return rows;
}

async function restoreFromSnapshot(csvPath, { dryRun = true } = {}) {
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const snapshotRows = parseCsv(csvText);

  if (dryRun) {
    return { totalRows: snapshotRows.length, dryRun: true, sample: snapshotRows.slice(0, 10) };
  }

  const CHUNK = 500;
  let restored = 0;
  for (let i = 0; i < snapshotRows.length; i += CHUNK) {
    const chunk = snapshotRows.slice(i, i + CHUNK);
    // is_excluded/excluded_reasonの組み合わせでグループ化して更新回数を減らす
    const groups = new Map();
    chunk.forEach(r => {
      const key = JSON.stringify({ is_excluded: r.is_excluded, excluded_reason: r.excluded_reason });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.id);
    });
    for (const [key, ids] of groups) {
      const fields = JSON.parse(key);
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/email_import_queue?id=in.(${ids.join(',')})`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(fields),
      });
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`復元に失敗しました(${restored}/${snapshotRows.length}件まで完了): ${err}`);
      }
      restored += ids.length;
    }
  }
  return { totalRows: snapshotRows.length, restored, dryRun: false };
}

if (require.main === module) {
  const csvPath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!csvPath) {
    console.error('使い方: node scripts/restore_email_snapshot.js <snapshot.csv> [--dry-run]');
    process.exit(1);
  }
  restoreFromSnapshot(csvPath, { dryRun }).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { parseCsv, restoreFromSnapshot };
