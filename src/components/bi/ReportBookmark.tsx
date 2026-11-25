'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { viewChange } from '@/lib/bi/report-contracts';
import type { BiAgentPageScope } from '@/lib/bi/agent/contracts';
export function ReportBookmark({ workspaceId, datasetId, version, page, conversationId, runId, title, onSaved }: {
  workspaceId:string; datasetId:string; version:number; page:BiAgentPageScope; conversationId:string; runId:string;
  title:string; onSaved:(id:string)=>void;
}) {
  const [name,setName] = useState(title.slice(0,120)), [open,setOpen] = useState(false), [busy,setBusy] = useState(false);
  const [error,setError] = useState(''); const intent = useRef<{key:string;id:string}|null>(null);
  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    const {module, report, ...query} = page;
    if (module !== 'reports') {setBusy(false);return;}
    const key = JSON.stringify([version,runId,name]);
    if (intent.current?.key !== key) intent.current={key,id:crypto.randomUUID()};
    try {
      const result = await readBi('/api/bi/reports/views', viewChange,{method:'POST',body:JSON.stringify({
        workspace_id:workspaceId,dataset_id:datasetId,version,options:{action:'create',name,view_id:intent.current.id,
          options:{...report, report_type:report?.report_type ?? 'daily',query},topic:{conversation_id:conversationId,run_id:runId}},
      })});
      setOpen(false); onSaved(result.view.view_id);
    } catch(e) {setError(dataErrorMessage(e));}
    finally {setBusy(false);}
  }
  return <div className="mt-4">{!open ? <Button size="sm" variant="outline" onClick={()=>setOpen(true)}>将这次回答保存为专题</Button> :
    <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void save();}}>
      <Input className="max-w-sm" aria-label="专题名称" value={name} maxLength={120} onChange={e=>setName(e.target.value)} />
      <Button type="submit" size="sm" disabled={busy || !name.trim()}>确认保存专题</Button>
      <Button type="button" size="sm" variant="outline" onClick={()=>setOpen(false)}>取消</Button></form>}
    {error && <p role="alert" className="mt-2 text-sm">{error}</p>}</div>;
}
