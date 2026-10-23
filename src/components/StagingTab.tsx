import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Server, Loader2, RefreshCw, Folder, ChevronRight, Check, HardDrive } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { toast } from 'sonner';
import QRCodeDataUrl from '@/components/ui/qrcodedataurl';
import { startPanDeviceAuth, pollPanDeviceAuth } from '@/services/subscriptions';
import {
  stagingListAccounts,
  stagingDeleteAccount,
  stagingBindAccount,
  stagingListDirs,
  stagingSetDir,
  GB,
  type StagingAccount,
  type StagingDir,
} from '@/services/staging';

const fmtGB = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;

/**
 * 管理员：暂存主账号
 * 扫码授权 → 自动读取该光鸭云盘的账号名与目录 → 点选一个目录作为暂存目录即可。
 * 不需要手填备注名 / 目录 ID / 容量。
 */
export default function StagingTab() {
  const [accounts, setAccounts] = useState<StagingAccount[]>([]);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'create' | 'rebind'>('create');
  const [rebindAccount, setRebindAccount] = useState<StagingAccount | null>(null);

  // 扫码
  const [scanSession, setScanSession] = useState<any>(null);
  const [scanRemain, setScanRemain] = useState(0);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanDoneRef = useRef(false);

  // 绑定结果 + 目录选择
  const [step, setStep] = useState<'scan' | 'pick'>('scan');
  const [boundId, setBoundId] = useState<string | null>(null);
  const [boundLabel, setBoundLabel] = useState('');
  const [dirs, setDirs] = useState<StagingDir[]>([]);
  const [crumbs, setCrumbs] = useState<Array<{ id: string; name: string }>>([{ id: '', name: '根目录' }]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [savingDir, setSavingDir] = useState(false);

  const stopTimer = useCallback(() => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAccounts(await stagingListAccounts());
    } catch (e: any) {
      toast.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => stopTimer(), [stopTimer]);

  const resetDialog = () => {
    stopTimer();
    setScanSession(null);
    scanDoneRef.current = false;
    setStep('scan');
    setBoundId(null);
    setBoundLabel('');
    setDirs([]);
    setCrumbs([{ id: '', name: '根目录' }]);
    setRebindAccount(null);
  };

  const openCreate = () => {
    resetDialog();
    setMode('create');
    setOpen(true);
  };

  const openRebind = (a: StagingAccount) => {
    resetDialog();
    setMode('rebind');
    setRebindAccount(a);
    setOpen(true);
  };

  const loadDirs = async (accountId: string, parentId: string) => {
    setLoadingDirs(true);
    try {
      setDirs(await stagingListDirs(accountId, parentId));
    } catch (e: any) {
      toast.error(e?.message || '读取目录失败');
      setDirs([]);
    } finally {
      setLoadingDirs(false);
    }
  };

  /** 扫码授权：成功后自动绑定，再进入目录选择（新建）或直接更新（重新绑定） */
  const startBind = async () => {
    try {
      const s = await startPanDeviceAuth('guangya');
      setScanSession(s);
      setScanRemain(s.expiresIn ?? 120);
      scanDoneRef.current = false;
      scanTimerRef.current = setInterval(async () => {
        if (scanDoneRef.current) {
          stopTimer();
          return;
        }
        setScanRemain((r) => (r > 0 ? r - 1 : 0));
        try {
          const r: any = await pollPanDeviceAuth(scanSession.sessionId);
          if (r.status === 'success') {
            if (scanDoneRef.current) return;
            scanDoneRef.current = true;
            stopTimer();
            setScanSession(null);
            const tokenJson = JSON.stringify({
              access_token: r.accessToken,
              refresh_token: r.refreshToken,
              client_id: r.clientId,
            });
            if (mode === 'rebind' && rebindAccount) {
              const res = await stagingBindAccount({
                token_json: tokenJson,
                id: rebindAccount.id,
                root_dir_id: rebindAccount.root_dir_id,
              });
              toast.success(`已重新绑定：${res.label}`);
              setOpen(false);
              load();
              return;
            }
            const res = await stagingBindAccount({ token_json: tokenJson });
            setBoundId(res.id);
            setBoundLabel(res.label);
            setDirs(res.dirs ?? []);
            setCrumbs([{ id: '', name: '根目录' }]);
            setStep('pick');
            toast.success(`已绑定光鸭账号：${res.label}`);
          } else if (r.status === 'expired' || r.status === 'failed') {
            scanDoneRef.current = true;
            stopTimer();
            setScanSession(null);
            toast.error(r.message || '绑定失败');
          }
        } catch (e: any) {
          // 网络抖动继续等；若是业务错误（如授权校验失败）则终止
          if (e?.message && !/timeout|网络|fetch/i.test(e.message)) {
            scanDoneRef.current = true;
            stopTimer();
            setScanSession(null);
            toast.error(e.message);
          }
        }
      }, 2000);
    } catch (e: any) {
      toast.error(e?.message || '发起授权失败');
    }
  };

  const enterDir = (d: StagingDir) => {
    if (!boundId) return;
    const next = [...crumbs, d];
    setCrumbs(next);
    loadDirs(boundId, d.id);
  };

  const goCrumb = (index: number) => {
    if (!boundId) return;
    const next = crumbs.slice(0, index + 1);
    setCrumbs(next);
    loadDirs(boundId, next[next.length - 1].id);
  };

  const chooseCurrentDir = async () => {
    if (!boundId) return;
    const cur = crumbs[crumbs.length - 1];
    setSavingDir(true);
    try {
      await stagingSetDir({
        id: boundId,
        root_dir_id: cur.id || null,
        root_dir_name: cur.id ? cur.name : null,
      });
      toast.success(cur.id ? `暂存目录已设为：${cur.name}` : '暂存目录已设为根目录');
      setOpen(false);
      load();
    } catch (e: any) {
      toast.error(e?.message || '保存目录失败');
    } finally {
      setSavingDir(false);
    }
  };

  const removeAccount = async (a: StagingAccount) => {
    if (!window.confirm(`确定删除主账号「${a.label}」？其下所有空间分配与文件记录会一并删除。`)) return;
    try {
      await stagingDeleteAccount(a.id);
      toast.success('已删除');
      load();
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    }
  };

  const curDirName = crumbs[crumbs.length - 1];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" /> 暂存主账号
        </CardTitle>
        <Button size="sm" onClick={openCreate}>
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
                <TableHead>光鸭账号</TableHead>
                <TableHead>暂存目录</TableHead>
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
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    暂无主账号，点右上角「添加主账号」扫码绑定
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.label}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-sm">
                        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                        {a.root_dir_name || '根目录'}
                      </span>
                    </TableCell>
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
                        <Button size="sm" variant="outline" onClick={() => openRebind(a)} title="重新扫码授权">
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => removeAccount(a)} title="删除">
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
        open={open}
        onOpenChange={(v) => {
          if (!v) resetDialog();
          setOpen(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === 'rebind' ? '重新绑定光鸭账号' : '添加暂存主账号'}</DialogTitle>
          </DialogHeader>

          {step === 'scan' ? (
            <div className="space-y-3">
              {!scanSession ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    用要作为暂存盘的光鸭账号扫码授权，绑定后自动读取该云盘的账号与目录，无需手动填写。
                  </p>
                  <Button onClick={startBind} className="w-full">
                    <Server className="mr-1.5 h-4 w-4" /> 扫码授权绑定光鸭
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-center rounded-lg border border-border bg-card p-3">
                    <QRCodeDataUrl text={scanSession.verifyUrl} width={200} />
                  </div>
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 请用光鸭 App 扫码并确认授权
                    {scanRemain > 0 && <span>（{scanRemain}s 后失效）</span>}
                  </div>
                  {scanSession.verifyUrl ? (
                    <div className="break-all text-center text-[11px] text-muted-foreground">
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
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
                <Check className="h-4 w-4 text-emerald-600" />
                <span className="flex-1 truncate">
                  已绑定：<strong>{boundLabel}</strong>
                </span>
              </div>

              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">选择该云盘内的暂存目录（当前：{curDirName.name}）</p>
                <div className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
                  {crumbs.map((c, i) => (
                    <span key={`${c.id}-${i}`} className="inline-flex items-center">
                      {i > 0 && <ChevronRight className="mx-0.5 h-3 w-3" />}
                      <button
                        type="button"
                        className={`rounded px-1 py-0.5 hover:bg-muted ${i === crumbs.length - 1 ? 'font-medium text-foreground' : ''}`}
                        onClick={() => goCrumb(i)}
                      >
                        {c.name}
                      </button>
                    </span>
                  ))}
                </div>

                <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border">
                  {loadingDirs ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> 读取目录…
                    </div>
                  ) : dirs.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">该目录下没有子文件夹</div>
                  ) : (
                    dirs.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted"
                        onClick={() => enterDir(d)}
                      >
                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                        <span className="flex-1 truncate">{d.name}</span>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            {step === 'scan' ? (
              <Button variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  稍后再说（默认根目录）
                </Button>
                <Button onClick={chooseCurrentDir} disabled={savingDir}>
                  {savingDir && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  <HardDrive className="mr-1.5 h-4 w-4" /> 使用「{curDirName.name}」
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
