-- 侧边栏顶部「展示位」：管理员填一个 URL，用图片或视频展示（替代原来的品牌文字块）。
--
-- 背景：功能菜单顶部原本固定显示「网盘推广工具」品牌文字，现改为可配置的展示位：
--   sidebar_media_type：none（不展示）/ image（图片）/ video（视频，自动静音循环播放）
--   sidebar_media_url ：图片或视频地址（留空即不展示）
--   sidebar_media_link：可选，点击展示位后打开的链接（新窗口）
--
-- 复用 login_config 表（已有「公开可读、管理员可写」的策略，无需新增策略）。

alter table public.login_config
  add column if not exists sidebar_media_type text not null default 'none',
  add column if not exists sidebar_media_url text,
  add column if not exists sidebar_media_link text;

comment on column public.login_config.sidebar_media_type is '侧边栏顶部展示位类型：none / image / video';
comment on column public.login_config.sidebar_media_url is '侧边栏展示位的图片或视频地址（留空即不展示）';
comment on column public.login_config.sidebar_media_link is '可选：点击展示位跳转的链接';

do $$
begin
  alter table public.login_config
    add constraint login_config_sidebar_media_type_chk
    check (sidebar_media_type in ('none', 'image', 'video'));
exception
  when duplicate_object then null;
end $$;
