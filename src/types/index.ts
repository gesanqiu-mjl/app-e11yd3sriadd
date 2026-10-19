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
  /** 侧边栏顶部展示位：none 不展示 / image 图片 / video 视频 */
  sidebar_media_type: 'none' | 'image' | 'video';
  /** 展示位的图片或视频地址（留空即不展示） */
  sidebar_media_url: string | null;
  /** 可选：点击展示位跳转的链接 */
  sidebar_media_link: string | null;
  /** 资源管理页顶部横幅图片地址（留空即不展示） */
  home_banner_url: string | null;
  /** 可选：点击顶部横幅跳转的链接 */
  home_banner_link: string | null;
  updated_at: string;
}

export const LOGIN_CONFIG_DEFAULTS: Omit<LoginConfig, 'id' | 'updated_at'> = {
  left_bg_color: '#1a6b4a',
  left_use_bg_image: false,
  left_bg_image_url: null,
  left_logo_url: null,
  left_title: '网盘推广工具',
  left_heading: '高效追踪每一部剧集的更新',
  left_description: '智能解析、批量导入、自动变更检测。修改即同步到已更新栏，一键复制即可分享。',
  left_copyright: '© 2026 网盘推广工具',
  right_title: '欢迎回来',
  right_subtitle: '登录以管理你的剧集资源',
  right_btn_text: '登录',
  tutorial_url: null,
  invite_code_info: null,
  sidebar_media_type: 'none',
  sidebar_media_url: null,
  sidebar_media_link: null,
  home_banner_url: null,
  home_banner_link: null,
};

/**
 * 首页图文教程（管理员维护，前台展示）。
 * images 为图片公开地址数组，按数组顺序展示。
 */
export interface Tutorial {
  id: string;
  title: string;
  /** 正文，按换行分段展示 */
  content: string;
  images: string[];
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  /** 头像地址（存于 avatars bucket；未设置则用用户名首字母占位） */
  avatar_url?: string | null;
  role: UserRole;
  status: UserStatus;
  membership_expires_at: string | null;
  /** 批量发帖权限到期时间：null=未开通，> now()=有效，<= now()=已过期（功能锁定） */
  batch_post_expires_at?: string | null;
  /** 订阅功能权限：是否拥有订阅转存功能（管理员默认可用）。false=未开通，须管理员在后台开启 */
  subscriptions_enabled?: boolean | null;
  /** 受限账号（特殊邀请码注册）：只能使用订阅功能，且只能订阅管理员维护的订阅源 */
  subscription_only?: boolean | null;
  /**
   * 订阅数量上限（管理员按账号设置）：
   * null / undefined 时按账号类型取默认——订阅专用 10 / 普通 80（订阅专用账号的 null 意为「不限」）
   */
  max_subscriptions?: number | null;
  /** 资源条数上限（管理员按账号设置）；null / undefined = 默认 200，管理员账号不受限 */
  max_resources?: number | null;
  /**
   * 功能权限：管理员在「用户管理」里按账号逐项开通/关闭。
   * undefined / null 视为开启（兼容历史数据），只有显式 false 才是关闭；admin 角色始终可用。
   */
  can_resources?: boolean | null;
  can_site_sync?: boolean | null;
  can_shortlink?: boolean | null;
  can_subscriptions?: boolean | null;
  created_at: string;
}

/** 可由管理员授权的功能项 */
export type ProfileFeature = 'can_resources' | 'can_site_sync' | 'can_shortlink' | 'can_subscriptions';

export const FEATURE_LABELS: Record<ProfileFeature, string> = {
  can_resources: '资源管理',
  can_site_sync: '站点同步',
  can_shortlink: '短链管理',
  can_subscriptions: '订阅转存',
};

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
  /** 特殊邀请码：永久有效，注册出来的账号只能使用订阅功能（且只能订阅管理员维护的订阅源，最多 10 个） */
  is_special?: boolean;
}

/**
 * 管理员「资源管理」里**更新中**资源的网盘链接：受限账号的订阅源就从这里选。
 * 同一个资源可能返回多行（光鸭 + 夸克 + 百度），由用户按自己绑定的网盘挑。
 */
export interface AdminResourceSource {
  resource_id: string;
  /** 资源名（含集数等信息，直接作为订阅名） */
  name: string;
  episode_count: number;
  pan: 'guangya' | 'quark' | 'baidu' | 'xunlei' | 'uc' | 'p123';
  url: string;
  /** 链接有效性（链接检测结果）：valid / invalid / unknown */
  link_status: string;
  is_finished: boolean;
  updated_at: string;
}

