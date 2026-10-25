import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, getJobFile } from '@/lib/bi/http';

export async function GET(request: NextRequest, context: { params: Promise<{ job_id: string; resource: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    const { job_id, resource } = await context.params;
    return await getJobFile(request, job_id, resource);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
