import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Rss, Plus, Trash2, Play, Loader2, RefreshCw, KeyRound, Pencil,
  Power, PowerOff, FlaskConical, AlertCircle, Copy, CheckCheck, Link2, Download,
  Folder, FolderOpen, Search, X, Layers, QrCode, Sparkles,
  CheckCircle2, CircleDashed, ShieldCheck, Unlink, Lock,
  Crown, ChevronLeft, ChevronRight,
} from 'lucide-react';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import QRCodeDataUrl from '@/components/ui/qrcodedataurl';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { extractPasscodeFromUrl } from '@/lib/panUtils';
import {
  bindPanAccount, bindPanTokens, bindXunleiToken, prefillXunleiToken, clearSubscriptionItems, fetchPanDirs, listPanAccounts,
  listSubscriptionItems, listSubscriptions, previewSubscriptionSource, probePanAccount,
  removePanAccount, removeSubscription, runAllSubscriptions, runSubscriptionOnce, saveSubscription,
  toggleSubscription, PAN_LABELS, startPanDeviceAuth, pollPanDeviceAuth,
  fetchMyInactivityState, unfreezeMyAccount,
  type PanAccount, type PanDir, type PanDeviceSession, type PanKey, type PanScanKey, type PreviewResult,
  type Subscription, type SubscriptionItem, type ItemStatus, type InactivityState,
} from '@/services/subscriptions';
import {
  fetchResourceBrief, fetchResources, fetchSubscriptionSources, fetchAdminResourceSources,
  fetchSourceOwners, fetchSourceOwnerResources,
} from '@/services/api';
import type {
  Resource, SubscriptionSource, AdminResourceSource, SourceOwner, SourceOwnerResource,
} from '@/types/index';

const PAN_KEYS: PanKey[] = ['guangya', 'quark', 'baidu', 'xunlei', 'uc', 'p123'];

/**
 * 锁定中的网盘（未开放）：值为卡片上显示的角标文案。
 * 迅雷（2026-10）：风控「四件套」与转存搬移仍在适配，先对用户关闭所有入口
 * （卡片灰化、扫码/令牌按钮禁用、目标网盘不可选、订阅保存与执行都会被拦）。
 * 服务端 subscription-run 有 XUNLEI_LOCKED 开关做同样的硬拦截，解锁时两处一起改。
 */
const LOCKED_PANS: Partial<Record<PanKey, string>> = {
  xunlei: '正在适配中',
};

/** 锁定网盘被点击时的一句话提示 */
function lockedTip(pan: PanKey) {
  return `${PAN_LABELS[pan]}${LOCKED_PANS[pan] ?? ''}，暂未开放使用`;
}

/**
 * 支持「文件夹模式」（整个文件夹转存、保留子目录）的网盘。
 * 必须与服务端 saveSubscription 的白名单、以及 DB 触发器 enforce_folder_mode_pan 保持一致，
 * 否则会出现「界面能勾、库里被改成 false、执行时退回逐文件」的静默降级。
 */
const FOLDER_MODE_PANS: PanKey[] = ['guangya', 'quark', 'baidu', 'uc', 'p123'];

/**
 * 普通用户的订阅数量上限，必须与服务端 subscription-run 的 DEFAULT_MAX_SUBS 保持一致。
 * 「订阅专用」账号（特殊激活码注册）不用这个值，沿用 profiles.max_subscriptions（默认 10）。
 */
const DEFAULT_MAX_SUBS = 80;

/**
 * 网盘驱动的展示信息（紧凑卡片）：
 * logo = 官方 app 图标（public/images/pan/ 下的方形容器图标），auth = 授权方式徽标，desc = 一句话能力。
 * 只写真实能力，别加没实现的（如「秒传」「302」）。
 */
const PAN_META: Record<PanKey, {
  logo: string;
  auth: string;
  desc: string;
}> = {
  guangya: {
    logo: '/images/pan/guangya.png',
    auth: '扫码登录',
    desc: '光鸭云盘接入，授权后可自动续期',
  },
  quark: {
    logo: '/images/pan/quark.png',
    auth: '扫码 / Cookie',
    desc: '夸克网盘接入，扫码登录或粘 Cookie，凭证加密托管',
  },
  baidu: {
    logo: '/images/pan/baidu.png',
    auth: '扫码 / Cookie',
    desc: '百度网盘接入，扫码登录或粘 Cookie，凭证加密托管',
  },
  xunlei: {
    logo: '/images/pan/xunlei.png',
    auth: '令牌绑定',
    desc: '正在适配中：风控令牌与转存链路尚未稳定，暂未开放使用',
  },
  uc: {
    logo: '/images/pan/uc.png',
    auth: 'Cookie',
    desc: 'UC 网盘接入，粘贴浏览器登录 Cookie 即可，凭证加密托管',
  },
  p123: {
    logo: '/images/pan/p123.png',
    auth: 'App扫码/令牌',
    desc: '123 云盘接入：推荐 123云盘 App 扫码，也可粘贴 authorToken；支持分享目录监控、文件夹模式与转存',
  },
};

const ITEM_STATUS_META: Record<ItemStatus, { label: string; className: string }> = {
  pending: { label: '待处理', className: 'bg-muted text-muted-foreground' },
  transferred: { label: '已转存', className: 'bg-secondary/20 text-secondary' },
  imported: { label: '已联动', className: 'bg-primary/15 text-primary' },
  failed: { label: '失败', className: 'bg-destructive/15 text-destructive' },
  skipped: { label: '已跳过', className: 'bg-muted text-muted-foreground' },
};

/** 检查时间（分钟）：定时任务每分钟触发一次，到点才真正探测链接 */
const INTERVAL_OPTIONS = [
  { value: '1', label: '每 1 分钟' },
  { value: '2', label: '每 2 分钟' },
  { value: '3', label: '每 3 分钟' },
  { value: '5', label: '每 5 分钟' },
  { value: '10', label: '每 10 分钟' },
  { value: '15', label: '每 15 分钟' },
  { value: '30', label: '每 30 分钟' },
  { value: '60', label: '每小时' },
  { value: '180', label: '每 3 小时' },
  { value: '720', label: '每 12 小时' },
];

/** 检查时间的展示文案：命中预设就用人话，否则回落成「每 N 分钟」 */
function intervalLabel(minutes: number | null | undefined) {
  const n = Math.max(1, Number(minutes) || 1);
  return INTERVAL_OPTIONS.find((o) => o.value === String(n))?.label ?? `每 ${n} 分钟`;
}

/**
 * 「下次检查」的时钟文案。
 * 服务端的调度判断按北京时间（北京时间 0-7 点算深夜），所以这里也按北京时间显示时分，保持一致。
 */
function clockOf(iso: string | null | undefined) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + 8 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 学到的主要更新时段文案：「8、16 点前后」 */
function hotHoursLabel(hours: number[] | null | undefined) {
  if (!hours || hours.length === 0) return null;
  return `${hours.join('、')} 点前后`;
}

/** 智能检测状态（订阅列表里的一行小字）：下次检查 + 学到的时段 */
function adaptiveNote(sub: Subscription) {
  if (sub.adaptive_enabled === false) return null;
  const parts: string[] = [];
  const next = clockOf(sub.next_check_at);
  if (next) {
    parts.push(Date.parse(sub.next_check_at ?? '') <= Date.now() ? '即将检查' : `下次 ${next}`);
  }
  const hot = hotHoursLabel(sub.update_hours);
  parts.push(hot ? `常更新：${hot}` : '正在学习更新时段');
  return parts.join(' · ');
}

/** 执行锁超时，与后端 RUN_LOCK_TTL_MS 保持一致：超过就认为这次执行已经结束 */
const RUN_LOCK_TTL_MS = 10 * 60_000;

/** 服务端是否正在执行这个订阅（依据执行锁 run_lock_at；执行是后台跑的，界面据此显示「运行中」） */
function isRunning(sub: Subscription) {
  return !!sub.run_lock_at && Date.now() - new Date(sub.run_lock_at).getTime() < RUN_LOCK_TTL_MS;
}

