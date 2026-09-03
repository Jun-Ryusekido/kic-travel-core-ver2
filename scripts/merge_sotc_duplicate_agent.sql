-- 取引先マスタ(agents)の重複統合: 「M/S. SOTC TRAVEL LTD.」が担当者違い
-- (Binita Lama / Narmada Muthu Thanu)で2件登録されていた件の統合。
--
-- 背景: Invoice住所欄空欄・Invoice発行時のユニーク制約違反の調査(SESSION_NOTES.md
-- 調査A参照)で、agent_id不在時のcompany_name完全一致フォールバックが、この重複により
-- .maybeSingle()で複数件ヒットしエラーになる(index.html 28024-28027行のコメント参照)
-- ことが判明した。実データを比較し、参照件数・連絡先の充実度から以下の通り統合する。
--
--   正(残す側): 016d6c76-e687-4ba1-baec-6c176218ad55 (Binita Lama)
--     - bookings.agent_id一致 7件、invoices.agent_id一致 1件(INV-967-SO)
--     - company_phone・携帯番号(contact_person2)ありで連絡先がより充実
--   統合対象(is_deleted=trueにする側): 15aa9c0d-39f4-4984-a312-517b73e3fce8 (Narmada Muthu Thanu)
--     - bookings.agent_id一致 1件(#870)のみ、invoices.agent_id一致 0件
--
-- 実行前に以下を実クエリで確認済み(2026-09-03時点):
--   - bookings: id=9d841ca2-5598-457d-8452-62f993fed5c2 (ref_no=#870) のagent_idが
--     15aa9c0d-39f4-4984-a312-517b73e3fce8 になっている(唯一の参照)。
--   - agents: 016d6c76側のcontact_person3_*列は全てnull(空きスロット)であることを
--     確認済みのため、Narmadaさんの連絡先を上書きせずcontact_person3として追加登録する。
--
-- 物理削除は行わない(is_deleted=trueによる論理削除のみ。取引先マスタ画面の
-- deleteAgent()と同じフィールド構成)。
--
-- Supabaseダッシュボードの SQL Editor で、上から順に実行すること。

-- 1) booking #870の付け替え(agent_id: 15aa9c0d → 016d6c76)
update public.bookings set agent_id = '016d6c76-e687-4ba1-baec-6c176218ad55'
  where id = '9d841ca2-5598-457d-8452-62f993fed5c2';

-- 2) Narmadaさんの連絡先をcontact_person3として正式登録(空きスロットのため上書きなし)
update public.agents set
  contact_person3_name_en = 'Narmada Muthu Thanu',
  contact_person3_phone = '+91 98206 73153',
  contact_person3_email = 'narmada.muthuthanu@sotc.in'
  where id = '016d6c76-e687-4ba1-baec-6c176218ad55';

-- 3) 15aa9c0d(Narmada側のレコード)を論理削除
update public.agents set
  is_deleted = true,
  deleted_at = now(),
  deleted_by = 'jr@kictravel.jp'
  where id = '15aa9c0d-39f4-4984-a312-517b73e3fce8';

notify pgrst, 'reload schema';
