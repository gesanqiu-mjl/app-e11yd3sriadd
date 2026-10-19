import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
// @ts-ignore
import { supabase } from '@/db/supabase';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/types/index';
import { toast } from 'sonner';
import { describeEnsureResult, ensureAllSiteSessions } from '@/lib/siteCredentials';

/**
 * 账号是否已被停用，返回停用原因（未停用返回 null）。
 *
 * 两种停用：
 *   1. 管理员手动禁用（profiles.status = 'disabled'）；
 *   2. 普通账号会员到期 —— 数据库定时任务会把 status 置为 disabled（迁移 00055），
 *      这里再按到期时间兜一层，免得「刚过到期时间、任务还没跑到」的窗口期还能登录。
 * 管理员不受会员到期影响；membership_expires_at = null 表示永久。
 */
export function accountBlockedMessage(profile: Profile | null): string | null {
  if (!profile) return null;
  if (profile.status === 'disabled') return '该账号已被禁用，请联系管理员';
  if (
    profile.role !== 'admin' &&
    profile.membership_expires_at &&
    new Date(profile.membership_expires_at).getTime() <= Date.now()
  ) {
    return '该账号会员已到期，账号已停用；如需继续使用请联系管理员开通';
  }
  return null;
}

/** 自动巡检节流：同一浏览器 10 分钟内不重复巡检（显式登录会强制巡检一次） */
const SITE_CHECK_THROTTLE_MS = 10 * 60 * 1000;
const SITE_CHECK_STORAGE_KEY = 'site-credential:last-check-at';

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('获取用户信息失败:', error);
    return null;
  }
  return data;
}
interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  isMembershipActive: boolean;
  signInWithUsername: (username: string, password: string) => Promise<{ error: Error | null }>;
  signUpWithUsername: (username: string, password: string) => Promise<{ error: Error | null; userId?: string }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ error: Error | null }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const isMembershipActive = profile?.role === 'admin' || (() => {
    if (!profile?.membership_expires_at) return true;
    return new Date(profile.membership_expires_at).getTime() > Date.now();
  })();

  const refreshProfile = async () => {
    if (!user) {
      setProfile(null);
      return;
    }

    const profileData = await getProfile(user.id);
    setProfile(profileData);
  };

  /**
   * 登录后自动巡检各站点账号：会话有效则静默通过，
   * 失效则用云端保存的账号密码自动重新登录，无法自动处理的汇总提示一次。
   */
  const runSiteCheck = useCallback(async (force = false) => {
    try {
      const last = Number(localStorage.getItem(SITE_CHECK_STORAGE_KEY) ?? 0);
      if (!force && Date.now() - last < SITE_CHECK_THROTTLE_MS) return;
      localStorage.setItem(SITE_CHECK_STORAGE_KEY, String(Date.now()));
    } catch {
      /* localStorage 不可用时不做节流 */
    }

    try {
      const result = await ensureAllSiteSessions();
      if (!result?.summary?.checked) return;
      const { auto, attention } = describeEnsureResult(result);
      if (auto) toast.success(auto);
      if (attention) {
        toast.warning('站点账号需要处理', { description: attention, duration: 8000 });
      }
    } catch (e) {
      // 巡检失败不影响正常使用，仅开发期可见
      console.warn('[site-credential] 自动巡检失败：', (e as Error).message);
    }
  }, []);

  useEffect(() => {
    /**
     * 拉取资料后决定「放行 or 登出」：账号被禁用 / 会员到期的普通账号，
     * 即使浏览器里还留着旧会话也一律登出（否则到期账号还能继续用旧登录态）。
     */
    const applyProfileOrSignOut = (userId: string) => {
      getProfile(userId).then((p) => {
        const blocked = accountBlockedMessage(p);
        if (blocked) {
          setProfile(null);
          void supabase.auth.signOut();
          toast.error(blocked, { duration: 8000 });
          return;
        }
        setProfile(p);
      });
    };

    supabase
      .auth
      .getSession()
      // @ts-ignore
      .then(({ data: { session } }) => {
        setUser(session?.user ?? null);
        if (session?.user) {
          applyProfileOrSignOut(session.user.id);
          // 会话恢复时也巡检一次（10 分钟节流）
          void runSiteCheck(false);
        }
      })
      // @ts-ignore
      .catch(error => {
        toast.error(`获取用户信息失败: ${error.message}`);
      })
      .finally(() => {
        setLoading(false);
      });

    // @ts-ignore
    // In this function, do NOT use any await calls. Use `.then()` instead to avoid deadlocks.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        applyProfileOrSignOut(session.user.id);
        // 显式登录时强制巡检一次，不等节流
        if (event === 'SIGNED_IN') void runSiteCheck(true);
      } else {
        setProfile(null);
        try {
          localStorage.removeItem(SITE_CHECK_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    });

    return () => subscription.unsubscribe();
  }, [runSiteCheck]);

  const signInWithUsername = async (username: string, password: string) => {
    try {
      // 用户名可能已被用户自己在「个人中心」改过 → 先解析成该账号当前的登录邮箱；
      // 解析不到（老账号/网络异常）再按注册时的历史规则兜底。
      const { data: resolvedEmail } = await supabase.rpc('resolve_login_email', {
        p_username: username,
      });
      const email =
        (typeof resolvedEmail === 'string' && resolvedEmail.trim()) || `${username}@miaoda.com`;
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      // 检查账号是否被禁用 / 普通账号会员是否已到期（到期即视为停用）
      const { data: userData } = await supabase.auth.getUser();
      if (userData?.user) {
        const profileData = await getProfile(userData.user.id);
        const blocked = accountBlockedMessage(profileData);
        if (blocked) {
          await supabase.auth.signOut();
          throw new Error(blocked);
        }
      }
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signUpWithUsername = async (username: string, password: string) => {
    try {
      const email = `${username}@miaoda.com`;
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username } },
      });

      if (error) throw error;
      return { error: null, userId: data.user?.id };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  };

  /**
   * 修改自己的登录密码。
   *
   * 为什么先 signInWithPassword 验证旧密码：GoTrue 没有「校验密码」的接口，
   * 只凭当前会话就能改密码的话，会话被劫持（共享设备/令牌泄露）即可直接改密；
   * 用旧密码重新登录一次即可确认是本人操作（顺带刷新会话，不影响登录态）。
   */
  const changePassword = async (currentPassword: string, newPassword: string) => {
    try {
      const email = user?.email;
      if (!email) throw new Error('当前登录态缺少账号信息，请退出后重新登录再试');

      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (verifyError) {
        const msg = /invalid login credentials/i.test(verifyError.message)
          ? '当前密码不正确'
          : verifyError.message;
        throw new Error(msg);
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, isMembershipActive, signInWithUsername, signUpWithUsername, signOut, refreshProfile, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
