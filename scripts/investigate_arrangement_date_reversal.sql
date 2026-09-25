-- 読み取り専用: 日付の前後チェック(ホテル・バス明細の逆転で保存を止める)と、バスのドライバー宿泊(driver_*)の
-- 既存データの確認。2026-09-25 作成。JUNがSupabase SQL Editorで1ブロックずつ実行する。

-- 1) 既に日付が逆転しているホテル明細(この予約は、直すまで予約詳細を保存できなくなる)
select b.ref_no, h.hotel_name, h.check_in, h.check_out, h.booking_id
from public.booking_hotels h
join public.bookings b on b.id = h.booking_id
where h.check_in is not null and h.check_out is not null and h.check_out < h.check_in
order by b.ref_no;

-- 2) 既に日付が逆転しているバス明細(同上)
select b.ref_no, x.bus_company, x.start_date, x.end_date, x.booking_id
from public.booking_buses x
join public.bookings b on b.id = x.booking_id
where x.start_date is not null and x.end_date is not null and x.end_date < x.start_date
order by b.ref_no;

-- 3) ドライバー宿泊(driver_*)に値が残っているバス明細の件数(この修正の前は、予約詳細でバスタブを保存するたびにNULLに戻っていた)
select count(*) filter (where coalesce(driver_hotel_name, '') <> '') as has_hotel_name,
       count(*) filter (where coalesce(driver_hotel_phone, '') <> '') as has_phone,
       count(*) filter (where coalesce(driver_hotel_address, '') <> '') as has_address,
       count(*) filter (where driver_check_in is not null) as has_check_in,
       count(*) filter (where driver_check_out is not null) as has_check_out,
       count(*) filter (where coalesce(driver_hotel_amount, 0) > 0) as has_amount,
       count(*) filter (where driver_check_in is not null and driver_check_out is not null and driver_check_out < driver_check_in) as reversed_driver_dates,
       count(*) as total
from public.booking_buses;

-- 4) booking_busesの全列(保存処理 buildBusRows が送らない列が他に無いかの確認用)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'booking_buses'
order by ordinal_position;
