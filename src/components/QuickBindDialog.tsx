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
  searchPanLinks,
  addPanLink,
  bindResourceToLink,
} from '@/services/api';
import type { Resource, MukakuMovie, YaLink, PinglianLink } from '@/types/index';
import { detectPanName } from '@/lib/panUtils';

export type SiteSourceType = 'mukaku' | 'ya' | 'pinglian' | 'framehdr' | 'xn' | 'panfx';

export interface SiteBindingPayload {
  site: SiteSourceType;
  link_id: number;
  movies_id?: number;
  video_id?: number;
  vod_name?: string;
  pan_type?: string;
  code?: string;
}

export interface SelectedPanLinkItem {
  id: string;
  url: string;
  pan_name: string;
  extract_code?: string;
  source_title?: string;
  checked: boolean;
}

interface QuickBindDialogProps {
  resource: Resource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 更新当前行资源
  onUpdateCurrent: (
    resourceId: string,
    filledName: string,
    filledLink: string,
    coverUrl?: string | null,
    siteBinding?: SiteBindingPayload
  ) => Promise<void>;
  // 串行队列追加多网盘新行
  onQueueAppend: (
    baseResource: Resource,
    filledName: string,
    linksQueue: Array<{
      url: string;
      pan_name?: string;
      extract_code?: string;
      siteBinding?: SiteBindingPayload;
    }>
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
  { id: 'ya', label: '鸭影臻藏', badge: '多云盘', desc: '检索站内片源及已收录网盘，支持自动添加网盘分享', supported: true },
  { id: 'pinglian', label: '盘链片库', badge: '网盘库', desc: '检索全站网盘分享库，支持同步发布到剧集', supported: true },
  { id: 'framehdr', label: '帧HDR', badge: '豆瓣片库', desc: '基于帧影站内豆瓣源检索影片条目', supported: true },
  { id: 'xn', label: '观影小牛', badge: '搜索提示', desc: '基于小牛站内搜索联想片源', supported: true },
  { id: 'panfx', label: '123社区', badge: '仅发帖', desc: '暂未提供全网片源检索接口，仅支持帖子管理', supported: false },
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

export default function QuickBindDialog({
  resource,
  open,
  onOpenChange,
  onUpdateCurrent,
  onQueueAppend,
}: QuickBindDialogProps) {
  const queryInputId = useId();
  const titleInputId = useId();
  const [selectedSite, setSelectedSite] = useState<SiteSourceType>('mukaku');
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);

  // 搜索结果列表
  const [mukakuMovies, setMukakuMovies] = useState<MukakuMovie[]>([]);
  const [yaLinks, setYaLinks] = useState<YaLink[]>([]);
  const [pinglianLinks, setPinglianLinks] = useState<PinglianLink[]>([]);

  // 选中的片源
  const [selectedMovie, setSelectedMovie] = useState<MukakuMovie | null>(null);
  const [selectedYa, setSelectedYa] = useState<YaLink | null>(null);
  const [selectedPinglian, setSelectedPinglian] = useState<PinglianLink | null>(null);

  // 回填设置与发布表单
  const [targetName, setTargetName] = useState('');
  const [selectedCover, setSelectedCover] = useState<string | null>(null);
  const [panLinks, setPanLinks] = useState<SelectedPanLinkItem[]>([]);
  const [publishToSite, setPublishToSite] = useState(true);

  // 快速录入单条或多条网盘
  const [newSingleUrl, setNewSingleUrl] = useState('');
  const [newSingleCode, setNewSingleCode] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [showPasteBox, setShowPasteBox] = useState(false);

  // 站点绑定状态检测
  const [siteBindStatus, setSiteBindStatus] = useState<{
    mukakuBound: boolean;
    yaBound: boolean;
  }>({ mukakuBound: false, yaBound: false });

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
      setSelectedMovie(null);
      setSelectedYa(null);
      setSelectedPinglian(null);
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
      const [mStatus, yStatus] = await Promise.allSettled([
        getMukakuStatus(),
        yaGetAccountStatus(),
      ]);
      setSiteBindStatus({
        mukakuBound: mStatus.status === 'fulfilled' && (mStatus.value?.valid === true || mStatus.value?.status === 'active'),
        yaBound: yStatus.status === 'fulfilled' && yStatus.value?.success === true,
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
    setSelectedPinglian(null);
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
        const list = await searchYaVideos(q);
        setYaLinks(list);
        if (list.length === 0) {
          toast.info(`未在鸭影臻藏搜到「${q}」`);
        }
      } else if (site === 'pinglian') {
        const list = await searchPanLinks(q);
        setPinglianLinks(list);
        if (list.length === 0) {
          toast.info(`未在盘链搜到「${q}」`);
        }
      } else if (site === 'panfx') {
        toast.info('123社区仅支持论坛帖子发布管理，暂无全局片库检索 API');
      } else {
        toast.info(`${site} 站点暂支持作为同步目标，正在丰富片库检索通道`);
      }
    } catch (e: any) {
      console.error('搜索站点片源异常', e);
      toast.error(e?.message || '搜索片源失败，请重试');
    } finally {
      setSearching(false);
    }
  }

