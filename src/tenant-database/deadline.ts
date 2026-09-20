import { TenantDatabaseError } from "./error";

export function deadline<T>(
	operation: Promise<T>,
	milliseconds: number,
	code: string,
	late?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			reject(new TenantDatabaseError(code));
		}, milliseconds);
		void operation.then(
			(value) => {
				if (settled) {
					late?.(value);
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(
						error instanceof TenantDatabaseError
							? error
							: new TenantDatabaseError(code),
					);
				}
			},
		);
	});
}
