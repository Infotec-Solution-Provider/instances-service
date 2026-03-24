# Copilot Instructions for `instances-service`

## Purpose
`instances-service` is the **most critical service** in the In.pulse CRM platform. It exists because the platform integrates with a legacy CRM where each tenant's database runs **on the tenant's own local server**. This service bridges that gap by serving two roles:

1. **Instance registry**: stores tenant metadata (instances/clients), their per-tenant MySQL DB connection credentials (host, port, user, password, database), and arbitrary per-tenant JSON configuration parameters.
2. **SQL proxy gateway**: maintains a managed pool of MySQL connections (one per tenant) and executes raw SQL queries against tenant databases on behalf of any other service. **Every query that reads customers, loyalty data, users, or any CRM data from a tenant's local database passes through this service.**

No other service opens direct connections to tenant databases. They all use `InstancesClient` from `@in.pulse-crm/sdk` to route queries through this service.

## Tech stack
| Concern | Choice |
|---|---|
| Runtime | Node.js + TypeScript 5 |
| Framework | Express 4 + `express-async-errors` |
| ORM | Prisma 5 (`@prisma/client`) — for the **instances registry DB only** |
| Tenant DB driver | `mysql2` (raw connection pools, no ORM) |
| Validation | `class-validator` + `class-transformer` |
| Auth | `jsonwebtoken` (ephemeral secret per process start) |
| Shared libs | `@in.pulse-crm/utils` (`Logger`, `logRoutes`), `@rgranatodutra/http-errors` |
| Port | `8000` (configurable via `LISTEN_PORT`) |

## Folder structure (`src/`)
```
src/
├── main.ts                        # Bootstrap: Express, CORS, mounts all controllers, starts server
├── controllers/
│   ├── auth.controller.ts         # POST /api/instances/root/auth — login → JWT
│   ├── instances.controller.ts    # CRUD for tenant instance records
│   ├── servers.controller.ts      # PUT server connection config per instance (auth-gated)
│   ├── parameters.controller.ts   # PUT JSON parameters per instance (auth-gated)
│   └── pools.controller.ts        # POST query — executes SQL on tenant DB (internal only)
├── services/
│   ├── prisma.service.ts          # Singleton PrismaClient export
│   ├── auth.service.ts            # JWT sign/verify + validateTokenMiddleware
│   ├── instances.service.ts       # Prisma CRUD for Instance + relations
│   ├── servers.service.ts         # Prisma upsert/get for Server (DB credentials)
│   ├── parameters.service.ts      # Prisma upsert for Parameters (JSON blob)
│   └── pools.service.ts           # Dynamic mysql2 pool management + query execution with retry
├── dtos/
│   ├── login.dto.ts               # { login, password }
│   ├── create-instance.dto.ts     # { name, server?, parameters? }
│   ├── create-server.dto.ts       # ServerDto: { host, port, username, password, database }
│   ├── create-parameter.dto.ts    # { parameters: Record<string, any> }
│   └── query.dto.ts               # { query: string, parameters?: unknown[] }
└── entities/
    └── client-pool.entity.ts      # Wraps a mysql2 Pool with query/ping/destroy methods
```

