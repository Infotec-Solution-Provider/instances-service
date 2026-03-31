import axios from "axios";
import { prisma } from "./prisma.service";

interface StateItem {
	code: string;
	name: string;
}

interface MemoryEntry<T> {
	data: T;
	expiresAt: number;
}

class GeoCacheService {
	private static readonly IBGE_BASE_URL =
		"https://servicodados.ibge.gov.br/api/v1/localidades";
	private static readonly STATES_KEY = "states";
	private static readonly STATES_TTL_MS = 24 * 60 * 60 * 1000; // 24h
	private static readonly CITIES_TTL_MS = 24 * 60 * 60 * 1000; // 24h
	private static readonly memory = new Map<string, MemoryEntry<unknown>>();

	private static async safeFindDbCache(key: string) {
		try {
			return await prisma.geoCache.findUnique({ where: { key } });
		} catch (error) {
			console.error("(geo-cache) unable to read cache table, using memory only", error);
			return null;
		}
	}

	private static async safeUpsertDbCache(
		key: string,
		payload: unknown,
		expiresAtDate: Date,
	) {
		try {
			await prisma.geoCache.upsert({
				where: { key },
				create: {
					key,
					payload: payload as never,
					expiresAt: expiresAtDate,
				},
				update: {
					payload: payload as never,
					fetchedAt: new Date(),
					expiresAt: expiresAtDate,
				},
			});
		} catch (error) {
			console.error("(geo-cache) unable to persist cache table, using memory only", error);
		}
	}

	public static async getStates(): Promise<StateItem[]> {
		const data = await this.getOrRefresh<StateItem[]>(
			this.STATES_KEY,
			this.STATES_TTL_MS,
			this.fetchStatesFromIbge,
		);

		return [...data].sort((a, b) => a.name.localeCompare(b.name));
	}

	public static async getCitiesByState(uf: string): Promise<string[]> {
		const normalizedUf = uf.trim().toUpperCase();
		const key = `cities:${normalizedUf}`;

		const data = await this.getOrRefresh<string[]>(
			key,
			this.CITIES_TTL_MS,
			() => this.fetchCitiesFromIbge(normalizedUf),
		);

		return [...data].sort((a, b) => a.localeCompare(b));
	}

	private static async getOrRefresh<T>(
		key: string,
		ttlMs: number,
		fetcher: () => Promise<T>,
	): Promise<T> {
		const now = Date.now();
		const memoryEntry = this.memory.get(key) as MemoryEntry<T> | undefined;

		if (memoryEntry && memoryEntry.expiresAt > now) {
			return memoryEntry.data;
		}

		const dbCache = await this.safeFindDbCache(key);
		if (dbCache) {
			const cachedData = dbCache.payload as T;
			const expiresAt = dbCache.expiresAt.getTime();
			if (expiresAt > now) {
				this.memory.set(key, { data: cachedData, expiresAt });
				return cachedData;
			}
		}

		try {
			const freshData = await fetcher();
			const expiresAtDate = new Date(now + ttlMs);

			await this.safeUpsertDbCache(key, freshData, expiresAtDate);

			this.memory.set(key, {
				data: freshData,
				expiresAt: expiresAtDate.getTime(),
			});

			return freshData;
		} catch (error) {
			if (dbCache) {
				const staleData = dbCache.payload as T;
				this.memory.set(key, {
					data: staleData,
					expiresAt: now + 10 * 60 * 1000, // keep stale for 10 minutes
				});
				return staleData;
			}

			throw error;
		}
	}

	private static async fetchStatesFromIbge(): Promise<StateItem[]> {
		const response = await axios.get<Array<{ sigla: string; nome: string }>>(
			`${this.IBGE_BASE_URL}/estados`,
		);

		return response.data.map((state) => ({
			code: state.sigla,
			name: state.nome,
		}));
	}

	private static async fetchCitiesFromIbge(uf: string): Promise<string[]> {
		const response = await axios.get<Array<{ nome: string }>>(
			`${this.IBGE_BASE_URL}/estados/${uf}/municipios`,
		);

		return response.data.map((city) => city.nome);
	}
}

export default GeoCacheService;
