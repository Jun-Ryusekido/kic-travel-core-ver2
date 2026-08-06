// F13フェーズ2: agent_idバックフィル - 本番実行スクリプト(案。まだ実行しない)。
//
// scripts/backfill_agent_id_dryrun.jsと全く同じ正規化・マッチングロジックで対象行を
// 特定し、実際にbookings/booking_sales/invoices.agent_idをUPDATEする。
//
// 前提:
//   1. scripts/add_agent_id_to_bookings_sales_invoices.sqlを実行済みであること
//      (agent_id列が無い状態で実行するとPATCHが列不明エラーで失敗する)
//   2. scripts/backfill_agent_id_dryrun.jsの結果を確認済みであること
//
// 安全対策:
//   - デフォルトはドライラン相当(--yesを付けない限り実際のUPDATEは行わない。
//     このスクリプト単体でも二重に安全弁を持たせている)
//   - 実行前に対象行(id, agent_name, 現在のagent_id)を全件JSONバックアップとして
//     ダウンロード(scripts/data/配下)してからUPDATEする
//   - 既にagent_idが設定済みの行は対象外(上書きしない。再実行しても安全=べき等)
//   - agent_name='0'(ダミー値)、正規化後未マッチ、agentsマスタ側で正規化後に
//     複数一致(曖昧)の行はスキップする(ドライランと同じ判定基準)
//   - PATCHは1件ずつではなくagent_id単位でin.()バッチ化して呼び出し回数を抑える
//   - 実行後、対象件数と実際に更新できた件数を突き合わせて差異があれば警告する
//
// 実行方法:
//   1. まずドライラン確認:
//      SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/backfill_agent_id_dryrun.js
//   2. 内容に問題なければ本実行:
//      SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/backfill_agent_id.js --yes

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if(!SB_KEY){ console.error('SUPABASE_SERVICE_ROLE_KEYを指定してください'); process.exit(1); }

const DUMMY_AGENT_NAMES = new Set(['0']);
const DRY_RUN = process.argv.indexOf('--yes') === -1;

