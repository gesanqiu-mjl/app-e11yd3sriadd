import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LayoutDashboard,
  LogOut,
  ChevronDown,
  RefreshCw,
  Clock,
  Rss,
  Link2,
  PanelLeftClose,
  Users,
  Ticket,
  KeyRound,
  Film,
  History,
  Settings2,
  Megaphone,
  BookOpen,
  ImagePlus,
  Clapperboard,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import AnnouncementBar from '@/components/AnnouncementBar';
import MobileBottomNav from '@/components/MobileBottomNav';
import { getLoginConfig } from '@/services/api';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

interface AppLayoutProps {
  children: React.ReactNode;
  /**
   * 把「整屏高度」锁给布局（页面内部自己分配滚动区）。
   * 适用于资源管理这类「列表自己滚、页面不滚」的页面 —— 
   * 用它可以彻底避免 `h-[calc(100vh-3.5rem)]` 这类写死高度：
   * ① 100vh 在 iOS 会被地址栏吃掉一截（改用 100dvh）；② 公告条存在时还要多减 32px，写死必然算错。
   */
  fixedHeight?: boolean;
}

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  feature?: 'can_resources' | 'can_site_sync' | 'can_shortlink' | 'can_subscriptions';
}

/** 管理后台的子菜单（与 AdminPage 的页签一一对应，用 ?tab= 直达） */
const ADMIN_TABS = [
  { label: '用户管理', tab: 'users', icon: Users },
  { label: '邀请码', tab: 'invites', icon: Ticket },
  { label: '订阅源', tab: 'subscription-sources', icon: Rss },
  { label: '登录页配置', tab: 'login-config', icon: Settings2 },
  { label: '公告管理', tab: 'announcements', icon: Megaphone },
  { label: '图文教程', tab: 'tutorials', icon: BookOpen },
  { label: 'API 密钥', tab: 'api-keys', icon: KeyRound },
  { label: '资源与历史', tab: 'resources', icon: Film },
  { label: '修改历史', tab: 'history', icon: History },
];

