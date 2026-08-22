// email_import_queue.html_body(赤字・強調表記検知バッジ用にOutlookから取り込んだ
// メール本文のHTML版、1行最大50,000文字)は、容量調査(2026-08-22)でテーブル全体の
// 大半を占めていることが判明した。この列は「メールを受信箱で処理する時」
// (sendEmailToBooking()がis_flagged判定のためAIに渡す)にしか使われず、
// imported=trueに更新された後(=既に受信箱での処理が完了した後)は一切読まれない
// (index.html全体を確認済み。html_bodyを読む箇所はsendEmailToBooking()の1箇所のみで、
// これはimported=trueを立てる前にしか呼ばれない)。
//
// このスクリプトは、imported=true かつ received_at が指定日数(既定30日)より古い行の
// html_body列だけをNULLに更新する。body(プレーンテキスト本文)・attachments・
// REF#候補等、他の列には一切触れない。
//
// 安全策(scripts/dedupe_email_import_queue.jsと同じ方針):
//   1. 既定はレポートのみ(--apply を付けない限り実際の更新は一切行わない)。
//      対象件数・削減見込みサイズを必ず先に表示する。
//   2. --apply 時も、クリアされるhtml_bodyの内容を実行前に必ずローカルJSON
//      (scripts/data/email_import_queue_html_body_backup_<実行日時>.json)へ保存する
//      (html_bodyはVBA側で再送されないため、クリア後は元データを復元できない。
//      誤操作時の最終手段として残す)。
//   3. --apply 時も、--yes を付けない限り対象件数を表示した上で確認プロンプトで停止する。
//   4. 更新はid一覧を明示的に指定したPATCHのみで行い(WHERE句に日付条件だけで全件を
//      対象にする一括UPDATEは行わない)、実行後に「対象件数と実際に更新した件数が
//      一致するか」を検証する。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/clear_old_email_import_html_body.js                  (レポートのみ)
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/clear_old_email_import_html_body.js --apply           (確認プロンプトあり)
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/clear_old_email_import_html_body.js --apply --yes     (確認なしで実行、タスクスケジューラ用)
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/clear_old_email_import_html_body.js --days 60         (日数を変更、--applyと併用可)

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PAGE_SIZE = 1000;
const CHUNK_SIZE = 200;

function parseArgs(argv) {
  const args = { apply: false, yes: false, days: 30 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--yes') args.yes = true;
    else if (argv[i] === '--days') args.days = Number(argv[++i]) || 30;
  }
  return args;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

// imported=true かつ received_at < cutoff かつ html_body が既にNULLでない行のみを対象にする
// (未取り込みの行・30日以内の行・既にNULL済みの行はそもそも対象に含めない=安全側)。
function buildFilterQS(cutoffIso) {
  return `imported=eq.true&received_at=lt.${encodeURIComponent(cutoffIso)}&html_body=not.is.null`;
}

async function fetchTargetRows(cutoffIso) {
  const rows = [];
  let from = 0;
  for (;;) {
    const url = `${SB_URL}/rest/v1/email_import_queue?${buildFilterQS(cutoffIso)}&select=id,subject,sender,received_at,html_body&order=received_at.asc`;
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

// 対象と同じidのみをPATCH(WHERE句をid=in.(...)に限定し、実行タイミングのずれで
// 新たに条件に該当した行を誤って巻き込まないようにする)。
async function clearHtmlBodyByIds(ids) {
  const url = `${SB_URL}/rest/v1/email_import_queue?id=in.(${ids.join(',')})`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ html_body: null }),
  });
  if (!res.ok) throw new Error(`更新に失敗しました: ${res.status} ${await res.text()}`);
  const updated = await res.json();
  return updated.length;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY環境変数が設定されていません。');
    process.exitCode = 1;
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - args.days);
  const cutoffIso = cutoff.toISOString();

  console.log(`対象条件: imported=true かつ received_at < ${cutoffIso}(${args.days}日以前) かつ html_bodyが未クリア`);
  console.log('対象行を取得中...');
  const rows = await fetchTargetRows(cutoffIso);

  const totalBytes = rows.reduce((s, r) => s + Buffer.byteLength(r.html_body || '', 'utf8'), 0);
  console.log(`\n===== 事前レポート =====`);
  console.log(`対象件数: ${rows.length}`);
  console.log(`html_body合計サイズ(概算、UTF-8バイト数。実際のディスク削減量はPostgreSQLのTOAST圧縮により異なる場合があります): ${formatBytes(totalBytes)}`);
  if (rows.length) {
    console.log('\n対象サンプル(先頭5件):');
    for (const r of rows.slice(0, 5)) {
      console.log(`  id=${r.id} subject="${(r.subject || '').slice(0, 40)}" received_at=${r.received_at} html_body_bytes=${Buffer.byteLength(r.html_body || '', 'utf8')}`);
    }
  }

  if (rows.length === 0) {
    console.log('\n対象がありません。終了します。');
    return;
  }

  if (!args.apply) {
    console.log('\n[レポートのみ] 実際の更新は行っていません。内容を確認の上、--apply を付けて再実行してください。');
    return;
  }

  if (!args.yes) {
    const ans = await ask(`\n${rows.length}件のhtml_bodyをNULLに更新します。よろしいですか？ (y/N): `);
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('中止しました。');
      return;
    }
  }

  // バックアップ(クリアされる内容そのもの)を更新実行前に必ず保存する
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dataDir, `email_import_queue_html_body_backup_${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\nバックアップを書き込みました: ${backupPath}`);

  console.log('\n本番実行: 更新を開始します...');
  const ids = rows.map((r) => r.id);
  let clearedCount = 0;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const n = await clearHtmlBodyByIds(chunk);
    clearedCount += n;
    console.log(`  ${clearedCount}/${ids.length} 件更新完了`);
  }

  console.log(`\n完了。対象件数: ${rows.length} / 実際に更新した件数: ${clearedCount}`);
  if (clearedCount !== rows.length) {
    console.warn('警告: 対象件数と更新件数が一致しません。他プロセスによる同時更新の可能性があります。バックアップファイルを確認してください。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exitCode = 1;
});
