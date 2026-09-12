export interface Option {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  withCount?: boolean;
}

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface LoginConfig {
  id: number;
  left_bg_color: string;
  left_use_bg_image: boolean;
  left_bg_image_url: string | null;
  left_logo_url: string | null;
  left_title: string;
  left_heading: string;
  left_description: string;
  left_copyright: string;
  right_title: string;
  right_subtitle: string;
  right_btn_text: string;
  /** 教程地址（新窗口打开） */
  tutorial_url: string | null;
  /** 邀请码/激活码获取说明（弹窗展示的多行文本） */
  invite_code_info: string | null;
  updated_at: string;
}

export const LOGIN_CONFIG_DEFAULTS: Omit<LoginConfig, 'id' | 'updated_at'> = {
  left_bg_color: '#1a6b4a',
  left_use_bg_image: false,
  left_bg_image_url: null,
  left_logo_url: null,
  left_title: '资源更新追踪',
  left_heading: '高效追踪每一部剧集的更新',
  left_description: '智能解析、批量导入、自动变更检测。修改即同步到已更新栏，一键复制即可分享。',
  left_copyright: '© 2026 资源更新追踪系统',
  right_title: '欢迎回来',
  right_subtitle: '登录以管理你的剧集资源',
  right_btn_text: '登录',
  tutorial_url: null,
  invite_code_info: null,
};

export interface Profile {
  id: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  role: UserRole;
  status: UserStatus;
  membership_expires_at: string | null;
  created_at: string;
}

export interface PanLink {
  url: string;
  pan_name: string;
  status?: 'valid' | 'invalid' | 'unknown';
  checked_at?: string;
}

export interface Resource {
  id: string;
  name: string;
  episode_count: number;
  link: string;
  links: PanLink[];
  sort_order: number;
  owner_id: string;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
  link_status: 'valid' | 'invalid' | 'partial' | 'unknown';
  link_checked_at: string | null;
  is_finished?: boolean;
}

export type ResourceField = 'name' | 'episode_count' | 'link';

export interface ChangeHistory {
  id: string;
  resource_id: string | null;
  resource_name: string;
  field_name: string;
  field_label: string;
  old_value: string;
  new_value: string;
  changed_at: string;
  user_id: string;
}

// 管理员视图扩展
export interface AdminResource extends Resource {
  owner_name: string | null;
}

export interface AdminHistory extends ChangeHistory {
  username: string | null;
}

export interface UpdatedItem {
  resource: Resource;
  changedAt: Date;
  changedFieldLabel: string;
  /** 站点同步失败信息（有则在已更新面板底部红色标注） */
  syncErrors?: { site: string; reason: string }[];
}

// 邀请码
export interface InviteCode {
  id: string;
  code: string;
  created_by: string | null;
  used_by: string | null;
  used_at: string | null;
  created_at: string;
  is_revoked: boolean;
  membership_days: number;
}

// 盘链账号绑定信息
export interface PinglianBinding {
  status: 'active' | 'expired';
  username: string | null;
  last_check_at: string | null;
  remark: string | null;
  updated_at: string | null;
}

// 盘链发布记录（v4 接口字段）
export interface PinglianLink {
  id: number;
  video_id: number;
  source_link_id: number | null;
  user_id: number;
  username: string | null;
  title: string;
  url: string;
  password: string | null;
  pan_type: string;
  note: string | null;
  is_active: boolean;
  is_system: boolean;
  is_verified: boolean;
  created_at: string | null;
  updated_at: string | null;
  video_title: string | null;
  video_cover: string | null;
}

// 资源与站点剧集绑定关系
export interface ResourceBinding {
  id: string;
  resource_id: string;
  link_id: number;
  link_title: string | null;
  vod_name: string | null;
  pan_type: string | null;
  link_password: string | null;
  created_at: string;
}

// 资源与观影站点分享的绑定关系（一个资源可绑定多条，每条对应一种网盘）
export interface XnResourceBinding {
  id: string;
  resource_id: string;
  share_id: string;       // xn 分享短码
  share_title: string | null;
  share_url: string | null;
  pan_label: string | null;  // 网盘标签（绑定时从分享 URL 自动识别）
  created_at: string;
}

// 观影站点（xn--wcv59z.com）绑定信息
export interface XnBinding {
  status: 'active' | 'expired';
  last_check_at: string | null;
  remark: string | null;
}

// 观影站点分享记录（列式数组转行式后的单条）
export interface XnShare {
  id: string;
  title: string;
  dir: string;
  tname: string | null;
  time: string | null;
  url: string;
  atitle: string | null;
  bindcount: number;
  status: number;
}

