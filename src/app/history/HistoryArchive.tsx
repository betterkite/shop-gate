'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BiNotice, BiPagination, BI_PANEL } from '@/components/bi/BiPrimitives';

type Selection = { project: string; tab: 'messages' | 'files'; directory: string; page: number };
type Entry = { id: string; title: string; body?: string; href?: string; download?: boolean };
type Result = { entries: Entry[]; total: number };
type Project = { id: string; name: string };
type Message = { id: string; role: string; content: string; createdAt: string };
type File = { name: string; path: string; type: 'directory' | 'file' };

function href(s: Partial<Selection>) {
  const p = new URLSearchParams();
  if (s.project) p.set('project', s.project);
  if (s.project && s.tab === 'files') {
    p.set('tab', 'files');
    if (s.directory && s.directory !== '.') p.set('directory', s.directory);
  }
  if (s.page && s.page > 1) p.set('page', String(s.page));
  return '/history' + (p.size ? '?' + p.toString() : '');
}
async function load(s: Selection, signal: AbortSignal): Promise<Result> {
  const base = '/api/projects/' + encodeURIComponent(s.project);
  const query = new URLSearchParams({ archive_page: String(s.page) });
  if (s.project && s.tab === 'files') query.set('path', s.directory);
  const route = !s.project ? '/api/projects' : s.tab === 'files' ? base + '/files'
    : '/api/chat/' + encodeURIComponent(s.project) + '/messages';
  const url = route + '?' + query.toString();
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 401 ? '请登录后查看历史记录。'
    : res.status === 403 ? '当前账号没有查看这些记录的权限。'
    : res.status === 404 ? '这份历史记录或文件夹已无法找到。' : '读取历史记录失败，请刷新重试。');
  const body = await res.json();
  if (!s.project) {
    const rows: Project[] = body.data.rows;
    return { total: body.data.total, entries: rows.map(row => ({ id: row.id, title: row.name, href: href({ project: row.id }) })) };
  }
  if (s.tab === 'files') {
    const rows: File[] = body.data.rows;
    return { total: body.data.total, entries: rows.map(row => ({
      id: row.path, title: row.name, download: row.type === 'file',
      href: row.type === 'directory' ? href({ ...s, directory: row.path, page: 1 })
        : base + '/artifact?' + new URLSearchParams({ path: row.path }),
    })) };
  }
  const rows: Message[] = body.data.rows;
  return { total: body.data.total, entries: rows.map(row => ({
    id: row.id, title: (row.role === 'user' ? '用户' : row.role === 'assistant' ? '经营助手' : '运行记录') + ' · ' + new Date(row.createdAt).toLocaleString('zh-CN'),
    body: row.content,
  })) };
}

export function HistoryArchive(s: Selection) {
  const router = useRouter();
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const { project, directory, tab, page } = s;
  useEffect(() => {
    const controller = new AbortController();
    load({ project, directory, tab, page }, controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取失败。'); });
    return () => controller.abort();
  }, [project, directory, tab, page]);
  const entryTab = (label: string, selected: Selection['tab']) =>
    <Link scroll={false} href={href({ project, tab: selected })} aria-current={tab === selected ? 'page' : undefined}
      className={tab === selected ? 'font-semibold text-primary underline' : 'text-muted-foreground hover:underline'}>{label}</Link>;
  return <section className={BI_PANEL}>
    {project && <nav aria-label="历史记录" className="mb-4 flex flex-wrap gap-4 text-sm">
      <Link href="/history" className="text-primary">全部会话</Link>
      {entryTab('会话内容', 'messages')}{entryTab('成果文件', 'files')}
      {tab === 'files' && directory !== '.' && <Link href={href({ ...s, directory: directory.split('/').slice(0, -1).join('/') || '.', page: 1 })}>上一级文件夹</Link>}
    </nav>}
    {error ? <BiNotice error>{error}</BiNotice> : !data ? <p role="status">正在读取…</p> : <>
      {!data.entries.length && <p className="text-muted-foreground">{data.total ? '此页没有记录，请返回上一页。' : '此处还没有历史记录。'}</p>}
      <ul className="divide-y divide-border">{data.entries.map(row => <li key={row.id} className="min-w-0 py-3">
        {row.download ? <a href={row.href} download className="break-all font-medium text-primary hover:underline">{row.title}</a>
          : row.href ? <Link href={row.href} className="break-all font-medium text-primary hover:underline">{row.title}</Link>
          : <article><h2 className="text-sm font-semibold">{row.title}</h2><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{row.body}</p></article>}
      </li>)}</ul>
      <BiPagination label="历史记录分页" total={data.total} page={page} change={next => router.push(href({ ...s, page: next }), { scroll: false })} />
    </>}
  </section>;
}
