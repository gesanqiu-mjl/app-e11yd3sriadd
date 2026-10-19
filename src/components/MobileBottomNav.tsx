import { Link, useLocation } from 'react-router-dom';
import { Clapperboard, LayoutDashboard, Link2, RefreshCw, Rss, User, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * 手机端底部导航（仅 < md 显示）。
 *
 * 对应设计稿：资源管理 / 短链统计 / 订阅转存 / 个人中心 /（管理员）管理后台。
 * 权限口径与侧边栏完全一致（featureAllowed + 订阅专用账号），
 * 避免手机上出现「点了没权限」的入口；桌面端隐藏，保持原侧边栏体验不变。
 */
interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  feature?: 'can_resources' | 'can_shortlink' | 'can_site_sync' | 'can_subscriptions';
}

const ITEMS: NavItem[] = [
  { label: '资源管理', path: '/', icon: Clapperboard, feature: 'can_resources' },
  { label: '短链统计', path: '/links', icon: Link2, feature: 'can_shortlink' },
  { label: '站点同步', path: '/sync', icon: RefreshCw, feature: 'can_site_sync' },
  { label: '订阅转存', path: '/subscribe', icon: Rss, feature: 'can_subscriptions' },
  { label: '个人中心', path: '/profile', icon: User },
];

export default function MobileBottomNav() {
  const { profile } = useAuth();
  const location = useLocation();
  const isAdmin = profile?.role === 'admin';
  const subOnly = !isAdmin && profile?.subscription_only === true;

  const featureAllowed = (key?: NavItem['feature']) => {
    if (isAdmin || !key) return true;
    if (key === 'can_subscriptions') {
      return profile?.can_subscriptions === true || profile?.subscriptions_enabled === true;
    }
    return profile?.[key] !== false;
  };

  const items = ITEMS.filter((item) => featureAllowed(item.feature));
  const base = subOnly
    ? items.filter((i) => i.path === '/subscribe' || i.path === '/profile')
    : items;
  const navItems: NavItem[] =
    isAdmin && !subOnly ? [...base, { label: '管理后台', path: '/admin', icon: LayoutDashboard }] : base;

  return (
    <nav
      aria-label="底部导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch">
        {navItems.map((item) => {
          const active =
            item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] leading-none transition-colors ${
                active ? 'font-medium text-primary' : 'text-muted-foreground active:bg-muted/60'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
