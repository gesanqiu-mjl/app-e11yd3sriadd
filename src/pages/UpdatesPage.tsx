import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import UpdatedPanel from '@/components/UpdatedPanel';
import HistoryDialog from '@/components/HistoryDialog';
import { UpdatedItem, DisplayFormat } from '@/types/index';
import { fetchUpdatedItems, clearUpdatedItems } from '@/services/api';

/**
 * 更新状态页（手机端首页点「更新状态」跳到这里，路由 /updates）。
 *
 * 复用首页右侧「已更新」面板的全部能力（面板自带 今天 / 昨天 / 前天 三个日期的切换）：
 * 日期切换、显示格式（全部/光鸭/夸克…）、复制图文或纯文字、查看历史记录、清空当天记录。
 * 这样手机上一个入口就能完整查看三天的更新记录，不需要再压缩在右侧小面板里。
 */
export default function UpdatesPage() {
  const [dayOffset, setDayOffset] = useState(0);
  const [items, setItems] = useState<UpdatedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [format, setFormat] = useState<DisplayFormat>('all');
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 上次加载是否失败（切回前台时自动补一次，手机端网络抖动场景） */
  const failedRef = useRef(false);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const list = await fetchUpdatedItems(offset);
      failedRef.current = false;
      setItems(list);
    } catch {
      failedRef.current = true;
      toast.error('加载更新记录失败', {
        description: '多为手机网络瞬时中断，稍后会自动重试。',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(dayOffset);
  }, [dayOffset, load]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && failedRef.current) void load(dayOffset);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [dayOffset, load]);

  const handleClear = useCallback(() => {
    clearUpdatedItems(dayOffset)
      .then(() => {
        setItems([]);
        toast.success('已清空所选日期的更新记录');
      })
      .catch(() => toast.error('清空失败，请稍后重试'));
  }, [dayOffset]);

  return (
    <AppLayout fixedHeight>
      <PageMeta
        title="更新状态 - 网盘推广工具"
        description="查看今天 / 昨天 / 前天的资源更新记录，支持一键复制图文或纯文字分享。"
        keywords="更新记录,剧集更新,资源更新,网盘链接"
      />
      <div className="flex h-full min-h-0 flex-col">
        {/* 标题区：手机端从首页「更新状态」跳进来，明确当前在看什么 */}
        <div className="shrink-0 border-b border-border px-4 py-3 md:px-6 md:py-4">
          <h1 className="font-serif text-lg font-bold text-foreground md:text-xl">更新状态</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground md:text-xs">
            查看 今天 / 昨天 / 前天 的资源更新记录，可复制图文或纯文字直接分享。
          </p>
        </div>
        <div className="min-h-0 flex-1">
          <UpdatedPanel
            items={items}
            format={format}
            onClear={handleClear}
            onFormatChange={setFormat}
            dayOffset={dayOffset}
            onDayOffsetChange={setDayOffset}
            onOpenHistory={() => setHistoryOpen(true)}
            loading={loading}
          />
        </div>
      </div>
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />
    </AppLayout>
  );
}
