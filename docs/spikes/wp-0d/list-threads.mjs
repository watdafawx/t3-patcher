// prints thread ids from orchestration.subscribeShell's first items (helper for the CDP thread-capture step)
import { openTunnel, getDesktopBearer, issueTicket, RpcSocket, sleep } from './lib.mjs';
const t = await openTunnel(2);
try {
  const tk = await issueTicket(t.httpBase, await getDesktopBearer(t.cdpPort));
  const s = await new RpcSocket(`${t.wsBase}/ws?wsTicket=${encodeURIComponent(tk.json.ticket)}&orchestrationProtocol=2`).open();
  const sub = s.subscribe('orchestration.subscribeShell', { afterSequence: 0, omitIdleSubagents: true }, (v) => console.log(JSON.stringify(v).slice(0, 600)));
  await sleep(1500); sub.cancel(); s.close();
} finally { t.close(); }
