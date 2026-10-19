-- ============================================================
-- 123 云盘（123pan）开放「文件夹模式」
--
-- 背景：文件夹模式需要三层同时放行，否则会出现「界面能勾、存库被改 false、执行时退回逐文件」：
--   1) 前端 SubscribePage.FOLDER_MODE_PANS
--   2) 边缘函数 saveSubscription 的 folder_mode 白名单 + FOLDER_MODE_PANS
--   3) 本触发器 enforce_folder_mode_pan
--
-- 123 整目录转存可行（2026-10-18 实测）：
--   POST https://<分享号>.share.123pan.cn/api/restful/goapi/v1/file/copy/save
--   fileList 元素里 type:1 即目录，123 会连子目录一起秒传落地。
--
-- 坑（已写进函数注释）：清洗/清理会把目录移入回收站（file/trash + operation:2），
-- 目录一旦离开目录树，订阅里存的 target_dir(FileId) 就失效了，
-- 而 123 提交转存时不会报错、只给一个 taskID，轮询接口又 404 —— 只能靠目录树遍历校验兜住。
-- ============================================================

create or replace function public.enforce_folder_mode_pan()
returns trigger
language plpgsql
as $$
begin
  if new.folder_mode = true
     and new.pan is not null
     and new.pan <> all (array['guangya', 'quark', 'baidu', 'uc', 'p123']) then
    new.folder_mode := false;
  end if;
  return new;
end;
$$;

comment on function public.enforce_folder_mode_pan() is
  '文件夹模式白名单：guangya / quark / baidu / uc / p123（123云盘，2026-10-18 放开）。与前端 FOLDER_MODE_PANS、边缘函数 saveSubscription 白名单保持一致。';
