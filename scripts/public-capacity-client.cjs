// Only the three disposable validation hosts. Never accepts arbitrary targets.
const fs = require('node:fs');
const seconds = Number(process.argv[2]);
if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600 || !process.env.FIXTURE_WRITE_KEY) throw Error('Invalid validation duration or key');
const controller = new AbortController();
async function run(suffix) {
  const url = `https://swkoo-load-${suffix}.apps.swkoo.kr`, results = [];
  for (const [rps, duration] of [[1,15],[3,15],[5,15],[2,seconds]]) {
    const times = [], pending = new Set(), types = { ssr: 0, read: 0, write: 0 };
    const began = performance.now(); let errors = 0, skipped = 0;
    for (let i = 0; i < rps * duration; i++) {
      if (controller.signal.aborted) throw Error('Another client failed');
      const delay = began + i * 1000 / rps - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (pending.size >= 2) { skipped++; continue; }
      const started = performance.now(), kind = i % 10 === 0 ? 'write' : i % 2 === 0 ? 'ssr' : 'read';
      const task = (async () => {
        try {
          const response = await fetch(url + (kind === 'ssr' ? '/' : '/api/records'), {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
            ...(kind === 'write' ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-validation-key': process.env.FIXTURE_WRITE_KEY }, body: JSON.stringify({ value: 'https-' + i }) } : {}),
          });
          if (!response.ok) throw Error('HTTP ' + response.status);
          if (kind === 'ssr') { if (!(await response.text()).includes('SQLite')) throw Error('SSR content'); }
          else { const body = await response.json(); if (kind === 'read' && (!Array.isArray(body.records) || body.count < 0)) throw Error('API content'); }
          types[kind]++; times.push(performance.now() - started);
        } catch { errors++; controller.abort(); }
      })();
      pending.add(task); task.finally(() => pending.delete(task));
    }
    await Promise.all(pending); times.sort((a,b) => a-b);
    results.push({ rps, seconds: duration, requests: times.length, types, errors, skipped, p95Ms: times[Math.ceil(times.length * .95) - 1] ?? null });
    if (errors || skipped) { controller.abort(); throw Error('HTTPS client failed: ' + suffix); }
  }
  return { suffix, results };
}
Promise.all(['a','b','c'].map(run)).then(results => {
  fs.writeFileSync(process.argv[3], JSON.stringify({ results })); console.log('HTTPS clients completed');
}).catch(error => { controller.abort(); console.error(error.message); process.exitCode = 1; });
