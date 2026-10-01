-- ============================================================
-- 白桦 · AI 配置模板（部署后由管理员填写自己的密钥）
-- 用法：把下面 YOUR_* 处替换成你自己的值 → Supabase SQL Editor 执行
-- 注意：本文件包含密钥，请勿提交到公开仓库、勿公开转发
-- ============================================================

create table if not exists public.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table public.settings enable row level security;   -- 匿名不可读，仅 Edge Function 用 service_role 读取

-- ① DeepSeek（文案与设计理念、诗句）
insert into public.settings (key, value) values
('ai', '{
  "key":         "YOUR_DEEPSEEK_KEY",
  "model":       "deepseek-chat",
  "img_key":     "YOUR_SILICONFLOW_KEY",
  "img_model":   "Tongyi-MAI/Z-Image-Turbo",
  "img_base":    "https://api.siliconflow.cn/v1"
}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ② 邮件（客户授权晒单后的通知收件人；发件用 QQ 邮箱示例）
insert into public.settings (key, value) values
('mail', '{
  "smtp_host": "smtp.qq.com",
  "smtp_port": 465,
  "smtp_user": "YOUR_SMTP_USER@qq.com",
  "smtp_pass": "YOUR_SMTP_AUTH_CODE",
  "to": ["admin@example.com"]
}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- 自检
select key, value ? 'key' as has_ai_key, value ? 'img_key' as has_img_key, value ? 'smtp_user' as has_mail
from public.settings order by key;
