import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, Server, Users, HardDrive } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  stagingListAccounts,
  stagingListPanOwners,
  stagingSaveAccount,
  stagingDeleteAccount,
  stagingListAllocations,
  stagingSaveAllocation,
  stagingDeleteAllocation,
  GB,
  type StagingAccount,
  type StagingAllocation,
  type StagingPanOwner,
} from '@/services/staging';
import { fetchAllProfiles } from '@/services/api';

const fmtGB = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;

export default function StagingTab() {
  const [accounts, setAccounts] = useState<StagingAccount[]>([]);
  const [allocsByAcc, setAllocsByAcc] = useState<Record<string, StagingAllocation[]>>({});
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<{ id: string; username: string | null; email: string | null }[]>([]);
  const [panOwners, setPanOwners] = useState<StagingPanOwner[]>([]);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ label: '', pan_owner_user_id: '', root_dir_id: '', total_capacity_gb: '100' });

  const [allocOpen, setAllocOpen] = useState(false);
  const [allocAccId, setAllocAccId] = useState<string>('');
  const [allocUserId, setAllocUserId] = useState<string>('');
  const [allocGb, setAllocGb] = useState<string>('10');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [acc, prof, owners] = await Promise.all([
        stagingListAccounts(),
        fetchAllProfiles(),
        stagingListPanOwners(),
      ]);
      setAccounts(acc);
      setProfiles(
        (prof as Array<{ id: string; username: string | null; email: string | null }>).map((p) => ({
          id: p.id,
          username: p.username,
          email: p.email,
        }))
      );
      setPanOwners(owners);
      const map: Record<string, StagingAllocation[]> = {};
      await Promise.all(acc.map(async (a) => { map[a.id] = await stagingListAllocations(a.id); }));
      setAllocsByAcc(map);
    } catch (e: any) {
      toast.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEdit = (a?: StagingAccount) => {
    if (a) {
      setEditId(a.id);
      setForm({
        label: a.label,
        pan_owner_user_id: a.pan_owner_user_id ?? '',
        root_dir_id: a.root_dir_id ?? '',
        total_capacity_gb: (a.total_capacity_bytes / GB).toString(),
      });
    } else {
      setEditId(null);
      setForm({ label: '', pan_owner_user_id: '', root_dir_id: '', total_capacity_gb: '100' });
    }
    setEditOpen(true);
  };

  const saveAccount = async () => {
    try {
      await stagingSaveAccount({
        id: editId ?? undefined,
        label: form.label,
        pan_owner_user_id: form.pan_owner_user_id,
        root_dir_id: form.root_dir_id || null,
        total_capacity_bytes: Math.max(0, Math.round(Number(form.total_capacity_gb) * GB)),
      });
      toast.success('已保存主账号');
      setEditOpen(false);
      load();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    }
  };

  const removeAccount = async (id: string) => {
    if (!window.confirm('删除主账号会一并删除其下所有空间分配与文件记录，确定？')) return;
    try {
      await stagingDeleteAccount(id);
      toast.success('已删除');
      load();
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    }
  };

  const openAlloc = (accId: string) => {
    setAllocAccId(accId);
    setAllocUserId('');
    setAllocGb('10');
    setAllocOpen(true);
  };

  const saveAlloc = async () => {
    if (!allocUserId) {
      toast.error('请选择用户');
      return;
    }
    try {
      await stagingSaveAllocation({
        account_id: allocAccId,
        user_id: allocUserId,
        capacity_bytes: Math.max(0, Math.round(Number(allocGb) * GB)),
      });
      toast.success('已分配空间');
      setAllocOpen(false);
      load();
    } catch (e: any) {
      toast.error(e?.message || '分配失败');
    }
  };

  const removeAlloc = async (id: string) => {
    try {
      await stagingDeleteAllocation(id);
      toast.success('已删除分配');
      load();
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" /> 暂存主账号（光鸭云盘）
          </CardTitle>
          <Button size="sm" onClick={() => openEdit()}>
            <Plus className="mr-1 h-4 w-4" /> 添加主账号
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>备注名</TableHead>
                  <TableHead>总容量</TableHead>
                  <TableHead>已用</TableHead>
                  <TableHead>已分配</TableHead>
                  <TableHead>用户数</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">暂无主账号</TableCell>
                  </TableRow>
                ) : (
                  accounts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.label}</TableCell>
                      <TableCell>{fmtGB(a.total_capacity_bytes)}</TableCell>
                      <TableCell>{fmtGB(a.used_bytes ?? 0)}</TableCell>
                      <TableCell>{fmtGB(a.allocated_bytes ?? 0)}</TableCell>
                      <TableCell>{a.user_count ?? 0}</TableCell>
                      <TableCell>
                        <Badge variant={a.status === 'active' ? 'default' : 'destructive'}>{a.status}</Badge>
                        {a.status !== 'active' && a.last_error ? (
                          <div className="mt-1 max-w-[200px] truncate text-xs text-destructive" title={a.last_error}>
                            {a.last_error}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => openAlloc(a.id)}>
                            <Users className="mr-1 h-3.5 w-3.5" /> 分配
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openEdit(a)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => removeAccount(a.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {accounts.map((a) => (
        <Card key={a.id}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4" /> {a.label} · 空间分配
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>容量</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(allocsByAcc[a.id] ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">暂无分配</TableCell>
                  </TableRow>
                ) : (
                  (allocsByAcc[a.id] ?? []).map((al) => (
                    <TableRow key={al.id}>
                      <TableCell>{al.profile?.username || al.profile?.email || al.user_id}</TableCell>
                      <TableCell>{fmtGB(al.capacity_bytes)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => removeAlloc(al.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? '编辑主账号' : '添加暂存主账号'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>备注名</Label>
              <Input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="如：光鸭-主1"
              />
            </div>
            <div className="space-y-1">
              <Label>关联光鸭账号</Label>
              <select
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"
                value={form.pan_owner_user_id}
                onChange={(e) => setForm({ ...form, pan_owner_user_id: e.target.value })}
              >
                <option value="">选择已绑定光鸭的账号</option>
                {panOwners.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.username}
                    {p.status !== 'active' ? `（${p.status}）` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                主账号复用该用户已绑定的光鸭网盘凭证（需先在「网盘绑定」绑定光鸭）
              </p>
            </div>
            <div className="space-y-1">
              <Label>暂存目录 ID（可选）</Label>
              <Input
                value={form.root_dir_id}
                onChange={(e) => setForm({ ...form, root_dir_id: e.target.value })}
                placeholder="光鸭文件夹 fileId，留空=网盘根目录"
              />
            </div>
            <div className="space-y-1">
              <Label>总容量（GB）</Label>
              <Input
                type="number"
                value={form.total_capacity_gb}
                onChange={(e) => setForm({ ...form, total_capacity_gb: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>取消</Button>
            <Button onClick={saveAccount}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={allocOpen} onOpenChange={setAllocOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>分配空间</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>用户</Label>
              <select
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"
                value={allocUserId}
                onChange={(e) => setAllocUserId(e.target.value)}
              >
                <option value="">选择用户</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.username || p.email || p.id}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>容量（GB）</Label>
              <Input type="number" value={allocGb} onChange={(e) => setAllocGb(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAllocOpen(false)}>取消</Button>
            <Button onClick={saveAlloc}>分配</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
