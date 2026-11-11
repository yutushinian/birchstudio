-- ============================================================
-- 白桦 · 会员卡模块 v1（幂等，可重复执行）
-- 项目：btfxanbzshefhobndywd（api.birchstudio.cn）
-- 内容：
--   1) 4 张表：member_cards / member_txns / gifts / gift_orders
--   2) 后台 RPC：mc_admin_*（发卡、改资料、删卡、改密、消费、积分/余额调整、明细、NFC 码）
--   3) 前台 RPC：mc_login / mc_login_hash / mc_change_pwd / mc_my_txns / mc_gift_list / mc_redeem
--   4) 礼品与兑换订单 RPC：gift_admin_*
-- 说明：
--   * 所有表开启 RLS 且无任何放行策略，只能通过 SECURITY DEFINER 函数访问
--   * 管理员鉴权沿用站点既有模型：p_pwd 传「管理员用户名」，由 verify_admin_pwd 判定
--   * 会员卡密码用 sha256(salt + 明文) 存储；NFC 免密凭证 = 当前 pwd_hash
--     用户改密后 pwd_hash 变化，旧 NFC 码自动失效（页面改为只输密码）
-- ============================================================

create extension if not exists pgcrypto;
create sequence if not exists member_card_seq start 1001;
create sequence if not exists gift_order_seq start 1001;

