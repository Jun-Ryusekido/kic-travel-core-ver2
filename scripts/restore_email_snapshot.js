// 【実行に必要な環境変数】SUPABASE_SERVICE_ROLE_KEY(必須。anonキーでは実行できない)
//   値の取得: Supabase管理画面 > Project Settings > API Keys > service_role(secret)
//   設定・実行(PowerShell): $env:SUPABASE_SERVICE_ROLE_KEY="<値>"; node scripts/restore_email_snapshot.js
//   設定・実行(bash):       SUPABASE_SERVICE_ROLE_KEY=<値> node scripts/restore_email_snapshot.js
//   キーはファイルに書かずコミットしないこと。未設定時はanonキーにフォールバックせずエラー終了する
//   (2026-09 RLS対応フェーズ1で全スクリプトをservice_role必須に統一)。
// email_import_queue の is_excluded/excluded_reason を、指定したスナップショットCSVの
// 内容へ復元する(ロールバック用)。実行時のみ実際にUPDATEを行う。
//
// 使い方: node scripts/restore_email_snapshot.js _dryrun/snapshot_before_bulk_20260728.csv [--dry-run] [--ids=id1,id2,...]
//   --dry-run を付けると実際のUPDATEは行わず、復元対象件数と内容のみ表示する。
//   --ids=... を付けると、指定したid群のみを復元対象にする(検証等でテーブル全体を
//   触らずに済ませるための絞り込みオプション。省略時はCSV内の全行が対象)。
//
// 500件チャンクでの分割実行、既存の一括適用(index.html: runEmailExclusionBulkUpdate)と
// 同じ考え方。id/is_excluded/excluded_reasonの3列のみを対象とし、他列・削除は一切行わない。

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
function requireServiceRoleKey(key) {
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEYが未設定です。anonでは実行できません(anonキーはRLS有効化・権限剥奪によりテーブルを読み書きできず、空の結果による誤判定や書き込み失敗の原因になるため)。ファイル冒頭の【実行に必要な環境変数】の手順で設定してから再実行してください。');
    process.exit(1);
  }
}
requireServiceRoleKey(SUPABASE_KEY);

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

async function restoreFromSnapshot(csvPath, { dryRun = true, onlyIds = null } = {}) {
  const csvText = fs.readFileSync(csvPath, 'utf8');
  let snapshotRows = parseCsv(csvText);
  if (onlyIds && onlyIds.length) {
    const idSet = new Set(onlyIds);
    snapshotRows = snapshotRows.filter(r => idSet.has(r.id));
  }

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
  const idsArg = process.argv.find(a => a.startsWith('--ids='));
  const onlyIds = idsArg ? idsArg.slice('--ids='.length).split(',').map(s => s.trim()).filter(Boolean) : null;
  if (!csvPath) {
    console.error('使い方: node scripts/restore_email_snapshot.js <snapshot.csv> [--dry-run] [--ids=id1,id2,...]');
    process.exit(1);
  }
  restoreFromSnapshot(csvPath, { dryRun, onlyIds }).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { parseCsv, restoreFromSnapshot };
