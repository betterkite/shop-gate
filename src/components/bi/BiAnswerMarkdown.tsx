import React from 'react';
import { renderLightMarkdown } from '@/components/chat/LightMarkdown';

/** Text-only parser: no HTML execution, remote images or model-provided links. */
export function BiAnswerMarkdown({ text }: { text: string }) {
  return <div className="min-w-0 break-words text-sm leading-7 [&_h3]:text-foreground [&_h4]:text-foreground [&_table]:border-border [&_thead]:bg-muted/40 [&_th]:border-border [&_th]:text-foreground [&_td]:border-border [&_td]:text-foreground [&_code]:bg-muted [&_code]:text-foreground [&_pre]:bg-muted">
    {renderLightMarkdown(text)}
  </div>;
}
