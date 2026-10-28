import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { getTenantDatabase } from "../services/tenant-database.service";
import { CatalogOrderingService } from "../catalog-ordering/service";
import { TenantDatabaseError } from "../tenant-database/error";

export function createCatalogOrderingRouter(
	service = new CatalogOrderingService(getTenantDatabase()),
) {
	const router = Router(),
		nonces = new Map<string, number>();
	router.post(
		"/api/instances/:instance/catalog-ordering",
		async (req, res) => {
			res.setHeader("Cache-Control", "no-store");
			const reject = (
				status: number,
				code: string,
				outcome = "NOT_COMMITTED",
			) => res.status(status).json({ code, outcome });
			const key = process.env["TENANT_TRANSACTION_SECRET"],
				timestamp = req.get("x-tenant-timestamp") ?? "",
				nonce = req.get("x-tenant-nonce") ?? "",
				signature = req.get("x-tenant-signature") ?? "",
				now = Date.now();
			if (!key || Buffer.byteLength(key) < 32)
				return reject(503, "TENANT_ORDERING_NOT_CONFIGURED");
			if (
				!/^\d{13}$/.test(timestamp) ||
				Math.abs(now - Number(timestamp)) > 60000 ||
				!/^[a-f0-9-]{36}$/i.test(nonce) ||
				!/^[a-f0-9]{64}$/i.test(signature) ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,190}$/.test(
					req.params["instance"] ?? "",
				)
			)
				return reject(401, "TENANT_ORDERING_UNAUTHORIZED");
			const body = JSON.stringify(req.body);
			if (!body || Buffer.byteLength(body) > 1048576)
				return reject(413, "TENANT_ORDERING_TOO_LARGE");
			const expected = createHmac("sha256", key)
				.update(`${timestamp}\n${nonce}\n${req.path}\n${body}`)
				.digest();
			if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
				return reject(401, "TENANT_ORDERING_UNAUTHORIZED");
			for (const [id, until] of nonces)
				if (until < now) nonces.delete(id);
			if (nonces.has(nonce))
				return reject(409, "TENANT_ORDERING_REPLAY", "UNKNOWN");
			if (nonces.size >= 10000)
				return reject(429, "TENANT_ORDERING_BUSY");
			nonces.set(nonce, Number(timestamp) + 60000);
			try {
				return res.json({
					data: await service.execute(
						req.params["instance"]!,
						req.body,
					),
				});
			} catch (error) {
				const safe =
					error instanceof TenantDatabaseError
						? error
						: new TenantDatabaseError(
								"TENANT_ORDERING_FAILED",
								"UNKNOWN",
							);
				return reject(
					safe.code === "TENANT_ORDERING_INVALID"
						? 400
						: [
									"TENANT_ORDERING_CHANGED",
									"TENANT_DUPLICATE_KEY",
									"TENANT_ORDERING_SCOPE_UNAVAILABLE",
									"TENANT_ORDERING_UNIT_UNAVAILABLE",
							  ].includes(safe.code)
							? 409
							: 503,
					safe.code,
					safe.outcome,
				);
			}
		},
	);
	return router;
}
