import React, { useState, useEffect, useId } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Search,
  Loader2,
  Sparkles,
  Film,
  CheckCircle2,
  Star,
  Calendar,
  Layers,
  Link as LinkIcon,
  AlertCircle,
  Tv,
  Plus,
  Trash2,
  ExternalLink,
  Info,
  Share2,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  searchMukakuMovies,
  getMukakuMovieDetail,
  addMukakuResource,
  bindResourceToMukaku,
  getMukakuStatus,
  searchYaVideos,
  yaAddResource,
  bindResourceToYa,
  yaGetAccountStatus,
  searchXnVideos,
  addXnShare,
  searchFramehdrResources,
  addFramehdrLink,
  searchJyingMovies,
  addJyingResource,
  bindResourceToJying,
  getJyingBinding,
} from '@/services/api';
import type { Resource, MukakuMovie, YaLink, JyingMovie } from '@/types/index';
import type { XnSearchItem, FramehdrSearchItem } from '@/services/api';
import { detectPanName } from '@/lib/panUtils';
import { SITE_URLS, siteHost } from '@/lib/siteCredentials';

export type SiteSourceType = 'mukaku' | 'ya' | 'framehdr' | 'xn' | 'panfx' | 'jying';

export interface SiteBindingPayload {
  site: SiteSourceType;
  /** 站点侧记录 ID：mukaku / ya 为数字；观影小牛改用 share_id */
  link_id?: number;
  movies_id?: number;
  video_id?: number;
  vod_name?: string;
  pan_type?: string;
  code?: string;
  /** 该条绑定对应的本地网盘链接：本地按 URL 识别网盘名，
   *  避免用站点侧类型代码（如鸭影对光鸭返回的 others）导致同步时匹配失败 */
  pan_url?: string;
  /** 观影小牛：站点分享短码 ID */
  share_id?: string;
  /** 分享标题（观影小牛落库使用） */
  link_title?: string;
  /** 分享外链（观影小牛落库使用） */
  share_url?: string;
}

export interface SelectedPanLinkItem {
  id: string;
  url: string;
  pan_name: string;
  extract_code?: string;
  source_title?: string;
  checked: boolean;
  /** 按站点独立记忆的勾选状态：{ [siteId]: boolean }；未记录的站点回退到 checked */
  checkedSites?: Record<string, boolean>;
}

interface QuickBindDialogProps {
  resource: Resource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 更新当前行资源（siteBindings：首条 + 队列各条的站点发布绑定，全部落地到当前行）
  onUpdateCurrent: (
    resourceId: string,
    filledName: string,
    filledLink: string,
    coverUrl?: string | null,
    siteBindings?: SiteBindingPayload[]
  ) => Promise<void>;
}

const SITE_OPTIONS: Array<{
  id: SiteSourceType;
  label: string;
  badge: string;
  desc: string;
  supported: boolean;
}> = [
  { id: 'mukaku', label: '不太灵片库', badge: '一键发布', desc: '站内全网片库检索，支持自动发布网盘资源并挂载', supported: true },
  { id: 'framehdr', label: '帧影', badge: '豆瓣片库', desc: '基于帧影站内豆瓣源检索影片条目', supported: true },
  { id: 'xn', label: '观影片库', badge: '搜索提示', desc: '基于片库站内搜索联想片源', supported: true },
  { id: 'panfx', label: '123社区', badge: '仅发帖', desc: '暂未提供全网片源检索接口，仅支持帖子管理', supported: false },
  { id: 'jying', label: '聚影', badge: '云端片库', desc: '检索聚影全站片库，支持在该影片下自动新增网盘分享', supported: true },
];

/** 智能清洗关键词（去掉括号年份、集数、画质等），用于搜索站点片库 */
function cleanSearchQuery(raw?: string | null): string {
  if (!raw) return '';
  let s = raw.trim();
  s = s.replace(/^[\[【《][^\]】》]+[\]】》]\s*/, '');
  s = s.replace(/[\(（]\s*(19|20)\d{2}\s*[\)）]/g, ' ');
  s = s.replace(/更新至\s*第?\s*\d+\s*[集话期]/g, ' ');
  s = s.replace(/第?\s*\d+\s*[集话期]/g, ' ');
  s = s.replace(/(4K|1080P|2160P|SDR|HDR|纯净版|高码率|无水印|国粤双语|内嵌中字).*/i, ' ');
  s = s.replace(/[《》【】\[\]]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim() || raw.trim();
}

