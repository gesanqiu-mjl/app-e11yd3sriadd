import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Trash2, Plus, Check, X, CloudIcon, Layers, Search, ImagePlus, Loader2, Link2, Link, RefreshCw, ShieldCheck, CircleCheck, RefreshCcw, AlertTriangle, GripVertical, Sparkles, FileJson, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
import {
  Resource, FIELD_LABELS, ResourceBinding, XnResourceBinding, YaResourceBinding,
  FramehdrResourceBinding, PanfxResourceBinding, MukakuResourceBinding, MukakuMovie,
  JyingResourceBinding, HdhavenResourceBinding, St1ResourceBinding,
} from '@/types/index';
import {
  updateResourceField, updateResourceCover, recordChange, deleteResource, importCoverFromUrl,
  fetchResourceBindings, updatePanLink, COOKIE_EXPIRED_CODE, PINGLIAN_LINK_NOT_FOUND_CODE, bindResourceToLink,
  fetchXnResourceBindings, syncResourceToXn, XN_COOKIE_EXPIRED_CODE, bindResourceToXnShare,
  fetchYaResourceBindings, syncResourceToYa, YA_EXPIRED_CODE, bindResourceToYa,
  fetchFramehdrResourceBindings, syncResourceToFramehdr, FRAMEHDR_COOKIE_EXPIRED_CODE, bindResourceToFramehdr,
  fetchPanfxResourceBindings, syncResourceToPanfx, PANFX_COOKIE_EXPIRED_CODE,
  getSt1ResourceBindings, updateSt1Resource, ST1_TOKEN_EXPIRED_CODE,
  fetchMukakuResourceBindings, syncResourceToMukaku, MUKAKU_TOKEN_EXPIRED_CODE, bindResourceToMukaku,
  fetchJyingResourceBindings, syncResourceToJying, JYING_EXPIRED_CODE, bindResourceToJying,
  fetchHdhavenResourceBindings, bindResourceToHdhavenBySlug, syncResourceToHdhaven,
  HDHAVEN_EXPIRED_CODE,
  HDHAVEN_CHALLENGE_REQUIRED_CODE,
  checkLinks, setResourceFinished, updateResourceSortOrders,
  fetchResources, fetchResourceSyncQueue, clearResourceSyncQueue,
} from '@/services/api';
import { AUTO_RELOGIN_SITES, ensureSiteSession, SITE_LABELS, type SiteKey } from '@/lib/siteCredentials';
import { importJsonText } from '@/lib/jsonImport';
import { downloadResourcesXlsx } from '@/lib/exportXlsx';
import { parseHdhavenMetaFromName } from '@/lib/hdhavenMeta';
import { uploadCover, deleteCover } from '@/lib/uploadCover';
import { matchLinkForPanType, PAN_TYPE_LABELS } from '@/lib/panUtils';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ResourceFormDialog from './ResourceFormDialog';
import BatchImportDialog from './BatchImportDialog';
import BindDialog from './BindDialog';
import ManageLinksDialog from './ManageLinksDialog';
import QuickBindDialog, { type SiteBindingPayload } from './QuickBindDialog';
import ResourceCardList from './ResourceCardList';

/**
 * 鸭影臻藏推送开关。
 * 站点账号绑定 UI 已下线；按需求「保留数据但停止推送」：库里 ya_resource_bindings 一条不动，
 * 只是资源改名/换链接不再推给鸭影。要恢复推送把它改回 true 即可（后端 worker 里的 PUSH_YA 同步改）。
 */
const YA_PUSH_ENABLED = false;

interface EditState {
  rowId: string;
  field: string;
  value: string;
}

/** 可排序行：useSortable + ContextMenu 组合，仅手柄可发起拖拽（PointerSensor 鼠标+触屏通用） */
function SortableResourceRow({
  resource, disabled, rowClass, onRowClick, menuContent, children,
}: {
  resource: Resource;
  disabled: boolean;
  rowClass: string;
  onRowClick: (e: React.MouseEvent) => void;
  menuContent: React.ReactNode;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: resource.id,
    disabled,
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          ref={setNodeRef}
          data-testid="sortable-row"
          style={transform ? { transform: CSS.Translate.toString(transform), transition } : undefined}
          className={`${rowClass} ${isDragging ? 'opacity-50 relative z-10 shadow-lg' : ''}`}
          onClick={onRowClick}
        >
          {/* 拖拽手柄：唯一拖拽激活器 */}
          <td className="w-6 md:w-8 px-0 py-1 align-middle text-center"
            onClick={(e) => e.stopPropagation()}>
            {!disabled && (
              <span
                ref={setActivatorNodeRef}
                data-testid="drag-handle"
                className="inline-flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none"
                {...attributes}
                {...listeners}
              >
                <GripVertical className="h-3.5 w-3.5" />
              </span>
            )}
          </td>
          {children}
        </tr>
      </ContextMenuTrigger>
      {menuContent}
    </ContextMenu>
  );
}

interface ResourceTableProps {
  resources: Resource[];
  onResourcesChange: (resources: Resource[]) => void;
  onResourceUpdated: (resource: Resource, fieldLabel: string) => void;
  onResourceAdded: (resource: Resource) => void;
  onSyncResult?: (resourceId: string, errors: { site: string; reason: string }[]) => void;
  readOnly?: boolean;
  // 受控：供父组件在手机端头部触发弹窗
  addOpen: boolean;
  onAddOpenChange: (v: boolean) => void;
  batchOpen: boolean;
  onBatchOpenChange: (v: boolean) => void;
  /**
   * 手机端工具栏追加内容（由 HomePage 传入：更新状态 / 新增资源 / 更多）。
   * 设计稿里这些按钮与「搜索框」在同一行，所以交给本组件渲染，手机端不再多占一行。
   */
  toolbarExtra?: React.ReactNode;
}

// colClass 在 th/td 上使用，手机端隐藏「链接」列，桌面端恢复
const COLUMNS: Array<{ key: keyof Resource; label: string; colClass: string; editable: boolean }> = [
  { key: 'name', label: '资源名称', colClass: '', editable: true },
  { key: 'episode_count', label: '集数', colClass: 'w-10 md:min-w-16', editable: true },
  { key: 'links', label: '链接', colClass: 'hidden md:table-cell md:min-w-48', editable: false },
];

