import React, { useState, useEffect, useCallback } from 'react';
import { History, Lock, Layers, Plus, CheckCheck, CircleCheckBig, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import ResourceTable from '@/components/ResourceTable';
import UpdatedPanel from '@/components/UpdatedPanel';
import CompletedPanel from '@/components/CompletedPanel';
import HistoryDialog from '@/components/HistoryDialog';
import { Resource, UpdatedItem, DisplayFormat } from '@/types/index';
import { fetchResources, fetchUpdatedItems, clearUpdatedItems, setResourceFinished } from '@/services/api';
import { useAuth } from '@/contexts/AuthContext';

export default function HomePage() {
  const { isMembershipActive, profile } = useAuth();
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedItems, setUpdatedItems] = useState<UpdatedItem[]>([]);
  const [updatedLoading, setUpdatedLoading] = useState(false);
  const [dayOffset, setDayOffset] = useState(0); // 0=今天 1=昨天 2=前天
  const [displayFormat, setDisplayFormat] = useState<DisplayFormat>('all');
  const [historyOpen, setHistoryOpen] = useState(false);
  // 手机端：按钮提升到标题栏，状态在此管理
  const [addOpen, setAddOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  // 右侧栏面板切换：已更新 / 已完结
  const [sidePanel, setSidePanel] = useState<'updated' | 'completed'>('updated');

  const loadUpdated = useCallback((offset: number) => {
    setUpdatedLoading(true);
    fetchUpdatedItems(offset)
      .then(setUpdatedItems)
      .catch(() => toast.error('加载已更新记录失败，请稍后重试'))
      .finally(() => setUpdatedLoading(false));
  }, []);

  useEffect(() => {
    fetchResources()
      .then(setResources)
      .catch(() => toast.error('加载资源列表失败，请刷新重试'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadUpdated(dayOffset);
  }, [dayOffset, loadUpdated]);

  const handleResourceUpdated = useCallback(
    (resource: Resource, fieldLabel: string) => {
      // 资源被修改：若当前查看的是「今天」，直接刷新服务端数据以保证一致
      if (dayOffset === 0) {
        loadUpdated(0);
      } else {
        // 查看历史日期时，切换回今天以展示最新更新
        setDayOffset(0);
      }
      void resource;
      void fieldLabel;
    },
    [dayOffset, loadUpdated]
  );

  const handleSyncResult = useCallback(
    (resourceId: string, errors: { site: string; reason: string }[]) => {
      setUpdatedItems((prev) =>
        prev.map((item) =>
          item.resource.id === resourceId
            ? { ...item, syncErrors: errors.length > 0 ? errors : undefined }
            : item
        )
      );
    },
    []
  );

  const handleResourceAdded = useCallback((resource: Resource) => {
    setResources((prev) => [...prev, resource]);
  }, []);

  /** 从已完结面板移除资源（取消完结标记） */
  const handleRemoveFinished = useCallback((resource: Resource) => {
    setResourceFinished(resource.id, false)
      .then(() => {
        setResources((prev) =>
          prev.map((r) => (r.id === resource.id ? { ...r, is_finished: false } : r))
        );
        toast.success('已移出已完结');
      })
      .catch(() => toast.error('移出失败，请重试'));
  }, []);

  const handleClearUpdated = useCallback(() => {
    clearUpdatedItems(dayOffset)
      .then(() => {
        setUpdatedItems([]);
        toast.success('已清空所选日期的更新记录');
      })
      .catch(() => toast.error('清空失败，请稍后重试'));
  }, [dayOffset]);

  return (
    <AppLayout>
      <PageMeta
        title="资源管理中心 - 影视资源更新追踪与管理"
        description="影视资源管理中心，提供剧集、动漫、电影等资源的更新进度追踪、集数维护与跨站点批量同步功能。"
        keywords="资源管理, 影视更新, 剧集追踪, 完结归档, 链接管理"
      />
      <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
        {/* 工具栏：标题 + 手机端操作按钮 + 历史记录 */}
        <div className="flex items-center gap-2 px-4 md:px-8 py-2 md:py-4 border-b border-border bg-background shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h2 className="font-serif text-lg font-bold text-foreground truncate">我的剧集资源</h2>
            {!loading && (
              <span className="text-xs text-muted-foreground shrink-0">{resources.length} 条</span>
            )}
          </div>
          {/* 手机端：批量导入 + 新增资源 紧跟标题后（桌面端按钮在表格工具栏） */}
          {!loading && (
            <div className="flex items-center gap-1.5 md:hidden shrink-0">
              <Button variant="outline" size="sm"
                onClick={() => setBatchOpen(true)}
                disabled={!isMembershipActive}
                className="h-7 px-2 gap-1 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                <Layers className="h-3 w-3" />导入
              </Button>
              <Button size="sm"
                onClick={() => setAddOpen(true)}
                disabled={!isMembershipActive}
                className="h-7 px-2 gap-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90">
                <Plus className="h-3 w-3" />新增
              </Button>
            </div>
          )}
          {/* 会员到期时间（桌面端常驻显示；管理员显示永久） */}
          {profile?.role !== 'admin' && profile?.membership_expires_at && (
            <span
              className={`hidden md:inline-flex items-center gap-1 text-xs shrink-0 ${
                new Date(profile.membership_expires_at).getTime() <= Date.now()
                  ? 'text-destructive'
                  : 'text-accent'
              }`}
              title="会员到期时间"
            >
              <Clock className="h-3.5 w-3.5" />
              到期：{new Date(profile.membership_expires_at).toLocaleDateString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistoryOpen(true)}
            className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden md:inline">查看历史</span>
          </Button>
        </div>

        {/* 会员过期提示 */}
        {!isMembershipActive && (
          <div className="flex items-center gap-2 px-4 md:px-8 py-2.5 bg-destructive/10 border-b border-destructive/20 shrink-0">
            <Lock className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-xs text-destructive">
              您的会员已于 {profile?.membership_expires_at ? new Date(profile.membership_expires_at).toLocaleDateString() : ''} 到期，编辑功能已锁定，请联系管理员续费。
            </span>
          </div>
        )}

        {/* 主体 */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col p-2 md:p-4 gap-2 md:gap-4">
            {loading ? (
              <div className="flex items-center justify-center flex-1">
                <div className="text-sm text-muted-foreground animate-pulse">加载资源中…</div>
              </div>
            ) : (
              <ResourceTable
                resources={resources}
                onResourcesChange={setResources}
                onResourceUpdated={handleResourceUpdated}
                onResourceAdded={handleResourceAdded}
                onSyncResult={handleSyncResult}
                readOnly={!isMembershipActive}
                addOpen={addOpen}
                onAddOpenChange={setAddOpen}
                batchOpen={batchOpen}
                onBatchOpenChange={setBatchOpen}
              />
            )}
          </div>

          {/* 右侧面板：已更新 / 已完结 tab 切换；手机端 h-48 紧凑，桌面端自适应 */}
          <div className="md:w-80 shrink-0 border-t md:border-t-0 md:border-l border-border min-h-0 h-48 md:h-auto flex flex-col bg-card/40">
            {/* Tab 切换栏 */}
            <div className="flex shrink-0 border-b border-border bg-muted/30">
              <button
                onClick={() => setSidePanel('updated')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                  sidePanel === 'updated'
                    ? 'text-primary border-b-2 border-primary bg-card'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <CheckCheck className="h-3.5 w-3.5" />已更新
              </button>
              <button
                onClick={() => setSidePanel('completed')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                  sidePanel === 'completed'
                    ? 'text-primary border-b-2 border-primary bg-card'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <CircleCheckBig className="h-3.5 w-3.5" />已完结
                {resources.some((r) => r.is_finished) && (
                  <span className="text-[10px] text-accent">({resources.filter((r) => r.is_finished).length})</span>
                )}
              </button>
            </div>
            {/* 面板内容 */}
            <div className="flex-1 min-h-0">
              {sidePanel === 'updated' ? (
                <UpdatedPanel
                  items={updatedItems}
                  format={displayFormat}
                  onClear={handleClearUpdated}
                  onFormatChange={setDisplayFormat}
                  dayOffset={dayOffset}
                  onDayOffsetChange={setDayOffset}
                  loading={updatedLoading}
                />
              ) : (
                <CompletedPanel
                  resources={resources}
                  onRemoveFinished={handleRemoveFinished}
                  format={displayFormat}
                  onFormatChange={setDisplayFormat}
                />
              )}
            </div>
          </div>
        </div>

        <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />
      </div>
    </AppLayout>
  );
}
