import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, FileSpreadsheet, Info, Loader2, RefreshCw, StopCircle, Upload, XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { readXlsx } from '@/lib/parseXlsx';
import {
  BATCH_POST_SITE_LABELS,
  parseBatchPostSheets,
  planBatchPost,
  publishBatchPost,
  type BatchPostPlanItem,
  type BatchPostResult,
  type BatchPostRow,
  type BatchPostSite,
} from '@/lib/batchPost';
import { fetchResourceQuota } from '@/services/api';

interface BatchPostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: BatchPostSite;
}

type Phase = 'idle' | 'matching' | 'ready' | 'publishing' | 'done';

interface ProgressState {
  done: number;
  total: number;
}

export default function BatchPostDialog({ open, onOpenChange, site }: BatchPostDialogProps) {
  const siteLabel = BATCH_POST_SITE_LABELS[site];
  const fileRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [sourceName, setSourceName] = useState('');
  const [rows, setRows] = useState<BatchPostRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [items, setItems] = useState<BatchPostPlanItem[]>([]);
  const [progress, setProgress] = useState<ProgressState>({ done: 0, total: 0 });
  const [results, setResults] = useState<BatchPostResult[]>([]);
  const [quota, setQuota] = useState<{ isAdmin: boolean; used: number; limit: number } | null>(null);
  const [currentLabel, setCurrentLabel] = useState('');
  /**
   * 发帖是否使用短链：null = 未手动选择（用账号默认：管理员开、其它账号关）。
   * 用户可在此弹窗自行切换；第三方脚本直接调 batch-post 时传 useShortLink 也能自主选择。
   */
  const [useShortLink, setUseShortLink] = useState<boolean | null>(null);
  const shortLinkChoice = useShortLink ?? quota?.isAdmin ?? false;

  const busy = phase === 'matching' || phase === 'publishing';

  // 关闭时复位，避免下次打开残留上一次的结果
  useEffect(() => {
    if (open) return;
    stopRef.current = false;
    setPhase('idle');
    setSourceName('');
    setRows([]);
    setParseErrors([]);
    setItems([]);
    setResults([]);
    setProgress({ done: 0, total: 0 });
    setCurrentLabel('');
  }, [open]);

  // 打开时取一次资源配额，提前提示可能入库失败的行数
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchResourceQuota()
      .then((q) => { if (!cancelled) setQuota(q); })
      .catch(() => { if (!cancelled) setQuota(null); });
    return () => { cancelled = true; };
  }, [open]);

  const readyCount = useMemo(() => items.filter((it) => it.status === 'ready').length, [items]);
  const skippedCount = items.length - readyCount;
  const remainingQuota = quota && !quota.isAdmin ? Math.max(quota.limit - quota.used, 0) : null;
  const quotaShortfall = remainingQuota !== null && readyCount > remainingQuota;
  const failures = useMemo(() => results.filter((r) => !r.ok), [results]);
  const succeeded = results.length - failures.length;
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  /** 解析 xlsx 并立即在站点片库匹配片源 */
  const startMatch = useCallback(
    async (list: BatchPostRow[]) => {
      stopRef.current = false;
      setItems([]);
      setResults([]);
      setPhase('matching');
      setProgress({ done: 0, total: list.length });
      try {
        const planned = await planBatchPost(site, list, {
          concurrency: 2,
          shouldStop: () => stopRef.current,
          onProgress: (done, total, item) => {
            setProgress({ done, total });
            setCurrentLabel(item.row.fileName || item.row.drama);
          },
        });
        setItems(planned);
        setPhase('ready');
        const ready = planned.filter((it) => it.status === 'ready').length;
        if (ready === 0) toast.error('所有行都未匹配到站点片源，请检查剧名是否与站点一致');
        else toast.success(`匹配完成：可发布 ${ready} 行，跳过 ${planned.length - ready} 行`);
      } catch (e) {
        setPhase('idle');
        toast.error((e as Error).message || '匹配失败');
      } finally {
        setCurrentLabel('');
      }
    },
    [site]
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.xlsx')) {
        toast.error('仅支持 .xlsx 文件（Excel / WPS 另存为 .xlsx 后再上传）');
        return;
      }
      setSourceName(file.name);
      try {
        const sheets = await readXlsx(file);
        const parsed = parseBatchPostSheets(sheets);
        setParseErrors(parsed.errors);
        setRows(parsed.rows);
        if (parsed.rows.length === 0) {
          toast.error(parsed.errors[0] || '表格中没有可用数据');
          return;
        }
        await startMatch(parsed.rows);
      } catch (e) {
        setPhase('idle');
        setRows([]);
        setParseErrors([]);
        toast.error((e as Error).message || '读取 xlsx 失败');
      }
    },
    [startMatch]
  );

  /** 执行发帖（可指定子集，用于「重试失败项」） */
  const startPublish = useCallback(
    async (list: BatchPostPlanItem[]) => {
      const targets = list.filter((it) => it.status === 'ready');
      if (targets.length === 0) {
        toast.info('没有可发布的行');
        return;
      }
      stopRef.current = false;
      setResults([]);
      setPhase('publishing');
      setProgress({ done: 0, total: targets.length });
      try {
        const res = await publishBatchPost(site, targets, {
          concurrency: 2,
          shouldStop: () => stopRef.current,
          // 用户在本弹窗选择的「是否使用短链」
          useShortLink: shortLinkChoice,
          onProgress: (done, total, result) => {
            setProgress({ done, total });
            setCurrentLabel(result.fileName || result.drama);
          },
        });
        setResults(res.results);
        if (res.failed === 0) toast.success(`${siteLabel}批量发帖完成：成功 ${res.posted} 条`);
        else if (res.posted > 0) toast.warning(`批量发帖完成：成功 ${res.posted} 条，失败 ${res.failed} 条`);
        else toast.error(`批量发帖失败：${res.failed} 条均未成功，原因见列表`);
        setPhase('done');
      } catch (e) {
        setPhase('ready');
        toast.error((e as Error).message || '批量发帖失败');
      } finally {
        setCurrentLabel('');
      }
    },
    [site, siteLabel, shortLinkChoice]
  );

  const retryFailed = useCallback(() => {
    const failedRows = new Set(failures.map((r) => r.rowNo));
    const list = items.filter((it) => failedRows.has(it.row.rowNo));
    if (list.length === 0) {
      toast.info('失败项已不在当前列表中，请重新上传表格');
      return;
    }
    void startPublish(list);
  }, [failures, items, startPublish]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // 执行中不允许关闭，避免误触中断
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[calc(100%-1.5rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            {siteLabel}批量发帖
          </DialogTitle>
          <DialogDescription>
            上传表格（列：<span className="text-foreground">剧名 / 文件名 / 链接</span>），按剧名自动匹配站点片源后逐行发帖；
            发帖成功会在本应用资源库新增对应资源并保存绑定，<span className="text-foreground">新资源统一归入「已完结」</span>，之后可在资源表格里正常增量同步。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {/* 上传区 */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {phase === 'matching' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {sourceName ? '重新选择表格' : '选择 xlsx 表格'}
            </Button>
            <span className="text-xs text-muted-foreground truncate">
              {sourceName || '支持 .xlsx（Excel / WPS 另存为）'}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleFile(file);
              }}
            />
          </div>

          {/* 解析提示 */}
          {parseErrors.length > 0 && (
            <div className="max-h-24 overflow-y-auto rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-600 dark:text-amber-500 space-y-0.5">
              {parseErrors.map((msg) => (
                <div key={msg} className="flex items-start gap-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                  <span>{msg}</span>
                </div>
              ))}
            </div>
          )}

          {/* 短链开关（可自定义选择）：正文里的网盘链接是否换成短链 */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/40 p-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">发帖使用短链</div>
              <div className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                开启：发给站点的正文里，网盘链接换成该链接自己的短链（光鸭
                <code className="font-mono"> g…</code>、夸克<code className="font-mono"> q…</code>，一眼可区分）；
                关闭：按原始网盘链接推送。资源库与站点绑定始终保存原始链接，后续同步不受影响。
              </div>
            </div>
            <Switch
              checked={shortLinkChoice}
              disabled={busy}
              onCheckedChange={(v) => setUseShortLink(v)}
            />
          </div>

          {/* 统计 */}
          {rows.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 p-3 space-y-1 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">表格数据行</span>
                <span className="text-foreground">{rows.length} 行</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">已匹配站点片源</span>
                <span className="text-emerald-600 dark:text-emerald-500">{readyCount} 行</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">未匹配（跳过）</span>
                <span className={skippedCount > 0 ? 'text-destructive' : 'text-muted-foreground'}>{skippedCount} 行</span>
              </div>
              {remainingQuota !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">资源库剩余额度</span>
                  <span className={quotaShortfall ? 'text-destructive' : 'text-foreground'}>{remainingQuota} 条</span>
                </div>
              )}
            </div>
          )}

          {quotaShortfall && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                资源库额度不足：本次需入库 {readyCount} 条，仅剩 {remainingQuota} 条。超出部分会显示「帖子已发布，但入库失败」。
              </span>
            </div>
          )}

          {/* 进度 */}
          {busy && (
            <div className="space-y-1.5">
              <Progress value={percent} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {phase === 'matching' ? '匹配中' : '发帖中'} {progress.done}/{progress.total}（{percent}%）
                </span>
                <span className="truncate max-w-[50%]" title={currentLabel}>{currentLabel}</span>
              </div>
            </div>
          )}

          {/* 结果汇总 */}
          {results.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              {failures.length === 0 ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />全部成功，共 {succeeded} 条
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <XCircle className="h-3.5 w-3.5" />失败 {failures.length} 条（成功 {succeeded} 条）
                </span>
              )}
            </div>
          )}

          {/* 明细列表：优先展示失败项，其次展示计划 */}
          {(failures.length > 0 || items.length > 0) && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {failures.map((f) => (
                <div key={`fail-${f.rowNo}`} className="px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[10px] text-muted-foreground">第 {f.rowNo} 行</span>
                    <span className="truncate text-xs text-foreground" title={f.fileName || f.drama}>
                      {f.fileName || f.drama}
                    </span>
                  </div>
                  <div className="text-[11px] text-destructive">{f.message}</div>
                </div>
              ))}
              {failures.length === 0 && items.map((it) => (
                <div key={`plan-${it.row.rowNo}`} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="shrink-0 text-[10px] text-muted-foreground">第 {it.row.rowNo} 行</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={it.row.fileName || it.row.drama}>
                    {it.row.fileName || it.row.drama}
                  </span>
                  {it.status === 'ready' ? (
                    <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-500">
                      → {it.target?.title}
                      {it.target?.year ? ` (${it.target.year})` : ''}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-destructive" title={it.reason}>
                      {it.reason}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              匹配规则：按「剧名」在站点片库检索，标题完全一致优先、其次包含匹配，并用文件名里的年份做二次校验；
              未匹配到的行会跳过，不影响其它行。
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {!busy && failures.length > 0 && (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={retryFailed}>
              <RefreshCw className="h-3.5 w-3.5" />重试失败项
            </Button>
          )}
          {busy ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => {
                stopRef.current = true;
                toast.info('已请求停止，等待进行中的任务结束…');
              }}
            >
              <StopCircle className="h-3.5 w-3.5" />停止
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 gap-1.5"
              disabled={readyCount === 0}
              onClick={() => void startPublish(items)}
            >
              <Upload className="h-3.5 w-3.5" />
              开始发帖（{readyCount}）
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
