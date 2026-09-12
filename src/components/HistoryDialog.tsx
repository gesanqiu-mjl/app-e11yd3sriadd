import React, { useState, useEffect } from 'react';
import { History, CalendarDays } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChangeHistory } from '@/types/index';
import { fetchHistory } from '@/services/api';
import { toast } from 'sonner';

interface HistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function HistoryDialog({ open, onOpenChange }: HistoryDialogProps) {
  const [history, setHistory] = useState<ChangeHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    if (open) loadHistory();
  }, [open]);

  async function loadHistory(start?: string, end?: string) {
    setLoading(true);
    try {
      const data = await fetchHistory(start, end);
      setHistory(data);
    } catch {
      toast.error('加载历史记录失败');
    } finally {
      setLoading(false);
    }
  }

  function handleFilter() {
    loadHistory(startDate || undefined, endDate || undefined);
  }

  function handleReset() {
    setStartDate('');
    setEndDate('');
    loadHistory();
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border flex flex-col max-h-[90dvh]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <History className="h-4 w-4 text-primary" />
            修改历史记录
          </DialogTitle>
        </DialogHeader>

        {/* 日期筛选 */}
        <div className="flex flex-col md:flex-row items-start md:items-end gap-2 shrink-0 pt-1">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-7 text-xs bg-input border-border flex-1 min-w-0"
              placeholder="开始日期"
            />
            <span className="text-xs text-muted-foreground shrink-0">至</span>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-7 text-xs bg-input border-border flex-1 min-w-0"
              placeholder="结束日期"
            />
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Button
              size="sm"
              onClick={handleFilter}
              className="h-7 px-3 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
            >
              筛选
            </Button>
            {(startDate || endDate) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleReset}
                className="h-7 px-2 text-xs text-muted-foreground hover:bg-muted"
              >
                重置
              </Button>
            )}
          </div>
        </div>

        {/* 历史列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto mt-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground animate-pulse">加载中…</span>
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <History className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">暂无修改记录</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-xs">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-card border-b border-border">
                    <th className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap min-w-40">修改时间</th>
                    <th className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap min-w-28">资源名称</th>
                    <th className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap min-w-20">修改字段</th>
                    <th className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap min-w-24">修改前</th>
                    <th className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap min-w-24">修改后</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, idx) => (
                    <tr
                      key={h.id}
                      className={`border-b border-border/40 hover:bg-muted/20 transition-colors ${
                        idx % 2 === 0 ? 'bg-background' : 'bg-card/40'
                      }`}
                    >
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {formatDate(h.changed_at)}
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap max-w-36 truncate">
                        {h.resource_name}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-xs">
                          {h.field_label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground max-w-32 truncate">
                        {h.old_value || '—'}
                      </td>
                      <td className="px-3 py-2 text-accent font-medium max-w-32 truncate">
                        {h.new_value || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="shrink-0 pt-2 text-right">
          <span className="text-xs text-muted-foreground">
            共 {history.length} 条记录
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
