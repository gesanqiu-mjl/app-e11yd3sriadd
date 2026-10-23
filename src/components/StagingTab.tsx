import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, Server, Loader2 } from 'lucide-react';
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
import QRCodeDataUrl from '@/components/ui/qrcodedataurl';
import { startPanDeviceAuth, pollPanDeviceAuth } from '@/services/subscriptions';
import {
  stagingListAccounts,
  stagingSaveAccount,
  stagingDeleteAccount,
  GB,
  type StagingAccount,
} from '@/services/staging';

const fmtGB = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;

/** 管理员：管理「暂存主账号」——独立的专用光鸭云盘（与「网盘绑定」不混用），扫码授权后凭证存本表 */
export default function StagingTab() {
  const [accounts, setAccounts] = useState<StagingAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ label: '', token_json: '', root_dir_id: '', total_capacity_gb: '100' });

  // 光鸭扫码绑定
  const [scanSession, setScanSession] = useState<any>(null);
  const [scanRemain, setScanRemain] = useState(0);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanDoneRef = useRef(false);

  const stopScanTimer = useCallback(() => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const acc = await stagingListAccounts();
      setAccounts(acc);
    } catch (e: any) {
      toast.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => stopScanTimer(), [stopScanTimer]);

  const openEdit = (a?: StagingAccount) => {
    stopScanTimer();
    setScanSession(null);
    scanDoneRef.current = false;
    if (a) {
      setEditId(a.id);
      setForm({
        label: a.label,
        token_json: '',
        root_dir_id: a.root_dir_id ?? '',
        total_capacity_gb: (a.total_capacity_bytes / GB).toString(),
      });
    } else {
      setEditId(null);
      setForm({ label: '', token_json: '', root_dir_id: '', total_capacity_gb: '100' });
    }
    setEditOpen(true);
  };

  const startBind = async () => {
    try {
      const s = await startPanDeviceAuth('guangya');
      setScanSession(s);
      setScanRemain(s.expiresIn ?? 120);
      scanDoneRef.current = false;
      scanTimerRef.current = setInterval(async () => {
        if (scanDoneRef.current) {
          stopScanTimer();
          return;
        }
        setScanRemain((r) => (r > 0 ? r - 1 : 0));
        try {
          const r: any = await pollPanDeviceAuth(scanSession.sessionId);
          if (r.status === 'success') {
            if (scanDoneRef.current) return;
            scanDoneRef.current = true;
            stopScanTimer();
            const tokenJson = JSON.stringify({
              access_token: r.accessToken,
              refresh_token: r.refreshToken,
              client_id: r.clientId,
            });
            setForm((f) => ({ ...f, token_json: tokenJson }));
            setScanSession(null);
            toast.success('光鸭账号已绑定');
          } else if (r.status === 'expired' || r.status === 'failed') {
            scanDoneRef.current = true;
            stopScanTimer();
            setScanSession(null);
            toast.error(r.message || '绑定失败');
          }
        } catch {
          /* 网络抖动：继续等 */
        }
      }, 2000);
    } catch (e: any) {
      toast.error(e?.message || '发起授权失败');
    }
  };

  const saveAccount = async () => {
    try {
      if (!form.token_json && !editId) {
        toast.error('请先绑定光鸭账号（扫码授权）');
        return;
      }
      await stagingSaveAccount({
        id: editId ?? undefined,
        label: form.label,
        token_json: form.token_json || undefined,
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

  // 已绑定（编辑已有账号视为已绑定，可不重绑）；新建账号必须扫码绑定
  const bound = !!form.token_json || !!editId;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" /> 暂存主账号（独立光鸭云盘）
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

      <Dialog
        open={editOpen}
        onOpenChange={(v) => {
          if (!v) {
            stopScanTimer();
            setScanSession(null);
          }
          setEditOpen(v);
        }}
      >
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

            <div className="space-y-1 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <Label>光鸭账号绑定</Label>
                {bound ? <span className="text-xs text-emerald-600">已绑定 ✓</span> : null}
              </div>
              {!scanSession ? (
                <Button size="sm" variant="outline" onClick={startBind} className="mt-1">
                  <Server className="mr-1 h-3.5 w-3.5" />
                  {bound ? '重新绑定光鸭' : '绑定光鸭（扫码授权）'}
                </Button>
              ) : (
                <div className="mt-2 space-y-2">
                  <div className="flex justify-center rounded-lg border border-border bg-card p-3">
                    <QRCodeDataUrl text={scanSession.verifyUrl} width={180} />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 请用光鸭 App 扫码授权
                    {scanRemain > 0 && <span>（{scanRemain}s 后失效）</span>}
                  </div>
                  {scanSession.verifyUrl ? (
                    <div className="break-all text-[11px] text-muted-foreground">
                      或浏览器打开：
                      <a
                        href={scanSession.verifyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {scanSession.verifyUrl}
                      </a>
                    </div>
                  ) : null}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                主账号是独立的专用光鸭云盘，与「网盘绑定」里的账号不混用；用管理员的光鸭账号扫码授权后，用户转存的资源都存到这里。
              </p>
            </div>

            <div className="space-y-1">
              <Label>暂存目录 ID（必填）</Label>
              <Input
                value={form.root_dir_id}
                onChange={(e) => setForm({ ...form, root_dir_id: e.target.value })}
                placeholder="光鸭文件夹 fileId（在光鸭网盘新建专用文件夹后复制）"
              />
              <p className="text-xs text-muted-foreground">
                转存文件会落入此目录；建议建一个专用文件夹，复制其 fileId
              </p>
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
            <Button
              variant="outline"
              onClick={() => {
                stopScanTimer();
                setScanSession(null);
                setEditOpen(false);
              }}
            >
              取消
            </Button>
            <Button onClick={saveAccount}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
