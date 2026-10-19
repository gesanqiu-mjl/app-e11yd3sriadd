-- 文件夹模式放开到百度网盘
--
-- 背景：触发器 enforce_folder_mode_pan 目前只放行 guangya / quark，
-- 百度订阅勾了「文件夹模式」会被静默置 false（边缘函数保存层同步放开）。
--
-- 百度侧依据：POST /share/transfer 的 fsidlist 直接给目录 fs_id 即可整目录转存，
-- 落地为同名文件夹、子目录结构完整保留、目标目录根下不产生平铺副本。
-- 转后清理改用 Web 端 POST /api/filemanager?opera=delete（进回收站，可恢复）。
-- 影盘/迅雷仍强制关闭。

create or replace function public.enforce_folder_mode_pan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pan not in ('guangya', 'quark', 'baidu') then
    new.folder_mode := false;
  end if;
  return new;
end
$$;

comment on function public.enforce_folder_mode_pan() is
  '文件夹模式支持光鸭 / 夸克 / 百度；其它网盘一律置 false';