/** 从多行纯文本中解析出网盘链接列表 */
function parseMultiLinesToLinks(text: string): SelectedPanLinkItem[] {
  if (!text.trim()) return [];
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const results: SelectedPanLinkItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const urlMatch = line.match(/https?:\/\/[^\s"'<>]+/i);
    if (!urlMatch) continue;
    let url = urlMatch[0];

    let code = '';
    const codeMatch = line.match(/(?:提取码|pwd|code|密码)[：:\s]*([a-zA-Z0-9]{4,6})/i);
    if (codeMatch) {
      code = codeMatch[1];
    } else {
      const urlPwdMatch = url.match(/[?&]pwd=([a-zA-Z0-9]{4,6})/i);
      if (urlPwdMatch) code = urlPwdMatch[1];
    }

    if (code && url.includes(`?pwd=${code}`)) {
      url = url.split('?pwd=')[0];
    }

    results.push({
      id: `paste-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      url,
      pan_name: detectPanName(url),
      extract_code: code,
      checked: true,
    });
  }
  return results;
}

/**
 * 某条网盘链接对指定站点的勾选状态。
 * 各站点互相独立：站点未单独设置过时回退到默认 checked，
 * 这样用户可以「只把光鸭云盘发给帧影、把全部链接发给鸭影」而互不影响。
 */
function isLinkCheckedForSite(item: SelectedPanLinkItem, site: SiteSourceType): boolean {
  return item.checkedSites?.[site] ?? item.checked;
}

export default function QuickBindDialog({
  resource,
  open,
  onOpenChange,
  onUpdateCurrent,
}: QuickBindDialogProps) {
  const queryInputId = useId();
  const titleInputId = useId();
  const [selectedSite, setSelectedSite] = useState<SiteSourceType>('mukaku');
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);

  // 搜索结果列表
  const [mukakuMovies, setMukakuMovies] = useState<MukakuMovie[]>([]);
  const [yaLinks, setYaLinks] = useState<YaLink[]>([]);
  const [xnVideos, setXnVideos] = useState<XnSearchItem[]>([]);
  const [framehdrResults, setFramehdrResults] = useState<FramehdrSearchItem[]>([]);
  const [jyingShares, setJyingShares] = useState<JyingMovie[]>([]);

  // 选中的片源
  const [selectedMovie, setSelectedMovie] = useState<MukakuMovie | null>(null);
  const [selectedYa, setSelectedYa] = useState<YaLink | null>(null);
  const [selectedXn, setSelectedXn] = useState<XnSearchItem | null>(null);
  const [selectedFramehdr, setSelectedFramehdr] = useState<FramehdrSearchItem | null>(null);
  const [selectedJying, setSelectedJying] = useState<JyingMovie | null>(null);

  // 回填设置与发布表单
  const [targetName, setTargetName] = useState('');
  const [selectedCover, setSelectedCover] = useState<string | null>(null);
  const [panLinks, setPanLinks] = useState<SelectedPanLinkItem[]>([]);
  const [publishToSite, setPublishToSite] = useState(true);
  // 当前资源是否已有自己的网盘链接（打开弹窗时判定）
  const [resourceHasOwnLink, setResourceHasOwnLink] = useState(false);
  // 本次弹窗内各站点已发布的条数，用于「连续向多站点发布」时给出完成反馈
  const [publishedSites, setPublishedSites] = useState<Record<string, number>>({});

  // 快速录入单条或多条网盘
  const [newSingleUrl, setNewSingleUrl] = useState('');
  const [newSingleCode, setNewSingleCode] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [showPasteBox, setShowPasteBox] = useState(false);

  // 站点绑定状态检测
  const [siteBindStatus, setSiteBindStatus] = useState<{
    mukakuBound: boolean;
    yaBound: boolean;
    jyingBound: boolean;
  }>({ mukakuBound: false, yaBound: false, jyingBound: false });

  // 队列回填与发布执行状态
  const [queueProgress, setQueueProgress] = useState<{
    running: boolean;
    current: number;
    total: number;
    statusText: string;
  }>({ running: false, current: 0, total: 0, statusText: '' });

  // 弹窗打开时重置状态
  useEffect(() => {
    if (open && resource) {
      const cleanKw = cleanSearchQuery(resource.name);
      setKeyword(cleanKw || resource.name);
      setTargetName(resource.name);
      setSelectedCover(resource.cover_url ?? null);

      const existingLinks: SelectedPanLinkItem[] = [];
      if (resource.links && resource.links.length > 0) {
        resource.links.forEach((l, idx) => {
          if (l.url) {
            existingLinks.push({
              id: `exist-${idx}`,
              url: l.url,
              pan_name: l.pan_name || detectPanName(l.url),
              checked: true,
            });
          }
        });
      } else if (resource.link) {
        existingLinks.push({
          id: 'exist-single',
          url: resource.link,
          pan_name: detectPanName(resource.link),
          checked: true,
        });
      }
      setPanLinks(existingLinks);
      setResourceHasOwnLink(existingLinks.length > 0);
      setPublishedSites({});
      setSelectedMovie(null);
      setSelectedYa(null);
      setSelectedXn(null);
      setNewSingleUrl('');
      setNewSingleCode('');
      setPasteText('');
      setShowPasteBox(false);

      // 查询站点凭据绑定状态
      checkSiteBindings();

      // 自动执行一次搜索
      doSearch(cleanKw || resource.name, selectedSite);
    }
  }, [open, resource]);

  async function checkSiteBindings() {
    try {
      const [mStatus, yStatus, jStatus] = await Promise.allSettled([
        getMukakuStatus(),
        yaGetAccountStatus(),
        getJyingBinding(),
      ]);
      setSiteBindStatus({
        mukakuBound: mStatus.status === 'fulfilled' && (mStatus.value?.valid === true || mStatus.value?.status === 'active'),
        yaBound: yStatus.status === 'fulfilled' && yStatus.value?.success === true,
        jyingBound: jStatus.status === 'fulfilled' && jStatus.value?.status === 'active',
      });
    } catch {
      // 容错忽略
    }
  }

  // 站点切换
  function handleSelectSite(site: SiteSourceType) {
    setSelectedSite(site);
    setSelectedMovie(null);
    setSelectedYa(null);
    setSelectedXn(null);
    if (keyword.trim()) {
      doSearch(keyword.trim(), site);
    }
  }

  // 执行搜索
  async function doSearch(kw: string, site: SiteSourceType) {
    const q = kw.trim();
    if (!q) {
      toast.error('请输入片源名称进行搜索');
      return;
    }
    setSearching(true);
    try {
      if (site === 'mukaku') {
        const list = await searchMukakuMovies(q);
        setMukakuMovies(list);
        if (list.length === 0) {
          toast.info(`未在不太灵片库搜到「${q}」，可尝试去除年份或缩短关键词`);
        }
      } else if (site === 'ya') {
        // includeNoLink：片源存在但本人尚未在其下发布过链接时也要列出，
        // 否则「搜索片源 → 在该片源下发布资源」这条链路会全程搜不到任何结果
        const list = await searchYaVideos(q, { includeNoLink: true });
        setYaLinks(list);
        if (list.length === 0) {
          toast.info(`未在鸭影臻藏搜到「${q}」，可尝试去掉年份或精简关键词`);
        }
      } else if (site === 'xn') {
        const list = await searchXnVideos(q);
        setXnVideos(list);
        if (list.length === 0) {
          toast.info(`未在观影片库搜到「${q}」，可尝试去除年份或缩短关键词`);
        }
      } else if (site === 'framehdr') {
        const list = await searchFramehdrResources(q);
        setFramehdrResults(list);
        if (list.length === 0) {
          toast.info(`未在帧影片库搜到「${q}」，可尝试精简关键词`);
        }
      } else if (site === 'jying') {
        // 聚影支持「搜全站片库 → 在该影片下新增分享」，检索走全站影片库
        const list = await searchJyingMovies(q);
        setJyingShares(list);
        if (list.length === 0) {
          toast.info(`未在聚影片库搜到「${q}」，可尝试去掉年份或精简关键词`);
        }
      } else if (site === 'panfx') {
        toast.info('123社区仅支持论坛帖子发布管理，暂无全局片库检索 API');
      } else {
        const label = SITE_OPTIONS.find((s) => s.id === site)?.label ?? site;
        toast.info(`【${label}】暂支持作为同步目标，正在丰富片库检索通道`);
      }
    } catch (e: any) {
      console.error('搜索站点片源异常', e);
      toast.error(e?.message || '搜索片源失败，请重试');
    } finally {
      setSearching(false);
    }
  }

  // 选中某部不太灵影片
  // 注意：不覆盖「资源标题」——该字段始终以资源名称为准；选中片源只更新选中态与封面
  async function handlePickMukakuMovie(movie: MukakuMovie) {
    setSelectedMovie(movie);

    if (movie.pic) {
      setSelectedCover(movie.pic);
    }

    toast.success(`已选定《${movie.title}》，资源标题保持为资源名称`);
  }

  // 选中某部鸭影片源（不覆盖「资源标题」，标题始终以资源名称为准）
  function handlePickYaVideo(item: YaLink) {
    setSelectedYa(item);
    if (item.video_cover) setSelectedCover(item.video_cover);
    const title = item.video_title || item.name || '';

    // 资源已有自己的网盘链接时，站点片源仅作为发布目标，不再把站点链接塞进回填列表，
    // 否则会形成「第 2 条链接」进而触发队列追加新行
    if (item.url && !resourceHasOwnLink) {
      const validUrl = item.url;
      setPanLinks((prev) => {
        const exists = prev.some((l) => l.url === validUrl);
        if (exists) return prev;
        return [
          {
            id: `ya-${item.id || Date.now()}`,
            url: validUrl,
            pan_name: item.drive_label || detectPanName(validUrl),
            extract_code: item.extract_code || '',
            checked: true,
          },
          ...prev,
        ];
      });
    }
    toast.success(`已选定鸭影《${title}》`);
  }

  // 选中观影小牛片源（不覆盖「资源标题」）
  // 联想结果只含 dir + id，发布分享时作为 binds[][dir] / binds[][id] 使用
  // 选中帧影片源（不覆盖「资源标题」，标题始终以资源名称为准）
  function handlePickFramehdr(item: FramehdrSearchItem) {
    setSelectedFramehdr(item);
    if (item.cover) setSelectedCover(item.cover);
    toast.success(`已选定帧影片源《${item.title}》`);
  }

  // 选中聚影片源（聚影支持在该影片下新增分享；不覆盖资源标题）
  function handlePickJying(item: JyingMovie) {
    setSelectedJying(item);
    if (item.cover) setSelectedCover(item.cover);
    toast.success(`已选定聚影片源《${item.title}》，发布时将在该影片下新增分享`);
  }

  function handlePickXnVideo(item: XnSearchItem) {
    setSelectedXn(item);
    if (item.cover) setSelectedCover(item.cover);
    toast.success(`已选定观影片库片源《${item.title}》`);
  }

  // 快速添加单条网盘链接（完全还原用户提供的弹窗元素：链接、粘贴识别、分享码）
  function handleAddSingleLink() {
    const raw = newSingleUrl.trim();
    if (!raw) {
      toast.error('请填写网盘链接');
      return;
    }
    const urlMatch = raw.match(/https?:\/\/[^\s"'<>]+/i);
    const cleanUrl = urlMatch ? urlMatch[0] : raw;
    let code = newSingleCode.trim();

    if (!code) {
      const codeMatch = raw.match(/(?:提取码|pwd|code|密码)[：:\s]*([a-zA-Z0-9]{4,6})/i);
      if (codeMatch) code = codeMatch[1];
    }

    setPanLinks((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        url: cleanUrl,
        pan_name: detectPanName(cleanUrl),
        extract_code: code,
        checked: true,
      },
    ]);
    setNewSingleUrl('');
    setNewSingleCode('');
    toast.success('已添加网盘链接至回填列表');
  }

  // 智能粘贴识别剪贴板或多行文本
  function handleApplyPastedLinks() {
    const items = parseMultiLinesToLinks(pasteText);
    if (items.length === 0) {
      toast.error('未识别到有效的网盘分享链接');
      return;
    }
    setPanLinks((prev) => [...prev, ...items]);
    setPasteText('');
    setShowPasteBox(false);
    toast.success(`已成功解析添加 ${items.length} 条网盘链接`);
  }

  // 切换链接勾选状态（只影响当前选中的站点，其它站点保持各自的选择）
  function toggleLinkChecked(id: string) {
    setPanLinks((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              checkedSites: {
                ...(l.checkedSites ?? {}),
                [selectedSite]: !isLinkCheckedForSite(l, selectedSite),
              },
            }
          : l
      )
    );
  }

  // 移除某条链接
  function removeLinkItem(id: string) {
    setPanLinks((prev) => prev.filter((l) => l.id !== id));
  }

  // 当前站点下勾选的有效链接列表（各站点的勾选互相独立）
  const activeCheckedLinks = panLinks.filter(
    (l) => isLinkCheckedForSite(l, selectedSite) && l.url.trim()
  );

  // 核心：点击确认并回填（同时自动发布到目标站点网盘资源库）
  async function handleConfirmAndPublish() {
    if (!resource) return;
    const finalName = targetName.trim();
    if (!finalName) {
      toast.error('请填写资源标题');
      return;
    }
    if (activeCheckedLinks.length === 0) {
      toast.error('请至少勾选或添加 1 条网盘链接');
      return;
    }

    // 检查站点凭证与自动发布条件
    let shouldPublish = publishToSite;
    if (shouldPublish) {
      if (selectedSite === 'mukaku' && !siteBindStatus.mukakuBound) {
        toast.warning('检测到尚未绑定不太灵账号，将进行本地回填。若需自动发布至站点，请先前往「站点同步」页登录不太灵。');
        shouldPublish = false;
      } else if (selectedSite === 'ya' && !siteBindStatus.yaBound) {
        toast.warning('检测到鸭影凭证已过期，将进行本地回填。若需自动发布至站点，请先前往「站点同步」页重新登录。');
        shouldPublish = false;
      } else if (selectedSite === 'ya' && !selectedYa) {
        // 站点 add 接口的 p_title 必须是「站内片源名」，未选片源无法定位目标
        toast.warning('请先在上方搜索并选择鸭影臻藏的【目标片源】，再点击发布');
        shouldPublish = false;
      } else if (selectedSite === 'jying' && !siteBindStatus.jyingBound) {
        toast.warning('检测到尚未绑定聚影账号，将仅做本地回填。若需自动发布分享，请先前往「站点同步」页登录聚影。');
        shouldPublish = false;
      } else if (selectedSite === 'jying' && !selectedJying) {
        // 聚影需先定位目标影片，未选片源无法在该影片下新增分享
        toast.warning('请先在上方搜索并选择聚影的【目标片源】，再点击发布');
        shouldPublish = false;
      }
    }

    setQueueProgress({
      running: true,
      current: 0,
      total: activeCheckedLinks.length,
      statusText: '正在准备回填并发布资源…',
    });

    try {
      // 1. 若选的是不太灵且需要发布，预先解析好 movies_id
      let mukakuMoviesId: number | null = null;
      if (shouldPublish && selectedSite === 'mukaku') {
        if (selectedMovie?.id) {
          mukakuMoviesId = Number(selectedMovie.id);
        } else if (selectedMovie?.doub_id) {
          setQueueProgress((p) => ({ ...p, statusText: '正在获取不太灵影视主键…' }));
          const d = await getMukakuMovieDetail(selectedMovie.doub_id);
          mukakuMoviesId = d.movies_id;
        }
      }

      // 2. 处理第 1 条链接：回填当前行 + 站点发布
      const firstLink = activeCheckedLinks[0];
      setQueueProgress({
        running: true,
        current: 1,
        total: activeCheckedLinks.length,
        statusText: shouldPublish
          ? `正在向【${SITE_OPTIONS.find((s) => s.id === selectedSite)?.label}】发布第 1 条网盘资源…`
          : '正在回填当前行数据…',
      });

      let firstBinding: SiteBindingPayload | undefined;
      // 实际发布成功的条数（首条 + 队列各条累加）。
      // 用于收尾提示如实反映结果：站点失败/限流时不能仍提示「全部成功」。
      let publishedCount = 0;
      // 队列各条发布失败的次数（首条失败由各自 toast.error 单独提示）
      let failedCount = 0;
      if (shouldPublish) {
        if (selectedSite === 'mukaku' && mukakuMoviesId) {
          try {
            const addRes = await addMukakuResource({
              movies_id: mukakuMoviesId,
              seed_name: finalName,
              link: firstLink.url,
              code: firstLink.extract_code || '',
            });
            if (addRes.created_id) {
              firstBinding = {
                site: 'mukaku',
                link_id: addRes.created_id,
                movies_id: mukakuMoviesId,
                vod_name: selectedMovie?.title || finalName,
                pan_type: addRes.pan_type,
                code: firstLink.extract_code,
              };
            }
            publishedCount += 1;
          } catch (pubErr: any) {
            console.warn('发布到不太灵失败，降级本地回填', pubErr);
            failedCount += 1;
            toast.error(`发布至不太灵失败: ${pubErr?.message || '未知错误'}，已保留本地回填`);
          }
        } else if (selectedSite === 'ya') {
          try {
            // api_add_resource 的 p_title 必须是「站内片源名」，而不是资源名，
            // 否则站点会报「片源不存在」；category 同样以选中的片源为准
            const yaRes = await yaAddResource({
              title: selectedYa?.video_title || finalName,
              category: selectedYa?.video_category || '电视剧',
              name: finalName,
              url: firstLink.url,
              extractCode: firstLink.extract_code,
            });
            if (yaRes?.link_id) {
              firstBinding = {
                site: 'ya',
                link_id: yaRes.link_id,
                video_id: yaRes.video_id,
                vod_name: selectedYa?.video_title || finalName,
                pan_type: yaRes.drive_type,
                pan_url: firstLink.url,
                code: firstLink.extract_code,
              };
            }
            publishedCount += 1;
          } catch (yaErr: any) {
            console.warn('发布到鸭影失败', yaErr);
            failedCount += 1;
            toast.error(`发布至鸭影失败: ${yaErr?.message || '未知错误'}`);
          }
        } else if (selectedSite === 'framehdr' && selectedFramehdr) {
          try {
            // 帧影发布到指定片源：resource_id 为站点影片 ID，name 为网盘类型
            const fhRes = await addFramehdrLink({
              resourceId: selectedFramehdr.id,
              url: firstLink.url,
              name: detectPanName(firstLink.url) || '光鸭云盘',
              password: firstLink.extract_code,
              // 站点「资源介绍」字段填写资源名称
              description: finalName,
            });
            if (fhRes?.link_id) {
              firstBinding = {
                site: 'framehdr',
                link_id: fhRes.link_id,
                vod_name: selectedFramehdr.title,
                pan_type: detectPanName(firstLink.url) || undefined,
                code: firstLink.extract_code,
              };
            } else {
              toast.warning('已发布到帧影，但未能取回链接 ID，请手动绑定该资源');
            }
            publishedCount += 1;
          } catch (fhErr: any) {
            console.warn('发布到帧影失败', fhErr);
            failedCount += 1;
            toast.error(`发布至帧影失败: ${fhErr?.message || '未知错误'}`);
          }
        } else if (selectedSite === 'jying' && selectedJying) {
          try {
            // 聚影：在选中影片下新增分享。网盘类型由站点按链接自动识别，
            // 故直接用第 1 条勾选链接发布，成功后以返回的资源 ID 落地绑定
            const addRes = await addJyingResource({
              movieId: selectedJying.id,
              shareLink: firstLink.url,
              description: finalName,
              extractionCode: firstLink.extract_code,
            });
            if (addRes.id) {
              firstBinding = {
                site: 'jying',
                link_id: addRes.id,
                vod_name: selectedJying.title,
                link_title: finalName,
                pan_url: firstLink.url,
                code: firstLink.extract_code,
              };
            } else {
              toast.warning('已发布到聚影，但未能取回资源 ID，请手动绑定该资源');
            }
            publishedCount += 1;
          } catch (jyErr: any) {
            console.warn('发布到聚影失败', jyErr);
            failedCount += 1;
            toast.error(`发布至聚影失败: ${jyErr?.message || '未知错误'}`);
          }
        } else if (selectedSite === 'xn' && selectedXn) {
          try {
            // 观影片库发布分享强制要求绑定至少 1 个资源，
            // 用选中片源的 dir + id（来自 /res/search_suggest）组 binds
            const xnRes = await addXnShare({
              title: finalName,
              panurl: firstLink.url,
              panpw: firstLink.extract_code ?? '',
              is: 1,
              binds: [{ dir: selectedXn.dir, id: String(selectedXn.id) }],
            });
            // 发布成功即落地「资源 × 观影分享」绑定
            if (xnRes?.shareId) {
              firstBinding = {
                site: 'xn',
                share_id: xnRes.shareId,
                link_title: finalName,
                share_url: firstLink.url,
                vod_name: selectedXn.title,
                pan_type: detectPanName(firstLink.url) || undefined,
                code: firstLink.extract_code,
              };
            } else {
              toast.warning('已发布到观影片库，但未能取回分享 ID，请手动绑定该资源');
            }
            publishedCount += 1;
          } catch (xnErr: any) {
            console.warn('发布到观影片库失败', xnErr);
            failedCount += 1;
            toast.error(`发布至观影片库失败: ${xnErr?.message || '未知错误'}`);
          }
        }
      }

      // 3. 处理后续多链接队列（第 2 至第 N 条）：继续向站点发布，不新建资源行，
      //    每条的发布结果同样绑定到当前这一行资源
      const extraBindings: SiteBindingPayload[] = [];
      if (activeCheckedLinks.length > 1) {
        for (let i = 1; i < activeCheckedLinks.length; i++) {
          const item = activeCheckedLinks[i];
          setQueueProgress({
            running: true,
            current: i + 1,
            total: activeCheckedLinks.length,
            statusText: shouldPublish
              ? `正在向站点发布第 ${i + 1}/${activeCheckedLinks.length} 条【${item.pan_name}】资源…`
              : `正在处理第 ${i + 1}/${activeCheckedLinks.length} 条网盘链接…`,
          });

          let subBinding: SiteBindingPayload | undefined;
          if (shouldPublish) {
            if (selectedSite === 'mukaku' && mukakuMoviesId) {
              try {
                const addRes = await addMukakuResource({
                  movies_id: mukakuMoviesId,
                  seed_name: finalName,
                  link: item.url,
                  code: item.extract_code || '',
                });
                if (addRes.created_id) {
                  subBinding = {
                    site: 'mukaku',
                    link_id: addRes.created_id,
                    movies_id: mukakuMoviesId,
                    vod_name: selectedMovie?.title || finalName,
                    pan_type: addRes.pan_type,
                    code: item.extract_code,
                  };
                }
                publishedCount += 1;
              } catch (subErr) {
                console.warn('队列发布不太灵失败', subErr);
                failedCount += 1;
              }
            } else if (selectedSite === 'ya') {
              try {
                const yaRes = await yaAddResource({
                  title: selectedYa?.video_title || finalName,
                  category: selectedYa?.video_category || '电视剧',
                  name: finalName,
                  url: item.url,
                  extractCode: item.extract_code,
                });
                if (yaRes?.link_id) {
                  subBinding = {
                    site: 'ya',
                    link_id: yaRes.link_id,
                    video_id: yaRes.video_id,
                    vod_name: selectedYa?.video_title || finalName,
                    pan_type: yaRes.drive_type,
                    pan_url: item.url,
                    code: item.extract_code,
                  };
                }
                publishedCount += 1;
              } catch (subErr) {
                console.warn('队列发布鸭影失败', subErr);
                failedCount += 1;
              }
            } else if (selectedSite === 'framehdr' && selectedFramehdr) {
              // 帧影：队列第 2 条起同样发布到同一片源，资源名称不变、仅更换链接
              try {
                await addFramehdrLink({
                  resourceId: selectedFramehdr.id,
                  url: item.url,
                  name: detectPanName(item.url) || '光鸭云盘',
                  password: item.extract_code,
                  description: finalName,
                });
                publishedCount += 1;
              } catch (subErr) {
                console.warn('队列发布帧影失败', subErr);
                failedCount += 1;
              }
            } else if (selectedSite === 'jying' && selectedJying) {
              // 聚影：队列第 2 条起同样在该影片下新增一条分享记录，
              // 网盘类型由站点按链接自动识别，无需传入
              try {
                const jySub = await addJyingResource({
                  movieId: selectedJying.id,
                  shareLink: item.url,
                  description: finalName,
                  extractionCode: item.extract_code,
                });
                if (jySub.id) {
                  subBinding = {
                    site: 'jying',
                    link_id: jySub.id,
                    vod_name: selectedJying.title,
                    link_title: finalName,
                    pan_url: item.url,
                    code: item.extract_code,
                  };
                }
                publishedCount += 1;
              } catch (subErr) {
                console.warn('队列发布聚影失败', subErr);
                failedCount += 1;
              }
            } else if (selectedSite === 'xn' && selectedXn) {
              try {
                const xnSub = await addXnShare({
                  title: finalName,
                  panurl: item.url,
                  panpw: item.extract_code ?? '',
                  is: 1,
                  binds: [{ dir: selectedXn.dir, id: String(selectedXn.id) }],
                });
                if (xnSub?.shareId) {
                  subBinding = {
                    site: 'xn',
                    share_id: xnSub.shareId,
                    link_title: finalName,
                    share_url: item.url,
                    vod_name: selectedXn.title,
                    pan_type: detectPanName(item.url) || undefined,
                    code: item.extract_code,
                  };
                }
                publishedCount += 1;
              } catch (subErr) {
                console.warn('队列发布观影片库失败', subErr);
                failedCount += 1;
              }
            }
          }
          if (subBinding) extraBindings.push(subBinding);
        }
      }

      // 4. 回填当前行资源：首条 + 队列各条的站点绑定一并落地到当前行
      await onUpdateCurrent(
        resource.id,
        finalName,
        firstLink.url,
        selectedCover,
        [firstBinding, ...extraBindings].filter((b): b is SiteBindingPayload => !!b)
      );

      const siteLabel = SITE_OPTIONS.find((s) => s.id === selectedSite)?.label ?? selectedSite;
      if (shouldPublish) {
        setPublishedSites((prev) => ({ ...prev, [selectedSite]: publishedCount }));
      }
      if (!shouldPublish) {
        toast.success(`《${finalName}》已回填。可继续切换站点发布`);
      } else if (failedCount === 0 && publishedCount === activeCheckedLinks.length) {
        toast.success(
          `《${finalName}》已回填，并向【${siteLabel}】发布 ${publishedCount} 条网盘链接。可继续切换站点发布`
        );
      } else {
        // 部分失败：如实告知成功/失败条数，不再笼统提示「已全部发布」
        const parts = [`《${finalName}》已回填`];
        if (publishedCount > 0) parts.push(`向【${siteLabel}】成功发布 ${publishedCount}/${activeCheckedLinks.length} 条`);
        if (failedCount > 0) parts.push(`${failedCount} 条发布失败（可在列表中重试或到站点同步页补发）`);
        toast.warning(parts.join('，') + '。可继续切换站点发布');
      }
      // 不关闭弹窗：支持连续向多个站点发布，切换站点后各自的勾选状态互相独立
    } catch (e: any) {
      console.error('快捷绑定并发布失败', e);
      toast.error(e?.message || '操作失败，请重试');
    } finally {
      setQueueProgress({ running: false, current: 0, total: 0, statusText: '' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl max-h-[90dvh] overflow-y-auto p-4 md:p-6 bg-background">
        <DialogHeader className="space-y-1">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base md:text-lg flex items-center gap-2 font-semibold">
              <Sparkles className="h-4 w-4 text-primary" />
              快捷绑定与发布网盘资源
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            检索全站点官方片库，规范回填完整片名、海报，并自动将网盘资源链接分享/发布到该部影片中。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* 1. 站点切换 Tab */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-primary" />
                选择目标检索与发布站点
              </span>
              {selectedSite === 'mukaku' && (
                <span className={`text-[11px] ${siteBindStatus.mukakuBound ? 'text-primary' : 'text-amber-500'}`}>
                  {siteBindStatus.mukakuBound ? '● 不太灵已登录绑定' : '○ 不太灵未登录（仅本地回填）'}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
              {SITE_OPTIONS.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => handleSelectSite(site.id)}
                  className={`p-2 rounded-md border text-left flex flex-col justify-between transition-all ${
                    selectedSite === site.id
                      ? 'border-primary bg-primary/10 text-primary shadow-xs'
                      : 'border-border/60 hover:border-border hover:bg-muted/40 text-muted-foreground'
                  }`}
                >
                  <span className="text-xs font-medium truncate flex items-center gap-1">
                    {site.label}
                    {publishedSites[site.id] > 0 && (
                      <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
                    )}
                  </span>
                  <span className="text-[10px] text-muted-foreground/80 mt-1">
                    {publishedSites[site.id] > 0 ? `已发布 ${publishedSites[site.id]} 条` : site.badge}
                  </span>
                  {/* 站点网址：用户要知道去哪个站绑定账号 / 看片源 */}
                  <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                    {SITE_URLS[site.id] ? siteHost(SITE_URLS[site.id]) : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* 2. 搜索框 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor={queryInputId} className="text-xs font-medium text-foreground">片源搜索关键词</label>
              {resource?.name && (
                <button
                  type="button"
                  onClick={() => {
                    const c = cleanSearchQuery(resource.name);
                    setKeyword(c);
                    doSearch(c, selectedSite);
                  }}
                  className="text-[11px] text-primary hover:underline flex items-center gap-1"
                >
                  <Search className="h-3 w-3" />
                  清洗原片名并重搜
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id={queryInputId}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doSearch(keyword, selectedSite)}
                  placeholder="输入片名检索（自动容错括号年份，如：冬城猎凶）"
                  className="pl-8 text-xs h-9 bg-input"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => doSearch(keyword, selectedSite)}
                disabled={searching}
                className="h-9 px-4 text-xs shrink-0"
              >
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '搜索'}
              </Button>
            </div>
          </div>

          {/* 3. 片源搜索结果列表 */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground flex items-center justify-between">
              <span>检索结果（点击选中片源）</span>
              {searching && <span className="text-[11px] text-primary flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> 正在查询站内片库…</span>}
            </span>

            <div className="border border-border/80 rounded-md p-2 bg-muted/20 min-h-32 max-h-48 overflow-y-auto space-y-2">
              {searching ? (
                <div className="py-8 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  正在穿透检索站内片库，请稍候…
                </div>
              ) : selectedSite === 'mukaku' ? (
                mukakuMovies.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    未找到相关片源，可尝试点击「清洗原片名并重搜」或精简关键词
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {mukakuMovies.map((movie) => {
                      const isPicked = selectedMovie?.doub_id === movie.doub_id || selectedMovie?.id === movie.id;
                      return (
                        <div
                          key={String(movie.id || movie.doub_id)}
                          onClick={() => handlePickMukakuMovie(movie)}
                          className={`flex gap-2.5 p-2 rounded-md border cursor-pointer transition-all ${
                            isPicked
                              ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary'
                              : 'border-border bg-card hover:bg-muted/50'
                          }`}
                        >
                          {movie.pic ? (
                            <img
                              src={movie.pic}
                              alt={movie.title}
                              className="w-12 h-16 object-cover rounded shrink-0 bg-muted"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <div className="w-12 h-16 rounded bg-muted flex items-center justify-center shrink-0">
                              <Film className="h-5 w-5 text-muted-foreground/50" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                            <div>
                              <div className="flex items-center justify-between gap-1">
                                <h4 className="font-medium text-xs truncate text-foreground">
                                  {movie.title}
                                </h4>
                                {isPicked && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                              </div>
                              <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground flex-wrap">
                                {movie.year && (
                                  <span className="flex items-center gap-0.5">
                                    <Calendar className="h-2.5 w-2.5" />
                                    {movie.year}
                                  </span>
                                )}
                                {movie.type && <span className="truncate max-w-24">· {movie.type}</span>}
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/40">
                              <span>豆瓣ID: {movie.doub_id || '—'}</span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0">
                                点击选定
                              </Badge>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : selectedSite === 'ya' ? (
                yaLinks.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">未检索到鸭影片源</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {yaLinks.map((item) => {
                      // 无链接条目代表「站内已收录该片源、本人尚未发布链接」，id 恒为 0，
                      // 因此 key 与选中判断都必须带上 video_id，否则会重复且选中态串台
                      const picked = !!selectedYa
                        && selectedYa.id === item.id
                        && selectedYa.video_id === item.video_id;
                      return (
                        <div
                          key={item.id ? `link-${item.id}` : `video-${item.video_id}`}
                          onClick={() => handlePickYaVideo(item)}
                          className={`p-2 rounded border cursor-pointer transition-all ${
                            picked
                              ? 'border-primary bg-primary/10 ring-1 ring-primary'
                              : 'border-border bg-card hover:bg-muted/50'
                          }`}
                        >
                          <div className="w-12 h-16 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden relative">
                            <Film className="h-5 w-5 text-muted-foreground/50" />
                            {item.video_cover && (
                              <img
                                src={item.video_cover}
                                alt={item.video_title || item.name || ''}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover"
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 text-xs font-medium">
                              <span className="truncate">{item.video_title || item.name}</span>
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                {item.id ? (item.drive_label || '网盘') : '站内已收录'}
                              </Badge>
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-1 truncate">
                              {item.url
                                ? <span className="font-mono">{item.url}</span>
                                : '你尚未在该片源下发布链接 · 选中后可直接发布新资源'}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : selectedSite === 'framehdr' ? (
                framehdrResults.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    未检索到帧影片库片源。请先在设置页绑定帧影账号，并尝试精简关键词
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {framehdrResults.map((item) => {
                      const picked = selectedFramehdr?.id === item.id;
                      return (
                        <div
                          key={item.id}
                          onClick={() => handlePickFramehdr(item)}
                          className={`flex gap-2.5 p-2 rounded-md border cursor-pointer transition-all ${
                            picked
                              ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary'
                              : 'border-border bg-card hover:bg-muted/50'
                          }`}
                        >
                          <div className="w-12 h-16 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden relative">
                            <Film className="h-5 w-5 text-muted-foreground/50" />
                            {item.cover && (
                              <img
                                src={item.cover}
                                alt={item.title}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                            <div className="flex items-center justify-between gap-1">
                              <h4 className="font-medium text-xs truncate text-foreground">
                                {item.title}
                              </h4>
                              {picked && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/40">
                              <span>ID: {item.id}{item.year ? ` · ${item.year}` : ''}</span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0">
                                点击选定
                              </Badge>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : selectedSite === 'jying' ? (
                jyingShares.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    未检索到聚影片源。请先在「站点同步 → 聚影站点」绑定账号，并尝试精简关键词
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {jyingShares.map((item) => {
                      const picked = selectedJying?.id === item.id;
                      return (
                        <div
                          key={item.id}
                          onClick={() => handlePickJying(item)}
                          className={`cursor-pointer rounded-lg border p-2 flex gap-2 transition-colors ${
                            picked ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/40'
                          }`}
                        >
                          <div className="relative w-10 h-14 rounded overflow-hidden bg-muted shrink-0">
                            {item.cover && (
                              <img
                                src={item.cover}
                                alt={item.title}
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                            <div className="flex items-center justify-between gap-1">
                              <h4 className="font-medium text-xs truncate text-foreground">{item.title}</h4>
                              {picked && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {item.description || '—'}
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/40 gap-1">
                              <span>ID: {item.id}{item.release_year ? ` · ${item.release_year}` : ''}</span>
                              <Badge variant="secondary" className="text-[9px] px-1 py-0 shrink-0">
                                {item.movie_type_display || '影片'}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : selectedSite === 'xn' ? (
                xnVideos.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    未检索到观影片库片源。请先在设置页绑定观影站点 Cookie，并尝试精简关键词
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {xnVideos.map((item) => {
                      const picked =
                        selectedXn?.id === item.id && selectedXn?.dir === item.dir;
                      return (
                        <div
                          key={`${item.dir}-${item.id}`}
                          onClick={() => handlePickXnVideo(item)}
                          className={`flex gap-2.5 p-2 rounded-md border cursor-pointer transition-all ${
                            picked
                              ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary'
                              : 'border-border bg-card hover:bg-muted/50'
                          }`}
                        >
                          <div className="w-12 h-16 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden relative">
                            <Film className="h-5 w-5 text-muted-foreground/50" />
                            {item.cover && (
                              <img
                                src={item.cover}
                                alt={item.title}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                            <div>
                              <div className="flex items-center justify-between gap-1">
                                <h4 className="font-medium text-xs truncate text-foreground">
                                  {item.title}
                                </h4>
                                {picked && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                              </div>
                              <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground flex-wrap">
                                {item.year && (
                                  <span className="flex items-center gap-0.5">
                                    <Calendar className="h-2.5 w-2.5" />
                                    {item.year}
                                  </span>
                                )}
                                {item.type && (
                                  <span className="truncate max-w-24">· {item.type}</span>
                                )}
                                {item.score && <span>· {item.score}分</span>}
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/40">
                              <span>
                                {item.dir} / {item.id}
                              </span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0">
                                点击选定
                              </Badge>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  已切换至 {SITE_OPTIONS.find((s) => s.id === selectedSite)?.label}，可直接使用下方表单回填发布
                </div>
              )}
            </div>
          </div>

          {/* 4. 发布与回填设置区域（完全对应截图【发布网盘资源】的核心字段） */}
          <div className="border border-border rounded-lg p-3 md:p-4 bg-card/60 space-y-3.5">
            <div className="flex items-center justify-between border-b border-border/60 pb-2">
              <div className="flex items-center gap-2">
                <Share2 className="h-4 w-4 text-primary" />
                <h4 className="text-xs md:text-sm font-semibold text-foreground">
                  发布网盘资源并回填
                </h4>
              </div>
              {selectedMovie && (
                <span className="text-[11px] text-primary truncate max-w-56">
                  目标影片：《{selectedMovie.title}》
                </span>
              )}
            </div>

            {/* 资源标题（必填） */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor={titleInputId} className="text-xs font-medium text-foreground flex items-center gap-1">
                  <span className="text-destructive">*</span>
                  资源标题
                </label>
                <span className="text-[10px] text-muted-foreground">
                  对应站点【发布网盘资源】中的资源标题，所有队列行保持一致
                </span>
              </div>
              <Input
                id={titleInputId}
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder="例如：冬城猎凶 (2026) 4K高码版"
                className="text-xs h-9 bg-input"
              />
            </div>

            {/* 自动同步发布开关（核心特性） */}
            <div className="p-2.5 rounded-md border border-primary/30 bg-primary/5 flex items-start gap-2.5">
              <Checkbox
                id="publish-check"
                checked={publishToSite}
                onCheckedChange={(c) => setPublishToSite(Boolean(c))}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <label htmlFor="publish-check" className="text-xs font-semibold text-foreground cursor-pointer block">
                  自动将网盘链接分享/发布到【{SITE_OPTIONS.find((s) => s.id === selectedSite)?.label}】该影片下（推荐）
                </label>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  点击确认后，系统将自动以该资源标题、网盘链接及提取码调用站点发布接口进行挂载并双向绑定。
                </p>
              </div>
            </div>

            {/* 单条快速录入与粘贴识别工具栏 */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground flex items-center gap-1">
                  <span className="text-destructive">*</span>
                  网盘链接与提取码（单条或批量）
                </span>
                <button
                  type="button"
                  onClick={() => setShowPasteBox(!showPasteBox)}
                  className="text-[11px] text-primary hover:underline flex items-center gap-0.5"
                >
                  <Plus className="h-3 w-3" />
                  {showPasteBox ? '收起批量粘贴' : '批量粘贴多云盘链接'}
                </button>
              </div>

              {/* 单条录入栏：包含 链接输入框 + 提取码 + 添加按钮 */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-1.5">
                <div className="md:col-span-7">
                  <Input
                    value={newSingleUrl}
                    onChange={(e) => setNewSingleUrl(e.target.value)}
                    placeholder="https://pan.baidu.com/s/... 或 夸克/阿里"
                    className="text-xs h-8 bg-input font-mono"
                  />
                </div>
                <div className="md:col-span-3">
                  <Input
                    value={newSingleCode}
                    onChange={(e) => setNewSingleCode(e.target.value)}
                    placeholder="分享码/提取码"
                    className="text-xs h-8 bg-input font-mono"
                  />
                </div>
                <div className="md:col-span-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleAddSingleLink}
                    className="w-full h-8 text-xs"
                  >
                    + 加入
                  </Button>
                </div>
              </div>

              {/* 批量粘贴多链接展开框 */}
              {showPasteBox && (
                <div className="p-2.5 rounded-md border border-border bg-card space-y-2 mt-2">
                  <Textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="在此直接粘贴多行网盘分享链接（每行一条，自动识别提取码）：&#10;https://pan.quark.cn/s/... 提取码:abcd&#10;https://pan.baidu.com/s/... pwd=1234"
                    className="text-xs h-20 bg-input"
                  />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowPasteBox(false)} className="h-7 text-xs">
                      取消
                    </Button>
                    <Button type="button" size="sm" onClick={handleApplyPastedLinks} className="h-7 text-xs">
                      智能解析并加入
                    </Button>
                  </div>
                </div>
              )}

              {/* 网盘链接勾选列表 */}
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1 mt-2">
                {panLinks.length === 0 ? (
                  <div className="p-3 text-center rounded border border-dashed text-xs text-muted-foreground bg-background/50">
                    暂无待回填网盘链接。上方可选择站点已有片源或手动添加/批量粘贴。
                  </div>
                ) : (
                  panLinks.map((item, idx) => (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between gap-2 p-1.5 rounded border text-xs transition-colors ${
                        isLinkCheckedForSite(item, selectedSite) ? 'bg-card border-border' : 'bg-muted/40 border-border/50 opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Checkbox
                          checked={isLinkCheckedForSite(item, selectedSite)}
                          onCheckedChange={() => toggleLinkChecked(item.id)}
                          className="h-3.5 w-3.5"
                        />
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 shrink-0">
                          {idx === 0 ? '首条' : `第${idx + 1}条`}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                          {item.pan_name}
                        </Badge>
                        <span className="font-mono truncate text-[11px] text-foreground/80 flex-1">
                          {item.url}
                        </span>
                        {item.extract_code && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0 font-mono">
                            码: {item.extract_code}
                          </Badge>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLinkItem(item.id)}
                        className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 5. 底部操作栏 */}
          <div className="flex items-center justify-between pt-1 border-t border-border/60">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5 text-primary shrink-0" />
              {activeCheckedLinks.length > 0 ? (
                <span>
                  【{SITE_OPTIONS.find((s) => s.id === selectedSite)?.label}】已选 <strong>{activeCheckedLinks.length}</strong> 条链接；各站点勾选互相独立，发布后可继续切换站点。
                </span>
              ) : (
                <span>确认后将规范片名并回填网盘链接，同时发布到目标站点。</span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={queueProgress.running}
                onClick={() => onOpenChange(false)}
                className="h-8 text-xs px-3"
              >
                关闭
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={queueProgress.running || !targetName.trim() || activeCheckedLinks.length === 0}
                onClick={handleConfirmAndPublish}
                className="h-8 text-xs px-4 gap-1.5"
              >
                {queueProgress.running ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {queueProgress.statusText || '正在发布与写入…'}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {activeCheckedLinks.length > 1
                      ? `确认发布并回填 (${activeCheckedLinks.length}条)`
                      : '确认回填并发布'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
