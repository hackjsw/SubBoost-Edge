# Local Client Components

Local-only interactive components live in `local/src/components` and use
`"use client"`. `local-login.tsx` is the reference for form state, loading,
request errors, cancellation guards, and an `aria-live` error region.

Use component state for Local-only forms. Use shared `useUserStore`,
`useConfigStore`, toaster, and confirm dialog for existing cross-product state
and feedback. There is no Local hooks or store layer today; do not introduce
one merely to wrap a single component.

Never import Prisma, session signing, encrypted fields, or server environment
helpers into a client component.
