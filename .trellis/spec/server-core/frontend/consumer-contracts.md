# Consumer Contracts

The browser should receive stable DTOs and shared API error bodies, not service
objects. Use the existing response contracts exported from
`@subboost/server-core/subscription`, `rules`, and `http`.

Application adapters should parse unknown JSON and turn non-OK responses into
an `Error` before passing data into shared surfaces. See
`edge/app/dashboard/page.tsx` and `local/app/dashboard/page.tsx`.

Do not import `@subboost/server-core/crypto`, direct refresh orchestrators, or
SSRF helpers into client components. Do not duplicate response types with
slightly different optional fields in each surface; extend the shared contract
when the server response changes for both runtimes.
