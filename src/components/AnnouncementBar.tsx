import React, { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { fetchActiveAnnouncements, type Announcement } from '@/services/api';

/** 顶部滚动公告条：读取启用的公告并横向滚动展示 */
export default function AnnouncementBar() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchActiveAnnouncements()
      .then((data) => {
        if (mounted) setItems(data.filter((a) => a.content.trim()));
      })
      .catch(() => {
        if (mounted) setError(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (error || items.length === 0) return null;

  // 拼接所有公告为一条滚动文本（用分隔符分隔）
  const text = items.map((a) => a.content.trim()).join('　　◆　　');

  return (
    <div className="w-full bg-primary text-primary-foreground overflow-hidden shrink-0">
      <div className="flex items-center gap-2 px-3 md:px-6 h-8">
        <Megaphone className="h-3.5 w-3.5 shrink-0" />
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="whitespace-nowrap animate-marquee text-xs font-medium">
            <span className="inline-block pr-16">{text}</span>
            <span className="inline-block pr-16">{text}</span>
          </div>
        </div>
      </div>
    </div>
  );
}