// 订阅源（管理员维护；受限账号只能从这里选订阅链接）
export interface SubscriptionSource {
  id: string;
  name: string;
  note: string | null;
  source_url: string;
  source_type: 'auto' | 'rss' | 'page' | 'pan_share';
  source_passcode: string | null;
  keyword: string | null;
  pan: 'guangya' | 'quark' | 'baidu' | 'xunlei' | 'uc' | 'p123';
  clean_mode: 'none' | 'episode';
  interval_minutes: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 新建/编辑订阅源时可提交的字段 */
export type SubscriptionSourceInput = Omit<SubscriptionSource, 'id' | 'created_at' | 'updated_at'>;

// 开放接口密钥（管理员在「API 管理」创建，供第三方程序调用 /functions/v1/resource-api）
export interface ApiKey {
  id: string;
  /** 应用 / 用途名称 */
  name: string;
  /** 密钥明文（rk_ 开头），仅管理员可见 */
  api_key: string;
  remark: string | null;
  is_active: boolean;
  /** 到期时间，null 表示永久有效 */
  expires_at: string | null;
  /** 归属账号：开放接口默认只返回该账号名下的资源 */
  owner_id: string;
  /**
   * 数据范围：owner=仅归属账号（默认）；
   * all=全部账号 —— 「订阅入库通知」接口（/subscriptions）可跨账号查询，管理员用它做统一通知。
   */
  scope: 'owner' | 'all';
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  call_count: number;
  last_ip: string | null;
}

// 盘链账号绑定信息
export interface PinglianBinding {
  status: 'active' | 'expired';
  username: string | null;
  last_check_at: string | null;
  remark: string | null;
  updated_at: string | null;
}

/** 盘链图形验证码（GET /api/auth/captcha）：id 用于登录提交，image 为 base64 PNG，ttl 为有效期秒数 */
export interface PinglianCaptcha {
  id: string;
  image: string;
  ttl: number;
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
  /** 所属视频封面（video.cover_url，鸭影站点片源海报） */
  video_cover?: string | null;
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

// 聚影站点（www.jying.top）账号绑定信息
export interface JyingBinding {
  status: 'active' | 'expired';
  username: string | null;
  last_check_at: string | null;
  remark: string | null;
  updated_at: string | null;
}

/** 聚影「我的分享」条目（资源条目维度，来自 my_shares 扁平化结果） */
export interface JyingShareItem {
  id: number;                 // 聚影资源条目 ID（update 用的 link_id）
  movie_id: number;           // 所属影片 ID
  movie_title: string | null;
  movie_cover: string | null;
  release_year: number | null;
  movie_type: string | null;
  title: string | null;       // 资源标题
  share_link: string | null;  // 站点上的真实分享链接
  link_hidden_reason: string | null;
  resource_type: string | null;          // quark / guangya ...
  resource_type_display: string | null;  // 夸克网盘 / 光鸭网盘
  can_edit: boolean;
}

/** 聚影全站片库检索结果（search_movies） */
export interface JyingMovie {
  id: number;
  title: string;
  description?: string | null;
  cover?: string | null;
  backdrop_url?: string | null;
  release_year?: number | null;
  movie_type?: string | null;
  movie_type_display?: string | null;
}

// 资源与聚影分享条目的绑定关系（一个资源可绑定多条，每条对应一种网盘）
export interface JyingResourceBinding {
  id: string;
  resource_id: string;
  link_id: number;
  movie_id: number | null;
  link_title: string | null;
  vod_name: string | null;
  pan_label: string | null;
  created_at: string;
}

// 栖影 HDHaven（hdhaven.com）账号绑定信息
export interface HdhavenBinding {
  status: 'active' | 'expired';
  username: string | null;
  user_number: number | null;
  last_check_at: string | null;
  remark: string | null;
  updated_at: string | null;
}

/** 栖影「我的分享」条目（OpenAPI GET /shares，自动翻页聚合） */
export interface HdhavenShareItem {
  slug: string;                       // 分享条目标识（update 用）
  tmdb_id: string | null;
  media_type: string | null;          // movie / tv
  title: string | null;               // 分享标题（通常含年份）
  pan_type: string | null;            // 站点网盘类型：guangya / 115 / 123 / ed2k
  share_size: string | null;
  episode_range: string | null;
  file_count: number | null;
  remark: string | null;
  hide_link: boolean | null;
  validate_status: string | null;
  review_status: string | null;
  created_at: string | null;
  updated_at: string | null;
  media_title: string | null;
  poster_path: string | null;
  /** 分享链接与提取码：仅详情接口（/shares/{slug}）返回 */
  url?: string | null;
  access_code?: string | null;
}

/** 栖影片源检索结果（TMDB 原生结构） */
export interface HdhavenTmdbItem {
  id: number;
  title?: string | null;              // 电影标题
  name?: string | null;               // 剧集标题
  media_type?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  poster_path?: string | null;
  overview?: string | null;
}

// 资源与栖影分享条目的绑定关系（一个资源可绑定多条，每条对应一种网盘）
export interface HdhavenResourceBinding {
  id: string;
  resource_id: string;
  slug: string;
  tmdb_id: string | null;
  media_type: string | null;
  link_title: string | null;
  vod_name: string | null;
  pan_type: string | null;
  pan_label: string | null;
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

/** 「1号站点」绑定：开放 API 令牌型（用户在站点「开放API」标签生成 pat_ 令牌后填入） */
export interface St1Binding {
  /** 站点地址（不含 /api/open）；服务端配了 ST1_BASE_URL 时为空 */
  base_url: string | null;
  /** 令牌对应的站点用户名（GET /profile 得到，仅展示） */
  username: string | null;
  /** 默认发布分类 id（站点 /categories 的 id） */
  default_category_id: string | null;
  status: 'active' | 'expired';
  last_error: string | null;
  last_check_at: string | null;
}

/** 「1号站点」片源绑定：本地资源 ↔ 站点片源 */
export interface St1ResourceBinding {
  id: string;
  resource_id: string;
  remote_id: string;
  remote_url: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}
