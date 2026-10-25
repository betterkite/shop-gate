import { redirect } from 'next/navigation';

// R3 adds the overview after actual ledger-backed UI/Agent acceptance.
// Until then this entry opens a real workflow, not empty module tabs.
export default function BiEntry() { redirect('/bi/data'); }
