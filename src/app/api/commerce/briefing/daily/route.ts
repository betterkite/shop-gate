import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import {
  generateRetailDailyBrief,
  getLatestRetailDailyBrief,
} from '@/lib/commerce/retail-daily-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'research.report.read' });
    const latest = await getLatestRetailDailyBrief();
    return createSuccessResponse(latest);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return handleApiError(error, 'retail-briefing:get', 'Failed to load the latest retail daily brief');
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'research.report.run' });
    const body = await request.json().catch(() => ({}));
    const result = await generateRetailDailyBrief({
      reportDate:
        typeof (body as { reportDate?: unknown })?.reportDate === 'string'
          ? (body as { reportDate: string }).reportDate
          : undefined,
    });
    return createSuccessResponse(result);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return handleApiError(error, 'retail-briefing:generate', 'Failed to generate the retail daily brief');
  }
}
