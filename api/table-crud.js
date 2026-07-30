// service_role key経由の汎用テーブル操作API。
//
// これまでbooking-sales.js/booking-costs.js/local-expenses.js/parking-reservations.jsの
// 4ファイルに分かれていた「anonロールの直接書き込みを禁止し、ログイン済みユーザーからの
// リクエストのみservice_role keyで書き込みを許可する」という全く同じ実装パターンを、
// Vercel Hobbyプランのサーバーレス関数数上限(12個)対策として1ファイルに統合したもの。
//
// セキュリティ上の見通しを保つため、統合後も「どのテーブルに」「どのactionが」許可されて
// いるかをTABLE_CONFIGで明示的にホワイトリスト化している(bodyのtable名をそのままクエリに
// 埋め込んで任意テーブルを操作できるような実装にはしていない)。各テーブル・action固有の
// バリデーション/レスポンス形状は、移行前の各ファイルの実装をそのまま踏襲する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

// テーブルごとに許可するactionをホワイトリスト化する。ここに無い(table, action)の
// 組み合わせは400で拒否する。
const TABLE_CONFIG = {
  booking_sales: { actions: ['replace', 'updatePayments', 'deleteByBooking'], label: '売上明細' },
  booking_costs: { actions: ['replace', 'insert', 'deleteByBooking'], label: '仕入明細' },
  local_expenses: { actions: ['replace'], label: '現地費用明細' },
  parking_reservations: { actions: ['list', 'save', 'delete'], label: '駐車場予約' },
  // guide_settlements/guide_settlement_items: 社内スタッフ(index.html、ログインセッション
  // トークンで認証)からの操作に加え、ガイド本人がguide.html(ログイン機構を持たず、精算
  // リンクのaccess_tokenのみで認証する)から自分の精算明細を送信・編集するケースがある。
  // そのためguestInsert/guestUpdateByIdの2アクションのみ、通常のセッショントークンの
  // 代わりにguide_settlements.access_tokenでの認証を許可する(handler側のguest認証分岐、
  // および各doGuest*関数のsettlement_id検証を参照)。
  guide_settlements: {
    actions: ['insert', 'updateById', 'updateByIds', 'deleteById', 'deleteByIds', 'deleteByField'],
    label: 'ガイド精算',
    allowedDeleteFields: ['booking_ref'],
  },
  guide_settlement_items: {
    actions: ['insert', 'updateById', 'updateByIds', 'deleteById', 'deleteByIds', 'deleteByField', 'guestInsert', 'guestUpdateById'],
    label: 'ガイド精算明細',
    allowedDeleteFields: ['settlement_id'],
    // ガイド本人(guestUpdateById)が編集できるのは受領書番号のみ。ステータス承認・
    // 反映フラグ等、社内スタッフのみが操作すべき項目はここに含めない。
    guestUpdatableFields: ['receipt_no'],
  },
  // business_partners(取引先マスタ): permanentlyDeletePartner(完全削除、deleteById)以外は
  // deletePartner/restorePartnerともis_deletedフラグを立てる論理削除(updateById)であり、
  // 実際のDELETE文はdeleteByIdの1箇所のみ(削除済み取引先の復元画面から明示的に実行)。
  business_partners: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '取引先マスタ',
  },
  // agents(取引先マスタ・Agent): business_partnersと完全に同じ論理削除/復元/完全削除の
  // 構造を持つ、送客元エージェント専用の別テーブル。
  agents: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '取引先マスタ(Agent)',
  },
  // guides(ガイドマスタ): business_partners/agentsと異なりis_deleted等の論理削除列を
  // 持たず、ハードデリートのみ。予約詳細のガイド検索から「＋新規ガイド登録」する際
  // (submitNewGuide)、挿入直後の採番id(guide_id)をその場でbooking_guides側に紐付ける
  // 必要があるため、insertReturningで挿入結果を返す。
  guides: {
    actions: ['insert', 'insertReturning', 'updateById', 'deleteById'],
    label: 'ガイドマスタ',
  },
  // bookings(予約本体): フェーズ3。他の全テーブルから参照される中核テーブルのため、
  // 今回は書き込み(insert/updateById/deleteById)のみをservice_role経由に移行し、
  // 読み取り(select、一覧表示・ダッシュボード・メールマッチング等)はこれまで通り
  // anon+RLSのまま変更しない(rollout時のリスクを最小化するため)。
  bookings: {
    actions: ['insert', 'updateById', 'deleteById'],
    label: '予約',
  },
  // booking_facilities(観光施設・バス駐車場等): 観光地予約管理画面(複数予約横断の
  // 一覧・インライン編集)からのステータス/確認番号/備考の更新のみをservice_role経由に
  // 移行。読み取り、および既存のダッシュボードToDo(対応期限管理)からの更新は
  // 今回のスコープ外でありanon+RLSのまま変更しない。
  // insert: 観光地予約管理ページのAI読み取り機能から、複数予約(booking_id)へ
  // またがる観光施設明細をまとめて新規追加するために使用する。updateByIdは
  // 従来通りインライン編集用。
  // booking_facilitiesはdeadline_completed_at等の目的限定タイムスタンプは持つが汎用
  // updated_atは無い。今回はcreated_by/updated_byのみ追加し、汎用updated_at列の新設は
  // スコープ外とする(stampUpdatedAtは付けない)。
  booking_facilities: {
    actions: ['updateById', 'insert'],
    label: '観光施設・バス駐車場等',
    stampIdentity: true,
  },
  // booking_hotels/booking_buses/booking_restaurants(セキュリティ移行バッチA)。
  // 予約詳細モーダルの保存(旧safeReplaceBookingRows)は既存のbooking_sales等と同じ
  // doReplace(action:'replace')に統一する。booking_hotelsのみ、ホテル管理ページの
  // 重複解消モーダル(insert/updateById)とステータスクイック切替(updateById)がある
  // ため、それらのactionも合わせて許可する。
  // stampIdentity: true の各テーブルは、created_by/updated_by列を持つ(監査ログ機能の
  // 前提整備)。値はクライアントの自己申告を一切信用せず、verifySessionTokenで検証済みの
  // トークンから取り出したemailのみをサーバー側でスタンプする(下記handler参照)。
  // booking_hotelsは既にstatus_updated_at列を持つため、汎用updated_at列は追加しない
  // (stampUpdatedAtは付けない。created_by/updated_byのみ追加・スタンプする)。
  booking_hotels: {
    actions: ['replace', 'insert', 'updateById'],
    label: 'ホテル明細',
    stampIdentity: true,
  },
  // booking_buses/booking_restaurantsはupdated_at相当の列が無かったため、created_by/
  // updated_byに加えて汎用updated_at列も新設し、insert/replace時にスタンプする。
  booking_buses: {
    actions: ['replace'],
    label: 'バス明細',
    stampIdentity: true,
    stampUpdatedAt: true,
  },
  booking_restaurants: {
    actions: ['replace'],
    label: 'レストラン明細',
    stampIdentity: true,
    stampUpdatedAt: true,
  },
};

