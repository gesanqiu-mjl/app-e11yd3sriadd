import React, { useCallback, useEffect, useState } from 'react';
import { Crown, Loader2, Check, X, ShieldOff, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { fetchSourceOwnerApplications, reviewSourceOwner } from '@/services/api';
import type { SourceOwnerApplication } from '@/types/index';

/** 待审核 / 已通过 / 已驳回 */
type FilterKey = 'pending' | 'approved' | 'rejected' | 'all';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '未通过' },
  { key: 'all', label: '全部' },
];

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  approved: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  rejected: 'bg-muted text-muted-foreground',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * 管理员：源主申请审核。
 *
 * 通过后该用户的「更新中」资源会进入其他用户的内置订阅源；
 * 撤销（revoke）会立即把资源从订阅源隐藏，用户可再次申请。
 */
export default function SourceOwnerTab() {
  const [filter, setFilter] = useState<FilterKey>('pending');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<SourceOwnerApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** 确认弹窗状态 */
  const [confirm, setConfirm] = useState<{
    row: SourceOwnerApplication;
    action: 'approve' | 'reject' | 'revoke';
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchSourceOwnerApplications(filter === 'all' ? null : filter);
      setRows(data);
    } catch (e) {
      toast.error((e as Error).message || '加载源主申请失败');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = query.trim()
    ? rows.filter((r) =>
        [r.username, r.display_name].some((v) =>
          (v || '').toLowerCase().includes(query.trim().toLowerCase())
        )
      )
    : rows;

  const pendingCount = rows.filter((r) => r.status === 'pending').length;

  async function doReview() {
    if (!confirm) return;
    const { row, action } = confirm;
    setConfirm(null);
    setBusyId(row.user_id);
    try {
      await reviewSourceOwner({ userId: row.user_id, action });
      toast.success(
        action === 'approve'
          ? `已通过「${row.display_name || row.username || '该用户'}」的源主申请`
          : action === 'reject'
            ? '已驳回该申请'
            : '已撤销该源主身份'
      );
      await load();
    } catch (e) {
      toast.error((e as Error).message || '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  const actionLabel = confirm
    ? confirm.action === 'approve' ? '通过申请' : confirm.action === 'reject' ? '驳回申请' : '撤销源主身份'
    : '';
  const actionDesc = confirm
    ? confirm.action === 'approve'
      ? `通过后，该用户「更新中」的 ${confirm.row.resource_count} 个资源将出现在其他用户的内置订阅源中。`
      : confirm.action === 'reject'
        ? '驳回后用户可以重新提交申请。'
        : '撤销后该用户的资源会立即从订阅源隐藏，用户可重新申请。'
    : '';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              filter === f.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {f.label}
            {f.key === 'pending' && pendingCount > 0 && filter === 'pending' && (
              <span className="ml-1">({pendingCount})</span>
            )}
          </button>
        ))}
        <div className="relative ml-auto max-w-xs flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索用户名 / 源主名"
            className="h-8 bg-input border-border text-xs"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} className="h-8 gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : visible.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {filter === 'pending' ? '暂无待审核的源主申请' : '没有符合条件的记录'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">用户</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 pr-3 font-medium">资源</th>
                <th className="py-2 pr-3 font-medium">申请理由</th>
                <th className="py-2 pr-3 font-medium">申请时间</th>
                <th className="py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.user_id} className="border-b border-border/60">
                  <td className="py-2.5 pr-3">
                    <div className="font-medium text-foreground">{r.display_name || r.username || '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.display_name && r.username ? `@${r.username}` : ''}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[r.status]}`}>
                      {r.status === 'pending' ? '待审核' : r.status === 'approved' ? '已通过' : '未通过'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                    更新中 <span className="font-medium text-foreground">{r.resource_count}</span> · 已完结{' '}
                    <span className="font-medium text-foreground">{r.finished_count}</span>
                  </td>
                  <td className="max-w-[240px] py-2.5 pr-3">
                    <div className="truncate text-xs text-muted-foreground" title={r.apply_note || ''}>
                      {r.apply_note || '—'}
                    </div>
                    {r.review_note && (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80" title={r.review_note}>
                        审核：{r.review_note}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                    {formatTime(r.created_at)}
                    {r.reviewed_at && (
                      <div className="text-[11px] text-muted-foreground/80">
                        审核于 {formatTime(r.reviewed_at)}
                        {r.reviewed_by_name ? ` · ${r.reviewed_by_name}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    {busyId === r.user_id ? (
                      <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
                    ) : r.status === 'pending' ? (
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          onClick={() => setConfirm({ row: r, action: 'approve' })}
                          className="h-8 gap-1"
                        >
                          <Check className="h-3.5 w-3.5" /> 通过
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirm({ row: r, action: 'reject' })}
                          className="h-8 gap-1"
                        >
                          <X className="h-3.5 w-3.5" /> 驳回
                        </Button>
                      </div>
                    ) : r.status === 'approved' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirm({ row: r, action: 'revoke' })}
                        className="h-8 gap-1"
                      >
                        <ShieldOff className="h-3.5 w-3.5" /> 撤销
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Crown className="mt-0.5 h-3 w-3 shrink-0" />
        源主的「更新中」资源会展示在订阅转存的「内置订阅源」里；用特殊邀请码注册的账号看不到源主资源。
      </p>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{actionLabel}</AlertDialogTitle>
            <AlertDialogDescription>{actionDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doReview()}>确定</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}