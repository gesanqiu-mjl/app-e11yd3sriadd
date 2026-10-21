import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Users, Film, History, Shield, ShieldOff, Loader2, Search, Ticket, Copy, CheckCheck, RefreshCw, Clock, Crown, Settings, Megaphone, Download, Upload, Unlock, KeyRound, Layers, Link2, Trash2, BookOpen } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { updateProfileFeature, updateProfilesFeatureBulk, deleteUserAccount, type ProfileFeatureKey } from '@/services/api';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FEATURE_LABELS } from '@/types/index';
import {
  fetchAllProfiles,
  fetchAllResources,
  fetchAllHistory,
  updateProfileRole,
  updateProfileStatus,
  updateProfileMembership,
  setProfileMembershipExpiry,
  fetchInviteCodes,
  createInviteCode,
  revokeInviteCode,
  buildResourceExport,
  importResources,
  type ResourceExportItem,
  updateProfileBatchPost,
  setProfileBatchPostExpiry,
  updateProfileSubscription,
  updateProfileQuota,
  MAX_RESOURCES_PER_USER,
} from '@/services/api';
import type { Profile, AdminResource, AdminHistory, UserRole, InviteCode } from '@/types/index';
import LoginConfigTab from '@/components/LoginConfigTab';
import AnnouncementTab from '@/components/AnnouncementTab';
import TutorialTab from '@/components/TutorialTab';
import ApiKeysTab from '@/components/ApiKeysTab';
import SubscriptionSourceTab from '@/components/SubscriptionSourceTab';
import SourceOwnerTab from '@/components/SourceOwnerTab';

const MEMBERSHIP_OPTIONS = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '365 天' },
  { value: '3650', label: '10 年' },
  { value: '-1', label: '永久（无期限）' },
  { value: 'custom', label: '自定义到期时间' },
];

/** 邀请码可选时长：比「设置会员时长」多一个 1 天，用于发放短期体验码（不含自定义到期时间） */
const INVITE_CODE_MEMBERSHIP_OPTIONS = [
  { value: '1', label: '1 天' },
  ...MEMBERSHIP_OPTIONS.filter((o) => o.value !== 'custom'),
];

/** 批量发帖权限可选有效期（按自然月计算） */
const BATCH_POST_OPTIONS = [
  { value: '1', label: '1 个月' },
  { value: '3', label: '3 个月' },
  { value: '6', label: '6 个月' },
  { value: '12', label: '1 年' },
  { value: 'custom', label: '自定义到期时间' },
  { value: 'off', label: '关闭权限' },
];

/** 批量发帖权限是否有效：管理员默认可用，普通用户须已开通且未到期 */
function isBatchPostActive(p: Profile): boolean {
  if (p.role === 'admin') return true;
  if (!p.batch_post_expires_at) return false;
  return new Date(p.batch_post_expires_at).getTime() > Date.now();
}

/** 订阅功能权限是否有效：管理员默认可用，普通用户须由管理员开通（subscriptions_enabled） */
function isSubscriptionEnabled(p: Profile): boolean {
  if (p.role === 'admin') return true;
  return !!p.subscriptions_enabled;
}