function sbFetch(table, path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/${table}${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function readJsonSafe(resp) {
  try { return await resp.json(); } catch (e) { return {}; }
}

// PostgRESTが"permission denied for table xxx"を返す典型的な原因は、RLS/GRANTの
// ロックダウンSQL実行時にservice_roleへのGRANT文が反映されていないケース
// (service_roleはRLSはバイパスするが、テーブル自体へのGRANTが無ければ書き込めない)。
// 原因調査を早くできるよう、その場合だけヒントを付け足す(移行前の各ファイルと同じ対策)。
function withGrantHint(message, table) {
  if (/permission denied for table/i.test(String(message || ''))) {
    return `${message}\n\n（service_roleロールに${table}へのGRANTが付与されていない可能性があります。Supabase SQL Editorで次を再実行してください: grant select, insert, update, delete on public.${table} to service_role; notify pgrst, 'reload schema';）`;
  }
  return message;
}

// 「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」安全な差分置き換え。
// クライアント側のsafeReplaceBookingRowsと同じ考え方(#782の全削除→再挿入事故の再発防止)。
async function doReplace(table, label, bookingId, rows) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };

  const existingRes = await sbFetch(table, `?booking_id=eq.${encodeURIComponent(bookingId)}&select=id`);
  if (!existingRes.ok) return { status: 500, body: { error: '既存データの確認に失敗しました' } };
  const existing = await existingRes.json();
  const existingIds = (existing || []).map((r) => r.id);

  if (Array.isArray(rows) && rows.length) {
    const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!insRes.ok) {
      const e = await readJsonSafe(insRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
    }
  }
  if (existingIds.length) {
    const delRes = await sbFetch(table, `?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!delRes.ok) {
      const e = await readJsonSafe(delRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）` } };
    }
  }
  return { status: 200, body: { ok: true } };
}

