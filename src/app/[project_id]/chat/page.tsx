import { redirect } from 'next/navigation';

export default async function HistoricalConversation({ params }: {
  params: Promise<{ project_id: string }>;
}) {
  const { project_id } = await params;
  redirect('/history?' + new URLSearchParams({ project: project_id }));
}
