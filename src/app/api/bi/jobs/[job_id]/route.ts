import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, getJobs } from '@/lib/bi/http';

export async function GET(request: NextRequest, context: { params: Promise<{ job_id: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await getJobs(request, (await context.params).job_id);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
