-- ============================================================
-- 订单撤回修复 v1（2026-11-11）
-- 问题：已发货订单点「撤回待处理」后，会员卡兑换单（member_card_no 非空、
--       已有运单号）会被 update_order 里的「填了运单号即发货」逻辑立刻改回
--       shipped，看起来就是“怎么都退回不了待处理”。
-- 修复：1) p_status='pending' 时不再自动转 shipped，并清空 shipped_at；
--       2) 兑换单同步回 gift_orders 的待处理状态；
--       3) 新增语义明确的 recall_order(p_id, p_pwd) 供后台调用。
-- 可重复执行。
-- ============================================================

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
begin
    if p_pwd is not null and not verify_admin_pwd(p_pwd) then return false; end if;

    update public.orders set
        status = coalesce(p_status, status),
        tracking_no = coalesce(p_tracking_no, tracking_no),
        anti_code = coalesce(p_anti_code, anti_code),
        product_name = coalesce(p_product_name, product_name),
        note = coalesce(p_note, note),
        order_no = coalesce(nullif(p_order_no, ''), order_no),
        shipped_at = case
            when coalesce(p_status, '') = 'pending' then null
            when p_status = 'shipped' and coalesce(status, '') <> 'shipped' then now()
            else shipped_at
        end
     where id = p_id
    returning * into v;

    if not found then
        return false;
    end if;

    -- 只有会员卡兑换单才有 member_card_no
    if coalesce(v.member_card_no, '') <> '' then
        if coalesce(p_status, '') = 'pending' then
            -- 撤回待处理：兑换单同步回退，避免会员卡界面仍显示“已发货”
            update public.gift_orders as g
               set status = 'pending', shipped_at = null
              from public.orders as o
             where o.id = v.id
               and ((o.gift_order_id is not null and g.id = o.gift_order_id)
                    or (g.order_no = o.order_no and coalesce(o.order_no, '') <> ''));
        else
            -- 填了运单号即视为发货（仅限非撤回的更新）
            if coalesce(v.tracking_no, '') <> '' and coalesce(v.status, '') = 'pending' then
                update public.orders set status = 'shipped', shipped_at = now()
                 where id = v.id
                returning * into v;
            end if;

            if coalesce(v.status, '') = 'shipped' then
                v_body := '你的兑换「' || coalesce(v.product_name, '礼品') || '」'
                       || case when coalesce(v.tracking_no, '') <> ''
                               then '已发货，运单号：' || v.tracking_no
                               else '已更新物流信息' end
                       || '。可在此页面「物流提醒」查看。';
                perform public.mc_push_mail('birch_mail_card_' || v.member_card_no,
                                            '物流提醒 · ' || v.order_no, v_body);
                update public.gift_orders as g
                   set status = 'shipped',
                       tracking_no = v.tracking_no,
                       shipped_at = now()
                  from public.orders as o
                 where o.id = v.id
                   and ((o.gift_order_id is not null and g.id = o.gift_order_id)
                        or (g.order_no = o.order_no and coalesce(o.order_no, '') <> ''));
            end if;
        end if;
    end if;

    return true;
end $$;

-- 撤回已发货订单：状态回待处理、清空发货时间，兑换单同步回退
create or replace function public.recall_order(p_id bigint, p_pwd text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v public.orders;
begin
    if not verify_admin_pwd(p_pwd) then return false; end if;

    update public.orders
       set status = 'pending', shipped_at = null
     where id = p_id
    returning * into v;

    if not found then
        return false;
    end if;

    if coalesce(v.member_card_no, '') <> '' then
        update public.gift_orders as g
           set status = 'pending', shipped_at = null
          from public.orders as o
         where o.id = v.id
           and ((o.gift_order_id is not null and g.id = o.gift_order_id)
                or (g.order_no = o.order_no and coalesce(o.order_no, '') <> ''));
    end if;

    return true;
end $$;

grant execute on function public.recall_order(bigint, text) to anon, authenticated;