  // 选中某部不太灵影片
  async function handlePickMukakuMovie(movie: MukakuMovie) {
    setSelectedMovie(movie);
    // 规范完整片名：保留主标题 + 上映年份（若有）
    const fullNormName = movie.year && !movie.title.includes(String(movie.year))
      ? `${movie.title} (${movie.year})`
      : movie.title;
    setTargetName(fullNormName);

    if (movie.pic) {
      setSelectedCover(movie.pic);
    }

    toast.success(`已选定《${movie.title}》，已预填规范资源标题`);
  }

  // 选中某部鸭影片源
  function handlePickYaVideo(item: YaLink) {
    setSelectedYa(item);
    const title = item.video_title || item.name || '';
    if (title) setTargetName(title);

    if (item.url) {
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

  // 选中盘链某条记录
  function handlePickPinglian(item: PinglianLink) {
    setSelectedPinglian(item);
    const title = item.video_title || item.title || '';
    if (title) setTargetName(title);
    if (item.video_cover) setSelectedCover(item.video_cover);

    if (item.url) {
      setPanLinks((prev) => {
        const exists = prev.some((l) => l.url === item.url);
        if (exists) return prev;
        return [
          {
            id: `pinglian-${item.id || Date.now()}`,
            url: item.url,
            pan_name: item.pan_type || detectPanName(item.url),
            extract_code: item.password || '',
            checked: true,
          },
          ...prev,
        ];
      });
    }
    toast.success(`已选定盘链条目《${title}》`);
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

  // 切换链接勾选状态
  function toggleLinkChecked(id: string) {
    setPanLinks((prev) =>
      prev.map((l) => (l.id === id ? { ...l, checked: !l.checked } : l))
    );
  }

  // 移除某条链接
  function removeLinkItem(id: string) {
    setPanLinks((prev) => prev.filter((l) => l.id !== id));
  }

  // 勾选的有效链接列表
  const activeCheckedLinks = panLinks.filter((l) => l.checked && l.url.trim());

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
          } catch (pubErr: any) {
            console.warn('发布到不太灵失败，降级本地回填', pubErr);
            toast.error(`发布至不太灵失败: ${pubErr?.message || '未知错误'}，已保留本地回填`);
          }
        } else if (selectedSite === 'ya') {
          try {
            const yaRes = await yaAddResource({
              title: finalName,
              category: '电视剧',
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
                code: firstLink.extract_code,
              };
            }
          } catch (yaErr: any) {
            console.warn('发布到鸭影失败', yaErr);
            toast.error(`发布至鸭影失败: ${yaErr?.message || '未知错误'}`);
          }
        } else if (selectedSite === 'pinglian' && selectedPinglian?.video_id) {
          try {
            await addPanLink({
              link_title: finalName,
              link_url: firstLink.url,
              link_password: firstLink.extract_code,
              pan_type: detectPanName(firstLink.url),
              vod_id: Number(selectedPinglian.video_id),
            });
          } catch (plErr: any) {
            console.warn('发布到盘链失败', plErr);
          }
        }
      }

