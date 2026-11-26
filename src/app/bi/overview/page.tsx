import type { Metadata } from 'next';
import { BusinessEntry } from '@/components/bi/BusinessEntry';

export const metadata: Metadata = { title: '经营总览 · Shop Gate', description: '查看经营变化、平台贡献和月度目标。' };
export const dynamic = 'force-dynamic';
export default function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return BusinessEntry({ section: 'overview', searchParams });
}
