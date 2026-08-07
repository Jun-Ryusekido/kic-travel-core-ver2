// email_import_queueの重複データ(subject+sender+received_atが完全一致)を削除する。
//
// 背景: catchup-missed-mail.ps1がLastCheckの更新前に中断される等で同じ期間のメールを
// 複数回取り込んでしまい、2600件超の完全重複(件名・送信者・受信日時が全て一致)が
// 蓄積していたことが判明した(2026-08-07調査)。
//
// 「完全重複」の定義はsubject+sender+received_atの3項目一致で、これは受信箱UI側の
// dedupeEmailInboxRows(index.html)と同じ判定基準(表示側は間引くだけでDBは削除しない
// 設計だったが、今回は実データ側も整理する)。sender+received_atのみの2項目一致では
// 「同じ送信者から同時刻に届いた別件名の正当な別メール」まで拾ってしまうため使わない。
//
// 各重複グループの中で残す1件を選ぶ優先順位:
//   1. imported=true(既に予約に取り込み済み=運用者の作業が乗っている)を最優先で残す
//   2. ignored=true(運用者が明示的に「対象外」と判断した)を次に優先
//   3. どちらも同値ならcreated_atが最も古いもの(最初に取り込まれたもの)を残す
// これはemail_import_queueの他列(is_excluded/excluded_reason/postponed)を見ても、
// 運用者の判断が乗っている行を誤って消さないための優先順位。
//
// 安全策:
//   1. 削除対象を1件でも実行する前に、重複グループ全行(残す分・消す分の両方)を
//      ローカルJSON(scripts/data/email_import_queue_dedupe_backup_<実行日時>.json)へ
//      保存する。
//   2. 既定はドライラン(--apply を付けない限り実際には削除しない)。
//   3. 削除はidのリストでin()指定して一括実行し、実行後に削除件数を検証する。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/dedupe_email_import_queue.js            (ドライラン)
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/dedupe_email_import_queue.js --apply     (本番実行)

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PAGE_SIZE = 1000;

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function fetchAllRows() {
  const rows = [];
  let from = 0;
  for (;;) {
    const url = `${SB_URL}/rest/v1/email_import_queue?select=id,subject,sender,received_at,created_at,imported,ignored,postponed,is_excluded&order=created_at.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + PAGE_SIZE - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) throw new Error(`取得に失敗しました: ${res.status} ${await res.text()}`);
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function groupKey(r) {
  return `${r.subject || ''} ${r.sender || ''} ${r.received_at || ''}`;
}

// グループ内で残す1件を選ぶ。imported > ignored > created_at最古の優先順位。
function pickKeeper(group) {
  const sorted = [...group].sort((a, b) => {
    if (!!b.imported !== !!a.imported) return (b.imported ? 1 : 0) - (a.imported ? 1 : 0);
    if (!!b.ignored !== !!a.ignored) return (b.ignored ? 1 : 0) - (a.ignored ? 1 : 0);
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return sorted[0];
}

function buildPlan(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = groupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  const toDelete = [];
  const toKeep = [];
  for (const g of dupGroups) {
    const keeper = pickKeeper(g);
    toKeep.push(keeper);
    for (const r of g) {
      if (r.id !== keeper.id) toDelete.push(r);
    }
  }
  return { dupGroups, toDelete, toKeep };
}

async function deleteByIds(ids) {
  const url = `${SB_URL}/rest/v1/email_import_queue?id=in.(${ids.join(',')})`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
  });
  if (!res.ok) throw new Error(`削除に失敗しました: ${res.status} ${await res.text()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY環境変数が設定されていません。');
    process.exitCode = 1;
    return;
  }

  console.log('email_import_queueの全行を取得中...');
  const rows = await fetchAllRows();
  console.log(`取得件数: ${rows.length}`);

  const { dupGroups, toDelete, toKeep } = buildPlan(rows);
  console.log(`重複グループ数(subject+sender+received_at完全一致): ${dupGroups.length}`);
  console.log(`削除対象件数: ${toDelete.length}`);
  console.log(`残す件数(各グループ1件): ${toKeep.length}`);

  const importedKept = toKeep.filter((r) => r.imported).length;
  const importedDeleted = toDelete.filter((r) => r.imported).length;
  console.log(`  うちimported=trueを残した件数: ${importedKept}`);
  console.log(`  うちimported=trueだったが削除された件数(通常0のはず): ${importedDeleted}`);

  console.log('\n削除対象サンプル(先頭5件):');
  for (const r of toDelete.slice(0, 5)) {
    console.log(`  id=${r.id} subject="${(r.subject || '').slice(0, 40)}" sender=${r.sender} received_at=${r.received_at} created_at=${r.created_at} imported=${!!r.imported}`);
  }

  if (toDelete.length === 0) {
    console.log('\n削除対象がありません。終了します。');
    return;
  }

  // バックアップ(残す分・消す分の両方、グループ全体)を削除実行前に必ず保存する
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dataDir, `email_import_queue_dedupe_backup_${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ dupGroups, toDelete, toKeep }, null, 2), 'utf8');
  console.log(`\nバックアップを書き込みました: ${backupPath}`);

  if (!args.apply) {
    console.log('\n[ドライラン] 実際の削除は行っていません。内容を確認の上、--apply を付けて再実行してください。');
    return;
  }

  console.log('\n本番実行: 削除を開始します...');
  const ids = toDelete.map((r) => r.id);
  const chunkSize = 200;
  let deletedCount = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await deleteByIds(chunk);
    deletedCount += chunk.length;
    console.log(`  ${deletedCount}/${ids.length} 件削除完了`);
  }
  console.log(`\n完了。削除件数: ${deletedCount}`);
}

main().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exitCode = 1;
});
