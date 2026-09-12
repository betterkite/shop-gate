"use client";

type ChatAvailabilityStateProps = {
  status: 'checking' | 'missing' | 'error';
  onBack: () => void;
};

export function ChatAvailabilityState({ status, onBack }: ChatAvailabilityStateProps) {
  const statusMessage = status === 'missing'
    ? '项目不存在，正在返回首页…'
    : status === 'error'
      ? '项目暂时无法加载，请返回首页后重试。'
      : '正在载入项目…';

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center">
      <div>
        {status === 'error' ? (
          <button type="button" onClick={onBack} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
            返回首页
          </button>
        ) : (
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" aria-hidden="true" />
        )}
        <p className="mt-4 text-sm font-medium text-foreground">{statusMessage}</p>
      </div>
    </main>
  );
}
