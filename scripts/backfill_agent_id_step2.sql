-- agent_idバックフィル(Step2): agent_id が未設定(null)のinvoices/bookingsのうち、
-- agent_name(またはbooking側の請求先名)を正規化(trim・小文字化・ピリオド/カンマ除去・
-- 連続空白統一)してagentsマスタ(is_deleted=falseのみ)と突合し、一意に1件へ
-- 特定できたものだけをbackfillする。複数候補や未マッチのものは対象外(手を付けない)。
--
-- 対象の特定は直前に実行した実SELECT結果(agents/invoices/bookingsの実クエリ結果)
-- からのみ引用している。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ===== invoices: 11件 =====
update public.invoices set agent_id = '91c6208b-f483-42ee-8cac-ba8f1116f043' where id = '8d8b0268-0d5a-4440-b84e-270e24428246'; -- INV-728  -> Kesari Tours Pvt. Ltd.
update public.invoices set agent_id = '29ce0b44-1b81-4911-a01d-4b46b5c6e741' where id = '68ed5635-a428-4129-aefd-bb84f8ce1c1c'; -- INV-1069 -> Kulin Kumar Holidays Pvt. LTD
update public.invoices set agent_id = '91c6208b-f483-42ee-8cac-ba8f1116f043' where id = 'af2d4629-5670-455e-ab3f-2570486dbd94'; -- INV-782  -> Kesari Tours Pvt. Ltd.
update public.invoices set agent_id = '7b3af701-a22c-4ba8-b0ec-b7e907d36d1c' where id = '415b10c9-9743-4cba-a356-6327c9eb34af'; -- INV-967  -> M/S. THOMAS COOK (I) LTD.
update public.invoices set agent_id = '093d34cf-5a7a-4185-a9e6-e4824f7fdd31' where id = 'ed48c8ee-b486-4b18-94c3-376fd79c5237'; -- INV-1053 -> ORN VACATIONS PRIVATE LIMITED
update public.invoices set agent_id = '093d34cf-5a7a-4185-a9e6-e4824f7fdd31' where id = 'a54603a8-5b72-410e-8fa1-4fa44ba750ed'; -- INV-1064 -> ORN VACATIONS PRIVATE LIMITED
update public.invoices set agent_id = '093d34cf-5a7a-4185-a9e6-e4824f7fdd31' where id = '9531771f-58c2-4128-a0a4-30cb5095567f'; -- INV-1065 -> ORN VACATIONS PRIVATE LIMITED
update public.invoices set agent_id = '51095588-5484-454f-8388-ae1c115e517f' where id = '808d25e5-3094-4695-810b-4b2b932bdb0a'; -- INV-1269 -> NEXUS DMC
update public.invoices set agent_id = '093d34cf-5a7a-4185-a9e6-e4824f7fdd31' where id = '6b45272d-822c-4f72-a0f9-6bbefdc905ea'; -- INV-563  -> ORN VACATIONS PRIVATE LIMITED
update public.invoices set agent_id = '51095588-5484-454f-8388-ae1c115e517f' where id = '94982ddb-5f1d-405f-9870-1708b1c02172'; -- INV-949  -> NEXUS DMC
update public.invoices set agent_id = '093d34cf-5a7a-4185-a9e6-e4824f7fdd31' where id = '6e834971-059d-46f0-ac34-ddeb77b17ce5'; -- INV-1126 -> ORN VACATIONS PRIVATE LIMITED

-- ===== bookings: 3件 =====
update public.bookings set agent_id = 'e36944ec-2a59-4836-b71a-8f7c0611e24c' where id = '6eba9402-9813-4995-add5-f1af45a32e27'; -- #534 -> DPauls Travel and Tours Ltd.
update public.bookings set agent_id = '016d6c76-e687-4ba1-baec-6c176218ad55' where id = 'd4cdea71-9ec6-4cdf-8400-dc98e8808fe2'; -- #477 -> M/S. SOTC TRAVEL LTD.
update public.bookings set agent_id = 'e36944ec-2a59-4836-b71a-8f7c0611e24c' where id = 'f14ddfab-2747-4d12-b32b-090650fb1076'; -- #527 -> DPauls Travel and Tours Ltd.

-- ===== INV-1188 "Shanzad International" の失効(ソフトデリート) =====
-- invoicesテーブルにis_deleted列は無いが、statusに既存の「失効(void)」という
-- ソフトデリート相当の状態が既に運用されている(Invoice一覧のvoid判定・
-- askInvVoidChoice/closeInvVoidModal等で使用中の既存の仕組み)ため、物理削除ではなく
-- こちらを使う。正しい社名は「Sanzad International LLP」(hなし)と確定。
-- マスタ登録・再紐付けは別途手動で行う予定のため、ここでは失効のみ行う。
update public.invoices set status = 'void' where id = 'f3a3b882-018b-4325-b7a3-29fae3efda53'; -- INV-1188 "Shanzad International" (agent_id null, amount=1269000, booking_id=1bceb284-914e-4a1a-8e76-bb33b4fc4d49)

-- INV-1299 "RES AN EVE" は今回対象外(未紐付けのまま)。
-- bookingsの残り290件(空欄196・"0" 59・実名ありだがマスタ未登録35、Sanzad International LLP
-- 5件含む)も今回対象外。
