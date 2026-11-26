import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, postJobAction } from '@/lib/bi/http';

export async function POST(request: NextRequest, context: { params: Promise<{ job_id: string; action: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    const { job_id, action } = await context.params;
    return await postJobAction(request, job_id, action);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
