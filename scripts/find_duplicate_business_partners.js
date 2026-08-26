// 取引先マスタ(business_partners)の重複会社を洗い出す読み取り専用の調査スクリプト。
//
// 背景: business_partner_contacts(担当者複数対応)が無かった頃、担当者が変わるたびに
// 会社ごと新規登録されていたと見られ、同じ会社が何度も重複登録されている
// (2026/08/26調査、W大阪の4件重複を個別に手動統合済み。他にも正規化した会社名で
// 2件以上重複するグループが少なくとも31グループ・計70件以上を確認済み)。
//
// 正規化ロジックは、index.htmlのnormalizePartnerCompanyName()(取引先の突合・重複調査の
// 両方で使う唯一の正規化関数、とindex.html自身のコメントに明記されている)をそのまま
// 移植したもの。アプリ本体の重複判定と食い違わないよう、この関数だけを正規化の基準とする。
//
// このスクリプトは読み取りのみ。business_partners/business_partner_contacts/
// booking_hotels等への書き込みは一切行わない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/find_duplicate_business_partners.js
//   出力: scripts/data/duplicate_business_partners_report.csv
//         (グループ番号ごとに、どのidを残すか"keep"列に手動でYを入れて
//         merge_duplicate_business_partners.jsの入力として使う)

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OUT_CSV = path.resolve(__dirname, 'data/duplicate_business_partners_report.csv');

async function sbSelectAll(table, select, extraQuery) {
  let all = [], from = 0;
  const PAGE = 1000;
  while (true) {
    const url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${extraQuery ? '&' + extraQuery : ''}&offset=${from}&limit=${PAGE}`;
    const res = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// index.htmlのnormalizePartnerCompanyName()と同一のロジック(移植)。
function normalizePartnerCompanyName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・.,()（）]/g, '')
    .replace(/株式会社|有限会社|合同会社|一般社団法人|公益社団法人|一般財団法人|公益財団法人/g, '');
}

function toCsvRow(fields) {
  return fields.map(f => {
    const s = String(f == null ? '' : f);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

async function main() {
  if (!SB_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }

  console.log('business_partners(is_deleted!=true)を読み込み中...');
  const partners = await sbSelectAll(
    'business_partners',
    'id,company_name,company_name_en,category,created_at',
    'or=(is_deleted.is.null,is_deleted.eq.false)'
  );
  console.log(`対象: ${partners.length}件`);

  console.log('business_partner_contacts(is_deleted=false)を読み込み中...');
  const contacts = await sbSelectAll('business_partner_contacts', 'business_partner_id', 'is_deleted=eq.false');
  const contactCountByPartnerId = new Map();
  contacts.forEach(c => {
    contactCountByPartnerId.set(c.business_partner_id, (contactCountByPartnerId.get(c.business_partner_id) || 0) + 1);
  });

  // 予約データ側(手配タブ)から、会社名の正規化キーで参照されているかどうかを判定するための
  // 参照名セットを作る。手配データ側はbusiness_partnersとFK連携しておらず、店名/会社名の
  // テキストのみを保持しているため(既存の他機能と同じ突合方式)、正規化キーの集合の
  // 有無だけで「参照されている可能性がある」ことを判定する簡易チェックとする。
  console.log('booking_hotels/booking_buses/booking_facilities/booking_restaurantsを読み込み中...');
  const [hotels, buses, facilities, restaurants] = await Promise.all([
    sbSelectAll('booking_hotels', 'hotel_name'),
    sbSelectAll('booking_buses', 'bus_company'),
    sbSelectAll('booking_facilities', 'facility_name'),
    sbSelectAll('booking_restaurants', 'restaurant_name'),
  ]);
  const referencedNameKeys = new Set();
  [
    ...hotels.map(h => h.hotel_name),
    ...buses.map(b => b.bus_company),
    ...facilities.map(f => f.facility_name),
    ...restaurants.map(r => r.restaurant_name),
  ].forEach(name => {
    const key = normalizePartnerCompanyName(name);
    if (key) referencedNameKeys.add(key);
  });

  // 正規化キーでグルーピングし、2件以上のグループのみ抽出する。
  const groups = new Map(); // key -> partner[]
  partners.forEach(p => {
    const key = normalizePartnerCompanyName(p.company_name);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const dupGroups = [...groups.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`\n重複グループ数: ${dupGroups.length}グループ`);
  console.log(`重複対象の行数(合計): ${dupGroups.reduce((s, [, rows]) => s + rows.length, 0)}件`);

  const csvRows = [['グループ番号', '正規化名', 'id', '会社名(元表記)', 'カテゴリ', '登録日時', '担当者数', '予約データからの参照有無', 'keep']];
  dupGroups.forEach(([key, rows], idx) => {
    const groupNo = idx + 1;
    // 登録日時が古い順(=最初に登録された行を上に)に並べる。どれをkeepにするかは
    // 人が判断するための参考情報であり、自動選択はしない。
    const sorted = [...rows].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    sorted.forEach(p => {
      const contactCount = contactCountByPartnerId.get(p.id) || 0;
      const hasBookingRef = referencedNameKeys.has(normalizePartnerCompanyName(p.company_name)) ? '有' : '無';
      csvRows.push([groupNo, key, p.id, p.company_name || '', p.category || '', p.created_at || '', contactCount, hasBookingRef, '']);
    });
  });

  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, csvRows.map(toCsvRow).join('\n'), 'utf8');
  console.log(`\nCSVを保存しました: ${OUT_CSV}`);

  console.log('\n--- 重複グループ上位20件(件数の多い順) ---');
  console.table(dupGroups.slice(0, 20).map(([key, rows]) => ({
    正規化名: key,
    件数: rows.length,
    表記例: rows.map(p => p.company_name).slice(0, 3).join(' / '),
  })));

  console.log('\n※このスクリプトは読み取りのみ。実際の変更は一切行っていません。');
  console.log(`※CSVの"keep"列に、各グループで残すidの行にYを入れてから、`);
  console.log('  merge_duplicate_business_partners.js --dry-run で内容を確認してください。');
}

module.exports = { normalizePartnerCompanyName, toCsvRow, main };

if (require.main === module) {
  main().catch(e => { console.error('エラーが発生しました:', e.message); process.exit(1); });
}