/** 侧边栏底部「收起菜单 / 展开菜单」（需要 useSidebar 上下文） */
function SidebarCollapse() {
  const { state, toggleSidebar } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="收起菜单" onClick={toggleSidebar}>
          <PanelLeftClose className="h-4 w-4" />
          <span>{state === 'collapsed' ? '展开菜单' : '收起菜单'}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** 账号块：点击后在侧边栏内**就地展开**子菜单（不是弹窗）；折叠成图标栏时点击直接进个人中心 */
function SidebarAccount({
  username,
  isAdmin,
  avatarUrl,
  expiryText,
  expiryClass,
  onSignOut,
}: {
  username: string;
  isAdmin: boolean;
  avatarUrl: string | null;
  expiryText: string;
  expiryClass: string;
  onSignOut: () => void;
}) {
  const { state } = useSidebar();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const collapsed = state === 'collapsed';
  const initial = username.charAt(0).toUpperCase();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          tooltip={username}
          isActive={open && !collapsed}
          onClick={() => (collapsed ? navigate('/profile') : setOpen((v) => !v))}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="头像" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {initial}
            </span>
          )}
          <div className="grid flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{username}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {isAdmin ? '管理员' : '普通用户'}
            </span>
          </div>
          <ChevronDown
            className={`ml-auto h-4 w-4 text-muted-foreground transition-transform group-data-[collapsible=icon]:hidden ${
              open && !collapsed ? 'rotate-180' : ''
            }`}
          />
        </SidebarMenuButton>

        {open && !collapsed && (
          <SidebarMenuSub>
            <SidebarMenuSubItem>
              <div className="flex items-start gap-2 px-2 py-1.5 text-[11px] leading-snug">
                <Clock className={`mt-[1px] h-3 w-3 shrink-0 ${expiryClass}`} />
                <span className="min-w-0">
                  <span className={`block truncate ${expiryClass}`}>{expiryText}</span>
                  {/* 只展示登录名，不展示邮箱 */}
                  <span className="block truncate text-muted-foreground">{username}</span>
                </span>
              </div>
            </SidebarMenuSubItem>
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                asChild
                className="!text-destructive hover:!bg-destructive/10 hover:!text-destructive"
              >
                <button type="button" onClick={onSignOut} className="w-full">
                  <LogOut />
                  <span>退出登录</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          </SidebarMenuSub>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export default function AppLayout({ children, fixedHeight = false }: AppLayoutProps) {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const isAdmin = profile?.role === 'admin';
  const username = profile?.username || '用户';

  /** 侧边栏顶部展示位（管理员在「登录页配置」里填写图片/视频 URL） */
  const [media, setMedia] = useState<{ type: string; url: string | null; link: string | null }>({
    type: 'none',
    url: null,
    link: null,
  });
  useEffect(() => {
    getLoginConfig()
      .then((c) =>
        setMedia({
          type: c.sidebar_media_type || 'none',
          url: c.sidebar_media_url,
          link: c.sidebar_media_link,
        })
      )
      .catch(() => {});
  }, []);
  const mediaUrl = (media.url || '').trim();
  const mediaLink = (media.link || '').trim();
  const hasMedia = media.type !== 'none' && !!mediaUrl;

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  /** 受限（订阅专用）账号：用特殊邀请码注册，只能使用订阅功能 */
  const subOnly = !isAdmin && profile?.subscription_only === true;
  /** 功能权限：管理员始终可用；普通账号按后台开通情况显示（未开通的入口直接不展示） */
  const featureAllowed = (key?: NavItem['feature']) => {
    if (isAdmin || !key) return true;
    if (key === 'can_subscriptions') {
      return profile?.can_subscriptions === true || profile?.subscriptions_enabled === true;
    }
    return profile?.[key] !== false;
  };
  const baseNavItems: NavItem[] = [
    { label: '资源管理', path: '/', icon: Clapperboard, feature: 'can_resources' },
    { label: '短链统计', path: '/links', icon: Link2, feature: 'can_shortlink' },
    { label: '站点同步', path: '/sync', icon: RefreshCw, feature: 'can_site_sync' },
    { label: '订阅转存', path: '/subscribe', icon: Rss, feature: 'can_subscriptions' },
    { label: '管理后台', path: '/admin', icon: LayoutDashboard },
    { label: '个人中心', path: '/profile', icon: User },
  ];
  const allNavItems = baseNavItems.filter((item) => featureAllowed(item.feature));
  // 订阅专用账号只保留「订阅转存」与「个人中心」
  const navItems = subOnly
    ? allNavItems.filter((i) => i.path === '/subscribe' || i.path === '/profile')
    : allNavItems.filter((i) => i.path !== '/admin' || isAdmin);
  const showAdmin = isAdmin && navItems.some((i) => i.path === '/admin');
  const adminTab = searchParams.get('tab') || 'users';
  /** 顶部标题：按当前路由取菜单名 */
  const currentTitle =
    [...navItems].sort((a, b) => b.path.length - a.path.length).find((i) => i.path === location.pathname)?.label ||
    (location.pathname.startsWith('/admin') ? '管理后台' : '网盘推广工具');

  /** 会员状态文案（账号块展开后显示） */
  const expiry = (() => {
    if (isAdmin) return { text: '管理员 · 永久有效', className: 'text-primary' };
    const expires = profile?.membership_expires_at;
    if (!expires) return { text: '会员状态：未设置', className: 'text-muted-foreground' };
    const expired = new Date(expires).getTime() <= Date.now();
    return expired
      ? { text: `会员已过期（${new Date(expires).toLocaleDateString()}）`, className: 'text-destructive' }
      : { text: `会员到期：${new Date(expires).toLocaleDateString()}`, className: 'text-primary' };
  })();

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        {/* 顶部展示位：管理员在「登录页配置」里填图片 / 视频 URL，点开即显示；
            未配置时管理员看到引导入口，普通用户不显示 */}
        <SidebarHeader className="p-2">
          {hasMedia ? (
            <a
              href={mediaLink || undefined}
              target={mediaLink ? '_blank' : undefined}
              rel="noopener noreferrer"
              title={mediaLink ? '打开链接' : undefined}
              className={`block overflow-hidden rounded-xl ring-1 ring-sidebar-border group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:w-8 ${
                mediaLink ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              {media.type === 'video' ? (
                <video
                  src={mediaUrl}
                  className="aspect-video w-full object-cover group-data-[collapsible=icon]:aspect-square"
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : (
                <img
                  src={mediaUrl}
                  alt="侧边栏展示"
                  className="aspect-video w-full object-cover group-data-[collapsible=icon]:aspect-square"
                />
              )}
            </a>
          ) : isAdmin ? (
            <Link
              to="/admin?tab=login-config"
              title="在「登录页配置」里填写图片 / 视频地址"
              className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-sidebar-border text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:aspect-square group-data-[collapsible=icon]:w-8"
            >
              <ImagePlus className="h-4 w-4" />
              <span className="group-data-[collapsible=icon]:hidden">展示位未配置</span>
            </Link>
          ) : null}
        </SidebarHeader>

        {/* 功能菜单 */}
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>功能菜单</SidebarGroupLabel>
            <SidebarMenu>
              {navItems
                .filter((item) => item.path !== '/admin')
                .map((item) => {
                  const active = location.pathname === item.path;
                  return (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                        <Link to={item.path}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              {showAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname.startsWith('/admin')}
                    tooltip="管理后台"
                  >
                    <Link to="/admin">
                      <LayoutDashboard />
                      <span>管理后台</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuSub>
                    {ADMIN_TABS.map((t) => (
                      <SidebarMenuSubItem key={t.tab}>
                        <SidebarMenuSubButton asChild isActive={adminTab === t.tab}>
                          <Link to={`/admin?tab=${t.tab}`}>
                            <t.icon />
                            <span>{t.label}</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        {/* 底部：账号（点开就地展开子菜单） + 收起菜单 */}
        <SidebarFooter className="gap-1">
          <SidebarAccount
            username={username}
            isAdmin={isAdmin}
            avatarUrl={profile?.avatar_url ?? null}
            expiryText={expiry.text}
            expiryClass={expiry.className}
            onSignOut={() => void handleSignOut()}
          />
          <SidebarCollapse />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset
        className={
          fixedHeight
            ? 'flex h-[100dvh] max-h-[100dvh] min-h-0 min-w-0 flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)]'
            : 'min-w-0 bg-background pb-[env(safe-area-inset-bottom)]'
        }
      >
        <AnnouncementBar />
        {/* 顶栏：折叠按钮 + 当前页面（吸顶，手机端按钮放大到易点尺寸） */}
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:px-4">
          <SidebarTrigger className="-ml-1 h-10 w-10 shrink-0 text-muted-foreground hover:text-foreground md:h-8 md:w-8" />
          <span className="truncate text-sm font-semibold text-foreground">{currentTitle}</span>
        </header>
        {/* 手机端底部导航是 fixed 的，给内容留出 56px + 安全区，避免最后一行被导航压住 */}
        <main className="min-h-0 min-w-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </main>
      </SidebarInset>

      {/* 手机端底部导航（设计稿）：桌面端隐藏 */}
      <MobileBottomNav />
    </SidebarProvider>
  );
}