// 鸭影臻藏账号绑定信息
export interface YaBinding {
  status: 'active' | 'expired';
  last_check_at: string | null;
  remark: string | null;
}

// 鸭影臻藏账号状态（api_get_account_status 返回）
export interface YaAccountStatus {
  success?: boolean;
  username?: string;
  user_number?: number;
  points?: number;
  consecutive_check_ins?: number;
  member_level?: string;
  member_level_label?: string;
  last_check_in?: string;
  pan_stats?: {
    total_magnet?: number;
    total_drive?: number;
    today_magnet?: number;
    today_drive?: number;
    today_clicks_magnet?: number;
    today_clicks_drive?: number;
  };
  tracking?: { video_id?: number; title?: string; update_day?: string }[];
  formatted?: string;
}

// 鸭影臻藏发布记录（searchVideos 返回的单条资源链接）
export interface YaLink {
  id: number;
  /** 资源链接名称（API 实际字段名 name） */
  name: string | null;
  url: string | null;
  extract_code: string | null;
  /** 网盘类型，如 aliyun / quark / 123 等 */
  drive_type?: string | null;
  /** 网盘中文名称（API 直接返回，优先于本地映射） */
  drive_label?: string | null;
  /** 所属剧集名，由 searchYaVideos 从 video.title 注入 */
  video_title?: string | null;
  /** 所属视频 ID（video.id），用于 addResource 时传递 */
  video_id?: number;
  /** 所属视频分类（video.category） */
  video_category?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

// 资源与鸭影臻藏发布记录的绑定关系（一个资源可绑定多条，每条对应一种网盘）
export interface YaResourceBinding {
  id: string;
  resource_id: string;
  link_id: number;
  link_title: string | null;
  vod_name: string | null;
  pan_label: string | null;  // 网盘标签（绑定时取站点网盘名称）
  created_at: string;
}

// 帧影站点（framehdr.com）账号绑定信息
export interface FramehdrBinding {
  status: 'active' | 'expired';
  last_check_at: string | null;
  remark: string | null;
}

// 帧影站点发布记录（framehdr-proxy list 返回的单条）
export interface FramehdrLink {
  id: number;
  title: string;
  detail_url: string | null;
  drive_name: string | null;
  url: string;
  extract_code: string | null;
  created_at: string | null;
}

// 资源与帧影站点发布记录的绑定关系
export interface FramehdrResourceBinding {
  id: string;
  resource_id: string;
  link_id: number;
  link_title: string | null;
  drive_name: string | null;
  created_at: string;
}

// 123社区（123panfx.com）账号绑定信息
export interface PanfxBinding {
  status: 'active' | 'expired';
  last_check_at: string | null;
  remark: string | null;
}

// 123社区帖子（list 返回的单条）
export interface PanfxPost {
  tid: number;
  fid: string | null;
  subject: string | null;
  posts: number | null;
  views: number | null;
  create_date: number | null;
  last_date: number | null;
  firstpid: number | null;
}

// 资源与 123社区帖子的绑定关系
export interface PanfxResourceBinding {
  id: string;
  resource_id: string;
  tid: number;
  firstpid: number | null;
  subject: string | null;
  fid: string | null;
  created_at: string;
}

// 不太灵站点（web3.mukaku.com / MUKAKU）账号绑定信息
export interface MukakuBinding {
  username: string;
  valid: boolean;
  status: 'active' | 'expired';
  token_expires_at: string | null;
}

// 不太灵站点登录验证码
export interface MukakuCaptcha {
  key: string;
  img: string;
}

// 不太灵站点已发布的网盘资源
export interface MukakuWpResource {
  id: number;
  movies_id: number;
  seed_name: string;
  link: string;
  code?: string | null;
  type?: string | null;
  title?: string | null;
  vod_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

// 不太灵站点片源搜索结果（影视项）
export interface MukakuMovie {
  id?: number;
  doub_id?: string | number;
  title: string;
  pic?: string;
  year?: string | number;
  rate?: string | number;
  actors?: string;
  type?: string;
}

// 资源与不太灵站点发布记录的绑定关系
export interface MukakuResourceBinding {
  id: string;
  resource_id: string;
  link_id: number;
  movies_id: number;
  seed_name: string | null;
  vod_name: string | null;
  pan_type: string | null;
  share_code: string | null;
  created_at: string;
}

export type DisplayFormat = 'all' | 'guangya' | 'quark';

export const FIELD_LABELS: Record<string, string> = {
  name: '资源名称',
  episode_count: '集数',
  link: '链接',
};

export interface NewResourceInput {
  name: string;
  episode_count: number;
  link: string;
  sort_order: number;
}