## API shape
All routes are prefixed with `/api/instances`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/instances/root/auth` | No | Login with `login`/`password` → returns JWT |
| POST | `/api/instances` | No | Create a new tenant instance (with optional server + parameters) |
| GET | `/api/instances` | No | List all instances (includes server + parameters) |
| GET | `/api/instances/:clientName` | No | Get one instance by name |
| PUT | `/api/instances/:clientName/server` | **JWT** | Set/update the MySQL DB credentials for a tenant |
| PUT | `/api/instances/:clientName/parameters` | **JWT** | Set/update the JSON parameters blob for a tenant |
| POST | `/api/instances/:clientName/query` | No (internal) | Execute a raw SQL query against the tenant's DB |

### Auth mechanism
- `POST /api/instances/root/auth` accepts `{ login, password }` and returns `{ token }`.
- The JWT secret is a `randomUUID()` generated at **process startup** — tokens do not survive restarts.
- Tokens expire after **1 day**.
- `AuthService.validateTokenMiddleware` extracts the Bearer token from `Authorization` header and calls `jwt.verify`. Only the `PUT /server` and `PUT /parameters` endpoints require this token.
- The `/query` endpoint has **no authentication** — it must only be accessible to trusted internal services (never exposed publicly).

### Response shape
```json
{ "message": "...", "data": { ... } }
```
Error responses use `handleRequestError` from `@rgranatodutra/http-errors`.

## Build / dev commands
```bash
npm run dev         # ts-node-dev --transpile-only --respawn src/main.ts (hot reload)
npm run build       # tsc → dist/
npm run start:prod  # node dist/server.js
```

## Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `LISTEN_PORT` | `8000` | HTTP server port |
| `INSTANCES_DATABASE_URL` | — | MySQL connection string for the **instances registry DB** (Prisma) |

## How other services depend on this
Every backend service that needs tenant DB access uses `InstancesClient` from `@in.pulse-crm/sdk`:

```ts
import { InstancesClient } from "@in.pulse-crm/sdk";
const instancesService = new InstancesClient(process.env.INSTANCES_API_URL);
// executes a raw query on the tenant DB:
await instancesService.executeQuery(instance, sql, bindings);
```

This calls `POST /api/instances/:clientName/query` under the hood. Services like `customers-service` build queries with Knex and ship the raw SQL + bindings to this endpoint — they never hold direct DB connections.

## Prisma schema overview
The registry DB has four models:

| Model | Table | Description |
|---|---|---|
| `User` | `users` | Admin users for managing instances. Fields: `id`, `name`, `login` (unique), `password` (plain text — legacy). |
| `Instance` | `clients` | Tenant records. PK is `name` (string, 3–16 chars). Has optional `server` and `parameters` relations. |
| `Server` | `clients_servers` | MySQL credentials per tenant: `host`, `port`, `username`, `password`, `database`. One-to-one with `Instance`. |
| `Parameters` | `clients_parameters` | Arbitrary JSON config blob per tenant stored in a `parameters Json` column. One-to-one with `Instance`. |

The registry DB holds **no CRM data** — only the instance registry itself.

## Connection pool management (`PoolsService`)
`PoolsService` maintains a static in-memory array of `ClientPool` instances (one per tenant):

- **Lazy creation**: pools are created on first query for a given `instanceName`.
- **Health check**: a 30-second `setInterval` pings each pool with `SELECT 1`; failed pools are removed and recreated on next query.
- **Retry logic**: up to 3 attempts with exponential backoff (1s → 2s → 4s capped at 5s) on connection errors (`PROTOCOL_CONNECTION_LOST`, `ECONNRESET`, `ETIMEDOUT`, etc.).
- **Pool config**: `connectionLimit: 10`, `connectTimeout: 10000`, `charset: latin1_swedish_ci` (legacy tenant schema), `enableKeepAlive: true`.
- **Payload limit**: the `/query` route handles up to **20 MB** request bodies.

## Code conventions
- **Services use static methods**: unlike other services in the platform, `InstancesService`, `ServersService`, `ParametersService`, `AuthService`, and `PoolsService` all export `default ClassName` with purely `static` methods — no instances needed.
- **Controllers** follow the same class-based pattern as the rest of the platform: `public readonly router` registered in the constructor, `private async` handler methods returning `Promise<Response>`.
- **DTOs**: `class-validator` decorators on class properties; `class-transformer` `@Type` for nested objects. Validated via the `validateDto` middleware from `inpulse-crm/utils/src/validateDto`.
- **Error handling**: throw typed errors from `@rgranatodutra/http-errors` (`NotFoundError`, `ConflictError`, `UnauthenticatedError`, `UnauthorizedError`). `express-async-errors` propagates async throws. `handleRequestError` serializes to JSON.
- **Naming**: `PascalCase` classes, `camelCase` variables. File names follow `<feature>.controller.ts`, `<feature>.service.ts`, `<feature>.dto.ts`, `<feature>.entity.ts` conventions.
- **TypeScript**: strict mode fully enabled (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.). `module: NodeNext`, `target: es2022`.

## Critical invariants
- **Never add direct tenant DB connections in other services.** All tenant SQL must go through this service's `/query` endpoint.
- **The auth secret is ephemeral.** Any issued tokens are invalidated on restart. Do not rely on token persistence across deploys.
- **The `/query` endpoint has no auth guard.** It must be network-isolated (e.g., accessible only within the internal service network, not through an API gateway exposed to the internet).
- **`PoolsService` is stateful.** Restarting the service drops all connection pools — they are recreated lazily on first use.
- **Passwords are stored in plain text** in the `users` table (legacy). Do not add new features that store secrets in cleartext.
