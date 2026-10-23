import React, { useEffect, useState, useCallback } from 'react';
import { Trash2, HardDrive } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  stagingListAccounts,
  stagingListAllocations,
  stagingSaveAllocation,
  stagingDeleteAllocation,
  GB,
  type StagingAccount,
  type StagingAllocation,
} from '@/services/staging';

const fmtGB = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;

interface Props {
  open: boolean;
  userId: string | null;
  onClose: () => void;
}

/** 管理员在「用户管理」中调整某账号的暂存空间容量（可分配到多个主账号） */
export default function StagingAllocationDialog({ open, userId, onClose }: Props) {
  const [accounts, setAccounts] = useState<StagingAccount[]>([]);
  const [allocs, setAllocs] = useState<StagingAllocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [selAcc, setSelAcc] = useState('');
  const [gb, setGb] = useState('10');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const accs = await stagingListAccounts();
      setAccounts(accs);
      const all: StagingAllocation[] = [];
      await Promise.all(
        accs.map(async (a) => {
          const list = await stagingListAllocations(a.id);
          all.push(...list.filter((x) => x.user_id === userId));
        })
      );
      setAllocs(all);
    } catch (e: any) {
      toast.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (open) {
      setSelAcc('');
      setGb('10');
      load();
    }
  }, [open, load]);

  const save = async () => {
    if (!userId || !selAcc) {
      toast.error('请选择暂存主账号');
      return;
    }
    setBusy(true);
    try {
      await stagingSaveAllocation({
        account_id: selAcc,
        user_id: userId,
        capacity_bytes: Math.max(0, Math.round(Number(gb) * GB)),
      });
      toast.success('已保存暂存空间容量');
      await load();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await stagingDeleteAllocation(id);
      toast.success('已删除');
      await load();
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>调整暂存空间容量</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <>
              <div>
                <Label className="text-xs">当前分配</Label>
                {allocs.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">该用户尚未分配暂存空间</p>
                ) : (
                  <div className="mt-1 space-y-1">
                    {allocs.map((a) => {
                      const acc = accounts.find((x) => x.id === a.account_id);
                      return (
                        <div
                          key={a.id}
                          className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                        >
                          <span className="truncate">{acc?.label || a.account_id}</span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="font-medium">{fmtGB(a.capacity_bytes)}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => remove(a.id)}
                              disabled={busy}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="space-y-2 border-t border-border pt-3">
                <Label className="text-xs">新增 / 调整分配</Label>
                <Select value={selAcc} onValueChange={setSelAcc}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择暂存主账号" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={gb}
                    onChange={(e) => setGb(e.target.value)}
                    className="w-32"
                  />
                  <span className="text-xs text-muted-foreground">GB</span>
                  <Button size="sm" onClick={save} disabled={busy} className="ml-auto">
                    保存
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  保存会覆盖该用户在此主账号上的原有容量；可分配到多个主账号
                </p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
