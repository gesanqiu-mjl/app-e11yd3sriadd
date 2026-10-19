import React, { useCallback, useRef, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  fetchHdhavenChallenge, submitHdhavenChallenge, HDHAVEN_CHALLENGE_REQUIRED_CODE,
} from '@/services/api';

interface Pending {
  resolve: () => void;
  reject: (reason: Error) => void;
}

/**
 * 栖影风控验证码闭环（接口文档 §5）：
 * 请求命中 SCRAPE_CHALLENGE_REQUIRED 时 → 服务端取图 → 人工识别 5 位字符 → 提交验证 → 自动重放原请求。
 * 站点风控不支持自动绕过，必须人工看图，因此这里用弹窗收集答案。
 *
 * 用法：
 *   const { withChallenge, challengeDialog } = useHdhavenChallenge();
 *   await withChallenge(() => loadHdhavenShares());   // 命中风控会自动弹窗，验证通过后重试一次
 *   // 在 JSX 中渲染 {challengeDialog}
 */
export function useHdhavenChallenge() {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  /** 取一张新验证码图片（图片已由服务端内联为 data URL） */
  const loadImage = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAnswer('');
    try {
      const challenge = await fetchHdhavenChallenge();
      setChallengeId(challenge.id);
      setImage(challenge.image);
    } catch (e) {
      setChallengeId('');
      setImage('');
      setError((e as Error).message || '获取验证码失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  /** 结束等待：error 有值时让调用方感知（如用户取消），否则视为验证通过 */
  const settle = useCallback((reason?: Error) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    if (!pending) return;
    if (reason) pending.reject(reason);
    else pending.resolve();
  }, []);

  /**
   * 包一层站点调用：命中风控门时弹窗等待人工验证，验证通过后重放一次原请求；
   * 其他错误原样抛出。
   */
  const withChallenge = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if ((e as Error & { code?: string }).code !== HDHAVEN_CHALLENGE_REQUIRED_CODE) throw e;
      }
      toast.info('栖影要求完成图形验证码，请在弹窗中填写图片里的 5 位字符');
      setOpen(true);
      await loadImage();
      await new Promise<void>((resolve, reject) => {
        pendingRef.current = { resolve, reject };
      });
      return await fn();
    },
    [loadImage]
  );

  async function handleSubmit() {
    const value = answer.trim();
    if (!challengeId) {
      toast.error('验证码图片尚未就绪，请点击「换一张」重试');
      return;
    }
    if (value.length !== 5) {
      toast.error('请输入图片中的 5 位字符');
      return;
    }
    setSubmitting(true);
    try {
      await submitHdhavenChallenge(challengeId, value);
      toast.success('验证通过，正在重试');
      settle();
    } catch (e) {
      const msg = (e as Error).message || '验证码校验未通过，请重新识别';
      setError(msg);
      toast.error(msg);
      await loadImage(); // 校验失败自动换一张
    } finally {
      setSubmitting(false);
    }
  }

  const challengeDialog = (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) settle(new Error('已取消栖影验证码校验'));
      }}
    >
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-base">
            <ShieldAlert className="h-4 w-4 text-primary shrink-0" />
            栖影风控验证
          </DialogTitle>
          <DialogDescription className="text-xs">
            站点请求过频触发了图形验证码（未执行原操作、不扣积分）。请输入图片中的
            <strong> 5 位字符</strong>，验证通过后会自动重试刚才的操作。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-center h-20 rounded-lg border border-border bg-muted/40 overflow-hidden">
            {loading ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />正在获取验证码…
              </span>
            ) : image ? (
              <img src={image} alt="栖影验证码" className="h-full object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">验证码图片加载失败</span>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
              placeholder="输入 5 位字符"
              maxLength={5}
              autoFocus
              className="h-9 text-sm bg-input border-border tracking-[0.3em] uppercase"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadImage()}
              disabled={loading || submitting}
              className="h-9 shrink-0 text-xs border-border gap-1"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              换一张
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => settle(new Error('已取消栖影验证码校验'))}
            disabled={submitting}
            className="h-8 text-xs border-border"
          >
            取消
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || loading || !challengeId}
            className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}提交验证
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { withChallenge, challengeDialog };
}
