import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminPage from './pages/AdminPage';
import SyncPage from './pages/SyncPage';
import SubscribePage from './pages/SubscribePage';
import CollectPage from './pages/CollectPage';
import ShortLinkPage from './pages/ShortLinkPage';
import ShortLinkRedirectPage from './pages/ShortLinkRedirectPage';
import ProfilePage from './pages/ProfilePage';
import StagingPage from './pages/StagingPage';
import UpdatesPage from './pages/UpdatesPage';
import type { ReactNode } from 'react';

export interface RouteConfig {
  name: string;
  path: string;
  element: ReactNode;
  visible?: boolean;
  public?: boolean;
}

export const routes: RouteConfig[] = [
  {
    name: '资源管理',
    path: '/',
    element: <HomePage />,
  },
  {
    name: '登录',
    path: '/login',
    element: <LoginPage />,
    public: true,
  },
  {
    name: '注册',
    path: '/register',
    element: <RegisterPage />,
    public: true,
  },
  {
    name: '管理后台',
    path: '/admin',
    element: <AdminPage />,
  },
  {
    // 更新状态：手机端首页「更新状态」按钮跳到这里，展示今天/昨天/前天的更新记录
    // （不进侧边栏菜单，桌面端仍用首页右侧「已更新」面板，避免入口重复）
    name: '更新状态',
    path: '/updates',
    element: <UpdatesPage />,
    visible: false,
  },
  {
    name: '站点同步',
    path: '/sync',
    element: <SyncPage />,
  },
  {
    name: '订阅转存',
    path: '/subscribe',
    element: <SubscribePage />,
  },
  {
    name: '短链统计',
    path: '/links',
    element: <ShortLinkPage />,
  },
  {
    name: '个人中心',
    path: '/profile',
    element: <ProfilePage />,
  },
  {
    name: '暂存空间',
    path: '/staging',
    element: <StagingPage />,
  },
  {
    // 短链兜底跳转（公开、不进菜单）：自有域名未把 /s/*、/go/* 转发到短链函数时由前端接管
    name: '短链跳转',
    path: '/s/*',
    element: <ShortLinkRedirectPage />,
    public: true,
    visible: false,
  },
  {
    name: '短链跳转',
    path: '/go/*',
    element: <ShortLinkRedirectPage />,
    public: true,
    visible: false,
  },
  {
    name: '资源收集',
    path: '/collect',
    element: <CollectPage />,
    public: true,
    visible: false,
  },
];
