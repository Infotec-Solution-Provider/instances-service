import { TransactionOutcome } from "./contracts";

/** Deliberately excludes driver SQL, parameters, credentials and raw causes. */
export class TenantDatabaseError extends Error {
	constructor(
		public readonly code: string,
		public readonly outcome: TransactionOutcome = "NOT_COMMITTED",
	) {
		super(code);
		this.name = "TenantDatabaseError";
	}
}
