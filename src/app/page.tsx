import Link from 'next/link';
import { ArrowUpRight, BarChart3, Boxes, Coins, Database, FileSpreadsheet, History, MessagesSquare, PackageSearch, ReceiptText, Store, Undo2 } from 'lucide-react';
import { AuthUserMenu } from '@/components/auth/AuthUserMenu';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { BUSINESS_SECTIONS, type BusinessSection } from '@/lib/bi/sections';

const sections = [
  ['overview', BarChart3], ['channels', Boxes], ['stores', Store], ['products', PackageSearch],
  ['profit', ReceiptText], ['refunds', Undo2], ['costs', Coins], ['reports', FileSpreadsheet],
] as const satisfies ReadonlyArray<readonly [BusinessSection, typeof BarChart3]>;

export default function HomePage() {
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3 font-semibold"><span className="rounded-xl bg-primary p-2 text-primary-foreground"><BarChart3 aria-hidden="true" /></span>Shop Gate</div>
        <div className="flex items-center gap-2"><ThemeToggle compact /><AuthUserMenu variant="header" /></div>
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-5 py-8 md:py-14">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-3xl font-semibold tracking-tight md:text-4xl">经营工作台</h1>
          <p className="mt-3 text-muted-foreground">选择分析范围，可在每个经营页面向助手提问并核对数据来源。</p></div>
        <Link href="/bi/data" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground"><Database size={17} />导入与管理数据</Link>
      </div>
      <nav aria-label="经营分析模块" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {sections.map(([id, Icon]) => <Link key={id} href={'/bi/' + id} prefetch={false}
          className="group flex min-h-40 flex-col rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/55 focus-visible:outline-primary">
          <span className="mb-4 flex items-center justify-between text-primary"><Icon size={22} /><ArrowUpRight aria-hidden="true" size={16} /></span>
          <h2 className="font-semibold">{BUSINESS_SECTIONS[id].title}</h2>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{BUSINESS_SECTIONS[id].description}</p>
        </Link>)}
      </nav>
      <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2">
      <Link href="/bi/assistant" className="inline-flex items-center gap-2 rounded-lg py-2 font-medium text-primary hover:underline"><MessagesSquare size={17} />独立经营对话</Link>
      <Link href="/history" className="inline-flex items-center gap-2 rounded-lg py-2 font-medium text-primary hover:underline"><History size={17} />查看历史会话与成果</Link>
      </div>
    </main>
  </div>;
}