      // 更新当前行资源
      await onUpdateCurrent(
        resource.id,
        finalName,
        firstLink.url,
        selectedCover,
        firstBinding
      );

      // 3. 处理后续多链接队列（第 2 至第 N 条）：串行逐条在当前行下方追加新行并调用站点发布
      if (activeCheckedLinks.length > 1) {
        const remainingLinksQueue: Array<{
          url: string;
          pan_name?: string;
          extract_code?: string;
          siteBinding?: SiteBindingPayload;
        }> = [];

        for (let i = 1; i < activeCheckedLinks.length; i++) {
          const item = activeCheckedLinks[i];
          setQueueProgress({
            running: true,
            current: i + 1,
            total: activeCheckedLinks.length,
            statusText: shouldPublish
              ? `正在向站点发布第 ${i + 1}/${activeCheckedLinks.length} 条【${item.pan_name}】资源…`
              : `正在追加第 ${i + 1}/${activeCheckedLinks.length} 行资源…`,
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
              } catch (subErr) {
                console.warn('队列发布不太灵失败', subErr);
              }
            } else if (selectedSite === 'ya') {
              try {
                const yaRes = await yaAddResource({
                  title: finalName,
                  category: '电视剧',
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
                    code: item.extract_code,
                  };
                }
              } catch (subErr) {
                console.warn('队列发布鸭影失败', subErr);
              }
            }
          }

          remainingLinksQueue.push({
            url: item.url,
            pan_name: item.pan_name,
            extract_code: item.extract_code,
            siteBinding: subBinding,
          });
        }

        // 串行写入其余新行
        await onQueueAppend(resource, finalName, remainingLinksQueue);
      }

      toast.success(
        activeCheckedLinks.length > 1
          ? `多云盘队列录入完成！共完成 ${activeCheckedLinks.length} 条网盘资源规范回填${shouldPublish ? '并发布至站点影片下' : ''}`
          : `规范回填完成！已更新《${finalName}》${shouldPublish ? '并自动发布至站点' : ''}`
      );
      onOpenChange(false);
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
                  <span className="text-xs font-medium truncate">{site.label}</span>
                  <span className="text-[10px] text-muted-foreground/80 mt-1">
                    {site.badge}
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
                    {yaLinks.map((item) => (
                      <div
                        key={String(item.id)}
                        onClick={() => handlePickYaVideo(item)}
                        className={`p-2 rounded border cursor-pointer transition-all ${
                          selectedYa?.id === item.id
                            ? 'border-primary bg-primary/10 ring-1 ring-primary'
                            : 'border-border bg-card hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs font-medium">
                          <span className="truncate">{item.video_title || item.name}</span>
                          <Badge variant="outline" className="text-[10px]">{item.drive_label || '网盘'}</Badge>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1 truncate font-mono">
                          {item.url}
                        </div>
                      </div>
                    ))}
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
                        item.checked ? 'bg-card border-border' : 'bg-muted/40 border-border/50 opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Checkbox
                          checked={item.checked}
                          onCheckedChange={() => toggleLinkChecked(item.id)}
                          className="h-3.5 w-3.5"
                        />
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 shrink-0">
                          {idx === 0 ? '首条·更新当前行' : `队列第${idx + 1}条·追加新行`}
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
              {activeCheckedLinks.length > 1 ? (
                <span>
                  已选 <strong>{activeCheckedLinks.length}</strong> 条网盘链接：首条覆盖当前行，后续串行追加新行并挂载至站点，资源名完全一致。
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
                取消
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
                      ? `确认队列发布并回填 (${activeCheckedLinks.length}条)`
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
