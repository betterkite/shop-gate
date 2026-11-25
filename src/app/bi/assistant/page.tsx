import type { Metadata } from 'next';
import { BusinessEntry } from '@/components/bi/BusinessEntry';

export const metadata: Metadata = { title: '独立经营对话 · Shop Gate' };
export const dynamic = 'force-dynamic';

export default function AssistantPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return BusinessEntry({ section: 'overview', assistantOnly: true, searchParams });
}