function ResourceTable({
  resources,
  onResourcesChange,
  onResourceUpdated,
  onResourceAdded,
  onSyncResult,
  readOnly = false,
  addOpen,
  onAddOpenChange,
  batchOpen,
  onBatchOpenChange,
  toolbarExtra,
}: ResourceTableProps) {
  const [editState, setEditState] = useState<EditState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [finishTab, setFinishTab] = useState<'updating' | 'finished'>('updating');
  // JSON 资源包导入（兼容「完整导出包」与「裸数组」两种形态）
  const [importingJson, setImportingJson] = useState(false);
  const [importJsonProgress, setImportJsonProgress] = useState({ done: 0, total: 0 });
  // XLSX 导出（含封面抓取，耗时较长，需要禁用按钮并显示进度态）
  const [exporting, setExporting] = useState(false);
  // 封面加载失败的资源（多为旧环境地址已失效），降级为占位按钮，避免显示破图
  const [brokenCovers, setBrokenCovers] = useState<Record<string, boolean>>({});
  const jsonFileRef = useRef<HTMLInputElement>(null);
  // 行多选（用于右键批量操作）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [checkingLinks, setCheckingLinks] = useState(false);
  // 链接检测分片进度（done/total），检测期间在按钮上展示
  const [checkProgress, setCheckProgress] = useState({ done: 0, total: 0 });
  // 手机端（触屏）需双击才触发编辑，防止滚动误触
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  useEffect(() => {
    setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);
  const [manageLinksTarget, setManageLinksTarget] = useState<Resource | null>(null);
  const [manageLinksOpen, setManageLinksOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);

  // 盘链绑定关系（一个资源可绑定多条站点记录，按网盘类型分别同步）
  const [bindings, setBindings] = useState<Record<string, ResourceBinding[]>>({});
  // 观影站点绑定关系（一个资源可绑定多条分享，按网盘标签分别同步）
  const [xnBindings, setXnBindings] = useState<Record<string, XnResourceBinding[]>>({});
  // 鸭影臻藏绑定关系（一个资源可绑定多条片源，按网盘标签分别同步）
  const [yaBindings, setYaBindings] = useState<Record<string, YaResourceBinding[]>>({});
  // 帧影站点绑定关系
  const [framehdrBindings, setFramehdrBindings] = useState<Record<string, FramehdrResourceBinding>>({});
  // 123社区绑定关系
  const [panfxBindings, setPanfxBindings] = useState<Record<string, PanfxResourceBinding>>({});
  // 1号站点绑定关系（一个资源绑定站点上的一条片源）
  const [st1Bindings, setSt1Bindings] = useState<Record<string, St1ResourceBinding>>({});
  // 不太灵站点绑定关系
  const [mukakuBindings, setMukakuBindings] = useState<Record<string, MukakuResourceBinding[]>>({});
  // 聚影站点绑定关系（一个资源可绑定多条：每条对应一种网盘）
  const [jyingBindings, setJyingBindings] = useState<Record<string, JyingResourceBinding[]>>({});
  // 栖影站点绑定关系（一个资源可绑定多条：每条对应一种网盘）
  const [hdhavenBindings, setHdhavenBindings] = useState<Record<string, HdhavenResourceBinding[]>>({});
  const [bindTarget, setBindTarget] = useState<Resource | null>(null);
  const [bindOpen, setBindOpen] = useState(false);
  const [quickBindTarget, setQuickBindTarget] = useState<Resource | null>(null);
  const [quickBindOpen, setQuickBindOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // 订阅在服务端改了资源（集数等）后会往 resource_sync_queue 登记一条待推送任务：
  // 站点推送依赖用户会话与各站点的自动重登 / 链接匹配，只能在前端做，所以打开本页时自动补推。
  const [bindingsReady, setBindingsReady] = useState(false);
  const syncQueueDrained = useRef(false);
  useEffect(() => {
    if (!bindingsReady || syncQueueDrained.current || resources.length === 0) return;
    syncQueueDrained.current = true;
    (async () => {
      const tasks = await fetchResourceSyncQueue();
      if (tasks.length === 0) return;
      const finished: string[] = [];
      for (const t of tasks) {
        const res = resources.find((r) => r.id === t.resource_id);
        if (!res) { finished.push(t.id); continue; } // 资源已被删除 → 任务作废
        try {
          await syncToSite(res);
          finished.push(t.id);
        } catch {
          // 推送失败就保留任务，下次打开本页再补推
        }
      }
      await clearResourceSyncQueue(finished);
      if (finished.length > 0) toast.success(`已把 ${finished.length} 条订阅产生的变更同步到站点`);
    })().catch(() => { /* 静默：下次打开再试 */ });
  }, [bindingsReady, resources]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchResourceBindings().catch(() => [] as ResourceBinding[]),
      fetchXnResourceBindings().catch(() => [] as XnResourceBinding[]),
      fetchYaResourceBindings().catch(() => [] as YaResourceBinding[]),
      fetchFramehdrResourceBindings().catch(() => [] as FramehdrResourceBinding[]),
      fetchPanfxResourceBindings().catch(() => [] as PanfxResourceBinding[]),
      fetchMukakuResourceBindings().catch(() => [] as MukakuResourceBinding[]),
      fetchJyingResourceBindings().catch(() => [] as JyingResourceBinding[]),
      fetchHdhavenResourceBindings().catch(() => [] as HdhavenResourceBinding[]),
      getSt1ResourceBindings().catch(() => [] as St1ResourceBinding[]),
    ]).then(([list, xnList, yaList, framehdrList, panfxList, mukakuList, jyingList, hdhavenList, st1List]) => {
      if (cancelled) return;
      const map: Record<string, ResourceBinding[]> = {};
      list.forEach((b) => { (map[b.resource_id] ??= []).push(b); });
      setBindings(map);
      const xnMap: Record<string, XnResourceBinding[]> = {};
      xnList.forEach((b) => { (xnMap[b.resource_id] ??= []).push(b); });
      setXnBindings(xnMap);
      const yaMap: Record<string, YaResourceBinding[]> = {};
      yaList.forEach((b) => { (yaMap[b.resource_id] ??= []).push(b); });
      setYaBindings(yaMap);
      const framehdrMap: Record<string, FramehdrResourceBinding> = {};
      framehdrList.forEach((b) => { framehdrMap[b.resource_id] = b; });
      setFramehdrBindings(framehdrMap);
      const panfxMap: Record<string, PanfxResourceBinding> = {};
      panfxList.forEach((b) => { panfxMap[b.resource_id] = b; });
      setPanfxBindings(panfxMap);
      const st1Map: Record<string, St1ResourceBinding> = {};
      st1List.forEach((b) => { st1Map[b.resource_id] = b; });
      setSt1Bindings(st1Map);
      const mukakuMap: Record<string, MukakuResourceBinding[]> = {};
      mukakuList.forEach((b) => { (mukakuMap[b.resource_id] ??= []).push(b); });
      setMukakuBindings(mukakuMap);
      const jyingMap: Record<string, JyingResourceBinding[]> = {};
      jyingList.forEach((b) => { (jyingMap[b.resource_id] ??= []).push(b); });
      setJyingBindings(jyingMap);
      const hdhavenMap: Record<string, HdhavenResourceBinding[]> = {};
      hdhavenList.forEach((b) => { (hdhavenMap[b.resource_id] ??= []).push(b); });
      setHdhavenBindings(hdhavenMap);
      setBindingsReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Tab 过滤（更新中 / 已完结），再叠加搜索过滤
  const tabFiltered = finishTab === 'finished'
    ? resources.filter((r) => r.is_finished)
    : resources.filter((r) => !r.is_finished);

  const filtered = search.trim()
    ? tabFiltered.filter((r) => {
        const q = search.trim().toLowerCase();
        return (
          r.name?.toLowerCase().includes(q) ||
          r.link?.toLowerCase().includes(q) ||
          (Array.isArray(r.links) && r.links.some((l) => l.url?.toLowerCase().includes(q) || l.pan_name?.toLowerCase().includes(q)))
        );
      })
    : tabFiltered;

  // 全选状态（仅针对当前 tab 可见行）
  const allSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));
  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.id)));
    }
  }
  function toggleSelectOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** 将选中行（或指定行）移动到已完结 / 移回更新中 */
  async function handleMoveToFinished(targetIds: string[], finished: boolean) {
    const label = finished ? '已完结' : '更新中';
    try {
      await Promise.all(targetIds.map((id) => setResourceFinished(id, finished)));
      onResourcesChange(
        resources.map((r) => targetIds.includes(r.id) ? { ...r, is_finished: finished } : r)
      );
      setSelectedIds(new Set());
      toast.success(`已移动 ${targetIds.length} 条资源到「${label}」`);
    } catch {
      toast.error('移动失败，请重试');
    }
  }

  useEffect(() => {
    if (editState && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editState?.rowId, editState?.field]);

  function startEdit(rowId: string, field: string, currentValue: string | number) {
    if (readOnly) return;
    setEditState({ rowId, field, value: String(currentValue) });
  }

  async function saveEdit() {
    if (!editState) return;
    const resource = resources.find((r) => r.id === editState.rowId);
    if (!resource) { setEditState(null); return; }

    const originalValue = String(resource[editState.field as keyof Resource] ?? '');
    const newValue = editState.value.trim();

    // 集数非法数字校验
    if (editState.field === 'episode_count' && newValue !== '' && !/^\d+$/.test(newValue)) {
      toast.error('请输入有效的集数（纯数字）');
      setEditState(null);
      return;
    }

    setEditState(null);
    if (originalValue === newValue) return;

    const parsedValue =
      editState.field === 'episode_count' ? parseInt(newValue) || 0 : newValue;

    try {
      let newResource: Resource;
      // 修改集数且名称含「第N集」时，同步替换名称中的集数文本，
      // 保证表格、已更新面板、站点同步标题三处一致
      if (
        editState.field === 'episode_count' &&
        /第\s*\d+\s*集/.test(resource.name ?? '')
      ) {
        const newName = resource.name.replace(/第\s*\d+\s*集/, `第${parsedValue}集`);
        await updateResourceField(editState.rowId, 'name', newName);
        await recordChange({
          resource_id: editState.rowId,
          resource_name: newName,
          field_name: 'name',
          field_label: FIELD_LABELS.name ?? 'name',
          old_value: resource.name,
          new_value: newName,
        });
        newResource = { ...resource, episode_count: parsedValue as number, name: newName };
      } else {
        newResource = { ...resource, [editState.field]: parsedValue };
      }

      const updated = await updateResourceField(editState.rowId, editState.field, parsedValue);
      if (updated) {
        await recordChange({
          resource_id: editState.rowId,
          resource_name: newResource.name,
          field_name: editState.field,
          field_label: FIELD_LABELS[editState.field] ?? editState.field,
          old_value: originalValue,
          new_value: String(parsedValue),
        });
        const newResources = resources.map((r) =>
          r.id === editState.rowId ? newResource : r
        );
        onResourcesChange(newResources);
        onResourceUpdated(
          newResource,
          FIELD_LABELS[editState.field] ?? editState.field
        );
        toast.success('已保存，已记录到更新栏');
        // 已绑定的资源自动同步到站点
        syncToSite(newResource);
      }
    } catch {
      toast.error('保存失败，请重试');
    }
  }

  function cancelEdit() { setEditState(null); }

  /** 同步已绑定资源到所有已绑定站点（名称/集数/链接变更时） */
  async function syncToSite(resource: Resource) {
    const pinglianList = bindings[resource.id] ?? [];
    const xnList = xnBindings[resource.id] ?? [];
    const yaList = yaBindings[resource.id] ?? [];
    const fhB = framehdrBindings[resource.id];
    const pfxB = panfxBindings[resource.id];
    const st1B = st1Bindings[resource.id];
    const mukList = mukakuBindings[resource.id] ?? [];
    const jyingList = jyingBindings[resource.id] ?? [];
    const hdhavenList = hdhavenBindings[resource.id] ?? [];
    if (pinglianList.length === 0 && xnList.length === 0 && yaList.length === 0 && !fhB && !pfxB && !st1B && mukList.length === 0 && jyingList.length === 0 && hdhavenList.length === 0) return;
    setSyncingId(resource.id);

    // 命中这些错误码代表「站点会话失效」：先尝试用云端凭据自动重登，再重试一次
    const RELOGIN_TRIGGER_CODES = new Set<string | undefined>([
      COOKIE_EXPIRED_CODE,
      XN_COOKIE_EXPIRED_CODE,
      YA_EXPIRED_CODE,
      FRAMEHDR_COOKIE_EXPIRED_CODE,
      PANFX_COOKIE_EXPIRED_CODE,
      ST1_TOKEN_EXPIRED_CODE,
      MUKAKU_TOKEN_EXPIRED_CODE,
      HDHAVEN_EXPIRED_CODE,
    ]);

    /** 会话失效时用云端保存的账号密码自动重登，返回是否已恢复可用 */
    const tryAutoRelogin = async (site: SiteKey): Promise<boolean> => {
      if (!AUTO_RELOGIN_SITES.includes(site)) return false;
      try {
        const r = await ensureSiteSession(site);
        if (r.status === 'relogged' || r.status === 'ok') {
          toast.success(`已自动重新登录「${SITE_LABELS[site]}」，正在重试同步`);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    // 单站同步失败自动重试：最多尝试 3 次（间隔递增），
    // 登录过期类错误不盲目重试——先自动重登，成功则重试，仍失败再抛出
    const syncWithRetry = async <T,>(fn: () => Promise<T>, site?: SiteKey): Promise<T> => {
      const maxAttempts = 3;
      let lastErr: unknown = null;
      let reloginTried = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (e) {
          const err = e as Error & { code?: string };
          if (RELOGIN_TRIGGER_CODES.has(err.code)) {
            // 会话失效：自动重登一次后重试，避免「必须手动去站点同步页重登」导致同步失败
            if (site && !reloginTried) {
              reloginTried = true;
              if (await tryAutoRelogin(site)) continue;
            }
            throw err;
          }
          if (
            err.code === PINGLIAN_LINK_NOT_FOUND_CODE ||
            // 栖影有请求频率风控：命中图形验证码门时重试无意义且会加剧风控
            err.code === HDHAVEN_CHALLENGE_REQUIRED_CODE
          ) {
            throw err;
          }
          lastErr = e;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 600 * attempt));
          }
        }
      }
      // 3 次尝试后仍失败：包装错误信息注明已重试
      if (lastErr instanceof Error) {
        throw new Error(`${lastErr.message}（已自动重试 ${maxAttempts} 次仍失败）`);
      }
      throw lastErr ?? new Error('同步失败');
    };

    const title = /第\s*\d+\s*集/.test(resource.name)
      ? resource.name.replace(/第\s*\d+\s*集/, `第${resource.episode_count}集`)
      : resource.name;
    const panUrl = resource.link ?? '';

    const succeededSites: string[] = [];
    const failedSites: { site: string; reason: string }[] = [];

    // 盘链：逐条绑定记录串行同步，多链接时按网盘类型匹配对应链接。
    // 同一盘链 session 的请求必须串行发送——PHP 站点有 session 文件锁，
    // 并发会导致后到请求被阻塞拿到异常响应，被误判为登录过期
    for (const b of pinglianList) {
      const panLabel = PAN_TYPE_LABELS[b.pan_type ?? ''] ?? b.pan_type ?? '对应网盘';
      const matchedUrl = matchLinkForPanType(
        b.pan_type,
        Array.isArray(resource.links) ? resource.links : [],
        resource.link ?? ''
      );
      if (!matchedUrl) {
        failedSites.push({
          site: `盘链·${panLabel}`,
          reason: `资源中没有「${panLabel}」类型的链接，未同步该条记录`,
        });
        continue;
      }
      try {
        const upd = await syncWithRetry(() => updatePanLink({
          link_id: b.link_id,
          link_title: title,
          link_url: matchedUrl,
          link_password: b.link_password ?? '',
          pan_type: b.pan_type ?? 'others',
        }), 'pinglian');
        // 站点改版后旧 link_id 失效：服务端自动迁移成功时返回新 ID，本地同步更新
        const remappedId =
          typeof upd?.data?.id === 'number' && upd.data.id !== b.link_id ? upd.data.id : null;
        if (!succeededSites.includes('盘链')) succeededSites.push('盘链');
        setBindings((prev) => ({
          ...prev,
          [resource.id]: (prev[resource.id] ?? []).map((x) =>
            x.link_id === b.link_id
              ? { ...x, link_title: title, ...(remappedId != null ? { link_id: remappedId } : {}) }
              : x
          ),
        }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === COOKIE_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新登录'
          : err.code === PINGLIAN_LINK_NOT_FOUND_CODE
          ? '该绑定在站点已失效（站点已改版），请解绑后重新绑定'
          : (err.message || '未知错误');
        failedSites.push({ site: `盘链·${panLabel}`, reason });
      }
    }
    // 全站串行同步：盘链完成后依次执行观影 → 鸭影 → 帧影 → 123社区，
    // 一条接一条顺序提交，避免并发请求触发站点会话锁/限流

    // 观影站点：逐条分享记录串行同步，多链接时按网盘标签匹配对应链接
    for (const xnB of xnList) {
      const matchedUrl = matchLinkForPanType(
        xnB.pan_label,
        Array.isArray(resource.links) ? resource.links : [],
        resource.link ?? ''
      );
      const xnLabel = xnB.pan_label || '未识别网盘';
      if (!matchedUrl) {
        failedSites.push({
          site: `观影·${xnLabel}`,
          reason: `资源中没有「${xnLabel}」类型的链接，未同步该条分享`,
        });
        continue;
      }
      try {
        await syncWithRetry(() => syncResourceToXn({ shareId: xnB.share_id, newTitle: title, panUrl: matchedUrl }), 'xn');
        if (!succeededSites.includes('观影站点')) succeededSites.push('观影站点');
        setXnBindings((prev) => ({
          ...prev,
          [resource.id]: (prev[resource.id] ?? []).map((x) =>
            x.share_id === xnB.share_id ? { ...x, share_title: title } : x
          ),
        }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === XN_COOKIE_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新绑定 Cookie'
          : (err.message || '未知错误');
        failedSites.push({ site: `观影·${xnLabel}`, reason });
      }
    }

    // 鸭影臻藏：站点账号绑定入口已下线，按需求「保留数据但停止推送」。
    // 绑定记录（ya_resource_bindings）原样保留，把 YA_PUSH_ENABLED 改回 true 即可恢复同步。
    for (const yaB of (YA_PUSH_ENABLED ? yaList : [])) {
      const matchedUrl = matchLinkForPanType(
        yaB.pan_label,
        Array.isArray(resource.links) ? resource.links : [],
        resource.link ?? ''
      );
      const yaLabel = yaB.pan_label || '未识别网盘';
      if (!matchedUrl) {
        failedSites.push({
          site: `鸭影·${yaLabel}`,
          reason: `资源中没有「${yaLabel}」类型的链接，未同步该条片源`,
        });
        continue;
      }
      try {
        await syncWithRetry(() => syncResourceToYa({ linkId: yaB.link_id, newTitle: title, panUrl: matchedUrl }));
        if (!succeededSites.includes('鸭影臻藏')) succeededSites.push('鸭影臻藏');
        setYaBindings((prev) => ({
          ...prev,
          [resource.id]: (prev[resource.id] ?? []).map((x) =>
            x.link_id === yaB.link_id ? { ...x, link_title: title } : x
          ),
        }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === YA_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新绑定账号'
          : (err.message || '未知错误');
        failedSites.push({ site: `鸭影·${yaLabel}`, reason });
      }
    }

    if (fhB && panUrl) {
      try {
        await syncWithRetry(() => syncResourceToFramehdr({ linkId: fhB.link_id, panUrl, driveName: fhB.drive_name, description: title }), 'framehdr');
        succeededSites.push('帧影站点');
        setFramehdrBindings((prev) => ({ ...prev, [resource.id]: { ...fhB, link_title: title } }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === FRAMEHDR_COOKIE_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新绑定 Cookie'
          : (err.message || '未知错误');
        failedSites.push({ site: '帧影站点', reason });
      }
    }

    if (pfxB && panUrl) {
      try {
        await syncWithRetry(() => syncResourceToPanfx({
          tid: pfxB.tid,
          panUrl,
          title,
          firstpid: pfxB.firstpid,
          fid: pfxB.fid,
        }), 'panfx');
        succeededSites.push('123社区');
        setPanfxBindings((prev) => ({ ...prev, [resource.id]: { ...pfxB, subject: title } }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === PANFX_COOKIE_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新绑定 Cookie'
          : (err.message || '未知错误');
        failedSites.push({ site: '123社区', reason });
      }
    }

    // 1号站点同步：绑定的是站点上已存在的片源，用 PATCH 局部更新标题与网盘地址
    if (st1B && panUrl) {
      try {
        await syncWithRetry(() => updateSt1Resource({
          remoteId: st1B.remote_id,
          title,
          panUrl,
        }), 'st1');
        succeededSites.push('1号站点');
        setSt1Bindings((prev) => ({ ...prev, [resource.id]: { ...st1B, title } }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === ST1_TOKEN_EXPIRED_CODE
          ? '令牌已失效，请到「站点同步」页重新绑定令牌'
          : (err.message || '未知错误');
        failedSites.push({ site: '1号站点', reason });
      }
    }

    // 不太灵站点同步（支持同部剧绑定多条不同网盘记录）
    for (const mukB of mukList) {
      const panLabel = PAN_TYPE_LABELS[mukB.pan_type ?? ''] ?? mukB.pan_type ?? '对应网盘';
      const matchedUrl = matchLinkForPanType(
        mukB.pan_type,
        Array.isArray(resource.links) ? resource.links : [],
        resource.link ?? ''
      );
      if (!matchedUrl) {
        failedSites.push({
          site: `不太灵站点 (${mukB.seed_name || `#${mukB.link_id}`})`,
          reason: `资源中没有「${panLabel}」类型的链接，未同步该条记录`,
        });
        continue;
      }
      try {
        await syncWithRetry(() => syncResourceToMukaku({
          linkId: mukB.link_id,
          moviesId: mukB.movies_id,
          newTitle: title,
          panUrl: matchedUrl,
          shareCode: mukB.share_code || undefined,
        }), 'mukaku');
        succeededSites.push('不太灵站点');
        setMukakuBindings((prev) => {
          const list = prev[resource.id] ?? [];
          return {
            ...prev,
            [resource.id]: list.map((x) => (x.link_id === mukB.link_id ? { ...x, seed_name: title } : x)),
          };
        });
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === MUKAKU_TOKEN_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新登录'
          : (err.message || '未知错误');
        failedSites.push({ site: `不太灵站点 (${mukB.seed_name || `#${mukB.link_id}`})`, reason });
      }
    }

    // 聚影站点同步：为「修改已有分享」语义 —— 逐条把已绑定分享的链接
    // 替换为本地资源中「同网盘类型」的链接（聚影没有新建分享的批量接口）
    for (const jyB of jyingList) {
      const jyLabel = jyB.pan_label || '对应网盘';
      const matchedUrl = matchLinkForPanType(
        jyB.pan_label,
        Array.isArray(resource.links) ? resource.links : [],
        resource.link ?? ''
      );
      if (!matchedUrl) {
        failedSites.push({
          site: `聚影·${jyLabel}`,
          reason: `资源中没有「${jyLabel}」类型的链接，未同步该条分享`,
        });
        continue;
      }
      try {
        await syncWithRetry(() => syncResourceToJying({ linkId: jyB.link_id, panUrl: matchedUrl }));
        if (!succeededSites.includes('聚影站点')) succeededSites.push('聚影站点');
        setJyingBindings((prev) => ({
          ...prev,
          [resource.id]: (prev[resource.id] ?? []).map((x) =>
            x.link_id === jyB.link_id ? { ...x, link_title: title } : x
          ),
        }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === JYING_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新登录'
          : (err.message || '未知错误');
        failedSites.push({ site: `聚影·${jyLabel}`, reason });
      }
    }

    // 栖影站点同步：同样是「修改已有分享」语义 —— 逐条把已绑定分享的链接替换为
    // 本地资源中「同网盘类型」的链接（栖影没有新建分享的接口，只能改已有分享）。
    // 站点有频率风控，服务端已限速，这里保持串行逐条提交
    for (const hdB of hdhavenList) {
      const hdLabel = hdB.pan_label || hdB.pan_type || '对应网盘';
      const matchedUrl = matchLinkForPanType(
        hdB.pan_type || hdB.pan_label,
        Array.isArray(resource.links) ? resource.links : [],
        resource.link ?? ''
      );
      if (!matchedUrl) {
        failedSites.push({
          site: `栖影·${hdLabel}`,
          reason: `资源中没有「${hdLabel}」类型的链接，未同步该条分享`,
        });
        continue;
      }
      try {
        await syncWithRetry(() => syncResourceToHdhaven({
          slug: hdB.slug,
          panUrl: matchedUrl,
          panType: hdB.pan_type ?? undefined,
          // 站点 update 是「全量字段回写」：把本地标题与按名称解析出的属性一起同步，
          // 否则站点侧分享标题/属性永远不变（此前只发 URL 的 bug）
          title,
          meta: parseHdhavenMetaFromName(title, {
            isTv: hdB.media_type ? hdB.media_type === 'tv' : (resource.episode_count ?? 0) > 1,
            episodeCount: resource.episode_count ?? null,
          }),
        }), 'hdhaven');
        succeededSites.push('栖影站点');
        setHdhavenBindings((prev) => ({
          ...prev,
          [resource.id]: (prev[resource.id] ?? []).map((x) =>
            x.slug === hdB.slug ? { ...x, link_title: title } : x
          ),
        }));
      } catch (e) {
        const err = e as Error & { code?: string };
        const reason = err.code === HDHAVEN_EXPIRED_CODE
          ? '登录已过期，请到「站点同步」页重新登录'
          : err.code === HDHAVEN_CHALLENGE_REQUIRED_CODE
            ? '触发站点图形验证码风控，请先到 hdhaven.com 完成验证后重试'
            : (err.message || '未知错误');
        failedSites.push({ site: `栖影·${hdLabel}`, reason });
      }
    }

    if (succeededSites.length > 0) {
      toast.success(`已同步到 ${[...new Set(succeededSites)].join('、')}：${title}`);
    }
    if (failedSites.length > 0) {
      const failMsg = failedSites.map((f) => `${f.site}：${f.reason}`).join('\n');
      toast.warning(`${failedSites.length} 条同步失败\n${failMsg}`, { duration: 8000 });
    }
    onSyncResult?.(resource.id, failedSites);
    setSyncingId(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') cancelEdit();
  }

  /** dnd-kit：PointerSensor（鼠标+触屏统一） */
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    })
  );

  function handleDragStart(_e: DragStartEvent) {
    // 拖拽开始（可用于后续扩展：高亮可放置区域）
  }

  /** 拖拽结束：重排序并持久化（target = 松手时最近的可排序行） */
  async function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const srcIdx = tabFiltered.findIndex((r) => r.id === active.id);
    const tgtIdx = tabFiltered.findIndex((r) => r.id === over.id);
    if (srcIdx < 0 || tgtIdx < 0) return;
    // 在 tabFiltered 中移动，保留 non-tab 资源位置
    const reordered = [...tabFiltered];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    // 重新分配 sort_order（步长 10，为后续插入预留空间）
    const updates = reordered.map((r, i) => ({ id: r.id, sort_order: (i + 1) * 10 }));
    // 乐观更新本地状态
    const updatesMap = new Map(updates.map((u) => [u.id, u.sort_order]));
    onResourcesChange(resources.map((r) => updatesMap.has(r.id) ? { ...r, sort_order: updatesMap.get(r.id)! } : r));
    try {
      await updateResourceSortOrders(updates);
    } catch {
      toast.error('排序保存失败，请刷新重试');
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const resource = resources.find((r) => r.id === id);
      if (resource?.cover_url) await deleteCover(resource.cover_url).catch(() => {});
      await deleteResource(id);
      // 同步清理本地绑定状态（DB 外键 ON DELETE CASCADE 已自动删行）
      setBindings((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setYaBindings((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPanfxBindings((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      onResourcesChange(resources.filter((r) => r.id !== id));
      toast.success('已删除');
    } catch {
      toast.error('删除失败');
    } finally {
      setDeletingId(null);
    }
  }

  /**
   * 导出资源清单为 XLSX（标题 / 封面图片 / 网盘链接（带云盘名称）/ 状态）。
   * 勾选了资源时只导出勾选的，未勾选的不纳入导出；一条都没勾选时导出全部。
   */
  async function handleExportXlsx() {
    const targets = selectedIds.size > 0
      ? resources.filter((r) => selectedIds.has(r.id))
      : resources;
    if (targets.length === 0) {
      toast.info('当前没有可导出的资源');
      return;
    }
    setExporting(true);
    try {
      const result = await downloadResourcesXlsx(targets);
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
      setExporting(false);
    }
  }

  /**
   * 导入 JSON 资源包：兼容「完整导出包」与「裸数组」两种形态。
   * 与批量导入（粘贴文本、靠解析）互补 —— 这条用于迁移/恢复导出的数据，
   * 完整保留封面、网盘链接、完结状态等字段。
   */
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
      // 批量写入后直接以服务端结果重建列表，避免本地拼接的顺序与 sort_order 不一致
      onResourcesChange(await fetchResources());
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

  async function handleCheckLinks() {
    const targets = filtered.filter((r) => r.link || (r.links && r.links.length > 0));
    if (targets.length === 0) {
      toast.info('当前没有可检测链接的资源');
      return;
    }
    setCheckingLinks(true);
    setCheckProgress({ done: 0, total: targets.length });
    try {
      const { results, failedChunks } = await checkLinks(
        targets.map((r) => r.id),
        (done, total) => setCheckProgress({ done, total })
      );
      const map = new Map(results.map((r) => [r.id, r]));
      onResourcesChange(
        resources.map((r) => {
          const res = map.get(r.id);
          if (!res) return r;
          const urlValid = new Map(res.linkResults.map((l) => [l.url, l.valid]));
          const links = (Array.isArray(r.links) ? r.links : []).map((l) => ({
            ...l,
            status: urlValid.has(l.url) ? (urlValid.get(l.url) ? 'valid' : 'invalid') : l.status,
            checked_at: res.checkedAt,
          }));
          return {
            ...r,
            link_status: res.status,
            link_checked_at: res.checkedAt,
            links,
          };
        })
      );
      const invalid = results.filter((r) => r.status === 'invalid').length;
      const partial = results.filter((r) => r.status === 'partial').length;
      if (failedChunks > 0) {
        // 部分批次超时：已检测的结果照常展示，并提示重试剩余部分
        toast.warning(
          `已检测 ${results.length} 条（${invalid} 条全部失效${partial > 0 ? `、${partial} 条部分失效` : ''}），` +
            `另有 ${failedChunks} 批因外站响应过慢超时，请稍后重试`,
          { duration: 8000 }
        );
      } else if (invalid > 0) {
        toast.error(`检测完成：${invalid} 条资源链接已全部失效${partial > 0 ? `，${partial} 条部分失效` : ''}`);
      } else if (partial > 0) {
        toast.warning(`检测完成：${partial} 条资源存在部分失效链接`);
      } else {
        toast.success(`检测完成：${results.length} 条资源链接均有效`);
      }
    } catch (e) {
      toast.error((e as Error).message || '链接检测失败');
    } finally {
      setCheckingLinks(false);
      setCheckProgress({ done: 0, total: 0 });
    }
  }

  function triggerCoverUpload(resourceId: string) {
    if (readOnly) return;
    uploadTargetRef.current = resourceId;
    fileInputRef.current?.click();
  }

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const resourceId = uploadTargetRef.current;
    e.target.value = '';
    if (!file || !resourceId) return;
    await doUpload(file, resourceId);
  }, [resources, onResourcesChange, onResourceUpdated]); // eslint-disable-line

  const doUpload = useCallback(async (file: File, resourceId: string) => {
    const resource = resources.find((r) => r.id === resourceId);
    if (!resource) return;

    setUploadingId(resourceId);
    setUploadProgress(0);
    try {
      if (resource.cover_url) await deleteCover(resource.cover_url).catch(() => {});
      const result = await uploadCover(file, resourceId, setUploadProgress);
      const updated = await updateResourceCover(resourceId, result.url);
      if (updated) {
        const newResources = resources.map((r) =>
          r.id === resourceId ? { ...r, cover_url: result.url } : r
        );
        onResourcesChange(newResources);
        onResourceUpdated({ ...resource, cover_url: result.url }, '封面');
        // 新封面上传成功后清掉「失效」标记，恢复正常展示
        setBrokenCovers((prev) => {
          if (!prev[resourceId]) return prev;
          const next = { ...prev };
          delete next[resourceId];
          return next;
        });
        // 封面已按规格归一化：提示最终版式与体积
        const msg = `封面已上传（${result.orientation === 'landscape' ? '横版' : '竖版'} ${result.width}×${result.height}，${(result.finalSize / 1024).toFixed(0)} KB）`;
        toast.success(msg);
      }
    } catch (err) {
      toast.error((err as Error).message || '封面上传失败，请重试');
    } finally {
      setUploadingId(null);
      setUploadProgress(0);
    }
  }, [resources, onResourcesChange, onResourceUpdated]);

  async function handleRemoveCover(resource: Resource) {
    if (readOnly) return;
    if (!resource.cover_url) return;
    try {
      await deleteCover(resource.cover_url);
      await updateResourceCover(resource.id, null);
      onResourcesChange(resources.map((r) =>
        r.id === resource.id ? { ...r, cover_url: null } : r
      ));
      toast.success('封面已删除');
    } catch {
      toast.error('封面删除失败');
    }
  }

  function renderCell(resource: Resource, col: (typeof COLUMNS)[number]) {
    const isEditing = editState?.rowId === resource.id && editState?.field === col.key;
    const rawValue = resource[col.key];
    // links 是数组，不参与内联编辑，displayValue 只用于可编辑的标量字段
    const scalarValue = typeof rawValue === 'string' || typeof rawValue === 'number' ? rawValue : '';
    const displayValue = String(scalarValue);

    if (isEditing) {
      const isEpisode = col.key === 'episode_count';
      return (
        <div className={`flex items-center gap-1 ${isEpisode ? 'absolute left-1 top-1/2 -translate-y-1/2 z-20 w-28 bg-card rounded shadow-md border border-border px-1 py-0.5' : 'w-full'}`}>
          <Input
            ref={inputRef}
            value={editState.value}
            onChange={(e) => setEditState((s) => s && { ...s, value: e.target.value })}
            onKeyDown={handleKeyDown}
            onBlur={saveEdit}
            className="h-7 px-2 text-xs bg-input border-primary/50 focus-visible:ring-primary/40 min-w-0 flex-1"
            type="text"
            inputMode={isEpisode ? 'numeric' : undefined}
          />
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-accent hover:text-accent hover:bg-accent/10"
            onMouseDown={(e) => { e.preventDefault(); saveEdit(); }} onClick={saveEdit}>
            <Check className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-muted"
            onMouseDown={(e) => { e.preventDefault(); cancelEdit(); }} onClick={cancelEdit}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      );
    }

    if (col.key === 'name') {
      const bList = bindings[resource.id] ?? [];
      const xnList2 = xnBindings[resource.id] ?? [];
      const yaList2 = yaBindings[resource.id] ?? [];
      const mukList2 = mukakuBindings[resource.id] ?? [];
      const jyList2 = jyingBindings[resource.id] ?? [];
      const hdList2 = hdhavenBindings[resource.id] ?? [];
      const allBound = bList.length + xnList2.length + yaList2.length
        + (framehdrBindings[resource.id] ? 1 : 0) + (panfxBindings[resource.id] ? 1 : 0)
        + (st1Bindings[resource.id] ? 1 : 0)
        + mukList2.length + jyList2.length + hdList2.length;
      return (
        <div className="flex items-center gap-1 min-w-0">
          {/* touch-manipulation：关掉双击缩放，否则触屏上双击会变成缩放、触发不了 dblclick */}
          <div
            className="flex-1 min-w-0 overflow-hidden touch-manipulation cursor-pointer group rounded px-1 -mx-1 hover:bg-muted/60 transition-colors"
            title={isTouchDevice ? '双击编辑名称' : undefined}
            onClick={!isTouchDevice ? () => startEdit(resource.id, col.key, scalarValue) : undefined}
            onDoubleClick={isTouchDevice ? () => startEdit(resource.id, col.key, scalarValue) : undefined}
          >
            {displayValue
              ? <span className={`text-xs block truncate ${resource.link_status === 'invalid' ? 'text-destructive font-semibold' : resource.link_status === 'partial' ? 'text-destructive font-medium' : ''}`}>{displayValue}</span>
              : <span className="text-muted-foreground/40 text-xs italic">—</span>}
            {resource.link_status === 'invalid' && (
              <span className="text-[10px] text-destructive flex items-center gap-0.5 mt-0.5">
                <Link2 className="h-2.5 w-2.5 shrink-0" />链接已失效
              </span>
            )}
            {resource.link_status === 'partial' && (
              <span className="text-[10px] text-destructive flex items-center gap-0.5 mt-0.5">
                <AlertTriangle className="h-2.5 w-2.5 shrink-0" />部分链接失效
              </span>
            )}
          </div>
          {/* 快捷绑定按钮 */}
          <Button
            variant="outline"
            size="sm"
            title={readOnly
              ? '会员已到期，编辑功能已锁定'
              : '快捷绑定：搜索站点片库并自动回填名称与链接'}
            disabled={readOnly}
            onClick={(e) => {
              e.stopPropagation();
              setQuickBindTarget(resource);
              setQuickBindOpen(true);
            }}
            className="h-6 px-1.5 text-[11px] gap-1 shrink-0 text-primary border-primary/30 hover:bg-primary/10 hover:border-primary transition-colors"
          >
            <Sparkles className="h-3 w-3" />
            <span className="hidden sm:inline">快捷绑定</span>
          </Button>

          {/* 手机端：链接管理按钮（桌面端有独立链接列） */}
          <Button
            variant="ghost"
            size="icon"
            title={readOnly ? '会员已到期，编辑功能已锁定' : '管理链接'}
            disabled={readOnly}
            onClick={(e) => { e.stopPropagation(); setManageLinksTarget(resource); setManageLinksOpen(true); }}
            className="md:hidden h-6 w-6 shrink-0 text-muted-foreground/60 hover:text-primary hover:bg-primary/10"
          >
            <Link className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={readOnly
              ? '会员已到期，编辑功能已锁定'
              : allBound > 1
                ? `已绑定 ${allBound} 条站点记录`
                : bList.length === 1
                  ? `已绑定：${bList[0].vod_name || bList[0].link_title || `#${bList[0].link_id}`}`
                  : '绑定站点剧集'}
            disabled={readOnly}
            onClick={(e) => { e.stopPropagation(); setBindTarget(resource); setBindOpen(true); }}
            className={`h-6 w-6 shrink-0 ${allBound > 0 ? 'text-secondary hover:text-secondary hover:bg-secondary/10' : 'text-muted-foreground/60 hover:text-primary hover:bg-primary/10'}`}
          >
            {syncingId === resource.id
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Link2 className="h-3 w-3" />}
          </Button>
        </div>
      );
    }

    if (col.key === 'links') {
      const panLinks = Array.isArray(resource.links) && resource.links.length > 0
        ? resource.links
        : resource.link?.trim() ? [{ url: resource.link, pan_name: '' }] : [];
      return (
        <div
          className={`flex flex-wrap items-center gap-1 group min-w-0 ${readOnly ? '' : 'cursor-pointer'}`}
          title={readOnly ? '会员已到期，编辑功能已锁定' : undefined}
          onClick={() => { if (readOnly) return; setManageLinksTarget(resource); setManageLinksOpen(true); }}
        >
          {panLinks.length > 0 ? (
            panLinks.map((l, i) => (
              <Badge key={i} variant="secondary"
                className={`h-5 px-1.5 text-[10px] border-0 hover:opacity-80 transition-colors gap-1 shrink-0 ${
                  l.status === 'invalid'
                    ? 'bg-destructive/15 text-destructive'
                    : l.status === 'valid'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-primary/10 text-primary'
                }`}
                title={l.status === 'invalid' ? '该链接已失效' : l.status === 'valid' ? '该链接有效' : l.pan_name || '链接'}>
                <CloudIcon className="h-2.5 w-2.5" />
                {l.pan_name || '链接'}
                {l.status === 'invalid' && <X className="h-2.5 w-2.5" />}
              </Badge>
            ))
          ) : (
            <span className="text-muted-foreground/50 text-xs italic group-hover:text-muted-foreground transition-colors">
              点击添加链接
            </span>
          )}
        </div>
      );
    }

    return (
      <div
        className="cursor-pointer group rounded px-1 -mx-1 hover:bg-muted/60 transition-colors"
        title={isTouchDevice ? '双击编辑' : undefined}
        onClick={!isTouchDevice ? () => startEdit(resource.id, col.key, scalarValue) : undefined}
        onDoubleClick={isTouchDevice ? () => startEdit(resource.id, col.key, scalarValue) : undefined}
      >
        {displayValue
          ? <span className="text-xs">{displayValue}</span>
          : <span className="text-muted-foreground/40 text-xs italic">—</span>}
      </div>
    );
  }

  // 快捷绑定：更新当前行资源（完整名称、链接、封面，并同步持久化站点发布绑定）
  async function handleUpdateCurrent(
    resourceId: string,
    filledName: string,
    filledLink: string,
    coverUrl?: string | null,
    siteBindings?: SiteBindingPayload[]
  ) {
    const resource = resources.find((r) => r.id === resourceId);
    if (!resource) return;

    let updatedResource: Resource = { ...resource };

    // 1. 完整回填资源名称
    if (filledName && filledName !== resource.name) {
      await updateResourceField(resourceId, 'name', filledName);
      await recordChange({
        resource_id: resourceId,
        resource_name: filledName,
        field_name: 'name',
        field_label: FIELD_LABELS.name ?? 'name',
        old_value: resource.name,
        new_value: filledName,
      });
      updatedResource = { ...updatedResource, name: filledName };
    }

    // 2. 回填资源链接
    if (filledLink !== undefined && filledLink !== resource.link) {
      await updateResourceField(resourceId, 'link', filledLink);
      await recordChange({
        resource_id: resourceId,
        resource_name: updatedResource.name,
        field_name: 'link',
        field_label: FIELD_LABELS.link ?? 'link',
        old_value: resource.link,
        new_value: filledLink,
      });
      const newLinks = filledLink ? [{ url: filledLink, pan_name: '' }] : [];
      await updateResourceField(resourceId, 'links', newLinks);
      updatedResource = { ...updatedResource, link: filledLink, links: newLinks };
    }

    // 3. 若提供封面海报且当前未设置封面，自动更新封面
    if (coverUrl && !resource.cover_url) {
      try {
        // 外站封面先下载导入本应用存储桶，避免防盗链 / 跨域导致无法显示与合成分享卡片
        const localCover = await importCoverFromUrl(resourceId, coverUrl);
        const finalCover = localCover || coverUrl;
        await updateResourceCover(resourceId, finalCover);
        updatedResource = { ...updatedResource, cover_url: finalCover };
      } catch (err) {
        console.warn('自动设置封面失败', err);
      }
    }

    // 4. 若自动发布到了站点，持久化站点绑定映射（首条 + 队列各条，全部绑到当前行）
    for (const siteBinding of siteBindings ?? []) {
      try {
        if (siteBinding.site === 'mukaku' && siteBinding.movies_id && siteBinding.link_id) {
          await bindResourceToMukaku(resourceId, {
            id: siteBinding.link_id,
            movies_id: siteBinding.movies_id,
            seed_name: filledName,
            vod_name: siteBinding.vod_name || filledName,
            pan_type: siteBinding.pan_type,
            code: siteBinding.code,
          });
          const mukakuList = await fetchMukakuResourceBindings();
          const mukakuMap: Record<string, MukakuResourceBinding[]> = {};
          mukakuList.forEach((b) => { (mukakuMap[b.resource_id] ??= []).push(b); });
          setMukakuBindings(mukakuMap);
        } else if (siteBinding.site === 'ya' && siteBinding.video_id && siteBinding.link_id) {
          await bindResourceToYa(resourceId, {
            id: siteBinding.link_id,
            video_id: siteBinding.video_id,
            video_title: siteBinding.vod_name || filledName,
            name: siteBinding.vod_name || filledName,
            // 网盘名一律由该绑定「对应的本地链接」按 URL 推导：
            // 站点对光鸭等网盘只返回 drive_type='others'，而本地链接的 pan_name
            // 来自 URL 识别 —— 两者不同源时同步会报「资源中没有 others 类型链接」
            url: siteBinding.pan_url || filledLink,
            extract_code: siteBinding.code || '',
          });
          const yaList = await fetchYaResourceBindings();
          const yaMap: Record<string, YaResourceBinding[]> = {};
          yaList.forEach((b) => { (yaMap[b.resource_id] ??= []).push(b); });
          setYaBindings(yaMap);
        } else if (siteBinding.site === 'pinglian' && siteBinding.link_id) {
          // 盘链：发布成功后落地「资源 × 盘链记录」绑定
          await bindResourceToLink(resourceId, {
            id: siteBinding.link_id,
            title: siteBinding.link_title || filledName,
            video_title: siteBinding.vod_name || filledName,
            pan_type: siteBinding.pan_type || 'others',
            password: siteBinding.code || null,
          });
          const plList = await fetchResourceBindings();
          const plMap: Record<string, ResourceBinding[]> = {};
          plList.forEach((b) => { (plMap[b.resource_id] ??= []).push(b); });
          setBindings(plMap);
        } else if (siteBinding.site === 'framehdr' && siteBinding.link_id) {
          // 帧影：发布成功后落地「资源 × 帧影链接」绑定
          await bindResourceToFramehdr(resourceId, {
            id: siteBinding.link_id,
            title: siteBinding.vod_name || filledName,
            drive_name: siteBinding.pan_type || null,
          } as import('@/types/index').FramehdrLink);
          const fhList = await fetchFramehdrResourceBindings();
          const fhMap: Record<string, FramehdrResourceBinding> = {};
          fhList.forEach((b) => { fhMap[b.resource_id] = b; });
          setFramehdrBindings(fhMap);
        } else if (siteBinding.site === 'jying' && siteBinding.link_id) {
          // 聚影：同步成功后落地「资源 × 聚影分享条目」绑定
          await bindResourceToJying(resourceId, {
            id: siteBinding.link_id,
            vod_name: siteBinding.vod_name || filledName,
            title: siteBinding.link_title || filledName,
            share_link: siteBinding.pan_url || filledLink,
          });
          const jyList = await fetchJyingResourceBindings();
          const jyMap: Record<string, JyingResourceBinding[]> = {};
          jyList.forEach((b) => { (jyMap[b.resource_id] ??= []).push(b); });
          setJyingBindings(jyMap);
        } else if (siteBinding.site === 'xn' && siteBinding.share_id) {
          // 观影小牛：发布成功后落地「资源 × 观影分享」绑定
          await bindResourceToXnShare(resourceId, {
            id: siteBinding.share_id,
            title: siteBinding.link_title || filledName,
            url: siteBinding.share_url || filledLink,
          });
          const xnList = await fetchXnResourceBindings();
          const xnMap: Record<string, XnResourceBinding[]> = {};
          xnList.forEach((b) => { (xnMap[b.resource_id] ??= []).push(b); });
          setXnBindings(xnMap);
        } else if (siteBinding.site === 'hdhaven' && siteBinding.share_id) {
          // 栖影：投稿成功后落地「资源 × 栖影分享条目」绑定（slug 存放在 share_id）
          await bindResourceToHdhavenBySlug({
            resourceId,
            slug: siteBinding.share_id,
            linkTitle: siteBinding.link_title || filledName,
            vodName: siteBinding.vod_name || filledName,
            panType: siteBinding.pan_type ?? null,
          });
          const hdList = await fetchHdhavenResourceBindings();
          const hdMap: Record<string, HdhavenResourceBinding[]> = {};
          hdList.forEach((b) => { (hdMap[b.resource_id] ??= []).push(b); });
          setHdhavenBindings(hdMap);
        }
      } catch (bindErr) {
        console.warn('保存站点绑定映射失败', bindErr);
      }
    }

    // 5. 更新前端状态并触发记录通知
    const nextResources = resources.map((r) => (r.id === resourceId ? updatedResource : r));
    onResourcesChange(nextResources);
    onResourceUpdated(updatedResource, '快捷绑定');

    // 6. 若已绑定外部站点，触发增量同步
    syncToSite(updatedResource);
  }

  return (
    <div className="flex flex-col gap-2 md:gap-3 h-full">
      {/* Tab 切换：更新中 / 已完结。
          手机端（<md）＝设计稿的分段控件（选中浅蓝底 + 蓝字）；
          桌面端（md+）＝ **完全保持原有下划线样式**，PC 展示不变 */}
      <div className="flex shrink-0 overflow-hidden rounded-xl border border-border bg-card md:rounded-none md:rounded-t-lg md:border-0 md:border-b md:border-border md:bg-muted/20">
        <button
          onClick={() => { setFinishTab('updating'); setSelectedIds(new Set()); }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors md:py-2 ${
            finishTab === 'updating'
              ? 'bg-primary/10 text-primary md:bg-card md:text-primary md:border-b-2 md:border-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40 md:hover:bg-muted/40'
          }`}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          更新中
          <span className={`text-[10px] ${finishTab === 'updating' ? 'text-primary/70 md:text-muted-foreground' : 'text-muted-foreground'}`}>
            ({resources.filter((r) => !r.is_finished).length})
          </span>
        </button>
        <div className="w-px shrink-0 bg-border md:hidden" />
        <button
          onClick={() => { setFinishTab('finished'); setSelectedIds(new Set()); }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors md:py-2 ${
            finishTab === 'finished'
              ? 'bg-primary/10 text-primary md:bg-card md:text-accent md:border-b-2 md:border-accent'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40 md:hover:bg-muted/40'
          }`}
        >
          <CircleCheck className="h-3.5 w-3.5" />
          已完结
          <span className={`text-[10px] ${finishTab === 'finished' ? 'text-primary/70 md:text-muted-foreground' : 'text-muted-foreground'}`}>
            ({resources.filter((r) => r.is_finished).length})
          </span>
        </button>
      </div>

      {/* 工具栏（手机端按设计稿：搜索框 + 更新状态 + 新增资源 + ⋯ + 链接检测，一行全显示）
          搜索框 min-w-0 flex-1 吸收剩余宽度，右侧按钮 shrink-0 固定大小 → 谁都不会被切掉 */}
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {/* 搜索框（手机端字号保持 16px：iOS 上输入框 < 16px 时聚焦会自动放大整页） */}
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索资源名称…"
            className="h-9 min-w-0 rounded-full border-border/60 bg-muted/50 pl-8 text-base focus-visible:ring-primary/40 md:h-8 md:rounded-lg md:border-border md:bg-input md:text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {/* 手机端：页面动作按钮（HomePage 传入，与搜索框同一行） */}
        {toolbarExtra}
        {/* 手机端：链接检测（带文字，避免只有一个图标看不出是功能键） */}
        <Button variant="outline" size="sm" onClick={handleCheckLinks}
          title="检测链接有效性"
          disabled={checkingLinks || filtered.length === 0}
          className="md:hidden h-7 shrink-0 gap-0.5 whitespace-nowrap rounded-full border-border px-1.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground">
          {checkingLinks
            ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
            : <ShieldCheck className="h-2.5 w-2.5 shrink-0" />}
          {checkingLinks && checkProgress.total > 0
            ? `${checkProgress.done}/${checkProgress.total}`
            : '链接检测'}
        </Button>
        {/* 桌面端显示按钮（手机端按钮在页面标题栏） */}
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {search ? `${filtered.length} / ${tabFiltered.length}` : `共 ${tabFiltered.length} 条`}
            {selectedIds.size > 0 && <span className="text-primary ml-1">· 已选 {selectedIds.size}</span>}
          </span>
          <Button variant="outline" size="sm" onClick={() => onBatchOpenChange(true)}
            disabled={readOnly}
            className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
            <Layers className="h-3.5 w-3.5" />批量导入
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportXlsx}
            disabled={exporting}
            title="导出 XLSX：勾选资源后仅导出勾选项"
            className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
            {exporting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Download className="h-3.5 w-3.5" />}
            导出 XLSX{selectedIds.size > 0 ? `（已选 ${selectedIds.size}）` : ''}
          </Button>
          <Button variant="outline" size="sm" onClick={() => jsonFileRef.current?.click()}
            disabled={readOnly || importingJson}
            className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
            {importingJson
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <FileJson className="h-3.5 w-3.5" />}
            {importingJson ? `导入中 ${importJsonProgress.done}/${importJsonProgress.total}` : '导入 JSON'}
          </Button>
          <input
            ref={jsonFileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportJson}
          />
          <Button size="sm" onClick={() => onAddOpenChange(true)}
            disabled={readOnly}
            className="h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" />新增资源
          </Button>
          <Button variant="outline" size="sm" onClick={handleCheckLinks}
            disabled={checkingLinks || filtered.length === 0}
            className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
            {checkingLinks
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <ShieldCheck className="h-3.5 w-3.5" />}
            {checkingLinks
              ? `检测中 ${checkProgress.done}/${checkProgress.total}`
              : '链接检测'}
          </Button>
        </div>
      </div>

      {/* 隐藏文件选择器 */}
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="hidden" onChange={handleFileChange} />

      {/* 表格区域：手机用卡片列表（设计稿），桌面 table-auto min-w-max 恢复原样 */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {/* 手机端：卡片列表（自身滚动）。动作与行内编辑全部复用下方表格的同一套状态与回调 */}
      <div className="min-h-0 flex-1 overflow-y-auto md:hidden">
        <ResourceCardList
          resources={filtered}
          readOnly={readOnly}
          isTouchDevice={isTouchDevice}
          brokenCovers={brokenCovers}
          onCoverBroken={(id) => setBrokenCovers((prev) => ({ ...prev, [id]: true }))}
          onCoverClick={triggerCoverUpload}
          onRemoveCover={handleRemoveCover}
          uploadingId={uploadingId}
          uploadProgress={uploadProgress}
          deletingId={deletingId}
          onDelete={handleDelete}
          onQuickBind={(r) => { setQuickBindTarget(r); setQuickBindOpen(true); }}
          onBind={(r) => { setBindTarget(r); setBindOpen(true); }}
          onManageLinks={(r) => { setManageLinksTarget(r); setManageLinksOpen(true); }}
          editState={editState}
          onStartEdit={(r, field) =>
            startEdit(r.id, field, field === 'episode_count' ? r.episode_count ?? 0 : r.name ?? '')
          }
          onEditValueChange={(v) => setEditState((s) => (s ? { ...s, value: v } : s))}
          onSaveEdit={saveEdit}
          onCancelEdit={cancelEdit}
          inputRef={inputRef}
          onEditKeyDown={handleKeyDown}
        />
      </div>

      <div className="hidden flex-1 min-h-0 overflow-auto rounded-lg border border-border md:block">
        <table className="w-full table-fixed md:table-auto md:min-w-max text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border bg-card">
              {/* 拖拽手柄列（无搜索时才显示） */}
              <th className="w-6 md:w-8 px-0 py-2.5" />
              {/* 全选 checkbox */}
              <th className="px-1 md:px-2 py-2.5 text-center w-8 md:w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={filtered.length === 0}
                  aria-label="全选"
                />
              </th>
              <th className="px-1 md:px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap w-12 md:w-16">封面</th>
              {COLUMNS.map((col) => (
                <th key={col.key} className={`px-2 md:px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap ${col.colClass}`}>
                  {col.label}
                </th>
              ))}
              <th className="px-1 md:px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap w-10 md:min-w-16">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 4} className="py-12 text-center text-muted-foreground text-sm">
                  {search
                    ? `未找到包含「${search}」的资源`
                    : finishTab === 'finished'
                    ? '暂无已完结资源，右键勾选的资源选择「移动到已完结」'
                    : '暂无资源，点击「新增资源」开始添加'}
                </td>
              </tr>
            ) : (
              <SortableContext items={filtered.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              {filtered.map((resource, idx) => {
                const isSelected = selectedIds.has(resource.id);
                // 右键菜单目标：若当前行已被选中则操作所有选中行，否则只操作当前行
                const ctxIds = isSelected && selectedIds.size > 1
                  ? Array.from(selectedIds)
                  : [resource.id];
                return (
                  <SortableResourceRow
                    key={resource.id}
                    resource={resource}
                    disabled={!!search || readOnly}
                    rowClass={`border-b border-border/50 transition-colors hover:bg-muted/20 cursor-context-menu ${
                      isSelected ? 'bg-primary/8 ring-1 ring-inset ring-primary/20' : idx % 2 === 0 ? 'bg-background' : 'bg-card/50'
                    }`}
                    onRowClick={(e) => {
                      // 点击行时切换选中（但不影响行内其他点击事件）
                      const tag = (e.target as HTMLElement).tagName.toLowerCase();
                      if (['input', 'button', 'a', 'img'].includes(tag)) return;
                      toggleSelectOne(resource.id);
                    }}
                    menuContent={
                      <ContextMenuContent>
                        {/* 右键：移动到已完结 / 移回更新中 */}
                        {finishTab === 'updating' ? (
                          <ContextMenuItem
                            disabled={readOnly}
                            onClick={() => handleMoveToFinished(ctxIds, true)}
                            className="gap-2 text-accent focus:text-accent focus:bg-accent/10"
                          >
                            <CircleCheck className="h-4 w-4" />
                            移动到已完结
                            {ctxIds.length > 1 && <span className="ml-auto text-xs text-muted-foreground">({ctxIds.length} 条)</span>}
                          </ContextMenuItem>
                        ) : (
                          <ContextMenuItem
                            disabled={readOnly}
                            onClick={() => handleMoveToFinished(ctxIds, false)}
                            className="gap-2 text-primary focus:text-primary focus:bg-primary/10"
                          >
                            <RefreshCcw className="h-4 w-4" />
                            移回更新中
                            {ctxIds.length > 1 && <span className="ml-auto text-xs text-muted-foreground">({ctxIds.length} 条)</span>}
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          disabled={readOnly || deletingId === resource.id}
                          onClick={() => handleDelete(resource.id)}
                          className="gap-2 text-destructive focus:text-destructive focus:bg-destructive/10"
                        >
                          <Trash2 className="h-4 w-4" />
                          删除资源
                        </ContextMenuItem>
                      </ContextMenuContent>
                    }
                  >
                  {/* 行 Checkbox */}
                  <td className="px-1 md:px-2 py-1 md:py-2 align-middle text-center w-8 md:w-10"
                    onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelectOne(resource.id)}
                      aria-label={`选择 ${resource.name}`}
                    />
                  </td>
                  {/* 封面列 */}
                  <td className="px-1 md:px-3 py-1 md:py-2 align-middle w-12 md:w-16"
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverId(resource.id); }}
                    onDragLeave={(e) => { e.stopPropagation(); setDragOverId(null); }}
                    onDrop={async (e) => {
                      e.preventDefault(); e.stopPropagation();
                      setDragOverId(null);
                      const file = e.dataTransfer.files?.[0];
                      if (file) await doUpload(file, resource.id);
                    }}
                  >
                    <div className={`relative group w-8 h-11 md:w-10 md:h-14 rounded overflow-hidden shrink-0 transition-all ${dragOverId === resource.id ? 'ring-2 ring-primary ring-offset-1 scale-105' : ''}`}>
                      {uploadingId === resource.id ? (
                        <div className="w-full h-full bg-muted flex flex-col items-center justify-center gap-1">
                          <Loader2 className="h-3 w-3 text-primary animate-spin" />
                          <span className="text-[9px] text-primary">{uploadProgress}%</span>
                        </div>
                      ) : resource.cover_url && !brokenCovers[resource.id] ? (
                        <>
                          <img
                            src={resource.cover_url}
                            alt="封面"
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                            onError={() =>
                              setBrokenCovers((prev) => ({ ...prev, [resource.id]: true }))
                            }
                          />
                          {/* 注意：触屏没有 hover —— 手机上必须常显，否则「更换 / 删除」永远点不到；
                              桌面端保持 hover 才浮现，避免遮挡封面。按钮补内边距扩大触控区 */}
                          <div className="absolute inset-0 bg-black/50 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-0.5">
                            <button onClick={() => triggerCoverUpload(resource.id)}
                              className="text-white text-[9px] leading-tight px-1.5 py-1 rounded hover:bg-white/20 active:bg-white/25">更换</button>
                            <button onClick={() => handleRemoveCover(resource)}
                              className="text-red-300 text-[9px] leading-tight px-1.5 py-1 rounded hover:bg-red-500/20 active:bg-red-500/25">删除</button>
                          </div>
                        </>
                      ) : (
                        <button
                          onClick={() => triggerCoverUpload(resource.id)}
                          title={brokenCovers[resource.id] ? '原封面地址已失效，点击上传新封面' : undefined}
                          className="w-full h-full bg-muted/60 border border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-colors flex flex-col items-center justify-center gap-0.5 rounded"
                        >
                          <ImagePlus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
                          <span className="text-[9px] text-muted-foreground leading-tight">
                            {brokenCovers[resource.id] ? '封面失效' : '添加封面'}
                          </span>
                        </button>
                      )}
                    </div>
                  </td>
                  {COLUMNS.map((col) => (
                    <td key={col.key} className={`relative px-2 md:px-3 py-1 md:py-2 align-middle ${col.colClass}`}>
                      {renderCell(resource, col)}
                    </td>
                  ))}
                  <td className="px-1 md:px-3 py-1 md:py-2 align-middle w-10 md:min-w-16">
                    <Button variant="ghost" size="icon"
                      className="h-9 w-9 md:h-7 md:w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleDelete(resource.id)}
                      disabled={readOnly || deletingId === resource.id}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                  </SortableResourceRow>
                );
              })}
            </SortableContext>
            )}
          </tbody>
        </table>
      </div>
      </DndContext>

      <ResourceFormDialog open={addOpen} onOpenChange={onAddOpenChange}
        onAdded={onResourceAdded} maxSortOrder={resources.length} />

      <BatchImportDialog open={batchOpen} onOpenChange={onBatchOpenChange}
        onImported={(list) => onResourcesChange([...resources, ...list])}
        maxSortOrder={resources.length} />

      <BindDialog
        resource={bindTarget}
        pinglianBindings={bindTarget ? bindings[bindTarget.id] ?? [] : []}
        xnBindings={bindTarget ? xnBindings[bindTarget.id] ?? [] : []}
        yaBindings={bindTarget ? yaBindings[bindTarget.id] ?? [] : []}
        framehdrBinding={bindTarget ? framehdrBindings[bindTarget.id] ?? null : null}
        panfxBinding={bindTarget ? panfxBindings[bindTarget.id] ?? null : null}
        st1Binding={bindTarget ? st1Bindings[bindTarget.id] ?? null : null}
        mukakuBindings={bindTarget ? mukakuBindings[bindTarget.id] ?? [] : []}
        jyingBindings={bindTarget ? jyingBindings[bindTarget.id] ?? [] : []}
        hdhavenBindings={bindTarget ? hdhavenBindings[bindTarget.id] ?? [] : []}
        open={bindOpen}
        onOpenChange={setBindOpen}
        onPinglianBound={(resourceId, b) => setBindings((prev) => {
          const list = prev[resourceId] ?? [];
          const idx = list.findIndex((x) => x.link_id === b.link_id);
          return { ...prev, [resourceId]: idx >= 0 ? list.map((x, i) => (i === idx ? b : x)) : [...list, b] };
        })}
        onPinglianUnbound={(resourceId, linkId) => setBindings((prev) => {
          if (linkId == null) {
            const next = { ...prev };
            delete next[resourceId];
            return next;
          }
          return { ...prev, [resourceId]: (prev[resourceId] ?? []).filter((x) => x.link_id !== linkId) };
        })}
        onXnBound={(resourceId, b) => setXnBindings((prev) => {
          const list = prev[resourceId] ?? [];
          const idx = list.findIndex((x) => x.share_id === b.share_id);
          return { ...prev, [resourceId]: idx >= 0 ? list.map((x, i) => (i === idx ? b : x)) : [...list, b] };
        })}
        onXnUnbound={(resourceId, shareId) => setXnBindings((prev) => {
          if (shareId == null) {
            const next = { ...prev };
            delete next[resourceId];
            return next;
          }
          return { ...prev, [resourceId]: (prev[resourceId] ?? []).filter((x) => x.share_id !== shareId) };
        })}
        onYaBound={(resourceId, b) => setYaBindings((prev) => {
          const list = prev[resourceId] ?? [];
          const idx = list.findIndex((x) => x.link_id === b.link_id);
          return { ...prev, [resourceId]: idx >= 0 ? list.map((x, i) => (i === idx ? b : x)) : [...list, b] };
        })}
        onYaUnbound={(resourceId, linkId) => setYaBindings((prev) => {
          if (linkId == null) {
            const next = { ...prev };
            delete next[resourceId];
            return next;
          }
          return { ...prev, [resourceId]: (prev[resourceId] ?? []).filter((x) => x.link_id !== linkId) };
        })}
        onFramehdrBound={(resourceId, b) => setFramehdrBindings((prev) => ({ ...prev, [resourceId]: b }))}
        onFramehdrUnbound={(resourceId) => setFramehdrBindings((prev) => {
          const next = { ...prev };
          delete next[resourceId];
          return next;
        })}
        onPanfxBound={(resourceId, b) => setPanfxBindings((prev) => ({ ...prev, [resourceId]: b }))}
        onPanfxUnbound={(resourceId) => setPanfxBindings((prev) => {
          const next = { ...prev };
          delete next[resourceId];
          return next;
        })}
        onSt1Bound={(resourceId, b) => setSt1Bindings((prev) => ({ ...prev, [resourceId]: b }))}
        onSt1Unbound={(resourceId) => setSt1Bindings((prev) => {
          const next = { ...prev };
          delete next[resourceId];
          return next;
        })}
        onMukakuBound={(resourceId, b) => setMukakuBindings((prev) => {
          const list = prev[resourceId] ?? [];
          const idx = list.findIndex((x) => x.link_id === b.link_id);
          return { ...prev, [resourceId]: idx >= 0 ? list.map((x, i) => (i === idx ? b : x)) : [...list, b] };
        })}
        onMukakuUnbound={(resourceId, linkId) => setMukakuBindings((prev) => {
          if (linkId == null) {
            const next = { ...prev };
            delete next[resourceId];
            return next;
          }
          return { ...prev, [resourceId]: (prev[resourceId] ?? []).filter((x) => x.link_id !== linkId) };
        })}
        onJyingBound={(resourceId, b) => setJyingBindings((prev) => {
          const list = prev[resourceId] ?? [];
          const idx = list.findIndex((x) => x.link_id === b.link_id);
          return { ...prev, [resourceId]: idx >= 0 ? list.map((x, i) => (i === idx ? b : x)) : [...list, b] };
        })}
        onJyingUnbound={(resourceId, linkId) => setJyingBindings((prev) => {
          if (linkId == null) {
            const next = { ...prev };
            delete next[resourceId];
            return next;
          }
          return { ...prev, [resourceId]: (prev[resourceId] ?? []).filter((x) => x.link_id !== linkId) };
        })}
        onHdhavenBound={(resourceId, b) => setHdhavenBindings((prev) => {
          const list = prev[resourceId] ?? [];
          const idx = list.findIndex((x) => x.slug === b.slug);
          return { ...prev, [resourceId]: idx >= 0 ? list.map((x, i) => (i === idx ? b : x)) : [...list, b] };
        })}
        onHdhavenUnbound={(resourceId, slug) => setHdhavenBindings((prev) => {
          if (slug == null) {
            const next = { ...prev };
            delete next[resourceId];
            return next;
          }
          return { ...prev, [resourceId]: (prev[resourceId] ?? []).filter((x) => x.slug !== slug) };
        })}
      />

      <ManageLinksDialog
        open={manageLinksOpen}
        onOpenChange={setManageLinksOpen}
        resource={manageLinksTarget}
        onSaved={(updated) => {
          onResourcesChange(resources.map((r) => r.id === updated.id ? updated : r));
          onResourceUpdated(updated, '链接');
        }}
      />

      <QuickBindDialog
        resource={quickBindTarget}
        open={quickBindOpen}
        onOpenChange={setQuickBindOpen}
        onUpdateCurrent={handleUpdateCurrent}
      />
    </div>
  );
}

export { ResourceTable };
export default ResourceTable;
