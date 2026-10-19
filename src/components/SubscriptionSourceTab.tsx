import { useEffect, useState } from 'react';
import {
  Link2, Plus, Trash2, Loader2, PencilLine, Eye, EyeOff, AlertCircle, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { extractPasscodeFromUrl } from '@/lib/panUtils';
import {
  fetchSubscriptionSources,
  createSubscriptionSource,
  updateSubscriptionSource,
  deleteSubscriptionSource,
} from '@/services/api';
import type { SubscriptionSource, SubscriptionSourceInput } from '@/types/index';

/** 源地址是不是网盘分享链接（是的话自动对齐目标网盘） */
function detectSharePan(url: string): 'guangya' | 'quark' | 'baidu' | 'xunlei' | 'uc' | 'p123' | null {
  const u = url.trim();
  if (/guangyapan\.com\/s\//i.test(u)) return 'guangya';
  // UC 必须先判：分享链接同样是 /s/xxx，但域名是 drive.uc.cn
  if (/(drive\.uc\.cn|pc-api\.uc\.cn)\/s\//i.test(u)) return 'uc';
  // 123 云盘：分享链接是动态子域 <分享号>.share.123pan.cn/<分享路径>
  if (/(share\.123pan\.cn|123pan\.com|123865\.com|123684\.com|123912\.com)\//i.test(u)) return 'p123';
  if (/pan\.quark\.cn\/s\//i.test(u)) return 'quark';
  if (/(pan\.baidu\.com|yun\.baidu\.com)\/s\//i.test(u)) return 'baidu';
  if (/pan\.xunlei\.com\/s\//i.test(u)) return 'xunlei';
  return null;
}

/** 网盘短名（列表里的标签） */
const PAN_TAG_LABELS: Record<'guangya' | 'quark' | 'baidu' | 'xunlei' | 'uc' | 'p123', string> = {
  guangya: '光鸭',
  quark: '夸克',
  baidu: '百度',
  xunlei: '迅雷',
  uc: 'UC',
  p123: '123云盘',
};

const EMPTY_DRAFT: SubscriptionSourceInput = {
  name: '',
  note: null,
  source_url: '',
  source_type: 'auto',
  source_passcode: null,
  keyword: null,
  pan: 'guangya',
  clean_mode: 'episode',
  interval_minutes: 30,
  is_active: true,
  sort_order: 0,
};

/**
 * 后台「订阅源」管理：管理员维护允许被订阅的源地址。
 * 用「特殊邀请码」注册的受限账号只能从这里选订阅链接（后端也会硬校验，不能绕过）。
 */
export default function SubscriptionSourceTab() {
  const [items, setItems] = useState<SubscriptionSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SubscriptionSourceInput>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SubscriptionSource | null>(null);

  async function load() {
    setLoading(true);
    try {
      setItems(await fetchSubscriptionSources(true));
    } catch (e) {
      toast.error((e as Error).message || '加载订阅源失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  }

  function openEdit(item: SubscriptionSource) {
    setEditingId(item.id);
    setDraft({
      name: item.name,
      note: item.note,
      source_url: item.source_url,
      source_type: item.source_type,
      source_passcode: item.source_passcode,
      keyword: item.keyword,
      pan: item.pan,
      clean_mode: item.clean_mode,
      interval_minutes: item.interval_minutes,
      is_active: item.is_active,
      sort_order: item.sort_order,
    });
    setDialogOpen(true);
  }

  /** 填了分享链接就自动切到「分享目录监控」并对齐目标网盘，同时带上链接自带的 ?pwd= 提取码 */
  function onUrlChange(v: string) {
    const detected = detectSharePan(v);
    const pwdFromUrl = extractPasscodeFromUrl(v);
    setDraft((d) => ({
      ...d,
      source_url: v,
      ...(detected ? { source_type: 'pan_share' as const, pan: detected } : {}),
      ...(pwdFromUrl ? { source_passcode: pwdFromUrl } : {}),
    }));
  }

  async function handleSave() {
    if (!draft.source_url.trim()) {
      toast.info('请填写订阅源地址');
      return;
    }
    const payload: SubscriptionSourceInput = {
      ...draft,
      name: draft.name.trim() || '未命名订阅源',
      source_url: draft.source_url.trim(),
      note: draft.note?.trim() || null,
      source_passcode: draft.source_passcode?.trim() || null,
      keyword: draft.keyword?.trim() || null,
      interval_minutes: Math.max(1, Math.min(1440, Number(draft.interval_minutes) || 30)),
    };
    setSaving(true);
    try {
      if (editingId) {
        await updateSubscriptionSource(editingId, payload);
        toast.success('订阅源已更新');
      } else {
        await createSubscriptionSource(payload);
        toast.success('订阅源已添加');
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast.error((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(item: SubscriptionSource) {
    try {
      await updateSubscriptionSource(item.id, { is_active: !item.is_active });
      toast.success(item.is_active ? '已停用（受限账号不能再选它）' : '已启用');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '操作失败');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteSubscriptionSource(deleteTarget.id);
      toast.success('订阅源已删除');
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message || '删除失败');
    }
  }

  return (
    <div className="space-y-5">
      {/* 说明 */}
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3">
        <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          这里是「可用订阅源白名单」：用<b className="text-foreground">特殊邀请码</b>注册的受限账号只能从下面
          <b className="text-foreground">已启用</b>的源里选订阅链接，不能自己填任意地址（最多 10 个订阅）。
          普通账号不受影响，仍可自由填写订阅源。
        </p>
      </div>

      {/* 列表 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">订阅源列表</h3>
            {items.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                共 {items.length} 条 / 启用 {items.filter((i) => i.is_active).length} 条
              </Badge>
            )}
          </div>
          <Button size="sm" className="h-8 text-xs gap-1.5" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            新增订阅源
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
            <AlertCircle className="h-7 w-7 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">还没有订阅源，点「新增订阅源」添加</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => (
              <div
                key={item.id}
                className={`rounded-lg border p-3 transition-colors ${
                  item.is_active ? 'border-border bg-background' : 'border-border/50 bg-muted/30 opacity-75'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate">{item.name}</span>
                      <Badge
                        variant="secondary"
                        className={`text-[10px] h-4 px-1.5 border-0 ${
                          item.is_active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {item.is_active ? '启用中' : '已停用'}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 border-0 bg-muted text-muted-foreground">
                        {PAN_TAG_LABELS[item.pan] ?? item.pan}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">每 {item.interval_minutes} 分钟</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-mono mt-1 break-all">{item.source_url}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      提取码：{item.source_passcode || '—'} · 关键字：{item.keyword || '全部'} · 清洗：
                      {item.clean_mode === 'episode' ? '精简为 S01E01' : '不改名'}
                      {item.note ? ` · 说明：${item.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
                      onClick={() => openEdit(item)}
                    >
                      <PencilLine className="h-3 w-3" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-primary gap-1"
                      onClick={() => handleToggle(item)}
                    >
                      {item.is_active ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      {item.is_active ? '停用' : '启用'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive gap-1"
                      onClick={() => setDeleteTarget(item)}
                    >
                      <Trash2 className="h-3 w-3" />
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新增 / 编辑 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-base">{editingId ? '编辑订阅源' : '新增订阅源'}</DialogTitle>
            <DialogDescription className="text-xs">
              受限账号（特殊邀请码注册）会在这个列表里选择订阅链接；填网盘分享链接时会自动按「分享目录监控」运行。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">名称</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="如：某某剧更新页"
                  className="h-9 bg-input border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">目标网盘</Label>
                <Select
                  value={draft.pan}
                  onValueChange={(v) => setDraft({ ...draft, pan: v as 'guangya' | 'quark' | 'baidu' | 'xunlei' | 'uc' | 'p123' })}
                >
                  <SelectTrigger className="h-9 bg-input border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="guangya">光鸭云盘</SelectItem>
                    <SelectItem value="quark">夸克网盘</SelectItem>
                    <SelectItem value="baidu">百度网盘</SelectItem>
                    <SelectItem value="xunlei">迅雷云盘</SelectItem>
                    <SelectItem value="uc">UC网盘</SelectItem>
                    <SelectItem value="p123">123云盘</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">订阅源地址</Label>
              <Input
                value={draft.source_url}
                onChange={(e) => onUrlChange(e.target.value)}
                placeholder="更新页 / RSS 地址，或分享链接（https://www.guangyapan.com/s/xxx）"
                className="h-9 bg-input border-border"
              />
              {detectSharePan(draft.source_url) && (
                <p className="text-[11px] text-primary">
                  检测到{PAN_TAG_LABELS[draft.pan] ?? draft.pan}分享链接：将按「分享目录监控」运行（目标网盘已自动对齐）
                </p>
              )}
              {draft.pan === 'baidu' && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  百度网盘源的订阅用户需要先在「订阅转存 → 网盘账号」里点「授权登录」完成百度授权，否则该源无法转存。
                  分享若带提取码，请填到下面的「提取码」。
                </p>
              )}
              {draft.pan === 'xunlei' && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  迅雷云盘源的订阅用户需要先在「订阅转存 → 网盘账号」里用手机迅雷扫码绑定，否则该源无法转存。
                  分享若带提取码（?pwd=），可填到下面的「提取码」，也可以直接留在链接里自动识别。
                </p>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">源类型</Label>
                <Select
                  value={draft.source_type}
                  onValueChange={(v) => setDraft({ ...draft, source_type: v as SubscriptionSourceInput['source_type'] })}
                >
                  <SelectTrigger className="h-9 bg-input border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自动识别</SelectItem>
                    <SelectItem value="rss">RSS / Atom</SelectItem>
                    <SelectItem value="page">网页更新页</SelectItem>
                    <SelectItem value="pan_share">网盘分享链接</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">提取码</Label>
                <Input
                  value={draft.source_passcode ?? ''}
                  onChange={(e) => setDraft({ ...draft, source_passcode: e.target.value })}
                  placeholder="可空"
                  className="h-9 bg-input border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">检查间隔（分钟）</Label>
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.interval_minutes}
                  onChange={(e) => setDraft({ ...draft, interval_minutes: Number(e.target.value) })}
                  className="h-9 bg-input border-border"
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">关键字过滤</Label>
                <Input
                  value={draft.keyword ?? ''}
                  onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
                  placeholder="可空；多个用 | 分隔"
                  className="h-9 bg-input border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">文件名清洗</Label>
                <Select
                  value={draft.clean_mode}
                  onValueChange={(v) => setDraft({ ...draft, clean_mode: v as 'none' | 'episode' })}
                >
                  <SelectTrigger className="h-9 bg-input border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="episode">精简为 S01E01 形式（推荐）</SelectItem>
                    <SelectItem value="none">不处理文件名</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">说明（可选）</Label>
              <Textarea
                value={draft.note ?? ''}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                placeholder="给用户看的备注，例如「本季度更新剧集合集」"
                className="min-h-16 resize-y text-sm"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div>
                <p className="text-sm text-foreground">启用</p>
                <p className="text-[11px] text-muted-foreground">停用后受限账号不能再选它，已有订阅不受影响</p>
              </div>
              <Switch
                checked={draft.is_active}
                onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} className="text-xs">
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving} className="gap-1.5 text-xs">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {editingId ? '保存修改' : '添加'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-base">删除订阅源</DialogTitle>
            <DialogDescription className="text-xs">
              确定删除「{deleteTarget?.name}」吗？已用它建立的订阅不受影响，但受限账号以后不能再选它。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} className="text-xs">
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} className="text-xs">
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
