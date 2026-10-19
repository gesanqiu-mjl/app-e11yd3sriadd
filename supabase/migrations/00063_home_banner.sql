-- 资源管理页顶部「展示位」：管理员填图片 URL，在页面最上方展示一条横幅。
--
-- 与侧边栏展示位同一套机制（复用 login_config 表：公开可读、管理员可写）：
--   home_banner_url ：横幅图片地址（留空即不展示；管理员会看到引导入口）
--   home_banner_link：可选，点击横幅跳转的链接（新窗口）

alter table public.login_config
  add column if not exists home_banner_url text,
  add column if not exists home_banner_link text;

comment on column public.login_config.home_banner_url is '资源管理页顶部横幅图片地址（留空即不展示）';
comment on column public.login_config.home_banner_link is '可选：点击顶部横幅跳转的链接';
