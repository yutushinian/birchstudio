-- ============================================================
-- 会员卡（四）：NFC 短码（≤ 50 bit）
-- 幂等：可重复执行
--  1) member_cards.nfc_code：9 位 Crockford Base32 = 45 bit
--     URL 由 https://birchstudio.cn/#mc=T01&k=<64hex>（约 100 字节）
--     缩到 https://birchstudio.cn/#c=<9位>（35 字节）
--     NDEF 双记录（URI + Text）合计约 82 字节，NTAG213 也能装下
--  2) mc_nfc_code：管理员为某张卡生成/查看短码
--  3) mc_nfc_open：刷卡后凭短码换回会员卡信息（返回 auth_hash 供后续操作）
--  4) 改密 / 重置密码时清空短码，与「改密后旧 NFC 码失效」的既有语义一致
-- ============================================================

-- ========== 1. 字段与索引 ==========
alter table public.member_cards
    add column if not exists nfc_code text not null default '';

create unique index if not exists member_cards_nfc_code_uidx
    on public.member_cards (nfc_code)
    where nfc_code <> '';

comment on column public.member_cards.nfc_code is 'NFC 短码：9 位 Base32（45 bit），唯一；空表示未生成';

-- ========== 2. 生成 / 查看短码 ==========
create or replace function public.mc_nfc_code(p_pwd text, p_card_no text)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare
    v public.member_cards;
    v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';  -- 去掉 0 O 1 I，共 32 个
    v_code text;
    v_bytes bytea;
    v_i int;
    v_try int := 0;
begin
    perform public.mc_guard(p_pwd);

    select * into v from public.member_cards
     where card_no = btrim(p_card_no)
     limit 1 for update;
    if not found then
        raise exception '会员卡不存在';
    end if;

    if coalesce(v.nfc_code, '') <> '' then
        return jsonb_build_object('card_no', v.card_no, 'nfc_code', v.nfc_code,
                                  'code_len', length(v.nfc_code), 'created', false);
    end if;

    loop
        v_try := v_try + 1;
        v_bytes := extensions.gen_random_bytes(9);
        v_code := '';
        for v_i in 0..8 loop
            -- 每个随机字节 % 32 完全均匀（256 是 32 的整数倍）
            v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_i) % 32) + 1, 1);
        end loop;
        exit when not exists (
            select 1 from public.member_cards
             where nfc_code = v_code and id <> v.id
        );
        if v_try >= 30 then
            raise exception '短码生成失败，请重试';
        end if;
    end loop;

    update public.member_cards
       set nfc_code = v_code, updated_at = now()
     where id = v.id;

    return jsonb_build_object('card_no', v.card_no, 'nfc_code', v_code,
                              'code_len', length(v_code), 'created', true);
end $$;

revoke all on function public.mc_nfc_code(text, text) from public;
grant execute on function public.mc_nfc_code(text, text) to anon, authenticated;

-- ========== 3. 凭短码打开会员卡 ==========
create or replace function public.mc_nfc_open(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare v public.member_cards;
begin
    if length(btrim(coalesce(p_code, ''))) < 6 then
        raise exception 'NFC 码不完整';
    end if;

    select * into v from public.member_cards
     where nfc_code <> '' and upper(nfc_code) = upper(btrim(p_code))
     limit 1;
    if not found then
        raise exception 'NFC 码无效或已失效，请重新生成';
    end if;
    if v.status <> 'active' then
        raise exception '会员卡已停用，请联系客服';
    end if;

    return public.mc_card_json(v) || jsonb_build_object('auth_hash', v.pwd_hash);
end $$;

revoke all on function public.mc_nfc_open(text) from public;
grant execute on function public.mc_nfc_open(text) to anon, authenticated;

-- ========== 4. 后台卡片详情带上短码 ==========
create or replace function public.mc_admin_card(p_pwd text, p_card_no text)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare v public.member_cards;
begin
    perform public.mc_guard(p_pwd);
    select * into v from public.member_cards where card_no = btrim(p_card_no);
    if not found then raise exception '会员卡不存在'; end if;
    return public.mc_card_json(v) || jsonb_build_object(
        'nfc_hash', v.pwd_hash,
        'nfc_code', coalesce(v.nfc_code, '')
    );
end $$;

-- ========== 5. 改密 / 重置：清空短码 ==========
create or replace function public.mc_change_pwd(p_login text, p_old text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
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
       set pwd_salt = v_salt, pwd_hash = v_hash, nfc_code = '', updated_at = now()
     where id = v.id;

    insert into public.member_txns
        (card_id, card_no, kind, title, operator)
    values (v.id, v.card_no, 'adjust', '会员自助修改密码（原 NFC 码失效）', 'self');

    return jsonb_build_object('ok', true, 'card_no', v.card_no, 'auth_hash', v_hash);
end $$;

create or replace function public.mc_admin_reset_pwd(p_pwd text, p_card_no text, p_new_pwd text default '123456')
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare v public.member_cards; v_salt text; v_hash text;
begin
    perform public.mc_guard(p_pwd);
    if length(coalesce(p_new_pwd, '')) < 6 then raise exception '密码至少 6 位'; end if;
    select * into v from public.member_cards where card_no = btrim(p_card_no) for update;
    if not found then raise exception '会员卡不存在'; end if;
    v_salt := encode(gen_random_bytes(8), 'hex');
    v_hash := encode(digest(v_salt || p_new_pwd, 'sha256'), 'hex');
    update public.member_cards
       set pwd_salt = v_salt, pwd_hash = v_hash, nfc_code = '', updated_at = now()
     where id = v.id;
    insert into public.member_txns
        (card_id, card_no, kind, title, operator)
    values (v.id, v.card_no, 'adjust', '管理员重置密码', p_pwd);
    return jsonb_build_object('ok', true, 'card_no', v.card_no,
                              'init_pwd', p_new_pwd, 'nfc_hash', v_hash);
end $$;

notify pgrst, 'reload schema';
