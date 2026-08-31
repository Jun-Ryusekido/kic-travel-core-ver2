// KIC_Access移行データ(予約台帳テーブル)の2スナップショット(A=2025/02/20版・B=2026/07/17版)を
// 読み取り、予約台帳IDで突合して scripts/data/access_booking_reconcile.json を生成する。
// このスクリプトはExcel読み取りとローカルJSON書き出しのみで、Supabaseには一切接続しない。
//
// 実行方法: node scripts/generate_access_booking_reconcile.js [--a <path>] [--b <path>] [--out <path>]
//   既定ではNAS上の原本を直接読む。
//
// 出力形式: [{ id: '#1153', status: 'both'|'new_only'|'old_only', A: {...}, B: {...}, diffs: [...] }]
//   - id: '#' + 予約台帳ID (bookings.ref_no形式に合わせる。#1153で対応確認済み)
//   - status: both=A/B両方に存在, new_only=Bのみ(新規), old_only=Aのみ
//   - A/B: 反映対象列のみを持つオブジェクト。日付はMM/DD/YY→YYYY-MM-DDに正規化(YY→20YY。
//     Accessのプレースホルダ「12/28/99」は2099-12-28となり、既存bookingsの慣行と一致)。
//     null・空文字の項目はキーごと省略する(=「Access側に情報なし」として扱い、
//     dry_run/applyのcomputeFinalValueがundefinedをスキップするため、既存bookingsの値を
//     空で上書きすることが構造的に起きない)。
//   - diffs: AとBで正規化後の値が異なる列名(bookings列名)の一覧(参考情報)

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_A = '\\\\Ls220d8cb\\kic_date\\その他\\新しいフォルダー\\KIC_Access移行データ_トランザクション3点.xlsx';
const DEFAULT_B = '\\\\Ls220d8cb\\kic_date\\その他\\新しいフォルダー\\KIC_Access移行データ_トランザクション3点_20260717版.xlsx';
const DEFAULT_OUT = 'scripts/data/access_booking_reconcile.json';
const SHEET = '予約台帳テーブル';

// Access列名のうち、reconcile JSONに含める列(dry_run_access_booking_merge.jsの
// ACCESS_FIELD_MAP/STATUS_ACCESS_KEYと対応)。日付列は正規化対象。
// 【2026-08-31追記】'請求金額'・'確定粗利'は予約台帳テーブル上の情報列として追加した
// (新規追加候補の内容確認用。ACCESS_FIELD_MAPには含めないため、dry_run/applyの
// 本番bookingsへの反映判定ロジックには一切影響しない、あくまで参考情報)。
const KEEP_COLUMNS = ['担当者', '出発日', '帰国予定日', 'ADT', 'CHD', 'INF', '会社名', '行程', '国名', '種別', '手配完了', '請求金額', '確定粗利'];
const DATE_COLUMNS = new Set(['出発日', '帰国予定日']);
// 予約台帳テーブルとは別シート(仕入明細テーブル/請求明細テーブル)の金額を、
// 予約台帳IDで集計してA/B各レコードに付与する(こちらも参考情報のみ。ACCESS_FIELD_MAPには
// 含めないため反映判定には影響しない)。
const AGGREGATE_SHEETS = [
  { sheet: '仕入明細テーブル', amountCol: '仕入額', outKey: '仕入合計' },
  { sheet: '請求明細テーブル', amountCol: '金額', outKey: '売上合計' },
];

