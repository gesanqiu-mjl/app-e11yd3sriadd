import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Loader2, ExternalLink, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 短链兜底跳转页（公开路由 /s/* 与 /go/*）
 *
 * 背景：短链首选形态是「自有域名 + 原链接路径」，例如
 *   https://guangya.xyz.hr/s/1956421372229992464_aeZIFqDoqz15G-J_
 * 如果 nginx 已把 /s/* 转发到短链函数，请求根本不会进到前端（服务端直接 302，最快）。
 * 没配转发时（或想零改动上线），请求会落到前端 index.html，由本页兜底：
 *   带上原路径请求短链函数（json=1）→ 拿到目标地址 → 浏览器跳转。点击同样被计数 ✓
 */
const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/go`;
const CHANNEL_KEYS = ['c', 'ch', 'channel', 'src'];

type ViewState =
  | { kind: 'loading' }
  | { kind: 'code'; title?: string; target: string; extract: string }
  | { kind: 'error'; reason: string };

function reasonText(reason?: string): string {
  if (reason === 'expired') return '该分享链接已过期';
  if (reason === 'disabled') return '该分享链接已被分享者停用';
  if (reason === 'no_target') return '短链没有配置目标地址';
  return '短链不存在或已失效';
}

export default function ShortLinkRedirectPage() {
  const { pathname, search } = useLocation();
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    const qs = new URLSearchParams(search);
    const channel = CHANNEL_KEYS.map((k) => qs.get(k)).find((v) => v && v.trim()) ?? '';
    // 只保留渠道参数，其它参数不带（例如 ?json=1 由这里自己加）
    const target = `${FN}${pathname}?json=1${channel ? `&c=${encodeURIComponent(channel)}` : ''}`;
    let cancelled = false;

    fetch(target, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; reason?: string; target_url?: string; extract_code?: string | null; title?: string | null }
          | null;
        if (cancelled) return;
        if (!data || data.ok !== true || !data.target_url) {
          setState({ kind: 'error', reason: reasonText(data?.reason) });
          return;
        }
        if (data.extract_code) {
          setState({
            kind: 'code',
            target: data.target_url,
            extract: String(data.extract_code),
            title: data.title ?? undefined,
          });
        } else {
          // 无提取码：直接跳转到网盘（本次点击已被服务端计入）
          window.location.replace(data.target_url);
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', reason: '网络异常，请稍后重试' });
      });

    return () => { cancelled = true; };
  }, [pathname, search]);

  // 跳转过程不展示任何本系统信息：loading 时直接渲染空白页（用户只看到"点开就到网盘"）
  if (state.kind === 'loading') {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">

        {state.kind === 'code' && (
          <>
            <p className="text-sm font-medium text-foreground break-words mb-1">
              {state.title || '资源提取'}
            </p>
            <p className="text-xs text-muted-foreground mb-3">提取码（可直接复制粘贴）</p>
            <div className="font-mono text-2xl tracking-[0.2em] rounded-lg border border-dashed border-border bg-muted/40 py-3 mb-4 select-all">
              {state.extract}
            </div>
            <Button
              onClick={() => window.location.replace(state.target)}
              className="w-full gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <ExternalLink className="h-4 w-4" />前往网盘
            </Button>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <AlertTriangle className="h-6 w-6 text-destructive mx-auto mb-3" />
            <p className="text-sm text-foreground">{state.reason}</p>
            <p className="text-xs text-muted-foreground mt-1">请联系分享者重新获取链接</p>
          </>
        )}
      </div>
    </div>
  );
}