-- ---------- 1. 表结构 ----------
create table if not exists public.member_cards (
    id          bigserial primary key,
    card_no     text not null unique,              -- 会员卡号（对外展示 / NFC）
    login_id    text not null unique,              -- 登录账号（与卡号分离）
    pwd_salt    text not null,
    pwd_hash    text not null,
    nickname    text default '',
    phone       text default '',
    points      numeric(12,2) not null default 0,  -- 积分
    balance     numeric(12,2) not null default 0,  -- 储值余额（元）
    note        text default '',
    status      text not null default 'active',    -- active / disabled
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table if not exists public.member_txns (
    id            bigserial primary key,
    card_id       bigint references public.member_cards(id) on delete cascade,
    card_no       text not null,
    kind          text not null,                    -- create/consume/recharge/points_add/points_sub/redeem/adjust
    amount        numeric(12,2) not null default 0, -- 金额变动（消费为正数，充值/调整为带符号）
    points        numeric(12,2) not null default 0, -- 积分变动（带符号）
    balance_after numeric(12,2) not null default 0,
    points_after  numeric(12,2) not null default 0,
    title         text default '',
    operator      text default '',
    ref_no        text default '',
    created_at    timestamptz not null default now()
);
create index if not exists idx_member_txns_card on public.member_txns(card_no, created_at desc);

create table if not exists public.gifts (
    id          bigserial primary key,
    name        text not null,
    points_cost numeric(12,2) not null default 0,
    stock       integer,
    image_url   text default '',
    active      boolean not null default true,
    sort        integer not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table if not exists public.gift_orders (
    id          bigserial primary key,
    order_no    text not null unique,
    card_id     bigint references public.member_cards(id) on delete set null,
    card_no     text not null,
    login_id    text default '',
    gift_id     bigint,
    gift_name   text not null,
    points_cost numeric(12,2) not null default 0,
    nickname    text default '',
    phone       text default '',
    address     text default '',
    note        text default '',
    status      text not null default 'pending',   -- pending/shipped/done/cancel
    tracking_no text default '',
    created_at  timestamptz not null default now(),
    shipped_at  timestamptz
);
create index if not exists idx_gift_orders_status on public.gift_orders(status, created_at desc);

alter table public.member_cards enable row level security;
alter table public.member_txns  enable row level security;
alter table public.gifts        enable row level security;
alter table public.gift_orders  enable row level security;

drop policy if exists mc_deny_cards  on public.member_cards;
drop policy if exists mc_deny_txns   on public.member_txns;
drop policy if exists mc_deny_gifts  on public.gifts;
drop policy if exists mc_deny_gorder on public.gift_orders;
create policy mc_deny_cards  on public.member_cards  for all using (false) with check (false);
create policy mc_deny_txns   on public.member_txns   for all using (false) with check (false);
create policy mc_deny_gifts  on public.gifts         for all using (false) with check (false);
create policy mc_deny_gorder on public.gift_orders   for all using (false) with check (false);

revoke all on public.member_cards, public.member_txns, public.gifts, public.gift_orders from anon, authenticated;

-- ---------- 2. 内部工具 ----------
create or replace function public.mc_card_json(c public.member_cards)
returns jsonb language sql immutable as $$
    select jsonb_build_object(
        'card_no', c.card_no, 'login_id', c.login_id, 'nickname', c.nickname,
        'phone', c.phone, 'points', c.points, 'balance', c.balance,
        'note', c.note, 'status', c.status,
        'created_at', c.created_at, 'updated_at', c.updated_at);
$$;

create or replace function public.mc_txn_json(t public.member_txns)
returns jsonb language sql immutable as $$
    select jsonb_build_object(
        'id', t.id, 'kind', t.kind, 'amount', t.amount, 'points', t.points,
        'balance_after', t.balance_after, 'points_after', t.points_after,
        'title', t.title, 'operator', t.operator, 'ref_no', t.ref_no,
        'created_at', t.created_at);
$$;

create or replace function public.mc_guard(p_pwd text)
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    if p_pwd is null or not exists (
        select 1 from public.users
        where username = p_pwd and (is_admin = true or is_super_admin = true)
    ) then
        raise exception '无管理员权限';
    end if;
end $$;

-- ---------- 3. 后台 · 会员卡 ----------
create or replace function public.mc_admin_list(p_pwd text, p_kw text default '')
returns setof jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    perform mc_guard(p_pwd);
    return query
        select mc_card_json(c)
        from public.member_cards c
        where coalesce(p_kw, '') = ''
           or c.card_no ilike '%' || p_kw || '%'
           or c.login_id ilike '%' || p_kw || '%'
           or coalesce(c.nickname, '') ilike '%' || p_kw || '%'
           or coalesce(c.phone, '') ilike '%' || p_kw || '%'
        order by c.created_at desc
        limit 500;
end $$;

create or replace function public.mc_admin_card(p_pwd text, p_card_no text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    perform mc_guard(p_pwd);
    select * into v from public.member_cards where card_no = btrim(p_card_no);
    if not found then raise exception '会员卡不存在'; end if;
    return mc_card_json(v) || jsonb_build_object('nfc_hash', v.pwd_hash);
end $$;

create or replace function public.mc_admin_create(
    p_pwd text,
    p_card_no text default null,
    p_login_id text default null,
    p_nickname text default '',
    p_phone text default '',
    p_points numeric default 0,
    p_balance numeric default 0,
    p_note text default '',
    p_init_pwd text default '123456'
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
    v_card text; v_login text; v_salt text; v_hash text; v public.member_cards;
begin
    perform mc_guard(p_pwd);

    v_card := nullif(btrim(coalesce(p_card_no, '')), '');
    if v_card is null then
        v_card := 'BC' || to_char(now(), 'YYMM') || lpad(nextval('member_card_seq')::text, 4, '0');
    end if;
    v_login := nullif(btrim(coalesce(p_login_id, '')), '');
    if v_login is null then v_login := v_card; end if;

    if exists (select 1 from public.member_cards where card_no = v_card) then
        raise exception '会员卡号已存在';
    end if;
    if exists (select 1 from public.member_cards where login_id = v_login) then
        raise exception '登录账号已存在';
    end if;

    v_salt := encode(gen_random_bytes(8), 'hex');
    v_hash := encode(digest(v_salt || coalesce(nullif(p_init_pwd, ''), '123456'), 'sha256'), 'hex');

    insert into public.member_cards
        (card_no, login_id, pwd_salt, pwd_hash, nickname, phone, points, balance, note)
    values
        (v_card, v_login, v_salt, v_hash, coalesce(p_nickname, ''), coalesce(p_phone, ''),
         coalesce(p_points, 0), coalesce(p_balance, 0), coalesce(p_note, ''))
    returning * into v;

    insert into public.member_txns
        (card_id, card_no, kind, amount, points, balance_after, points_after, title, operator)
    values
        (v.id, v.card_no, 'create', 0, v.points, v.balance, v.points,
         case when v.points <> 0 or v.balance <> 0
              then '开卡（初始余额 ¥' || to_char(v.balance, 'FM999999990.00') || '，初始积分 ' || to_char(v.points, 'FM999999990.##') || '）'
              else '开卡' end,
         p_pwd);

    return mc_card_json(v) || jsonb_build_object(
        'init_pwd', coalesce(nullif(p_init_pwd, ''), '123456'),
        'nfc_hash', v.pwd_hash);
end $$;

create or replace function public.mc_admin_update(
    p_pwd text,
    p_card_no text,
    p_login_id text default null,
    p_nickname text default null,
    p_phone text default null,
    p_note text default null,
    p_status text default null
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    perform mc_guard(p_pwd);
    select * into v from public.member_cards where card_no = btrim(p_card_no) for update;
    if not found then raise exception '会员卡不存在'; end if;

    if p_login_id is not null and btrim(p_login_id) <> '' and btrim(p_login_id) <> v.login_id then
        if exists (select 1 from public.member_cards where login_id = btrim(p_login_id) and id <> v.id) then
            raise exception '登录账号已被占用';
        end if;
        v.login_id := btrim(p_login_id);
    end if;
    if p_nickname is not null then v.nickname := p_nickname; end if;
    if p_phone is not null then v.phone := p_phone; end if;
    if p_note is not null then v.note := p_note; end if;
    if p_status is not null and p_status in ('active', 'disabled') then v.status := p_status; end if;

    update public.member_cards
       set login_id = v.login_id, nickname = v.nickname, phone = v.phone,
           note = v.note, status = v.status, updated_at = now()
     where id = v.id
    returning * into v;

    return mc_card_json(v);
end $$;

create or replace function public.mc_admin_delete(p_pwd text, p_card_no text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    perform mc_guard(p_pwd);
    delete from public.member_cards where card_no = btrim(p_card_no) returning * into v;
    if not found then raise exception '会员卡不存在'; end if;
    return jsonb_build_object('ok', true, 'card_no', v.card_no);
end $$;

create or replace function public.mc_admin_reset_pwd(
    p_pwd text, p_card_no text, p_new_pwd text default '123456'
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards; v_salt text; v_hash text;
begin
    perform mc_guard(p_pwd);
    if length(coalesce(p_new_pwd, '')) < 6 then raise exception '密码至少 6 位'; end if;
    select * into v from public.member_cards where card_no = btrim(p_card_no) for update;
    if not found then raise exception '会员卡不存在'; end if;
    v_salt := encode(gen_random_bytes(8), 'hex');
    v_hash := encode(digest(v_salt || p_new_pwd, 'sha256'), 'hex');
    update public.member_cards
       set pwd_salt = v_salt, pwd_hash = v_hash, updated_at = now()
     where id = v.id;
    insert into public.member_txns
        (card_id, card_no, kind, title, operator)
    values (v.id, v.card_no, 'adjust', '管理员重置密码', p_pwd);
    return jsonb_build_object('ok', true, 'card_no', v.card_no, 'init_pwd', p_new_pwd, 'nfc_hash', v_hash);
end $$;

create or replace function public.mc_admin_consume(
    p_pwd text, p_card_no text, p_amount numeric
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards; v_earned numeric;
begin
    perform mc_guard(p_pwd);
    if p_amount is null or p_amount <= 0 then raise exception '消费金额必须大于 0'; end if;

    select * into v from public.member_cards where card_no = btrim(p_card_no) for update;
    if not found then raise exception '会员卡不存在'; end if;
    if v.balance < p_amount then
        raise exception '余额不足：当前 ¥%，本次需 ¥%',
            to_char(v.balance, 'FM999999990.00'), to_char(p_amount, 'FM999999990.00');
    end if;

    v_earned := round(p_amount, 0);   -- 1 元 = 1 积分

    update public.member_cards
       set balance = balance - p_amount,
           points  = points + v_earned,
           updated_at = now()
     where id = v.id
    returning * into v;

    insert into public.member_txns
        (card_id, card_no, kind, amount, points, balance_after, points_after, title, operator)
    values
        (v.id, v.card_no, 'consume', p_amount, v_earned, v.balance, v.points,
         '消费 ¥' || to_char(p_amount, 'FM999999990.00') || '，获积分 ' || to_char(v_earned, 'FM999999990'),
         p_pwd);

    return jsonb_build_object(
        'ok', true, 'card_no', v.card_no,
        'consumed', p_amount, 'earned', v_earned,
        'balance', v.balance, 'points', v.points);
end $$;

create or replace function public.mc_admin_points(
    p_pwd text, p_card_no text, p_delta numeric, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    perform mc_guard(p_pwd);
    if p_delta is null or p_delta = 0 then raise exception '积分变动不能为 0'; end if;

    select * into v from public.member_cards where card_no = btrim(p_card_no) for update;
    if not found then raise exception '会员卡不存在'; end if;
    if v.points + p_delta < 0 then raise exception '积分不足：当前 %，需扣 %', v.points, abs(p_delta); end if;

    update public.member_cards
       set points = points + p_delta, updated_at = now()
     where id = v.id
    returning * into v;

    insert into public.member_txns
        (card_id, card_no, kind, points, balance_after, points_after, title, operator)
    values
        (v.id, v.card_no,
         case when p_delta > 0 then 'points_add' else 'points_sub' end,
         p_delta, v.balance, v.points,
         coalesce(nullif(btrim(p_reason), ''), case when p_delta > 0 then '管理员增加积分' else '管理员扣减积分' end),
         p_pwd);

    return jsonb_build_object('ok', true, 'card_no', v.card_no, 'delta', p_delta, 'points', v.points);
end $$;

create or replace function public.mc_admin_balance(
    p_pwd text, p_card_no text, p_delta numeric, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    perform mc_guard(p_pwd);
    if p_delta is null or p_delta = 0 then raise exception '金额变动不能为 0'; end if;

    select * into v from public.member_cards where card_no = btrim(p_card_no) for update;
    if not found then raise exception '会员卡不存在'; end if;
    if v.balance + p_delta < 0 then raise exception '余额不足：当前 ¥%', to_char(v.balance, 'FM999999990.00'); end if;

    update public.member_cards
       set balance = balance + p_delta, updated_at = now()
     where id = v.id
    returning * into v;

    insert into public.member_txns
        (card_id, card_no, kind, amount, balance_after, points_after, title, operator)
    values
        (v.id, v.card_no, case when p_delta > 0 then 'recharge' else 'adjust' end,
         p_delta, v.balance, v.points,
         coalesce(nullif(btrim(p_reason), ''), case when p_delta > 0 then '充值 / 增加余额' else '扣减余额' end),
         p_pwd);

    return jsonb_build_object('ok', true, 'card_no', v.card_no, 'delta', p_delta, 'balance', v.balance);
end $$;

create or replace function public.mc_admin_txns(
    p_pwd text, p_card_no text, p_limit integer default 100
) returns setof jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    perform mc_guard(p_pwd);
    return query
        select mc_txn_json(t)
        from public.member_txns t
        where t.card_no = btrim(p_card_no)
        order by t.created_at desc, t.id desc
        limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

-- ---------- 4. 前台 · 登录 / 改密 / 明细 ----------
create or replace function public.mc_login(p_login text, p_pwd text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1;
    if not found then raise exception '会员卡不存在，请核对账号'; end if;
    if v.status <> 'active' then raise exception '会员卡已停用，请联系客服'; end if;
    if v.pwd_hash <> encode(digest(v.pwd_salt || coalesce(p_pwd, ''), 'sha256'), 'hex') then
        raise exception '账号或密码错误';
    end if;
    return mc_card_json(v) || jsonb_build_object('auth_hash', v.pwd_hash);
end $$;

create or replace function public.mc_login_hash(p_login text, p_hash text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards;
begin
    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1;
    if not found then raise exception '会员卡不存在'; end if;
    if v.status <> 'active' then raise exception '会员卡已停用，请联系客服'; end if;
    if v.pwd_hash <> lower(btrim(coalesce(p_hash, ''))) then
        raise exception 'NFC 凭证已失效，请输入当前密码';
    end if;
    return mc_card_json(v) || jsonb_build_object('auth_hash', v.pwd_hash);
end $$;

create or replace function public.mc_change_pwd(p_login text, p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v public.member_cards; v_salt text; v_hash text;
begin
    if length(coalesce(p_new, '')) < 6 then raise exception '新密码至少 6 位'; end if;
    if p_new = p_old then raise exception '新密码不能与原密码相同'; end if;

    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1 for update;
    if not found then raise exception '会员卡不存在'; end if;
    if v.pwd_hash <> encode(digest(v.pwd_salt || coalesce(p_old, ''), 'sha256'), 'hex') then
        raise exception '原密码不正确';
    end if;

    v_salt := encode(gen_random_bytes(8), 'hex');
    v_hash := encode(digest(v_salt || p_new, 'sha256'), 'hex');
    update public.member_cards
       set pwd_salt = v_salt, pwd_hash = v_hash, updated_at = now()
     where id = v.id;

    insert into public.member_txns
        (card_id, card_no, kind, title, operator)
    values (v.id, v.card_no, 'adjust', '会员自助修改密码（原 NFC 码失效）', 'self');

    return jsonb_build_object('ok', true, 'card_no', v.card_no, 'auth_hash', v_hash);
end $$;

create or replace function public.mc_my_txns(p_login text, p_hash text, p_limit integer default 100)
returns setof jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
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
        select mc_txn_json(t)
        from public.member_txns t
        where t.card_id = v.id
        order by t.created_at desc, t.id desc
        limit greatest(1, least(coalesce(p_limit, 100), 300));
end $$;

-- ---------- 5. 礼品（前台） ----------
create or replace function public.mc_gift_list()
returns setof jsonb language sql security definer set search_path = public, extensions, pg_temp as $$
    select jsonb_build_object(
        'id', g.id, 'name', g.name, 'points_cost', g.points_cost,
        'stock', g.stock, 'image_url', g.image_url, 'sort', g.sort,
        'sold_out', (g.stock is not null and g.stock <= 0))
    from public.gifts g
    where g.active = true
    order by g.sort asc, g.id asc;
$$;

create or replace function public.mc_redeem(
    p_login text, p_hash text, p_gift_id bigint,
    p_nickname text, p_phone text, p_address text, p_note text default ''
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
    v public.member_cards; g public.gifts;
    v_order_no text; v_order public.gift_orders;
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
        raise exception '积分不足：当前 % 分，兑换需 % 分', to_char(v.points, 'FM999999990.##'), to_char(g.points_cost, 'FM999999990.##');
    end if;
    if coalesce(btrim(p_nickname), '') = '' or coalesce(btrim(p_phone), '') = '' or coalesce(btrim(p_address), '') = '' then
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

    insert into public.member_txns
        (card_id, card_no, kind, points, balance_after, points_after, title, operator, ref_no)
    values
        (v.id, v.card_no, 'redeem', -g.points_cost, v.balance, v.points,
         '兑换礼品：' || g.name || '（' || to_char(g.points_cost, 'FM999999990.##') || ' 积分）',
         'self', v_order_no);

    return jsonb_build_object(
        'ok', true, 'order_no', v_order_no, 'gift_name', g.name,
        'points_cost', g.points_cost, 'points', v.points, 'card_no', v.card_no);
end $$;

-- ---------- 6. 后台 · 礼品 ----------
create or replace function public.gift_admin_list(p_pwd text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    perform mc_guard(p_pwd);
    return query
        select jsonb_build_object(
            'id', g.id, 'name', g.name, 'points_cost', g.points_cost,
            'stock', g.stock, 'image_url', g.image_url, 'active', g.active,
            'sort', g.sort, 'created_at', g.created_at)
        from public.gifts g
        order by g.sort asc, g.id desc;
end $$;

create or replace function public.gift_admin_save(
    p_pwd text, p_id bigint, p_name text, p_points numeric,
    p_stock integer default null, p_active boolean default true,
    p_image text default '', p_sort integer default 0
) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g public.gifts;
begin
    perform mc_guard(p_pwd);
    if coalesce(btrim(p_name), '') = '' then raise exception '礼品名称不能为空'; end if;
    if p_points is null or p_points < 0 then raise exception '所需积分不能为负'; end if;

    if p_id is null then
        insert into public.gifts(name, points_cost, stock, active, image_url, sort)
        values (btrim(p_name), p_points, p_stock, coalesce(p_active, true), coalesce(p_image, ''), coalesce(p_sort, 0))
        returning * into g;
    else
        update public.gifts
           set name = btrim(p_name), points_cost = p_points, stock = p_stock,
               active = coalesce(p_active, true), image_url = coalesce(p_image, ''),
               sort = coalesce(p_sort, 0), updated_at = now()
         where id = p_id
        returning * into g;
        if not found then raise exception '礼品不存在'; end if;
    end if;

    return jsonb_build_object('ok', true, 'id', g.id, 'name', g.name);
end $$;

create or replace function public.gift_admin_delete(p_pwd text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    perform mc_guard(p_pwd);
    delete from public.gifts where id = p_id;
    if not found then raise exception '礼品不存在'; end if;
    return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- ---------- 7. 后台 · 兑换订单 ----------
create or replace function public.gift_admin_orders(p_pwd text, p_status text default '')
returns setof jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
    perform mc_guard(p_pwd);
    return query
        select jsonb_build_object(
            'id', o.id, 'order_no', o.order_no, 'card_no', o.card_no,
            'login_id', o.login_id, 'gift_name', o.gift_name, 'points_cost', o.points_cost,
            'nickname', o.nickname, 'phone', o.phone, 'address', o.address, 'note', o.note,
            'status', o.status, 'tracking_no', o.tracking_no,
            'created_at', o.created_at, 'shipped_at', o.shipped_at)
        from public.gift_orders o
        where coalesce(p_status, '') = '' or o.status = p_status
        order by o.created_at desc
        limit 500;
end $$;

create or replace function public.gift_admin_ship(p_pwd text, p_id bigint, p_tracking text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare o public.gift_orders;
begin
    perform mc_guard(p_pwd);
    update public.gift_orders
       set status = 'shipped', tracking_no = coalesce(btrim(p_tracking), ''),
           shipped_at = now()
     where id = p_id
    returning * into o;
    if not found then raise exception '兑换订单不存在'; end if;
    return jsonb_build_object('ok', true, 'id', o.id, 'order_no', o.order_no, 'status', o.status);
end $$;

create or replace function public.gift_admin_status(p_pwd text, p_id bigint, p_status text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare o public.gift_orders;
begin
    perform mc_guard(p_pwd);
    if p_status not in ('pending', 'shipped', 'done', 'cancel') then raise exception '状态值不合法'; end if;
    update public.gift_orders set status = p_status where id = p_id returning * into o;
    if not found then raise exception '兑换订单不存在'; end if;
    return jsonb_build_object('ok', true, 'id', o.id, 'status', o.status);
end $$;

-- ---------- 8. 授权 ----------
grant execute on function public.mc_login(text, text) to anon, authenticated;
grant execute on function public.mc_login_hash(text, text) to anon, authenticated;
grant execute on function public.mc_change_pwd(text, text, text) to anon, authenticated;
grant execute on function public.mc_my_txns(text, text, integer) to anon, authenticated;
grant execute on function public.mc_gift_list() to anon, authenticated;
grant execute on function public.mc_redeem(text, text, bigint, text, text, text, text) to anon, authenticated;
grant execute on function public.mc_admin_list(text, text) to anon, authenticated;
grant execute on function public.mc_admin_card(text, text) to anon, authenticated;
grant execute on function public.mc_admin_create(text, text, text, text, text, numeric, numeric, text, text) to anon, authenticated;
grant execute on function public.mc_admin_update(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.mc_admin_delete(text, text) to anon, authenticated;
grant execute on function public.mc_admin_reset_pwd(text, text, text) to anon, authenticated;
grant execute on function public.mc_admin_consume(text, text, numeric) to anon, authenticated;
grant execute on function public.mc_admin_points(text, text, numeric, text) to anon, authenticated;
grant execute on function public.mc_admin_balance(text, text, numeric, text) to anon, authenticated;
grant execute on function public.mc_admin_txns(text, text, integer) to anon, authenticated;
grant execute on function public.gift_admin_list(text) to anon, authenticated;
grant execute on function public.gift_admin_save(text, bigint, text, numeric, integer, boolean, text, integer) to anon, authenticated;
grant execute on function public.gift_admin_delete(text, bigint) to anon, authenticated;
grant execute on function public.gift_admin_orders(text, text) to anon, authenticated;
grant execute on function public.gift_admin_ship(text, bigint, text) to anon, authenticated;
grant execute on function public.gift_admin_status(text, bigint, text) to anon, authenticated;

-- ---------- 9. 示例礼品（已存在则跳过） ----------
insert into public.gifts(name, points_cost, stock, active, sort)
select '白桦纪念徽章（示例，可编辑）', 100, null, true, 10
where not exists (select 1 from public.gifts);
