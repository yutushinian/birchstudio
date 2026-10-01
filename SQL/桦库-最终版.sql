-- 桦库 · 最终版数据库脚本（一次执行 · 幂等）
-- 项目：cplyzukenqxdwhfivlqx（Supabase → SQL Editor 整段执行）
-- 内容：① 桦库主结构（11 张表 + 全部函数）② 授权分享/弹幕库 ③ 验证次数 ④ 转盘按码开关与一次抽奖 ⑤ AI 配额 ⑥ 安全加固（XSS 清洗、晒单收紧）
-- 说明：不含任何密钥（已用占位符）；密钥与邮件/AI 配置见同目录“含密钥-…”文件。
-- 注意：本脚本会 DROP 并重建同名函数（不删数据），可重复执行。

-- ======================================================================
-- 第 1 部分：桦库主结构
-- ======================================================================

-- ============================================================
-- 白桦定制 · 数据库完整部署 SQL（完整版·一次运行）
-- 版本：v2026-08-30-完整版
-- 内容：11 张表 + 58 个函数 + 种子数据（已移除历史遗留 admin_settings 密码表）
--   1) 账号制鉴权：verify_admin_pwd 按「管理员用户名」校验（p_pwd 传管理员账号用户名）
--   2) 订单绑定多账号：bind_record_account 把订单加入 birch_order_bind 可见账号列表，
--      不覆盖原客户订单（原客户订单不消失）；get_my_orders 按 手机号/订单username/绑定映射 三路查询
--   3) 信箱：clear_own_mail 清空自己信箱；pushMail 写 birch_mail_<用户名>
--   4) gallery 画廊 + 邮箱订阅 + 水晶库 + 转盘 + 图片传输 + AI 用量统计
-- 使用：全选复制 → Supabase SQL Editor → 新建查询 → Run（幂等，可反复执行）
-- ============================================================

-- 0. 先自动清理所有旧函数（无论参数签名是否不同，保证全新部署不冲突）
DO $$
DECLARE
    func RECORD;
BEGIN
    FOR func IN 
        SELECT proname, pg_get_function_identity_arguments(pg_proc.oid) as args
        FROM pg_catalog.pg_proc AS pg_proc
        WHERE proname IN (
            'verify_admin_pwd','insert_record','batch_insert_records',
            'clear_all_records','delete_records','soft_delete_records',
            'restore_records','get_recycle_bin','purge_recycle_bin_one',
            'clear_recycle_bin','add_verify_history',
            'get_app_data','set_app_data','delete_app_data',
            'add_gallery_item','update_gallery_item','delete_gallery_item',
            'update_record','get_brand_text','get_contact','get_app_text',
            'subscribe_email','get_subscribers',
            'add_crystal','update_crystal','get_ai_config','delete_crystal',
            'submit_order','get_my_orders','list_orders','update_order','delete_order','purge_old_orders',
            'get_user_is_admin','get_user_is_super_admin','set_user_admin',
            'get_ai_usage_count','consume_ai_usage',
            'register_user','get_user_auth','touch_login','touch_active',
            'change_user_nickname','change_user_phone',
            'list_users','delete_user','reset_user_pwd','get_user_email',
            'get_order_by_tracking','get_my_spin','save_spin','consume_spins','change_user_pwd',
            'put_img_transfer','take_img_transfer',
            'bind_record_account','get_record_bind_account','clear_own_mail'
        )
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %I(%s) CASCADE', func.proname, func.args);
    END LOOP;
END $$;

-- 1. 创建主数据表（防伪记录）
CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    product_name TEXT,
    batch_no TEXT,
    message TEXT,
    export_msg BOOLEAN DEFAULT FALSE,
    create_time TEXT,
    create_timestamp BIGINT,
    verify_count INTEGER DEFAULT 0,
    verify_history JSONB DEFAULT '[]'::JSONB
);
ALTER TABLE records ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS export_name BOOLEAN DEFAULT TRUE;
ALTER TABLE records ADD COLUMN IF NOT EXISTS export_batch BOOLEAN DEFAULT TRUE;

-- 2. 创建回收站表
CREATE TABLE IF NOT EXISTS recycle_bin (
    id TEXT PRIMARY KEY,
    product_name TEXT,
    batch_no TEXT,
    message TEXT,
    export_msg BOOLEAN DEFAULT FALSE,
    create_time TEXT,
    create_timestamp BIGINT,
    verify_count INTEGER DEFAULT 0,
    verify_history JSONB DEFAULT '[]'::JSONB,
    deleted_at TEXT
);
ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS export_name BOOLEAN DEFAULT TRUE;
ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS export_batch BOOLEAN DEFAULT TRUE;

