import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Layers, Plus, CheckCheck, CircleCheckBig, Clock, Loader2, FileJson, Download, ImagePlus, RefreshCcw, MoreVertical, BookOpen } from 'lucide-react';
import { getLoginConfig, fetchActiveTutorials } from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import ResourceTable from '@/components/ResourceTable';
import UpdatedPanel from '@/components/UpdatedPanel';
import CompletedPanel from '@/components/CompletedPanel';
import HistoryDialog from '@/components/HistoryDialog';
import TutorialDialog from '@/components/TutorialDialog';
import { Resource, UpdatedItem, DisplayFormat, Tutorial } from '@/types/index';
import { fetchResources, fetchUpdatedItems, clearUpdatedItems, setResourceFinished } from '@/services/api';
import { importJsonText } from '@/lib/jsonImport';
import { downloadResourcesXlsx } from '@/lib/exportXlsx';
import { useAuth } from '@/contexts/AuthContext';

export default function HomePage() {
  const { isMembershipActive, profile } = useAuth();
  const navigate = useNavigate();
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedItems, setUpdatedItems] = useState<UpdatedItem[]>([]);
  const [updatedLoading, setUpdatedLoading] = useState(false);
  const [dayOffset, setDayOffset] = useState(0); // 0=今天 1=昨天 2=前天
  const [displayFormat, setDisplayFormat] = useState<DisplayFormat>('all');
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 顶部展示位（管理员在「登录页配置」里填图片 URL） */
  const [homeBanner, setHomeBanner] = useState<{ url: string; link: string }>({ url: '', link: '' });
  useEffect(() => {
    getLoginConfig()
      .then((c) =>
        setHomeBanner({ url: (c.home_banner_url || '').trim(), link: (c.home_banner_link || '').trim() })
      )
      .catch(() => {});
  }, []);
  /** 图文教程（管理员在「管理后台 → 图文教程」维护，前台仅读启用中的） */
  const [tutorials, setTutorials] = useState<Tutorial[]>([]);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  useEffect(() => {
    fetchActiveTutorials()
      .then(setTutorials)
      .catch(() => {});
  }, []);
  // 手机端：按钮提升到标题栏，状态在此管理
  const [addOpen, setAddOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  // 手机端：JSON 资源包导入（桌面端入口在表格工具栏）
  const [importingJson, setImportingJson] = useState(false);
  const [importJsonProgress, setImportJsonProgress] = useState({ done: 0, total: 0 });
  // XLSX 导出（含封面抓取，耗时较长）
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  // 右侧栏面板切换：已更新 / 已完结
  const [sidePanel, setSidePanel] = useState<'updated' | 'completed'>('updated');

  const loadUpdated = useCallback((offset: number) => {
    setUpdatedLoading(true);
    fetchUpdatedItems(offset)
      .then(setUpdatedItems)
      .catch(() =>
        toast.error('加载已更新记录失败', {
          description: '手机网络瞬时抖动时会出现，稍后会自动重试。',
        })
      )
      .finally(() => setUpdatedLoading(false));
  }, []);

  /** 上次「资源列表」是否加载失败（用于切回前台时自动补一次） */
  const loadFailedRef = useRef(false);

  /**
   * 加载资源列表。
   *
   * 手机浏览器上偶发的 "Failed to fetch" + 「加载资源列表失败」现在已经有两层兜底：
   *   ① 传输层：supabase 请求对「读请求」自动重试 2 次（见 src/db/supabase.ts）；
   *   ② 应用层：仍失败时弹「重试」按钮，并且在页面切回前台（解锁/切回 App）时自动补一次。
   * 这样用户不再需要手动刷新整页。
   */
  const loadResources = useCallback(async () => {
    try {
      const list = await fetchResources();
      loadFailedRef.current = false;
      setResources(list);
    } catch {
      loadFailedRef.current = true;
      toast.error('加载资源列表失败', {
        description: '多为手机网络瞬时中断（切后台 / 换网络）。可点「重试」，或稍等自动重试。',
        action: { label: '重试', onClick: () => void loadResources() },
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadResources();
  }, [loadResources]);

  // 手机切回前台（含锁屏解锁）时，若上次失败过就自动补拉一次
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && loadFailedRef.current) void loadResources();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadResources]);

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

  /** 导出资源清单为 XLSX（标题 / 封面图片 / 网盘链接（带云盘名称）/ 状态） */
  async function handleExportXlsx() {
    if (resources.length === 0) {
      toast.info('当前没有可导出的资源');
      return;
    }
    setExportingXlsx(true);
    try {
      const result = await downloadResourcesXlsx(resources);
      if (!result) {
        toast.info('当前没有可导出的资源');
        return;
      }
      toast.success(
        `已导出 ${result.exported} 条资源${result.covers > 0 ? `（含封面 ${result.covers} 张）` : ''}`
      );
    } catch (e) {
      toast.error((e as Error).message || '导出失败，请重试');
    } finally {
      setExportingXlsx(false);
    }
  }

  /** 导入 JSON 资源包（兼容完整导出包与裸数组），导入后按服务端结果重建列表 */
  async function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许连续导入同一个文件
    if (!file || importingJson) return;

    setImportingJson(true);
    setImportJsonProgress({ done: 0, total: 0 });
    try {
      const res = await importJsonText(await file.text(), (done, total) =>
        setImportJsonProgress({ done, total })
      );
      setResources(await fetchResources());
      if (res.failed === 0) {
        toast.success(`导入完成：新增 ${res.inserted} 条资源`);
      } else {
        toast.warning(`导入完成：成功 ${res.inserted} 条，失败 ${res.failed} 条`);
      }
    } catch (err) {
      toast.error((err as Error).message || '导入失败，请重试');
    } finally {
      setImportingJson(false);
      setImportJsonProgress({ done: 0, total: 0 });
    }
  }

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

  /**
   * 手机端工具栏（设计稿）：与「搜索框」同一行的三个按钮 ——
   *   更新状态（跳 /updates 看今天/昨天/前天记录）、新增资源、以及「更多」里的导入/导出。
   * 由 ResourceTable 渲染在自己的工具栏行里（`toolbarExtra`），因此手机上只有一行，不再有额外标题行/工具栏行。
   */
  const mobileActions = !loading && (
    <div className="flex shrink-0 items-center gap-1.5 md:hidden">
      <Button
        size="sm"
        onClick={() => navigate('/updates')}
        title="查看今天 / 昨天 / 前天的更新记录"
        className="h-7 shrink-0 gap-0.5 rounded-full bg-primary/10 px-1.5 text-[9px] font-medium text-primary hover:bg-primary/15"
      >
        <RefreshCcw className="h-2.5 w-2.5 shrink-0" />更新状态
      </Button>
      <Button
        size="sm"
        onClick={() => setAddOpen(true)}
        disabled={!isMembershipActive}
        className="h-7 shrink-0 gap-0.5 rounded-full bg-primary px-1.5 text-[9px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        <Plus className="h-2.5 w-2.5 shrink-0" />新增资源
      </Button>
    </div>
  );

  return (
    <AppLayout fixedHeight>
      <PageMeta
        title="网盘推广工具"
        description="影视资源管理中心，提供剧集、动漫、电影等资源的更新进度追踪、集数维护与跨站点批量同步功能。"
        keywords="资源管理, 影视更新, 剧集追踪, 完结归档, 链接管理"
      />
      {/* h-full：高度由布局壳的 fixedHeight 模式给出（100dvh 已扣掉顶栏/公告条），
          不再写死 calc(100vh-3.5rem) —— 那样在 iOS 会被地址栏吃掉一截、且漏算公告条 32px */}
      {/* JSON 导入用的隐藏文件选择器：放在最外层，确保手机端也能被按钮触发
          （若放进上面那个「仅桌面显示」的容器里，display:none 可能导致点不开选择器） */}
      <input
        ref={jsonFileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportJson}
      />
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* 手机端不再有独立标题行/工具栏行 —— 严格按设计稿：
            顶部展示位（banner）→ 更新中/已完结 → 「搜索 + 更新状态 + 新增资源 + 链接检测」一行 → 卡片列表。
            因此这里整块只在桌面端显示（桌面端原有布局不变）。 */}
        <div className="hidden items-center gap-2 border-b border-border bg-background px-4 py-2 shrink-0 md:flex md:px-8 md:py-4">
          {/* 占位，保证右侧按钮/文字仍然靠右 */}
          <div className="min-w-0 flex-1" />
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
            {/* 顶部展示位：管理员在「登录页配置」里填图片 URL；未配置时管理员看到引导入口 */}
            {homeBanner.url ? (
              <a
                href={homeBanner.link || undefined}
                target={homeBanner.link ? '_blank' : undefined}
                rel="noopener noreferrer"
                title={homeBanner.link ? '打开链接' : undefined}
                className={`block shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm ${
                  homeBanner.link ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <img src={homeBanner.url} alt="顶部展示位" className="h-32 w-full object-cover" />
              </a>
            ) : profile?.role === 'admin' ? (
              <Link
                to="/admin?tab=login-config"
                className="flex h-20 shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary md:h-24"
              >
                <ImagePlus className="h-4 w-4" />
                顶部展示位未配置 —— 点此在「登录页配置」里添加图片 URL
              </Link>
            ) : null}

            {/* 图文教程入口：有启用教程时对所有人展示；没有时仅管理员看到引导 */}
            {tutorials.length > 0 ? (
              <button
                type="button"
                onClick={() => setTutorialOpen(true)}
                title="查看图文教程"
                className="group flex shrink-0 items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-left shadow-sm transition-colors hover:border-primary/40"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <BookOpen className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-foreground">图文教程</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {tutorials[0].title || '查看使用说明'} · 共 {tutorials.length} 篇
                  </span>
                </span>
                <span className="hidden shrink-0 text-[11px] text-primary transition-opacity group-hover:opacity-100 sm:block sm:opacity-60">
                  查看 ›
                </span>
              </button>
            ) : profile?.role === 'admin' ? (
              <Link
                to="/admin?tab=tutorials"
                className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <BookOpen className="h-4 w-4" />
                还没有图文教程 —— 点此添加标题、正文与配图
              </Link>
            ) : null}

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
                toolbarExtra={mobileActions}
              />
            )}
          </div>

          {/* 右侧面板（已更新 / 已完结）：严格按设计稿，**手机端整块不显示** ——
              手机上的更新记录改由「更新状态」页（/updates）承载，
              否则这块会把卡片列表挤到几乎看不见（之前的实际问题）。桌面端保持原样。 */}
          <div className="hidden shrink-0 border-l border-border min-h-0 flex-col bg-card/40 md:flex md:w-80">
            {/* 标题行：剧集资源总数（桌面端在此；手机端在页面顶部） */}
            <div className="hidden shrink-0 items-center gap-2 px-3 pb-1 pt-2.5 md:flex">
              <h2 className="truncate text-sm font-semibold text-foreground">我的剧集资源</h2>
              {!loading && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{resources.length} 条</span>
              )}
            </div>
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
                  onOpenHistory={() => setHistoryOpen(true)}
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
        <TutorialDialog open={tutorialOpen} onOpenChange={setTutorialOpen} tutorials={tutorials} />
      </div>
    </AppLayout>
  );
}
