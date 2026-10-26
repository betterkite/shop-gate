import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, getBatchErrors } from '@/lib/bi/http';

export async function GET(request: NextRequest, context: { params: Promise<{ batch_id: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await getBatchErrors(request, (await context.params).batch_id);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
