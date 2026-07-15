// booking_hotels テーブルの重複レコード候補を検出してレポートするスクリプト（読み取り専用）。
//
// 重複判定キー: ホテル名 + REF#（bookings.ref_no、booking_idで結合） + チェックイン日 +
// チェックアウト日 + 部屋タイプ(room_type) + 金額(amount) の完全一致。
// 文字列は前後空白を除去し、null/undefined/空文字は同一視して比較する。
//
// 「残す」候補の判定基準:
//   1. ステータス優先順位: 手配OK > 回答待ち系(回答待ち/問い合わせ中) > NG回答 > その他/未設定
//      （画面表示では「問い合わせ中」も「回答待ち」として表示されるため同順位に統一している。
//       実データに現れたステータス値は 手配OK / 回答待ち / 問い合わせ中 / NG回答 の4種類）
//   2. 同順位内では created_at が新しい方を残す候補とする
//
// このスクリプトはDBへの削除・更新を一切行わない（読み取りのみ）。
//
// 実行方法: node scripts/find-duplicate-booking-hotels.js
//   任意で --csv <path> を指定すると、重複グループの詳細をCSVファイルにも出力する。

const fs = require('fs');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

async function sbGetAll(table, select) {
  const pageSize = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&order=id&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!r.ok) throw new Error(`Supabase ${table}: ${r.status} ${r.statusText}`);
    const rows = await r.json();
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// null/undefined/空文字/前後空白の違いを吸収して比較用に正規化する。
function normStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// amountは数値・数値文字列どちらで返ってきても同一視できるようNumber化する（NaNは空扱い）。
function normAmount(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isNaN(n) ? normStr(v) : String(n);
}

function statusRank(status) {
  const s = normStr(status);
  if (s === '手配OK') return 0;
  if (s === '回答待ち' || s === '問い合わせ中') return 1;
  if (s === 'NG回答') return 2;
  return 3; // 未知/未設定ステータスは最下位（残す候補にしない）
}

function buildKey(row, refNoByBookingId) {
  const refNo = normStr(refNoByBookingId.get(row.booking_id));
  return [
    normStr(row.hotel_name),
    refNo,
    normStr(row.check_in),
    normStr(row.check_out),
    normStr(row.room_type),
    normAmount(row.amount),
  ].join('');
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function main() {
  const csvArgIdx = process.argv.indexOf('--csv');
  const csvPath = csvArgIdx !== -1 ? process.argv[csvArgIdx + 1] : null;

  console.log(`Supabase: ${SB_URL}`);
  console.log('booking_hotels / bookings を取得中...\n');

  const [hotelRows, bookingRows] = await Promise.all([
    sbGetAll('booking_hotels', '*'),
    sbGetAll('bookings', 'id,ref_no'),
  ]);

  const refNoByBookingId = new Map(bookingRows.map((b) => [b.id, b.ref_no]));

  console.log('=== booking_hotels スキーマ（取得した列一覧） ===');
  if (hotelRows.length > 0) {
    console.log(Object.keys(hotelRows[0]).join(', '));
  } else {
    console.log('(レコードが0件のため列一覧を取得できませんでした)');
  }
  console.log(`\nbooking_hotels 総レコード数: ${hotelRows.length}`);
  console.log(`bookings 総レコード数: ${bookingRows.length}\n`);

  // ステータス実値の分布も併せて報告する（ユーザー想定の3種と実データが異なるため）。
  const statusCounts = {};
  hotelRows.forEach((r) => {
    const s = normStr(r.status) || '(空/未設定)';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  console.log('=== status列の実際の値と件数 ===');
  Object.entries(statusCounts).forEach(([s, c]) => console.log(`  ${s}: ${c}件`));
  console.log('');

  const groups = new Map();
  hotelRows.forEach((row) => {
    const key = buildKey(row, refNoByBookingId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  const totalDupRecords = dupGroups.reduce((s, g) => s + g.length, 0);

  console.log('='.repeat(70));
  console.log(`重複候補グループ数: ${dupGroups.length}`);
  console.log(`重複候補の対象レコード総数: ${totalDupRecords}`);
  console.log('='.repeat(70) + '\n');

  const csvRows = [
    ['group_no', 'hotel_name', 'ref_no', 'check_in', 'check_out', 'room_type', 'amount',
      'id', 'status', 'created_at', 'status_updated_at', 'keep_candidate'],
  ];

  dupGroups.forEach((group, gi) => {
    // 残す候補: ステータス優先順位 昇順 → created_at 降順（新しい方を優先）
    const sorted = [...group].sort((a, b) => {
      const rankDiff = statusRank(a.status) - statusRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    const keepId = sorted[0].id;

    const first = group[0];
    const refNo = refNoByBookingId.get(first.booking_id) || '';
    console.log(`--- グループ ${gi + 1} (${group.length}件) ---`);
    console.log(`  ホテル名: ${first.hotel_name || ''}`);
    console.log(`  REF#: ${refNo}`);
    console.log(`  チェックイン: ${first.check_in || ''} / チェックアウト: ${first.check_out || ''}`);
    console.log(`  部屋タイプ: ${first.room_type || ''}`);
    console.log(`  金額: ${first.amount}`);
    group
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .forEach((r) => {
        const mark = r.id === keepId ? '[残す候補]' : '[削除候補]';
        console.log(`    ${mark} id=${r.id} status=${r.status || '(未設定)'} created_at=${r.created_at} status_updated_at=${r.status_updated_at || ''}`);
      });
    console.log('');

    group.forEach((r) => {
      csvRows.push([
        gi + 1, first.hotel_name, refNo, first.check_in, first.check_out, first.room_type, first.amount,
        r.id, r.status, r.created_at, r.status_updated_at, r.id === keepId ? 'KEEP' : 'DELETE_CANDIDATE',
      ]);
    });
  });

  if (dupGroups.length === 0) {
    console.log('重複候補は検出されませんでした。');
  }

  if (csvPath) {
    const csvText = csvRows.map((row) => row.map(csvEscape).join(',')).join('\n');
    fs.writeFileSync(csvPath, '﻿' + csvText, 'utf8'); // BOM付きでExcelでも文字化けしないようにする
    console.log(`\nCSVレポートを出力しました: ${csvPath}`);
  }

  console.log('\n※このスクリプトはDBへの削除・更新を一切行っていません（レポート出力のみ）。');
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
