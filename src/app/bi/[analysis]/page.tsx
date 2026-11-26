import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BusinessEntry } from '@/components/bi/BusinessEntry';
import { BUSINESS_SECTIONS, type BusinessSection } from '@/lib/bi/sections';

export const dynamic = 'force-dynamic';
type Params = Promise<{ analysis: string }>;
async function selectedSection(params: Params): Promise<BusinessSection> {
  const { analysis } = await params;
  if (analysis !== 'channels' && analysis !== 'stores' && analysis !== 'products' && analysis !== 'profit' && analysis !== 'refunds' && analysis !== 'costs' && analysis !== 'reports') notFound();
  return analysis;
}
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const section = BUSINESS_SECTIONS[await selectedSection(params)];
  return { title: section.title + ' · Shop Gate', description: section.description };
}
export default async function BusinessAnalysisPage({ params, searchParams }: {
  params: Params; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return BusinessEntry({ section: await selectedSection(params), searchParams });
}
