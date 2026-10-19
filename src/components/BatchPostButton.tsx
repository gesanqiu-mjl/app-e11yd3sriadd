import { useState } from 'react';
import { Lock, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import BatchPostDialog from '@/components/BatchPostDialog';
import { useAuth } from '@/contexts/AuthContext';
import { batchPostRemainingDays, isBatchPostAllowed, type BatchPostSite } from '@/lib/batchPost';

interface BatchPostButtonProps {
  site: BatchPostSite;
  /** 站点操作进行中（如登录/解绑中）时禁用 */
  disabled?: boolean;
  className?: string;
}

/**
 * 「批量发帖」入口按钮 + 弹窗。
 * 需要管理员在后台开通「批量发帖权限」（可设 1/3/6/12 个月有效期），未开通或已过期即锁定。
 */
export default function BatchPostButton({ site, disabled, className }: BatchPostButtonProps) {
  const [open, setOpen] = useState(false);
  const { profile } = useAuth();
  const allowed = isBatchPostAllowed(profile);
  const remainDays = batchPostRemainingDays(profile);
  const lockedTip = '批量发帖权限未开通或已过期，请联系管理员开通';

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          if (!allowed) {
            toast.error(lockedTip);
            return;
          }
          setOpen(true);
        }}
        disabled={disabled}
        title={
          allowed
            ? `批量发帖：上传 xlsx（剧名/文件名/链接），按剧名自动匹配站点片源后批量发布${
                remainDays !== null ? `（权限剩余 ${remainDays} 天）` : ''
              }`
            : lockedTip
        }
        className={
          className ??
          'h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5'
        }
      >
        {allowed ? <Upload className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        批量发帖
      </Button>
      <BatchPostDialog open={open} onOpenChange={setOpen} site={site} />
    </>
  );
}