async function sbFetch(table, qs, opts={}){
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers||{}),
    },
  });
  const text = await res.text();
  if(!res.ok) throw new Error(`${table} ${opts.method||'GET'} failed: ${res.status} ${text}`);
  // Prefer: return=minimal(PATCH等)の場合、成功時はSupabase側がレスポンスボディを
  // 空にする(204 No Content、またはcontent-length 0)。空ボディへres.json()を呼ぶと
  // 「Unexpected end of JSON input」で例外になり、DB更新自体は成功しているのに
  // スクリプトだけが異常終了してしまっていた(本番実行で1003件中12件のみ更新後に
  // 停止した不具合の原因)。空ボディはnullを返し、それ以外だけJSON.parseする。
  if(!text) return null;
  try{
    return JSON.parse(text);
  }catch(e){
    throw new Error(`${table} ${opts.method||'GET'} : レスポンスがJSONとして解析できません: ${text.slice(0,200)}`);
  }
}
async function sbSelectAll(table, select){
  let all = [], from = 0; const PAGE = 1000;
  while(true){
    const data = await sbFetch(table, `?select=${encodeURIComponent(select)}&offset=${from}&limit=${PAGE}`);
    all = all.concat(data);
    if(data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function toHalfWidth(str){
  return String(str || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}
const CORP_SUFFIX_PATTERNS = [
  /株式会社/g, /\(株\)/g, /（株）/g, /有限会社/g, /\(有\)/g, /（有）/g,
  /co\.?,?\s*ltd\.?/gi, /co\.?\s*limited/gi, /pvt\.?\s*ltd\.?/gi, /private\s*limited/gi,
  /inc\.?/gi, /corp\.?/gi, /corporation/gi, /llc/gi, /l\.l\.c\.?/gi, /gmbh/gi,
];
function normalizeAgentName(raw){
  let s = toHalfWidth(raw || '');
  s = s.normalize('NFKC');
  CORP_SUFFIX_PATTERNS.forEach(pat => { s = s.replace(pat, ''); });
  s = s.replace(/[.,、。・]/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

async function processTable(table, agentNormMap, agentNormCollisions){
  const rows = await sbSelectAll(table, 'id,agent_name,agent_id');
  const targets = []; // {id, agentId}
  let skippedAlreadySet = 0, skippedDummy = 0, skippedUnmatched = 0, skippedAmbiguous = 0, skippedBlank = 0;

  rows.forEach(r => {
    if(r.agent_id){ skippedAlreadySet++; return; } // べき等: 既に設定済みなら上書きしない
    const raw = (r.agent_name || '').trim();
    if(!raw){ skippedBlank++; return; }
    if(DUMMY_AGENT_NAMES.has(raw)){ skippedDummy++; return; }
    const key = normalizeAgentName(raw);
    if(!key){ skippedBlank++; return; }
    if(agentNormCollisions.has(key)){ skippedAmbiguous++; return; }
    const hit = agentNormMap.get(key);
    if(!hit){ skippedUnmatched++; return; }
    targets.push({ id: r.id, agentId: hit.id, agentName: raw });
  });

  console.log(`\n[${table}] 対象${targets.length}件 / 設定済みスキップ${skippedAlreadySet}件 / ダミー除外${skippedDummy}件 / 未マッチ${skippedUnmatched}件 / 曖昧${skippedAmbiguous}件 / 空欄${skippedBlank}件`);

  if(targets.length===0) return { table, updated:0, target: targets.length };

  // バックアップ(更新対象行のid/agent_name/更新予定agent_idのみ。実データの全カラムは
  // 変更しないため最小限で十分)。
  const backupDir = path.join(__dirname, 'data');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const backupPath = path.join(backupDir, `agent_id_backfill_backup_${table}_${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(targets, null, 2));
  console.log(`  バックアップ保存: ${backupPath}`);

  if(DRY_RUN){
    console.log(`  [ドライラン] --yesが指定されていないため、実際のUPDATEは行いません(${targets.length}件が対象になる見込み)`);
    return { table, updated:0, target: targets.length };
  }

  // agentIdごとにグループ化し、in.()でまとめてPATCHすることで呼び出し回数を抑える。
  const byAgent = new Map();
  targets.forEach(t => { if(!byAgent.has(t.agentId)) byAgent.set(t.agentId, []); byAgent.get(t.agentId).push(t.id); });

  // 1チャンクの失敗で全体を止めない(1件のエラーで残り全部が未処理になっていた不具合の
  // 修正)。失敗したチャンクのidは全てfailedIdsに集約し、最後にまとめて報告する。
  let updated = 0;
  const failedChunks = []; // {agentId, ids, error}
  const totalChunks = [...byAgent.values()].reduce((s,ids)=>s+Math.ceil(ids.length/200), 0);
  let chunkNo = 0;
  for(const [agentId, ids] of byAgent){
    // URL長対策で200件ずつチャンク化(他スクリプトのPATCH URL長エラー対応と同じ方式)。
    for(let i=0; i<ids.length; i+=200){
      const chunk = ids.slice(i, i+200);
      chunkNo++;
      console.log(`  [${chunkNo}/${totalChunks}] agent_id=${agentId} の${chunk.length}件を更新中... (id先頭: ${chunk[0]})`);
      try{
        await sbFetch(table, `?id=in.(${chunk.join(',')})`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ agent_id: agentId }),
        });
        updated += chunk.length;
      }catch(e){
        console.error(`  [${chunkNo}/${totalChunks}] ✗ 失敗: ${e.message}`);
        failedChunks.push({ agentId, ids: chunk, error: e.message });
      }
    }
  }

  if(failedChunks.length){
    console.warn(`\n  ⚠ ${failedChunks.length}チャンク(合計${failedChunks.reduce((s,c)=>s+c.ids.length,0)}件)の更新に失敗しました:`);
    console.table(failedChunks.map(c=>({agent_id:c.agentId, 件数:c.ids.length, 先頭id:c.ids[0], エラー:c.error})));
    const failLogPath = path.join(backupDir, `agent_id_backfill_failed_${table}_${ts}.json`);
    fs.writeFileSync(failLogPath, JSON.stringify(failedChunks, null, 2));
    console.warn(`  失敗チャンクの詳細を保存しました: ${failLogPath}`);
  }

  // 検証: 実際にagent_idが設定されたか再取得して突き合わせる。
  const verifyIds = targets.map(t=>t.id);
  let verifiedCount = 0;
  for(let i=0; i<verifyIds.length; i+=200){
    const chunk = verifyIds.slice(i, i+200);
    const data = await sbFetch(table, `?id=in.(${chunk.join(',')})&select=id,agent_id`);
    verifiedCount += (data||[]).filter(r=>r.agent_id).length;
  }
  if(verifiedCount !== targets.length){
    console.warn(`  ⚠ 検証不一致: 更新対象${targets.length}件のうちagent_id設定確認できたのは${verifiedCount}件です。手動確認してください。`);
  }else{
    console.log(`  更新完了・検証OK: ${updated}件`);
  }
  return { table, updated, target: targets.length, failed: failedChunks.reduce((s,c)=>s+c.ids.length,0) };
}

async function main(){
  console.log(DRY_RUN ? '=== ドライランモード(--yesなし。UPDATEは行いません) ===' : '=== 本実行モード(--yes指定。実際にUPDATEします) ===');

  const agents = await sbSelectAll('agents', 'id,company_name,is_deleted');
  const agentNormMap = new Map();
  const agentNormCollisions = new Map();
  // is_deleted=trueの行(論理削除済み、重複統合の吸収先ではない方)は除外する。
  // is_deletedが無い/NULLの旧データは「削除されていない」扱いにする。
  agents.filter(a => !a.is_deleted).forEach(a => {
    const key = normalizeAgentName(a.company_name);
    if(!key) return;
    if(agentNormMap.has(key)){
      const list = agentNormCollisions.get(key) || [agentNormMap.get(key).company_name];
      list.push(a.company_name);
      agentNormCollisions.set(key, list);
    }else{
      agentNormMap.set(key, {id: a.id, company_name: a.company_name});
    }
  });

  const results = [];
  for(const table of ['bookings', 'booking_sales', 'invoices']){
    results.push(await processTable(table, agentNormMap, agentNormCollisions));
  }

  console.log('\n========== 結果サマリー ==========');
  console.table(results);
  if(DRY_RUN) console.log('\n実際に反映するには --yes を付けて再実行してください。');
}

main().catch(e => { console.error(e); process.exit(1); });
