-- 会员卡 v2：记录保留 5 天 / 兑换并入待处理订单 / 绑定账号与物流提醒
-- 幂等，可重复执行

-- ========== 1. 表结构 ==========
alter table public.orders
  add column if not exists member_card_no text not null default '';
alter table public.orders
  add column if not exists source text not null default 'shop';
alter table public.orders
  add column if not exists gift_order_id bigint;

create index if not exists idx_orders_member_card
  on public.orders (member_card_no) where member_card_no <> '';

alter table public.member_cards
  add column if not exists bind_username text not null default '';

-- ========== 2. 站内信写入（服务端直接写 app_data） ==========
create or replace function public.mc_push_mail(p_key text, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_arr jsonb;
    v_len int;
begin
    if coalesce(btrim(p_key), '') = '' then
        return;
    end if;
    select data into v_arr from public.app_data where key = p_key;
    if v_arr is null or jsonb_typeof(v_arr) <> 'array' then
        v_arr := '[]'::jsonb;
    end if;
    v_arr := v_arr || jsonb_build_object(
        'id', (extract(epoch from clock_timestamp()) * 1000)::bigint,
        'title', coalesce(p_title, ''),
        'body', coalesce(p_body, ''),
        'time', to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'));
    v_len := jsonb_array_length(v_arr);
    if v_len > 300 then
        select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into v_arr
          from jsonb_array_elements(v_arr) with ordinality as t(e, ord)
         where ord > v_len - 300;
    end if;
    insert into public.app_data (key, data, updated_at)
    values (p_key, v_arr, now())
    on conflict (key) do update set data = excluded.data, updated_at = now();
end $$;

-- ========== 3. list_orders 增加会员卡字段 ==========
drop function if exists public.list_orders(text);
create or replace function public.list_orders(p_pwd text)
returns table(id bigint, order_no text, order_pwd text, phone text, username text,
              nickname text, product_name text, amount numeric, discount numeric,
              final_price numeric, trade_no text, receiver text, address text,
              note text, status text, tracking_no text, anti_code text,
              created_at timestamp with time zone, member_card_no text, source text)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not verify_admin_pwd(p_pwd) then return; end if;
    return query
        select o.id, o.order_no, o.order_pwd, o.phone, o.username, o.nickname,
               o.product_name, o.amount, o.discount, o.final_price, o.trade_no,
               o.receiver, o.address, o.note, o.status, o.tracking_no, o.anti_code,
               o.created_at, o.member_card_no, o.source
          from public.orders o
         order by o.created_at desc;
end $$;

-- ========== 4. 发货统一入口：写会员卡物流 + 同步兑换单 ==========
create or replace function public.update_order(
    p_id bigint, p_status text default null, p_tracking_no text default null,
    p_anti_code text default null, p_product_name text default null,
    p_note text default null, p_order_no text default null, p_pwd text default null)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v public.orders;
    v_body text;
    v_is_shipped boolean;
begin
    if p_pwd is not null and not verify_admin_pwd(p_pwd) then return false; end if;

    update public.orders set
        status = coalesce(p_status, status),
        tracking_no = coalesce(p_tracking_no, tracking_no),
        anti_code = coalesce(p_anti_code, anti_code),
        product_name = coalesce(p_product_name, product_name),
        note = coalesce(p_note, note),
        order_no = coalesce(nullif(p_order_no, ''), order_no),
        shipped_at = case when p_status = 'shipped' and coalesce(status, '') <> 'shipped'
                          then now() else shipped_at end
     where id = p_id
    returning * into v;

    if not found then
        return false;
    end if;

    -- 只有会员卡兑换单才有 member_card_no
    if coalesce(v.member_card_no, '') <> '' then
        -- 会员卡兑换单：填了运单号即视为发货（普通商品订单仍按原两步流程）
        if coalesce(v.tracking_no, '') <> '' and coalesce(v.status, '') = 'pending' then
            update public.orders set status = 'shipped', shipped_at = now()
             where id = v.id
            returning * into v;
        end if;
        v_is_shipped := (coalesce(v.status, '') = 'shipped') or (coalesce(v.tracking_no, '') <> '');
        if v_is_shipped then
            v_body := '你的兑换「' || coalesce(v.product_name, '礼品') || '」'
                   || case when coalesce(v.tracking_no, '') <> ''
                           then '已发货，运单号：' || v.tracking_no
                           else '已更新物流信息' end
                   || '。可在此页面「物流提醒」查看。';
            -- 会员卡自己的物流通知（未绑定账号也能看到）
            perform public.mc_push_mail('birch_mail_card_' || v.member_card_no,
                                        '物流提醒 · ' || v.order_no, v_body);
            -- 绑定账号的站内信由后台原有逻辑发送（orders.username 已填绑定账号，
            -- 前端 setOrderTracking / batchFinishOrders 会调用 pushMail），此处不重复写
            update public.gift_orders
               set status = 'shipped',
                   tracking_no = v.tracking_no,
                   shipped_at = now()
             where (v.gift_order_id is not null and id = v.gift_order_id)
                or (order_no = v.order_no and coalesce(v.order_no, '') <> '');
        end if;
    end if;

    return true;
end $$;

-- ========== 5. 兑换：同时生成待处理订单 ==========
create or replace function public.mc_redeem(
    p_login text, p_hash text, p_gift_id bigint,
    p_nickname text, p_phone text, p_address text, p_note text default ''::text)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare
    v public.member_cards; g public.gifts;
    v_order_no text; v_order public.gift_orders;
    v_shop_no text; v_shop_pwd text;
begin
    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1 for update;
    if not found then raise exception '会员卡不存在'; end if;
    if v.status <> 'active' then raise exception '会员卡已停用，请联系客服'; end if;
    if v.pwd_hash <> lower(btrim(coalesce(p_hash, ''))) then
        raise exception '登录已过期，请重新输入密码';
    end if;

    select * into g from public.gifts
     where id = p_gift_id and active = true
     for update;
    if not found then raise exception '礼品不存在或已下架'; end if;
    if g.stock is not null and g.stock <= 0 then raise exception '礼品已兑完'; end if;
    if v.points < g.points_cost then
        raise exception '积分不足：当前 % 分，兑换需 % 分',
            to_char(v.points, 'FM999999990.##'), to_char(g.points_cost, 'FM999999990.##');
    end if;
    if coalesce(btrim(p_nickname), '') = '' or coalesce(btrim(p_phone), '') = ''
       or coalesce(btrim(p_address), '') = '' then
        raise exception '请填写收货人、电话和地址';
    end if;

    if g.stock is not null then
        update public.gifts set stock = stock - 1, updated_at = now() where id = g.id;
    end if;

    update public.member_cards
       set points = points - g.points_cost, updated_at = now()
     where id = v.id
    returning * into v;

    v_order_no := 'G' || to_char(now(), 'YYMMDD') || lpad(nextval('gift_order_seq')::text, 4, '0');

    insert into public.gift_orders
        (order_no, card_id, card_no, login_id, gift_id, gift_name, points_cost,
         nickname, phone, address, note)
    values
        (v_order_no, v.id, v.card_no, v.login_id, g.id, g.name, g.points_cost,
         btrim(p_nickname), btrim(p_phone), btrim(p_address), coalesce(p_note, ''))
    returning * into v_order;

    -- 生成一条正式订单，进入后台「待处理订单」
    v_shop_no := 'M' || to_char(now(), 'YYMMDD') || lpad(nextval('gift_order_seq')::text, 4, '0');
    v_shop_pwd := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    insert into public.orders
        (order_no, order_pwd, username, nickname, phone, product_name,
         amount, discount, final_price, trade_no, receiver, address, note,
         status, member_card_no, source, gift_order_id)
    values
        (v_shop_no, v_shop_pwd, coalesce(v.bind_username, ''), btrim(p_nickname), btrim(p_phone),
         '积分兑换 · ' || g.name, 0, 0, 0, '',
         btrim(p_nickname), btrim(p_address),
         '会员卡 ' || v.card_no || ' 兑换，扣 ' || to_char(g.points_cost, 'FM999999990.##') || ' 积分'
         || case when coalesce(p_note, '') <> '' then '；' || btrim(p_note) else '' end,
         'pending', v.card_no, 'gift', v_order.id);

    insert into public.member_txns
        (card_id, card_no, kind, points, balance_after, points_after, title, operator, ref_no)
    values
        (v.id, v.card_no, 'redeem', -g.points_cost, v.balance, v.points,
         '兑换礼品：' || g.name || '（' || to_char(g.points_cost, 'FM999999990.##') || ' 积分）',
         'self', v_shop_no);

    return jsonb_build_object(
        'ok', true, 'order_no', v_shop_no, 'gift_order_no', v_order_no,
        'gift_name', g.name, 'points_cost', g.points_cost,
        'points', v.points, 'card_no', v.card_no);
end $$;

-- ========== 6. 消费/积分记录只保留 5 天 ==========
create or replace function public.mc_my_txns(p_login text, p_hash text, p_limit integer default 100)
returns setof jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare v public.member_cards;
begin
    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1;
    if not found then raise exception '会员卡不存在'; end if;
    if v.pwd_hash <> lower(btrim(coalesce(p_hash, ''))) then
        raise exception '登录已过期，请重新输入密码';
    end if;
    return query
        select public.mc_txn_json(t)
          from public.member_txns t
         where t.card_id = v.id
           and t.created_at >= now() - interval '5 days'
         order by t.created_at desc, t.id desc
         limit greatest(1, least(coalesce(p_limit, 100), 300));
end $$;

create or replace function public.mc_admin_txns(p_pwd text, p_card_no text, p_limit integer default 100)
returns setof jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare v public.member_cards;
begin
    if not verify_admin_pwd(p_pwd) then raise exception '无管理员权限'; end if;
    select * into v from public.member_cards where card_no = btrim(p_card_no) limit 1;
    if not found then raise exception '会员卡不存在'; end if;
    return query
        select public.mc_txn_json(t)
          from public.member_txns t
         where t.card_id = v.id
           and t.created_at >= now() - interval '5 days'
         order by t.created_at desc, t.id desc
         limit greatest(1, least(coalesce(p_limit, 100), 300));
end $$;

-- 每天清理 5 天前的记录
create or replace function public.mc_purge_txns(p_days integer default 5)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
    delete from public.member_txns
     where created_at < now() - make_interval(days => greatest(1, coalesce(p_days, 5)));
    get diagnostics v_count = row_count;
    return v_count;
end $$;

do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        begin
            perform cron.unschedule('mc-purge-txns');
        exception when others then
            null;
        end;
        perform cron.schedule('mc-purge-txns', '15 3 * * *', 'select public.mc_purge_txns(5)');
    end if;
exception when others then
    null;
end $$;

-- ========== 7. 前台物流提醒 ==========
create or replace function public.mc_my_logistics(p_login text, p_hash text)
returns setof jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare v public.member_cards;
begin
    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1;
    if not found then raise exception '会员卡不存在'; end if;
    if v.pwd_hash <> lower(btrim(coalesce(p_hash, ''))) then
        raise exception '登录已过期，请重新输入密码';
    end if;
    return query
        select jsonb_build_object(
            'order_no', o.order_no,
            'product', o.product_name,
            'status', o.status,
            'tracking', coalesce(o.tracking_no, ''),
            'created_at', o.created_at,
            'shipped_at', o.shipped_at)
          from public.orders o
         where o.member_card_no = v.card_no
         order by o.created_at desc
         limit 30;
end $$;

-- ========== 8. 绑定账号（可选把卡号改为手机号） ==========
create or replace function public.mc_admin_bind(
    p_pwd text, p_card_no text, p_username text, p_to_phone boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare
    v public.member_cards;
    u public.users;
    v_new text;
begin
    if not verify_admin_pwd(p_pwd) then raise exception '无管理员权限'; end if;
    select * into v from public.member_cards where card_no = btrim(p_card_no) limit 1 for update;
    if not found then raise exception '会员卡不存在'; end if;

    v_new := v.card_no;
    if coalesce(btrim(p_username), '') <> '' then
        select * into u from public.users where username = btrim(p_username) limit 1;
        if not found then raise exception '账号不存在'; end if;
        if p_to_phone then
            if coalesce(btrim(u.phone), '') = '' then
                raise exception '该账号未填写手机号，无法改为卡号';
            end if;
            if exists (select 1 from public.member_cards
                        where card_no = btrim(u.phone) and id <> v.id) then
                raise exception '该手机号已被其它会员卡占用';
            end if;
            v_new := btrim(u.phone);
        end if;
    end if;

    update public.member_cards
       set bind_username = coalesce(btrim(p_username), ''),
           card_no = v_new,
           updated_at = now()
     where id = v.id;

    if v_new <> v.card_no then
        update public.member_txns set card_no = v_new where card_id = v.id;
        update public.gift_orders set card_no = v_new where card_id = v.id;
        update public.orders set member_card_no = v_new where member_card_no = v.card_no;
    end if;

    return jsonb_build_object(
        'ok', true, 'card_no', v_new, 'old_card_no', v.card_no,
        'bind_username', coalesce(btrim(p_username), ''));
end $$;

-- ========== 8.5 卡片 JSON 增加绑定账号字段 ==========
create or replace function public.mc_card_json(c member_cards)
returns jsonb
language sql
immutable
as $$
    select jsonb_build_object(
        'card_no', c.card_no, 'login_id', c.login_id, 'nickname', c.nickname,
        'phone', c.phone, 'points', c.points, 'balance', c.balance,
        'note', c.note, 'status', c.status, 'bind_username', c.bind_username,
        'created_at', c.created_at, 'updated_at', c.updated_at);
$$;

-- ========== 9. 权限：只允许通过 RPC 调用 ==========
revoke all on function public.mc_push_mail(text, text, text) from public;
revoke all on function public.mc_purge_txns(integer) from public;
grant execute on function public.mc_my_logistics(text, text) to anon, authenticated;
grant execute on function public.mc_admin_bind(text, text, text, boolean) to anon, authenticated;
grant execute on function public.list_orders(text) to anon, authenticated;
grant execute on function public.update_order(bigint, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.mc_redeem(text, text, bigint, text, text, text, text) to anon, authenticated;
