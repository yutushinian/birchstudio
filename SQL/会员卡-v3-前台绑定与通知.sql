-- ============================================================
-- 会员卡（三）：前台自助绑定账号 + 通知投递归位
-- 幂等：可重复执行
--  1) mc_self_bind：会员在前台用「会员卡 + 密码」自助绑定/解绑网站账号，
--     可选把会员卡号改成该账号的手机号（级联 txns / gift_orders / orders）
--  2) update_order：会员卡兑换单发货只写「本卡物流」，不再往任何账号信箱写；
--     绑定账号的站内信统一由前端 pushMail(…, username) 发，username 为空时不发
-- ============================================================

-- ========== 1. 前台自助绑定 ==========
create or replace function public.mc_self_bind(
    p_login text, p_hash text, p_username text, p_to_phone boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare
    v public.member_cards;
    u public.users;
    v_user text;
    v_new text;
begin
    select * into v from public.member_cards
     where login_id = btrim(p_login) or card_no = btrim(p_login)
     limit 1 for update;
    if not found then
        raise exception '会员卡不存在';
    end if;
    if v.status <> 'active' then
        raise exception '会员卡已停用，请联系客服';
    end if;
    if v.pwd_hash <> lower(btrim(coalesce(p_hash, ''))) then
        raise exception '登录已过期，请重新输入密码';
    end if;

    v_user := btrim(coalesce(p_username, ''));
    v_new := v.card_no;
    if v_user <> '' then
        -- 先按用户名找，找不到再按手机号找
        select * into u from public.users where username = v_user limit 1;
        if not found then
            select * into u from public.users
             where coalesce(btrim(phone), '') <> '' and btrim(phone) = v_user
             limit 1;
        end if;
        if not found then
            raise exception '账号不存在，请核对用户名或手机号';
        end if;
        v_user := u.username;
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
       set bind_username = v_user,
           card_no = v_new,
           updated_at = now()
     where id = v.id;

    if v_new <> v.card_no then
        update public.member_txns set card_no = v_new where card_id = v.id;
        update public.gift_orders set card_no = v_new where card_id = v.id;
        update public.orders set member_card_no = v_new where member_card_no = v.card_no;
    end if;

    return jsonb_build_object(
        'ok', true,
        'card_no', v_new,
        'old_card_no', v.card_no,
        'bind_username', v_user,
        'auth_hash', v.pwd_hash);
end $$;

revoke all on function public.mc_self_bind(text, text, text, boolean) from public;
grant execute on function public.mc_self_bind(text, text, text, boolean) to anon, authenticated;

-- ========== 2. 发货通知：只写本卡物流，不碰任何账号信箱 ==========
-- 说明：原实现已经在写 birch_mail_card_<卡号>，但前端「完成订单」在订单没有
--      username 时调用了 pushMail(title, body)（不带收件人），该函数会退回写
--      管理员自己的信箱。这里把注释与行为写清楚，并保证 gift_orders 同步；
--      不再新增任何「兜底写管理员信箱」的分支。
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
        -- 填了运单号即视为发货（普通商品订单仍按原两步流程）
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
                   || '。可在会员卡「物流提醒」查看。';
            -- 只写这张会员卡自己的物流提醒（未绑定账号也能看到）
            -- 绑定账号的站内信由前端按 orders.username 发送；username 为空时前端不发
            perform public.mc_push_mail('birch_mail_card_' || v.member_card_no,
                                        '物流提醒 · ' || v.order_no, v_body);
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

grant execute on function public.update_order(bigint, text, text, text, text, text, text, text)
  to anon, authenticated;

-- ========== 3. 清理历史上误投到管理员信箱的会员卡发货提醒 ==========
-- 只删「标题以 订单已完成 · M 开头」且「正文含 兑换」的条目，避免误删普通消息
do $$
declare
    r record;
    v_arr jsonb;
    v_new jsonb;
begin
    for r in select key, data from public.app_data where key like 'birch_mail_%' loop
        v_arr := r.data;
        if v_arr is null or jsonb_typeof(v_arr) <> 'array' then
            continue;
        end if;
        select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into v_new
          from jsonb_array_elements(v_arr) with ordinality as t(e, ord)
         where not (
             coalesce(e->>'title', '') like '订单已完成 · M%'
             and coalesce(e->>'body', '') like '%兑换%');
        if v_new is distinct from v_arr then
            update public.app_data set data = v_new, updated_at = now() where key = r.key;
        end if;
    end loop;
end $$;

-- ========== 4. 绑定账号的站内信也由服务端发（按“当前绑定”，不依赖订单快照） ==========
-- 说明：mc_redeem 下单时会把当时的 bind_username 写进 orders.username；
--       如果会员是下单后才绑定账号，订单里的 username 仍是空的，前端就不会通知。
--       这里发货时实时查 member_cards.bind_username，保证“现在绑了谁就通知谁”。
--       未绑定时 v_bind 为空，不写任何账号信箱。
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
    v_body_user text;
    v_is_shipped boolean;
    v_bind text;
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

    if coalesce(v.member_card_no, '') <> '' then
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
            v_body_user := '你的兑换「' || coalesce(v.product_name, '礼品') || '」'
                   || case when coalesce(v.tracking_no, '') <> ''
                           then '已发货，运单号：' || v.tracking_no
                           else '已更新物流信息' end
                   || '。可在「我的订单」查看。';

            -- 1) 这张会员卡自己的物流提醒（未绑定也能看到）
            perform public.mc_push_mail('birch_mail_card_' || v.member_card_no,
                                        '物流提醒 · ' || v.order_no, v_body);

            -- 2) 绑定了账号才通知该账号；没绑定就什么都不写
            select coalesce(bind_username, '') into v_bind
              from public.member_cards
             where card_no = v.member_card_no
             limit 1;
            if coalesce(v_bind, '') <> '' then
                perform public.mc_push_mail('birch_mail_' || v_bind,
                                            '已发货 · ' || v.order_no, v_body_user);
            end if;

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

grant execute on function public.update_order(bigint, text, text, text, text, text, text, text)
  to anon, authenticated;
