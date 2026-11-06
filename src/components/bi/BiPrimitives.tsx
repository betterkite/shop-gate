'use client';
import React, { type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, BarChart3, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { AuthUserMenu } from '@/components/auth/AuthUserMenu';

export const BI_PANEL = 'min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6';
export const BI_SELECT = 'h-10 min-w-0 max-w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground';
export function BiHeader({ workspaceId, datasetId }: { workspaceId: string; datasetId?: string }) {
  const p = new URLSearchParams({ workspace_id: workspaceId }); if (datasetId) p.set('dataset_id', datasetId);
  return <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
    <div className="mx-auto flex max-w-[1520px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-3"><Link href="/" aria-label="返回工作台" className="rounded-lg p-2 hover:bg-muted"><ArrowLeft className="h-5 w-5" /></Link>
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><BarChart3 className="h-5 w-5" /></span>
        <div><p className="text-xs font-medium text-primary">Shop Gate</p><h1 className="text-lg font-semibold">经营总览</h1></div></div>
      <div className="flex items-center gap-2"><ThemeToggle compact /><AuthUserMenu variant="header" /></div>
    </div>
    <nav aria-label="经营导航" className="mx-auto flex max-w-[1520px] flex-wrap gap-2 px-4 pb-3 text-sm sm:px-6">
      <Link href={`/bi/overview?${p}`} aria-current="page" className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 font-medium text-primary"><BarChart3 className="h-4 w-4" />经营总览</Link>
      <Link href={`/bi/data?${p}`} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Database className="h-4 w-4" />数据集与导入</Link>
    </nav>
  </header>;
}
export function BiNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div role={error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm leading-6 ${error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-primary/20 bg-primary/5 text-foreground'}`}>{children}</div>;
}
export function BiPagination({ page, total, label, busy = false, change }: {
  page: number; total: number; label: string; busy?: boolean; change: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
    <span>共 {total.toLocaleString('zh-CN')} 项 · 每页 20 项 · 第 {page} / {pages} 页</span>
    <span className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || page <= 1} onClick={() => change(page - 1)}>上一页</Button>
      <Button variant="outline" size="sm" disabled={busy || page >= pages} onClick={() => change(page + 1)}>下一页</Button></span>
  </nav>;
}
