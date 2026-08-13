// はやぶさ国際観光バスの30件横断メール(2026-08-13)を、メール受信箱の「送る」確認画面
// (showEmailSplitModal/guessEmailSplitCategory)経由で処理した際、抜粋にカテゴリの
// キーワードが無かったために全件が誤って「ホテル」と判定され、各予約のbooking_hotels
// テーブルに hotel_name 等が空欄で memo にメール抜粋だけが入ったドラフト行として
// 保存されてしまった不具合(index.htmlのguessEmailSplitCategoryは修正済み)のデータ修復。
// 本来はバス手配のメールだったため、正しくは各予約のbooking_busesに入るべきだった。
//
// このスクリプトは読み取りのみ(SELECT)を行う。書き込みは一切行わない
// (UPDATE/INSERT/DELETEに相当するAPI呼び出しはコード中に存在しない)。
//
// 処理内容:
//   1. booking_hotels全体から、hotel_name=''かつmemoに「団体名：KIC」を含む行(=今回の
//      誤った書き込みだと考えられる行)をSELECTする。
//   2. 各行のmemoから正規表現で「団体名：KICxxxx...」の部分を抽出する。
//   3. 2026-08-12の調査で確定した対応表(KIC_TO_REF_MAP)と照合し、本来あるべきREF#を
//      機械的に導き出す(現在の行がどのbooking_idに保存されていたかは一切参照しない。
//      memoの内容自体から正しい行き先を判定することで、#1308の誤りのような
//      「保存先自体が間違っていた」ケースも検知できる)。
//   4. 導き出したREF#で実際のbookingsを検索し、booking_idを特定する。
//   5. 結果を3つに分類してJSON出力する:
//      - moves: 対応表にあり、実際にbookingsも見つかった → apply script で移動対象
//      - unmatched: 対応表で「該当bookingなし」となっているもの(KIC1303/1305/1307/1314)、
//        または対応表にはあるがbookingsに実在しなかったもの → 未処理リストとして報告
//      - unrecognized: memoから「団体名：KICxxxx」を抽出できなかった行(想定外パターン。
//        手動確認が必要)
//
// 出力:
//   scripts/data/hayabusa_bus_repair_backup_<timestamp>.json
//     … 対象行の削除前バックアップ(id, booking_id, memo等の全カラム)
//   scripts/data/hayabusa_bus_repair_plan_<timestamp>.json
//     … apply_hayabusa_bus_data_repair.js への入力(moves/unmatched/unrecognized)
//
// 実行方法: node scripts/dry_run_hayabusa_bus_data_repair.js

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

// 2026-08-12の調査で確定済みの対応表。null = 該当bookingなし(現状手配不可の回のため
// bookingsに存在しない可能性が高い)。KIC1178_LJ(A)/(B)は実際のtour_codeがKIC1178_LFだが、
// メール本文中の表記(团体名の値)はLJのため、抽出キーはメール本文の表記に合わせる。
const KIC_TO_REF_MAP = {
  'KIC1172_JF(A)': '#1172',
  'KIC1172_JF(B)': '#1172',
  'KIC1173_JF': '#1173',
  'KIC1302_JF': '#1302',
  'KIC1303_JF': null,
  'KIC1304_JF': '#1304',
  'KIC1178_LJ(A)': '#1178',
  'KIC1178_LJ(B)': '#1178',
  'KIC1305_JF': null,
  'KIC1306_JF(A)': '#1306',
  'KIC1306_JF(B)': '#1306',
  'KIC1174_JF': '#1174',
  'KIC1307_JF': null,
  'KIC1308_JF': '#1308',
  'KIC1175_JF': '#1175',
  'KIC1310_JF': '#1310',
  'KIC1311_JF': '#1311',
  'KIC1313_JF': '#1313',
  'KIC1314_JF': null,
  'KIC1176_JF': '#1176',
  'KIC1315_JF': '#1315',
  'KIC1316_JF': '#1316',
  'KIC1317_JF': '#1317',
  'KIC1318_JF': '#1318',
  'KIC1319_JF': '#1319',
  'KIC1320_JF(A)': '#1320',
  'KIC1320_JF(B)': '#1320',
  'KIC1321_JF': '#1321',
  'KIC1322_JF': '#1322',
  'KIC1177_JF': '#1177',
};

// memoから「団体名：KICxxxx...」の部分(全角/半角コロン両対応)を抽出する。
// KICに続く英数字・アンダースコア・丸括弧(A)/(B)までを1トークンとして拾う。
const GROUP_NAME_RE = /団体名[:：]\s*(KIC[A-Za-z0-9_()]+)/;
function extractKicCode(memo) {
  const m = String(memo || '').match(GROUP_NAME_RE);
  return m ? m[1] : null;
}