// insertと同じだが、挿入直後にDBが採番したid等をクライアントに返す必要がある場合
// (例: submitNewGuideがガイド新規登録直後にそのidを予約行へ紐付ける)に使う。
async function doInsertReturning(table, label, rows) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(rows) });
  if (!insRes.ok) {
    const e = await readJsonSafe(insRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
  }
  const inserted = await insRes.json();
  return { status: 200, body: { ok: true, rows: inserted } };
}

async function doInsert(table, label, rows) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
  if (!insRes.ok) {
    const e = await readJsonSafe(insRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteByBooking(table, label, bookingId) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  const delRes = await sbFetch(table, `?booking_id=eq.${encodeURIComponent(bookingId)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!delRes.ok) {
    const e = await readJsonSafe(delRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

// booking_sales専用: 入金消込(通帳OCRの自動マッチング等)で、既存1行のpaymentsのみを更新する。
async function doUpdatePayments(table, rowId, payments) {
  if (!rowId) return { status: 400, body: { error: 'rowIdが指定されていません' } };
  const upRes = await sbFetch(table, `?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payments }),
  });
  if (!upRes.ok) {
    const e = await readJsonSafe(upRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '入金反映に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

// parking_reservations専用: 一覧取得。テーブル未作成時はエラーにせず空配列を返す
// (移行前のparking-reservations.jsと同じフォールバック挙動)。
async function doParkingList(table, limit) {
  const lim = Number(limit) > 0 ? Math.min(Number(limit), 200) : 10;
  const r = await sbFetch(table, `?select=*&order=created_at.desc&limit=${lim}`);
  if (!r.ok) {
    const e = await readJsonSafe(r);
    if (/relation .* does not exist/i.test(e.message || '')) return { status: 200, body: { rows: [], tableMissing: true } };
    return { status: 500, body: { error: withGrantHint(e.message, table) || '一覧の取得に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { rows } };
}

// parking_reservations専用: idがあれば更新、なければ新規作成(upsert)。
async function doParkingSave(table, id, payload) {
  if (!payload || typeof payload !== 'object') return { status: 400, body: { error: '保存する内容がありません' } };

  if (id) {
    const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await readJsonSafe(r);
      return { status: 500, body: { error: withGrantHint(e.message, table) || '更新に失敗しました' } };
    }
    const rows = await r.json();
    return { status: 200, body: { ok: true, row: rows[0] || null } };
  }

  const r = await sbFetch(table, '', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(payload) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    if (/relation .* does not exist/i.test(e.message || '')) {
      return { status: 500, body: { error: `${table}テーブルが未作成です。管理者にSupabase側でのテーブル作成を依頼してください。` } };
    }
    return { status: 500, body: { error: withGrantHint(e.message, table) || '登録に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { ok: true, row: rows[0] || null } };
}

async function doParkingDelete(table, id) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '削除に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

// 汎用actions(主にguide_settlements/guide_settlement_items向け。社内スタッフは
// これまでもanonキーで全フィールドを自由に読み書きできていたため、フィールドの
// ホワイトリスト化はせず、認証(有効なログインセッション)のみを要件とする。
async function doUpdateById(table, label, id, fields) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  if (!fields || typeof fields !== 'object') return { status: 400, body: { error: '更新内容が指定されていません' } };
  // return=representationにして更新後の行を返す。呼び出し元(bookings.saveBookingDetail等)が
  // 「更新対象の行が実際に存在したか(0件更新でないか)」を判定するために使う。
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(fields) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の更新に失敗しました` } };
  }
  const updatedRows = await r.json();
  return { status: 200, body: { ok: true, rows: updatedRows } };
}

async function doUpdateByIds(table, label, ids, fields) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { error: 'idが指定されていません' } };
  if (!fields || typeof fields !== 'object') return { status: 400, body: { error: '更新内容が指定されていません' } };
  const r = await sbFetch(table, `?id=in.(${ids.map(encodeURIComponent).join(',')})`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(fields) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の更新に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteById(table, label, id) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteByIds(table, label, ids) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { error: 'idが指定されていません' } };
  const r = await sbFetch(table, `?id=in.(${ids.map(encodeURIComponent).join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

// field/valueによる削除は、TABLE_CONFIG.allowedDeleteFieldsに明示されている列に限定する
// (bodyから任意の列名を受け取ってそのままクエリに埋め込むことを避けるため)。
async function doDeleteByField(table, label, config, field, value) {
  if (!config.allowedDeleteFields || !config.allowedDeleteFields.includes(field)) {
    return { status: 400, body: { error: `${table}に対して許可されていない削除条件です: ${field}` } };
  }
  if (value === undefined || value === null || value === '') return { status: 400, body: { error: '削除条件の値が指定されていません' } };
  const filter = Array.isArray(value) ? `in.(${value.map(encodeURIComponent).join(',')})` : `eq.${encodeURIComponent(value)}`;
  const r = await sbFetch(table, `?${field}=${filter}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

// guide.html(ログイン機構を持たない、精算リンクのaccess_tokenのみで認証)からの
// リクエスト用。access_tokenをguide_settlementsテーブルに照会し、該当する精算レコード
// (guestSettlement)を返す。見つからなければ「リンクが無効」として扱う。
async function resolveGuestSettlement(guestToken) {
  if (!guestToken) return null;
  const r = await sbFetch('guide_settlements', `?access_token=eq.${encodeURIComponent(guestToken)}&select=id,booking_ref,status`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] ? rows[0] : null;
}

// ガイド本人によるguide_settlement_items新規送信(領収書等)。クライアントが送ってきた
// settlement_idは信用せず、access_tokenから解決した本人の精算IDを必ず全行に強制設定する
// (他人の精算リンクのaccess_tokenを使わない限り、他の精算への書き込みはできない)。
async function doGuestInsert(table, label, rows, guestSettlement) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const safeRows = rows.map((row) => ({ ...row, settlement_id: guestSettlement.id }));
  return doInsert(table, label, safeRows);
}

// ガイド本人によるguide_settlement_items編集(受領書番号の修正等)。
// 1) 更新可能フィールドをTABLE_CONFIG.guestUpdatableFieldsでホワイトリスト化
// 2) 対象行が自分の精算(guestSettlement.id)に属することを更新前に確認
async function doGuestUpdateById(table, label, config, id, fields, guestSettlement) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const allowed = config.guestUpdatableFields || [];
  const safeFields = {};
  Object.keys(fields || {}).forEach((k) => { if (allowed.includes(k)) safeFields[k] = fields[k]; });
  if (Object.keys(safeFields).length === 0) return { status: 400, body: { error: '更新可能な項目がありません' } };

  const checkRes = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}&select=id,settlement_id`);
  if (!checkRes.ok) return { status: 500, body: { error: '対象データの確認に失敗しました' } };
  const checkRows = await checkRes.json();
  if (!checkRows || !checkRows[0] || checkRows[0].settlement_id !== guestSettlement.id) {
    return { status: 403, body: { error: 'この項目を編集する権限がありません' } };
  }
  return doUpdateById(table, label, id, safeFields);
}

// 旧エンドポイント(/api/booking-costs等)からのリクエストの後方互換対応。
// 統合前のフロントエンドJSがブラウザに残ったまま(デプロイ後もタブを開きっぱなしのユーザー)
// でも、bodyにtableが無い場合はvercel.jsonのルーティングで付与されるlegacyTableクエリ
// パラメータから推測してtable-crud.jsの処理に合流させることで、「デプロイ直後は動くが、
// 既に開いていたタブだけ404で保存できない」という事故を防ぐ(2026-07-27 本番インシデント対応)。
// vercel.jsonでこれらの旧パスは全てこの同じapi/table-crud.jsにルーティングされる
// (別ファイルではないためVercelの関数数は増えない)。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const body = req.body || {};
  const table = body.table || (req.query && req.query.legacyTable);
  const { action, token, guestToken } = body;

  // guestInsert/guestUpdateByIdのみ、ログインセッションを持たないguide.html(ガイド本人が
  // 精算リンクのaccess_tokenだけでアクセスする画面)からの呼び出しを許可する。それ以外の
  // 全actionは、これまで通り社内スタッフのログインセッショントークン検証を必須とする。
  const isGuestAction = action === 'guestInsert' || action === 'guestUpdateById';
  let guestSettlement = null;
  let session = null;
  if (isGuestAction) {
    guestSettlement = await resolveGuestSettlement(guestToken);
    if (!guestSettlement) return res.status(401).json({ error: '精算リンクが無効です。リンクの有効期限が切れているか、URLが正しくない可能性があります。' });
  } else {
    session = verifySessionToken(token);
    if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  }

  const config = TABLE_CONFIG[table];
  if (!config) return res.status(400).json({ error: `不明なtableです: ${table}` });
  if (!config.actions.includes(action)) return res.status(400).json({ error: `${table}に対して許可されていないactionです: ${action}` });

  // 監査ログ機能の前提整備(セキュリティ移行バッチA)：created_by/updated_byは
  // クライアントの自己申告値を一切使わず、verifySessionTokenで検証済みのemailのみを
  // サーバー側でスタンプする(guide_settlements等の既存created_byが「クライアントの
  // 自己申告値をそのまま信用する」設計になっている問題を、stampIdentity対象テーブルでは
  // 再現しない)。
  const stampEmail = config.stampIdentity && session ? session.email : null;
  function stampNewRows(rows) {
    if (!stampEmail || !Array.isArray(rows)) return rows;
    const extra = config.stampUpdatedAt ? { updated_at: new Date().toISOString() } : {};
    return rows.map((r) => ({ ...r, created_by: stampEmail, updated_by: stampEmail, ...extra }));
  }
  function stampUpdateFields(fields) {
    if (!stampEmail || !fields || typeof fields !== 'object') return fields;
    const extra = config.stampUpdatedAt ? { updated_at: new Date().toISOString() } : {};
    return { ...fields, updated_by: stampEmail, ...extra };
  }

  try {
    if (action === 'replace') {
      const { bookingId, rows } = req.body;
      const result = await doReplace(table, config.label, bookingId, stampNewRows(rows));
      return res.status(result.status).json(result.body);
    }
    if (action === 'insert') {
      const { rows } = req.body;
      const result = await doInsert(table, config.label, stampNewRows(rows));
      return res.status(result.status).json(result.body);
    }
    if (action === 'insertReturning') {
      const { rows } = req.body;
      const result = await doInsertReturning(table, config.label, rows);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByBooking') {
      const { bookingId } = req.body;
      const result = await doDeleteByBooking(table, config.label, bookingId);
      return res.status(result.status).json(result.body);
    }
    if (action === 'updatePayments') {
      const { rowId, payments } = req.body;
      const result = await doUpdatePayments(table, rowId, payments);
      return res.status(result.status).json(result.body);
    }
    if (action === 'list') {
      const { limit } = req.body;
      const result = await doParkingList(table, limit);
      return res.status(result.status).json(result.body);
    }
    if (action === 'save') {
      const { id, payload } = req.body;
      const result = await doParkingSave(table, id, payload);
      return res.status(result.status).json(result.body);
    }
    if (action === 'delete') {
      const { id } = req.body;
      const result = await doParkingDelete(table, id);
      return res.status(result.status).json(result.body);
    }
    if (action === 'updateById') {
      const { id, fields } = req.body;
      const result = await doUpdateById(table, config.label, id, stampUpdateFields(fields));
      return res.status(result.status).json(result.body);
    }
    if (action === 'updateByIds') {
      const { ids, fields } = req.body;
      const result = await doUpdateByIds(table, config.label, ids, fields);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteById') {
      const { id } = req.body;
      const result = await doDeleteById(table, config.label, id);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByIds') {
      const { ids } = req.body;
      const result = await doDeleteByIds(table, config.label, ids);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByField') {
      const { field, value } = req.body;
      const result = await doDeleteByField(table, config.label, config, field, value);
      return res.status(result.status).json(result.body);
    }
    if (action === 'guestInsert') {
      const { rows } = req.body;
      const result = await doGuestInsert(table, config.label, rows, guestSettlement);
      return res.status(result.status).json(result.body);
    }
    if (action === 'guestUpdateById') {
      const { id, fields } = req.body;
      const result = await doGuestUpdateById(table, config.label, config, id, fields, guestSettlement);
      return res.status(result.status).json(result.body);
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
