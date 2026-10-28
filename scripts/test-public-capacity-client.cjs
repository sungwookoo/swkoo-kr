const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let elapsed = 0;
const errors = [], urls = [];
const fakeProcess = { argv: ['node','client','60','unused'], env: { FIXTURE_WRITE_KEY: 'fixture' }, exitCode: 0 };
const context = {
  require: () => ({ writeFileSync: () => assert.fail('A stalled client must not report success') }),
  process: fakeProcess, performance: { now: () => elapsed }, AbortController, AbortSignal,
  setTimeout: (callback, ms) => { elapsed += ms; queueMicrotask(callback); },
  console: { log: () => {}, error: message => errors.push(message) },
  fetch: (url, options) => {
    urls.push(url);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
  },
};
const deadline = setTimeout(() => { throw Error('Stalled clients did not abort immediately'); }, 1000);
Promise.resolve(vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'public-capacity-client.cjs'),'utf8'), context))
  .then(() => {
    assert.equal(fakeProcess.exitCode, 1);
    assert(errors.some(message => /concurrency bound/i.test(message)));
    assert(urls.length <= 6);
    assert(urls.every(url => /^https:\/\/swkoo-load-[abc]\.apps\.swkoo\.kr\//.test(url)));
    console.log('PASS stalled external clients abort at the concurrency bound without network access');
  }).finally(() => clearTimeout(deadline));
