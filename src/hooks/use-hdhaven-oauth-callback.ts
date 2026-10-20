/**
 * 栖影 OpenAPI OAuth 授权回调处理
 *
 * 背景：站点侧登记的回调地址是站点根路径（https://guangya.xyz.hr），
 * 授权成功后浏览器会带着 ?code=...&state=... 回到根路径，也就是首页 ——
 * 而首页本身并不关心授权。所以这段处理必须挂在 App 全局层，
 * 任何入口进来都能接住，以后改登记地址也不用挪代码。
 *
 * 职责：
 *   · 识别 code + state（授权成功）或 error（用户拒绝 / 站点报错）
 *   · 调边缘函数换 token（PKCE 校验与加密落库都在服务端完成，前端不接触凭据）
 *   · 清掉地址栏参数，避免刷新时重复提交同一个一次性授权码
 *   · 结束后跳到「站点同步」页，让用户直接看到绑定结果
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { finishHdhavenOAuth } from '@/services/api';

/** 授权相关参数（成功 code+state / 失败 error，见 RFC 6749 §4.1.2.1） */
const OAUTH_PARAMS = ['code', 'state', 'error', 'error_description'] as const;

/** 授权结束后统一落到「站点同步」页 */
const AFTER_AUTH_PATH = '/sync';

export function useHdhavenOAuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    const clearParams = () => {
      OAUTH_PARAMS.forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${qs ? `?${qs}` : ''}`
      );
    };

    // 站点侧直接报错（应用被禁用、回调地址不匹配、用户点取消等）
    if (oauthError) {
      toast.error(`栖影授权未完成：${params.get('error_description') || oauthError}`);
      clearParams();
      navigate(AFTER_AUTH_PATH, { replace: true });
      return;
    }
    // 不是授权回调，正常放行
    if (!code || !state) return;

    let cancelled = false;
    (async () => {
      try {
        await finishHdhavenOAuth({ code, state });
        if (cancelled) return;
        toast.success('栖影授权成功，资源更新时将自动同步');
        clearParams();
        navigate(AFTER_AUTH_PATH, { replace: true });
      } catch (e) {
        if (cancelled) return;
        toast.error((e as Error).message || '授权失败，请重新发起授权');
        clearParams();
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);
}