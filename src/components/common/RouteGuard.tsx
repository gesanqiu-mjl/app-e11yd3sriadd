import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { routes } from '@/routes';
import type { Profile, ProfileFeature } from '@/types/index';

/**
 * 需要管理员开通才能访问的页面：
 * 未开通时自动跳到「第一个已开通」的页面（都不行就留在当前页，由页面自己给提示）。
 */
const FEATURE_ROUTES: Array<{ pattern: string; feature: ProfileFeature }> = [
  { pattern: '/', feature: 'can_resources' },
  { pattern: '/links', feature: 'can_shortlink' },
  { pattern: '/sync', feature: 'can_site_sync' },
  { pattern: '/subscribe', feature: 'can_subscriptions' },
];

interface RouteGuardProps {
  children: React.ReactNode;
}

// System-level public routes (no need to register in routes.tsx)
const SYSTEM_PUBLIC_ROUTES = ['/login', '/403', '/404'];

// Derived from routes.tsx: all routes marked with public: true
const routePublicPaths = routes.filter(r => r.public).map(r => r.path);

const PUBLIC_ROUTES = [...SYSTEM_PUBLIC_ROUTES, ...routePublicPaths];

/** 某个功能是否对该账号开通（undefined/null 视为开通，兼容历史数据） */
function featureAllowed(feature: ProfileFeature, profile: Profile | null): boolean {
  if (!profile) return true;
  if (feature === 'can_subscriptions') {
    return profile.can_subscriptions === true || profile.subscriptions_enabled === true;
  }
  return profile[feature] !== false;
}

function matchPublicRoute(path: string, patterns: string[]) {
  return patterns.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return regex.test(path);
    }
    return path === pattern;
  });
}

export function RouteGuard({ children }: RouteGuardProps) {
  const { user, loading, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (loading) return;

    const isPublic = matchPublicRoute(location.pathname, PUBLIC_ROUTES);

    if (!user && !isPublic) {
      navigate('/login', { state: { from: location.pathname }, replace: true });
      return;
    }

    // 受限（订阅专用）账号：用特殊邀请码注册，只允许停留在订阅页与个人中心
    const subOnly = !!user && profile?.role !== 'admin' && profile?.subscription_only === true;
    if (subOnly && !isPublic && location.pathname !== '/subscribe' && location.pathname !== '/profile') {
      navigate('/subscribe', { replace: true });
      return;
    }

    // 功能权限（管理员在「用户管理」里逐项开通）：未开通的页面不允许停留，
    // 自动跳到「第一个已开通」的页面；四个功能都没开通时留在当前页，由页面自己提示。
    if (user && !isPublic && profile && profile.role !== 'admin' && profile.status !== 'disabled') {
      const hit = FEATURE_ROUTES.find(
        (r) => location.pathname === r.pattern || (r.pattern !== '/' && location.pathname.startsWith(r.pattern)),
      );
      if (hit && !featureAllowed(hit.feature, profile)) {
        const firstOk = FEATURE_ROUTES.find((r) => featureAllowed(r.feature, profile));
        if (firstOk && firstOk.pattern !== location.pathname) {
          navigate(firstOk.pattern, { replace: true });
        }
      }
    }
  }, [user, loading, profile, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <>{children}</>;
}