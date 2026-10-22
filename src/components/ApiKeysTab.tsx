import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  Plus,
  Copy,
  CheckCheck,
  Eye,
  EyeOff,
  Loader2,
  Trash2,
  RefreshCw,
  Power,
  PowerOff,
  AlertCircle,
  BookOpen,
  UserCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  fetchAllProfiles,
  RESOURCE_API_BASE,
} from '@/services/api';
import type { ApiKey, Profile } from '@/types/index';

/** API Key 有效期可选值 */
/** 网站公开的匿名密钥：客户端插件用它 + 用户账号密码换 access_token（公开信息，非敏感） */
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';
/** 批量发帖（自动发帖脚本）接口地址：POST + 登录态 JWT，需要批量发帖权限 */
const BATCH_POST_API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/batch-post`;
/** 短链接口地址：POST + X-API-Key，只做短链（不发帖），短链按密钥归属账号创建 */
const SHORTLINK_API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shortlink-api`;
/** 本系统账号邮箱后缀：插件里用「用户名 + 该后缀」当邮箱登录 */
const ACCOUNT_EMAIL_SUFFIX = '@miaoda.com';

const EXPIRY_OPTIONS = [
  { value: 'never', label: '永久有效' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
  { value: 'custom', label: '自定义到期时间' },
];

function fmtDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 Date 转成 <input type="datetime-local"> 需要的本地时间字符串（YYYY-MM-DDTHH:mm） */
function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 密钥状态：停用 / 过期 / 可用 */
function keyStatus(k: ApiKey): { label: string; className: string } {
  if (!k.is_active) return { label: '已停用', className: 'bg-muted text-muted-foreground' };
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now()) {
    return { label: '已过期', className: 'bg-destructive/15 text-destructive' };
  }
  return { label: '可用', className: 'bg-primary/15 text-primary' };
}

function maskKey(key: string): string {
  return `${key.slice(0, 8)}${'•'.repeat(12)}${key.slice(-6)}`;
}

