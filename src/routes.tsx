import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminPage from './pages/AdminPage';
import SyncPage from './pages/SyncPage';
import CollectPage from './pages/CollectPage';
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
    name: '站点同步',
    path: '/sync',
    element: <SyncPage />,
  },
  {
    name: '资源收集',
    path: '/collect',
    element: <CollectPage />,
    public: true,
    visible: false,
  },
];
