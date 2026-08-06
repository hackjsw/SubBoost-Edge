# Testing The Worker

`edge/worker/index.test.ts` is the request/cron contract suite. Its `MemoryKv`
implements get, put, delete, and list while recording TTL metadata. The login
helper obtains a real test session cookie, and the execution context helper
captures `waitUntil` promises.

For each protected API, test anonymous 401 plus the authenticated success and
failure branches. Test method guards separately. Mock GitHub rule-tree fetches
and assert cache reuse/refresh behavior without network access.

For scheduled work, call the Worker's `scheduled` handler with each configured
cron value and await captured promises. Assert KV writes and service results;
do not test cron behavior by waiting on wall-clock time.