/** 代码块 + 复制按钮 */
function CodeBlock({ code, className = '' }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动选择复制');
    }
  }

  return (
    <div className={`relative group ${className}`}>
      <pre className="rounded-lg border border-border bg-muted/40 p-3 pr-10 font-mono text-[11px] leading-relaxed text-foreground overflow-x-auto whitespace-pre">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={copy}
        title="整块复制"
        className="absolute top-1.5 right-1.5 h-6 w-6 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        {copied ? <CheckCheck className="h-3 w-3 text-secondary" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

/** 文档小节标题 */
function DocSection({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="pt-4 mt-4 border-t border-border first:mt-0 first:pt-0 first:border-t-0">
      <h4 className="text-xs font-semibold text-foreground">{title}</h4>
      {desc && <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>}
      <div className="mt-2 space-y-2.5">{children}</div>
    </div>
  );
}

/** 文档表格（接口一览 / 请求参数）：手机端逐行堆叠，桌面端保持表格 */
function DocTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* 手机端：一行一张卡片（首列作标题，其余按表头逐条列出），长说明自动折行，不用横向滚动 */}
      <div className="divide-y divide-border md:hidden">
        {rows.map((r) => (
          <div key={r.join('|')} className="space-y-1 p-3">
            <div className="break-all font-mono text-[11px] text-foreground">{r[0]}</div>
            {r.slice(1).map((cell, i) => (
              <div key={`${r[0]}-${i}`} className="flex gap-1.5 text-[11px] text-muted-foreground">
                <span className="shrink-0">{head[i + 1]}：</span>
                <span className="break-words">{cell}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* 桌面端：保持原表格 */}
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {head.map((h) => (
                <TableHead key={h} className="whitespace-nowrap text-xs">{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.join('|')}>
                {r.map((cell, i) => (
                  <TableCell
                    key={`${r[0]}-${i}`}
                    className={
                      i === 0
                        ? 'whitespace-nowrap font-mono text-[11px] text-foreground'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default function ApiKeysTab() {
  const { profile } = useAuth();

  const [items, setItems] = useState<ApiKey[]>([]);
  const [accounts, setAccounts] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 新建弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [remark, setRemark] = useState('');
  const [ownerId, setOwnerId] = useState('');
  /** 数据范围：owner=仅归属账号；all=全部账号（订阅入库通知接口可跨账号查询） */
  const [scope, setScope] = useState<'owner' | 'all'>('owner');
  const [expiry, setExpiry] = useState('never');
  const [customExpiresAt, setCustomExpiresAt] = useState(
    toLocalInputValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [keys, users] = await Promise.all([fetchApiKeys(), fetchAllProfiles()]);
      setItems(keys);
      setAccounts(users);
    } catch (e) {
      toast.error((e as Error).message || '加载 API Key 失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 默认归属当前登录管理员，避免漏选
  useEffect(() => {
    if (profile?.id && !ownerId) setOwnerId(profile.id);
  }, [profile?.id, ownerId]);

  /** 归属账号展示名 */
  function accountLabel(id: string): string {
    if (id === profile?.id) return `${profile?.username || '我'}（我）`;
    const u = accounts.find((a) => a.id === id);
    return u ? (u.username || u.email || '未命名用户') : '账号已注销';
  }

  async function handleCopy(key: ApiKey) {
    try {
      await navigator.clipboard.writeText(key.api_key);
      setCopiedId(key.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  }

  async function handleCreate() {
    if (!name.trim()) {
      toast.info('请填写应用名称（便于区分调用方）');
      return;
    }
    if (!ownerId) {
      toast.info('请选择密钥归属账号');
      return;
    }

    let expiresAt: string | null = null;
    if (expiry === 'custom') {
      const d = new Date(customExpiresAt);
      if (!customExpiresAt || Number.isNaN(d.getTime())) {
        toast.error('请选择有效的到期时间');
        return;
      }
      expiresAt = d.toISOString();
    } else if (expiry !== 'never') {
      expiresAt = new Date(Date.now() + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();
    }

    setCreating(true);
    try {
      const created = await createApiKey({ name, ownerId, remark, expiresAt, scope });
      if (created) {
        setItems((prev) => [created, ...prev]);
        setRevealed((prev) => ({ ...prev, [created.id]: true }));
        toast.success(
          `已创建「${created.name}」（归属：${accountLabel(created.owner_id)}），密钥已展开，请复制后妥善保存`
        );
      }
      setCreateOpen(false);
      setName('');
      setRemark('');
      setScope('owner');
      setExpiry('never');
    } catch (e) {
      toast.error((e as Error).message || '创建失败，请重试');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(key: ApiKey) {
    setBusyId(key.id);
    try {
      await updateApiKey(key.id, { is_active: !key.is_active });
      setItems((prev) => prev.map((k) => (k.id === key.id ? { ...k, is_active: !k.is_active } : k)));
      toast.success(key.is_active ? '已停用该密钥' : '已启用该密钥');
    } catch (e) {
      toast.error((e as Error).message || '操作失败，请重试');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteApiKey(deleteTarget.id);
      setItems((prev) => prev.filter((k) => k.id !== deleteTarget.id));
      toast.success('密钥已删除');
    } catch (e) {
      toast.error((e as Error).message || '删除失败，请重试');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  const activeCount = items.filter(
    (k) => k.is_active && !(k.expires_at && new Date(k.expires_at).getTime() <= Date.now())
  ).length;
  const sampleKey = items[0]?.api_key ?? 'rk_xxxxxxxxxxxxxxxx';

  return (
    <div className="space-y-5">
      {/* 概览 + 新建 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
              <KeyRound className="h-4 w-4 text-primary" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">开放接口 API Key</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                创建密钥后，开发者可用它调用开放接口，<b>实时</b>查询<b>更新中（已更新）</b>与<b>已完结</b>的资源信息，
                无需登录本系统。每个密钥绑定一个账号，<b>资源类接口只返回该账号自己名下的资源</b>，看不到其他账号的数据；
                若需要「一个密钥查所有账号的订阅入库通知」，创建时把「数据范围」选成<b>全部账号</b>即可（仅对
                <code className="font-mono">/subscriptions</code> 生效）。资源一经修改，接口即返回最新数据。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={load}
              disabled={loading}
              className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="h-8 text-xs gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              创建 API Key
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <Badge variant="secondary" className="text-[10px] h-5">共 {items.length} 个</Badge>
          <Badge variant="secondary" className="text-[10px] h-5 bg-primary/15 text-primary">可用 {activeCount} 个</Badge>
          <Badge variant="secondary" className="text-[10px] h-5 bg-accent/15 text-accent">数据实时</Badge>
          <Badge variant="secondary" className="text-[10px] h-5 bg-muted text-muted-foreground">
            资源接口默认仅限归属账号
          </Badge>
          {items.some((k) => k.scope === 'all') && (
            <Badge variant="secondary" className="text-[10px] h-5 bg-accent/15 text-accent">
              订阅通知：全部账号
            </Badge>
          )}
        </div>
      </div>

      {/* 密钥列表 */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">应用名称</TableHead>
                <TableHead className="hidden whitespace-nowrap md:table-cell">归属账号</TableHead>
                <TableHead className="hidden whitespace-nowrap md:table-cell">API Key</TableHead>
                <TableHead className="hidden whitespace-nowrap md:table-cell">状态</TableHead>
                <TableHead className="hidden whitespace-nowrap md:table-cell">调用次数</TableHead>
                <TableHead className="hidden whitespace-nowrap md:table-cell">最近调用</TableHead>
                <TableHead className="hidden whitespace-nowrap md:table-cell">创建时间</TableHead>
                <TableHead className="whitespace-nowrap text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-sm text-muted-foreground">
                    暂无 API Key，点击「创建 API Key」生成
                  </TableCell>
                </TableRow>
              ) : (
                items.map((k) => {
                  const status = keyStatus(k);
                  const isRevealed = !!revealed[k.id];
                  const expired = !!k.expires_at && new Date(k.expires_at).getTime() <= Date.now();
                  // 归属账号 / 密钥 / 状态：桌面端各占一列，手机端折到应用名称下方（各只写一份）
                  const accountCell = (
                    <span className="inline-flex flex-wrap items-center gap-1 text-xs text-foreground">
                      <UserCheck className="h-3 w-3 shrink-0 text-primary" />
                      {accountLabel(k.owner_id)}
                      {k.scope === 'all' && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] h-4 px-1.5 border-0 bg-accent/15 text-accent"
                          title="数据范围：全部账号 —— 「订阅入库通知」接口可用该密钥查询所有账号的入库记录"
                        >
                          全部账号
                        </Badge>
                      )}
                    </span>
                  );
                  const keyLine = (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="break-all font-mono text-xs text-foreground">
                        {isRevealed ? k.api_key : maskKey(k.api_key)}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                        title={isRevealed ? '隐藏' : '显示完整密钥'}
                        onClick={() => setRevealed((prev) => ({ ...prev, [k.id]: !isRevealed }))}
                      >
                        {isRevealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="复制密钥"
                        onClick={() => handleCopy(k)}
                      >
                        {copiedId === k.id
                          ? <CheckCheck className="h-3 w-3 text-secondary" />
                          : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                  );
                  const statusBadge = (
                    <Badge variant="secondary" className={`text-[10px] border-0 ${status.className}`}>
                      {status.label}
                    </Badge>
                  );
                  return (
                    <TableRow key={k.id}>
                      <TableCell className="break-words md:whitespace-nowrap">
                        <div className="font-medium text-foreground">{k.name}</div>
                        {k.remark && (
                          <div className="text-[11px] text-muted-foreground break-words md:max-w-[14rem] md:truncate" title={k.remark}>
                            {k.remark}
                          </div>
                        )}
                        <div className="text-[11px] text-muted-foreground">
                          有效期：{k.expires_at ? fmtDate(k.expires_at) : '永久'}
                        </div>
                        {/* 手机端：归属账号/密钥/状态/调用次数/最近调用/创建时间折到应用名称下方，避免表格横向溢出 */}
                        <div className="mt-1.5 space-y-1 md:hidden">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            {accountCell}
                            {statusBadge}
                            <span>调用 {k.call_count} 次</span>
                            <span>
                              {k.last_used_at ? `最近 ${fmtDate(k.last_used_at)}` : '从未调用'}
                              {k.last_ip ? ` · IP ${k.last_ip}` : ''}
                            </span>
                            <span>创建 {fmtDate(k.created_at)}</span>
                          </div>
                          {keyLine}
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        {accountCell}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        {keyLine}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        {statusBadge}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                        {k.call_count}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                        {k.last_used_at ? fmtDate(k.last_used_at) : '从未调用'}
                        {k.last_ip && <div className="text-[10px]">IP：{k.last_ip}</div>}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                        {fmtDate(k.created_at)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === k.id || expired}
                            title={expired ? '已过期，无需停用' : undefined}
                            className={`h-7 text-xs hover:bg-muted gap-1 ${
                              k.is_active
                                ? 'text-muted-foreground hover:text-destructive'
                                : 'text-secondary hover:text-secondary'
                            }`}
                            onClick={() => handleToggleActive(k)}
                          >
                            {busyId === k.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : k.is_active ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                            {k.is_active ? '停用' : '启用'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted gap-1"
                            onClick={() => setDeleteTarget(k)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />删除
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

      {/* 开放接口文档（单页平铺展示） */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center gap-2 flex-wrap">
          <BookOpen className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">开放接口文档</h3>
          <span className="text-[11px] text-muted-foreground">
            1–7 为读取接口（GET · X-API-Key · 无需登录 · 仅返回归属账号资源）；第 8 节为批量发帖写入接口（POST · 登录态 JWT · 需批量发帖权限）
          </span>
          <Badge variant="secondary" className="text-[10px] h-5 bg-accent/15 text-accent border-0">数据实时</Badge>
        </div>

        <div className="mt-3">
          {/* 1. 接口地址与鉴权 */}
          <DocSection title="1. 接口地址与鉴权">
            <CodeBlock
              code={`# 接口基地址
${RESOURCE_API_BASE}

# 鉴权方式 1：请求头（推荐）
X-API-Key: ${sampleKey}

# 鉴权方式 2：URL 参数（便于浏览器直接打开）
?key=${sampleKey}`}
            />
            <p className="text-[11px] text-muted-foreground">
              密钥停用或到期后立即失效；密钥丢失时删除重建即可，调用次数与来源 IP 会在上面的列表中统计。
            </p>
            <p className="text-[11px] text-muted-foreground">
              另一种鉴权：客户端插件可以让用户用<b className="text-foreground">自己的账号登录</b>，拿到的
              <code className="font-mono"> access_token</code> 用
              <code className="font-mono"> Authorization: Bearer …</code> 调用 —— 只返回该用户自己的订阅入库通知，
              只能调 <code className="font-mono">/subscriptions</code> 与 <code className="font-mono">/me</code>
              （详见下方 5.2）。
            </p>
          </DocSection>

          {/* 2. 数据范围 */}
          <DocSection
            title="2. 数据范围（账号隔离）"
            desc="每个密钥绑定一个归属账号，接口只返回该账号自己名下的资源，无法查询其他账号的数据。"
          >
            <ul className="text-[11px] text-muted-foreground space-y-1 list-disc pl-4">
              <li>归属账号在创建密钥时指定，可随时在上方列表中查看；密钥的返回结果 = 该账号在「资源管理」中能看到的资源。</li>
              <li><code className="font-mono">/stats</code> 统计的也是该账号自己的数量，不是全站数量。</li>
              <li>账号被删除时，其名下的密钥会自动失效；密钥本身没有跨账号查询的权限开关。</li>
            </ul>
          </DocSection>

          {/* 3. 数据实时性 */}
          <DocSection
            title="3. 数据实时性"
            desc="接口直接读取当前数据库，不做缓存，任何时刻调用都返回最新数据。"
          >
            <ul className="text-[11px] text-muted-foreground space-y-1 list-disc pl-4">
              <li>在「资源管理」中新增资源、修改名称 / 集数 / 链接、标记完结后，<b className="text-foreground">下一次调用即可查到最新结果</b>，无需等待刷新或同步。</li>
              <li>每条资源的 <code className="font-mono">updated_at</code> 为该资源最后更新时间，<code className="font-mono">last_changed_at</code> 为最近一次修改记录时间（含修改字段名）。</li>
              <li>做增量拉取时用 <code className="font-mono">since</code> 参数，例如 <code className="font-mono">since=1h</code>、<code className="font-mono">since=7d</code>，只取这段时间内更新过的资源。</li>
              <li>响应中的 <code className="font-mono">generated_at</code> 为本次查询的服务端时间，便于对齐时序。</li>
            </ul>
          </DocSection>

          {/* 4. 接口一览 */}
          <DocSection title="4. 接口一览">
            <DocTable
              head={['路径', '说明']}
              rows={[
                ['/resource-api/updated', '本账号更新中（已更新）的资源，附带最近一次更新记录'],
                ['/resource-api/finished', '本账号已完结的资源'],
                ['/resource-api/resources', '本账号资源列表，范围由 type=all|updated|finished 决定'],
                ['/resource-api/stats', '本账号汇总统计：全部 / 更新中 / 已完结 数量与最近更新时间'],
                ['/resource-api/subscriptions', '订阅入库通知：本账号「订阅转存成功」的入库明细，format=text 直接给出可发群的通知文案（别名 /imported）'],
                ['/resource-api/me', '当前密钥与归属账号信息，用于自检'],
              ]}
            />
          </DocSection>

          {/* 5. 请求参数 */}
          <DocSection title="5. 请求参数">
            <DocTable
              head={['参数', '可选值 / 示例', '说明']}
              rows={[
                ['type', 'all / updated / finished', '资源范围，默认 all（/updated、/finished 路径已隐含该值）'],
                ['page', '1', '页码，默认 1'],
                ['page_size', '20', '每页条数，默认 20，最大 200'],
                ['keyword', '庆余年', '按资源名称模糊搜索（仅在本账号资源内搜索）'],
                ['since', '1h / 7d / 2026-09-01', '只返回更新时间在该时间之后的资源，支持 7d、12h、30m'],
                ['include_finished', '1', '【资源列表专用】配合 since 做增量拉取：把这段时间内「刚变为已完结」的资源也一并返回（默认不返回 —— 资源一移入已完结就离开 type=updated，只按 updated 轮询会看不到这次完结）'],
                ['link_status', 'valid / invalid / partial / unknown', '按网盘链接可用性过滤'],
                ['format', 'json / text', 'text 为可直接粘贴分享的纯文本清单（加 &download=1 直接下载文件）'],
                ['limit', '50', '【订阅入库 /subscriptions 专用】最多返回多少条入库文件，默认 50，最大 500'],
                ['before', '2026-10-04T05:37:32.903327Z', '【订阅入库专用】翻页游标：原样回传上一次响应里的 next_before，直到 has_more=false（一条不漏）'],
                ['hint', '1', '【订阅入库专用】format=text 时，若结果被截断则在文案末尾补一行提示（默认不补）'],
                ['subscription', '牧神记', '【订阅入库专用】按订阅名模糊过滤'],
                ['pan', 'guangya / quark', '【订阅入库专用】按网盘过滤'],
                ['account', 'gesanqiu', '【订阅入库专用】只看某个账号（用户名或用户 ID）。仅「数据范围=全部账号」的密钥可用；不传则查所有账号'],
              ]}
            />
          </DocSection>

          {/* 5.1 订阅入库通知 */}
          <DocSection
            title="5.1 订阅入库通知（/subscriptions）"
            desc="每次「订阅转存」把文件成功存进你的网盘后，这里就能查到——用于做「有新集入库」的提醒。"
          >
            <ul className="text-[11px] text-muted-foreground space-y-1 list-disc pl-4">
              <li>
                <b className="text-foreground">推荐用「增量游标」，不要用时间窗</b>：把响应里的{' '}
                <code className="font-mono">next_after</code> 存下来（本地文件 / 数据库皆可），
                下次带 <code className="font-mono">after=&lt;它&gt;</code> 再拉 —— 只返回「比它更新」的入库记录
                （按时间升序、整批不会被切半），<b className="text-foreground">无论隔多久都不会漏</b>；
                而 <code className="font-mono">since=10m</code> 这类时间窗只要漏拉一次就<b>永久错过</b>。
                text 模式下同一信息在响应头 <code className="font-mono">X-Next-After</code>。
              </li>
              <li>
                返回结构：<code className="font-mono">items</code>（每个入库文件一条：订阅名 / 网盘 / 目标目录 / 文件名 /
                集号 / 入库时间）、<code className="font-mono">groups</code>（按订阅聚合，含{' '}
                <code className="font-mono">marks</code> 集号列表与 <code className="font-mono">count</code>）、
                <code className="font-mono">text</code>（已排好版的通知文案）。
              </li>
              <li>
                <code className="font-mono">format=text</code> 直接返回文案本身，每行一条订阅，形如：
                <br />
                <code className="font-mono">
                  牧神记 更新 S01E103 已入库（光鸭云盘 → 日-更/牧-神记） · 10-04 04:26
                </code>
                <br />
                同一订阅多条时合并成一行（集号按集数升序，超过 6 个折叠为「等 N 个文件」）；
                <b className="text-foreground">没有新入库时返回空内容</b>，脚本据此判断是否要发消息，避免空推。
              </li>
              <li>
                <b className="text-foreground">完结也会推送</b>：订阅填了「全集数」并同步到位时判定完结
                （资源名改成「… 已完结全N集」并移入「已完结」）。完结那一轮可能<b>一个文件都没转存</b>，
                所以完结不在 <code className="font-mono">items</code> / <code className="font-mono">groups</code> 里，
                而是单独给出：JSON 的 <code className="font-mono">finished</code> 数组 +{' '}
                <code className="font-mono">finished_count</code>（字段：subscription / display_name / status=已完结 /
                total_episodes / finished_at / delete_at），<code className="font-mono">text</code> 里多出一行：
                <br />
                <code className="font-mono">
                  余红旧事 已完结全34集 已完结（光鸭云盘 → 日-更/余-红旧事.2026） · 10-06 12:41（订阅将于 10-06 13:41 自动删除）
                </code>
                <br />
                每条完结事件<b className="text-foreground">只推送一次</b>（推过就不再出现，避免刷屏）；到期删除订阅时，
                同账号同一部剧的其它网盘订阅会一起删除。
              </li>
              <li>
                增量拉取用 <code className="font-mono">since</code>（如 <code className="font-mono">since=10m</code>、
                <code className="font-mono">since=1d</code>）：每隔几分钟拉一次，把拿到的 <code className="font-mono">text</code>
                直接发到群里即可；也可以只用 <code className="font-mono">groups</code> 里的字段自己排版。
              </li>
              <li>
                <b className="text-foreground">别用「宽时间窗 + 默认条数」</b>：结果按入库时间倒序取，最多{' '}
                <code className="font-mono">limit</code> 条（默认 50、最大 500），所以一定会被截断
                （例：<code className="font-mono">since=1d</code> 时本账号有 286 条，默认只回最新 50 条，更早的静默丢失）。
                响应里给了 <code className="font-mono">has_more</code> / <code className="font-mono">truncated</code>
                （是否还有更早的没返回）、<code className="font-mono">next_before</code>（下一页游标）、
                <code className="font-mono">oldest_at</code>；带上{' '}
                <code className="font-mono">before=&lt;上次的 next_before&gt;</code> 再请求一次，直到{' '}
                <code className="font-mono">has_more=false</code>，即一条不漏。同一时间入库的一整批文件不会被切到两页，
                因此单页条数可能略多于 <code className="font-mono">limit</code>。
              </li>
              <li>
                <code className="font-mono">format=text</code> 时没有 JSON 可读，同样的标记放在响应头：
                <code className="font-mono">X-Has-More</code> / <code className="font-mono">X-Next-Before</code> /{' '}
                <code className="font-mono">X-Oldest-At</code>；也可以加 <code className="font-mono">hint=1</code>，
                让「已被截断」的提示直接写进文案末尾。翻页时 <code className="font-mono">since</code> 建议传固定时间戳
                （如 <code className="font-mono">2026-10-04T00:00:00Z</code>）而不是 <code className="font-mono">24h</code>{' '}
                这类相对值 —— 相对值每次请求都会重新计算，窗口下沿会随时间漂移。
              </li>
              <li>
                只统计「文件已成功转存进网盘」的记录（含未开启资源联动的订阅）；失败 / 跳过的条目不会出现在这里。
              </li>
              <li>
                <b className="text-foreground">谁能调用</b>：任何账号的密钥都能调用（只返回它自己的入库记录）；
                若在创建密钥时把「数据范围」设为<b className="text-foreground">全部账号</b>，这一把密钥即可查询
                <b className="text-foreground">所有账号</b>的入库记录（适合管理员做统一通知），响应里每条记录带
                <code className="font-mono">account</code>，也可用 <code className="font-mono">account=用户名</code> 只看某一个账号。
              </li>
            </ul>
          </DocSection>

          {/* 5.2 客户端插件：用户登录态 */}
          <DocSection
            title="5.2 客户端插件：用户登录后提示「订阅更新已入库」"
            desc="插件里让用户用他自己的账号登录，拿 access_token 调通知接口 —— 只会返回他本人的入库记录，不用给每个用户发密钥。"
          >
            <CodeBlock
              code={`const AUTH = '${import.meta.env.VITE_SUPABASE_URL}/auth/v1';

// ① 用户登录：换 access_token（邮箱 = 用户名 + ${ACCOUNT_EMAIL_SUFFIX}）
//    refresh_token 一定要存下来（插件本地保存），用它长期免登录
async function login(username, password) {
  const r = await fetch(AUTH + '/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: '${ANON_KEY}', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: username + '${ACCOUNT_EMAIL_SUFFIX}', password }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.msg || '账号或密码错误');
  return { access_token: j.access_token, refresh_token: j.refresh_token };
}

// ② access_token 有效期 7 天（平台上限）→ 用 refresh_token 续期，用户无需重新登录
async function refresh(session) {
  const r = await fetch(AUTH + '/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: '${ANON_KEY}', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const j = await r.json();
  if (!j.access_token) return null;                 // 续期也失败 → 让用户重新输入账号密码
  return { access_token: j.access_token, refresh_token: j.refresh_token || session.refresh_token };
}

// ③ 拉「我自己的」订阅入库通知（只返回本人账号的记录）；建议每 5 分钟一次
//    增量游标：把上次的 next_after（响应头 X-Next-After）存本地，下次带 after= 来 ——
//    漏拉 / 停机多久都不会丢；首次运行为空 = 只从"这次之后"的新入库开始。
let cursor = localStorage.getItem('subCursor') || '';
async function poll(session) {
  const url = '${RESOURCE_API_BASE}/subscriptions?format=text&limit=200'
    + (cursor ? '&after=' + encodeURIComponent(cursor) : '');
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + session.access_token },
  });
  if (res.status === 401) return await refresh(session);   // 续期，下一轮再拉
  const text = (await res.text()).trim();
  if (text) notify(text);                                  // 弹通知 / 托盘提示：「订阅更新已入库」
  // 无论如何都保存游标：has_more 时下一轮会继续往后拿，不会漏
  const next = res.headers.get('X-Next-After');
  if (next && next !== cursor) { cursor = next; localStorage.setItem('subCursor', cursor); }
  return session;
}
// 返回示例：一念永恒 更新 S01E01、S01E02 已入库（夸克云盘 → 影视/日更/一念永恒 完结季） · 10-04 05:00`}
            />
            <ul className="text-[11px] text-muted-foreground space-y-1 list-disc pl-4 mt-2">
              <li>
                只返回<b className="text-foreground">该登录用户自己账号</b>的入库记录：传{' '}
                <code className="font-mono">account=</code> 会被 403 拒绝，看不到别人的。
              </li>
              <li>
                用户登录态只能调 <code className="font-mono">/subscriptions</code>、
                <code className="font-mono">/imported</code>、<code className="font-mono">/me</code>；
                资源类接口仍需 API Key。
              </li>
              <li>
                <code className="font-mono">since</code> 用「上次拉取时间」或 <code className="font-mono">10m</code>{' '}
                这类相对时间即可做增量；<b className="text-foreground">没有新入库时返回空内容</b>，据此决定要不要提示。
              </li>
              <li>
                access_token 有效期已调到 <b className="text-foreground">7 天</b>（Supabase 平台上限 604800 秒，
                不能再长）；插件存好 <code className="font-mono">refresh_token</code> 就能长期免登录 ——
                只有用户主动退出或改密码才会失效。密码不经过本系统，由 Supabase Auth 直接校验。
              </li>
            </ul>
          </DocSection>

          {/* 6. 调用示例（整块复制一次即可） */}
          <DocSection title="6. 调用示例" desc="以下示例可直接整块复制，把示例密钥换成你自己的 Key 即可运行。">
            <CodeBlock
              code={`# ── 1) 自检：查看密钥归属账号、有效期与累计调用 ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/me"

# ── 2) 已完结资源（JSON，默认第 1 页 20 条） ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/finished"

# ── 3) 更新中的资源（近 1 小时有改动，可用于实时监控） ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/updated?since=1h"

# ── 4) 汇总统计（本账号：全部 / 更新中 / 已完结） ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/stats"

# ── 5) 纯文本清单（可直接粘贴分享；加 &download=1 直接下载 .txt） ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/finished?format=text"

# ── 6) JavaScript（Node / 浏览器） ──
const res = await fetch('${RESOURCE_API_BASE}/updated?page=1&page_size=20', {
  headers: { 'X-API-Key': '${sampleKey}' },
});
const json = await res.json();
if (json.code !== 0) throw new Error(json.message);
console.log('账号：', json.data.account.name, '总数：', json.data.pagination.total);
for (const item of json.data.list) {
  console.log(item.status, item.name, item.episode_count, item.link);
}

# ── 7) 浏览器直接打开（无需写代码） ──
${RESOURCE_API_BASE}/finished?key=${sampleKey}&format=text

# ── 8) 订阅入库通知：最近 1 小时新入库的文案（每行一条，可直接发群） ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/subscriptions?since=1h&format=text"

# ── 9) 订阅入库明细（JSON：items 逐文件 / groups 按订阅聚合） ──
curl -H "X-API-Key: ${sampleKey}" \\
  "${RESOURCE_API_BASE}/subscriptions?since=1d&limit=100"

# ── 10) 定时轮询示例（每 5 分钟拉一次，有内容就推送到群里） ──
# 注：text 模式没有新入库时返回空串，直接判断非空再发送即可；
#     窗口窄（10m）一般不会截断；若响应头 X-Has-More=1，就带 X-Next-Before 再拉一页，一条不漏。
async function pollOnce() {
  let before = '';
  for (let page = 0; page < 20; page++) {
    const url = '${RESOURCE_API_BASE}/subscriptions?since=10m&format=text'
      + (before ? '&before=' + encodeURIComponent(before) : '');
    const res = await fetch(url, { headers: { 'X-API-Key': '${sampleKey}' } });
    const text = (await res.text()).trim();
    if (text) await pushToGroup(text);                // 换成你自己的推送（企业微信/飞书/Bark…）
    if (res.headers.get('X-Has-More') !== '1') break;
    before = res.headers.get('X-Next-Before') || '';
    if (!before) break;
  }
}
pollOnce();`}
            />
          </DocSection>

          {/* 7. 返回结构与错误码 */}
          <DocSection title="7. 返回结构与错误码">
            <CodeBlock
              code={`{
  "code": 0,
  "message": "ok",
  "data": {
    "account": { "id": "4b7d...", "name": "gesanqiu" },   // 密钥归属账号
    "scope": "finished",
    "scope_label": "已完结资源",
    "pagination": { "total": 12, "page": 1, "page_size": 20, "total_pages": 1, "has_more": false },
    "filters": { "keyword": null, "since": null, "link_status": null },
    "generated_at": "2026-09-27T15:03:36.131Z",
    "list": [
      {
        "id": "b1f2...",
        "name": "示例剧集",
        "status": "已完结",              // 更新中 / 已完结
        "is_finished": true,
        "episode_count": 24,
        "owner": "gesanqiu",
        "cover_url": "https://.../cover.jpg",
        "link": "https://pan.quark.cn/s/xxxx",
        "links": [                       // 多盘链接（含网盘名称与可用性）
          { "url": "https://pan.quark.cn/s/xxxx", "pan_name": "夸克网盘", "status": "valid" }
        ],
        "link_status": "valid",
        "created_at": "2026-08-01T02:10:00.000Z",
        "updated_at": "2026-09-27T12:00:00.000Z",
        "last_changed_at": "2026-09-27T12:00:00.000Z",  // 最近一次修改记录
        "last_changed_field": "集数"
      }
    ]
  }
}`}
            />
            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground">
                出错时 <code className="font-mono">code</code> 为 HTTP 状态码：401 密钥缺失 / 无效、403 密钥已停用 / 过期 / 未绑定账号、
                400 参数错误、404 路径不存在、405 非 GET 请求、500 服务异常，同时返回
                <code className="font-mono"> message</code> 说明具体原因。
              </p>
            </div>
          </DocSection>

          {/* 8. 批量发帖接口（自动发帖 · 短链开关） */}
          <DocSection
            title="8. 批量发帖接口（自动发帖 · 短链开关）"
            desc="给「自动发帖脚本 / 第三方程序」用的写入接口：POST + 本系统登录态 JWT（不是 X-API-Key），调用方需已开通批量发帖权限。"
          >
            <CodeBlock
              code={`# ── 接口地址（POST · JSON）──
${BATCH_POST_API_BASE}

# ── 鉴权：本系统账号的 access_token（不是 X-API-Key）──
Authorization: Bearer <access_token>

# ── 请求体 ──
{
  "site": "xnsite",           // 目标站点，见下方清单
  "payload": { ...该站点发帖接口的原始字段... },
  "useShortLink": false        // 可选：是否把正文里的网盘链接换成短链
}

# ── 支持批量发帖的站点（site）──
xnsite      观影站点
ya          鸭影臻藏
framehdr    帧影站点
mukaku      不太灵站点
jying       聚影站点`}
            />

            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16 md:w-40">useShortLink</TableHead>
                    <TableHead>行为</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-mono text-[11px]">true</TableCell>
                    <TableCell className="text-[11px]">
                      发帖正文里的网盘链接换成<b className="text-foreground">该链接自己的短链</b>
                      （光鸭短码带前缀 <code className="font-mono">g…</code>、夸克带 <code className="font-mono">q…</code>，一眼可区分）
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-mono text-[11px]">false</TableCell>
                    <TableCell className="text-[11px]">
                      <b className="text-foreground">完全按原样推送原始网盘链接</b>（不开启短链时用这个）
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-mono text-[11px]">不传</TableCell>
                    <TableCell className="text-[11px]">
                      按账号默认：<b className="text-foreground">管理员开、其它账号关</b>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <CodeBlock
              code={`# ── 1) 用账号密码换取 access_token（每个用户各自的账号）──
curl -X POST "${import.meta.env.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password" \\
  -H "apikey: ${ANON_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"用户名@账号邮箱后缀","password":"账号密码"}'
# 从返回里取 access_token

# ── 2) 发帖：不开短链（原始网盘链接）──
curl -X POST "${BATCH_POST_API_BASE}" \\
  -H "Authorization: Bearer <access_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"site":"xnsite","payload":{"...":"..."},"useShortLink":false}'

# ── 3) 发帖：开短链（正文换成短链，短链按调用账号隔离）──
curl -X POST "${BATCH_POST_API_BASE}" \\
  -H "Authorization: Bearer <access_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"site":"xnsite","payload":{"...":"..."},"useShortLink":true}'

# ── 4) JavaScript（Node / 浏览器）──
const res = await fetch('${BATCH_POST_API_BASE}', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({ site: 'xnsite', payload: { /* ... */ }, useShortLink: true }),
});
const json = await res.json();   // 原样返回站点响应；失败时 success=false + message
console.log(json.success, json.message);`}
            />

            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                ① 开关字段也接受别名 <code className="font-mono">shortLink</code> /
                <code className="font-mono"> use_short_link</code>。<br />
                ② 短链<b className="text-foreground">只替换「发给站点的正文」</b>：本应用资源库与站点绑定关系
                <b className="text-foreground">始终保存原始网盘链接</b>，后续增量同步不受影响。<br />
                ③ 短链生成失败会<b className="text-foreground">自动回退为原链</b>，不会让发帖失败；
                短链按<b className="text-foreground">调用账号</b>创建（同账号同链接复用，不跨账号）。<br />
                ④ 错误码：<code className="font-mono">401</code> 未登录 / token 失效、
                <code className="font-mono">403</code>（<code className="font-mono">code=BATCH_POST_FORBIDDEN</code>）无批量发帖权限或已到期、
                <code className="font-mono">400</code> 站点不支持或缺少 payload、
                <code className="font-mono">504</code> 站点响应超时（可直接重试）。
              </p>
            </div>
          </DocSection>

          {/* 9. 短链接口（X-API-Key，只做短链、不发帖） */}
          <DocSection
            title="9. 短链接口（X-API-Key，短链按账号隔离）"
            desc="只想把网盘链接换成短链、不需要发帖能力时用它：与资源接口共用同一把密钥（X-API-Key），无需登录态 JWT。"
          >
            <CodeBlock
              code={`# ── 接口地址（POST · JSON）──
${SHORTLINK_API_BASE}

# ── 鉴权：与资源接口同一把密钥 ──
X-API-Key: ${sampleKey}

# ── 1) 自检：归属账号 / 是否开通短链 / 已有短链数 ──
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/me"

# ── 2) 一条网盘链接换短链（默认沿用原链接路径；同账号同链接自动复用）──
curl -X POST "${SHORTLINK_API_BASE}" \\
  -H "X-API-Key: ${sampleKey}" -H "Content-Type: application/json" \\
  -d '{"url":"https://www.guangyapan.com/s/1956421372229992464_aeZIFqDoqz15G-J_","channel":"群推送-光鸭云盘"}'
# → data.items[0].short_url = https://guangya.xyz.hr/s/1956421372229992464_aeZIFqDoqz15G-J_
#   渠道只存进短链行（点击照样按渠道统计），URL 上不带 ?c=，分享出去最短

# ── 3) 直接把整段正文推过来：只替换里面的网盘链接，其余一个字不动 ──
curl -X POST "${SHORTLINK_API_BASE}" \\
  -H "X-API-Key: ${sampleKey}" -H "Content-Type: application/json" \\
  -d '{"text":"剧名：某某剧\\n链接：https://www.guangyapan.com/s/xxxx\\n提取码：abcd"}'
# → data.text 为替换后的正文，data.replaced 为替换条数

# ── 4) 多条链接一次推 / 改用随机短码 ──
curl -X POST "${SHORTLINK_API_BASE}" \\
  -H "X-API-Key: ${sampleKey}" -H "Content-Type: application/json" \\
  -d '{"urls":["https://pan.quark.cn/s/aaa","https://www.guangyapan.com/s/bbb"],"mode":"short"}'

# ── 5) 按「资源」查短链（新增资源已自动生成短链，这里按资源查/补齐）──
#   · 资源新增或更新（links / 名称）时，系统会**自动**为资源所有者的账号生成短链；
#     本接口返回的是**调用方账号**名下的短链（缺失即补生成）—— 谁调用，点击就算谁的。
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/resource?id=<资源ID>"
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/resource?name=择日飞升&finished=0&limit=5"
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/resource?since=2026-10-16T00:00:00Z"   # 增量拉取
# → data.items[].links[] = { pan, url, code, short_url, reused }
#   scope=admin（默认，资源主的资源）/ self（本账号自己的资源）/ all（两者并集）
#   ensure=false 时只查不补（没有短链的会带 note 提示）

# 单个网盘链接也可以直接补/查（不查资源表）：
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/resource?url=https://www.guangyapan.com/s/xxxx"

# ── 6) 本账号短链列表（keyword 按标题 / 链接 / 短码搜；仅资源来源的用 only_resource=1）──
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/list?limit=20&keyword=某某剧"
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/list?only_resource=1&limit=50"
curl -H "X-API-Key: ${sampleKey}" "${SHORTLINK_API_BASE}/list?resource_id=<资源ID>"`}
            />

            <DocTable
              head={['字段', '说明']}
              rows={[
                ['url / urls / text', '三种输入，至少给一个：单条链接 / 多条链接数组 / 整段正文（正文只替换其中的网盘链接）'],
                ['mode', 'path（默认）沿用原链接路径，分享出去只有域名不同；short 用随机短码'],
                ['prefix', '自定义短码前缀（1~4 位小写字母 / 数字），默认按网盘取 g（光鸭）/ q（夸克）/ x'],
                ['title / channel / resource_id / extract_code / pan_name', '短链标题、渠道标记（存进短链行，点击统计自动区分渠道）、关联资源、提取码、网盘名'],
                ['channel_in_url', '默认 false：渠道不写进 URL（短链最短）；true 才拼成 ?c=<渠道>（中文渠道名会被 URL 编码，链接会变长）'],
                ['expires_at', '到期时间：2026-12-31 / 7d / 12h / 30m（到期后访问返回 410）'],
                ['reuse', '默认 true：同账号同目标已有短链直接复用；显式 false 则每次都新建一条'],
                ['/resource 的参数', 'id（资源 ID）/ name（名称模糊）/ url（只看这一条链接）/ since（按资源更新时间增量）/ finished（0 更新中、1 已完结、留空全部）/ scope / ensure / limit / offset'],
                ['/list 的过滤', 'keyword / resource_id / only_resource / since，配合 limit + offset 分页'],
              ]}
            />

            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                ① 短链属于<b className="text-foreground">调用方账号</b>（同账号同链接复用，不跨账号），
                只有开通「短链管理」的账号可用；<b className="text-foreground">资源自动生成的短链归资源所有者</b>。<br />
                ② 与「批量发帖」的分工：本接口<b className="text-foreground">不发帖</b>，也<b className="text-foreground">不接受 X-API-Key 发帖</b> ——
                发帖仍只走上面的 batch-post（登录态 JWT + 批量发帖权限）。<br />
                ③ 错误码：<code className="font-mono">401</code> 缺少 / 无效密钥、
                <code className="font-mono">403</code> 密钥停用或归属账号未开通短链、
                <code className="font-mono">400</code> 参数错误（如不是 http(s):// 链接）、
                <code className="font-mono">429</code> 调用过于频繁。
              </p>
            </div>
          </DocSection>
        </div>
      </div>

      {/* 新建密钥弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>创建 API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">应用名称</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：自动发帖脚本 / 数据看板"
                className="h-9 bg-input border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">归属账号</Label>
              <Select value={ownerId} onValueChange={setOwnerId}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue placeholder="选择该密钥对应的账号" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.username || a.email || '未命名用户'}
                      {a.id === profile?.id ? '（我）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                资源类接口只返回该账号自己名下的资源，例如给某个用户的开发需求创建密钥，就选他本人。
                订阅通知不需要给每个用户建密钥 —— 插件里让用户用他自己的账号登录即可（见下方文档 5.2），
                这里创建的密钥是给「第三方程序 / 统一通知服务」这类不登录本系统的调用方用的。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">数据范围</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as 'owner' | 'all')}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">仅归属账号（默认）</SelectItem>
                  <SelectItem value="all">全部账号（订阅入库通知）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {scope === 'all'
                  ? '「订阅入库通知」接口（/subscriptions）可用这一把密钥查询所有账号的入库记录，也能用 account=用户名 只看某一个账号；资源类接口仍只返回归属账号的数据。'
                  : '所有接口都只看归属账号自己的数据；如果需要「一个密钥查所有账号的订阅入库通知」，请选「全部账号」。'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">备注（可选）</Label>
              <Textarea
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="使用人、用途等信息，便于后续排查"
                className="min-h-16 resize-y text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">有效期</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {expiry === 'custom' && (
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">到期时间</Label>
                <Input
                  type="datetime-local"
                  value={customExpiresAt}
                  onChange={(e) => setCustomExpiresAt(e.target.value)}
                  className="h-9 bg-input border-border"
                />
                <p className="text-[11px] text-muted-foreground">按本地时间设置，到期后接口将拒绝该密钥。</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              取消
            </Button>
            <Button onClick={handleCreate} disabled={creating} className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              生成密钥
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>删除 API Key？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」（归属：{deleteTarget ? accountLabel(deleteTarget.owner_id) : ''}）
              的密钥删除后将立即失效且无法恢复，正在使用该密钥的调用方会报 401 错误。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
