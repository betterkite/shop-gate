import { NextRequest } from 'next/server';
import { biFailure, getTemplate } from '@/lib/bi/http';
import { requireAction } from '@/lib/auth/action';

export async function GET(request: NextRequest, context: { params: Promise<{ resource: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await getTemplate(request, (await context.params).resource);
  }
  catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
