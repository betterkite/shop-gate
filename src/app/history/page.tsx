import Link from 'next/link';
import { HistoryArchive } from './HistoryArchive';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { AuthUserMenu } from '@/components/auth/AuthUserMenu';

export default async function HistoryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const project = typeof params.project === 'string' ? params.project : '';
  const directory = typeof params.directory === 'string' ? params.directory : '.';
  const tab = params.tab === 'files' ? 'files' : 'messages';
  const rawPage = Number(params.page);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1000000 ? rawPage : 1;
  return <main className="mx-auto max-w-5xl px-5 py-7 text-foreground">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <Link href="/" className="font-semibold text-primary">← 返回经营工作台</Link>
      <div className="flex items-center gap-2"><ThemeToggle compact /><AuthUserMenu variant="header" /></div>
    </header>
    <h1 className="mt-6 text-3xl font-semibold">历史会话与成果</h1>
    <p className="mb-6 mt-2 text-muted-foreground">按原有访问权限查看旧版对话和保存的文件。</p>
    <nav aria-label="历史经营页面" className="mb-5 flex flex-wrap gap-4 text-sm text-primary">
      <Link href="/commerce-platform?view=products">历史商品运营</Link>
      <Link href="/operations-briefing?view=daily">历史经营日报</Link>
      <Link href="/analytics-workbench?view=overview">历史行为分析</Link>
    </nav>
    <HistoryArchive key={JSON.stringify([project, tab, directory, page])} project={project} tab={tab} directory={directory} page={page} />
  </main>;
}
