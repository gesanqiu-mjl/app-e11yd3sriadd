import React, { useEffect, useState, useCallback } from 'react';
import { ArrowDownToLine, Trash2, Pencil, Share2, HardDrive, Loader2 } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  stagingMyStatus,
  stagingTransfer,
  stagingListFiles,
  stagingDeleteFiles,
  stagingRenameFile,
  type StagingMyAlloc,
  type StagingFile,
} from '@/services/staging';

const fmtSize = (bytes: number): string => {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

export default function StagingPage() {
  const [status, setStatus] = useState<StagingMyAlloc[]>([]);
  const [files, setFiles] = useState<StagingFile[]>([]);
  const [selectedAcc, setSelectedAcc] = useState<string>('');
  const [transferring, setTransferring] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [pwd, setPwd] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameId, setRenameId] = useState<string>('');
  const [renameName, setRenameName] = useState('');
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await stagingMyStatus());
    } catch (e: any) {
      toast.error(e?.message || '加载空间状态失败');
    }
  }, []);
  const loadFiles = useCallback(async () => {
    try {
      setFiles(await stagingListFiles());
    } catch (e: any) {
      toast.error(e?.message || '加载文件失败');
    }
  }, []);
  useEffect(() => {
    loadStatus();
    loadFiles();
  }, [loadStatus, loadFiles]);

  useEffect(() => {
    if (!selectedAcc && status.length) setSelectedAcc(status[0].account_id);
  }, [status, selectedAcc]);

  const onTransfer = async () => {
    if (!selectedAcc) {
      toast.error('请先选择暂存主账号（若无，请联系管理员分配）');
      return;
    }
    if (!shareUrl.trim()) {
      toast.error('请填写光鸭分享链接');
      return;
    }
    setTransferring(true);
    try {
      const r = await stagingTransfer({ account_id: selectedAcc, share_url: shareUrl, pwd: pwd || undefined });
      toast.success(r.message);
      setShareUrl('');
      setPwd('');
      loadStatus();
      loadFiles();
    } catch (e: any) {
      toast.error(e?.message || '转存失败');
    } finally {
      setTransferring(false);
    }
  };

  const onDelete = async (ids: string[]) => {
    if (!window.confirm('确定删除选中的文件？删除后将从光鸭网盘移除')) return;
    setBusy(true);
    try {
      const r = await stagingDeleteFiles(ids);
      toast.success(r.message);
      loadStatus();
      loadFiles();
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const openRename = (f: StagingFile) => {
    setRenameId(f.id);
    setRenameName(f.name);
    setRenameOpen(true);
  };
  const doRename = async () => {
    if (!renameName.trim()) return;
    setBusy(true);
    try {
      await stagingRenameFile(renameId, renameName.trim());
      toast.success('已重命名');
      setRenameOpen(false);
      loadFiles();
    } catch (e: any) {
      toast.error(e?.message || '重命名失败');
    } finally {
      setBusy(false);
    }
  };

  const onCreateShare = () => {
    toast.info('创建分享链接功能接口待开放，敬请期待');
  };

  const filteredFiles = selectedAcc ? files.filter((f) => f.account_id === selectedAcc) : files;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" /> 我的暂存空间
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.length === 0 ? (
            <p className="text-sm text-muted-foreground">您还没有被分配暂存空间，请联系管理员分配。</p>
          ) : (
            status.map((s) => {
              const used = s.used_bytes;
              const cap = s.capacity_bytes;
              const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
              return (
                <div key={s.id} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{s.account?.label}</span>
                    <span className="text-muted-foreground">
                      {fmtSize(used)} / {fmtSize(cap)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">转存到暂存空间</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row">
            <Select value={selectedAcc} onValueChange={setSelectedAcc}>
              <SelectTrigger className="md:w-48">
                <SelectValue placeholder="选择暂存主账号" />
              </SelectTrigger>
              <SelectContent>
                {status.map((s) => (
                  <SelectItem key={s.account_id} value={s.account_id}>
                    {s.account?.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="flex-1"
              value={shareUrl}
              onChange={(e) => setShareUrl(e.target.value)}
              placeholder="光鸭分享链接"
            />
            <Input
              className="md:w-32"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="提取码(可选)"
            />
            <Button onClick={onTransfer} disabled={transferring}>
              {transferring ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <ArrowDownToLine className="mr-1 h-4 w-4" />
              )}
              转存
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            转存前会对比文件大小与您的剩余空间，超出则无法转存；仅支持公开分享（带提取码的后续支持）。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">我的暂存文件</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文件名</TableHead>
                <TableHead>大小</TableHead>
                <TableHead>转存时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredFiles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">暂无文件</TableCell>
                </TableRow>
              ) : (
                filteredFiles.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="max-w-[300px] truncate" title={f.name}>
                      {f.name}
                    </TableCell>
                    <TableCell>{fmtSize(f.size_bytes)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(f.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={f.status === 'done' ? 'default' : 'destructive'}>{f.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={onCreateShare}>
                          <Share2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openRename(f)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => onDelete([f.id])}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label>新文件名</Label>
            <Input value={renameName} onChange={(e) => setRenameName(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button onClick={doRename} disabled={busy}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