function parseArgs(argv) {
  const args = { a: DEFAULT_A, b: DEFAULT_B, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--a') args.a = argv[++i];
    if (argv[i] === '--b') args.b = argv[++i];
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

// 'MM/DD/YY HH:mm:ss' → 'YYYY-MM-DD'(YY→20YY)。形式外の値はそのまま返す(削らない)。
function normalizeDate(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{2})(\s|$)/);
  if (!m) return v;
  return `20${m[3]}-${m[1]}-${m[2]}`;
}

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// Access/Excelエクスポート由来のノーブレークスペース(U+00A0)等の不可視空白を通常の
// 半角スペースに正規化する。実データで「Kulin Kumar Holidays Pvt Ltd」のように
// NBSPが混入しており、放置するとDB側のきれいな値をNBSP混じりの値で「上書き」してしまう
// (見た目は同一なのに差分扱いになる)ことを確認したため。全角スペース(U+3000)は日本語の
// 名称で意味を持つ場合があるため変換しない。
function normalizeInvisibleSpaces(s) {
  return s.replace(/[\u00A0\u2007\u202F\uFEFF]/g, ' ');
}

function extractRecord(row) {
  const out = {};
  for (const col of KEEP_COLUMNS) {
    let v = row[col];
    if (isEmpty(v)) continue; // 空はキーごと省略(既存値を空で上書きしない)
    if (DATE_COLUMNS.has(col)) v = normalizeDate(v);
    out[col] = typeof v === 'string' ? normalizeInvisibleSpaces(v).trim() : v;
  }
  return out;
}

// 仕入明細テーブル/請求明細テーブルの金額列を予約台帳IDで合計する。値が無い/数値化できない
// 行は0として扱う(合計自体が無意味になるのを避けるため、行単位でスキップはしない)。
function readAggregates(wb, sheetName, amountCol) {
  const sums = new Map();
  if (!wb.SheetNames.includes(sheetName)) return sums;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  for (const row of rows) {
    const id = String(row['予約台帳ID'] ?? '').trim();
    if (!/^\d+$/.test(id)) continue;
    const amount = Number(row[amountCol]);
    sums.set(id, (sums.get(id) || 0) + (Number.isFinite(amount) ? amount : 0));
  }
  return sums;
}

function readSheet(filePath) {
  const wb = XLSX.readFile(filePath);
  if (!wb.SheetNames.includes(SHEET)) throw new Error(`${filePath} にシート「${SHEET}」がありません`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { defval: null });
  const aggregates = AGGREGATE_SHEETS.map((a) => ({ ...a, sums: readAggregates(wb, a.sheet, a.amountCol) }));
  const byId = new Map();
  for (const row of rows) {
    const id = String(row['予約台帳ID'] ?? '').trim();
    if (!/^\d+$/.test(id)) continue;
    const rec = extractRecord(row);
    for (const a of aggregates) {
      const sum = a.sums.get(id);
      if (sum !== undefined) rec[a.outKey] = sum;
    }
    byId.set(id, rec);
  }
  return byId;
}

function normVal(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`A: ${args.a}`);
  console.log(`B: ${args.b}`);
  const mapA = readSheet(args.a);
  const mapB = readSheet(args.b);
  console.log(`A側レコード数: ${mapA.size} / B側レコード数: ${mapB.size}`);

  const allIds = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((x, y) => Number(x) - Number(y));
  const records = allIds.map((id) => {
    const a = mapA.get(id);
    const b = mapB.get(id);
    const status = a && b ? 'both' : b ? 'new_only' : 'old_only';
    const diffs = [];
    if (a && b) {
      for (const col of KEEP_COLUMNS) {
        if (normVal(a[col]) !== normVal(b[col])) diffs.push(col);
      }
    }
    const rec = { id: `#${id}`, status };
    if (a) rec.A = a;
    if (b) rec.B = b;
    rec.diffs = diffs;
    return rec;
  });

  const byStatus = { both: 0, new_only: 0, old_only: 0 };
  records.forEach((r) => byStatus[r.status]++);

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(records, null, 1), 'utf8');
  console.log(`生成完了: ${outPath}`);
  console.log(`総レコード数: ${records.length} (both: ${byStatus.both} / new_only: ${byStatus.new_only} / old_only: ${byStatus.old_only})`);
  console.log(`A/Bで値が異なるレコード数: ${records.filter((r) => r.diffs.length > 0).length}`);
}

main();