/** 紧凑日期 `MM-DD HH:mm`（用户管理表格用，省宽度） */
function fmtShortDateTime(s: string): string {
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 紧凑日期 `MM-DD` */
function fmtShortDay(s: string): string {
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 Date 转成 <input type="datetime-local"> 需要的本地时间字符串（YYYY-MM-DDTHH:mm） */
function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function AdminPage() {
  const { profile } = useAuth();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [resources, setResources] = useState<AdminResource[]>([]);
  const [history, setHistory] = useState<AdminHistory[]>([]);
  const [loading, setLoading] = useState(true);

  // 邀请码 state
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genMembershipDays, setGenMembershipDays] = useState('30');
  /** 邀请码类型：normal=普通（按时长）/ special=特殊（永久 + 仅订阅 + 最多 10 个订阅） */
  const [genCodeType, setGenCodeType] = useState<'normal' | 'special'>('normal');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<InviteCode | null>(null);
  const [revoking, setRevoking] = useState(false);

  // 会员管理 state
  const [membershipTarget, setMembershipTarget] = useState<Profile | null>(null);
  const [membershipDays, setMembershipDays] = useState('30');
  const [customExpiresAt, setCustomExpiresAt] = useState('');
  const [membershipSaving, setMembershipSaving] = useState(false);

  // 批量发帖权限 state
  const [batchPostTarget, setBatchPostTarget] = useState<Profile | null>(null);
  const [batchPostMonths, setBatchPostMonths] = useState('1');
  const [batchPostCustomAt, setBatchPostCustomAt] = useState('');
  const [batchPostSaving, setBatchPostSaving] = useState(false);

  // 订阅功能权限 state
  const [subscriptionTarget, setSubscriptionTarget] = useState<Profile | null>(null);
  const [subscriptionEnabled, setSubscriptionEnabled] = useState(false);
  const [subscriptionSaving, setSubscriptionSaving] = useState(false);

  // 额度设置 state（资源条数 / 订阅条数，管理员可对任意非管理员账号单独调整）
  const [quotaTarget, setQuotaTarget] = useState<Profile | null>(null);
  /** 资源上限输入框；空 = 默认 200 */
  const [quotaResValue, setQuotaResValue] = useState('');
  /** 订阅上限输入框；空 = 按账号类型默认（订阅专用 10 / 普通 80） */
  const [quotaSubValue, setQuotaSubValue] = useState('');
  /** 仅订阅专用账号可勾选：null = 不限 */
  const [quotaSubUnlimited, setQuotaSubUnlimited] = useState(false);
  const [quotaSaving, setQuotaSaving] = useState(false);
  /** 用户管理：按账号类型筛选（特殊=特殊邀请码注册的订阅专用账号，独立于资源/历史的「按用户筛选」） */
  const [accountTypeFilter, setAccountTypeFilter] = useState<'all' | 'special' | 'normal'>('all');
  /** 用户管理：搜索（用户名 / 邮箱 / 手机号 / 用户 ID） */
  const [userSearch, setUserSearch] = useState('');
  /** 正在保存的功能权限：`<用户id>:<功能>` */
  const [featureSaving, setFeatureSaving] = useState<string | null>(null);
  /** 用户管理：勾选的账号 id（用于批量开通/关闭功能） */
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  /** 批量操作作用的功能项（默认四项全选） */
  const [batchFeatures, setBatchFeatures] = useState<ProfileFeatureKey[]>([
    'can_resources', 'can_site_sync', 'can_shortlink', 'can_subscriptions',
  ]);
  const [batchSaving, setBatchSaving] = useState(false);
  /** 管理后台当前页签：与侧边栏「管理后台」子菜单联动（/admin?tab=xxx） */
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<string>(searchParams.get('tab') || 'users');
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== tab) setTab(t);
    // 仅跟随地址栏变化；tab 自身变化由标签点击处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /** 可授权的功能项（顺序即表格列里的顺序） */
  const FEATURE_ITEMS: Array<{ key: ProfileFeatureKey; short: string }> = [
    { key: 'can_resources', short: '资源' },
    { key: 'can_site_sync', short: '同步' },
    { key: 'can_shortlink', short: '短链' },
    { key: 'can_subscriptions', short: '订阅' },
  ];
  /** 功能是否已开通：admin 恒开通；undefined/null 视为开通（兼容历史数据） */
  const featureOn = (p: Profile, key: ProfileFeatureKey): boolean => {
    if (p.role === 'admin') return true;
    if (key === 'can_subscriptions') return p.can_subscriptions === true || p.subscriptions_enabled === true;
    return p[key] !== false;
  };
  /**
   * 特殊（订阅专用）账号：只能用订阅功能 —— 资源 / 站点同步 / 短链 三项不可开通。
   * 数据库触发器 enforce_special_account_features 是最后一道兜底，这里是 UI 与调用侧的第一道。
   */
  const lockedFeatureForSpecial = (p: Profile, key: ProfileFeatureKey) =>
    isSpecialAccount(p) && key !== 'can_subscriptions';

  async function handleToggleFeature(p: Profile, key: ProfileFeatureKey, enabled: boolean) {
    if (lockedFeatureForSpecial(p, key)) {
      toast.error('特殊（订阅专用）账号只能使用订阅功能，其余功能不可开通');
      return;
    }
    setFeatureSaving(`${p.id}:${key}`);
    try {
      await updateProfileFeature(p.id, key, enabled);
      // 订阅转存同时更新老字段，避免「订阅功能」列与新开关显示不一致
      if (key === 'can_subscriptions') {
        try { await updateProfileSubscription(p.id, enabled); } catch { /* 老字段失败不影响新字段 */ }
      }
      toast.success(`已${enabled ? '开通' : '关闭'}「${p.username || p.email || p.id}」的${FEATURE_LABELS[key]}`);
      await load();
    } catch (e) {
      toast.error('设置功能权限失败：' + ((e as Error).message || ''));
    } finally {
      setFeatureSaving(null);
    }
  }
  async function handleDeleteUser(p: Profile) {
    const who = p.username || p.email || p.id;
    if (!window.confirm(`确定删除账号「${who}」？\n\n该账号名下的资源、订阅、站点绑定与统计数据都会一并删除，且不可恢复。`)) return;
    try {
      await deleteUserAccount(p.id);
      toast.success(`账号「${who}」已删除`);
      await load();
    } catch (e) {
      toast.error('删除失败：' + ((e as Error).message || ''));
    }
  }

  /** 勾选 / 取消勾选某个账号 */
  const toggleUserSelected = (id: string, on: boolean) => {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** 勾选 / 取消勾选当前筛选出的全部账号 */
  const toggleSelectAllShown = (on: boolean) => {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      for (const p of shownProfiles) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  };

  /**
   * 批量开通 / 关闭所选账号的功能。
   * · 管理员：四项功能恒可用，自动跳过；
   * · 特殊（订阅专用）账号：只能用订阅 → 即使批量勾了四项，也只对它们应用「订阅」。
   */
  async function handleBatchFeature(enabled: boolean) {
    const chosen = profiles.filter((p) => selectedUsers.has(p.id));
    if (chosen.length === 0) { toast.error('请先勾选要操作的账号'); return; }
    if (batchFeatures.length === 0) { toast.error('请至少选择一个功能'); return; }

    const regular = chosen.filter((p) => p.role !== 'admin' && !isSpecialAccount(p));
    const special = chosen.filter((p) => p.role !== 'admin' && isSpecialAccount(p));
    const specialFeatures: ProfileFeatureKey[] = batchFeatures.includes('can_subscriptions')
      ? ['can_subscriptions']
      : [];
    if (regular.length === 0 && (special.length === 0 || specialFeatures.length === 0)) {
      toast.error('所选账号里没有可设置的（管理员恒可用；特殊账号只允许订阅功能）');
      return;
    }

    const names = batchFeatures.map((f) => FEATURE_LABELS[f]).join('、');
    const plan = [
      regular.length > 0 ? `· ${regular.length} 个普通账号：${names}` : '',
      special.length > 0 && specialFeatures.length > 0 ? `· ${special.length} 个特殊账号：仅订阅` : '',
    ].filter(Boolean).join('\n');
    if (!window.confirm(`将${enabled ? '开通' : '关闭'}：\n${plan}\n\n（管理员账号会被跳过；特殊账号只能用订阅功能）`)) return;

    setBatchSaving(true);
    try {
      let done = 0;
      if (regular.length > 0) {
        done += await updateProfilesFeatureBulk(regular.map((p) => p.id), batchFeatures, enabled);
      }
      if (special.length > 0 && specialFeatures.length > 0) {
        done += await updateProfilesFeatureBulk(special.map((p) => p.id), specialFeatures, enabled);
      }
      toast.success(`已${enabled ? '开通' : '关闭'} ${done} 个账号的功能权限`);
      setSelectedUsers(new Set());
      await load();
    } catch (e) {
      toast.error('批量设置失败：' + ((e as Error).message || ''));
    } finally {
      setBatchSaving(false);
    }
  }

  const [userFilter, setUserFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [confirm, setConfirm] = useState<{ type: 'role' | 'status'; target: Profile } | null>(null);
  const [acting, setActing] = useState(false);

  // ── 资源导入导出 ──
  const [exportScope, setExportScope] = useState<'all' | 'updating' | 'finished'>('all');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
  const importFileRef = useRef<HTMLInputElement>(null);

  /** 导出资源为 JSON（可选范围：全部 / 更新中 / 已完结） */
  function handleExportResources() {
    const bundle = buildResourceExport(resources, exportScope);
    if (bundle.total_count === 0) {
      toast.info('当前范围内没有可导出的资源');
      return;
    }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resources_${exportScope}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${bundle.total_count} 条资源（含封面 ${bundle.with_covers_count} 条）`);
  }

  /** 导入资源 JSON：兼容「完整导出包」与「裸数组」两种形态 */
  async function handleImportResources(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许连续导入同一个文件
    if (!file || importing) return;

    setImporting(true);
    setImportProgress({ done: 0, total: 0 });
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error('JSON 解析失败，请确认文件格式');
        return;
      }

      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed as { resources?: unknown } | null)?.resources;
      if (!Array.isArray(arr) || arr.length === 0) {
        toast.error('文件里没有可导入的资源（未找到 resources 数组）');
        return;
      }

      const items: ResourceExportItem[] = arr.map((raw) => {
        const o = (raw ?? {}) as Record<string, unknown>;
        return {
          name: String(o.name ?? '').trim() || '未命名资源',
          episode_count: Number(o.episode_count ?? 0) || 0,
          link: String(o.link ?? ''),
          links: Array.isArray(o.links) ? (o.links as ResourceExportItem['links']) : [],
          cover_url: typeof o.cover_url === 'string' ? o.cover_url : null,
          is_finished: Boolean(o.is_finished),
          sort_order: Number(o.sort_order ?? 0) || 0,
          link_status: String(o.link_status ?? 'unknown'),
        };
      });

      const res = await importResources(items, (done, total) => setImportProgress({ done, total }));
      await load();
      if (res.failed === 0) {
        toast.success(`导入完成：新增 ${res.inserted} 条资源`);
      } else {
        toast.warning(`导入完成：成功 ${res.inserted} 条，失败 ${res.failed} 条`);
      }
    } catch (err) {
      toast.error((err as Error).message || '导入失败，请重试');
    } finally {
      setImporting(false);
      setImportProgress({ done: 0, total: 0 });
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r] = await Promise.all([fetchAllProfiles(), fetchAllResources()]);
      setProfiles(p);
      setResources(r);
    } catch {
      toast.error('加载数据失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInviteCodes = useCallback(async () => {
    setInviteLoading(true);
    try {
      const codes = await fetchInviteCodes();
      setInviteCodes(codes);
    } catch {
      toast.error('加载邀请码失败');
    } finally {
      setInviteLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadInviteCodes(); }, [loadInviteCodes]);

  async function loadHistory() {
    try {
      const h = await fetchAllHistory(startDate || undefined, endDate || undefined);
      setHistory(h);
    } catch {
      toast.error('加载历史记录失败');
    }
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  async function handleGenerateCode() {
    setGenerating(true);
    const isSpecial = genCodeType === 'special';
    try {
      const code = await createInviteCode(Number(genMembershipDays), isSpecial);
      if (code) {
        setInviteCodes((prev) => [code, ...prev]);
        toast.success(
          isSpecial
            ? `特殊邀请码 ${code.code} 已生成（永久有效·仅订阅功能·默认上限 10 个订阅，可在用户管理里调整）`
            : `邀请码 ${code.code} 已生成（会员 ${genMembershipDays === '-1' ? '永久' : genMembershipDays + ' 天'}）`
        );
      }
    } catch {
      toast.error('生成邀请码失败');
    } finally {
      setGenerating(false);
    }
  }

  async function handleSetMembership() {
    if (!membershipTarget) return;
    const who = membershipTarget.username || '该用户';

    // 自定义到期时间：直接写入指定时刻（本地时间 → ISO）
    if (membershipDays === 'custom') {
      if (!customExpiresAt) { toast.error('请选择到期时间'); return; }
      const d = new Date(customExpiresAt);
      if (Number.isNaN(d.getTime())) { toast.error('到期时间格式不正确'); return; }
      setMembershipSaving(true);
      try {
        await setProfileMembershipExpiry(membershipTarget.id, d.toISOString());
        toast.success(`已为「${who}」设置到期时间：${fmtDate(d.toISOString())}`);
        setMembershipTarget(null);
        await load();
      } catch {
        toast.error('设置到期时间失败，请重试');
      } finally {
        setMembershipSaving(false);
      }
      return;
    }

    setMembershipSaving(true);
    try {
      await updateProfileMembership(membershipTarget.id, Number(membershipDays));
      toast.success(`已为「${who}」设置会员${membershipDays === '-1' ? '（永久）' : ' ' + membershipDays + ' 天'}`);
      setMembershipTarget(null);
      await load();
    } catch {
      toast.error('设置会员失败，请重试');
    } finally {
      setMembershipSaving(false);
    }
  }

  async function handleSetBatchPost() {
    if (!batchPostTarget) return;
    const who = batchPostTarget.username || '该用户';

    // 关闭权限：到期时间置空（未开通）
    if (batchPostMonths === 'off') {
      setBatchPostSaving(true);
      try {
        await setProfileBatchPostExpiry(batchPostTarget.id, null);
        toast.success(`已关闭「${who}」的批量发帖权限`);
        setBatchPostTarget(null);
        await load();
      } catch {
        toast.error('关闭批量发帖权限失败，请重试');
      } finally {
        setBatchPostSaving(false);
      }
      return;
    }

    // 自定义到期时刻
    if (batchPostMonths === 'custom') {
      if (!batchPostCustomAt) { toast.error('请选择到期时间'); return; }
      const d = new Date(batchPostCustomAt);
      if (Number.isNaN(d.getTime())) { toast.error('到期时间格式不正确'); return; }
      setBatchPostSaving(true);
      try {
        await setProfileBatchPostExpiry(batchPostTarget.id, d.toISOString());
        toast.success(`已为「${who}」开通批量发帖权限，有效期至 ${fmtDate(d.toISOString())}`);
        setBatchPostTarget(null);
        await load();
      } catch {
        toast.error('设置批量发帖权限失败，请重试');
      } finally {
        setBatchPostSaving(false);
      }
      return;
    }

    setBatchPostSaving(true);
    try {
      await updateProfileBatchPost(batchPostTarget.id, Number(batchPostMonths));
      toast.success(`已为「${who}」开通批量发帖权限（${batchPostMonths} 个月）`);
      setBatchPostTarget(null);
      await load();
    } catch {
      toast.error('设置批量发帖权限失败，请重试');
    } finally {
      setBatchPostSaving(false);
    }
  }

  async function handleSetSubscription() {
    if (!subscriptionTarget) return;
    const who = subscriptionTarget.username || '该用户';
    setSubscriptionSaving(true);
    try {
      await updateProfileSubscription(subscriptionTarget.id, subscriptionEnabled);
      toast.success(
        subscriptionEnabled
          ? `已为「${who}」开通订阅功能`
          : `已关闭「${who}」的订阅功能`
      );
      setSubscriptionTarget(null);
      await load();
    } catch {
      toast.error('设置订阅功能权限失败，请重试');
    } finally {
      setSubscriptionSaving(false);
    }
  }

  /**
   * 管理员设置某账号额度（资源条数 / 订阅条数）。
   * 留空 = 恢复默认：资源 200；订阅按账号类型（订阅专用 10 / 普通 80，订阅专用勾「不限」时为 null）。
   */
  async function handleSaveQuota() {
    if (!quotaTarget) return;
    const who = quotaTarget.username || '该用户';
    const special = isSpecialAccount(quotaTarget);

    const resRaw = quotaResValue.trim();
    const resNum = resRaw === '' ? null : Number(resRaw);
    if (resNum !== null && (!Number.isFinite(resNum) || resNum < 1)) {
      toast.error('资源上限请输入不小于 1 的整数，或留空使用默认');
      return;
    }
    const subRaw = quotaSubValue.trim();
    const subNum = subRaw === '' ? null : Number(subRaw);
    if (!quotaSubUnlimited && subNum !== null && (!Number.isFinite(subNum) || subNum < 1)) {
      toast.error('订阅上限请输入不小于 1 的整数，或留空使用默认');
      return;
    }

    const payload = {
      maxResources: resNum === null ? null : Math.floor(resNum),
      maxSubscriptions: quotaSubUnlimited ? null : subNum === null ? null : Math.floor(subNum),
    };

    setQuotaSaving(true);
    try {
      await updateProfileQuota(quotaTarget.id, payload);
      const resText = payload.maxResources === null ? `默认 ${MAX_RESOURCES_PER_USER}` : `${payload.maxResources}`;
      const subText = quotaSubUnlimited
        ? '不限'
        : payload.maxSubscriptions === null
          ? special ? '默认 10' : '默认 80'
          : `${payload.maxSubscriptions}`;
      toast.success(`已更新「${who}」的额度：资源 ${resText} 条 · 订阅 ${subText} 个`);
      setQuotaTarget(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message || '设置额度失败，请重试');
    } finally {
      setQuotaSaving(false);
    }
  }

  async function handleCopyCode(code: InviteCode) {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopiedId(code.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeInviteCode(revokeTarget.id);
      setInviteCodes((prev) => prev.map((c) => c.id === revokeTarget.id ? { ...c, is_revoked: true } : c));
      toast.success('邀请码已撤销');
    } catch {
      toast.error('撤销失败，请重试');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  }

  async function handleConfirm() {
    if (!confirm) return;
    setActing(true);
    try {
      if (confirm.type === 'role') {
        const next: UserRole = confirm.target.role === 'admin' ? 'user' : 'admin';
        await updateProfileRole(confirm.target.id, next);
        toast.success(next === 'admin' ? '已设为管理员' : '已设为普通用户');
      } else {
        const next = confirm.target.status === 'active' ? 'disabled' : 'active';
        await updateProfileStatus(confirm.target.id, next);
        toast.success(next === 'active' ? '已启用账号' : '已禁用账号');
      }
      await load();
    } catch {
      toast.error('操作失败，请重试');
    } finally {
      setActing(false);
      setConfirm(null);
    }
  }

  function getCodeStatus(c: InviteCode): { label: string; color: string } {
    if (c.is_revoked) return { label: '已撤销', color: 'text-destructive' };
    if (c.used_by) return { label: '已使用', color: 'text-muted-foreground' };
    return { label: '未使用', color: 'text-secondary' };
  }

  if (profile?.role !== 'admin') {
    return (
      <AppLayout>
        <PageMeta
          title="系统管理后台 - 网盘推广工具"
          description="管理后台，支持用户角色权限配置、会员有效期管理、邀请码生成与系统登录配置。"
          keywords="管理后台, 用户管理, 角色权限, 邀请码, 系统配置"
        />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <ShieldOff className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">无权访问管理后台</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  /** 特殊邀请码注册的「订阅专用」账号（有标记的才受影响） */
  const isSpecialAccount = (p: Profile) => p.subscription_only === true;
  /**
   * 订阅上限展示文案。
   * null/0 时按账号类型：订阅专用账号 = 不限（历史语义），普通账号 = 默认 80。
   */
  const subLimitLabel = (p: Profile) => {
    if (typeof p.max_subscriptions === 'number' && p.max_subscriptions > 0) return `${p.max_subscriptions} 个`;
    return p.subscription_only === true ? '不限' : '默认 80 个';
  };
  /** 每个账号当前持有的资源条数（用于额度展示） */
  const resourceCountByOwner = new Map<string, number>();
  for (const r of resources) {
    resourceCountByOwner.set(r.owner_id, (resourceCountByOwner.get(r.owner_id) ?? 0) + 1);
  }
  const specialCount = profiles.filter(isSpecialAccount).length;
  const shownProfiles = (
    accountTypeFilter === 'all'
      ? profiles
      : profiles.filter((p) => (accountTypeFilter === 'special' ? isSpecialAccount(p) : !isSpecialAccount(p)))
  ).filter((p) => {
    // 搜索：用户名 / 邮箱 / 手机号 / 用户 ID —— 输入即筛，几十上百个账号也能秒定位
    const q = userSearch.trim().toLowerCase();
    if (!q) return true;
    return (p.username ?? '').toLowerCase().includes(q)
      || (p.email ?? '').toLowerCase().includes(q)
      || (p.phone ?? '').toLowerCase().includes(q)
      || p.id.toLowerCase().includes(q);
  });

  const filteredResources = userFilter === 'all'
    ? resources
    : resources.filter((r) => r.owner_id === userFilter);
  const filteredHistory = userFilter === 'all'
    ? history
    : history.filter((h) => h.user_id === userFilter);

  const usedByName = (usedById: string | null) => {
    if (!usedById) return null;
    return profiles.find((p) => p.id === usedById)?.username ?? '已注销用户';
  };

  return (
    <AppLayout>
      <PageMeta
        title="系统管理后台 - 网盘推广工具"
        description="管理后台，支持用户角色权限配置、会员有效期管理、邀请码生成与系统登录配置。"
        keywords="管理后台, 用户管理, 角色权限, 邀请码, 系统配置"
      />
      <div className="p-4 md:p-8 max-w-7xl mx-auto">
        <div className="flex items-center gap-2.5 mb-6">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
            <Shield className="h-4 w-4 text-primary" />
          </span>
          <div>
            <h1 className="font-serif text-xl font-bold text-foreground">管理后台</h1>
            <p className="text-xs text-muted-foreground">管理系统用户、资源与修改记录</p>
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            // 与侧边栏子菜单保持一致：把页签写进地址栏（用户管理为默认，不带参数）
            setSearchParams(v === 'users' ? {} : { tab: v }, { replace: true });
          }}
          className="w-full"
        >
          {/* 手机端 8 个标签会换行：必须 h-auto，否则第二行会跑到灰色容器外面（看着像散落的文字） */}
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-muted p-1">
            <TabsTrigger value="users" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Users className="h-3.5 w-3.5" /> 用户管理
            </TabsTrigger>
            <TabsTrigger value="invites" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Ticket className="h-3.5 w-3.5" /> 邀请码
            </TabsTrigger>
            <TabsTrigger value="api-keys" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <KeyRound className="h-3.5 w-3.5" /> API 管理
            </TabsTrigger>
            <TabsTrigger value="resources" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Film className="h-3.5 w-3.5" /> 全部资源
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <History className="h-3.5 w-3.5" /> 修改历史
            </TabsTrigger>
            <TabsTrigger value="login-config" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Settings className="h-3.5 w-3.5" /> 登录页设置
            </TabsTrigger>
            <TabsTrigger value="announcements" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Megaphone className="h-3.5 w-3.5" /> 公告管理
            </TabsTrigger>
            <TabsTrigger value="tutorials" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <BookOpen className="h-3.5 w-3.5" /> 图文教程
            </TabsTrigger>
            <TabsTrigger value="subscription-sources" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Link2 className="h-3.5 w-3.5" /> 订阅源
            </TabsTrigger>
            <TabsTrigger value="source-owners" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Crown className="h-3.5 w-3.5" /> 源主审核
            </TabsTrigger>
          </TabsList>

          {/* 用户管理 */}
          <TabsContent value="users" className="mt-4">
            {/* 搜索用户：用户名 / 邮箱 / 手机号 / 用户 ID 秒定位 */}
            <div className="relative mb-3 max-w-md">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="搜索用户：用户名 / 邮箱 / 手机号 / 用户ID"
                className="h-9 pl-8 bg-input border-border text-sm"
              />
            </div>
            {/* 勾选后的批量操作条：选「作用于哪些功能」→ 一键开通 / 关闭 */}
            {selectedUsers.size > 0 && (
              <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
                <span className="text-xs text-foreground shrink-0">
                  已选 <b className="text-primary">{selectedUsers.size}</b> 个账号
                </span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] text-muted-foreground">作用于：</span>
                  {FEATURE_ITEMS.map((f) => {
                    const on = batchFeatures.includes(f.key);
                    return (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() =>
                          setBatchFeatures((prev) =>
                            on ? prev.filter((k) => k !== f.key) : [...prev, f.key]
                          )
                        }
                        className={`h-6 px-2 rounded text-[11px] border transition-colors ${
                          on
                            ? 'border-primary text-primary bg-primary/10 font-medium'
                            : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {FEATURE_LABELS[f.key]}
                      </button>
                    );
                  })}
                </div>
                {profiles.some((p) => selectedUsers.has(p.id) && isSpecialAccount(p)) && (
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    所选含特殊账号 —— 它们只会应用「订阅」
                  </span>
                )}
                <div className="flex items-center gap-2 lg:ml-auto flex-wrap">
                  <Button
                    size="sm"
                    disabled={batchSaving}
                    onClick={() => void handleBatchFeature(true)}
                    className="h-7 gap-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {batchSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                    批量开通
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={batchSaving}
                    onClick={() => void handleBatchFeature(false)}
                    className="h-7 gap-1 text-xs border-border text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
                    批量关闭
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={batchSaving}
                    onClick={() => setSelectedUsers(new Set())}
                    className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    取消选择
                  </Button>
                </div>
              </div>
            )}
            {/* 账号类型筛选：特殊邀请码注册的「订阅专用」账号一眼可辨、可单独筛选 */}
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
              <div className="flex items-center gap-2 min-w-0">
                <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">
                  共 {profiles.length} 个用户
                  {specialCount > 0 && (
                    <>
                      {' · '}
                      <span className="text-primary">特殊（订阅专用）{specialCount} 个</span>
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {([
                  { key: 'all', label: '全部' },
                  { key: 'special', label: `特殊账号${specialCount ? ` ${specialCount}` : ''}` },
                  { key: 'normal', label: '普通账号' },
                ] as const).map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => setAccountTypeFilter(o.key)}
                    className={`h-7 px-2.5 rounded-md text-xs transition-colors ${
                      accountTypeFilter === o.key
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full [&_th]:px-2 [&_td]:px-2 [&_td]:py-2.5">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[34px]">
                        <Checkbox
                          aria-label="全选当前筛选出的账号"
                          checked={shownProfiles.length > 0 && shownProfiles.every((p) => selectedUsers.has(p.id))}
                          onCheckedChange={(v) => toggleSelectAllShown(v === true)}
                        />
                      </TableHead>
                      <TableHead className="whitespace-nowrap">用户</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">类型</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">会员</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">发帖</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">订阅</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">状态</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">功能权限</TableHead>
                      <TableHead className="whitespace-nowrap hidden lg:table-cell">注册</TableHead>
                      <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center py-12 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
                        </TableCell>
                      </TableRow>
                    ) : shownProfiles.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center py-12 text-sm text-muted-foreground">
                          {profiles.length === 0 ? '暂无用户' : '当前筛选下没有用户'}
                        </TableCell>
                      </TableRow>
                    ) : (
                      shownProfiles.map((p) => {
                        const isActive = p.role === 'admin' || (p.membership_expires_at ? new Date(p.membership_expires_at).getTime() > Date.now() : false);
                        // 功能权限胶囊：桌面端占一列，手机端折到用户名下方（只写一份）
                        const featureRow = (
                          <div className="flex flex-wrap items-center gap-1">
                            {FEATURE_ITEMS.map((f) => {
                              const specialLocked = lockedFeatureForSpecial(p, f.key);
                              const on = specialLocked ? false : featureOn(p, f.key);
                              const busy = featureSaving === `${p.id}:${f.key}`;
                              const locked = p.role === 'admin' || specialLocked;
                              return (
                                <button
                                  key={f.key}
                                  type="button"
                                  disabled={locked || busy}
                                  onClick={() => void handleToggleFeature(p, f.key, !on)}
                                  title={
                                    specialLocked
                                      ? `${FEATURE_LABELS[f.key]}：特殊（订阅专用）账号只能用订阅`
                                      : locked
                                      ? `${FEATURE_LABELS[f.key]}：管理员恒可用`
                                      : `${FEATURE_LABELS[f.key]}：${on ? '已开通（点击关闭）' : '未开通（点击开通）'}`
                                  }
                                  className={`h-6 rounded px-1.5 text-[10px] transition-colors disabled:cursor-not-allowed ${
                                    on
                                      ? 'bg-primary/15 text-primary font-medium'
                                      : 'bg-muted text-muted-foreground hover:text-foreground'
                                  } ${locked ? 'opacity-70' : ''}`}
                                >
                                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : f.short}
                                </button>
                              );
                            })}
                          </div>
                        );
                        return (
                          <TableRow key={p.id}>
                            <TableCell className="w-[36px]">
                              <Checkbox
                                aria-label={`选择 ${p.username || p.email || p.id}`}
                                checked={selectedUsers.has(p.id)}
                                onCheckedChange={(v) => toggleUserSelected(p.id, v === true)}
                              />
                            </TableCell>
                            <TableCell className="break-words md:whitespace-nowrap">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-foreground">{p.username || p.email || '—'}</span>
                                {p.role === 'admin' ? (
                                  <span className="rounded bg-primary/15 px-1.5 py-[1px] text-[10px] font-medium text-primary">管理员</span>
                                ) : (
                                  <span className="rounded bg-muted px-1.5 py-[1px] text-[10px] text-muted-foreground">普通用户</span>
                                )}
                                {p.id === profile?.id && <span className="text-[10px] text-muted-foreground">(我)</span>}
                              </div>
                              {/* 手机端：类型/会员/发帖/订阅/状态/注册/权限胶囊折到用户名下方，避免表格横向溢出 */}
                              <div className="mt-1.5 space-y-1 md:hidden">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                  <span className={isSpecialAccount(p) ? 'text-primary' : ''}>
                                    {isSpecialAccount(p) ? '特殊 · 仅订阅' : '普通'}
                                  </span>
                                  <span>
                                    会员 {p.role === 'admin' ? '永久' : isActive ? `至 ${fmtShortDay(p.membership_expires_at as string)}` : '已过期'}
                                  </span>
                                  <span>
                                    发帖 {p.role === 'admin' ? '可用' : isBatchPostActive(p) ? `至 ${fmtShortDay(p.batch_post_expires_at as string)}` : p.batch_post_expires_at ? '已过期' : '未开通'}
                                  </span>
                                  <span>
                                    订阅 {isSubscriptionEnabled(p) ? '已开通' : '未开通'}
                                    {isSpecialAccount(p) ? ` ≤${p.max_subscriptions ?? 10}` : ''}
                                  </span>
                                  <span className={p.status === 'active' ? '' : 'text-destructive'}>
                                    {p.status === 'active' ? '正常' : '已禁用'}
                                  </span>
                                  <span className="text-[10px]">注册 {fmtShortDateTime(p.created_at)}</span>
                                </div>
                                {featureRow}
                                {p.role !== 'admin' && (
                                  <span
                                    className="text-[10px] text-muted-foreground"
                                    title="资源条数：已持有 / 上限（可在「更多 → 额度设置」里调整）"
                                  >
                                    资源 {resourceCountByOwner.get(p.id) ?? 0}/{p.max_resources ?? MAX_RESOURCES_PER_USER}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap md:table-cell">
                              {isSpecialAccount(p) ? (
                                <span
                                  className="rounded bg-primary/15 px-1.5 py-[1px] text-[10px] font-medium text-primary"
                                  title="特殊邀请码注册：只能用订阅功能；只能订阅管理员在「订阅源」里维护的链接"
                                >
                                  特殊 · 仅订阅
                                </span>
                              ) : (
                                <span className="rounded bg-muted px-1.5 py-[1px] text-[10px] text-muted-foreground">普通</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-xs md:table-cell">
                              {p.role === 'admin' ? (
                                <span className="text-primary">永久</span>
                              ) : isActive ? (
                                <span className="text-secondary" title={`有效期至 ${fmtShortDateTime(p.membership_expires_at as string)}`}>
                                  至 {fmtShortDay(p.membership_expires_at as string)}
                                </span>
                              ) : (
                                <span className="text-destructive">已过期</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-xs md:table-cell">
                              {p.role === 'admin' ? (
                                <span className="text-primary">可用</span>
                              ) : isBatchPostActive(p) ? (
                                <span className="text-secondary" title={`有效期至 ${fmtShortDateTime(p.batch_post_expires_at as string)}`}>
                                  至 {fmtShortDay(p.batch_post_expires_at as string)}
                                </span>
                              ) : p.batch_post_expires_at ? (
                                <span className="text-destructive">已过期</span>
                              ) : (
                                <span className="text-muted-foreground">未开通</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-xs md:table-cell">
                              {isSubscriptionEnabled(p) ? (
                                <span className="text-secondary">已开通</span>
                              ) : (
                                <span className="text-muted-foreground">未开通</span>
                              )}
                              {p.role !== 'admin' && (
                                <span className="ml-1 text-muted-foreground" title="订阅条数上限，可在「更多 → 额度设置」里调整">
                                  上限 {subLimitLabel(p)}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-xs md:table-cell">
                              {p.status === 'active' ? (
                                <span className="text-secondary">正常</span>
                              ) : (
                                <span className="text-destructive">已禁用</span>
                              )}
                            </TableCell>
                            {/* 功能权限：资源 / 同步 / 短链 / 订阅，点一下即切换（紧凑胶囊，替代原来的四个开关） */}
                            <TableCell className="hidden whitespace-nowrap md:table-cell">
                              {featureRow}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground hidden lg:table-cell">
                              {fmtShortDateTime(p.created_at)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <div className="flex items-center justify-end gap-1">
                                {/* 常用：会员 */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                                  title="设置会员（有效期）"
                                  onClick={() => {
                                    setMembershipTarget(p);
                                    setMembershipDays('30');
                                    // 预填当前到期时间（便于在其基础上微调）；未设置过则默认一个月后
                                    setCustomExpiresAt(
                                      p.membership_expires_at
                                        ? toLocalInputValue(new Date(p.membership_expires_at))
                                        : toLocalInputValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
                                    );
                                  }}
                                  disabled={p.role === 'admin'}
                                >
                                  <Crown className="h-3.5 w-3.5" />
                                </Button>
                                {/* 其余操作收进「更多」，避免操作列被挤出屏幕 */}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                                      title="更多操作"
                                    >
                                      <Settings className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-44 bg-card border-border">
                                    <DropdownMenuItem
                                      disabled={p.role === 'admin'}
                                      onClick={() => {
                                        setBatchPostTarget(p);
                                        setBatchPostMonths('1');
                                        setBatchPostCustomAt(toLocalInputValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)));
                                      }}
                                    >
                                      <Unlock className="h-3.5 w-3.5 mr-2" />批量发帖权限
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={p.role === 'admin'}
                                      onClick={() => {
                                        setSubscriptionTarget(p);
                                        setSubscriptionEnabled(isSubscriptionEnabled(p));
                                      }}
                                    >
                                      <Layers className="h-3.5 w-3.5 mr-2" />订阅功能
                                    </DropdownMenuItem>
                                    {/* 任意非管理员账号都能单独设额度：资源条数 / 订阅条数 */}
                                    {p.role !== 'admin' && (
                                      <DropdownMenuItem
                                        onClick={() => {
                                          setQuotaTarget(p);
                                          setQuotaResValue(
                                            typeof p.max_resources === 'number' && p.max_resources > 0 ? String(p.max_resources) : ''
                                          );
                                          setQuotaSubValue(
                                            typeof p.max_subscriptions === 'number' && p.max_subscriptions > 0 ? String(p.max_subscriptions) : ''
                                          );
                                          // 订阅专用账号的 null = 不限（历史语义）；普通账号的 null = 默认 80
                                          setQuotaSubUnlimited(isSpecialAccount(p) && (p.max_subscriptions === null || p.max_subscriptions === undefined));
                                        }}
                                      >
                                        <Crown className="h-3.5 w-3.5 mr-2" />额度设置（资源 / 订阅）
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator className="bg-border" />
                                    <DropdownMenuItem
                                      disabled={p.id === profile?.id}
                                      onClick={() => setConfirm({ type: 'role', target: p })}
                                    >
                                      <Shield className="h-3.5 w-3.5 mr-2" />
                                      {p.role === 'admin' ? '设为普通用户' : '设为管理员'}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={p.id === profile?.id}
                                      onClick={() => setConfirm({ type: 'status', target: p })}
                                      className={p.status === 'active' ? 'text-destructive focus:text-destructive' : 'text-secondary focus:text-secondary'}
                                    >
                                      <ShieldOff className="h-3.5 w-3.5 mr-2" />
                                      {p.status === 'active' ? '禁用账号' : '启用账号'}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                                {/* 危险：删除 */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                  title="删除该账号及其名下全部数据（不可恢复）"
                                  onClick={() => void handleDeleteUser(p)}
                                  disabled={p.role === 'admin' || p.id === profile?.id}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 邀请码管理 */}
          <TabsContent value="invites" className="mt-4">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Ticket className="h-4 w-4 shrink-0" />
                <span>共 {inviteCodes.length} 个邀请码，未使用 {inviteCodes.filter((c) => !c.used_by && !c.is_revoked).length} 个</span>
              </div>
              {/* 手机端这排控件（刷新 + 两个下拉 + 生成按钮）总宽约 430px，shrink-0 会把「生成邀请码」挤出屏幕：
                  改成允许换行 + 独占一行 */}
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5"
                  onClick={loadInviteCodes}
                  disabled={inviteLoading}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${inviteLoading ? 'animate-spin' : ''}`} />
                  刷新
                </Button>
                <Select value={genCodeType} onValueChange={(v) => setGenCodeType(v as 'normal' | 'special')}>
                  <SelectTrigger className="w-32 h-8 bg-input border-border text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">普通邀请码</SelectItem>
                    <SelectItem value="special">特殊邀请码</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={genMembershipDays}
                  onValueChange={setGenMembershipDays}
                  disabled={genCodeType === 'special'}
                >
                  <SelectTrigger className="w-28 h-8 bg-input border-border text-xs disabled:opacity-60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVITE_CODE_MEMBERSHIP_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
                  onClick={handleGenerateCode}
                  disabled={generating}
                >
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ticket className="h-3.5 w-3.5" />}
                  生成邀请码
                </Button>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">邀请码</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">类型</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">会员时长</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">状态</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">使用者</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">使用时间</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">生成时间</TableHead>
                      <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inviteLoading ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-12 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
                        </TableCell>
                      </TableRow>
                    ) : inviteCodes.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-12 text-sm text-muted-foreground">
                          暂无邀请码，点击「生成邀请码」创建
                        </TableCell>
                      </TableRow>
                    ) : (
                      inviteCodes.map((c) => {
                        const { label, color } = getCodeStatus(c);
                        const isCopied = copiedId === c.id;
                        // 类型徽标：桌面端占一列，手机端折到邀请码下方（只写一份）
                        const typeBadge = c.is_special ? (
                          <Badge
                            variant="secondary"
                            className="text-[10px] h-4 px-1.5 border-0 bg-primary/15 text-primary"
                            title="永久有效；注册出来的账号只能使用订阅功能、只能订阅管理员订阅源，订阅数量默认上限 10 个（可在用户管理里调整）"
                          >
                            特殊
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] h-4 px-1.5 border-0 bg-muted text-muted-foreground">
                            普通
                          </Badge>
                        );
                        return (
                          <TableRow key={c.id}>
                            <TableCell className="whitespace-nowrap font-mono font-bold tracking-widest text-foreground">
                              {c.code}
                              {/* 手机端：类型/会员时长/状态/使用者/时间折到邀请码下方，避免表格横向溢出 */}
                              <div className="mt-1.5 space-y-1 font-sans font-normal tracking-normal md:hidden">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                  {typeBadge}
                                  <span>{c.is_special || c.membership_days === -1 ? '永久' : `${c.membership_days} 天`}</span>
                                  <span className={`text-[11px] ${color}`}>{label}</span>
                                  <span>使用者 {usedByName(c.used_by) ?? '—'}</span>
                                  <span>使用 {c.used_at ? fmtDate(c.used_at) : '—'}</span>
                                  <span>生成 {fmtDate(c.created_at)}</span>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap md:table-cell">
                              {typeBadge}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                              {c.is_special || c.membership_days === -1 ? '永久' : `${c.membership_days} 天`}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap md:table-cell">
                              <span className={`text-xs ${color}`}>{label}</span>
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                              {usedByName(c.used_by) ?? '—'}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                              {c.used_at ? fmtDate(c.used_at) : '—'}
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                              {fmtDate(c.created_at)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <div className="flex justify-end gap-1.5">
                                {!c.used_by && !c.is_revoked && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1"
                                      onClick={() => handleCopyCode(c)}
                                    >
                                      {isCopied ? <CheckCheck className="h-3.5 w-3.5 text-secondary" /> : <Copy className="h-3.5 w-3.5" />}
                                      {isCopied ? '已复制' : '复制'}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted"
                                      onClick={() => setRevokeTarget(c)}
                                    >
                                      撤销
                                    </Button>
                                  </>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* API 管理 */}
          <TabsContent value="api-keys" className="mt-4">
            <ApiKeysTab />
          </TabsContent>

          {/* 全部资源 */}
          <TabsContent value="resources" className="mt-4">
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
              <div className="flex items-center gap-2 min-w-0">
                <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">共 {filteredResources.length} 条资源</span>
              </div>
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="w-full md:w-48 h-9 bg-input border-border">
                  <SelectValue placeholder="按用户筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部用户</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.username || '未命名'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* 导入 / 导出（JSON） */}
              <div className="flex items-center gap-1.5 md:ml-auto">
                <Select
                  value={exportScope}
                  onValueChange={(v) => setExportScope(v as 'all' | 'updating' | 'finished')}
                >
                  <SelectTrigger className="w-32 h-9 bg-input border-border text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部资源</SelectItem>
                    <SelectItem value="updating">仅更新中</SelectItem>
                    <SelectItem value="finished">仅已完结</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportResources}
                  className="h-9 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Download className="h-3.5 w-3.5" />导出 JSON
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={importing}
                  onClick={() => importFileRef.current?.click()}
                  className="h-9 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  {importing
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Upload className="h-3.5 w-3.5" />}
                  {importing
                    ? `导入中 ${importProgress.done}/${importProgress.total}`
                    : '导入 JSON'}
                </Button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportResources}
                />
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">资源名称</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">集数</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">所属用户</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">链接</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredResources.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center py-12 text-sm text-muted-foreground">
                          暂无资源
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredResources.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="max-w-xs font-medium text-foreground md:whitespace-nowrap md:truncate">
                            <div className="break-words">{r.name || '—'}</div>
                            {/* 手机端：集数/所属用户/链接折到资源名称下方，避免表格横向溢出 */}
                            <div className="mt-1.5 space-y-1 md:hidden">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-normal text-muted-foreground">
                                <span>{r.episode_count} 集</span>
                                <span>{r.owner_name || '—'}</span>
                              </div>
                              {r.link ? (
                                <a href={r.link} target="_blank" rel="noreferrer" className="block break-all text-[11px] text-primary hover:underline">
                                  {r.link}
                                </a>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-sm md:table-cell">{r.episode_count}</TableCell>
                          <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                            {r.owner_name || '—'}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap max-w-xs md:table-cell">
                            {r.link ? (
                              <a href={r.link} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline truncate inline-block max-w-[200px] align-bottom">
                                {r.link}
                              </a>
                            ) : '—'}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 修改历史 */}
          <TabsContent value="history" className="mt-4">
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="w-full md:w-48 h-9 bg-input border-border">
                  <SelectValue placeholder="按用户筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部用户</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.username || '未命名'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* 手机端两个日期框改为可伸缩：原来固定 w-36，系统字体放大时两个框就会撑破行宽，把整块内容横向顶出去 */}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 min-w-0 flex-1 bg-input border-border text-sm sm:w-36 sm:flex-none"
                />
                <span className="shrink-0 text-xs text-muted-foreground">至</span>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-9 min-w-0 flex-1 bg-input border-border text-sm sm:w-36 sm:flex-none"
                />
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                {/* 手机端 table-fixed：只剩一列时列宽被锁死为容器宽度，长内容再离谱也不会把表格撑出横向滚动 */}
                <Table className="table-fixed md:table-auto">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">修改时间</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">用户</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">资源名称</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">字段</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">原值</TableHead>
                      <TableHead className="hidden whitespace-nowrap md:table-cell">新值</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHistory.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-sm text-muted-foreground">
                          暂无修改记录
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredHistory.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell className="text-xs text-muted-foreground md:whitespace-nowrap">
                            {fmtDate(h.changed_at)}
                            {/* 手机端：用户/资源/字段/原值→新值折到修改时间下方，避免表格横向溢出 */}
                            <div className="mt-1.5 space-y-1 md:hidden">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                                <span className="text-foreground">{h.username || '—'}</span>
                                <span className="break-all">{h.resource_name || '—'}</span>
                                <span>{h.field_label}</span>
                              </div>
                              <div className="flex flex-wrap items-baseline gap-1 text-[11px]">
                                {/* 用 break-all 而不是 break-words：链接这类长串不分词，break-words 不影响最小宽度，
                                    只要有一行存了长链接，整张表就会被撑宽、右侧内容被推到屏幕外 */}
                                <span className="break-all">{h.old_value || '空'}</span>
                                <span>→</span>
                                <span className="break-all text-primary">{h.new_value || '空'}</span>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-sm md:table-cell">{h.username || '—'}</TableCell>
                          {/* 资源名称 / 原值 / 新值：不再 140px 截断成「…」，内容长了换行完整显示（鼠标悬停也能看全文） */}
                          <TableCell className="hidden max-w-xs break-words text-sm md:table-cell">{h.resource_name || '—'}</TableCell>
                          <TableCell className="hidden whitespace-nowrap text-sm md:table-cell">{h.field_label}</TableCell>
                          <TableCell className="hidden max-w-[16rem] break-words text-sm text-muted-foreground md:table-cell" title={h.old_value || '空'}>{h.old_value || '空'}</TableCell>
                          <TableCell className="hidden max-w-[16rem] break-words text-sm text-primary md:table-cell" title={h.new_value || '空'}>{h.new_value || '空'}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 登录页设置 */}
          <TabsContent value="login-config" className="mt-4">
            <div className="rounded-xl border border-border bg-card p-4 md:p-6">
              <LoginConfigTab />
            </div>
          </TabsContent>
          <TabsContent value="announcements" className="mt-4">
            <AnnouncementTab />
          </TabsContent>
          <TabsContent value="tutorials" className="mt-4">
            <TutorialTab />
          </TabsContent>
          <TabsContent value="subscription-sources" className="mt-4">
            <SubscriptionSourceTab />
          </TabsContent>
          <TabsContent value="source-owners" className="mt-4">
            <SourceOwnerTab />
          </TabsContent>
        </Tabs>
      </div>

      {/* 用户操作确认弹窗 */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === 'role'
                ? confirm.target.role === 'admin' ? '设为普通用户？' : '设为管理员？'
                : confirm?.target.status === 'active' ? '禁用该账号？' : '启用该账号？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === 'status' && confirm.target.status === 'active'
                ? `禁用后「${confirm.target.username || '该用户'}」将无法登录系统。`
                : `确认对「${confirm?.target.username || '该用户'}」执行此操作？`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={acting}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {acting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 撤销邀请码确认弹窗 */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>撤销邀请码？</AlertDialogTitle>
            <AlertDialogDescription>
              邀请码 <span className="font-mono font-bold">{revokeTarget?.code}</span> 撤销后将无法被使用，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              确认撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 设置会员时长弹窗 */}
      <Dialog open={!!membershipTarget} onOpenChange={(o) => !o && setMembershipTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>设置会员时长</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              为「{membershipTarget?.username || '该用户'}」设置会员有效期。
              <span className="text-foreground">会员到期后账号会被自动停用（无法登录）</span>；
              把到期时间设成未来或永久时会同时恢复启用，不用再单独点「启用」。
            </p>
            {membershipTarget?.membership_expires_at && (
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                当前到期时间：
                <span className="text-foreground">{fmtDate(membershipTarget.membership_expires_at)}</span>
                {new Date(membershipTarget.membership_expires_at).getTime() <= Date.now() && (
                  <span className="ml-1 text-destructive">（已过期）</span>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">会员时长</Label>
              <Select value={membershipDays} onValueChange={setMembershipDays}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMBERSHIP_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {membershipDays === 'custom' && (
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">到期时间</Label>
                <Input
                  type="datetime-local"
                  value={customExpiresAt}
                  onChange={(e) => setCustomExpiresAt(e.target.value)}
                  className="h-9 bg-input border-border"
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setCustomExpiresAt(toLocalInputValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)))}
                    className="h-7 text-xs border-border">
                    +7 天
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setCustomExpiresAt(toLocalInputValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)))}
                    className="h-7 text-xs border-border">
                    +30 天
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => {
                      const d = new Date();
                      d.setMonth(d.getMonth() + 1, 1);
                      d.setDate(0);
                      d.setHours(23, 59, 0, 0);
                      setCustomExpiresAt(toLocalInputValue(d));
                    }}
                    className="h-7 text-xs border-border">
                    本月底
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => {
                      const d = new Date();
                      d.setFullYear(d.getFullYear(), 11, 31);
                      d.setHours(23, 59, 0, 0);
                      setCustomExpiresAt(toLocalInputValue(d));
                    }}
                    className="h-7 text-xs border-border">
                    今年底
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  按本地时间设置，到期后该用户的编辑功能将被锁定。
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMembershipTarget(null)} className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              取消
            </Button>
            <Button onClick={handleSetMembership} disabled={membershipSaving} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {membershipSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              确认设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 设置批量发帖权限弹窗 */}
      <Dialog open={!!batchPostTarget} onOpenChange={(o) => !o && setBatchPostTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>设置批量发帖权限</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              为「{batchPostTarget?.username || '该用户'}」开通批量发帖权限并设置有效期，到期后该用户的批量发帖功能会被锁定。
            </p>
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {batchPostTarget?.batch_post_expires_at ? (
                <span>
                  当前到期时间：
                  <span className="text-foreground">{fmtDate(batchPostTarget.batch_post_expires_at)}</span>
                  {new Date(batchPostTarget.batch_post_expires_at).getTime() <= Date.now() && (
                    <span className="ml-1 text-destructive">（已过期）</span>
                  )}
                </span>
              ) : (
                <span>当前状态：未开通</span>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">有效期</Label>
              <Select value={batchPostMonths} onValueChange={setBatchPostMonths}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BATCH_POST_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                按自然月计算（如 1 个月＝今天到下个月同日 0 点）；选择「关闭权限」会立即锁定该功能。
              </p>
            </div>
            {batchPostMonths === 'custom' && (
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">到期时间</Label>
                <Input
                  type="datetime-local"
                  value={batchPostCustomAt}
                  onChange={(e) => setBatchPostCustomAt(e.target.value)}
                  className="h-9 bg-input border-border"
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => {
                      const d = new Date();
                      d.setMonth(d.getMonth() + 1, 1);
                      d.setDate(0);
                      d.setHours(23, 59, 0, 0);
                      setBatchPostCustomAt(toLocalInputValue(d));
                    }}
                    className="h-7 text-xs border-border">
                    本月底
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => {
                      const d = new Date();
                      d.setFullYear(d.getFullYear(), 11, 31);
                      d.setHours(23, 59, 0, 0);
                      setBatchPostCustomAt(toLocalInputValue(d));
                    }}
                    className="h-7 text-xs border-border">
                    今年底
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">按本地时间设置，到期后批量发帖功能将被锁定。</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchPostTarget(null)} className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              取消
            </Button>
            <Button onClick={handleSetBatchPost} disabled={batchPostSaving} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {batchPostSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4" />}
              {batchPostMonths === 'off' ? '关闭权限' : '确认开通'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 设置订阅功能权限弹窗 */}
      <Dialog open={!!subscriptionTarget} onOpenChange={(o) => !o && setSubscriptionTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>订阅功能权限</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              为「{subscriptionTarget?.username || '该用户'}」{subscriptionEnabled ? '关闭' : '开通'}订阅功能。
              {subscriptionEnabled
                ? '关闭后该用户将无法使用订阅转存（含定时任务），已创建的订阅不会被删除。'
                : '开通后该用户即可创建 / 执行订阅转存。'}
            </p>
            <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
              <span className="text-sm text-foreground">订阅功能</span>
              <Switch checked={subscriptionEnabled} onCheckedChange={setSubscriptionEnabled} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubscriptionTarget(null)} className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              取消
            </Button>
            <Button onClick={handleSetSubscription} disabled={subscriptionSaving} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {subscriptionSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 额度设置弹窗：资源条数 / 订阅条数，任意非管理员账号可单独调整 */}
      <Dialog open={!!quotaTarget} onOpenChange={(o) => !o && setQuotaTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>额度设置（资源 / 订阅）</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              设置「{quotaTarget?.username || '该用户'}」最多能管理多少条资源、创建多少个订阅。
              {quotaTarget && isSpecialAccount(quotaTarget) && ' 该账号是特殊邀请码注册的「订阅专用」账号，只能在管理员维护的订阅源里选链接。'}
            </p>

            {/* 资源条数 */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">资源条数上限</Label>
              <Input
                type="number"
                min={1}
                max={99999}
                placeholder={`留空 = 默认 ${MAX_RESOURCES_PER_USER} 条`}
                value={quotaResValue}
                onChange={(e) => setQuotaResValue(e.target.value)}
                className="h-9 bg-input border-border"
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                {['100', '200', '500', '1000', '2000'].map((n) => (
                  <Button
                    key={n}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-border"
                    onClick={() => setQuotaResValue(n)}
                  >
                    {n} 条
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setQuotaResValue('')}
                >
                  恢复默认
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                超限后无法再新增资源（订阅转存等后台流程不受此限）；管理员账号本身不受限。
              </p>
            </div>

            {/* 订阅条数 */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">订阅条数上限</Label>
              <Input
                type="number"
                min={1}
                max={9999}
                placeholder={quotaTarget && isSpecialAccount(quotaTarget) ? '留空 = 不限（订阅专用账号）' : '留空 = 默认 80 条'}
                value={quotaSubValue}
                disabled={quotaSubUnlimited}
                onChange={(e) => setQuotaSubValue(e.target.value)}
                className="h-9 bg-input border-border disabled:opacity-50"
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                {['10', '20', '50', '80', '100'].map((n) => (
                  <Button
                    key={n}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-border"
                    disabled={quotaSubUnlimited}
                    onClick={() => setQuotaSubValue(n)}
                  >
                    {n} 个
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground hover:text-foreground"
                  disabled={quotaSubUnlimited}
                  onClick={() => setQuotaSubValue('')}
                >
                  恢复默认
                </Button>
              </div>
              {/* 「不限」只对订阅专用账号有意义：普通账号留空就是默认 80，不会被理解成无限 */}
              {quotaTarget && isSpecialAccount(quotaTarget) && (
                <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
                  <div>
                    <p className="text-sm text-foreground">不限数量</p>
                    <p className="text-[11px] text-muted-foreground">勾选后该账号可以创建任意多个订阅</p>
                  </div>
                  <Switch checked={quotaSubUnlimited} onCheckedChange={setQuotaSubUnlimited} />
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuotaTarget(null)} className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              取消
            </Button>
            <Button onClick={handleSaveQuota} disabled={quotaSaving} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {quotaSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crown className="h-4 w-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
