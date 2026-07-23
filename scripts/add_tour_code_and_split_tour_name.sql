-- 「TOUR NAME」欄を「TOUR CODE」と「TOUR NAME」に分割するための移行。
-- 既存のtour_name列は「KIC0967_TC / Alpine Route」のような
-- 「ツアーコード / ツアー名」形式で入っているため、
-- 「/」より前をtour_code列に、「/」より後ろ(前後の空白除去)をtour_nameの新しい値として
-- 振り分ける。「/」が無い行はtour_codeを空のままにし、tour_nameは元の値のまま変更しない。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.bookings add column if not exists tour_code text;

update public.bookings
set
  tour_code = trim(split_part(tour_name, '/', 1)),
  tour_name = trim(substring(tour_name from position('/' in tour_name) + 1))
where tour_name like '%/%';

notify pgrst, 'reload schema';