-- 3. 创建存档/应用数据表（用于自动存档）
CREATE TABLE IF NOT EXISTS app_data (
    key TEXT PRIMARY KEY,
    data JSONB DEFAULT '[]'::JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 行级安全策略 (RLS)
-- ============================================================
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE recycle_bin ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;

-- 允许任何人查询防伪记录（验证页面需要）
DROP POLICY IF EXISTS "allow_anonymous_select_records" ON records;
CREATE POLICY "allow_anonymous_select_records" ON records
    FOR SELECT USING (TRUE);

-- 其他表禁止直接访问，仅通过 RPC 操作
DROP POLICY IF EXISTS "deny_all_recycle_bin" ON recycle_bin;
CREATE POLICY "deny_all_recycle_bin" ON recycle_bin
    FOR ALL USING (FALSE);

DROP POLICY IF EXISTS "deny_all_app_data" ON app_data;
CREATE POLICY "deny_all_app_data" ON app_data
    FOR ALL USING (FALSE);

-- 首页加载语录默认内容（仅首次部署时写入；后台保存后以云端为准）
-- 注意：data 为 JSON 字符串，\n 是 JSON 换行转义，入库后为真实换行，请勿改成字面 \n
INSERT INTO app_data (key, data, updated_at)
VALUES ('birch_quotes', '"白桦，是纯洁与坚强的象征.\n因其挺拔不屈，象征坚韧与希望。\n我们结合五行之道，追寻天人合一、阴阳平衡。\n愿每一件水晶，传递善与希望。"', NOW())
ON CONFLICT (key) DO NOTHING;
-- 云端若已存在旧值（含字面 \n 导致前端显示成一坨），用正确格式覆盖（幂等，可反复执行）
UPDATE app_data
SET data = '"白桦，是纯洁与坚强的象征.\n因其挺拔不屈，象征坚韧与希望。\n我们结合五行之道，追寻天人合一、阴阳平衡。\n愿每一件水晶，传递善与希望。"',
    updated_at = NOW()
WHERE key = 'birch_quotes';

-- ============================================================
-- 核心函数：管理员验证（账号制）
-- ============================================================
-- 账号制鉴权：pwd 参数实为前端传入的【账号用户名】，
-- 只要该账号是 管理员(is_admin) 或 终端管理员(is_super_admin) 即通过。
CREATE OR REPLACE FUNCTION verify_admin_pwd(pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users
        WHERE username = pwd AND (is_admin = TRUE OR is_super_admin = TRUE)
    );
END;
$func$;

-- ============================================================
-- 函数：单条插入防伪记录
-- ============================================================
CREATE OR REPLACE FUNCTION insert_record(
    p_pwd TEXT,
    p_id TEXT,
    p_product_name TEXT,
    p_batch_no TEXT,
    p_message TEXT,
    p_export_msg BOOLEAN,
    p_create_time TEXT,
    p_create_timestamp BIGINT,
    p_verify_count INTEGER,
    p_verify_history JSONB,
    p_image_url TEXT DEFAULT NULL,
    p_export_name BOOLEAN DEFAULT TRUE,
    p_export_batch BOOLEAN DEFAULT TRUE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    INSERT INTO records (id, product_name, batch_no, message, export_msg, create_time, create_timestamp, verify_count, verify_history, image_url, export_name, export_batch)
    VALUES (p_id, p_product_name, p_batch_no, p_message, p_export_msg, p_create_time, p_create_timestamp, COALESCE(p_verify_count, 0), COALESCE(p_verify_history, '[]'::JSONB), p_image_url, p_export_name, p_export_batch);
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：批量插入/覆盖防伪记录
-- 前端传入 JSONB 数组，字段名为 camelCase
-- ============================================================
CREATE OR REPLACE FUNCTION batch_insert_records(
    p_records JSONB,
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    rec JSONB;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;

    FOR rec IN SELECT * FROM JSONB_ARRAY_ELEMENTS(p_records)
    LOOP
        INSERT INTO records (id, product_name, batch_no, message, export_msg, create_time, create_timestamp, verify_count, verify_history, image_url, export_name, export_batch)
        VALUES (
            rec ->> 'id',
            rec ->> 'productName',
            rec ->> 'batchNo',
            rec ->> 'message',
            COALESCE((rec ->> 'exportMsg')::BOOLEAN, FALSE),
            rec ->> 'createTime',
            (rec ->> 'createTimestamp')::BIGINT,
            COALESCE((rec ->> 'verifyCount')::INTEGER, 0),
            COALESCE(rec -> 'verifyHistory', '[]'::JSONB),
            NULLIF(rec ->> 'imageUrl', ''),
            COALESCE((rec ->> 'exportName')::BOOLEAN, TRUE),
            COALESCE((rec ->> 'exportBatch')::BOOLEAN, TRUE)
        )
        ON CONFLICT (id) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            batch_no = EXCLUDED.batch_no,
            message = EXCLUDED.message,
            export_msg = EXCLUDED.export_msg,
            create_time = EXCLUDED.create_time,
            create_timestamp = EXCLUDED.create_timestamp,
            verify_count = EXCLUDED.verify_count,
            verify_history = EXCLUDED.verify_history,
            image_url = EXCLUDED.image_url,
            export_name = EXCLUDED.export_name,
            export_batch = EXCLUDED.export_batch;
    END LOOP;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：清空全部防伪记录
-- ============================================================
CREATE OR REPLACE FUNCTION clear_all_records(p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM records;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：按 ID 数组删除记录（硬删除，用于存档恢复时清空现有数据）
-- ============================================================
CREATE OR REPLACE FUNCTION delete_records(
    p_ids TEXT[],
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM records WHERE id = ANY(p_ids);
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：软删除（移入回收站）
-- ============================================================
CREATE OR REPLACE FUNCTION soft_delete_records(
    p_ids TEXT[],
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    rec RECORD;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;

    FOR rec IN SELECT * FROM records WHERE id = ANY(p_ids)
    LOOP
        INSERT INTO recycle_bin (id, product_name, batch_no, message, export_msg, create_time, create_timestamp, verify_count, verify_history, image_url, export_name, export_batch, deleted_at)
        VALUES (rec.id, rec.product_name, rec.batch_no, rec.message, rec.export_msg, rec.create_time, rec.create_timestamp, rec.verify_count, rec.verify_history, rec.image_url, rec.export_name, rec.export_batch, NOW()::TEXT)
        ON CONFLICT (id) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            batch_no = EXCLUDED.batch_no,
            message = EXCLUDED.message,
            export_msg = EXCLUDED.export_msg,
            create_time = EXCLUDED.create_time,
            create_timestamp = EXCLUDED.create_timestamp,
            verify_count = EXCLUDED.verify_count,
            verify_history = EXCLUDED.verify_history,
            image_url = EXCLUDED.image_url,
            export_name = EXCLUDED.export_name,
            export_batch = EXCLUDED.export_batch,
            deleted_at = EXCLUDED.deleted_at;
    END LOOP;

    DELETE FROM records WHERE id = ANY(p_ids);
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：从回收站恢复记录
-- ============================================================
CREATE OR REPLACE FUNCTION restore_records(
    p_ids TEXT[],
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    rec RECORD;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;

    FOR rec IN SELECT * FROM recycle_bin WHERE id = ANY(p_ids)
    LOOP
        INSERT INTO records (id, product_name, batch_no, message, export_msg, create_time, create_timestamp, verify_count, verify_history, image_url, export_name, export_batch)
        VALUES (rec.id, rec.product_name, rec.batch_no, rec.message, rec.export_msg, rec.create_time, rec.create_timestamp, rec.verify_count, rec.verify_history, rec.image_url, rec.export_name, rec.export_batch)
        ON CONFLICT (id) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            batch_no = EXCLUDED.batch_no,
            message = EXCLUDED.message,
            export_msg = EXCLUDED.export_msg,
            create_time = EXCLUDED.create_time,
            create_timestamp = EXCLUDED.create_timestamp,
            verify_count = EXCLUDED.verify_count,
            verify_history = EXCLUDED.verify_history,
            image_url = EXCLUDED.image_url,
            export_name = EXCLUDED.export_name,
            export_batch = EXCLUDED.export_batch;
    END LOOP;

    DELETE FROM recycle_bin WHERE id = ANY(p_ids);
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：获取回收站列表
-- ============================================================
CREATE OR REPLACE FUNCTION get_recycle_bin(p_pwd TEXT)
RETURNS SETOF recycle_bin
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN;
    END IF;
    RETURN QUERY SELECT * FROM recycle_bin ORDER BY deleted_at DESC;
END;
$func$;

-- ============================================================
-- 函数：彻底删除单条回收站记录
-- ============================================================
CREATE OR REPLACE FUNCTION purge_recycle_bin_one(
    p_id TEXT,
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM recycle_bin WHERE id = p_id;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：清空回收站
-- ============================================================
CREATE OR REPLACE FUNCTION clear_recycle_bin(p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM recycle_bin;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：添加验证历史（查询次数+1）
-- ============================================================
CREATE OR REPLACE FUNCTION add_verify_history(
    p_id TEXT,
    p_entry JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    UPDATE records
    SET verify_count = COALESCE(verify_count, 0) + 1,
        verify_history = COALESCE(verify_history, '[]'::JSONB) || p_entry
    WHERE id = p_id;
END;
$func$;

-- ============================================================
-- 函数：读取应用存档数据（需管理员密码）
-- ============================================================
CREATE OR REPLACE FUNCTION get_app_data(p_key TEXT, p_pwd TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    result JSONB;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN '[]'::JSONB;
    END IF;
    SELECT data INTO result FROM app_data WHERE key = p_key;
    RETURN COALESCE(result, '[]'::JSONB);
END;
$func$;

-- ============================================================
-- 函数：写入应用存档数据（需管理员密码）
-- ============================================================
CREATE OR REPLACE FUNCTION set_app_data(
    p_key TEXT,
    p_data JSONB,
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    INSERT INTO app_data (key, data, updated_at)
    VALUES (p_key, p_data, NOW())
    ON CONFLICT (key) DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：删除应用存档数据（需管理员密码）
-- ============================================================
CREATE OR REPLACE FUNCTION delete_app_data(
    p_key TEXT,
    p_pwd TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM app_data WHERE key = p_key;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 臻品橱窗（gallery）
-- ============================================================
CREATE TABLE IF NOT EXISTS gallery (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    design_text TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    sort_order INT DEFAULT 0,
    featured BOOLEAN NOT NULL DEFAULT FALSE,
    recommended BOOLEAN NOT NULL DEFAULT FALSE,
    price TEXT DEFAULT '',
    original_price TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE gallery ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anonymous_select_gallery" ON gallery;
CREATE POLICY "allow_anonymous_select_gallery" ON gallery
    FOR SELECT USING (TRUE);

CREATE OR REPLACE FUNCTION add_gallery_item(
    p_name TEXT,
    p_design TEXT,
    p_image TEXT,
    p_pwd TEXT,
    p_sort INTEGER DEFAULT 0,
    p_price TEXT DEFAULT NULL,
    p_original_price TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    INSERT INTO gallery (name, design_text, image_url, sort_order, price, original_price)
    VALUES (p_name, p_design, p_image, p_sort, p_price, p_original_price);
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- 更新商品（管理员，可同时调整排序/精选）
CREATE OR REPLACE FUNCTION update_gallery_item(
    p_id BIGINT,
    p_name TEXT,
    p_design TEXT,
    p_image TEXT,
    p_pwd TEXT,
    p_sort INTEGER DEFAULT NULL,
    p_featured BOOLEAN DEFAULT NULL,
    p_price TEXT DEFAULT NULL,
    p_original_price TEXT DEFAULT NULL,
    p_recommended BOOLEAN DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    UPDATE gallery SET
        name = p_name,
        design_text = p_design,
        image_url = p_image,
        sort_order = COALESCE(p_sort, sort_order),
        featured = COALESCE(p_featured, featured),
        price = COALESCE(p_price, price),
        original_price = COALESCE(p_original_price, original_price),
        recommended = COALESCE(p_recommended, recommended)
    WHERE id = p_id;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- 删除商品（管理员）
CREATE OR REPLACE FUNCTION delete_gallery_item(p_id BIGINT, p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM gallery WHERE id = p_id;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- ============================================================
-- 函数：编辑单条防伪记录（管理员）
-- ============================================================
CREATE OR REPLACE FUNCTION update_record(
    p_pwd TEXT,
    p_id TEXT,
    p_product_name TEXT,
    p_batch_no TEXT,
    p_message TEXT,
    p_export_msg BOOLEAN,
    p_image_url TEXT,
    p_export_name BOOLEAN,
    p_export_batch BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN FALSE;
    END IF;
    UPDATE records
    SET product_name = p_product_name,
        batch_no = p_batch_no,
        message = p_message,
        export_msg = p_export_msg,
        image_url = p_image_url,
        export_name = p_export_name,
        export_batch = p_export_batch
    WHERE id = p_id;
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$func$;

-- 读取品牌理念（公开，无需密码；管理员用 set_app_data('birch_brand', 文本) 写入）
CREATE OR REPLACE FUNCTION get_brand_text()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    result JSONB;
BEGIN
    SELECT data INTO result FROM app_data WHERE key = 'birch_brand';
    RETURN COALESCE(result #>> '{}', '');
END;
$func$;

-- 读取联系方式（公开；管理员用 set_app_data('birch_contact', 文本) 写入）
CREATE OR REPLACE FUNCTION get_contact()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    result JSONB;
BEGIN
    SELECT data INTO result FROM app_data WHERE key = 'birch_contact';
    RETURN COALESCE(result #>> '{}', '');
END;
$func$;

-- 读取任意应用文本（公开；管理员用 set_app_data(key, 文本) 写入）
-- 安全：birch_ai_key（AI API Key）与 birch_archive_v1（操作存档）仅管理员
-- 可通过 get_app_data(p_key, p_pwd) 读取，公开的 get_app_text 一律返回空，防泄露。
CREATE OR REPLACE FUNCTION get_app_text(p_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    result JSONB;
BEGIN
    IF p_key IN ('birch_ai_key', 'birch_archive_v1') THEN
        RETURN '';
    END IF;
    SELECT data INTO result FROM app_data WHERE key = p_key;
    RETURN COALESCE(result #>> '{}', '');
END;
$func$;

-- ============================================================
-- 白桦来信订阅（subscribers）：主页订阅 + 注册邮箱自动加入
-- ============================================================
CREATE TABLE IF NOT EXISTS subscribers (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anonymous_select_subscribers" ON subscribers;
CREATE POLICY "allow_anonymous_select_subscribers" ON subscribers
    FOR SELECT USING (TRUE);

-- 订阅（公开调用，无需密码；防重复）
CREATE OR REPLACE FUNCTION subscribe_email(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF p_email IS NULL OR TRIM(p_email) = '' OR NOT (TRIM(p_email) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') THEN
        RETURN FALSE;
    END IF;
    INSERT INTO subscribers (email) VALUES (TRIM(p_email))
    ON CONFLICT (email) DO NOTHING;
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$func$;

-- 获取订阅列表（管理员）
CREATE OR REPLACE FUNCTION get_subscribers(p_pwd TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    rows JSONB;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN NULL; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('email', email, 'time', to_char(created_at, 'YYYY-MM-DD HH24:MI')) ORDER BY id), '[]'::jsonb)
    INTO rows FROM subscribers;
    RETURN rows;
END;
$func$;

-- ============================================================
-- 水晶五行常识表（手串定制 / 五行知识展示）
-- ============================================================
CREATE TABLE IF NOT EXISTS crystals (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#8fbfa3',
    element TEXT DEFAULT '木',
    meaning TEXT DEFAULT ''
);
ALTER TABLE crystals ADD COLUMN IF NOT EXISTS image TEXT DEFAULT '';
ALTER TABLE crystals ADD COLUMN IF NOT EXISTS shape TEXT DEFAULT '圆珠';
ALTER TABLE crystals ADD COLUMN IF NOT EXISTS size_mm NUMERIC DEFAULT 8;
ALTER TABLE crystals ADD COLUMN IF NOT EXISTS stock_qty NUMERIC DEFAULT NULL;
ALTER TABLE crystals ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT NULL;
ALTER TABLE crystals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anonymous_select_crystals" ON crystals;
CREATE POLICY "allow_anonymous_select_crystals" ON crystals
    FOR SELECT USING (TRUE);

-- 新增水晶（管理员）
CREATE OR REPLACE FUNCTION add_crystal(p_name TEXT, p_color TEXT, p_element TEXT, p_meaning TEXT, p_pwd TEXT, p_image TEXT DEFAULT NULL, p_shape TEXT DEFAULT '圆珠', p_size_mm NUMERIC DEFAULT 8, p_stock_qty NUMERIC DEFAULT NULL, p_price NUMERIC DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    INSERT INTO crystals (name, color, element, meaning, image, shape, size_mm, stock_qty, price)
    VALUES (p_name, p_color, p_element, p_meaning, COALESCE(p_image, ''), COALESCE(NULLIF(p_shape,''),'圆珠'), COALESCE(p_size_mm,8), p_stock_qty, p_price);
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$func$;

-- 更新水晶（管理员）
CREATE OR REPLACE FUNCTION update_crystal(p_id BIGINT, p_name TEXT, p_color TEXT, p_element TEXT, p_meaning TEXT, p_pwd TEXT, p_image TEXT DEFAULT NULL, p_shape TEXT DEFAULT NULL, p_size_mm NUMERIC DEFAULT NULL, p_stock_qty NUMERIC DEFAULT NULL, p_price NUMERIC DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    UPDATE crystals SET name=p_name, color=p_color, element=p_element, meaning=p_meaning,
        image=COALESCE(p_image, image),
        shape=COALESCE(NULLIF(p_shape,''), shape),
        size_mm=COALESCE(p_size_mm, size_mm),
        stock_qty=CASE WHEN p_stock_qty IS NULL THEN stock_qty ELSE p_stock_qty END,
        price=CASE WHEN p_price IS NULL THEN price ELSE p_price END
    WHERE id=p_id;
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$func$;

-- 读取 AI 设计配置（公开安全版：只返回是否已配置/模型/提示词，不含 API Key）
-- 兼容两种存储格式：对象 {key,funcUrl,...} 或 JSON 字符串 "{\"key\":...}"（旧版写入可能为字符串）
CREATE OR REPLACE FUNCTION get_ai_config()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    result JSONB;
BEGIN
    SELECT data INTO result FROM app_data WHERE key = 'birch_ai_config';
    IF result IS NULL THEN RETURN jsonb_build_object('enabled', false); END IF;
    -- 若存的是 JSON 字符串（而非对象），先解析成对象
    IF jsonb_typeof(result) = 'string' THEN
        BEGIN
            result := (result #>> '{}')::JSONB;
        EXCEPTION WHEN OTHERS THEN
            RETURN jsonb_build_object('enabled', false);
        END;
    END IF;
    RETURN jsonb_build_object(
        'enabled', COALESCE((result ->> 'enabled')::BOOLEAN, false),
        'model', COALESCE(result ->> 'model', 'deepseek-v4-flash'),
        'funcUrl', COALESCE(result ->> 'funcUrl', ''),
        'prompt', COALESCE(result ->> 'prompt', ''),
        'hasKey', COALESCE(result ->> 'key', '') <> ''
    );
END;
$func$;

-- 删除水晶（管理员）
CREATE OR REPLACE FUNCTION delete_crystal(p_id BIGINT, p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    DELETE FROM crystals WHERE id=p_id;
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$func$;


-- 默认水晶数据（按名称幂等插入或更新，可在后台「水晶知识库」继续补充）
-- 功效综合主流水晶科普资料整理，五行与颜色、用途对应，仅供民俗参考
INSERT INTO crystals (name, color, element, meaning)
SELECT v.name, v.color, v.element, v.meaning FROM (VALUES
    ('白水晶','#e8f0ea','金','招财助事业、镇宅净场、聚焦专注、清理负能量，百搭基础款，适合学业考试'),
    ('黄水晶','#f2d27e','土','招正财偏财、增强自信与事业运，被称为财富之石，旺生意旺财运'),
    ('绿幽灵','#7fb069','木','异象招财、事业晋升、贵人缘佳，聚财聚气，越通透越旺正财'),
    ('粉晶','#f2b8c6','火','招桃花、改善人缘、治愈情感，温柔之石，单身增桃花、恋爱增甜蜜'),
    ('紫水晶','#b39ddb','木','开启智慧、助学业考试、助眠安神、提升灵性与直觉，学生党必备'),
    ('海蓝宝','#7ec8e3','水','加强沟通表达、舒缓压力、助力面试演讲、旅行平安'),
    ('黑曜石','#2f3542','水','强力辟邪挡煞、防小人、稳定情绪、稳固磁场，深夜护身首选'),
    ('红玛瑙','#d96c6c','火','增强活力勇气、改善循环、积极进取，旺气血旺行动力'),
    ('绿玉髓','#9bc5a0','木','招财纳福、生机勃勃、缓解紧张情绪，旺事业人缘'),
    ('茶晶','#a98a5e','土','稳心定神、抗压排负、增强落地与执行力，适合高压工作'),
    ('月光石','#e9e3f0','水','柔化情绪、增进感情与直觉、助眠安稳，女士月光石'),
    ('金发晶','#d4af37','金','强效招财、事业突破、提升格局与贵人，招财金最强之一'),
    ('草莓晶','#f0a0b0','火','招正桃花、增进感情浓度、提升魅力人缘，恋爱加持'),
    ('青金石','#3f5f9e','水','开启喉轮、助表达与智慧、链接高我，适合学生与沟通工作者'),
    ('橄榄石','#90c96a','木','招财进宝、缓解焦虑、增强生命力，旺平安健康'),
    ('石榴石','#c44d5e','火','增强气血与行动力、助姻缘、旺事业，补气血女性友好'),
    ('琥珀','#d98e32','土','疗愈净化、安定心神、驱邪避凶，温和护身'),
    ('蓝晶石','#8ec5e8','水','清晰思维、化解执着、沟通顺畅，助表达与思考'),
    ('虎眼石','#b5813a','土','增强勇气与决断、招偏财、化解拖延，事业坚定之石'),
    ('天珠','#7a5a3a','土','藏密法器、护身辟邪、聚福转运，护身转运之王'),
    ('拉长石','#4a5a7a','水','直觉敏锐、缓解焦虑、助灵性成长，加班族减压'),
    ('摩根石','#f2b8c6','火','温和疗愈、增进爱与包容、缓解压力，柔和爱情石'),
    ('碧玺','#7a9a5a','木','五行能量石、调和身心、旺事业人缘，彩色宝石能量强'),
    ('红纹石','#e88a9a','火','招正缘、疗愈心伤、助感情升温，姻缘之石'),
    ('孔雀石','#3fa08a','木','驱除负能量、保护平安、助事业决策，护身旺事业'),
    ('银曜石','#5a6070','水','辟邪防小人、清理情绪、增强力量，职场防小人'),
    ('发晶','#d4c47a','金','招财聚财、增强行动力、促事业上升，金发晶同源'),
    ('烟晶','#6a5a48','土','稳定情绪、排负抗压、接地气，沉稳落地'),
    ('紫锂辉','#d8a0d0','火','爱与被爱、舒缓紧张、提升魅力，温柔治愈'),
    ('黄玉','#f0d060','土','招财进宝、乐观自信、旺事业，黄色正能量'),
    ('钛晶','#e8c35a','金','招财最强、事业巅峰、贵气逼人，能量超强财神晶'),
    ('太阳石','#f0a050','火','增强自信魅力、乐观积极、旺事业贵人，阳光正能量'),
    ('蓝砂石','#3a5a8a','水','沉稳勇气、招偏财、缓解压力，星空夜之石'),
    ('黑发晶','#3a3a4a','水','辟邪挡煞、防小人、助事业突破，护身强力'),
    ('铜发晶','#a06a3a','土','强效辟邪净化、助决策、增强领导力，气场强大'),
    ('绿发晶','#5a9a5a','木','助事业成长、招财、旺正财，与绿幽灵同效'),
    ('紫龙晶','#8a6ab8','木','助灵性、缓解压力、助睡眠，紫色疗愈系'),
    ('舒俱来','#b07ad0','火','贵人缘、情绪疗愈、提升直觉，神秘能量石'),
    ('红兔毛','#e8a0a0','火','招正财、温和桃花、护身，内敛财运'),
    ('白纹石','#e8e8e8','金','净化磁场、招正缘、安抚情绪，温柔净化'),
    ('黄玛瑙','#e8c060','土','招偏财、增强活力、旺事业，财气玛瑙'),
    ('黑玛瑙','#3a3a4a','水','辟邪护身、稳定情绪、增强耐力，经典护身'),
    ('绿碧玺','#5a9a5a','木','旺事业贵人、招正财、增强生命力，事业绿'),
    ('粉碧玺','#f2a8b8','火','招桃花人缘、提升魅力、温柔疗愈，爱情加持'),
    ('黑碧玺','#3a3a4a','水','强力辟邪防小人、净化负能量、稳固磁场，护身首选'),
    ('紫黄晶','#c8a060','土','智慧与财富并重、调和冲突、平衡运势，双重能量'),
    ('月光白晶','#f0f4f8','水','净化调和、情绪稳定、助沟通，柔和百搭'),
    ('星光粉晶','#f8c0d0','火','招桃花、聚人缘、增强恋爱运，星光增福')
) v(name,color,element,meaning)
WHERE NOT EXISTS (SELECT 1 FROM crystals c WHERE c.name = v.name);

-- 已存在的水晶同步更新功效描述（升级旧数据用）
UPDATE crystals c SET
    color = v.color,
    element = v.element,
    meaning = v.meaning
FROM (VALUES
    ('白水晶','#e8f0ea','金','招财助事业、镇宅净场、聚焦专注、清理负能量，百搭基础款，适合学业考试'),
    ('黄水晶','#f2d27e','土','招正财偏财、增强自信与事业运，被称为财富之石，旺生意旺财运'),
    ('绿幽灵','#7fb069','木','异象招财、事业晋升、贵人缘佳，聚财聚气，越通透越旺正财'),
    ('粉晶','#f2b8c6','火','招桃花、改善人缘、治愈情感，温柔之石，单身增桃花、恋爱增甜蜜'),
    ('紫水晶','#b39ddb','木','开启智慧、助学业考试、助眠安神、提升灵性与直觉，学生党必备'),
    ('海蓝宝','#7ec8e3','水','加强沟通表达、舒缓压力、助力面试演讲、旅行平安'),
    ('黑曜石','#2f3542','水','强力辟邪挡煞、防小人、稳定情绪、稳固磁场，深夜护身首选'),
    ('红玛瑙','#d96c6c','火','增强活力勇气、改善循环、积极进取，旺气血旺行动力'),
    ('绿玉髓','#9bc5a0','木','招财纳福、生机勃勃、缓解紧张情绪，旺事业人缘'),
    ('茶晶','#a98a5e','土','稳心定神、抗压排负、增强落地与执行力，适合高压工作'),
    ('月光石','#e9e3f0','水','柔化情绪、增进感情与直觉、助眠安稳，女士月光石'),
    ('金发晶','#d4af37','金','强效招财、事业突破、提升格局与贵人，招财金最强之一'),
    ('草莓晶','#f0a0b0','火','招正桃花、增进感情浓度、提升魅力人缘，恋爱加持'),
    ('青金石','#3f5f9e','水','开启喉轮、助表达与智慧、链接高我，适合学生与沟通工作者'),
    ('橄榄石','#90c96a','木','招财进宝、缓解焦虑、增强生命力，旺平安健康'),
    ('石榴石','#c44d5e','火','增强气血与行动力、助姻缘、旺事业，补气血女性友好'),
    ('琥珀','#d98e32','土','疗愈净化、安定心神、驱邪避凶，温和护身'),
    ('蓝晶石','#8ec5e8','水','清晰思维、化解执着、沟通顺畅，助表达与思考'),
    ('虎眼石','#b5813a','土','增强勇气与决断、招偏财、化解拖延，事业坚定之石'),
    ('天珠','#7a5a3a','土','藏密法器、护身辟邪、聚福转运，护身转运之王'),
    ('拉长石','#4a5a7a','水','直觉敏锐、缓解焦虑、助灵性成长，加班族减压'),
    ('摩根石','#f2b8c6','火','温和疗愈、增进爱与包容、缓解压力，柔和爱情石'),
    ('碧玺','#7a9a5a','木','五行能量石、调和身心、旺事业人缘，彩色宝石能量强'),
    ('红纹石','#e88a9a','火','招正缘、疗愈心伤、助感情升温，姻缘之石'),
    ('孔雀石','#3fa08a','木','驱除负能量、保护平安、助事业决策，护身旺事业'),
    ('银曜石','#5a6070','水','辟邪防小人、清理情绪、增强力量，职场防小人'),
    ('发晶','#d4c47a','金','招财聚财、增强行动力、促事业上升，金发晶同源'),
    ('烟晶','#6a5a48','土','稳定情绪、排负抗压、接地气，沉稳落地'),
    ('紫锂辉','#d8a0d0','火','爱与被爱、舒缓紧张、提升魅力，温柔治愈'),
    ('黄玉','#f0d060','土','招财进宝、乐观自信、旺事业，黄色正能量')
) v(name,color,element,meaning)
WHERE c.name = v.name;

-- ============================================================
-- 订单系统（待处理订单 / 我的订单 / 运单号）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.orders (
    id BIGSERIAL PRIMARY KEY,
    order_no TEXT UNIQUE NOT NULL,
    order_pwd TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL,
    amount NUMERIC NOT NULL DEFAULT 0,
    discount NUMERIC NOT NULL DEFAULT 0,
    final_price NUMERIC NOT NULL DEFAULT 0,
    trade_no TEXT DEFAULT '',
    receiver TEXT DEFAULT '',
    address TEXT DEFAULT '',
    note TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    tracking_no TEXT DEFAULT '',
    anti_code TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    shipped_at TIMESTAMPTZ
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orders_deny_all" ON public.orders;
CREATE POLICY "orders_deny_all" ON public.orders FOR ALL USING (FALSE);
-- 老表补列（已存在则跳过）
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL DEFAULT '';

-- 公开提交订单（客户下单后调用；记录下单账号与昵称）
CREATE OR REPLACE FUNCTION public.submit_order(
    p_order_no TEXT, p_order_pwd TEXT, p_username TEXT, p_nickname TEXT, p_phone TEXT, p_product_name TEXT,
    p_amount NUMERIC, p_discount NUMERIC, p_final NUMERIC, p_trade_no TEXT,
    p_receiver TEXT, p_address TEXT, p_note TEXT
) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    INSERT INTO public.orders (order_no, order_pwd, username, nickname, phone, product_name, amount, discount, final_price, trade_no, receiver, address, note)
    VALUES (p_order_no, p_order_pwd, p_username, p_nickname, p_phone, p_product_name, p_amount, p_discount, p_final, p_trade_no, p_receiver, p_address, p_note);
    SELECT TRUE;
$func$;

-- 我的订单（按手机号查询，登录后调用）
-- 包含三路：手机号 / 订单username / birch_order_bind 绑定映射
-- 另加：无订单的绑定记录（birch_record_bind 绑定的防伪码记录，status='no_order' 展示为「仅记录」）
CREATE OR REPLACE FUNCTION public.get_my_orders(p_phone TEXT, p_username TEXT DEFAULT NULL)
RETURNS TABLE(order_no TEXT, order_pwd TEXT, product_name TEXT, final_price NUMERIC, status TEXT, tracking_no TEXT, anti_code TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
    v_bind JSONB;
    v_rec JSONB;
    v_time JSONB;
BEGIN
    v_bind := NULL;
    v_rec := NULL;
    IF p_username IS NOT NULL AND p_username <> '' THEN
        SELECT data INTO v_bind FROM app_data WHERE key = 'birch_order_bind';
        SELECT data INTO v_rec FROM app_data WHERE key = 'birch_record_bind';
        SELECT data INTO v_time FROM app_data WHERE key = 'birch_bind_time';
    END IF;
    RETURN QUERY
        SELECT o.order_no, o.order_pwd, o.product_name, o.final_price, o.status, o.tracking_no, o.anti_code, o.created_at
        FROM public.orders o
        WHERE o.status <> 'deleted'
          AND (
            o.phone = p_phone
           OR (p_username IS NOT NULL AND p_username <> '' AND o.username = p_username)
           OR (v_bind IS NOT NULL AND v_bind -> o.order_no IS NOT NULL AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(v_bind -> o.order_no) AS u WHERE u = p_username
           ))
          )
        UNION ALL
        -- 无订单的绑定记录：order_no 用防伪码，status='no_order'，前端展示为「仅记录」
        SELECT r.id AS order_no, '' AS order_pwd, r.product_name,
               NULL::NUMERIC AS final_price, 'no_order' AS status, '' AS tracking_no, r.id AS anti_code,
               CASE WHEN v_time IS NOT NULL AND v_time -> r.id IS NOT NULL THEN to_timestamp((v_time ->> r.id)::BIGINT / 1000.0)
               WHEN r.create_timestamp > 0 THEN to_timestamp(r.create_timestamp / 1000.0) END AS created_at
        FROM public.records r
        WHERE v_rec IS NOT NULL
          AND v_rec -> r.id IS NOT NULL
          AND v_rec ->> r.id = p_username
          AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.anti_code = r.id)
        ORDER BY created_at DESC;
END;
$func$;

-- 管理员：全部订单
CREATE OR REPLACE FUNCTION public.list_orders(p_pwd TEXT)
RETURNS TABLE(id BIGINT, order_no TEXT, order_pwd TEXT, phone TEXT, username TEXT, nickname TEXT, product_name TEXT, amount NUMERIC, discount NUMERIC, final_price NUMERIC, trade_no TEXT, receiver TEXT, address TEXT, note TEXT, status TEXT, tracking_no TEXT, anti_code TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN; END IF;
    RETURN QUERY
        SELECT o.id, o.order_no, o.order_pwd, o.phone, o.username, o.nickname, o.product_name, o.amount, o.discount, o.final_price, o.trade_no, o.receiver, o.address, o.note, o.status, o.tracking_no, o.anti_code, o.created_at
        FROM public.orders o
        ORDER BY o.created_at DESC;
END;
$func$;

-- 管理员：更新订单（状态/运单号/防伪码）
CREATE OR REPLACE FUNCTION public.update_order(
    p_id BIGINT, p_status TEXT DEFAULT NULL, p_tracking_no TEXT DEFAULT NULL,
    p_anti_code TEXT DEFAULT NULL, p_product_name TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL,
    p_order_no TEXT DEFAULT NULL, p_pwd TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF p_pwd IS NOT NULL AND NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    UPDATE public.orders SET
        status = COALESCE(p_status, status),
        tracking_no = COALESCE(p_tracking_no, tracking_no),
        anti_code = COALESCE(p_anti_code, anti_code),
        product_name = COALESCE(p_product_name, product_name),
        note = COALESCE(p_note, note),
        order_no = COALESCE(NULLIF(p_order_no, ''), order_no),
        shipped_at = CASE WHEN p_status = 'shipped' AND status <> 'shipped' THEN now() ELSE shipped_at END
    WHERE id = p_id;
    RETURN TRUE;
END;
$func$;

-- 管理员：删除订单（拆分合并订单时删除合并后的新订单）
CREATE OR REPLACE FUNCTION public.delete_order(p_id BIGINT, p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
    v_code TEXT;
    v_no TEXT;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    SELECT anti_code, order_no INTO v_code, v_no FROM public.orders WHERE id = p_id;
    DELETE FROM public.orders WHERE id = p_id;
    -- 同步删除该订单的防伪码记录（若无其他订单引用该码），并清理绑定映射
    IF v_code IS NOT NULL AND v_code <> '' THEN
        IF NOT EXISTS (SELECT 1 FROM public.orders WHERE anti_code = v_code) THEN
            DELETE FROM public.records WHERE id = v_code;
        END IF;
        -- birch_record_bind 移除该记录绑定
        UPDATE app_data SET data = data - v_code, updated_at = NOW()
        WHERE key = 'birch_record_bind' AND data ? v_code;
    END IF;
    -- birch_order_bind 移除该订单的可见账号
    IF v_no IS NOT NULL AND v_no <> '' THEN
        UPDATE app_data SET data = data - v_no, updated_at = NOW()
        WHERE key = 'birch_order_bind' AND data ? v_no;
    END IF;
    RETURN TRUE;
END;
$func$;

-- 自动清理：删除超过 p_days 天的订单记录（180 天），含已发货/待处理/已删除
-- 返回删除条数；仅管理员可调用（必须传管理员密码），配合 pg_cron 定时任务每天自动执行
CREATE OR REPLACE FUNCTION public.purge_old_orders(p_days INT DEFAULT 180, p_pwd TEXT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE deleted_cnt INT;
BEGIN
    -- 必须校验管理员密码，防止任意调用删除订单
    IF p_pwd IS NULL OR NOT verify_admin_pwd(p_pwd) THEN RETURN 0; END IF;
    DELETE FROM public.orders
    WHERE created_at < (now() - make_interval(days => GREATEST(p_days, 1)));
    GET DIAGNOSTICS deleted_cnt = ROW_COUNT;
    RETURN deleted_cnt;
END;
$func$;

-- ============================================================
-- 180 天自动清理定时任务（pg_cron，每天凌晨 3 点执行）
-- 定时任务直接用原生 DELETE（以数据库角色运行，无需密码）
-- ============================================================
create extension if not exists pg_cron;

-- 若已存在同名任务先移除，避免重复创建
select cron.unschedule(jobid) from cron.job where jobname = 'purge-old-orders';

-- 每天 03:00 自动删除超过 180 天的订单记录
select cron.schedule('purge-old-orders', '0 3 * * *',
    $$delete from public.orders where created_at < now() - interval '180 days'$$);

-- 查看定时任务：select * from cron.job;
-- 取消定时任务：select cron.unschedule('purge-old-orders');

-- ============================================================
-- 账号系统（用户名 + 密码注册登录，密码加盐哈希存储）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    pwd_hash TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_deny_all" ON public.users;
CREATE POLICY "users_deny_all" ON public.users FOR ALL USING (FALSE);
-- 老表补列（已存在则跳过）
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL DEFAULT '';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';
-- 终端管理员：账号 your_wechat_id（店主）拥有最高权限，添加任何人为管理员时自动通过验证
-- 管理员账号：本包不预置任何账号（避免携带原有账号与密码哈希）。
-- 部署后请在网站注册一个账号（或由后台创建），再执行下面这句把它设为管理员：
--   UPDATE public.users SET is_admin = TRUE WHERE username = '你的账号';
-- 如需终端管理员（可管理其他管理员）：UPDATE public.users SET is_super_admin = TRUE WHERE username = '你的账号';
UPDATE public.users SET is_super_admin = TRUE, is_admin = TRUE WHERE username = 'your_wechat_id';

-- ============================================================
-- AI 分析次数（ai_usage）：登录用户每天 10 次；管理员不限
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_usage (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    use_date DATE NOT NULL DEFAULT CURRENT_DATE,
    count INT NOT NULL DEFAULT 0,
    UNIQUE (username, use_date)
);
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_usage_deny_all" ON public.ai_usage;
CREATE POLICY "ai_usage_deny_all" ON public.ai_usage FOR ALL USING (FALSE);

-- 查询用户是否为管理员（公开调用）
CREATE OR REPLACE FUNCTION public.get_user_is_admin(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT COALESCE((SELECT is_admin FROM public.users WHERE username = p_username), FALSE);
$func$;

-- 查询用户是否为终端管理员（超级管理员，公开调用）
CREATE OR REPLACE FUNCTION public.get_user_is_super_admin(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT COALESCE((SELECT is_super_admin FROM public.users WHERE username = p_username), FALSE);
$func$;

-- 设置/取消用户的管理员身份
-- 终端管理员操作（p_operator 为终端管理员）：自动通过验证，无需操作密码
-- 普通路径：校验操作者账号（verify_admin_pwd 账号制）
-- 安全：终端管理员账号（如 your_wechat_id）不可被取消管理员权限
CREATE OR REPLACE FUNCTION public.set_user_admin(p_username TEXT, p_is_admin BOOLEAN, p_pwd TEXT, p_operator TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    -- 终端管理员不可被取消管理员权限
    IF NOT p_is_admin AND EXISTS (
        SELECT 1 FROM public.users WHERE username = p_username AND is_super_admin = TRUE
    ) THEN
        RETURN FALSE;
    END IF;
    -- 终端管理员操作：自动通过验证（无需操作密码）
    IF p_operator IS NOT NULL AND p_operator <> '' AND EXISTS (
        SELECT 1 FROM public.users WHERE username = p_operator AND is_super_admin = TRUE
    ) THEN
        UPDATE public.users SET is_admin = p_is_admin WHERE username = p_username;
        RETURN TRUE;
    END IF;
    -- 普通路径：账号制校验操作者（verify_admin_pwd）
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    UPDATE public.users SET is_admin = p_is_admin WHERE username = p_username;
    RETURN TRUE;
END;
$func$;

-- 查询某用户今日 AI 分析次数（公开调用）
CREATE OR REPLACE FUNCTION public.get_ai_usage_count(p_username TEXT, p_date DATE DEFAULT CURRENT_DATE)
RETURNS INT
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT COALESCE((SELECT count FROM public.ai_usage WHERE username = p_username AND use_date = p_date), 0);
$func$;

-- 消费一次 AI 分析（公开调用；返回是否成功）
CREATE OR REPLACE FUNCTION public.consume_ai_usage(p_username TEXT, p_date DATE DEFAULT CURRENT_DATE)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    INSERT INTO public.ai_usage (username, use_date, count)
    VALUES (p_username, p_date, 1)
    ON CONFLICT (username, use_date) DO UPDATE SET count = public.ai_usage.count + 1;
    RETURN TRUE;
END;
$func$;

-- 注册（公开调用；用户名已存在则返回 FALSE）
CREATE OR REPLACE FUNCTION public.register_user(p_username TEXT, p_nickname TEXT, p_salt TEXT, p_pwd_hash TEXT, p_phone TEXT, p_email TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF EXISTS (SELECT 1 FROM public.users WHERE username = p_username) THEN
        RETURN FALSE;
    END IF;
    INSERT INTO public.users (username, nickname, salt, pwd_hash, phone, email) VALUES (p_username, p_nickname, p_salt, p_pwd_hash, p_phone, COALESCE(p_email, ''));
    RETURN TRUE;
END;
$func$;

-- 登录校验（返回加盐哈希，前端比对）
CREATE OR REPLACE FUNCTION public.get_user_auth(p_username TEXT)
RETURNS TABLE(username TEXT, nickname TEXT, salt TEXT, pwd_hash TEXT, phone TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT u.username, u.nickname, u.salt, u.pwd_hash, u.phone
    FROM public.users u
    WHERE u.username = p_username;
$func$;

-- 登录成功时记录最后登录时间（公开调用）
CREATE OR REPLACE FUNCTION public.touch_login(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    UPDATE public.users SET last_login_at = now(), last_active_at = now() WHERE username = p_username;
    SELECT TRUE;
$func$;

-- 心跳：记录用户最近一次网页使用时间（登录后前端每 60 秒调用一次，公开调用）
CREATE OR REPLACE FUNCTION public.touch_active(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    UPDATE public.users SET last_active_at = now() WHERE username = p_username;
    SELECT TRUE;
$func$;

-- 用户自助修改昵称（需验证当前密码哈希，与改密码一致；账号名不可修改）
CREATE OR REPLACE FUNCTION public.change_user_nickname(p_username TEXT, p_new_nickname TEXT, p_old_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE cur TEXT;
BEGIN
    SELECT pwd_hash INTO cur FROM public.users WHERE username = p_username;
    IF cur IS NULL OR cur <> p_old_hash THEN RETURN FALSE; END IF;
    UPDATE public.users SET nickname = COALESCE(p_new_nickname, '') WHERE username = p_username;
    RETURN TRUE;
END;
$func$;

-- 用户自助修改手机号（需验证当前密码哈希；手机号为必填，用于「我的订单」查询）
CREATE OR REPLACE FUNCTION public.change_user_phone(p_username TEXT, p_new_phone TEXT, p_old_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE cur TEXT;
BEGIN
    SELECT pwd_hash INTO cur FROM public.users WHERE username = p_username;
    IF cur IS NULL OR cur <> p_old_hash THEN RETURN FALSE; END IF;
    UPDATE public.users SET phone = COALESCE(p_new_phone, '') WHERE username = p_username;
    RETURN TRUE;
END;
$func$;

-- 管理员：查看所有用户（含最后登录时间）
CREATE OR REPLACE FUNCTION public.list_users(p_pwd TEXT)
RETURNS TABLE(username TEXT, nickname TEXT, phone TEXT, email TEXT, created_at TIMESTAMPTZ, last_login_at TIMESTAMPTZ, last_active_at TIMESTAMPTZ, salt TEXT, pwd_hash TEXT, is_admin BOOLEAN, is_super_admin BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN; END IF;
    RETURN QUERY
        SELECT u.username, u.nickname, u.phone, u.email, u.created_at, u.last_login_at, u.last_active_at, u.salt, u.pwd_hash, u.is_admin, u.is_super_admin
        FROM public.users u
        ORDER BY u.created_at DESC;
END;
$func$;

-- 管理员：删除账号（需验证管理员密码）
CREATE OR REPLACE FUNCTION public.delete_user(p_username TEXT, p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    -- 终端管理员账号（如 your_wechat_id）不可删除
    IF EXISTS (SELECT 1 FROM public.users WHERE username = p_username AND is_super_admin = TRUE) THEN
        RETURN FALSE;
    END IF;
    DELETE FROM public.users WHERE username = p_username;
    RETURN TRUE;
END;
$func$;

-- 管理员：重置用户密码（新密码由前端加盐哈希后传入）
CREATE OR REPLACE FUNCTION public.reset_user_pwd(p_username TEXT, p_salt TEXT, p_pwd_hash TEXT, p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    UPDATE public.users SET salt = p_salt, pwd_hash = p_pwd_hash WHERE username = p_username;
    RETURN TRUE;
END;
$func$;

-- 查询用户邮箱（公开；用于订单邮件通知）
CREATE OR REPLACE FUNCTION public.get_user_email(p_username TEXT)
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT COALESCE((SELECT email FROM public.users WHERE username = p_username), '');
$func$;

-- 按运单号查询订单（公开，客户在「我的订单」中输入运单号查找）
CREATE OR REPLACE FUNCTION public.get_order_by_tracking(p_tracking_no TEXT)
RETURNS TABLE(order_no TEXT, product_name TEXT, final_price NUMERIC, status TEXT, tracking_no TEXT, anti_code TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT o.order_no, o.product_name, o.final_price, o.status, o.tracking_no, o.anti_code, o.created_at
    FROM public.orders o
    WHERE o.tracking_no = p_tracking_no
    ORDER BY o.created_at DESC;
$func$;

-- ============================================================
-- 幸运立减（幸运转盘：每个账号每天可转一次，记录含时间戳按天判断）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wheel_spins (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    discount INT NOT NULL DEFAULT 0,
    consumed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wheel_spins_user ON public.wheel_spins(username, consumed);
ALTER TABLE public.wheel_spins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wheel_spins_deny" ON public.wheel_spins;
CREATE POLICY "wheel_spins_deny" ON public.wheel_spins FOR ALL USING (FALSE);

-- 查询最近一次转盘记录
CREATE OR REPLACE FUNCTION public.get_my_spin(p_username TEXT)
RETURNS TABLE(discount INT, consumed BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    SELECT w.discount, w.consumed, w.created_at
    FROM public.wheel_spins w
    WHERE w.username = p_username
    ORDER BY w.created_at DESC
    LIMIT 1;
$func$;

-- 保存一次转盘结果（购买前有效）
CREATE OR REPLACE FUNCTION public.save_spin(p_username TEXT, p_discount INT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    INSERT INTO public.wheel_spins (username, discount) VALUES (p_username, p_discount);
    SELECT TRUE;
$func$;

-- 购买完成后消耗记录（解锁下一次转盘）
CREATE OR REPLACE FUNCTION public.consume_spins(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $func$
    UPDATE public.wheel_spins SET consumed = TRUE WHERE username = p_username AND consumed = FALSE;
    SELECT TRUE;
$func$;

-- 用户自助修改密码（需验证原密码哈希；新密码由前端加盐哈希后传入）
CREATE OR REPLACE FUNCTION public.change_user_pwd(p_username TEXT, p_old_hash TEXT, p_new_salt TEXT, p_new_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE cur TEXT;
BEGIN
    SELECT pwd_hash INTO cur FROM public.users WHERE username = p_username;
    IF cur IS NULL OR cur <> p_old_hash THEN RETURN FALSE; END IF;
    UPDATE public.users SET salt = p_new_salt, pwd_hash = p_new_hash WHERE username = p_username;
    RETURN TRUE;
END;
$func$;

-- ============================================================
-- 操作步骤说明（后台全部功能使用手册 · 存档）
-- 管理员入口：
--   · 登录 your_wechat_id（终端管理员，最高权限）后按 8 键 ×6 次 → 免密直接进入管理员后台
--   · 添加管理员：用户管理 →「👑 设为管理员」（终端管理员操作自动通过，无需密码）
--   · 清空回收站等危险操作：验证「管理员账号自己的登录密码」
--   · 所有后台操作均记录操作者（谁删了/加了/清了什么），存档详情可查看
-- ============================================================

-- ── 1. 待处理订单（secOrders）──────────────────────────────
-- ① 客户下单后自动进入「待处理订单」列表（不输入关键词时只显示待处理；
--    输入订单号/订单密码/用户名/昵称/手机号/商品名可搜索全部订单含已发货）
-- ② 每笔待处理订单卡片内只需填写：产品名称、专属定制编号、白桦寄语、图片文件名，
--    然后点「📷 导出防伪码图片」即可导出：
--    → 若订单还没有防伪码：先按表单内容生成并入官方码库并保存到订单（订单仍为待处理，**不会自动完成订单**）
--    → 已有防伪码：直接用该码导出
--    → 导出官方码卡片 JPG（品名 + 编号 + 官方码 + 二维码 + 寄语），仅导出图片，不改动订单状态
--    → 导出文件名 = 订单名（产品名）.jpg；合并订单导出时不显示「合并自：xxx」备注。
-- ③ 合并订单同样可用此流程（导出仅导出图片，不自动完成订单）；
--    另外合并订单有「✅ 完成订单」按钮（未生成码时自动生成入库再完成）和「🔀 拆分此单」。
--    用户端（我的订单/运单号查询）：被合并的原订单显示「🧩 已合并」，
--    仅作为一条记录展示（不提供详情/查找服务）；只有合并后的订单提供正常服务。
--    数据库记录管理 → 查看详情 → 「📷 导出JPG」：若该记录关联了订单（无论是否已点击完成），
--    一律按「单个防伪码生成界面」样式导出卡片，文件名 = 订单名.jpg；
--    未关联订单的记录保持「顾客预览」卡片导出。
-- ④ 「🗑️ 删除订单」：删除待处理/合并订单；若该订单已生成防伪码，
--    会同步把对应官方码记录移入回收站（可在回收站恢复）。
-- ⑤ 已发货订单显示运单号与官方码，可复制运单号、修改运单号、撤回待处理。

-- ── 2. 订单合并与拆分 ──────────────────────────────────────
-- 合并：勾选 ≥2 个待处理订单前面的复选框 → 点「🧩 合并选中订单」→ 输入合并名称
--       → 确认后生成一笔新订单（合计金额），原订单标记为已合并。
-- 拆分：合并生成的新订单卡片上会显示「🔀 拆分此单」按钮 → 点击确认后，
--       恢复所有原订单为待处理状态，并删除合并后的新订单。

-- ── 3. 用户管理（secUsers）─────────────────────────────────
-- 查看：全部注册账号（昵称、用户名、手机号、注册时间、最后登录时间）
-- 「📋 查看订单」：弹出该账号全部订单（订单号/商品/金额/状态/防伪码）
-- 「🗑️ 删除订单」：弹出选择弹窗，可勾选**指定的某几笔**订单删除；
--                 订单对应防伪码记录同步移入回收站（可恢复）
-- 「➕ 增加订单」：弹出「为账号添加订单」弹窗，界面与「单个官方码生成」一致：
--                 产品名称/专属定制编号/白桦寄语/图片文件名（含导出开关），
--                 确认后自动生成防伪码入官方码库并绑定订单，订单进入待处理列表。
-- 「🔑 重置密码」：将用户密码重置为 888888
-- 「🗑️ 删除账号」：永久删除该账号（需输入管理员密码确认）

-- ── 4. 数据库记录管理（secDb）──────────────────────────────
-- 查看全部官方码记录；可预览图片、查看详情、复制码、导出选中 ZIP、批量删除。
-- 「📋 退回待处理订单」：顶部按钮，直接切换到待处理订单界面继续处理。
-- 「📦 运单号」：若记录已关联订单 → 直接填运单号；
--                若无关联订单 → 输入用户名补建订单并绑定该记录与运单号。
-- 「➕ 为账号增加订单」：顶部按钮，输入用户名后为该账号补建订单
--                 （输入产品名称/编号/寄语/图片，自动生成防伪码入库并绑定订单）。
-- 「↩️ 退回待处理」：仅当该官方码关联的订单**已发货**时才显示按钮，
--                 点击后把订单退回待处理重新发货（防伪码保留在原订单上）。
--                 记录上始终显示关联订单号与状态（已发货/待处理/已合并）。
-- 滚动链：各列表/弹窗采用浏览器原生滚动链（overscroll-behavior:auto），
--         内层列表滑到底/顶后继续滑动，自动带动上一级（大框/页面），位移与手指一致。

-- ── 5. 待处理订单撤回 ──────────────────────────────────────
-- 已发货订单卡片上也有「↩️ 撤回待处理」按钮：点击后订单回到待处理列表，
-- 可重新生成防伪码、填运单号、完成订单。

-- ── 5. 单个/批量生成官方码（secSingle / secBatch）────────────
-- 单个：填产品名称/专属定制编号/寄语/图片文件名 → 「生成官方二维码」
--       → 可导出卡片 JPG、复制 NFC 码。
-- 批量：统一名称/编号/数量(1~50)/寄语/图片 → 「批量生成（自动入库）」。

-- ── 6. 回收站（secRecycle）─────────────────────────────────
-- 删除的官方码记录进入回收站：可「↩️ 恢复」或「🗑️ 彻底删除」。
-- **删除的待处理订单也进入回收站**：订单删除改为软删除（状态标记 deleted），
-- 回收站顶部显示「已删除订单」区块，可「↩️ 恢复」回待处理（防伪码一并恢复）
-- 或「🗑️ 彻底删除」（连同防伪码彻底清除）；「⚠️ 清空回收站」同时清空记录与订单。

-- ── 7. 其他后台设置 ────────────────────────────────────────
-- 邮件设置：订单通知收件邮箱（多个用逗号/换行分隔）
-- 臻品橱窗管理：商品增删改、上首页轮播(精选)、加入臻选推荐
-- 品牌理念 / 联系方式 / 活动通知：首页展示文案
-- 加载语录：首页/橱窗图片加载完成前轮流展示的文字（每行一条，自动循环，可随时修改）
-- 转盘优惠：立减金额区间与概率
-- 加入我们·分成：经销商返佣政策文案
-- 水晶知识库：水晶五行与功效管理（含珠子形状：圆珠/方糖/桶珠/随型/算盘珠/车轮珠；大小 mm；库存数量 stock_qty；
--             价格 price；后台可增删改；前台手串设计只显示库存>0 或未设库存的珠子）
-- AI 设计（secAiDesign）：DeepSeek 智能搭配。后台填 Edge Function 地址（ai-design/index.ts 部署后获得）
--             + DeepSeek API Key（platform.deepseek.com 创建，只存数据库不暴露给访客）+ 模型名（默认 deepseek-v4-flash）
--             前台生辰/摇卦/随缘点「✨ 一键配置」→ AI 自动做命理分析并给出手串搭配方案（以诗结尾）。
-- AI 次数限制：登录用户每天 10 次（ai_usage 表按 用户名+日期 计数）；未登录永久 2 次（本地存储计数）；
--             管理员不限（users.is_admin = true，用户管理里「👑 设为管理员」设置）。
-- 修改密码：用户管理里「重置密码」（管理员可重置任意账号密码）

-- ── 8. 数据库存档管理（archivePanel）────────────────────────
-- 管理员后台「所有按钮的操作」都会自动记录存档（含新增：查看订单为只读不存档，
-- 删除订单/删除账号订单/为账号增加订单等均存档）：
-- 官方码（生成单条/批量/删除/批量删除/恢复/编辑/导出卡片/复制码/NFC码/ZIP导出）、
-- 订单（生成防伪码/完成订单/导出防伪码图片/填运单号/合并/拆分/删除/撤回/为账号增加订单）、
-- 账号（删除账号/删除订单/重置密码）、设置（邮件/品牌/联系方式/通知/转盘/分成/管理员密码）、
-- 橱窗商品（新增/编辑/删除/精选/臻选/排序）、水晶知识库（新增/编辑/删除）、
-- AI 设计设置。
-- 所有操作在刷新/关闭网页时自动合并保存为一次存档（pagehide + beforeunload + visibilitychange
-- 三重兜底，keepalive 写入云端；若失败，下次打开后台自动补写），自动清理超过 5 天的旧存档；
-- 可「🔍 查看详情」或「↩️ 恢复覆盖当前数据库」。
-- ⚠️ 恢复存档会清空当前云端数据库并替换为存档内容，请谨慎操作。

-- ── 9. 手机扫码传图（华为一碰传的网页实现）────────────────────
-- 用法：后台「新增/编辑商品」→ 点「📲 手机传图」→ 手机扫二维码（华为相机/微信扫一扫均可）
--       → 手机端打开页面选一张照片 → 图片经下方中转表传回电脑后台的上传框（免装软件）。
-- ⚠️ 新增功能：需要在 Supabase 后台「SQL Editor」重新执行一次本段 SQL（含建表与两个函数）。
-- 安全说明：配对码为随机 6 位，数据 10 分钟内自动过期清理；中转数据用完即删。
CREATE TABLE IF NOT EXISTS img_transfer (
    id BIGSERIAL PRIMARY KEY,
    code TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_img_transfer_code ON img_transfer (code);

-- 手机端写入待收图片（10 分钟前的旧数据随手清理）
CREATE OR REPLACE FUNCTION put_img_transfer(p_code TEXT, p_data TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
    IF p_code IS NULL OR length(p_code) < 4 OR p_data IS NULL OR p_data = '' THEN
        RETURN FALSE;
    END IF;
    DELETE FROM img_transfer WHERE created_at < NOW() - INTERVAL '10 minutes';
    INSERT INTO img_transfer (code, data) VALUES (p_code, p_data);
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN RETURN FALSE;
END;
$func$;

-- 电脑端取走图片（读取最新一条并删除该配对码的全部记录）
CREATE OR REPLACE FUNCTION take_img_transfer(p_code TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
    v_data TEXT;
BEGIN
    SELECT data INTO v_data FROM img_transfer
    WHERE code = p_code AND created_at > NOW() - INTERVAL '10 minutes'
    ORDER BY id DESC LIMIT 1;
    DELETE FROM img_transfer WHERE code = p_code;
    RETURN v_data;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$func$;

-- ============================================================
-- GitHub 自动上传配置（「💾 保存」按钮用）
-- 说明：
--   1) 配置存在 app_data 表，读取需管理员密码（get_app_data），不会泄露给访客
--   2) 前端已去掉配置面板，改仓库/令牌时：修改下面 JSON 里的值，重新执行本段即可
--   3) 令牌只应存在数据库和你的手里，不要把本文件发给别人
-- ============================================================
INSERT INTO app_data (key, data, updated_at)
VALUES ('birch_github_cfg', '{"owner":"your-github-name","repo":"your-repo","branch":"main","filename":"index.html","token":"在此填入你的GitHub令牌（可选：后台推送网页用）"}'::JSONB, NOW())
ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();

-- ============================================================
-- 数据库管理界面「绑定账号」功能（追加于完整版）
-- 说明：把防伪码记录绑定到指定账号，关联订单的账号同步更新，
--       绑定账号的信箱会收到站内通知（前端已实现）。
-- ============================================================

-- 绑定：记录 → 账号（更新关联订单的 username + 记录绑定映射）
CREATE OR REPLACE FUNCTION public.bind_record_account(
    p_record_id TEXT,
    p_username TEXT,
    p_pwd TEXT
)
RETURNS TEXT  -- 返回关联订单号（无订单返回 NULL；错误返回 ERR_xxx）
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
    v_order_no TEXT;
    v_order_bind JSONB;
    v_users JSONB;
    v_bind_key TEXT;
    v_pname TEXT;
    v_pmsg TEXT;
    v_pwd TEXT;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN
        RETURN 'ERR_PWD';
    END IF;
    IF p_record_id IS NULL OR p_record_id = '' THEN
        RETURN 'ERR_ID';
    END IF;
    IF p_username IS NULL OR p_username = '' THEN
        RETURN 'ERR_USER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE username = p_username) THEN
        RETURN 'ERR_NO_USER';
    END IF;

    -- 1) 找到关联订单（防伪码记录 ↔ 订单 anti_code）；不覆盖原订单 username，
    --    原客户订单保持不变（订单本身只有一个 username，但绑定映射允许额外账号可见）
    SELECT order_no INTO v_order_no
    FROM public.orders WHERE anti_code = p_record_id LIMIT 1;

    -- 1.5) 若记录没有订单：自动创建订单（与臻品添加一致：订单+记录对应、可在「我的订单」打开详情）
    --      寄语=生成时写的白桦寄语，时间=当下，信息=记录内容
    IF v_order_no IS NULL THEN
        SELECT r.product_name, r.message INTO v_pname, v_pmsg
        FROM public.records r WHERE r.id = p_record_id;
        IF v_pname IS NOT NULL AND v_pname <> '' THEN
            v_order_no := 'BH' || floor(random() * 90000000 + 10000000)::TEXT;
            WHILE EXISTS (SELECT 1 FROM public.orders WHERE order_no = v_order_no) LOOP
                v_order_no := 'BH' || floor(random() * 90000000 + 10000000)::TEXT;
            END LOOP;
            v_pwd := lpad(floor(random() * 900000 + 100000)::TEXT, 6, '0');
            INSERT INTO public.orders (order_no, order_pwd, username, product_name, amount, discount, final_price, status, anti_code, note, created_at)
            VALUES (v_order_no, v_pwd, p_username, v_pname, 0, 0, 0, 'shipped', p_record_id, COALESCE(v_pmsg, ''), now());
        END IF;
    END IF;

    -- 2) 若有关联订单：把账号加入该订单的「可见账号」列表（birch_order_bind）
    IF v_order_no IS NOT NULL THEN
        v_bind_key := 'birch_order_bind';
        BEGIN
            SELECT COALESCE(data, '{}'::JSONB) INTO v_order_bind
            FROM app_data WHERE key = v_bind_key;
            v_order_bind := COALESCE(v_order_bind, '{}'::JSONB);
            v_users := COALESCE(v_order_bind -> v_order_no, '[]'::JSONB);
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(v_users) AS u WHERE u = p_username
            ) THEN
                v_users := v_users || jsonb_build_array(p_username);
                v_order_bind := v_order_bind || jsonb_build_object(v_order_no, v_users);
                INSERT INTO app_data (key, data, updated_at)
                VALUES (v_bind_key, v_order_bind, NOW())
                ON CONFLICT (key) DO UPDATE SET
                    data = EXCLUDED.data,
                    updated_at = EXCLUDED.updated_at;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    -- 3) 记录绑定映射（存 app_data：birch_record_bind → {recordId: username}）
    -- 记录绑定时间（birch_bind_time → {recordId: 毫秒时间戳}，供「我的订单」显示绑定时刻）
    BEGIN
        SELECT COALESCE(data, '{}'::JSONB) INTO v_order_bind
        FROM app_data WHERE key = 'birch_bind_time';
        v_order_bind := COALESCE(v_order_bind, '{}'::JSONB);
        v_order_bind := v_order_bind || jsonb_build_object(p_record_id, floor(extract(epoch FROM now()) * 1000)::BIGINT);
        INSERT INTO app_data (key, data, updated_at)
        VALUES ('birch_bind_time', v_order_bind, NOW())
        ON CONFLICT (key) DO UPDATE SET
            data = EXCLUDED.data,
            updated_at = EXCLUDED.updated_at;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    BEGIN
        SELECT COALESCE(data, '{}'::JSONB) INTO v_order_bind
        FROM app_data WHERE key = 'birch_record_bind';
        v_order_bind := COALESCE(v_order_bind, '{}'::JSONB);
        v_order_bind := v_order_bind || jsonb_build_object(p_record_id, p_username);
        INSERT INTO app_data (key, data, updated_at)
        VALUES ('birch_record_bind', v_order_bind, NOW())
        ON CONFLICT (key) DO UPDATE SET
            data = EXCLUDED.data,
            updated_at = EXCLUDED.updated_at;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN v_order_no;
END;
$func$;

-- 查询某条记录绑定的账号（供前端展示）
CREATE OR REPLACE FUNCTION public.get_record_bind_account(p_record_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
    v_bound JSONB;
    v_user TEXT;
BEGIN
    -- 先查关联订单的 username
    SELECT username INTO v_user FROM public.orders WHERE anti_code = p_record_id LIMIT 1;
    IF v_user IS NOT NULL AND v_user <> '' THEN
        RETURN v_user;
    END IF;
    -- 再查绑定映射
    BEGIN
        SELECT data INTO v_bound FROM app_data WHERE key = 'birch_record_bind';
        RETURN v_bound ->> p_record_id;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
END;
$func$;

-- ============================================================
-- 信箱清空修复：普通用户可清空自己的站内信箱（无需管理员密码）
-- ============================================================
CREATE OR REPLACE FUNCTION public.clear_own_mail(p_username TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
BEGIN
    IF p_username IS NULL OR p_username = '' THEN
        RETURN FALSE;
    END IF;
    UPDATE app_data
    SET data = '[]'::JSONB, updated_at = NOW()
    WHERE key = 'birch_mail_' || p_username;
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$func$;

-- ============================================================
-- 存量库历史绑定回填（新库自动空转，无副作用；幂等可反复执行）
-- 1) 把已有 birch_record_bind（记录→账号）同步到 birch_order_bind（订单→可见账号），
--    让之前绑过的账号立刻能在「我的订单」看到对应订单；
-- 2) 给有订单的历史绑定补发「白桦订单已绑定」站内信到目标账号信箱（不重复）。
-- ============================================================
DO $$
DECLARE
    r RECORD;
    v_order_no TEXT;
    v_order_bind JSONB;
    v_users JSONB;
    v_mail JSONB;
    v_new JSONB;
    v_added INT := 0;
    v_mailed INT := 0;
BEGIN
    SELECT COALESCE(data, '{}'::JSONB) INTO v_order_bind
    FROM app_data WHERE key = 'birch_order_bind';
    v_order_bind := COALESCE(v_order_bind, '{}'::JSONB);

    FOR r IN
        SELECT kv.key AS rec_id, kv.value AS usr
        FROM jsonb_each_text(
            COALESCE((SELECT data FROM app_data WHERE key = 'birch_record_bind'), '{}'::JSONB)
        ) AS kv
    LOOP
        SELECT order_no INTO v_order_no
        FROM public.orders WHERE anti_code = r.rec_id LIMIT 1;
        IF v_order_no IS NOT NULL THEN
            -- 1) 订单可见账号列表
            v_users := COALESCE(v_order_bind -> v_order_no, '[]'::JSONB);
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(v_users) AS u WHERE u = r.usr
            ) THEN
                v_users := v_users || jsonb_build_array(r.usr);
                v_order_bind := v_order_bind || jsonb_build_object(v_order_no, v_users);
                v_added := v_added + 1;
            END IF;
            -- 2) 补发站内信（已有同订单号的绑定通知则跳过）
            --    兼容历史写入：birch_mail_* 有的是 JSONB 数组，有的是 JSONB 字符串标量
            --    （内容为数组文本，前端 pushMail 以 JSON.stringify 字符串经 JSONB 参数写入所致），统一解析为数组
            SELECT data INTO v_mail
            FROM app_data WHERE key = 'birch_mail_' || r.usr;
            IF v_mail IS NULL THEN
                v_mail := '[]'::JSONB;
            ELSIF jsonb_typeof(v_mail) <> 'array' THEN
                BEGIN
                    v_mail := COALESCE(v_mail #>> '{}', '[]')::JSONB;
                EXCEPTION WHEN OTHERS THEN
                    v_mail := '[]'::JSONB;
                END;
                IF jsonb_typeof(v_mail) <> 'array' THEN
                    v_mail := '[]'::JSONB;
                END IF;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_mail) AS m
                WHERE m->>'title' LIKE '白桦订单已绑定%' AND m->>'body' LIKE '%' || v_order_no || '%'
            ) THEN
                v_new := jsonb_build_object(
                    'id', floor(extract(epoch FROM now()) * 1000)::BIGINT,
                    'title', '白桦订单已绑定 · ' || v_order_no,
                    'body', '您的防伪码记录（' || r.rec_id || '）已绑定到账号 ' || r.usr || '，关联订单：' || v_order_no || '，可在「我的订单」中查看。',
                    'time', to_char(now(), 'YYYY/MM/DD HH24:MI:SS')
                );
                v_mail := v_mail || jsonb_build_array(v_new);
                IF jsonb_array_length(v_mail) > 100 THEN
                    v_mail := (
                        SELECT COALESCE(jsonb_agg(sub.value), '[]'::JSONB)
                        FROM (
                            SELECT value
                            FROM jsonb_array_elements(v_mail) AS x
                            ORDER BY (x.value->>'id')::BIGINT DESC
                            LIMIT 100
                        ) AS sub
                    );
                END IF;
                INSERT INTO app_data (key, data, updated_at)
                VALUES ('birch_mail_' || r.usr, v_mail, NOW())
                ON CONFLICT (key) DO UPDATE SET
                    data = EXCLUDED.data,
                    updated_at = EXCLUDED.updated_at;
                v_mailed := v_mailed + 1;
            END IF;
        END IF;
    END LOOP;

    INSERT INTO app_data (key, data, updated_at)
    VALUES ('birch_order_bind', v_order_bind, NOW())
    ON CONFLICT (key) DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;

    RAISE NOTICE '历史绑定回填完成：新增 % 条订单可见绑定，补发 % 条站内信', v_added, v_mailed;
END $$;


-- 历史备注修正：把「生成防伪码自动创建」备注改为对应记录的白桦寄语（可反复执行）
UPDATE public.orders o
SET note = COALESCE(r.message, r.product_name, '')
FROM public.records r
WHERE o.anti_code = r.id AND o.note = '生成防伪码自动创建';

-- 历史修正：此前「臻选推荐添加」的订单改为完成态（不进待处理），备注清空（白桦寄语另存于记录）
UPDATE public.orders
SET status = 'shipped', note = ''
WHERE note = '臻选推荐添加' AND status = 'pending';

-- 部署完成提示
SELECT '白桦防伪系统 SQL 部署完成！管理员账号：your_wechat_id（终端管理员）' AS deployment_status;

-- ============================================================
-- 生成防伪码不再自动创建订单（移除自动建单触发器）
-- 说明：单个/批量生成的官方码只存入官方码库（records），
--      不自动生成订单、不进「待处理订单」列表。
--      绑定账号后，在对方「我的订单」按「生成防伪码」条目展示。
-- ============================================================
DROP TRIGGER IF EXISTS trg_auto_order_after_record_insert ON public.records;
DROP FUNCTION IF EXISTS public.auto_create_order_for_record();

-- 清理历史：删除此前由自动建单触发器创建的待处理虚拟订单
-- 特征：备注为「生成防伪码自动创建」（或已被改为寄语），且无客户信息、零金额、有防伪码
DELETE FROM public.orders
WHERE (note = '生成防伪码自动创建'
       OR (status = 'pending' AND username = '' AND phone = '' AND final_price = 0 AND anti_code <> ''));

-- ============================================================
-- 解除绑定：把记录与账号的绑定移除（后台「查看订单」里删除「仅记录」条目用）
-- 只解除绑定映射（birch_record_bind），记录本身保留在官方码库。
-- ============================================================
CREATE OR REPLACE FUNCTION public.unbind_record_account(p_record_id TEXT, p_username TEXT, p_pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
    v_bind JSONB;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN FALSE; END IF;
    IF p_record_id IS NULL OR p_record_id = '' OR p_username IS NULL OR p_username = '' THEN
        RETURN FALSE;
    END IF;
    -- 移除 birch_record_bind 中的记录→账号映射
    BEGIN
        SELECT COALESCE(data, '{}'::JSONB) INTO v_bind
        FROM app_data WHERE key = 'birch_record_bind';
        v_bind := COALESCE(v_bind, '{}'::JSONB);
        IF v_bind ? p_record_id THEN
            v_bind := v_bind - p_record_id;
            INSERT INTO app_data (key, data, updated_at)
            VALUES ('birch_record_bind', v_bind, NOW())
            ON CONFLICT (key) DO UPDATE SET
                data = EXCLUDED.data,
                updated_at = EXCLUDED.updated_at;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN TRUE;
END;
$func$;

-- ============================================================
-- 臻选推荐：一键生成防伪码 + 给指定账号添加订单
-- 用法：前端传入防伪码（前端 generateId 生成）、商品名、价格、目标账号
-- 返回：订单号；错误返回 ERR_xxx
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_code_order(
    p_code TEXT, p_product_name TEXT, p_final NUMERIC, p_username TEXT, p_pwd TEXT, p_note TEXT DEFAULT NULL, p_image TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
    v_no TEXT;
    v_pwd TEXT;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN 'ERR_PWD'; END IF;
    IF p_code IS NULL OR p_code = '' OR p_product_name IS NULL OR p_product_name = '' OR p_username IS NULL OR p_username = '' THEN
        RETURN 'ERR_PARAM';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE username = p_username) THEN
        RETURN 'ERR_NO_USER';
    END IF;
    -- 1) 防伪码入库
    INSERT INTO public.records (id, product_name, message, image_url, create_time, create_timestamp, verify_count, verify_history, export_msg, export_name, export_batch)
    VALUES (p_code, p_product_name, COALESCE(p_note, ''), NULLIF(p_image, ''), to_char(now(), 'YYYY/M/D HH24:MI:SS'),
            floor(extract(epoch FROM now()) * 1000)::BIGINT, 0, '[]'::JSONB, FALSE, TRUE, TRUE);
    -- 2) 创建订单
    v_no := 'BH' || floor(random() * 90000000 + 10000000)::TEXT;
    WHILE EXISTS (SELECT 1 FROM public.orders WHERE order_no = v_no) LOOP
        v_no := 'BH' || floor(random() * 90000000 + 10000000)::TEXT;
    END LOOP;
    v_pwd := lpad(floor(random() * 900000 + 100000)::TEXT, 6, '0');
    INSERT INTO public.orders (order_no, order_pwd, username, product_name, amount, discount, final_price, status, anti_code, note, created_at)
    VALUES (v_no, v_pwd, p_username, p_product_name, p_final, 0, p_final, 'shipped', p_code, COALESCE(p_note, ''), now());
    RETURN v_no;
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERR';
END;
$func$;

-- ============================================================
-- 历史恢复（可选）：此前被「覆盖逻辑」软删的臻选添加订单
-- 只恢复：商品名属于橱窗（gallery）的、有账号、无运单号、有防伪码的 deleted 订单
-- （不会误恢复手动删除的普通订单）
-- ============================================================
UPDATE public.orders o
SET status = 'shipped'
WHERE o.status = 'deleted'
  AND o.username <> ''
  AND o.tracking_no = ''
  AND o.anti_code <> ''
  AND o.product_name IN (SELECT name FROM gallery);

-- ============================================================
-- 清理历史软删订单（旧版 delete_order 只标记 status='deleted'，未真正删除）
-- 把已标记删除的订单彻底删除，并同步删除其防伪码记录（若无其他订单引用）
-- ============================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id, anti_code FROM public.orders WHERE status = 'deleted'
    LOOP
        DELETE FROM public.orders WHERE id = r.id;
        IF r.anti_code IS NOT NULL AND r.anti_code <> '' THEN
            IF NOT EXISTS (SELECT 1 FROM public.orders WHERE anti_code = r.anti_code) THEN
                DELETE FROM public.records WHERE id = r.anti_code;
            END IF;
        END IF;
    END LOOP;
END $$;

-- ======================================================================
-- 第 2 部分：桦库增量与功能（授权分享 / 转盘 / 配额 / 安全加固）
-- ======================================================================

-- ============================================================
-- 白桦 Supabase · 完整替换库配套 SQL（一次性执行，幂等可重跑）
-- 适用项目：cplyzukenqxdwhfivlqx
-- 说明：
--   桦库官方码 = records.id（一码一记录/一订单）；
--   先决条件：桦库主库（records / users / app_data / gallery /
--             verify_admin_pwd 等 58 个函数）已部署（见 白桦2.0/SQL.txt 完整版）。
--   本文件只负责：授权分享库 + 验证次数 + AI 图片配置 + 分享审核 RPC。
-- ============================================================

-- 0) 前置自检：需已存在 verify_admin_pwd（账号制鉴权）与 users 表
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'verify_admin_pwd'
  ) THEN
    RAISE NOTICE '未检测到 verify_admin_pwd —— 请先执行「白桦2.0/SQL.txt（完整版）」，再运行本文件；否则分享审核 RPC 将不可用';
  END IF;
END $$;

-- ============================================================
-- 1) 顾客授权分享库 shares（前台图片墙 + 弹幕 + 后台一行一条）
--    提交即入库(approved=false 待审)；审核通过后客户可见/上墙/弹幕播放。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shares (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text,            -- 官方码 records.id（一码一条）
  name text,            -- 产品名
  batch text,           -- 专属定制编号 batch_no
  idea text,            -- 客户定制想法（选填）
  img text,             -- 分享图（记录图/上传图）
  comment text,         -- 客户评论（弹幕文案）
  discount numeric,     -- 审核通过后减免金额
  contact text,         -- 联系微信（选填，默认取店铺微信）
  consent boolean DEFAULT true,   -- 同意授权分享
  approved boolean NOT NULL DEFAULT false,  -- 审核：false 待审 / true 上墙
  email_sent boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shares_code ON public.shares(code);
CREATE INDEX IF NOT EXISTS idx_shares_created ON public.shares(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_approved ON public.shares(approved);

ALTER TABLE public.shares ENABLE ROW LEVEL SECURITY;

-- 匿名可见：仅已审核上墙（隐私：待审评论不公开）
DROP POLICY IF EXISTS shares_select_anon ON public.shares;
CREATE POLICY shares_select_anon ON public.shares FOR SELECT
  USING (approved = true);

-- 匿名可提交（审核前前台不显示）
DROP POLICY IF EXISTS shares_insert_anon ON public.shares;
CREATE POLICY shares_insert_anon ON public.shares FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON public.shares TO anon, authenticated;
GRANT USAGE ON SEQUENCE shares_id_seq TO anon, authenticated;

-- 默认分享减免（可到后台「分享审核」修改；读 get_app_text('birch_share_discount')）
INSERT INTO public.app_data (key, data)
VALUES ('birch_share_discount', to_jsonb('10'::text))
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 2) 验证次数（桦库官方码 = records.id，一码一单核验计数）
-- ============================================================
ALTER TABLE public.records ADD COLUMN IF NOT EXISTS verify_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.records ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

CREATE OR REPLACE FUNCTION public.inc_verify(p_code text)
RETURNS TABLE(ok boolean, cnt integer) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v integer;
BEGIN
  UPDATE public.records
     SET verify_count = COALESCE(verify_count, 0) + 1, last_verified_at = now()
   WHERE id = p_code
   RETURNING COALESCE(verify_count, 1) INTO v;
  IF v IS NULL THEN RETURN QUERY SELECT false, 0; RETURN; END IF;
  RETURN QUERY SELECT true, v;
END; $$;
GRANT EXECUTE ON FUNCTION public.inc_verify(text) TO anon, authenticated;

-- ============================================================
-- 3) 分享审核 RPC（SECURITY DEFINER，沿用账号制鉴权 verify_admin_pwd）
--    前端 p_pwd 传「管理员账号用户名」，与桦库其它后台操作一致。
-- ============================================================

-- 3.1) 后台：分享列表（含待审），按时间倒序
CREATE OR REPLACE FUNCTION public.list_shares(p_pwd text)
RETURNS TABLE(
  id bigint, code text, name text, batch text, idea text, img text,
  comment text, discount numeric, contact text, consent boolean,
  approved boolean, email_sent boolean, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN; END IF;
  RETURN QUERY
    SELECT s.id, s.code, s.name, s.batch, s.idea, s.img, s.comment,
           s.discount, s.contact, s.consent, s.approved, s.email_sent, s.created_at
    FROM public.shares s
    ORDER BY s.approved ASC, s.created_at DESC;
END; $$;
GRANT EXECUTE ON FUNCTION public.list_shares(text) TO anon, authenticated;

-- 3.2) 审核：通过上墙 / 下架
CREATE OR REPLACE FUNCTION public.set_share_approved(p_id bigint, p_approved boolean, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.shares SET approved = COALESCE(p_approved, true)
   WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_share_approved(bigint, boolean, text) TO anon, authenticated;

-- 3.3) 修改减免金额
CREATE OR REPLACE FUNCTION public.set_share_discount(p_id bigint, p_discount numeric, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.shares SET discount = p_discount WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_share_discount(bigint, numeric, text) TO anon, authenticated;

-- 3.4) 删除一条分享
CREATE OR REPLACE FUNCTION public.delete_share(p_id bigint, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  DELETE FROM public.shares WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.delete_share(bigint, text) TO anon, authenticated;

-- ============================================================
-- 4) AI 出图配置（只写图模型；DeepSeek ai_key/ai_model 沿用原配置不动）
--    img_base 为硅基流动 API 根地址（函数内会拼 /images/generations）
--    若要一次性补全 DeepSeek key：另运行同目录「桦库-AI密钥配置.sql」
--    兼容性：settings.value 列无论 jsonb 还是 text 均可执行（自动探测）
-- ============================================================

-- 4.0) settings 表兜底（仅当库内不存在才创建；列类型不覆盖已有表结构）
DO $$
DECLARE ctype text;
BEGIN
  SELECT data_type INTO ctype FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'value';
  IF ctype IS NULL THEN
    CREATE TABLE IF NOT EXISTS public.settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT '{}',
      updated_at timestamptz DEFAULT now()
    );
  END IF;
END $$;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- 4.1) 合并 AI 出图配置（读兼容 text/jsonb；只补 img_*，不动已有 key/model）
DO $$
DECLARE
  ctype text;
  raw   text;
  cur   jsonb;
BEGIN
  SELECT data_type INTO ctype FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'value';
  IF ctype IS NULL THEN ctype := 'text'; END IF;

  SELECT value::text INTO raw FROM public.settings WHERE key = 'ai';
  IF raw IS NULL OR btrim(raw) = '' THEN
    cur := '{}'::jsonb;
  ELSE
    BEGIN
      cur := raw::jsonb;
      IF jsonb_typeof(cur) IN ('string', 'null') THEN cur := COALESCE((cur #>> '{}')::jsonb, '{}'::jsonb); END IF;
    EXCEPTION WHEN OTHERS THEN
      cur := to_jsonb(raw);
    END;
  END IF;
  IF jsonb_typeof(cur) IS DISTINCT FROM 'object' THEN cur := '{}'::jsonb; END IF;

  cur := cur || jsonb_build_object(
    'img_key',  '在此填入你的通义（硅基流动）密钥',
    'img_model', 'Tongyi-MAI/Z-Image-Turbo',
    'img_base',  'https://api.siliconflow.cn/v1');

  IF lower(ctype) = 'jsonb' THEN
    INSERT INTO public.settings (key, value) VALUES ('ai', cur)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  ELSE
    INSERT INTO public.settings (key, value) VALUES ('ai', cur::text)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
END $$;

-- 自检
SELECT 'shares' AS t, count(*) FROM public.shares
UNION ALL SELECT 'records', count(*) FROM public.records;
SELECT key, value FROM public.settings WHERE key = 'ai';
SELECT key, data FROM public.app_data WHERE key = 'birch_share_discount';

-- ============================================================
-- 5) 幸运转盘按码开关（制作NFC码时默认允许；个别订单可在
--    「数据库记录管理」行内切换）records.wheel_enabled
-- ============================================================
ALTER TABLE public.records ADD COLUMN IF NOT EXISTS wheel_enabled boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.update_record_wheel(p_id text, p_enabled boolean, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.records SET wheel_enabled = COALESCE(p_enabled, true) WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.update_record_wheel(text, boolean, text) TO anon, authenticated;

-- ============================================================
-- 6) 幸运转盘·每个官方码一次抽奖（扫 NFC/二维码 → 同一防伪码）
--    后台允许(wheel_enabled=true)时该码可抽且仅可抽一次。
-- ============================================================
ALTER TABLE public.records ADD COLUMN IF NOT EXISTS wheel_spun boolean NOT NULL DEFAULT false;

-- 领取抽奖资格（原子：仅当 码存在 && 后台允许 && 未抽过 才成功）
CREATE OR REPLACE FUNCTION public.try_claim_wheel(p_code text)
RETURNS TABLE(ok boolean, already boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE id = p_code) THEN
    RETURN QUERY SELECT false, true; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE id = p_code AND wheel_enabled AND NOT wheel_spun) THEN
    RETURN QUERY SELECT false, true; RETURN;
  END IF;
  UPDATE public.records SET wheel_spun = true WHERE id = p_code;
  RETURN QUERY SELECT true, false;
END; $$;
GRANT EXECUTE ON FUNCTION public.try_claim_wheel(text) TO anon, authenticated;

-- 重置某码的抽奖资格（管理员）
CREATE OR REPLACE FUNCTION public.reset_record_wheel(p_id text, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.records SET wheel_spun = false WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.reset_record_wheel(text, text) TO anon, authenticated;

-- ============================================================
-- 7) 弹幕 / 信息（订单卡片）分开管理
--    shares.card_on = 是否在首页「客户晒单」显示订单卡片
--    shares.dm_on   = 是否作为弹幕播放
--    两者独立；都关 = 前台完全看不到（整条隐藏）
-- ============================================================
ALTER TABLE public.shares ADD COLUMN IF NOT EXISTS card_on boolean NOT NULL DEFAULT true;
ALTER TABLE public.shares ADD COLUMN IF NOT EXISTS dm_on   boolean NOT NULL DEFAULT true;

-- 兼容历史数据：此前被"隐藏"(approved=false)的整条，两个开关都关
UPDATE public.shares SET card_on = false, dm_on = false
 WHERE approved = false AND card_on = true AND dm_on = true;

-- 匿名可见范围：任一路开启即可见（前端再按各自开关分别呈现）
DROP POLICY IF EXISTS shares_select_anon ON public.shares;
CREATE POLICY shares_select_anon ON public.shares FOR SELECT
  USING (card_on = true OR dm_on = true);

-- 后台列表：返回新增的两个开关（返回类型变化，需先 DROP）
DROP FUNCTION IF EXISTS public.list_shares(text);
CREATE OR REPLACE FUNCTION public.list_shares(p_pwd text)
RETURNS TABLE(
  id bigint, code text, name text, batch text, idea text, img text,
  comment text, discount numeric, contact text, consent boolean,
  approved boolean, email_sent boolean, created_at timestamptz,
  card_on boolean, dm_on boolean
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN; END IF;
  RETURN QUERY
    SELECT s.id, s.code, s.name, s.batch, s.idea, s.img, s.comment,
           s.discount, s.contact, s.consent, s.approved, s.email_sent, s.created_at,
           s.card_on, s.dm_on
    FROM public.shares s
    ORDER BY s.created_at DESC;
END; $$;
GRANT EXECUTE ON FUNCTION public.list_shares(text) TO anon, authenticated;

-- 单独开关：卡片 / 弹幕
CREATE OR REPLACE FUNCTION public.set_share_card(p_id bigint, p_on boolean, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.shares SET card_on = COALESCE(p_on, true) WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_share_card(bigint, boolean, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_share_dm(p_id bigint, p_on boolean, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.shares SET dm_on = COALESCE(p_on, true) WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_share_dm(bigint, boolean, text) TO anon, authenticated;

-- 整条 隐藏/显示（同时切换两个开关）
CREATE OR REPLACE FUNCTION public.set_share_all(p_id bigint, p_on boolean, p_pwd text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.verify_admin_pwd(p_pwd) THEN RETURN false; END IF;
  UPDATE public.shares SET card_on = COALESCE(p_on, false), dm_on = COALESCE(p_on, false), approved = COALESCE(p_on, false) WHERE id = p_id;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_share_all(bigint, boolean, text) TO anon, authenticated;

-- ============================================================
-- 8) AI 配额（服务端限次，防刷）—— 配合 birch-ai 的 consume_ai_quota
--    三层：uid（匿名终身 2 次 / 登录每天 10 次）→ IP（每天 10 次）→ 全局（每天 500 次）
--    说明：函数侧 fail-open（配额服务异常时放行，不挡顾客）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.app_secrets (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT ''
);
ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;   -- 无策略：匿名读不到（函数用 service role）

INSERT INTO public.app_secrets(key, value)
VALUES ('ai_ip_salt', md5(random()::text || clock_timestamp()::text))
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ai_quota_uid (
  uid text PRIMARY KEY,
  used integer NOT NULL DEFAULT 0,
  anon boolean NOT NULL DEFAULT false,
  used_day date NOT NULL DEFAULT CURRENT_DATE,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_quota_ip (
  ip_hash text NOT NULL,
  day date NOT NULL DEFAULT CURRENT_DATE,
  used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
CREATE TABLE IF NOT EXISTS public.ai_quota_day (
  day date PRIMARY KEY,
  used integer NOT NULL DEFAULT 0
);
ALTER TABLE public.ai_quota_uid ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quota_ip  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quota_day ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_uid text, p_is_anon boolean, p_ip_hash text)
RETURNS TABLE(allowed boolean, reason text, remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_anon_limit constant integer := 2;    -- 未登录（匿名登录）终身 2 次
  v_user_daily constant integer := 10;   -- 登录用户每天 10 次
  v_ip_daily   constant integer := 20;   -- 同一 IP 每天 10 次（运营商共享网络建议 ≥10）
  v_global     constant integer := 500;  -- 全站每天 500 次熔断
  v_used integer; v_anon boolean; v_day date; v_g integer; v_ip integer;
BEGIN
  -- ① 全局熔断
  INSERT INTO ai_quota_day(day, used) VALUES (CURRENT_DATE, 1)
    ON CONFLICT (day) DO UPDATE SET used = ai_quota_day.used + 1
    RETURNING used INTO v_g;
  IF v_g > v_global THEN RETURN QUERY SELECT false, 'global_daily_limit', 0; RETURN; END IF;

  -- ② IP 层（匿名调用没有 uid，只受这一层）
  IF p_ip_hash IS NOT NULL AND p_ip_hash <> '' THEN
    INSERT INTO ai_quota_ip(ip_hash, day, used) VALUES (p_ip_hash, CURRENT_DATE, 1)
      ON CONFLICT (ip_hash, day) DO UPDATE SET used = ai_quota_ip.used + 1
      RETURNING used INTO v_ip;
    IF v_ip > v_ip_daily THEN RETURN QUERY SELECT false, 'ip_daily_limit', 0; RETURN; END IF;
  END IF;

  -- ③ uid 层
  IF p_uid IS NOT NULL AND p_uid <> '' THEN
    SELECT q.used, q.anon, q.used_day INTO v_used, v_anon, v_day FROM ai_quota_uid q WHERE q.uid = p_uid;
    IF NOT FOUND THEN
      INSERT INTO ai_quota_uid(uid, used, anon, used_day)
      VALUES (p_uid, 1, COALESCE(p_is_anon, false), CURRENT_DATE);
      v_used := 1; v_anon := COALESCE(p_is_anon, false);
    ELSIF COALESCE(p_is_anon, false) AND v_anon THEN
      IF v_used >= v_anon_limit THEN RETURN QUERY SELECT false, 'anon_limit_reached', 0; RETURN; END IF;
      UPDATE ai_quota_uid SET used = used + 1, updated_at = now() WHERE uid = p_uid;
      v_used := v_used + 1;
    ELSIF v_day <> CURRENT_DATE THEN
      UPDATE ai_quota_uid SET used = 1, used_day = CURRENT_DATE, updated_at = now() WHERE uid = p_uid;
      v_used := 1;
    ELSE
      IF v_used >= v_user_daily THEN RETURN QUERY SELECT false, 'user_daily_limit', 0; RETURN; END IF;
      UPDATE ai_quota_uid SET used = used + 1, updated_at = now() WHERE uid = p_uid;
      v_used := v_used + 1;
    END IF;
    RETURN QUERY SELECT true, 'ok', GREATEST(0, v_user_daily - v_used);
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'ok', -1;
END; $$;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(text, boolean, text) TO anon, authenticated, service_role;

-- ============================================================
-- 9) 安全加固（体检后修复）
--    9.1 内容清洗触发器：防"存储型 XSS"（验证页会直接渲染 records.message 等）
--    9.2 晒单表收紧：必须对应真实官方码、一个码一条、长度限制
--    9.3 管理员鉴权加固：可选"用户名 + 令牌"双因子（默认关闭，前端更新后再开启）
-- ============================================================

-- 9.1 内容清洗：去掉所有 HTML 标签与尖括号
CREATE OR REPLACE FUNCTION public.sanitize_text(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t IS NULL THEN NULL
              ELSE regexp_replace(regexp_replace(t, '<[^>]*>', '', 'g'), '[<>]', '', 'g') END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sanitize_records() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.product_name := public.sanitize_text(NEW.product_name);
  NEW.batch_no     := public.sanitize_text(NEW.batch_no);
  NEW.message      := public.sanitize_text(NEW.message);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_records_sanitize ON public.records;
CREATE TRIGGER trg_records_sanitize BEFORE INSERT OR UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.trg_sanitize_records();

CREATE OR REPLACE FUNCTION public.trg_sanitize_shares() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.comment := public.sanitize_text(NEW.comment);
  NEW.name    := public.sanitize_text(NEW.name);
  NEW.idea    := public.sanitize_text(NEW.idea);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_shares_sanitize ON public.shares;
CREATE TRIGGER trg_shares_sanitize BEFORE INSERT OR UPDATE ON public.shares
  FOR EACH ROW EXECUTE FUNCTION public.trg_sanitize_shares();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='gallery') THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.trg_sanitize_gallery() RETURNS trigger LANGUAGE plpgsql AS $b$
      BEGIN
        NEW.name := public.sanitize_text(NEW.name);
        NEW.design_text := public.sanitize_text(NEW.design_text);
        RETURN NEW;
      END $b$;
    $f$;
    EXECUTE 'DROP TRIGGER IF EXISTS trg_gallery_sanitize ON public.gallery';
    EXECUTE 'CREATE TRIGGER trg_gallery_sanitize BEFORE INSERT OR UPDATE ON public.gallery FOR EACH ROW EXECUTE FUNCTION public.trg_sanitize_gallery()';
  END IF;
END $$;

-- 历史数据一次性清洗
UPDATE public.records SET product_name = public.sanitize_text(product_name),
                          batch_no     = public.sanitize_text(batch_no),
                          message      = public.sanitize_text(message)
 WHERE product_name ~ '[<>]' OR batch_no ~ '[<>]' OR message ~ '[<>]';
UPDATE public.shares  SET comment = public.sanitize_text(comment), name = public.sanitize_text(name)
 WHERE comment ~ '[<>]' OR name ~ '[<>]';

-- 9.2 晒单表收紧
CREATE OR REPLACE FUNCTION public.trg_shares_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.comment IS NOT NULL AND length(NEW.comment) > 500 THEN NEW.comment := left(NEW.comment, 500); END IF;
  IF NEW.name    IS NOT NULL AND length(NEW.name)    > 40  THEN NEW.name    := left(NEW.name, 40);    END IF;
  IF NEW.code IS NOT NULL AND btrim(NEW.code) <> ''
     AND NOT EXISTS (SELECT 1 FROM public.records WHERE id = NEW.code) THEN
    RAISE EXCEPTION '该官方码不存在，无法晒单';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_shares_guard ON public.shares;
CREATE TRIGGER trg_shares_guard BEFORE INSERT ON public.shares
  FOR EACH ROW EXECUTE FUNCTION public.trg_shares_guard();

-- 一个官方码只允许一条晒单（先去重再建唯一索引）
DELETE FROM public.shares s USING public.shares d
 WHERE s.code <> '' AND s.code = d.code AND s.id < d.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_one_per_code ON public.shares(code) WHERE code <> '';

-- 说明：管理员双因子（可选）已移至独立文件「桦库-可选-管理员双因子.sql」，默认不要执行。

-- ======================================================================
-- 第 3 部分：线上核对补漏
-- ======================================================================
-- 说明：与线上库核对后补齐；以下为库中在用但原脚本缺失的函数。
-- 已排除（有意不纳入，属历史遗留、且涉及明文密码表，勿再使用）：
--   · change_admin_pwd —— 改写 legacy 表 admin_settings.password（现行为账号制鉴权，已废弃）
--   · app_settings / sql_version_flag —— 无任何函数引用，历史遗留表

CREATE OR REPLACE FUNCTION public.sync_crystal_stock(p_items jsonb, p_pwd text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    item JSONB;
    v_name TEXT; v_element TEXT; v_meaning TEXT; v_image TEXT; v_shape TEXT; v_size_mm NUMERIC;
    v_stock_qty NUMERIC; v_price NUMERIC; v_color TEXT;
    added INT := 0; updated INT := 0;
BEGIN
    IF NOT verify_admin_pwd(p_pwd) THEN RETURN jsonb_build_object('ok', false, 'error', '密码无效'); END IF;
    IF jsonb_typeof(p_items) <> 'array' THEN RETURN jsonb_build_object('ok', false, 'error', '参数必须是数组'); END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_name := TRIM(item ->> 'name');
        IF v_name IS NULL OR v_name = '' THEN CONTINUE; END IF;
        v_element := NULLIF(item ->> 'element', '');
        v_meaning := NULLIF(item ->> 'meaning', '');
        v_image := NULLIF(item ->> 'image', '');
        v_shape := NULLIF(item ->> 'shape', '');
        v_size_mm := NULLIF((item ->> 'size_mm')::NUMERIC, NULL);
        v_stock_qty := NULLIF((item ->> 'stock_qty')::NUMERIC, NULL);
        v_price := NULLIF((item ->> 'price')::NUMERIC, NULL);
        v_color := NULLIF(item ->> 'color', '');
        -- 存在则更新，不存在则插入
        IF EXISTS (SELECT 1 FROM crystals WHERE name = v_name) THEN
            UPDATE crystals SET
                element = COALESCE(v_element, element),
                meaning = COALESCE(v_meaning, meaning),
                image = COALESCE(v_image, image),
                shape = COALESCE(v_shape, shape),
                size_mm = COALESCE(v_size_mm, size_mm),
                stock_qty = COALESCE(v_stock_qty, stock_qty),
                price = COALESCE(v_price, price),
                color = COALESCE(v_color, color)
            WHERE name = v_name;
            updated := updated + 1;
        ELSE
            INSERT INTO crystals (name, color, element, meaning, image, shape, size_mm, stock_qty, price)
            VALUES (v_name, COALESCE(v_color, '#8fbfa3'), COALESCE(v_element, '木'), COALESCE(v_meaning, ''),
                    COALESCE(v_image, ''), COALESCE(v_shape, '圆珠'), COALESCE(v_size_mm, 8), v_stock_qty, v_price);
            added := added + 1;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('ok', true, 'added', added, 'updated', updated);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
