-- 予約編集の「編集中表示」用プレゼンステーブル(booking_edit_presence)の新設。
--
-- 背景: 複数人が同じ予約(booking_id)を同時に編集した場合、後から保存した方が先の変更を
-- 無言で上書きしてしまう問題への対策(A案「編集中表示」+B案「保存時の食い違い検知」の
-- ハイブリッド)のうち、A案「編集中表示」で使うテーブル。ロック(排他制御)は導入せず、
-- あくまで「誰が今この予約を見ているか」という気づきのためのハートビート記録のみを行う
-- (編集操作自体はブロックしない)。
--
-- 1ユーザーが同じ予約を複数タブ/複数ウィンドウで開いても1行に集約されるよう、
-- (booking_id, user_email)の組み合わせでunique制約を付ける。ハートビート送信は
-- この組み合わせをキーにしたupsertとして実装する(api/table-crud.jsのdoPresenceHeartbeat参照)。
--
-- booking_idはbookings(id)への外部キーとし、予約本体が削除された場合はプレゼンス行も
-- 連動して削除する(on delete cascade。孤立行が残り続けないようにするため)。
--
-- 権限方針は今日確立した最も安全な方針(RLS有効化、anon/authenticatedへのGRANT自体を
-- 一切行わない)を踏襲する。プレゼンス情報は「誰が今どの予約を見ているか」という
-- 内部専用の一時データであり、クライアントから直接select/insert/update/deleteする
-- 正当な理由が無いため、card_holders(anonにSELECTのみ許可)よりもさらに絞り、
-- guide_bank_accounts/partner_merge_pendingと同じ「読み書きとも service_role 限定」とする。
-- 読み取り(list_active)・書き込み(heartbeat/release)いずれも/api/table-crud.js経由の
-- service_role操作のみとし、サーバー側で検証済みセッションのuser_emailを使う
-- (クライアントが送ってきたuser_emailは信用しない。user_nameは表示用途のみのため
-- クライアント申告値をそのまま使う。詳細はapi/table-crud.jsのdoPresenceHeartbeat参照)。
--
-- last_heartbeat_atが古い行(5分以上前)は、api/table-crud.js側のlist_active実装が
-- 「編集中でない」とみなして結果から除外する運用のため、古い行の物理削除(定期クリーンアップ)
-- は必須ではない。テーブルが際限なく肥大化する懸念がある場合は、別途バッチ削除を検討する
-- (今回はスコープ外)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

create table if not exists public.booking_edit_presence (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  user_email text not null,
  user_name text,
  last_heartbeat_at timestamptz not null default now(),
  unique (booking_id, user_email)
);

create index if not exists booking_edit_presence_booking_id_idx on public.booking_edit_presence(booking_id);

alter table public.booking_edit_presence enable row level security;

-- anon/authenticatedへのGRANTは一切行わない(読み書きとも/api/table-crud.js経由の
-- service_role操作のみ)。RLSポリシーも作らない(ポリシーが1つも無い状態でRLSを有効化すると
-- 全ロールがデフォルトで拒否されるため、GRANT自体が無いanon/authenticatedは元々アクセス
-- できないが、念のためRLSも有効化して二重に塞ぐ。service_roleはRLSを自動的にバイパスする
-- ため、service_role用のポリシーも不要)。
grant select, insert, update, delete on public.booking_edit_presence to service_role;

notify pgrst, 'reload schema';
