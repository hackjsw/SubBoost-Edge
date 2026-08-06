# API And Authentication

Next route modules under `local/app/api` should remain small. Dynamic
subscription routes delegate to `local/src/lib/subscription-route-handlers.ts`,
which applies authentication, body validation, service calls, and HTTP mapping.

Use `withCurrentAdmin` for protected endpoints. Auth login reads a validated
body, compares the bcrypt hash, updates last login, signs a session, and sets an
HTTP-only cookie. Do not perform protected service work before the current admin
is resolved.

Use `json`, `apiError`, and `readJsonBody` from `local/src/lib/http.ts`.
Malformed JSON returns `null`; public errors use the shared `{ error, code }`
shape from `@subboost/server-core/http`. Keep method contracts in the route
module and domain work in a service.
