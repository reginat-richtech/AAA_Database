// Node-only — started from instrumentation.js behind a NEXT_RUNTIME==='nodejs'
// guard, so the node-only publish chain (pg, crypto, sharp) is never bundled
// for the edge runtime. Checks every 60s and auto-publishes approved Social
// Media posts whose scheduled time has arrived.
import { publishDuePosts } from './runScheduled';

export function startSocialScheduler() {
  if (process.env.SOCIAL_AUTOPUBLISH !== '1') return;          // gated off by default
  if (globalThis.__socialSchedulerStarted) return;            // start once per process
  globalThis.__socialSchedulerStarted = true;

  let running = false;
  const tick = async () => {
    if (running) return;            // skip if a previous tick is still working
    running = true;
    try {
      const r = await publishDuePosts();
      if (r.length) console.log(`[social-scheduler] processed ${r.length} due post(s):`, r.map((x) => `${x.platform}:${x.ok ? 'ok' : `FAIL(${x.error || '?'})`}`).join(' | '));
    } catch (e) {
      console.error('[social-scheduler] error:', e?.message || e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 5_000);     // first check shortly after startup
  setInterval(tick, 15_000);   // then every 15s — bounds lateness to ~15s
  console.log('[social-scheduler] started — first check in ~5s, then every 15s');
}
