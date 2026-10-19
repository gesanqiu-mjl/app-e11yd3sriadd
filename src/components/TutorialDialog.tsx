import React, { useEffect, useState } from 'react';
import { BookOpen, ImageOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Tutorial } from '@/types/index';

interface TutorialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tutorials: Tutorial[];
}

/**
 * 首页「图文教程」阅读弹窗。
 * 桌面：左目录 + 右内容；手机：顶部横向目录 + 下方内容（内容区独立滚动）。
 */
export default function TutorialDialog({ open, onOpenChange, tutorials }: TutorialDialogProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  // 打开时默认定位到第一篇；当前选中的教程被删/停用后自动回退
  useEffect(() => {
    if (!open) return;
    if (!tutorials.length) {
      setActiveId(null);
      return;
    }
    if (!activeId || !tutorials.some((t) => t.id === activeId)) {
      setActiveId(tutorials[0].id);
    }
  }, [open, tutorials, activeId]);

  const active = tutorials.find((t) => t.id === activeId) ?? tutorials[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-4 py-3 md:px-5 md:py-3.5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-primary" />
            图文教程
          </DialogTitle>
          <DialogDescription className="text-xs">
            {tutorials.length > 0 ? `共 ${tutorials.length} 篇，左侧可切换` : '暂无教程'}
          </DialogDescription>
        </DialogHeader>

        {tutorials.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <ImageOff className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">暂无教程内容</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* 目录 */}
            <nav className="shrink-0 border-b border-border md:w-56 md:border-b-0 md:border-r md:overflow-y-auto">
              <div className="flex gap-1 overflow-x-auto p-2 md:flex-col md:gap-0.5 md:overflow-x-visible">
                {tutorials.map((t, i) => {
                  const on = active?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setActiveId(t.id)}
                      className={`shrink-0 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors md:w-full md:shrink ${
                        on
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <span className="md:hidden">{i + 1}. {t.title || '未命名教程'}</span>
                      <span className="hidden md:block break-words">{i + 1}. {t.title || '未命名教程'}</span>
                    </button>
                  );
                })}
              </div>
            </nav>

            {/* 正文 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
              {active && (
                <article className="space-y-4">
                  <h2 className="text-base font-semibold text-foreground break-words">
                    {active.title || '未命名教程'}
                  </h2>

                  {active.content.trim() && (
                    <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
                      {active.content
                        .split('\n')
                        .filter((line) => line.trim() !== '')
                        .map((line, i) => (
                          <p key={i} className="whitespace-pre-wrap break-words">{line}</p>
                        ))}
                    </div>
                  )}

                  {active.images.length > 0 && (
                    <div className="space-y-3">
                      {active.images.map((url, i) => (
                        <img
                          key={url}
                          src={url}
                          alt={`${active.title}-${i + 1}`}
                          loading="lazy"
                          title="点击查看原图"
                          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                          className="w-full cursor-zoom-in rounded-lg border border-border bg-muted object-contain"
                        />
                      ))}
                    </div>
                  )}

                  {!active.content.trim() && active.images.length === 0 && (
                    <p className="text-xs text-muted-foreground">这篇教程还没有内容</p>
                  )}
                </article>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