async function sbGet(pathAndQuery) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchAffectedBookingHotelsRows() {
  // hotel_name=''かつmemoに「団体名：KIC」を含む行を対象にする。件数が多い可能性を
  // 考慮しrangeページングする。
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const rows = await sbGet(
      `booking_hotels?select=*&hotel_name=eq.&memo=ilike.*団体名：KIC*&order=id.asc&limit=${pageSize}&offset=${from}`
    );
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchAllBookingsRefMap() {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const rows = await sbGet(`bookings?select=id,ref_no&order=id.asc&limit=${pageSize}&offset=${from}`);
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  const map = {};
  all.forEach((b) => { map[b.ref_no] = b.id; });
  return map;
}

async function main() {
  console.log('booking_hotelsから対象行を検索中(読み取りのみ)...');
  const rows = await fetchAffectedBookingHotelsRows();
  console.log(`対象候補: ${rows.length}件(hotel_name=''かつmemoに「団体名：KIC」を含む)`);

  if (!rows.length) {
    console.log('対象行がありませんでした。修復対象なしとして終了します。');
    return;
  }

  console.log('bookings一覧を取得中(REF#解決用)...');
  const refToBookingId = await fetchAllBookingsRefMap();

  const moves = [];
  const unmatched = [];
  const unrecognized = [];

  for (const row of rows) {
    const kicCode = extractKicCode(row.memo);
    if (!kicCode) {
      unrecognized.push({ id: row.id, booking_id: row.booking_id, memo: row.memo });
      continue;
    }
    const hasKey = Object.prototype.hasOwnProperty.call(KIC_TO_REF_MAP, kicCode);
    const targetRef = hasKey ? KIC_TO_REF_MAP[kicCode] : undefined;
    if (!hasKey) {
      // 対応表に無いパターン(想定外の団体名)。手動確認が必要。
      unrecognized.push({ id: row.id, booking_id: row.booking_id, memo: row.memo, extracted_kic_code: kicCode, reason: '対応表に無いコード' });
      continue;
    }
    if (targetRef === null) {
      unmatched.push({ id: row.id, booking_id: row.booking_id, memo: row.memo, extracted_kic_code: kicCode, reason: '対応表上「該当bookingなし」' });
      continue;
    }
    const targetBookingId = refToBookingId[targetRef];
    if (!targetBookingId) {
      unmatched.push({ id: row.id, booking_id: row.booking_id, memo: row.memo, extracted_kic_code: kicCode, target_ref_no: targetRef, reason: `対応表はあるがbookingsに${targetRef}が実在しない` });
      continue;
    }
    moves.push({
      booking_hotels_id: row.id,
      current_booking_id: row.booking_id,
      extracted_kic_code: kicCode,
      target_ref_no: targetRef,
      target_booking_id: targetBookingId,
      moved_correctly_would_have_been: row.booking_id === targetBookingId ? 'same(参考: 現在の保存先が既に正しいケース)' : 'different(誤った保存先からの移動が必要)',
      memo: row.memo,
    });
  }

  console.log(`\n=== 分類結果 ===`);
  console.log(`moves(booking_busesへ移動): ${moves.length}件`);
  console.log(`unmatched(該当bookingなし/未処理リスト): ${unmatched.length}件`);
  console.log(`unrecognized(memoから団体名を抽出できない/対応表に無い): ${unrecognized.length}件`);

  if (unmatched.length) {
    console.log('\n--- unmatched一覧 ---');
    unmatched.forEach((u) => console.log(`  id=${u.id} booking_id=${u.booking_id} code=${u.extracted_kic_code || '(抽出不可)'} reason=${u.reason}`));
  }
  if (unrecognized.length) {
    console.log('\n--- unrecognized一覧(要手動確認) ---');
    unrecognized.forEach((u) => console.log(`  id=${u.id} booking_id=${u.booking_id} code=${u.extracted_kic_code || '(抽出不可)'} memo=${JSON.stringify((u.memo || '').slice(0, 80))}`));
  }

  const misplacedCount = moves.filter((m) => m.current_booking_id !== m.target_booking_id).length;
  console.log(`\n参考: movesのうち、現在の保存先(booking_id)が本来と異なっていた(=#1308のような誤結合)件数: ${misplacedCount}件`);

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const outDir = path.resolve('scripts/data');
  fs.mkdirSync(outDir, { recursive: true });

  const backupPath = path.join(outDir, `hayabusa_bus_repair_backup_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
  console.log(`\nバックアップ(対象行の全カラム、${rows.length}件)を保存しました: ${backupPath}`);

  const planPath = path.join(outDir, `hayabusa_bus_repair_plan_${timestamp}.json`);
  fs.writeFileSync(planPath, JSON.stringify({ moves, unmatched, unrecognized }, null, 2));
  console.log(`実行計画(moves/unmatched/unrecognized)を保存しました: ${planPath}`);
  console.log('\nこのバックアップ・実行計画の内容をJUNさんに提示し、確認を得てから');
  console.log(`  node scripts/apply_hayabusa_bus_data_repair.js --plan ${planPath}`);
  console.log('を実行してください(実行にはSUPABASE_SERVICE_ROLE_KEYが必要です)。');
}

module.exports = { KIC_TO_REF_MAP, extractKicCode, SB_URL };

if (require.main === module) {
  main().catch((e) => {
    console.error('エラー:', e.message);
    process.exit(1);
  });
}
