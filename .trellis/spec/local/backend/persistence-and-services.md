# Persistence And Services

`local/src/lib/prisma.ts` owns the Prisma client and development singleton.
Schema ownership and cascade/index behavior live in
`local/prisma/schema.prisma`. Generate the client before type checking or
building; deploy migrations with the workspace script.

Services combine Prisma, encryption, and runtime adapters with shared
server-core orchestration. `subscription-service.ts` injects Local fetchers
into shared refresh functions and persists the resulting snapshot/cache. Keep
normalization and refresh-result policy in server-core; keep database writes,
admin ownership, and encrypted fields here.

Never store plaintext source credentials or log passwords, session tokens,
source URLs, subscription bodies, or decrypted secrets.
