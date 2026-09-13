import type { ReactNode } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';

export type RetailPageTab = {
  href: string;
  label: string;
  active: boolean;
};

type RetailPageShellProps = {
  title: string;
  subtitle: string;
  badge?: ReactNode;
  tabs: RetailPageTab[];
  children: ReactNode;
};

/** 经营产品页的统一外壳：产品头、返回工作台和页内视图切换保持一致。 */
export function RetailPageShell({
  title,
  subtitle,
  badge,
  tabs,
  children,
}: RetailPageShellProps) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(238,107,77,0.10),_transparent_32%),hsl(var(--background))]">
      <PageHeader
        title={title}
        subtitle={subtitle}
        badge={badge}
        backHref="/"
        compactOnMobile
      />
      <main className="mx-auto w-full max-w-[1440px] px-4 pb-12 pt-5 sm:px-6 lg:px-8">
        <nav
          className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-border/70 bg-card/80 p-1 shadow-sm backdrop-blur"
          aria-label={`${title}视图`}
        >
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              prefetch={false}
              aria-current={tab.active ? 'page' : undefined}
              className={
                tab.active
                  ? 'shrink-0 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm'
                  : 'shrink-0 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
              }
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        {children}
      </main>
    </div>
  );
}