function fmt(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SubscribePage() {
  const { profile, isMembershipActive } = useAuth();
  // 订阅功能权限：管理员或管理员已开通的用户可用；未开通时整页功能受限（服务端也会硬性拒绝）
  const subEnabled = profile?.role === 'admin' || !!profile?.subscriptions_enabled;
  /**
   * 受限账号（用「特殊邀请码」注册）：只能使用订阅功能，且只能订阅管理员在「订阅源」里维护的链接。
   * 数量上限由管理员设置（注册时默认 10，管理员可在「用户管理 → 订阅上限」改成其它数字或「不限」）。
   * 前端只做体验层限制，真正拦截在服务端 saveSubscription。
   */
  const subOnly = profile?.role !== 'admin' && profile?.subscription_only === true;
  /**
   * 上限：null = 不限。
   *  · 管理员：不限
   *  · 「订阅专用」账号：管理员设置的 max_subscriptions（注册时默认 10），清空即不限
   *  · 普通用户：默认 DEFAULT_MAX_SUBS（80），管理员为个别账号设过数值则以该值为准
   */
  const maxSubs = profile?.role === 'admin'
    ? null
    : (typeof profile?.max_subscriptions === 'number' && profile.max_subscriptions > 0
        ? profile.max_subscriptions
        : subOnly ? null : DEFAULT_MAX_SUBS);
  const limitText = maxSubs === null ? '不限' : `${maxSubs} 个`;

  const [pans, setPans] = useState<PanAccount[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  /** 订阅源按网盘筛选：'all'=全部；某个网盘时只展示该网盘的订阅 */
  const [panTab, setPanTab] = useState<'all' | PanKey>('all');
  const [items, setItems] = useState<SubscriptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // 网盘绑定弹窗
  const [panDialog, setPanDialog] = useState<PanKey | null>(null);
  const [panCookie, setPanCookie] = useState('');
  const [panUser, setPanUser] = useState('');
  const [panDir, setPanDir] = useState('');
  const [panSaving, setPanSaving] = useState(false);
  const [panRemove, setPanRemove] = useState<PanKey | null>(null);

  // 订阅编辑弹窗
  const [subDialog, setSubDialog] = useState<{ open: boolean; editing?: Subscription }>({ open: false });
  const [form, setForm] = useState({
    name: '', sourceUrl: '', sourceType: 'auto' as 'auto' | 'rss' | 'page' | 'pan_share',
    sourcePasscode: '',
    keyword: '', pan: 'guangya' as PanKey, targetDir: '', targetDirName: '',
    cleanMode: 'episode' as 'none' | 'episode', autoPublish: false,
    // 文件夹模式（光鸭 / 夸克）：整目录转存 + 转后清理文档/图片
    folderMode: false,
    resourceId: '',
    // 默认 10 分钟：订阅一多，「每 1 分钟」会互相抢光鸭代理，反而谁都查不及时
    enabled: true, intervalMinutes: 10,
    // 智能检测（自适应调度）：默认开 —— 预期更新时段加密、其余时段放宽
    adaptiveEnabled: true,
    // 全集数（选填，字符串便于输入框留空）：填写后达到该集数即判定完结
    totalEpisodes: '',
  });

  // 「绑定资源管理中的资源」：可指定具体资源（不指定则按剧名自动匹配）
  const [boundRes, setBoundRes] = useState<{ id: string; name: string; episode_count: number } | null>(null);
  const [resPicker, setResPicker] = useState(false);
  const [resList, setResList] = useState<Resource[]>([]);
  const [resLoading, setResLoading] = useState(false);
  const [resQuery, setResQuery] = useState('');
  const [subSaving, setSubSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // 转存目录选择器（浏览网盘目录，选中的是目录 ID）
  const [dirPicker, setDirPicker] = useState(false);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirs, setDirs] = useState<PanDir[]>([]);
  // 转存目录：按名称过滤（目录较多时快捷定位）
  const [dirKeyword, setDirKeyword] = useState('');
  // 特殊账号不活跃状态（7 天无转存冻结 / 14 天无转存禁用）
  const [inactive, setInactive] = useState<InactivityState | null>(null);
  const [unfreezing, setUnfreezing] = useState(false);

  async function loadInactivity() {
    try {
      setInactive(await fetchMyInactivityState());
    } catch { /* 非关键信息，读取失败静默 */ }
  }

  useEffect(() => { void loadInactivity(); }, []);

  async function handleUnfreeze() {
    if (unfreezing) return;
    setUnfreezing(true);
    try {
      const r = await unfreezeMyAccount();
      toast.success(r.message);
      await loadInactivity();
    } catch (e) {
      toast.error((e as Error).message || '解冻失败');
    } finally { setUnfreezing(false); }
  }
  const [dirTrail, setDirTrail] = useState<Array<{ id: string; name: string }>>([{ id: '', name: '根目录' }]);

  async function loadDirs(parentId: string) {
    setDirLoading(true);
    try {
      setDirs(await fetchPanDirs({ pan: form.pan, parentId }));
    } catch (e) {
      setDirs([]);
      toast.error((e as Error).message || '读取目录失败');
    } finally {
      setDirLoading(false);
    }
  }

  function openDirPicker() {
    setDirPicker(true);
    setDirTrail([{ id: '', name: '根目录' }]);
    void loadDirs('');
  }

  function enterDir(d: PanDir) {
    setDirTrail((t) => [...t, { id: d.id, name: d.name }]);
    void loadDirs(d.id);
  }

  function gotoTrail(idx: number) {
    const next = dirTrail.slice(0, idx + 1);
    setDirTrail(next);
    void loadDirs(next[next.length - 1].id);
  }

  function pickCurrentDir() {
    const trail = dirTrail;
    const cur = trail[trail.length - 1];
    // 迅雷没有「账号默认目录」这一层：空目录 ID 会被服务端拒绝（防止文件落进网盘根目录），
    // 所以必须点进一个具体文件夹再选，否则订阅保存后转存一定失败。
    if (form.pan === 'xunlei' && !cur.id) {
      toast.info('迅雷云盘不能转存到根目录：请点进一个具体文件夹，再点「选择当前目录」');
      return;
    }
    setForm((f) => ({
      ...f,
      targetDir: cur.id,
      targetDirName: trail.map((t) => t.name).slice(1).join('/'),
    }));
    setDirPicker(false);
  }
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [subRemove, setSubRemove] = useState<Subscription | null>(null);
  /** 管理员维护的订阅源：受限账号只能从这里选（普通账号不使用这个列表） */
  const [sources, setSources] = useState<SubscriptionSource[]>([]);
  /** 管理员「资源管理」里更新中的资源链接（受限账号的主要订阅源） */
  const [resSources, setResSources] = useState<AdminResourceSource[]>([]);
  const [resSrcLoading, setResSrcLoading] = useState(false);
  // 选择订阅源弹窗（搜索 + 资源列表 + 光鸭/夸克二选一）
  const [srcPicker, setSrcPicker] = useState(false);
  const [srcQuery, setSrcQuery] = useState('');
  /** 订阅源模式：自定义地址 / 内置订阅源（管理员维护的订阅源 + 资源库链接） */
  const [srcMode, setSrcMode] = useState<'custom' | 'builtin'>('custom');

  /**
   * 订阅源列表：管理员维护的「订阅源」对所有能订阅的账号都展示（弹窗里可选「内置订阅源」）。
   * 管理员「资源库链接」可能很多，改成需要时再拉：受限账号进页面就拉（它只有这一种来源），
   * 普通账号在打开新建/编辑弹窗时拉一次。
   */
  useEffect(() => {
    fetchSubscriptionSources()
      .then(setSources)
      .catch(() => { /* 静默失败：弹窗里会提示「管理员还没有配置订阅源」 */ });
    if (!subOnly) return;
    void loadResourceSources();
  }, [subOnly]);

  /** 拉取管理员「更新中」资源的网盘链接（内置订阅源之一）；已拉过就不重复请求 */
  async function loadResourceSources() {
    if (resSrcLoading || resSources.length > 0) return;
    setResSrcLoading(true);
    try {
      setResSources(await fetchAdminResourceSources());
    } catch { /* 静默失败：弹窗里提示「读取资源失败」 */ }
    finally { setResSrcLoading(false); }
  }

  /** 按资源聚合：一个资源可能同时有光鸭 + 夸克两条链接，让用户自己挑 */
  const resSourceGroups = useMemo(() => {
    const q = srcQuery.trim().toLowerCase();
    const groups = new Map<string, { resource_id: string; name: string; episode_count: number; links: AdminResourceSource[] }>();
    for (const s of resSources) {
      if (q && !s.name.toLowerCase().includes(q)) continue;
      const g = groups.get(s.resource_id);
      if (g) g.links.push(s);
      else groups.set(s.resource_id, { resource_id: s.resource_id, name: s.name, episode_count: s.episode_count, links: [s] });
    }
    // 光鸭在前、夸克在后，稳定展示
    for (const g of groups.values()) {
      g.links.sort((a, b) => (a.pan === b.pan ? 0 : a.pan === 'guangya' ? -1 : 1));
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [resSources, srcQuery]);
  /** 资源总数（不受搜索框影响，用于文案） */
  const resSourceTotal = useMemo(() => new Set(resSources.map((s) => s.resource_id)).size, [resSources]);

  // ---------- 源主（Source Owner）----------
  /**
   * 源主的「更新中」资源也会出现在内置订阅源里。
   * 多位源主时先展示源主列表，点进去看该源主的资源，再选具体资源订阅。
   * 特殊邀请码账号（subOnly）在数据库层就被挡住，这两个接口会返回空数组。
   */
  const [owners, setOwners] = useState<SourceOwner[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(false);
  /** 选中的源主；为 null 时展示源主列表 */
  const [ownerPicked, setOwnerPicked] = useState<SourceOwner | null>(null);
  const [ownerResources, setOwnerResources] = useState<SourceOwnerResource[]>([]);
  const [ownerResLoading, setOwnerResLoading] = useState(false);

  async function loadOwners() {
    if (ownersLoading) return;
    setOwnersLoading(true);
    try {
      setOwners(await fetchSourceOwners());
    } catch { /* 静默失败：弹窗里不显示源主分组 */ }
    finally { setOwnersLoading(false); }
  }

  /** 进入某个源主的资源列表（先拉资源再切视图，避免空白） */
  async function enterOwner(owner: SourceOwner) {
    setOwnerResLoading(true);
    setOwnerPicked(owner);
    setSrcQuery('');
    try {
      setOwnerResources(await fetchSourceOwnerResources(owner.owner_id));
    } catch {
      setOwnerResources([]);
    } finally {
      setOwnerResLoading(false);
    }
  }

  /** 返回源主列表 */
  function backToOwners() {
    setOwnerPicked(null);
    setOwnerResources([]);
    setSrcQuery('');
  }

  /** 源主的资源按资源聚合（结构与管理员资源一致，便于复用渲染） */
  const ownerGroups = useMemo(() => {
    const q = srcQuery.trim().toLowerCase();
    const groups = new Map<string, { resource_id: string; name: string; episode_count: number; links: SourceOwnerResource[] }>();
    for (const s of ownerResources) {
      if (q && !s.name.toLowerCase().includes(q)) continue;
      const g = groups.get(s.resource_id);
      if (g) g.links.push(s);
      else groups.set(s.resource_id, { resource_id: s.resource_id, name: s.name, episode_count: s.episode_count, links: [s] });
    }
    for (const g of groups.values()) {
      g.links.sort((a, b) => (a.pan === b.pan ? 0 : a.pan === 'guangya' ? -1 : 1));
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [ownerResources, srcQuery]);

  // 校准结果
  const [probeTarget, setProbeTarget] = useState<PanKey | null>(null);
  const [probeUrl, setProbeUrl] = useState('');
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [copied, setCopied] = useState(false);

  // 光鸭令牌绑定（填入 Access Token / Refresh Token / Client ID）
  const [tokenDialog, setTokenDialog] = useState(false);
  const [gyAccessToken, setGyAccessToken] = useState('');
  const [gyRefreshToken, setGyRefreshToken] = useState('');
  const [gyClientId, setGyClientId] = useState('aMe-8VSlkrbQXpUR');
  const [tokenSaving, setTokenSaving] = useState(false);

  // 迅雷令牌绑定：必须用「自己客户端会话」的令牌 + 同源设备 ID（扫码令牌没有设备档案）
  const [xlTokenDialog, setXlTokenDialog] = useState(false);
  const [xlAccessToken, setXlAccessToken] = useState('');
  const [xlRefreshToken, setXlRefreshToken] = useState('');
  const [xlDeviceId, setXlDeviceId] = useState('');
  const [xlClientId, setXlClientId] = useState('');
  const [xlClientVersion, setXlClientVersion] = useState('');
  const [xlCaptchaToken, setXlCaptchaToken] = useState('');
  /** 整段粘贴用的暂存区（粘贴即自动拆分，不参与提交） */
  const [xlBulkText, setXlBulkText] = useState('');
  const [xlTokenSaving, setXlTokenSaving] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [p, s, i] = await Promise.all([
        listPanAccounts(),
        listSubscriptions(),
        listSubscriptionItems({ limit: 50 }),
      ]);
      setPans(p); setSubs(s); setItems(i);
    } catch (e) {
      // 静默刷新失败不打扰用户：下一轮自会重试
      if (!silent) toast.error((e as Error).message || '加载订阅数据失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 执行是在服务端后台跑的，「运行中 / 结果」随时会变；页面停留期间每 20 秒静默拉一次，
  // 省得用户非得手动点「刷新」才看得到状态变化。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 20000);
    return () => clearInterval(timer);
  }, [load]);

  // ───────── 光鸭扫码授权（设备码流程）─────────
  // 相比粘贴令牌：换回的凭证是发给官方 client_id 的，后续能一直自动续期
  const [scanOpen, setScanOpen] = useState(false);
  const [scanStarting, setScanStarting] = useState(false);
  const [scanSession, setScanSession] = useState<PanDeviceSession | null>(null);
  const [scanTip, setScanTip] = useState('');
  const [scanRemain, setScanRemain] = useState(0);
  /** 当前扫码的是哪个网盘（光鸭设备码 / 夸克 uop 二维码 / 百度 passport 二维码） */
  const [scanPan, setScanPan] = useState<PanScanKey>('guangya');
  /**
   * 「授权成功只处理一次」标记 + 定时器句柄。
   * 轮询是异步的、间隔只有 2 秒，而每次请求要走光鸭账号网关（常要好几秒）→ 两轮很容易重叠。
   * 关键：同一个会话只有「第一次成功」的那次响应带回凭证，之后再轮询只回 { status: 'success' }
   * 且不带凭证 —— 晚到的那一轮会把刚填好的表单清空（用户手一慢就没法保存）。
   */
  const scanDoneRef = useRef(false);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopScanTimer() {
    if (scanTimerRef.current !== null) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }

  async function handleStartScan(pan: PanScanKey = 'guangya') {
    if (LOCKED_PANS[pan]) { toast.info(lockedTip(pan)); return; }
    stopScanTimer();
    scanDoneRef.current = false; // 重新扫码：允许再处理一次成功结果
    setScanPan(pan);
    setScanOpen(true);
    setScanStarting(true);
    setScanSession(null);
    setScanTip(
      pan === 'baidu'
        ? '正在获取百度登录二维码…'
        : pan === 'quark'
          ? '正在获取夸克登录二维码…'
          : pan === 'xunlei'
            ? '正在获取迅雷登录二维码…'
            : pan === 'uc'
              ? '正在获取 UC 登录二维码…'
              : '正在申请授权码…'
    );
    try {
      const s = await startPanDeviceAuth(pan);
      setScanSession(s);
      setScanRemain(s.expiresIn);
      setScanTip(
        s.hint ||
          (pan === 'baidu'
            ? '请用手机「百度 App」或「百度网盘 App」扫码，扫码后点「确认登录」'
            : pan === 'quark'
              ? '请用手机「夸克 App」扫码，并在手机上点「确认登录」'
              : pan === 'xunlei'
                ? '请用手机「迅雷」扫码，并在手机上点「确认登录」'
                : pan === 'uc'
                  ? '请用手机「UC 网盘 App」或「UC 浏览器」扫码，并在手机上点「确认登录」'
                  : '请用光鸭云盘 App 扫码，并在手机上点击「同意登录」')
      );
    } catch (e) {
      const msg = (e as Error).message || '发起扫码授权失败';
      setScanTip(msg);
      toast.error(msg);
    } finally {
      setScanStarting(false);
    }
  }

  // 轮询授权结果：用户在光鸭确认后自动把凭证填进令牌表单
  useEffect(() => {
    if (!scanSession) return;
    scanTimerRef.current = setInterval(async () => {
      // 成功已经处理过：立刻停表，不再发请求（晚到的一轮只会拿到不带凭证的 success，会把表单清空）
      if (scanDoneRef.current) { stopScanTimer(); return; }
      setScanRemain((r) => (r > 0 ? r - 1 : 0));
      try {
        const r = await pollPanDeviceAuth(scanSession.sessionId);
        if (r.status === 'success') {
          // 只在「第一次成功」时收尾并回填；重复的成功响应直接忽略
          if (scanDoneRef.current) return;
          scanDoneRef.current = true;
          stopScanTimer();
          // 百度 / 夸克 / 迅雷 / UC / 123：服务端已把扫码换来的凭据加密落库，前端只需刷新账号列表
          // （123 原来漏在这里，成功后会误弹光鸭的令牌表单）
          const donePan = r.pan ?? scanSession.pan;
          if (donePan === 'baidu' || donePan === 'quark' || donePan === 'xunlei' || donePan === 'uc' || donePan === 'p123') {
            const label = PAN_LABELS[donePan as PanKey] ?? '网盘';
            toast.success(r.message || `${label}网盘已绑定（凭据已加密保存）`);
            setScanSession(null);
            setScanOpen(false);
            await load();
            if (donePan === 'xunlei') {
              // 扫码只能自动拿到令牌这一半（access/refresh/client_id）；
              // device_id 不在令牌里，必须用户从自己客户端请求头补，才能过设备档案校验。
              try {
                const p = await prefillXunleiToken();
                setXlAccessToken(p.accessToken);
                setXlRefreshToken(p.refreshToken);
                setXlClientId(p.clientId);
                setXlClientVersion(p.clientVersion);
                setXlDeviceId(p.deviceId || '');
                setXlTokenDialog(true);
                toast.info(
                  p.deviceId
                    ? '令牌已自动填入（设备 ID 沿用上次可用的），直接点「保存并校验」即可'
                    : '令牌与 Client ID 已自动填入，补上你自己客户端的设备 ID 后点「保存并校验」'
                );
              } catch (e) {
                toast.warning(`自动填入失败，请手动填写：${(e as Error).message}`);
                setXlTokenDialog(true);
              }
            }
            return;
          }
          const at = r.accessToken ?? '';
          const rt = r.refreshToken ?? '';
          if (at || rt) {
            // 扫码换回的凭证不直接落库：自动填进「填入光鸭令牌」表单，
            // 由用户确认后走原有的手动保存逻辑（已验证稳定）
            setGyRefreshToken(rt);
            setGyAccessToken(at);
            if (r.clientId) setGyClientId(r.clientId);
            toast.success('扫码成功，凭证已填入令牌表单，请确认后保存');
          } else {
            // 极少数情况：服务端已标记成功但这次响应不含凭证（例如上次响应丢包）→ 让用户重扫
            toast.warning('授权已完成，但本次未取到凭证，请重新扫码一次');
          }
          setScanSession(null);
          setScanOpen(false);
          setTokenDialog(true);
        } else if (r.status === 'failed') {
          scanDoneRef.current = true;
          stopScanTimer();
          toast.error(`授权失败：${r.message || '已拒绝'}`);
          setScanSession(null);
        } else if (r.status === 'expired') {
          scanDoneRef.current = true;
          stopScanTimer();
          setScanTip('授权码已过期，请关闭后重新发起');
          setScanSession(null);
        } else {
          setScanTip(r.message || '等待扫码授权…');
        }
      } catch {
        /* 网络抖动：下一轮继续轮询 */
      }
    }, Math.max(2, scanSession.interval) * 1000);
    return stopScanTimer;
  }, [scanSession, load]);


  function panOf(pan: PanKey): PanAccount | undefined {
    return pans.find((p) => p.pan === pan);
  }

  // ───────── 光鸭令牌绑定 ─────────

  /**
   * 支持把浏览器 localStorage 里 `credentials_<client_id>` 的整段 JSON 直接粘进
   * Access Token 输入框：能解析时自动拆到三个字段，省得逐个复制。
   */
  function handleGyTokenInput(raw: string) {
    setGyAccessToken(raw);
    const text = raw.trim();
    if (!text.startsWith('{')) return;
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const at = String(obj.access_token ?? '');
      if (!at) return;
      setGyAccessToken(at);
      if (obj.refresh_token) setGyRefreshToken(String(obj.refresh_token));
      if (obj.client_id) setGyClientId(String(obj.client_id));
      toast.info('已从粘贴的 JSON 中自动拆分出 Access / Refresh Token');
    } catch {
      /* 不是 JSON，按普通文本处理 */
    }
  }

  async function handleBindPanTokens() {
    if (!gyAccessToken.trim() && !gyRefreshToken.trim()) {
      toast.info('请至少填写 Refresh Token（推荐）或 Access Token');
      return;
    }
    setTokenSaving(true);
    try {
      const r = await bindPanTokens({
        pan: 'guangya',
        accessToken: gyAccessToken.trim(),
        refreshToken: gyRefreshToken.trim(),
        clientId: gyClientId.trim(),
      });
      if (r.verified === false) toast.warning(r.message || '令牌已保存，但校验未通过');
      else toast.success(r.message || '光鸭令牌已加密保存');
      setTokenDialog(false);
      setGyAccessToken('');
      setGyRefreshToken('');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '保存光鸭令牌失败');
    } finally {
      setTokenSaving(false);
    }
  }

  /**
   * 整段粘贴自动拆分：支持「Key: 值」每行一条（Bearer、引号、中文冒号都能吃），
   * 也支持只贴裸值（按 eyJ… / ck0. / a1. / 32位hex / x.y.z 特征猜字段）。
   */
  function parseXlCredBlob(raw: string): Record<string, string> {
    const got: Record<string, string> = {};
    const put = (k: string, v: string) => {
      const val = v.trim().replace(/^["'`]|["'`,]$/g, '').replace(/^Bearer\s+/i, '').trim();
      if (val && !got[k]) got[k] = val;
    };
    const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      // 键名归一化：去掉空格/下划线/连字符/括号，这样「设备 ID (x-device-id)」也能认
      const m = /^([^:：=]{2,32})[:：=]\s*(.+)$/.exec(line);
      if (m) {
        const key = m[1].toLowerCase().replace(/[\s_\-()（）]/g, '');
        const v = m[2];
        if (/accesstoken|authorization|访问令牌|^令牌/.test(key)) put('accessToken', v);
        else if (/refreshtoken|刷新令牌/.test(key)) put('refreshToken', v);
        else if (/deviceid|设备id|设备号/.test(key)) put('deviceId', v);
        else if (/clientid|客户端id/.test(key)) put('clientId', v);
        else if (/clientversion|versioncode|客户端版本/.test(key)) put('clientVersion', v);
        else if (/captchatoken|风控令牌|验证码/.test(key)) put('captchaToken', v);
        continue;
      }
      if (/^ey[A-Za-z0-9._-]{20,}$/.test(line)) put('accessToken', line);
      else if (/^ck0\./.test(line)) put('captchaToken', line);
      else if (/^a1\./.test(line)) put('refreshToken', line);
      else if (/^(wdi10\.)?[0-9a-f]{32}/i.test(line)) put('deviceId', line);
      else if (/^\d+\.\d+\.\d+/.test(line)) put('clientVersion', line);
      else if (line === 'Xqp0kJBXWhwaTpB6' || line === 'XW5SkOhLDjnOZP7J') put('clientId', line);
    }
    return got;
  }

  /** 把整段文本拆进各输入框（粘贴时自动调用，也可点按钮） */
  function applyXlCredBlob(text: string) {
    const got = parseXlCredBlob(text);
    const n = Object.keys(got).length;
    if (!n) {
      toast.info('没识别到字段：请保持「Access Token: 值」「设备 ID: 值」每行一条的格式');
      return;
    }
    if (got.accessToken) setXlAccessToken(got.accessToken);
    if (got.refreshToken) setXlRefreshToken(got.refreshToken);
    if (got.deviceId) setXlDeviceId(got.deviceId);
    if (got.clientId) setXlClientId(got.clientId);
    if (got.clientVersion) setXlClientVersion(got.clientVersion);
    if (got.captchaToken) setXlCaptchaToken(got.captchaToken);
    const names = [
      got.accessToken && 'Access Token',
      got.refreshToken && 'Refresh Token',
      got.deviceId && '设备 ID',
      got.clientId && 'Client ID',
      got.clientVersion && 'Client Version',
      got.captchaToken && '风控令牌',
    ].filter(Boolean).join('、');
    toast.success(`已识别 ${n} 项：${names}`);
  }

  /** 迅雷令牌绑定：Access Token + 设备 ID（同一个客户端会话里抓到的） */
  async function handleBindXunleiToken() {
    const at = xlAccessToken.trim().replace(/^Bearer\s+/i, '');
    const dev = xlDeviceId.trim().toLowerCase().replace(/^wdi10\.?/, '');
    if (!at) { toast.info('请填写 Access Token'); return; }
    if (!/^[0-9a-f]{32}/.test(dev)) { toast.info('设备 ID 必须是 32 位十六进制（可整串粘 deviceid，会自动截取）'); return; }
    setXlTokenSaving(true);
    try {
      const r = await bindXunleiToken({
        accessToken: at,
        refreshToken: xlRefreshToken.trim(),
        deviceId: dev,
        clientId: xlClientId.trim(),
        clientVersion: xlClientVersion.trim(),
        captchaToken: xlCaptchaToken.trim(),
      });
      if (r.verified === false) toast.warning(r.message || '令牌已保存，但设备档案校验未通过');
      else toast.success(r.message || '迅雷令牌已加密保存');
      setXlTokenDialog(false);
      setXlAccessToken('');
      setXlRefreshToken('');
      setXlCaptchaToken('');
      setXlBulkText('');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '保存迅雷令牌失败');
    } finally {
      setXlTokenSaving(false);
    }
  }

  // ───────── 网盘账号 ─────────
  async function handleBindPan() {
    if (!panDialog) return;
    const isToken = panDialog === 'p123';
    if (!panCookie.trim()) { toast.info(isToken ? '请粘贴 123 云盘登录令牌' : '请粘贴网盘登录 Cookie'); return; }
    setPanSaving(true);
    try {
      await bindPanAccount({ pan: panDialog, cookie: panCookie.trim(), username: panUser, rootDir: panDir });
      toast.success(`${PAN_LABELS[panDialog]} 已绑定（${isToken ? '令牌' : 'Cookie'} 已加密存储）`);
      setPanDialog(null); setPanCookie(''); setPanUser(''); setPanDir('');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '绑定失败');
    } finally {
      setPanSaving(false);
    }
  }

  async function handleRemovePan() {
    if (!panRemove) return;
    try {
      await removePanAccount(panRemove);
      toast.success('已解绑网盘账号');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '解绑失败');
    } finally {
      setPanRemove(null);
    }
  }

  async function handleProbe() {
    if (!probeTarget) return;
    // 光鸭 / 百度：只读探测自己的网盘即可（不需要样本链接）；夸克要用一条分享链接验证读取能力
    if (probeTarget === 'quark' && !probeUrl.trim()) {
      toast.info('请填写一个夸克分享链接作为样本');
      return;
    }
    setProbing(true);
    try {
      const r = await probePanAccount(probeTarget, probeUrl.trim());
      setProbeResult(JSON.stringify(r, null, 2));
    } catch (e) {
      toast.error((e as Error).message || '探测失败');
    } finally {
      setProbing(false);
    }
  }

  // ───────── 订阅 ─────────
  /** 订阅数量上限（普通用户 80 / 订阅专用账号 10 或管理员设定值）：达到后不允许再新建 */
  const atSubLimit = maxSubs !== null && subs.length >= maxSubs;

  function openSubDialog(editing?: Subscription) {
    if (!editing && atSubLimit) {
      toast.error(`订阅数量已达上限（${maxSubs} 个），请先删除不用的订阅`);
      return;
    }
    setPreview(null);
    setForm(editing ? {
      name: editing.name, sourceUrl: editing.source_url, sourceType: editing.source_type,
      sourcePasscode: editing.source_passcode ?? extractPasscodeFromUrl(editing.source_url),
      keyword: editing.keyword ?? '', pan: editing.pan,
      targetDir: editing.target_dir ?? '', targetDirName: editing.target_dir_name ?? '',
      // 受限账号（特殊邀请码注册）：文件名清洗固定「不处理，保留原文件名」
      cleanMode: subOnly ? 'none' : ((editing.clean_mode === 'episode' ? 'episode' : 'none') as 'none' | 'episode'),
      folderMode: editing.folder_mode === true,
      autoPublish: editing.auto_publish, resourceId: editing.resource_id ?? '',
      enabled: editing.enabled, intervalMinutes: editing.interval_minutes,
      // 老数据（没有这个字段）视为开启：与数据库默认值保持一致
      adaptiveEnabled: editing.adaptive_enabled !== false,
      totalEpisodes: editing.total_episodes ? String(editing.total_episodes) : '',
    } : {
      name: '', sourceUrl: '', sourceType: 'auto', sourcePasscode: '', keyword: '', pan: 'guangya',
      targetDir: '', targetDirName: '', cleanMode: subOnly ? 'none' : 'episode', autoPublish: false,
      folderMode: false, resourceId: '',
      enabled: true, intervalMinutes: 10, adaptiveEnabled: true, totalEpisodes: '',
    });
    // 回显已绑定的资源（只取这一条，避免每次打开弹窗都拉全量资源）
    setBoundRes(null);
    if (editing?.resource_id) {
      fetchResourceBrief(editing.resource_id)
        .then((r) => setBoundRes(r))
        .catch(() => { /* 资源已删除等情况：不显示即可 */ });
    }
    // 源地址来自「管理员订阅源」时，默认停在「内置订阅源」；否则默认「自定义订阅」
    const srcUrl = editing?.source_url ?? '';
    setSrcMode(subOnly || (!!srcUrl && sources.some((s) => s.source_url === srcUrl)) ? 'builtin' : 'custom');
    // 普通账号：打开弹窗时补拉一次资源库链接（内置订阅源选择 + 编辑时判断来源）
    if (!subOnly) void loadResourceSources();
    setSubDialog({ open: true, editing });
  }

  /** 打开「选择资源」弹窗：首次打开时拉一次资源列表 */
  async function openResPicker() {
    setResPicker(true);
    if (resList.length > 0) return;
    setResLoading(true);
    try {
      setResList(await fetchResources());
    } catch (e) {
      toast.error((e as Error).message || '读取资源列表失败');
    } finally {
      setResLoading(false);
    }
  }

  /** 源地址是不是网盘分享链接（是的话走「分享目录监控」） */
  function detectSharePan(url: string): PanKey | null {
    const u = url.trim();
    if (/guangyapan\.com\/s\//i.test(u)) return 'guangya';
    // UC 必须先判：share 链接是 drive.uc.cn/s/xxx，别被夸克那条正则吞掉
    if (/(drive\.uc\.cn|pc-api\.uc\.cn)\/s\//i.test(u)) return 'uc';
    // 123 云盘：分享跑在 https://<分享号>.share.123pan.cn/123pan/<key>
    if (/(share\.123pan\.cn|123pan\.com|123865\.com|123684\.com|123912\.com)\//i.test(u)) return 'p123';
    if (/pan\.quark\.cn\/s\//i.test(u)) return 'quark';
    if (/(pan\.baidu\.com|yun\.baidu\.com)\/s\//i.test(u)) return 'baidu';
    if (/pan\.xunlei\.com\/s\//i.test(u)) return 'xunlei';
    return null;
  }

  /** 填分享链接时自动切到「分享目录监控」并把目标网盘对齐（跨盘无法转存） */
  function onSourceUrlChange(v: string) {
    const detected = detectSharePan(v);
    // 锁定中的网盘（迅雷）不自动切换目标网盘：切过去也存不了，保存/预览时会明确提示
    const usable = detected && !LOCKED_PANS[detected] ? detected : null;
    // 链接自带 ?pwd=xxxx（百度 / 夸克「复制链接」都长这样）：自动填进提取码，用户不用再单独找
    const pwdFromUrl = extractPasscodeFromUrl(v);
    setPreview(null);
    setForm((f) => ({
      ...f,
      sourceUrl: v,
      ...(usable ? { sourceType: 'pan_share' as 'auto' | 'rss' | 'page' | 'pan_share', pan: usable } : {}),
      ...(pwdFromUrl ? { sourcePasscode: pwdFromUrl } : {}),
    }));
  }

  /**
   * 受限账号从管理员订阅源里选一条：把地址与其余默认项一起带进表单。
   * 转存目录仍由用户自己选（每个账号用的是自己的网盘目录，管理员无法代选）。
   */
  function applySource(srcId: string) {
    const s = sources.find((x) => x.id === srcId);
    if (!s) return;
    setPreview(null);
    setForm((f) => ({
      ...f,
      sourceUrl: s.source_url,
      sourceType: s.source_type,
      // 库里没存提取码时，从链接自带的 ?pwd= 补上（百度带码分享不给码打不开）
      sourcePasscode: s.source_passcode ?? extractPasscodeFromUrl(s.source_url),
      keyword: s.keyword ?? '',
      pan: s.pan,
      cleanMode: subOnly ? 'none' : s.clean_mode,
      intervalMinutes: s.interval_minutes,
      name: f.name.trim() ? f.name : s.name,
    }));
    if (LOCKED_PANS[s.pan]) toast.info(lockedTip(s.pan));
  }

  /**
   * 从管理员「更新中」的资源里选一条链接：一个资源可能同时有光鸭和夸克，点哪条用哪条。
   * 换网盘会清掉已选的目标目录（目录 ID 属于具体网盘，换盘后原来的目录无效）。
   * 受限账号没有「资源管理」→ 不开启联动；普通账号选的就是资源库里那条资源 → 自动绑定，
   * 之后集数/完结状态会跟着订阅更新（含「全集数」自动完结）。
   */
  function applyResourceSource(name: string, link: AdminResourceSource) {
    setPreview(null);
    const panChanged = form.pan !== link.pan;
    // 普通账号：开启联动（按剧名匹配到自己的同名资源，集数/完结状态跟着更新）。
    // 注意不能直接绑定管理员的这条资源 —— 资源归属校验只允许绑定自己的资源（服务端会拒绝）。
    const autoLink = !subOnly;
    setForm((f) => ({
      ...f,
      name: f.name.trim() ? f.name : name,
      sourceUrl: link.url,
      sourceType: 'pan_share',
      // 管理员资源里的百度链接也可能自带 ?pwd=（带码分享必须有），一并带过来
      sourcePasscode: extractPasscodeFromUrl(link.url),
      keyword: '',
      pan: link.pan,
      cleanMode: subOnly ? 'none' : 'episode',
      autoPublish: autoLink,
      resourceId: '',
      // 分享目录监控默认 30 分钟一轮，避免每分钟扫一次分享；普通账号保留自己已选的间隔
      ...(subOnly ? { intervalMinutes: 30 } : {}),
      ...(panChanged ? { targetDir: '', targetDirName: '' } : {}),
    }));
    setBoundRes(null);
    setSrcPicker(false);
    if (LOCKED_PANS[link.pan]) { toast.info(lockedTip(link.pan)); return; }
    toast.success(
      `已选择「${name}」的${PAN_LABELS[link.pan]}分享链接${autoLink ? '（已开启按剧名自动匹配资源）' : ''}`
    );
  }

  async function handlePreview() {
    if (!form.sourceUrl.trim()) { toast.info('请先填写订阅源地址'); return; }
    const previewSharePan = detectSharePan(form.sourceUrl);
    if (previewSharePan && LOCKED_PANS[previewSharePan]) { toast.info(lockedTip(previewSharePan)); return; }
    setPreviewing(true);
    try {
      const r = await previewSubscriptionSource({
        url: form.sourceUrl.trim(), sourceType: form.sourceType, keyword: form.keyword,
        // 提取码没填就认链接自带的 ?pwd=（百度带码分享不给码解析不出来）
        passcode: form.sourcePasscode.trim() || extractPasscodeFromUrl(form.sourceUrl),
        cleanMode: form.cleanMode,
      });
      setPreview(r);
      toast.success(`解析成功：共 ${r.total} 条，命中 ${r.filtered} 条`);
    } catch (e) {
      setPreview(null);
      toast.error((e as Error).message || '解析失败');
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSaveSub() {
    if (!form.sourceUrl.trim()) {
      toast.info(
        subOnly
          ? '请先从下拉列表中选择一个订阅源'
          : srcMode === 'builtin'
            ? '请先选择内置订阅源（或切回「自定义订阅」自己填地址）'
            : '请填写订阅源地址'
      );
      return;
    }
    if (!subDialog.editing && atSubLimit) {
      toast.error(`最多只能订阅 ${maxSubs} 个链接，请先删除不用的订阅`);
      return;
    }
    /*
     * 分享链接与目标网盘必须同盘。用户很容易在「网盘账号」里选了迅雷、但订阅表单里的
     * 目标网盘还是默认的光鸭，保存时才被后端拦下来（"请选择迅雷云盘"看得一头雾水）。
     * 这里按链接直接对齐，并说清楚为什么要重选目录。
     */
    const sharePan = detectSharePan(form.sourceUrl);
    // 锁定中的网盘（迅雷）：既不自动切换目标网盘，也不允许保存
    if (sharePan && LOCKED_PANS[sharePan]) {
      toast.info(lockedTip(sharePan));
      return;
    }
    if (LOCKED_PANS[form.pan]) {
      toast.info(lockedTip(form.pan));
      return;
    }
    if (sharePan && sharePan !== form.pan) {
      setForm((f) => ({ ...f, pan: sharePan, targetDir: '', targetDirName: '' }));
      toast.info(
        `订阅源是「${PAN_LABELS[sharePan]}」分享链接，已自动把目标网盘切换为${PAN_LABELS[sharePan]}：请重新选择转存目录后再保存`
      );
      return;
    }
    // 迅雷转存必须落在具体文件夹：根目录（空 ID）后端会直接拒绝，提前讲清楚
    if (form.pan === 'xunlei' && !form.targetDir) {
      toast.info('迅雷云盘请先选择一个具体的转存文件夹（不能是根目录）：点「选择目录」进入文件夹后再确定');
      return;
    }
    setSubSaving(true);
    try {
      const { updatedExisting } = await saveSubscription({
        id: subDialog.editing?.id,
        name: form.name.trim() || '未命名订阅',
        sourceUrl: form.sourceUrl.trim(),
        sourceType: form.sourceType,
        // 链接自带 ?pwd= 时也要落库：定时任务跑的时候库里的提取码才是权威
        sourcePasscode: form.sourcePasscode.trim() || extractPasscodeFromUrl(form.sourceUrl),
        keyword: form.keyword,
        // 受限账号固定「不处理」：服务端也会兜底，这里只是保持前后一致
        cleanMode: subOnly ? 'none' : form.cleanMode,
        // 文件夹模式：光鸭与夸克都支持（其它网盘由数据库触发器强制关闭）
        folderMode: form.folderMode,
        pan: form.pan,
        targetDir: form.targetDir,
        targetDirName: form.targetDirName,
        autoPublish: form.autoPublish,
        resourceId: form.resourceId || null,
        enabled: form.enabled,
        intervalMinutes: form.intervalMinutes,
        adaptiveEnabled: form.adaptiveEnabled,
        // 全集数：留空/0 → 不自动完结
        totalEpisodes: Number(form.totalEpisodes) || 0,
      });
      toast.success(
        updatedExisting
          ? '该订阅源已存在，已更新原有订阅'
          : subDialog.editing
            ? '订阅已更新'
            : '订阅已创建，定时任务会自动执行'
      );
      setSubDialog({ open: false });
      await load();
    } catch (e) {
      toast.error((e as Error).message || '保存失败');
    } finally {
      setSubSaving(false);
    }
  }

  async function handleRun(sub: Subscription) {
    if (!subEnabled) { toast.error('订阅功能未开通，请联系管理员开启'); return; }
    if (LOCKED_PANS[sub.pan as PanKey]) { toast.info(lockedTip(sub.pan as PanKey)); return; }
    setBusy(sub.id);
    try {
      const r = await runSubscriptionOnce(sub.id);
      toast.success(r.message || '执行完成');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '执行失败');
    } finally {
      setBusy(null);
    }
  }

  async function handleRunAll() {
    if (!subEnabled) { toast.error('订阅功能未开通，请联系管理员开启'); return; }
    setRunning(true);
    try {
      const r = await runAllSubscriptions(true);
      toast.success(`已执行 ${r.ran} 个订阅`);
      await load();
    } catch (e) {
      toast.error((e as Error).message || '执行失败');
    } finally {
      setRunning(false);
    }
  }

  async function handleToggle(sub: Subscription) {
    try {
      await toggleSubscription(sub.id, !sub.enabled);
      setSubs((prev) => prev.map((s) => (s.id === sub.id ? { ...s, enabled: !s.enabled } : s)));
      toast.success(sub.enabled ? '已暂停该订阅' : '已启用该订阅');
    } catch (e) {
      toast.error((e as Error).message || '操作失败');
    }
  }

  async function handleRemoveSub() {
    if (!subRemove) return;
    try {
      await removeSubscription(subRemove.id);
      toast.success('订阅已删除');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '删除失败');
    } finally {
      setSubRemove(null);
    }
  }

  async function handleClearFailed() {
    try {
      await clearSubscriptionItems({ onlyFailed: true });
      toast.success('已清理失败记录');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '清理失败');
    }
  }

  /** 订阅搜索关键字：按名称 / 源地址 / 关键字 / 转存目录匹配，订阅多了靠它快速定位 */
  const [subQuery, setSubQuery] = useState('');
  /** 当前网盘筛选 + 搜索关键字下要展示的订阅 */
  const shownSubs = useMemo(() => {
    const q = subQuery.trim().toLowerCase();
    return subs.filter((s) => {
      if (panTab !== 'all' && s.pan !== panTab) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.source_url.toLowerCase().includes(q) ||
        (s.keyword ?? '').toLowerCase().includes(q) ||
        (s.target_dir_name ?? '').toLowerCase().includes(q)
      );
    });
  }, [subs, panTab, subQuery]);
  /** 是否正在筛选（搜索有内容），用于文案与空态 */
  const subFiltering = subQuery.trim().length > 0;
  /** 筛选标签：全部 + 各网盘（带各自的订阅数量），保证不同网盘的订阅能区分开 */
  const panTabs: Array<{ key: 'all' | PanKey; label: string; count: number }> = [
    { key: 'all', label: '全部', count: subs.length },
    ...PAN_KEYS.map((p) => ({
      key: p as 'all' | PanKey,
      label: PAN_LABELS[p],
      count: subs.filter((s) => s.pan === p).length,
    })),
  ];

  return (
    <AppLayout>
      <PageMeta
        title="订阅转存 - 网盘推广工具"
        description="配置订阅源（RSS / 网页更新页），定时抓取网盘分享链接，自动转存到自己的光鸭/夸克/百度网盘并写入资源库。"
        keywords="订阅转存, RSS, 网盘转存, 光鸭, 夸克, 百度网盘, 自动入库"
      />
      <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-5">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
            <Download className="h-4 w-4 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-xl font-bold text-foreground">订阅转存</h1>
            <p className="text-xs text-muted-foreground">
              定时抓取订阅源 → 提取网盘分享链接 → 自动转存到你的光鸭 / 夸克 / 百度网盘 → 写入「我的资源」（进已更新面板）
            </p>
          </div>
          <Button
            size="sm" onClick={handleRunAll} disabled={running || subs.length === 0 || !subEnabled}
            className="h-8 text-xs gap-1.5 shrink-0"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            全部执行一次
          </Button>
        </div>

        {!isMembershipActive && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-xs text-destructive">会员已过期，订阅转存暂不可用，请联系管理员续费。</span>
          </div>
        )}

        {!subEnabled && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-xs text-destructive">您的订阅功能尚未开通，暂无法使用订阅转存；请联系管理员在「用户管理」中为您开启。</span>
          </div>
        )}

        {inactive?.disabled_at && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 flex-wrap">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-xs text-destructive">
              账号已被禁用（14 天无转存记录）：订阅检测已停止，且不可自助解冻，请联系管理员。
            </span>
          </div>
        )}

        {!inactive?.disabled_at && inactive?.frozen_at && (
          <div className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 flex-wrap">
            <div className="flex items-start gap-2 min-w-0">
              <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span className="text-xs text-amber-700 dark:text-amber-500 leading-relaxed">
                账号已冻结（7 天无转存记录），订阅检测已暂停。
                {inactive.unfreeze_used
                  ? '解冻机会已使用过（每人仅一次），请联系管理员。'
                  : '你可以自助解冻一次；解冻后请尽快让订阅产生新的转存记录，否则 14 天后将被直接禁用。'}
              </span>
            </div>
            {!inactive.unfreeze_used && (
              <Button size="sm" onClick={handleUnfreeze} disabled={unfreezing}
                className="h-8 shrink-0 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
                {unfreezing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                解冻（仅一次）
              </Button>
            )}
          </div>
        )}

        {subOnly && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20">
            <AlertCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <span className="text-xs text-primary leading-relaxed">
              你的账号为「订阅专用」账号：只能使用订阅功能，且只能订阅管理员提供的订阅源（共
              {sources.length} 个可选），订阅数量上限 {limitText}（当前 {subs.length} 个）。不能自己填写任意链接。
            </span>
          </div>
        )}

        {/* 网盘驱动：卡片式展示（图标 + 授权方式 + 能力标签 + 状态/操作） */}
        <div className="rounded-xl border border-border bg-card p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">网盘驱动</h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              已绑定 {PAN_KEYS.filter((p) => !LOCKED_PANS[p] && panOf(p)).length}/{PAN_KEYS.filter((p) => !LOCKED_PANS[p]).length}
            </span>
            <span className="text-[11px] text-muted-foreground">
              光鸭扫码授权（自动续期），夸克与百度扫码或粘贴登录 Cookie，UC 粘贴 Cookie；迅雷云盘正在适配中，暂未开放。凭据在服务端加密存储，前端不可见
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {PAN_KEYS.map((pan) => {
              const acc = panOf(pan);
              const meta = PAN_META[pan];
              const ok = acc?.status === 'active';
              const locked = LOCKED_PANS[pan];
              return (
                <div
                  key={pan}
                  className={`flex flex-col rounded-xl border p-3 transition-all ${
                    locked
                      ? 'border-border bg-muted/20'
                      : ok
                        ? 'border-primary/40 bg-gradient-to-br from-primary/[0.07] via-transparent to-transparent'
                        : acc
                          ? 'border-destructive/40 bg-destructive/[0.04]'
                          : 'border-border bg-background hover:border-primary/30'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-border/60">
                      <img
                        src={meta.logo}
                        alt={PAN_LABELS[pan]}
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold leading-tight text-foreground">{PAN_LABELS[pan]}</span>
                        <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-1.5 text-[9px] font-medium leading-4 text-primary">
                          {meta.auth}
                        </span>
                        {locked && (
                          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[9px] font-medium leading-4 text-amber-500">
                            {locked}
                          </span>
                        )}
                        {acc && !ok && (
                          <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 text-[9px] font-medium leading-4 text-destructive">
                            已失效
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[10.5px] leading-snug text-muted-foreground">{meta.desc}</p>
                    </div>
                    <span className="shrink-0" title={locked ?? (ok ? '已绑定' : acc ? '凭据已失效' : '未绑定')}>
                      {locked
                        ? <Lock className="h-4 w-4 text-muted-foreground" />
                        : ok
                          ? <CheckCircle2 className="h-4 w-4 text-primary" />
                          : acc
                            ? <AlertCircle className="h-4 w-4 text-destructive" />
                            : <CircleDashed className="h-4 w-4 text-muted-foreground/50" />}
                    </span>
                  </div>

                  {acc ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] leading-snug text-muted-foreground">
                      {acc.username && (
                        <span className="max-w-[45%] truncate">
                          账号 <span className="text-foreground">{acc.username}</span>
                        </span>
                      )}
                      <span className="shrink-0">
                        {acc.credential_type === 'oauth' || pan === 'guangya' ? 'Token 加密' : 'Cookie 加密'}
                      </span>
                      <span className="max-w-[45%] truncate">
                        目录 <span className="text-foreground">{acc.root_dir || acc.root_dir_id || '根目录'}</span>
                      </span>
                      <span className="shrink-0">检查 {fmt(acc.last_check_at)}</span>
                      {acc.last_error && (
                        <span className="w-full truncate text-destructive" title={acc.last_error}>
                          错误 {acc.last_error}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground">
                      {locked
                        ? `${locked}：该网盘暂未开放，解锁后再显示绑定方式。`
                        : pan === 'guangya'
                        ? '点「扫码授权」用光鸭 App 扫码，或「填入令牌」粘贴本机存储的 Refresh Token（可只填这一项）。'
                        : pan === 'baidu'
                          ? '点「扫码登录」用百度 App 扫码即可，服务端自动换出 Cookie 并加密保存；也可点「Cookie」手动粘贴整串 Cookie（须含 BDUSS）。'
                          : pan === 'xunlei'
                            ? '迅雷业务接口要求四件套（Bearer + x-device-id + x-client-id + x-captcha-token）。扫码后会自动填好令牌，再补浏览器 localStorage 的 deviceid 与一枚 captcha token（只需一次，之后自动续期）：点「填入令牌」。'
                            : pan === 'uc'
                              ? '点「绑定 Cookie」粘贴浏览器登录 drive.uc.cn 后的整串 Cookie（必须含 __pus）；服务端会先调 /user/info 校验通过，再加密保存。'
                              : '点「扫码登录」用夸克 App 扫码即可，服务端自动换出 Cookie 并加密保存；也可点「Cookie」手动粘贴整串 Cookie。'}
                    </p>
                  )}

                  <div className="mt-auto flex items-center gap-1 pt-2">
                    {locked ? (
                      <Button
                        size="sm" variant="outline" disabled
                        className="h-7 w-full gap-1 px-2 text-[11px] text-muted-foreground"
                      >
                        <Lock className="h-3 w-3" />
                        {locked}
                      </Button>
                    ) : pan === 'guangya' ? (
                      <>
                        <Button
                          size="sm" variant="outline"
                          className="h-7 flex-1 gap-1 border-primary/30 px-2 text-[11px] text-primary hover:bg-primary/10 hover:text-primary"
                          onClick={() => handleStartScan('guangya')}
                        >
                          <QrCode className="h-3 w-3" />
                          {acc ? '重新扫码' : '扫码授权'}
                        </Button>
                        <Button
                          size="sm" variant="outline"
                          className="h-7 gap-1 border-border px-2 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() => setTokenDialog(true)}
                        >
                          <KeyRound className="h-3 w-3" />
                          {acc ? '令牌' : '填入令牌'}
                        </Button>
                      </>
                    ) : pan === 'baidu' || pan === 'quark' || pan === 'xunlei' || pan === 'uc' || pan === 'p123' ? (
                      <>
                        <Button
                          size="sm" variant="outline"
                          className="h-7 flex-1 gap-1 border-primary/30 px-2 text-[11px] text-primary hover:bg-primary/10 hover:text-primary"
                          onClick={() => handleStartScan(pan)}
                        >
                          <QrCode className="h-3 w-3" />
                          {pan === 'p123' ? 'App 扫码' : acc ? '重新扫码' : '扫码登录'}
                        </Button>
                        {/* 迅雷没有可粘贴的 Cookie：改提供「令牌 + 设备 ID」绑定（扫码令牌无设备档案）；123 云盘用的是登录令牌而非 Cookie */}
                        {pan === 'xunlei' || pan === 'p123' ? (
                          <Button
                            size="sm" variant="outline"
                            className="h-7 gap-1 border-border px-2 text-[11px] text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              if (pan === 'xunlei') { setXlTokenDialog(true); return; }
                              setPanDialog(pan); setPanCookie(''); setPanUser(acc?.username ?? ''); setPanDir(acc?.root_dir ?? '');
                            }}
                          >
                            <KeyRound className="h-3 w-3" />
                            {acc ? '令牌' : '填入令牌'}
                          </Button>
                        ) : (
                          <Button
                            size="sm" variant="outline"
                            className="h-7 gap-1 border-border px-2 text-[11px] text-muted-foreground hover:text-foreground"
                            onClick={() => { setPanDialog(pan); setPanCookie(''); setPanUser(acc?.username ?? ''); setPanDir(acc?.root_dir ?? ''); }}
                          >
                            <KeyRound className="h-3 w-3" />
                            Cookie
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        size="sm" variant="outline"
                        className="h-7 flex-1 gap-1 border-primary/30 px-2 text-[11px] text-primary hover:bg-primary/10 hover:text-primary"
                        onClick={() => { setPanDialog(pan); setPanCookie(''); setPanUser(acc?.username ?? ''); setPanDir(acc?.root_dir ?? ''); }}
                      >
                        <KeyRound className="h-3 w-3" />
                        {pan === 'p123'
                          ? (acc ? '更新令牌' : '绑定令牌')
                          : (acc ? '更新 Cookie' : '绑定 Cookie')}
                      </Button>
                    )}
                    {acc && !locked && (
                      <Button
                        size="sm" variant="outline"
                        className="h-7 gap-1 border-border px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => { setProbeTarget(pan); setProbeUrl(''); setProbeResult(null); }}
                      >
                        <ShieldCheck className="h-3 w-3" />
                        {pan === 'quark' ? '试转存' : '校验'}
                      </Button>
                    )}
                    {acc && (
                      <Button
                        size="sm" variant="ghost"
                        className="h-7 gap-1 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setPanRemove(pan)}
                      >
                        <Unlink className="h-3 w-3" />
                        解绑
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 订阅源 */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between gap-2 p-4 md:px-6 md:py-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Rss className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">订阅源</h3>
              <span className="text-[11px] text-muted-foreground">
                {subFiltering
                  ? `匹配 ${shownSubs.length} / 共 ${subs.length} 个`
                  : panTab === 'all' ? `共 ${subs.length} 个` : `${PAN_LABELS[panTab]} ${shownSubs.length} 个`} · 定时任务每分钟检查一次，到点探测链接，发现新增文件即转存
              </span>
              {maxSubs !== null && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${atSubLimit ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
                  title={`当前 ${subs.length} 个，最多 ${maxSubs} 个`}
                >
                  额度 {subs.length}/{maxSubs}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {/* 不直接传 load：它第一个参数是 silent，会把点击事件当成"静默刷新" */}
              <Button variant="ghost" size="sm" onClick={() => load()} disabled={loading}
                className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
              </Button>
              <Button
                size="sm"
                onClick={() => openSubDialog()}
                disabled={atSubLimit}
                title={atSubLimit ? `订阅数量已达上限（${maxSubs} 个），请先删除不用的订阅` : undefined}
                className="h-8 text-xs gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />新建订阅
              </Button>
            </div>
          </div>
          {/* 按网盘筛选 + 搜索：不同网盘的订阅区分开，订阅多了靠搜索快速定位 */}
          <div className="flex items-center gap-2 px-4 md:px-6 pb-3 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              {panTabs.map((t) => {
                const active = panTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setPanTab(t.key)}
                    className={`h-7 px-2.5 rounded-md text-xs transition-colors ${
                      active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    {t.label}
                    <span className={`ml-1 ${active ? 'text-primary/70' : 'text-muted-foreground/70'}`}>{t.count}</span>
                  </button>
                );
              })}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={subQuery}
                onChange={(e) => setSubQuery(e.target.value)}
                placeholder="搜索订阅名称 / 源地址 / 关键字"
                className="h-8 pl-8 pr-7 bg-input border-border text-xs"
              />
              {subQuery && (
                <button
                  type="button"
                  onClick={() => setSubQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="清空搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="w-full max-w-full overflow-x-auto border-t border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">订阅源</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">关键字</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">目标网盘</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">检查时间</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">上次执行</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">状态</TableHead>
                  <TableHead className="hidden whitespace-nowrap text-right md:table-cell">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-10 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
                  </TableCell></TableRow>
                ) : shownSubs.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-10 text-sm text-muted-foreground">
                    {subs.length === 0
                      ? '还没有订阅，点「新建订阅」添加一个 RSS 或网页更新地址'
                      : subFiltering
                        ? (
                          <span className="inline-flex items-center gap-2">
                            没有匹配的订阅
                            <button
                              type="button"
                              onClick={() => { setSubQuery(''); setPanTab('all'); }}
                              className="text-primary hover:underline"
                            >
                              清空搜索条件
                            </button>
                          </span>
                        )
                        : `${panTab === 'all' ? '当前' : PAN_LABELS[panTab]}筛选下还没有订阅`}
                  </TableCell></TableRow>
                ) : shownSubs.map((sub) => {
                  // 状态徽标 / 操作按钮各只写一份：桌面端各占一列，手机端折进首列
                  const statusBadge = (
                    <Badge
                      variant="secondary"
                      className={`text-[10px] border-0 ${
                        sub.finished_at
                          ? 'bg-primary/15 text-primary'
                          : !sub.enabled
                            ? sub.paused_reason === 'credential'
                              ? 'bg-destructive/15 text-destructive'
                              : 'bg-muted text-muted-foreground'
                            : isRunning(sub) ? 'bg-secondary/20 text-secondary'
                              : sub.last_status === 'failed' ? 'bg-destructive/15 text-destructive'
                                : sub.last_status === 'partial' ? 'bg-accent/15 text-accent'
                                  : sub.last_status === 'retry' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                    : sub.last_status === 'ok' ? 'bg-primary/15 text-primary'
                                      : 'bg-muted text-muted-foreground'
                      }`}
                      title={
                        sub.finished_at
                          ? `已达全集数，资源已移入「已完结」；本订阅 1 小时后自动删除`
                          : !sub.enabled && sub.paused_reason === 'credential'
                            ? '凭证连续 3 次检测失败，已自动停止检测；重新绑定凭证后点「执行」即可恢复'
                            : sub.last_status === 'retry'
                              ? '上游网盘接口临时拥塞/超时（不是链接失效），已安排 2 分钟后自动重试'
                              : undefined
                      }
                    >
                      {sub.finished_at
                        ? '已完结'
                        : !sub.enabled
                        ? sub.paused_reason === 'credential'
                          ? '凭证失效'
                          : '已暂停'
                        : isRunning(sub)
                          ? <><Loader2 className="h-3 w-3 animate-spin mr-1 inline" />运行中</>
                          : sub.last_status === 'ok' ? '正常'
                            : sub.last_status === 'partial' ? '部分成功'
                              : sub.last_status === 'retry' ? '重试中'
                                : sub.last_status === 'failed' ? '失败'
                                  : '待运行'}
                    </Badge>
                  );
                  const rowActions = (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" disabled={busy === sub.id || !subEnabled} onClick={() => handleRun(sub)}
                        className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                        {busy === sub.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}执行
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openSubDialog(sub)}
                        className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                        <Pencil className="h-3.5 w-3.5" />编辑
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleToggle(sub)}
                        className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                        {sub.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                        {sub.enabled ? '暂停' : '启用'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setSubRemove(sub)}
                        className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted gap-1">
                        <Trash2 className="h-3.5 w-3.5" />删除
                      </Button>
                    </div>
                  );
                  return (
                  <TableRow key={sub.id} className={sub.enabled ? '' : 'opacity-60'}>
                    <TableCell className="max-w-[22rem]">
                      <div className="font-medium text-foreground break-words md:truncate">{sub.name}</div>
                      <div className="text-[11px] text-muted-foreground break-all md:truncate" title={sub.source_url}>
                        <Link2 className="h-3 w-3 inline mr-1" />{sub.source_url}
                      </div>
                      {/* 手机端：其余列折到名称下方 + 操作按钮跟在末尾，避免表格横向溢出被切掉 */}
                      <div className="mt-1.5 space-y-1 md:hidden">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          {statusBadge}
                          <span>
                            {PAN_LABELS[sub.pan] ?? sub.pan}
                            {LOCKED_PANS[sub.pan as PanKey] ? `（${LOCKED_PANS[sub.pan as PanKey]}）` : ''}
                          </span>
                          <span>关键字 {sub.keyword || '全部'}</span>
                          <span>{intervalLabel(sub.interval_minutes)}</span>
                        </div>
                        {sub.auto_publish && <div className="text-[10px] text-accent">已绑定资源管理</div>}
                        {adaptiveNote(sub) && (
                          <div className="text-[10px] text-primary/80 break-words">
                            <Sparkles className="h-3 w-3 inline mr-0.5" />{adaptiveNote(sub)}
                          </div>
                        )}
                        {sub.schedule_policy === 'day15_night60' && (
                          <div className="text-[10px] text-primary/80">固定节奏：白天 15 分钟 / 深夜 1 小时（01:00-07:00 统一 2 小时）</div>
                        )}
                        {sub.schedule_policy !== 'day15_night60' && sub.adaptive_enabled === false && (
                          <div className="text-[10px] opacity-70">已关闭智能检测</div>
                        )}
                        {sub.total_episodes ? (
                          <div className="text-[10px] text-muted-foreground">
                            {sub.finished_at
                              ? `已完结（全 ${sub.total_episodes} 集）· 1 小时后自动删除`
                              : `全集 ${sub.total_episodes} 集 · 达到即自动完结`}
                          </div>
                        ) : null}
                        <div className="text-[11px] text-muted-foreground">上次执行 {fmt(sub.last_run_at)}</div>
                        {sub.last_message && <div className="text-[10px] text-muted-foreground break-words">{sub.last_message}</div>}
                        <div className="pt-0.5">{rowActions}</div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground max-w-[10rem] truncate md:table-cell">{sub.keyword || '全部'}</TableCell>
                    <TableCell className="hidden text-xs whitespace-nowrap md:table-cell">
                      {PAN_LABELS[sub.pan] ?? sub.pan}
                      {LOCKED_PANS[sub.pan as PanKey] && (
                        <div className="text-[10px] text-amber-500">{LOCKED_PANS[sub.pan as PanKey]}</div>
                      )}
                      {sub.auto_publish && <div className="text-[10px] text-accent">绑定资源管理</div>}
                    </TableCell>
                    <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground md:table-cell">
                      {intervalLabel(sub.interval_minutes)}
                      {adaptiveNote(sub) && (
                        <div
                          className="text-[10px] max-w-[14rem] truncate text-primary/80"
                          title={`${adaptiveNote(sub)}（北京时间）`}
                        >
                          <Sparkles className="h-3 w-3 inline mr-0.5" />
                          {adaptiveNote(sub)}
                        </div>
                      )}
                      {sub.schedule_policy === 'day15_night60' ? (
                        <div className="text-[10px] text-primary/80" title="由管理员设定的固定节奏（北京时间）">
                          固定节奏：白天 15 分钟 / 深夜 1 小时（01:00-07:00 统一 2 小时）
                        </div>
                      ) : sub.adaptive_enabled === false ? (
                        <div className="text-[10px] opacity-70">已关闭智能检测</div>
                      ) : null}
                      {sub.total_episodes ? (
                        <div className="text-[10px] text-muted-foreground">
                          {sub.finished_at
                            ? `已完结（全 ${sub.total_episodes} 集）· 1 小时后自动删除`
                            : `全集 ${sub.total_episodes} 集 · 达到即自动完结`}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground md:table-cell">
                      {fmt(sub.last_run_at)}
                      {sub.last_message && (
                        <div className="text-[10px] max-w-[16rem] truncate" title={sub.last_message}>{sub.last_message}</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap md:table-cell">
                      {statusBadge}
                    </TableCell>
                    <TableCell className="hidden text-right whitespace-nowrap md:table-cell">
                      {rowActions}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* 抓取记录 */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between gap-2 p-4 md:px-6 md:py-4 flex-wrap">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">抓取记录</h3>
              <span className="text-[11px] text-muted-foreground">最近 50 条；「已入库」的条目可在「资源管理」里看到</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleClearFailed}
              className="h-8 text-xs text-destructive hover:text-destructive hover:bg-muted gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />清理失败记录
            </Button>
          </div>
          <div className="w-full max-w-full overflow-x-auto border-t border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">标题</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">网盘</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">状态</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">链接 / 说明</TableHead>
                  <TableHead className="hidden whitespace-nowrap md:table-cell">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-10 text-sm text-muted-foreground">
                    暂无抓取记录，执行一次订阅后这里会列出抓到的链接与转存结果
                  </TableCell></TableRow>
                ) : items.map((it) => {
                  const meta = ITEM_STATUS_META[it.status];
                  return (
                    <TableRow key={it.id}>
                      <TableCell className="max-w-[20rem] text-sm text-foreground md:truncate" title={it.title}>
                        <div className="break-words">{it.title}</div>
                        {/* 手机端：网盘 / 状态 / 链接 / 时间折到标题下方，避免表格横向溢出被切掉 */}
                        <div className="mt-1.5 space-y-1 md:hidden">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span>{it.pan ? (PAN_LABELS[it.pan as PanKey] ?? it.pan) : '—'}</span>
                            <Badge variant="secondary" className={`text-[10px] border-0 ${meta.className}`}>{meta.label}</Badge>
                            <span>{fmt(it.created_at)}</span>
                          </div>
                          {(it.transfer_url || it.share_url) && (
                            <a href={(it.transfer_url || it.share_url) as string} target="_blank" rel="noreferrer"
                              className="block break-all text-[11px] text-primary hover:underline">
                              {it.transfer_url || it.share_url}
                            </a>
                          )}
                          {it.share_passcode && <div className="text-[11px] text-muted-foreground">提取码 {it.share_passcode}</div>}
                          {/* 失败才是错误（红）；已入库但带说明（如未绑定网盘）按提示展示（灰） */}
                          {it.error && (
                            <div className={`text-[10px] break-words ${it.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {it.error}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground md:table-cell">
                        {it.pan ? (PAN_LABELS[it.pan as PanKey] ?? it.pan) : '—'}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        <Badge variant="secondary" className={`text-[10px] border-0 ${meta.className}`}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="hidden text-xs max-w-[24rem] md:table-cell">
                        {(it.transfer_url || it.share_url) && (
                          <a href={(it.transfer_url || it.share_url) as string} target="_blank" rel="noreferrer"
                            className="text-primary hover:underline truncate inline-block max-w-[22rem] align-bottom">
                            {it.transfer_url || it.share_url}
                          </a>
                        )}
                        {it.share_passcode && <span className="ml-1 text-muted-foreground">提取码 {it.share_passcode}</span>}
                        {it.error && (
                          <div
                            className={`text-[10px] max-w-[22rem] truncate ${it.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                            title={it.error}
                          >
                            {it.error}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground md:table-cell">{fmt(it.created_at)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* 网盘绑定弹窗 */}
      <Dialog open={!!panDialog} onOpenChange={(o) => !o && setPanDialog(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle>绑定 {panDialog ? PAN_LABELS[panDialog] : ''} 账号</DialogTitle>
            <DialogDescription className="text-xs">
              {panDialog === 'p123'
                ? '123 云盘不用 Cookie，而是用登录令牌 authorToken：登录 yun.123pan.com 后，开发者工具 → 控制台（Console）执行 localStorage.getItem(\'authorToken\')，把结果粘贴到下面；保存时服务端会先校验令牌，通过后才加密存储，仅用于转存调用，前端无法读取。'
                : panDialog === 'baidu'
                  ? '百度网盘的 Cookie 必须含 BDUSS；保存时服务端会用它再换一个 bdstoken（转存必需），两者一起加密存储，仅用于转存调用，前端无法读取。'
                  : panDialog === 'quark'
                    ? '推荐直接用「扫码登录」，服务端会自动换出整串 Cookie 并加密保存；也可手动粘贴浏览器登录后的整串 Cookie（含 ctoken 等登录态字段），仅用于转存调用，前端无法读取。'
                    : panDialog === 'uc'
                      ? 'UC 网盘与夸克同属 clouddrive 架构，Cookie 必须含 __pus；保存时服务端会先调 /user/info 校验，通过后才加密存储，仅用于转存调用，前端无法读取。'
                      : 'Cookie 会在服务端加密后存储，仅用于转存调用，前端无法读取。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">{panDialog === 'p123' ? '登录令牌（authorToken）' : '登录 Cookie'}</Label>
              <Textarea
                value={panCookie} onChange={(e) => setPanCookie(e.target.value)}
                placeholder={panDialog === 'p123'
                  ? "登录 yun.123pan.com 后：开发者工具 → Console 执行 localStorage.getItem('authorToken')，把输出整段粘贴（不要带引号）"
                  : panDialog === 'baidu'
                    ? '登录 pan.baidu.com 后：开发者工具 → 网络 → 任意请求 → Request Headers → Cookie，整串粘贴（务必包含 BDUSS=...）'
                    : panDialog === 'uc'
                      ? '登录 drive.uc.cn 后：开发者工具 → 网络 → 任意请求 → Request Headers → Cookie，整串粘贴（务必包含 __pus=...）'
                      : '浏览器登录网盘后，开发者工具 → 网络 → 任意请求 → Request Headers → Cookie，整串粘贴'}
                className="min-h-24 resize-y text-xs font-mono"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">账号名（可选）</Label>
                <Input value={panUser} onChange={(e) => setPanUser(e.target.value)} className="h-9 bg-input border-border" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">转存目录（可选）</Label>
                <Input value={panDir} onChange={(e) => setPanDir(e.target.value)} placeholder="留空=根目录"
                  className="h-9 bg-input border-border" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanDialog(null)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleBindPan} disabled={panSaving} className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {panSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 扫码授权：光鸭 / 迅雷走设备码流程，夸克走 uop 二维码，百度走 passport 二维码（后两者扫码后服务端直接换 Cookie 落库） */}
      <Dialog open={scanOpen} onOpenChange={(o) => { setScanOpen(o); if (!o) setScanSession(null); }}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>
              {scanPan === 'baidu'
                ? '扫码登录百度网盘'
                : scanPan === 'quark'
                  ? '扫码登录夸克网盘'
                  : scanPan === 'xunlei'
                    ? '扫码登录迅雷云盘'
                    : scanPan === 'uc'
                      ? '扫码登录 UC 网盘'
                      : scanPan === 'p123'
                        ? '扫码登录 123 云盘'
                        : '扫码授权光鸭云盘'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {scanPan === 'baidu' ? (
                <>
                  用手机<b>「百度 App」或「百度网盘 App」</b>扫码，扫码后在手机上点「确认登录」。
                  登录成功后服务端会自动换出完整 Cookie 并加密保存，你不需要手动复制。
                </>
              ) : scanPan === 'quark' ? (
                <>
                  用手机<b>「夸克 App」</b>扫码，扫码后在手机上点「确认登录」。
                  登录成功后服务端会自动换出完整 Cookie 并加密保存，你不需要手动复制。
                </>
              ) : scanPan === 'xunlei' ? (
                <>
                  用手机<b>「迅雷」App</b>扫码，扫码后在手机上点「确认登录」。
                  登录成功后服务端会自动换取令牌并加密保存（过期自动续期），你不需要手动复制。
                </>
              ) : scanPan === 'uc' ? (
                <>
                  用手机<b>「UC 网盘 App」或「UC 浏览器」</b>扫码，扫码后在手机上点「确认登录」。
                  登录成功后服务端会自动换出完整 Cookie（含 <span className="font-mono">__puus</span>）并加密保存，你不需要手动复制。
                </>
              ) : scanPan === 'p123' ? (
                <>
                  用手机<b>「123云盘」App</b>扫一扫，扫码后在 App 里点「确认登录」。
                  登录成功后服务端会自动取回登录令牌（<span className="font-mono">authorToken</span>）并加密保存，你不需要手动复制；
                  App 扫不了时改用「令牌」按钮粘贴也完全可以。
                </>
              ) : (
                <>
                  请用<b>光鸭云盘 App</b> 扫码，并在手机上点击「同意登录」（用微信/相机扫会打开下载页，
                  请忽略）。授权成功后，凭证会自动填入「填入光鸭令牌」表单，确认保存即可。
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {scanStarting && (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />正在申请授权码…
              </div>
            )}
            {scanSession && (
              <>
                <div className="flex justify-center rounded-lg border border-border bg-white p-3">
                  {scanSession.qrImageUrl ? (
                    // 百度直接给现成二维码图片（内容为百度 App 专用协议，不能自己编码）
                    <img src={scanSession.qrImageUrl} alt="百度登录二维码" className="h-[180px] w-[180px]" />
                  ) : (
                    <QRCodeDataUrl text={scanSession.verifyUrl} width={180} />
                  )}
                </div>
                {!scanSession.qrImageUrl && scanPan !== 'quark' && scanPan !== 'xunlei' && scanPan !== 'uc' && (
                  <div className="rounded-lg border border-border px-3 py-2 text-[11px]">
                    <div className="text-muted-foreground">
                      {scanPan === 'p123'
                        ? '若 App 扫码异常，可复制下面链接在 123云盘 App 内打开完成登录'
                        : '授权页地址（电脑浏览器打开可登录确认；手机浏览器打开只会显示下载页）'}
                    </div>
                    <a href={scanSession.verifyUrl} target="_blank" rel="noreferrer"
                      className="mt-0.5 block break-all text-primary hover:underline">
                      {scanSession.verifyUrl}
                    </a>
                    {scanSession.userCode && (
                      <div className="mt-1 text-muted-foreground">
                        若要求输入验证码：
                        <span className="ml-1 font-mono text-foreground">{scanSession.userCode}</span>
                      </div>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {scanTip}
                  {scanRemain > 0 && <span>（{scanRemain}s 后失效）</span>}
                </div>
              </>
            )}
            {!scanSession && !scanStarting && scanTip && (
              <div className="text-xs text-muted-foreground">{scanTip}</div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setScanOpen(false); setScanSession(null); }}
                className="border-border text-muted-foreground">关闭</Button>
              <Button onClick={() => handleStartScan(scanPan)} disabled={scanStarting} className="gap-1.5">
                {scanStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {scanPan === 'guangya' ? '重新获取授权码' : '刷新二维码'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 光鸭令牌绑定弹窗 */}
      <Dialog open={tokenDialog} onOpenChange={setTokenDialog}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle>填入光鸭令牌</DialogTitle>
            <DialogDescription className="text-xs">
              在浏览器登录光鸭云盘后，打开开发者工具 → Application → Local Storage，找到
              <span className="font-mono"> credentials_&lt;client_id&gt;</span>，把里面的
              <span className="font-mono"> refresh_token</span> 复制过来即可
              （保存时会自动换取新的 access_token）；也可以两段都填。
              令牌在服务端加密存储，仅用于转存调用，前端无法读取。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">Refresh Token（推荐，至少填这项）</Label>
              <Textarea
                value={gyRefreshToken}
                onChange={(e) => setGyRefreshToken(e.target.value)}
                placeholder="粘贴 refresh_token；也可以直接把整段 credentials JSON 粘到下面 Access Token 框，会自动拆分"
                className="min-h-16 resize-y text-xs font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">Access Token（可选）</Label>
              <Textarea
                value={gyAccessToken}
                onChange={(e) => handleGyTokenInput(e.target.value)}
                placeholder="可留空——保存时会用 Refresh Token 自动换取；也可直接粘贴整段 credentials JSON 自动拆分"
                className="min-h-20 resize-y text-xs font-mono"
              />
            </div>
            <div className="rounded-lg border border-border px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
              Client ID 固定使用光鸭官方 SDK 的值（账号网关按它路由，用了别的值续期会失败），无需填写。
              也可以用外面的「扫码授权」：成功后凭证会自动填入本表单，确认保存即可。
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenDialog(false)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleBindPanTokens} disabled={tokenSaving}
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {tokenSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 迅雷令牌绑定弹窗 */}
      <Dialog open={xlTokenDialog} onOpenChange={setXlTokenDialog}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle>填入迅雷令牌</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              <span className="text-foreground">扫码后会自动填好令牌与 Client ID，只剩「设备 ID」要补。</span>
              {' '}迅雷业务接口要求四件套：<span className="font-mono">Authorization</span> +
              <span className="font-mono"> x-device-id</span> + <span className="font-mono">x-client-id</span> +
              <span className="font-mono"> x-captcha-token</span>，缺风控令牌就报「验证码无效」；其中风控令牌必须是浏览器会话里那枚（服务端自己申请的票会被判"无设备档案"）。
              设备 ID：电脑浏览器登录 <span className="font-mono">pan.xunlei.com</span> → F12 →
              Application → Local Storage，复制 <span className="font-mono">deviceid</span>（形如
              <span className="font-mono"> wdi10.9cc34a…</span>，整串粘进来即可，会自动截前 32 位；
              也可用 Network 里任意 drive 请求的 <span className="font-mono">x-device-id</span>）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-2.5">
              <Label className="text-sm text-foreground">整段粘贴（自动拆分到下面各栏）</Label>
              <Textarea
                value={xlBulkText}
                onChange={(e) => setXlBulkText(e.target.value)}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  if (text && Object.keys(parseXlCredBlob(text)).length) {
                    e.preventDefault();
                    setXlBulkText(text);
                    applyXlCredBlob(text);
                  }
                }}
                placeholder={'Access Token: eyJ…\n设备 ID: 596d376b…\nRefresh Token: a1.…\nClient ID: Xqp0kJBXWhwaTpB6\nClient Version: 1.93.10\nx-captcha-token: ck0.…'}
                className="min-h-24 resize-y text-xs font-mono"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] leading-snug text-muted-foreground">
                  直接把抓包那段粘进来即可；键名不分中英文冒号，裸值（eyJ… / ck0. / a1. / 32 位 hex）也能认出来。
                </span>
                <Button
                  size="sm" variant="outline"
                  className="h-7 shrink-0 gap-1 border-primary/30 px-2 text-[11px] text-primary hover:bg-primary/10 hover:text-primary"
                  onClick={() => applyXlCredBlob(xlBulkText)}
                >
                  <Sparkles className="h-3 w-3" />
                  解析并填入
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">Access Token</Label>
              <Textarea
                value={xlAccessToken}
                onChange={(e) => setXlAccessToken(e.target.value)}
                placeholder="粘贴 authorization 里 Bearer 后面那串"
                className="min-h-20 resize-y text-xs font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">设备 ID（localStorage 的 deviceid / x-device-id）</Label>
              <Input
                value={xlDeviceId}
                onChange={(e) => setXlDeviceId(e.target.value)}
                placeholder="wdi10.9cc34a9895713a00ef335853a489b4f5… 或直接 32 位 hex"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">风控令牌 x-captcha-token（可选，建议填）</Label>
              <Textarea
                value={xlCaptchaToken}
                onChange={(e) => setXlCaptchaToken(e.target.value)}
                placeholder="localStorage 里 captcha_Xqp0kJBXWhwaTpB6 的 token，形如 ck0.xxxx"
                className="min-h-14 resize-y text-xs font-mono"
              />
              <p className="text-[10px] leading-snug text-muted-foreground">
                这一枚会被存成「种子」：服务端用它向迅雷申领新票，新票再当下一轮种子，形成链条自动续期，所以只需填一次。
                种子长时间失效（例如几天没有调用）时，重新粘一次即可。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">Refresh Token（可选，用于自动续期）</Label>
              <Textarea
                value={xlRefreshToken}
                onChange={(e) => setXlRefreshToken(e.target.value)}
                placeholder="浏览器端一般拿不到 refresh_token，可留空；过期后重新填一次即可"
                className="min-h-14 resize-y text-xs font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">Client ID（可选）</Label>
                <Input
                  value={xlClientId}
                  onChange={(e) => setXlClientId(e.target.value)}
                  placeholder="留空用默认值"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">Client Version（可选）</Label>
                <Input
                  value={xlClientVersion}
                  onChange={(e) => setXlClientVersion(e.target.value)}
                  placeholder="留空则不发送"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="rounded-lg border border-border px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
              保存时会先用这套身份真打一次文件列表：通过了才说明设备档案对得上，页面会提示校验结果。
              令牌在服务端加密存储，前端无法读取。
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setXlTokenDialog(false)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleBindXunleiToken} disabled={xlTokenSaving}
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {xlTokenSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}保存并校验
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 网盘自检弹窗 */}
      <Dialog open={!!probeTarget} onOpenChange={(o) => { if (!o) { setProbeTarget(null); setProbeResult(null); } }}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border">
          <DialogHeader>
            <DialogTitle>
              {probeTarget === 'guangya'
                ? '校验光鸭授权'
                : probeTarget === 'baidu'
                  ? '校验百度登录态'
                  : probeTarget === 'xunlei'
                    ? '校验迅雷云盘'
                    : '试转存（夸克）'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {probeTarget === 'guangya'
                ? '读取你的光鸭网盘根目录（只读，不写入任何数据），验证令牌与目录接口是否都可用。'
                : probeTarget === 'baidu'
                  ? '校验登录态、读取账号信息与网盘根目录（只读，不写入任何数据），验证 Cookie 与 bdstoken 是否都可用。'
                  : probeTarget === 'xunlei'
                    ? '校验登录态（/about 配额）并读取根目录（只读，不写入任何数据），验证令牌、风控票与目录接口是否都可用。'
                    : '用一条分享链接校验 Cookie 与分享读取能力（只读，不会转存、不会往你网盘里写文件）。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {probeTarget === 'quark' && (
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">该网盘的一个分享链接</Label>
                <Input value={probeUrl} onChange={(e) => setProbeUrl(e.target.value)}
                  placeholder="https://pan.quark.cn/s/xxxx" className="h-9 bg-input border-border" />
              </div>
            )}
            {probeResult && (
              <div className="relative">
                <pre className="rounded-lg border border-border bg-muted/40 p-3 pr-10 font-mono text-[11px] max-h-64 overflow-auto whitespace-pre-wrap">
                  {probeResult}
                </pre>
                <Button variant="ghost" size="sm"
                  className="absolute top-1.5 right-1.5 h-6 w-6 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(probeResult); setCopied(true); setTimeout(() => setCopied(false), 2000); }
                    catch { toast.error('复制失败'); }
                  }}>
                  {copied ? <CheckCheck className="h-3 w-3 text-secondary" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleProbe} disabled={probing}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
              {probing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              {probeTarget === 'quark' ? '试转存' : '开始校验'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 订阅编辑弹窗 */}
      <Dialog open={subDialog.open} onOpenChange={(o) => setSubDialog({ open: o })}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{subDialog.editing ? '编辑订阅' : '新建订阅'}</DialogTitle>
            <DialogDescription className="text-xs">
              定时抓取该地址，提取其中的光鸭 / 夸克分享链接并转存入库；地址本身若是分享链接，则监控该分享里新增的文件
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="如：某某更新页" className="h-9 bg-input border-border" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">源类型</Label>
                <Select value={form.sourceType} onValueChange={(v) => setForm({ ...form, sourceType: v as 'auto' | 'rss' | 'page' | 'pan_share' })}>
                  <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自动识别（推荐）</SelectItem>
                    <SelectItem value="rss">RSS / Atom</SelectItem>
                    <SelectItem value="page">网页更新页</SelectItem>
                    <SelectItem value="pan_share">网盘分享链接（监控新增文件）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm text-foreground">
                  {subOnly ? '订阅源（管理员「更新中」的资源）' : '订阅源'}
                </Label>
                {/* 普通账号：自定义地址 / 内置订阅源 二选一；受限账号只有内置来源，不显示切换 */}
                {!subOnly && (
                  <div className="flex items-center rounded-md border border-border p-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setSrcMode('custom')}
                      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                        srcMode === 'custom' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      自定义订阅
                    </button>
                    <button
                      type="button"
                      onClick={() => setSrcMode('builtin')}
                      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                        srcMode === 'builtin' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      内置订阅源
                    </button>
                  </div>
                )}
              </div>
              {subOnly || srcMode === 'builtin' ? (
                <>
                  {(() => {
                    const pickedRes = resSources.find((s) => s.url === form.sourceUrl);
                    const pickedSrc = sources.find((s) => s.source_url === form.sourceUrl);
                    const pickedPan = detectSharePan(form.sourceUrl);
                    return (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => { setSrcQuery(''); setSrcPicker(true); void loadResourceSources(); void loadOwners(); }}
                        className="w-full h-auto min-h-9 py-2 justify-between gap-2 border-border bg-input text-left font-normal hover:bg-muted"
                      >
                        <span className="min-w-0 flex-1">
                          {form.sourceUrl ? (
                            <>
                              <span className="block truncate text-sm text-foreground">
                                {pickedRes?.name ?? pickedSrc?.name ?? form.sourceUrl}
                                {pickedPan ? <span className="text-muted-foreground">（{PAN_LABELS[pickedPan]}）</span> : null}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">{form.sourceUrl}</span>
                            </>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              点击选择订阅源（管理员订阅源 {sources.length} 个 · 更新中的资源{resSourceTotal > 0 ? ` ${resSourceTotal} 个` : ''}）
                            </span>
                          )}
                        </span>
                        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </Button>
                    );
                  })()}
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {subOnly
                      ? <>你的账号只能订阅管理员资源库里的链接，不能自己填写任意地址；订阅数量上限 {limitText}。同一个资源如果同时有光鸭 / 夸克两条链接，选你绑定过的网盘那条即可（跨盘不能转存）。</>
                      : <>内置订阅源来自管理员维护的<b className="text-foreground">订阅源</b>与「资源管理」里<b className="text-foreground">更新中</b>的资源链接：选中后会带上名称 / 网盘等默认值（仍可继续修改）。选资源库链接会开启联动并按剧名匹配到<b className="text-foreground">你自己的同名资源</b>，集数与完结状态跟着更新。想自己填地址就切回「自定义订阅」。</>}
                  </p>
                </>
              ) : (
                <div className="flex gap-2">
                  <Input value={form.sourceUrl} onChange={(e) => onSourceUrlChange(e.target.value)}
                    placeholder="更新页 / RSS 地址，或分享链接（https://www.guangyapan.com/s/xxx）" className="h-9 bg-input border-border" />
                  <Button variant="outline" onClick={handlePreview} disabled={previewing || !subEnabled}
                    className="h-9 shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                    {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}解析测试
                  </Button>
                </div>
              )}
              {detectSharePan(form.sourceUrl) && (
                <div className="text-[11px] text-primary leading-relaxed">
                  检测到{PAN_LABELS[detectSharePan(form.sourceUrl) as PanKey]}分享链接：将按「分享目录监控」运行——
                  分享里新增文件就自动转存并入库，定时执行即可持续追更（目标网盘需为
                  {PAN_LABELS[detectSharePan(form.sourceUrl) as PanKey]}，已自动对齐）
                </div>
              )}
              {preview && (
                <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-[11px] space-y-1">
                  <div className="text-muted-foreground">
                    识别为{preview.mode === 'pan_share' ? ' 分享目录监控' : preview.isFeed ? ' RSS/Atom' : ' 网页'}
                    {preview.meta?.pageTitle ? `（${preview.meta.pageTitle}）` : ''}
                    {preview.mode === 'pan_share' ? '，' : '，解析 '}
                    {preview.mode === 'pan_share'
                      ? `${preview.total} 个条目、共 ${preview.meta?.detailLinks ?? 0} 个文件，关键字命中 ${preview.filtered} 条`
                      : `${preview.total} 条，关键字命中 ${preview.filtered} 条`}
                  </div>
                  {preview.items.slice(0, 3).map((p, i) => (
                    <div key={i} className="text-foreground">
                      <div className="truncate">
                        {i + 1}. {p.title || '（无标题）'}
                        {p.fileCount !== undefined ? (
                          <span className="text-muted-foreground">
                            {' '}· {p.fileCount} 个文件
                            {p.fileNames?.length ? `（${p.fileNames.join('、')}${p.fileCount > p.fileNames.length ? '…' : ''}）` : ''}
                          </span>
                        ) : (
                          <span className="text-muted-foreground"> · {p.pan ?? '未知网盘'}</span>
                        )}
                      </div>
                      {p.cleanedNames?.length ? (
                        <div className="truncate text-[11px] text-muted-foreground">
                          清洗后：{p.cleanedNames.join('、')}
                          {(p.fileCount ?? 0) > p.cleanedNames.length ? '…' : ''}
                          {p.cleanedNames.some((n) => n.includes('高码')) ? '（清洗后重名的，体积大的已加「高码」）' : ''}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {preview.meta && preview.total === 0 && preview.mode !== 'pan_share' && (
                    <div className="text-muted-foreground">
                      诊断：页面链接 {preview.meta.anchorCount} 个 · 清单页直链 {preview.meta.directLinks} 条
                      {preview.meta.detailCandidates > 0
                        && ` · 跟进详情页 ${preview.meta.detailFollowed}/${preview.meta.detailCandidates} 个`
                        + (preview.meta.detailLinks > 0 ? `（命中 ${preview.meta.detailLinks} 条）` : '')}
                      {preview.meta.scriptLinks > 0 && ` · JS 数据里的链接 ${preview.meta.scriptLinks} 个`}
                    </div>
                  )}
                  {preview.hint && <div className="text-destructive">{preview.hint}</div>}
                  {preview.probe?.length ? (
                    <div className="text-muted-foreground break-all">接口字段：{preview.probe.join('、')}</div>
                  ) : null}
                </div>
              )}
            </div>
            {(form.sourceType === 'pan_share' || detectSharePan(form.sourceUrl)) && (
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">分享提取码（可选）</Label>
                <Input value={form.sourcePasscode} onChange={(e) => setForm({ ...form, sourcePasscode: e.target.value })}
                  placeholder="夸克 / 百度 / 迅雷分享若要提取码请填写；光鸭分享留空" className="h-9 bg-input border-border" />
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">文件名清洗（转存后重命名）</Label>
                {subOnly ? (
                  <>
                    {/* 受限账号（特殊邀请码注册）：固定「不处理」，不提供「精简为集数」 */}
                    <div className="flex h-9 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-muted-foreground">
                      不处理，保留原文件名
                    </div>
                    <div className="text-[11px] text-muted-foreground leading-relaxed">
                      「订阅专用」账号固定为不处理：保留分享里的原始文件名，不改名
                    </div>
                  </>
                ) : (
                  <>
                    <Select
                      value={form.cleanMode}
                      onValueChange={(v) => setForm({ ...form, cleanMode: v as 'none' | 'episode' })}
                    >
                      <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="episode">精简为集数（推荐）</SelectItem>
                        <SelectItem value="none">不处理，保留原文件名</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="text-[11px] text-muted-foreground leading-relaxed">
                      例：A.Prophet. 2026.S01E01.2160p.WEB-DL.H.265.HDR Vivid.DDP 5.1.mp4 → S01E01.mp4
                    </div>
                  </>
                )}
              </div>
              {/* 文件夹模式（光鸭 / 夸克 / 百度 / UC / 123云盘）：整个文件夹原样转存 + 转后清理图片/文档 + 只清洗不加高码 */}
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">文件夹模式（整个文件夹转存）</Label>
                <div className="flex items-start gap-3">
                  <Switch
                    checked={form.folderMode}
                    disabled={!FOLDER_MODE_PANS.includes(form.pan)}
                    onCheckedChange={(v) => setForm({ ...form, folderMode: v })}
                  />
                  <span className="text-[11px] text-muted-foreground leading-relaxed">
                    {FOLDER_MODE_PANS.includes(form.pan)
                      ? '开启后：把分享里的整个文件夹原样转存（保留子目录），并删掉顺带转进来的图片/文档/文本（夸克 / 百度为删除到回收站、可恢复）；文件名只做清洗、不再加「高码」后缀'
                      : '当前网盘暂不支持文件夹模式'}
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">目标网盘</Label>
                <Select
                  value={form.pan}
                  onValueChange={(v) => {
                    const next = v as PanKey;
                    // 换网盘时清掉已选目录：目录 ID 属于具体网盘（百度用的是绝对路径），
                    // 沿用旧盘的 ID 会转存到错误位置甚至直接失败
                    setForm({ ...form, pan: next, ...(next === form.pan ? {} : { targetDir: '', targetDirName: '' }) });
                  }}
                >
                  <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAN_KEYS.map((p) => (
                      <SelectItem key={p} value={p} disabled={!!LOCKED_PANS[p]}>
                        {PAN_LABELS[p]}{LOCKED_PANS[p] ? `（${LOCKED_PANS[p]}）` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(() => {
                  const sp = detectSharePan(form.sourceUrl);
                  if (!sp || sp === form.pan) return null;
                  return (
                    <p className="text-[11px] leading-snug text-amber-500">
                      订阅源是{PAN_LABELS[sp]}分享链接：目标网盘必须选{PAN_LABELS[sp]}，跨盘无法转存
                      <button
                        type="button"
                        className="ml-1 underline underline-offset-2 hover:text-amber-400"
                        onClick={() => setForm({ ...form, pan: sp, targetDir: '', targetDirName: '' })}
                      >
                        一键切换
                      </button>
                    </p>
                  );
                })()}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">转存目录</Label>
                <div className="flex gap-2">
                  <Input value={form.targetDirName} readOnly
                    placeholder="网盘账号的默认目录" className="h-9 bg-input border-border text-xs" />
                  <Button type="button" variant="outline" onClick={openDirPicker} disabled={dirLoading}
                    className="h-9 shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                    {dirLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}浏览选择
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  {form.pan === 'baidu'
                    ? '百度网盘按「目录路径」记录：之后在网盘里重命名或移动该文件夹，需要重新来这里选一次，否则会转存失败'
                    : '按目录 ID 记录：之后你在网盘里重命名这个文件夹，转存依然会进到同一个目录'}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">
                  检查时间{form.adaptiveEnabled ? '（基准间隔）' : ''}
                </Label>
                <Select value={String(form.intervalMinutes)} onValueChange={(v) => setForm({ ...form, intervalMinutes: Number(v) })}>
                  <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INTERVAL_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  {form.adaptiveEnabled ? (
                    <>
                      这是<b className="text-foreground">基准间隔</b>：智能检测会在该剧常更新的时段（±1 小时）
                      加密到 {Math.min(form.intervalMinutes, 5)} 分钟，其余时段放宽（白天 1~2 小时）；
                      每天凌晨 01:00-07:00（北京时间）统一 2 小时一次。
                      关掉下面的「智能检测」就严格按这个间隔跑。
                    </>
                  ) : (
                    <>
                      严格按这个间隔检查：定时任务每分钟触发一轮，按「最久没检查的优先」轮转，
                      订阅多的时候实际检查会比这个间隔慢一些（否则大家会互相抢资源、谁都查不及时）。
                    </>
                  )}
                  发现新增文件会自动转存到上面的目标目录，图片（海报/截图/封面等）自动跳过
                </div>
              </div>
            </div>
            {/* 全集数（选填）：达到即判定完结（仅限能用资源管理的账号） */}
            {!subOnly && (
              <div className="space-y-1.5 rounded-lg border border-border px-3 py-2">
                <Label htmlFor="totalEpisodes" className="text-sm text-foreground">全集数（选填）</Label>
                <Input
                  id="totalEpisodes"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="例如 30；留空表示不自动完结"
                  value={form.totalEpisodes}
                  onChange={(e) => setForm({ ...form, totalEpisodes: e.target.value.replace(/[^\d]/g, '') })}
                  className="h-9 bg-input border-border"
                />
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  填了就会<b className="text-foreground">自动完结</b>：订阅同步到的集数达到该值时，资源名自动改为
                  <b className="text-foreground">「… 已完结全{form.totalEpisodes || 'N'}集」</b>、自动移入「已完结」，
                  对外 API 推送也显示为<b className="text-foreground">已完结</b>；本订阅会被取消并在
                  <b className="text-foreground"> 1 小时后自动删除</b>。
                  例：名称「雷霆令 2026 更新第18集 2160P SDR」+ 全集 30 → 「雷霆令 2026 已完结全30集 2160P SDR」。
                  留空 / 填 0 = 不自动完结。
                </div>
              </div>
            )}
            {/* 智能检测（自适应调度） */}
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div className="min-w-0 pr-3">
                <div className="text-sm text-foreground">智能检测（自适应调度）</div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  按这部剧的更新规律安排检查：常更新的时段加密到 5 分钟盯一次，其余时段放宽；
                  每天凌晨 01:00-07:00（北京时间）统一 2 小时检查一次；
                  连续 7 天没更新自动降为每天一次；距上次更新超过 36 小时会临时收紧，避免漏更。
                  刚添加的订阅先按基准间隔跑几天，攒够更新记录后自动启用时段预测。
                </div>
              </div>
              <Switch checked={form.adaptiveEnabled} onCheckedChange={(v) => setForm({ ...form, adaptiveEnabled: v })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div>
                <div className="text-sm text-foreground">启用订阅</div>
                <div className="text-[11px] text-muted-foreground">关闭后定时任务会跳过该订阅</div>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
            {!subOnly && (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div>
                  <div className="text-sm text-foreground">绑定「资源管理」中的资源</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    开启后：转存到的<b>新文件</b>会并入资源管理里的资源，集数按新文件更新（例：老 12 集、新增
                    S01E13/S01E14 → 14 集），并把变更排队同步到各站点。可在下面指定具体资源，不指定就按剧名自动匹配
                  </div>
                </div>
                <Switch checked={form.autoPublish} onCheckedChange={(v) => setForm({ ...form, autoPublish: v })} />
              </div>
            )}
            {!subOnly && form.autoPublish && (
              <div className="space-y-1.5 rounded-lg border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm text-foreground">绑定的资源</div>
                  <div className="flex items-center gap-1">
                    {form.resourceId && (
                      <Button type="button" variant="ghost" size="sm"
                        onClick={() => { setForm({ ...form, resourceId: '' }); setBoundRes(null); }}
                        className="h-7 text-xs text-muted-foreground hover:text-foreground">
                        取消绑定
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" onClick={openResPicker}
                      className="h-7 gap-1.5 border-border text-xs">
                      <Layers className="h-3 w-3" />{form.resourceId ? '更换资源' : '选择资源'}
                    </Button>
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  {form.resourceId
                    ? `已绑定「${boundRes?.name ?? '读取中…'}」${boundRes ? `（当前 ${boundRes.episode_count ?? 0} 集）` : ''}：转存新文件后自动更新集数并排队同步到站点`
                    : '未指定：按剧名自动匹配资源管理里已有的资源'}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubDialog({ open: false })}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleSaveSub} disabled={subSaving || !subEnabled} className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {subSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}保存订阅
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 选择订阅源弹窗：管理员订阅源 + 管理员「更新中」的资源（普通账号选「内置订阅源」时也能用） */}
      <Dialog open={srcPicker} onOpenChange={setSrcPicker}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {ownerPicked && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={backToOwners}
                  className="h-7 w-7 shrink-0 p-0"
                  title="返回源主列表"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              )}
              {ownerPicked ? `${ownerPicked.display_name} 的更新资源` : '选择订阅源'}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
              来自管理员与源主「资源管理」中<b>更新中</b>的资源；同一个资源有光鸭 / 夸克两条链接时，
              用哪个网盘点哪个（只能选你已绑定的网盘）。订阅后分享里新增的集数会自动转存到你的网盘。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* 源主列表：多位源主时先选源主，再选他的资源 */}
            {!ownerPicked && owners.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Crown className="h-3 w-3 text-primary" />
                  源主（{owners.length}）
                </div>
                {owners.map((o) => (
                  <button
                    key={o.owner_id}
                    type="button"
                    onClick={() => void enterOwner(o)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted transition-colors"
                  >
                    {o.avatar_url ? (
                      <img src={o.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                        {(o.display_name || '源').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{o.display_name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        更新中 {o.resource_count} 个资源
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                value={srcQuery}
                onChange={(e) => setSrcQuery(e.target.value)}
                placeholder="搜索资源名，如「斗罗大陆」"
                className="h-9 bg-input border-border"
              />
              {(resSrcLoading || ownerResLoading || ownersLoading) && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
              )}
            </div>
            <div className="max-h-[55vh] overflow-y-auto space-y-2 pr-1">
              {/* 管理员另配的订阅源（如果有） */}
              {sources.length > 0 && !srcQuery.trim() && !ownerPicked && (
                <div className="space-y-1 rounded-lg border border-border px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">管理员订阅源</div>
                  {sources.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { applySource(s.id); setSrcPicker(false); }}
                      className="w-full text-left text-sm text-foreground rounded-md px-2 py-1.5 hover:bg-muted transition-colors"
                    >
                      {s.name}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">（{PAN_LABELS[s.pan]}）</span>
                    </button>
                  ))}
                </div>
              )}
              {/* 资源列表：管理员资源 与 选中的源主资源 复用同一套渲染 */}
              {(() => {
                const groups = ownerPicked ? ownerGroups : resSourceGroups;
                const loading = ownerPicked ? ownerResLoading : resSrcLoading;
                const emptyText = ownerPicked
                  ? (srcQuery.trim() ? '没有匹配的资源' : '该源主目前没有「更新中」的资源')
                  : (resSrcLoading ? '正在读取管理员资源…' : srcQuery.trim() ? '没有匹配的资源' : '管理员目前没有「更新中」的资源');
                if (groups.length === 0) {
                  return (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      {loading && !ownerPicked ? '正在读取管理员资源…' : emptyText}
                    </p>
                  );
                }
                return groups.map((g) => {
                  const boundPans = new Set(pans.map((p) => p.pan as PanKey));
                  return (
                    <div key={g.resource_id} className="space-y-2 rounded-lg border border-border px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm text-foreground leading-snug">{g.name}</div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{g.episode_count} 集</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {g.links.map((l) => {
                          const hasPan = boundPans.has(l.pan);
                          const invalid = l.link_status === 'invalid';
                          return (
                            <Button
                              key={l.url}
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!hasPan}
                              title={
                                !hasPan
                                  ? `你还没有绑定${PAN_LABELS[l.pan]}账号，先在下方绑定后再选`
                                  : invalid
                                    ? '链接检测显示可能已失效，仍可尝试订阅'
                                    : `用${PAN_LABELS[l.pan]}订阅这个资源`
                              }
                              onClick={() => applyResourceSource(g.name, l)}
                              className={`h-7 gap-1.5 text-xs border-border ${invalid ? 'text-destructive' : 'text-foreground'}`}
                            >
                              {PAN_LABELS[l.pan]}
                              {invalid
                                ? <AlertCircle className="h-3 w-3" />
                                : <CheckCheck className="h-3 w-3 text-secondary" />}
                            </Button>
                          );
                        })}
                        {g.links.every((l) => !boundPans.has(l.pan)) && (
                          <span className="text-[11px] text-destructive">先绑定对应的网盘账号才能订阅</span>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSrcPicker(false)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 选择「资源管理」里的资源（订阅联动用） */}
      <Dialog open={resPicker} onOpenChange={setResPicker}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle>选择要绑定的资源</DialogTitle>
            <DialogDescription className="text-xs">
              订阅转存到新文件后，会把它们并入这条资源、按新文件更新集数，并把变更同步到已绑定的站点
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={resQuery} onChange={(e) => setResQuery(e.target.value)}
              placeholder="搜索资源名称…" className="h-9 border-border bg-input pl-8 text-xs" />
          </div>
          <div className="max-h-[45vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {resLoading && (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />读取中…
              </div>
            )}
            {!resLoading && resList.length === 0 && (
              <div className="p-3 text-xs text-muted-foreground">
                资源管理里还没有资源，先去「资源管理」添加
              </div>
            )}
            {!resLoading && resList
              .filter((r) => !resQuery.trim() || r.name?.toLowerCase().includes(resQuery.trim().toLowerCase()))
              .slice(0, 200)
              .map((r) => (
                <button key={r.id} type="button"
                  onClick={() => {
                    setForm((f) => ({ ...f, resourceId: r.id, autoPublish: true }));
                    setBoundRes({ id: r.id, name: r.name, episode_count: r.episode_count ?? 0 });
                    setResPicker(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted">
                  <span className="truncate text-xs text-foreground">{r.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {r.episode_count ?? 0} 集{r.is_finished ? ' · 完结' : ''}
                  </span>
                </button>
              ))}
            {!resLoading && resQuery.trim()
              && resList.filter((r) => r.name?.toLowerCase().includes(resQuery.trim().toLowerCase())).length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">没有匹配「{resQuery.trim()}」的资源</div>
              )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 选择转存目录（浏览自己的网盘目录） */}
      <Dialog open={dirPicker} onOpenChange={(o) => { setDirPicker(o); if (!o) setDirs([]); }}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle>选择转存目录（{PAN_LABELS[form.pan]}）</DialogTitle>
            <DialogDescription className="text-xs">
              选中的是目录 ID：之后你在网盘里重命名这个文件夹，转存依然会进到同一个目录
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {dirTrail.map((t, i) => (
              <React.Fragment key={t.id || 'root'}>
                {i > 0 && <span>/</span>}
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => gotoTrail(i)}
                >
                  {t.name}
                </button>
              </React.Fragment>
            ))}
          </div>
          {/* 目录名搜索：快捷定位要转存的目录（本地过滤，不发请求） */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={dirKeyword}
              onChange={(e) => setDirKeyword(e.target.value)}
              placeholder="搜索当前目录下的文件夹名，快捷定位（如：熊出没）"
              className="h-9 pl-8 pr-12 bg-input border-border text-sm"
            />
            {dirKeyword && (
              <button
                type="button"
                onClick={() => setDirKeyword('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground hover:text-foreground"
              >
                清除
              </button>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {dirLoading
              ? '正在读取…'
              : `本层共 ${dirs.length} 个文件夹`}
            {!dirLoading && dirKeyword
              ? `，匹配 ${dirs.filter((d) => (d.name || d.id).toLowerCase().includes(dirKeyword.trim().toLowerCase())).length} 个`
              : ''}
          </div>
          <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {dirLoading && (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {form.pan === 'guangya'
                  ? '读取中…（光鸭目录接口要在服务端盘点，目录较大时可能要十几秒，请稍候）'
                  : '读取中…（目录较大时可能要十几秒，请稍候）'}
              </div>
            )}
            {!dirLoading && dirs.length === 0 && (
              <div className="p-3 text-xs text-muted-foreground">
                {form.pan === 'xunlei'
                  ? '该目录下没有子文件夹：迅雷不能直接转存到根目录，请回到上一层换一个文件夹'
                  : '该目录下没有子文件夹，可直接点「选择当前目录」'}
              </div>
            )}
            {!dirLoading && dirs.length > 0
              && dirKeyword.trim() !== ''
              && dirs.filter((d) => (d.name || d.id).toLowerCase().includes(dirKeyword.trim().toLowerCase())).length === 0 && (
              <div className="p-3 text-xs text-muted-foreground">
                本层没有匹配「{dirKeyword.trim()}」的文件夹：可换个关键词，或先手动进入更上层的目录；
                若目标目录在其它父目录下，点「取消」后回到上一层重新进入。
              </div>
            )}
            {!dirLoading && dirs
              .filter((d) => {
                const q = dirKeyword.trim().toLowerCase();
                return !q || (d.name || d.id).toLowerCase().includes(q);
              })
              .map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => { setDirKeyword(''); enterDir(d); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate text-foreground">{d.name || d.id}</span>
              </button>
            ))}
          </div>
          <DialogFooter className="sm:items-center sm:justify-between">
            {form.pan === 'xunlei' && !dirTrail[dirTrail.length - 1]?.id ? (
              <span className="text-[11px] leading-snug text-amber-500 sm:text-left">
                迅雷云盘不能转存到根目录：请先点进一个文件夹
              </span>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDirPicker(false)}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
              <Button onClick={pickCurrentDir} className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
                <CheckCheck className="h-4 w-4" />选择当前目录
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 解绑网盘确认 */}
      <AlertDialog open={!!panRemove} onOpenChange={(o) => !o && setPanRemove(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>解绑网盘账号？</AlertDialogTitle>
            <AlertDialogDescription>
              解绑后 {panRemove ? PAN_LABELS[panRemove] : ''} 的 Cookie 会被删除，相关订阅将无法转存（仍会用源链接入库）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemovePan}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">确认解绑</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除订阅确认 */}
      <AlertDialog open={!!subRemove} onOpenChange={(o) => !o && setSubRemove(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>删除订阅？</AlertDialogTitle>
            <AlertDialogDescription>
              「{subRemove?.name}」及其抓取记录会被删除。已经入库的资源不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveSub}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
   