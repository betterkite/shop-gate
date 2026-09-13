"use client";

import { useState } from "react";

export function GenerateDailyBriefButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function onClick() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/commerce/briefing/daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        throw new Error(body?.error ?? `生成失败（HTTP ${response.status}）`);
      }
      setMessage(`已生成日报：${body.data?.date ?? ""}`);
      setTimeout(() => window.location.reload(), 500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
      >
        {busy ? "生成中…" : "生成今日日报"}
      </button>
      {message ? <span className="text-sm text-green-600">{message}</span> : null}
      {error ? <span className="text-sm text-red-500">{error}</span> : null}
    </div>
  );
}
