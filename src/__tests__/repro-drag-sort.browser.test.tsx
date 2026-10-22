import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ResourceTable } from '../components/ResourceTable';
import { Resource } from '../types/index';
import { cdp } from 'vitest/browser';

/** 拖拽排序触屏复现测试：Pointer 事件（触屏/鼠标统一通路）应触发排序保存 */

// ---- mocks（纯对象，避免 browser mode 下 Proxy 序列化崩溃）----
function makeChain() {
  const result = { data: null, error: null };
  const chain: Record<string, unknown> = {
    then: (onF: (v: unknown) => unknown, onR: (v: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR),
    catch: (onR: (v: unknown) => unknown) => Promise.resolve(result).catch(onR),
    finally: (cb: () => void) => Promise.resolve(result).finally(cb),
  };
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'upsert', 'update', 'insert', 'delete', 'maybeSingle', 'single']) {
    chain[m] = () => chain;
  }
  return chain;
}

vi.mock('@/db/supabase', () => ({
  supabase: {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }),
    },
    from: () => makeChain(),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

vi.mock('@/services/api', () => {
  const emptyList = () => Promise.resolve([]);
  return {
    // ResourceTable
    fetchXnResourceBindings: emptyList,
    fetchYaResourceBindings: emptyList,
    fetchFramehdrResourceBindings: emptyList,
    fetchPanfxResourceBindings: emptyList,
    fetchMukakuResourceBindings: emptyList,
    fetchJyingResourceBindings: emptyList,
    fetchHdhavenResourceBindings: emptyList,
    updateResourceField: () => Promise.resolve(null),
    updateResourceCover: () => Promise.resolve(null),
    recordChange: () => Promise.resolve(undefined),
    deleteResource: () => Promise.resolve(undefined),
    syncResourceToXn: () => Promise.resolve(undefined),
    syncResourceToYa: () => Promise.resolve(undefined),
    syncResourceToFramehdr: () => Promise.resolve(undefined),
    syncResourceToPanfx: () => Promise.resolve(undefined),
    setResourceFinished: () => Promise.resolve(undefined),
    checkLinks: () => Promise.resolve(undefined),
    updateResourceSortOrders: () => Promise.resolve(undefined),
    // ResourceFormDialog / BatchImportDialog
    insertResource: () => Promise.resolve(null),
    insertResources: () => Promise.resolve([]),
    // BindDialog
    loadXnShares: emptyList,
    bindResourceToXnShare: () => Promise.resolve(undefined),
    unbindResourceFromXn: () => Promise.resolve(undefined),
    searchYaVideos: emptyList,
    bindResourceToYa: () => Promise.resolve(undefined),
    unbindResourceFromYa: () => Promise.resolve(undefined),
    loadFramehdrLinks: emptyList,
    bindResourceToFramehdr: () => Promise.resolve(undefined),
    unbindResourceFromFramehdr: () => Promise.resolve(undefined),
    loadPanfxPosts: emptyList,
    bindResourceToPanfx: () => Promise.resolve(undefined),
    unbindResourceFromPanfx: () => Promise.resolve(undefined),
    // 常量
    COOKIE_EXPIRED_CODE: 'COOKIE_EXPIRED',
    XN_COOKIE_EXPIRED_CODE: 'XN_COOKIE_EXPIRED',
    YA_EXPIRED_CODE: 'YA_EXPIRED',
    FRAMEHDR_COOKIE_EXPIRED_CODE: 'FRAMEHDR_COOKIE_EXPIRED',
    PANFX_COOKIE_EXPIRED_CODE: 'PANFX_COOKIE_EXPIRED',
    MUKAKU_TOKEN_EXPIRED_CODE: 'MUKAKU_TOKEN_EXPIRED',
    JYING_EXPIRED_CODE: 'JYING_COOKIE_EXPIRED',
    HDHAVEN_EXPIRED_CODE: 'HDHAVEN_TOKEN_EXPIRED',
    HDHAVEN_RATE_LIMITED_CODE: 'HDHAVEN_RATE_LIMITED',
  };
});

vi.mock('@/lib/uploadCover', () => ({
  uploadCover: vi.fn().mockResolvedValue({ url: '' }),
  deleteCover: vi.fn().mockResolvedValue(undefined),
}));

function makeResource(id: string, name: string, sort_order: number): Resource {
  return {
    id,
    name,
    episode_count: 1,
    link: '',
    links: [],
    sort_order,
    owner_id: 'u1',
    cover_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    link_status: 'unknown',
    link_checked_at: null,
    is_finished: false,
  };
}

describe('资源行拖拽排序（触屏 Pointer 拖拽）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('按住第一行手柄拖到第三行，应触发排序保存', async () => {
    // 校准：mousemove 无副作用，用于探测 CDP 坐标在 iframe 内实际命中的元素
    const events: string[] = [];
    document.addEventListener('pointerdown', (e) => events.push(`pointerdown@${(e.target as HTMLElement).dataset.testid ?? (e.target as HTMLElement).tagName}`), true);
    let lastMoveTarget = '';
    document.addEventListener('mousemove', (e) => {
      const el = e.target as HTMLElement;
      const row = el.closest('[data-testid="sortable-row"]');
      lastMoveTarget = `${el.tagName}@${row ? Array.from(document.querySelectorAll('[data-testid="sortable-row"]')).indexOf(row) : -1}`;
    }, true);

    const onResourcesChange = vi.fn();
    const resources = [
      makeResource('r1', '剧集A', 10),
      makeResource('r2', '剧集B', 20),
      makeResource('r3', '剧集C', 30),
    ];

    render(
      <ResourceTable
        resources={resources}
        onResourcesChange={onResourcesChange}
        onResourceUpdated={vi.fn()}
        onResourceAdded={vi.fn()}
        addOpen={false}
        onAddOpenChange={vi.fn()}
        batchOpen={false}
        onBatchOpenChange={vi.fn()}
      />
    );

    // 等待表格渲染（浏览器内直接查 DOM）
    await vi.waitFor(() => {
      const handles = document.querySelectorAll('[data-testid="drag-handle"]');
      expect(handles.length).toBe(3);
    }, { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 200));
    const handles = document.querySelectorAll('[data-testid="drag-handle"]');
    const rows = document.querySelectorAll('[data-testid="sortable-row"]');

    const srcRect = handles[0].getBoundingClientRect();

    // 拖拽：CDP mouse 序列 + 相对位移策略（免疫 iframe 偏移）
    // 1) 扫描探测：找到命中任意手柄 span/svg 的 CDP 坐标
    const hx = Math.round(srcRect.x + srcRect.width / 2);
    const hy = Math.round(srcRect.y + srcRect.height / 2);
    let pressY = -1;
    for (let dy = 0; dy <= 600; dy += 8) {
      const y = hy + dy;
      await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y, button: 'none', buttons: 0 });
      await new Promise((r) => setTimeout(r, 15));
      if (lastMoveTarget.startsWith('svg@') || lastMoveTarget.startsWith('SPAN@')) {
        // 二次确认：重发 hover，等事件队列稳定后仍在手柄上
        await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y, button: 'none', buttons: 0 });
        await new Promise((r) => setTimeout(r, 60));
        if (lastMoveTarget.startsWith('svg@') || lastMoveTarget.startsWith('SPAN@')) {
          pressY = y;
          break;
        }
      }
    }
    if (pressY < 0) throw new Error(`校准失败：600px 内未命中手柄，最后目标=${lastMoveTarget}`);
    // 2) 相对向下拖 2 行（行高从 DOM 实测，偏移无关）；按下点 = 扫描命中的手柄坐标
    const rowH = rows[2].getBoundingClientRect().y - rows[0].getBoundingClientRect().y;
    const px = hx;
    const py = pressY;
    const endX = hx + 30; // 松手时向右进入行内
    const endY = Math.round(pressY + rowH); // 向下 2 行

    await cdp().send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await cdp().send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(px + ((endX - px) * i) / steps),
        y: Math.round(py + ((endY - py) * i) / steps),
        button: 'left',
        buttons: 1,
      });
      await new Promise((r) => setTimeout(r, 25));
    }
    await cdp().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1 });
    // 留时间给 drop 处理与异步保存
    await new Promise((r) => setTimeout(r, 500));

    // 断言：拖拽已激活（pointerdown 命中手柄）且排序回调被触发
    expect(events.some((e) => e.startsWith('pointerdown@svg') || e.startsWith('pointerdown@SPAN'))).toBe(true);
    expect(onResourcesChange).toHaveBeenCalled();
  }, 30000);
});
