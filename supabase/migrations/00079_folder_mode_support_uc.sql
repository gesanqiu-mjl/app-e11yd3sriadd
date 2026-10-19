-- ============================================================
-- 文件夹模式放开到 UC 网盘
--
-- UC 与夸克同架构（pc-api.uc.cn/1/clouddrive），整目录转存同样是
-- `share/sharepage/save` 的 fid_list 传目录 fid + 该目录的 share_fid_token，
-- 落地为同名文件夹并保留子目录。因此文件夹模式对 UC 与夸克一致。
--
-- 服务端已同步放开：
--   · saveSubscription 的 folder_mode 白名单
--   · runPanShareSubscription 的 FOLDER_MODE_PANS
--   · 文件夹模式内部的夸克特判（递归列举 / 落地检测 / 同名文件夹复用 / junk 清理）
--
-- 迅雷仍强制关闭。

create or replace function public.enforce_folder_mode_pan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pan not in ('guangya', 'quark', 'baidu', 'uc') then
    new.folder_mode := false;
  end if;
  return new;
end
$$;

comment on function public.enforce_folder_mode_pan() is
  '文件夹模式支持光鸭 / 夸克 / 百度 / UC；其它网盘一律置 false';