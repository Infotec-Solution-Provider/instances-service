import { execFile } from "node:child_process";
import { createConnection } from "node:net";

interface ProbeTarget {
	host: string;
	port: number;
}

export interface ZeroTierRecoveryConfig {
	enabled: boolean;
	intervalMs: number;
	failureThreshold: number;
	cooldownMs: number;
	startupGraceMs: number;
	commandTimeoutMs: number;
	restartTimeoutMs: number;
	networkIds: string[];
	probeTargets: ProbeTarget[];
	cliPath: string;
	useSudo: boolean;
}

export type HealthResult =
	| { healthy: true }
	| { healthy: false; reason: string; restartAllowed: boolean };

export interface RecoveryDependencies {
	check: () => Promise<HealthResult>;
	restart: () => Promise<void>;
	now: () => number;
	log: (message: string) => void;
}

export function readZeroTierRecoveryConfig(
	env: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
): ZeroTierRecoveryConfig {
	const enabled = env["ZEROTIER_RECOVERY_ENABLED"] === "true";
	const integer = (key: string, fallback: number, minimum: number) => {
		const raw = env[key]?.trim();
		const value = raw ? Number(raw) : fallback;
		if (
			enabled &&
			(!Number.isSafeInteger(value) ||
				value < minimum ||
				value > 2147483647)
		) {
			throw new Error(
				`${key} deve ser um inteiro entre ${minimum} e 2147483647`,
			);
		}
		return value;
	};
	const networkIds = (env["ZEROTIER_RECOVERY_NETWORK_IDS"] || "")
		.split(",")
		.map((id) => id.trim().toLowerCase())
		.filter(Boolean);
	if (enabled && networkIds.some((id) => !/^[a-f0-9]{16}$/.test(id))) {
		throw new Error(
			"ZEROTIER_RECOVERY_NETWORK_IDS deve conter IDs hexadecimais de 16 caracteres",
		);
	}
	const probeTargets: ProbeTarget[] = [];
	if (enabled) {
		for (const target of (env["ZEROTIER_RECOVERY_PROBE_TARGETS"] || "")
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean)) {
			const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(target);
			const host = match?.[1] || match?.[2];
			const port = Number(match?.[3]);
			if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
				throw new Error(
					"ZEROTIER_RECOVERY_PROBE_TARGETS deve conter host:porta separados por virgula",
				);
			}
			probeTargets.push({ host, port });
		}
		if (
			probeTargets.length &&
			new Set(probeTargets.map((target) => target.host.toLowerCase()))
				.size < 2
		) {
			throw new Error(
				"ZEROTIER_RECOVERY_PROBE_TARGETS requer pelo menos dois hosts distintos",
			);
		}
		if (platform !== "linux" && platform !== "win32") {
			throw new Error(
				"Recuperacao ZeroTier suporta Linux com systemd e Windows",
			);
		}
	}
	return {
		enabled,
		intervalMs: integer("ZEROTIER_RECOVERY_INTERVAL_MS", 5000, 5000),
		failureThreshold: integer("ZEROTIER_RECOVERY_FAILURE_THRESHOLD", 3, 2),
		cooldownMs: integer("ZEROTIER_RECOVERY_COOLDOWN_MS", 60000, 5000),
		startupGraceMs: integer(
			"ZEROTIER_RECOVERY_STARTUP_GRACE_MS",
			5000,
			5000,
		),
		commandTimeoutMs: integer(
			"ZEROTIER_RECOVERY_COMMAND_TIMEOUT_MS",
			5000,
			5000,
		),
		restartTimeoutMs: integer(
			"ZEROTIER_RECOVERY_RESTART_TIMEOUT_MS",
			5000,
			5000,
		),
		networkIds,
		probeTargets,
		cliPath:
			env["ZEROTIER_CLI_PATH"]?.trim() ||
			(platform === "win32"
				? "C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe"
				: "/usr/sbin/zerotier-cli"),
		useSudo: env["ZEROTIER_RECOVERY_USE_SUDO"] === "true",
	};
}

export type CommandRunner = (
	file: string,
	args: string[],
	timeout: number,
) => Promise<string>;

const runCommand: CommandRunner = (file, args, timeout) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				timeout,
				windowsHide: true,
				maxBuffer: 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(Object.assign(error, { stdout, stderr }));
				} else {
					resolve(stdout);
				}
			},
		);
	});

export function probeTcp(
	target: ProbeTarget,
	timeoutMs = 5000,
): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(target);
		const finish = (healthy: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(healthy);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function diagnosticFailure(error: unknown, useSudo: boolean): HealthResult {
	const failure = error as {
		code?: string | number;
		killed?: boolean;
		stderr?: string;
		stdout?: string;
	} | null;
	// A CLI publica erros de conexao em stdout e erros de autenticacao em stderr.
	const output = `${failure?.stderr || ""}\n${failure?.stdout || ""}`;
	// Permissoes/configuracao nao sao corrigidas reiniciando a rede. Nao registrar tokens/saida bruta.
	const blocked = (reason: string): HealthResult => ({
		healthy: false,
		restartAllowed: false,
		reason,
	});
	if (failure?.code === "ENOENT") {
		return blocked(
			useSudo
				? "sudo nao encontrado em /usr/bin/sudo; verificar instalacao"
				: "CLI nao encontrada; verificar ZEROTIER_CLI_PATH e instalacao do ZeroTier",
		);
	}
	if (failure?.code === "EACCES") {
		return blocked(
			useSudo
				? "sem permissao para executar /usr/bin/sudo; verificar executavel e diretorios"
				: "sem permissao para executar a CLI; verificar executavel e diretorios",
		);
	}
	if (/authtoken|authentication/i.test(output)) {
		return blocked(
			"autenticacao local da CLI falhou; verificar acesso ao token e usuario do processo" +
				(useSudo
					? " (sudo habilitado)"
					: "; conferir ZEROTIER_RECOVERY_USE_SUDO no Linux"),
		);
	}
	if (
		/sudo:.*(?:command not found|no such file or directory)/i.test(output)
	) {
		return blocked(
			"CLI nao encontrada pelo sudo; verificar ZEROTIER_CLI_PATH e instalacao do ZeroTier",
		);
	}
	if (/sudo:|password|not allowed/i.test(output)) {
		return blocked(
			"sudo ou autorizacao da CLI falhou; verificar sudo -n e regra NOPASSWD para os argumentos exatos -j info e -j listnetworks",
		);
	}
	if (/permission|access denied/i.test(output)) {
		return blocked(
			"CLI sem permissao; verificar usuario do processo, acesso ao token e configuracao de sudo",
		);
	}
	if (
		failure?.killed ||
		/error connecting to the zerotier service|connection refused|connection timed out/i.test(
			output,
		)
	) {
		return {
			healthy: false,
			restartAllowed: true,
			reason: "daemon local nao respondeu ao CLI",
		};
	}
	return {
		healthy: false,
		restartAllowed: false,
		reason: "diagnostico ZeroTier invalido; verificar CLI/configuracao",
	};
}

export function createZeroTierDependencies(
	config: ZeroTierRecoveryConfig,
	platform = process.platform,
	run: CommandRunner = runCommand,
	probe: (target: ProbeTarget) => Promise<boolean> = probeTcp,
): RecoveryDependencies {
	const cli = async (command: string): Promise<unknown> => {
		const args = [...(platform === "win32" ? ["-q"] : []), "-j", command];
		const output =
			platform === "linux" && config.useSudo
				? await run(
						"/usr/bin/sudo",
						["-n", config.cliPath, ...args],
						config.commandTimeoutMs,
					)
				: await run(config.cliPath, args, config.commandTimeoutMs);
		return JSON.parse(output) as unknown;
	};
	return {
		now: Date.now,
		log: (message) => console.log(`[ZeroTierRecovery] ${message}`),
		check: async () => {
			try {
				const info = (await cli("info")) as {
					online?: boolean;
					tcpFallbackActive?: boolean;
				} | null;
				if (!info || typeof info.online !== "boolean") {
					return {
						healthy: false,
						restartAllowed: false,
						reason: "resposta info sem estado online valido",
					};
				}
				if (!info.online && info.tcpFallbackActive !== true) {
					return {
						healthy: false,
						restartAllowed: true,
						reason: "ZeroTier OFFLINE",
					};
				}
				if (config.networkIds.length) {
					const networks = await cli("listnetworks");
					if (!Array.isArray(networks)) {
						return {
							healthy: false,
							restartAllowed: false,
							reason: "resposta listnetworks invalida",
						};
					}
					let networkFailure: HealthResult | undefined;
					for (const id of config.networkIds) {
						const network = networks.find(
							(item) => item?.id === id || item?.nwid === id,
						);
						if (
							!network ||
							![
								"OK",
								"PORT_ERROR",
								"REQUESTING_CONFIGURATION",
							].includes(network.status)
						) {
							return {
								healthy: false,
								restartAllowed: false,
								reason: `rede ${id} ausente, nao autorizada ou com estado nao recuperavel`,
							};
						}
						if (network.status !== "OK") {
							networkFailure = {
								healthy: false,
								restartAllowed: true,
								reason: `rede ${id}: ${network.status}`,
							};
						}
					}
					if (networkFailure) return networkFailure;
				}
				if (config.probeTargets.length) {
					const results = await Promise.all(
						config.probeTargets.map((target) => probe(target)),
					);
					if (!results.some(Boolean)) {
						return {
							healthy: false,
							restartAllowed: true,
							reason: "todos os destinos TCP configurados estao inacessiveis",
						};
					}
				}
				return { healthy: true };
			} catch (error) {
				return diagnosticFailure(
					error,
					platform === "linux" && config.useSudo,
				);
			}
		},
		restart: async () => {
			if (platform === "linux") {
				const args = ["restart", "zerotier-one"];
				if (config.useSudo) {
					await run(
						"/usr/bin/sudo",
						["-n", "/usr/bin/systemctl", ...args],
						config.restartTimeoutMs,
					);
				} else {
					await run(
						"/usr/bin/systemctl",
						args,
						config.restartTimeoutMs,
					);
				}
			} else if (platform === "win32") {
				await run(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"$ErrorActionPreference = 'Stop'; Restart-Service -Name 'ZeroTierOneService' -Force -ErrorAction Stop",
					],
					config.restartTimeoutMs,
				);
			} else {
				throw new Error(
					"Plataforma sem suporte para reinicio ZeroTier",
				);
			}
		},
	};
}

export class ZeroTierRecoveryService {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private stopped = false;
	private generation = 0;
	private running = false;
	private failures = 0;
	private lastRestartAt: number | undefined;
	private waitingForRecovery = false;
	private lastBlockedLog: { reason: string; at: number } | undefined;

	constructor(
		private readonly config: ZeroTierRecoveryConfig,
		private readonly dependencies: RecoveryDependencies = createZeroTierDependencies(
			config,
		),
	) {}

	public start(): void {
		if (!this.config.enabled || this.started) return;
		this.started = true;
		this.stopped = false;
		this.generation++;
		this.lastBlockedLog = undefined;
		this.dependencies.log(
			"monitor habilitado; aguardando periodo inicial de estabilizacao",
		);
		this.schedule(this.config.startupGraceMs);
	}

	public stop(): void {
		this.started = false;
		this.stopped = true;
		this.generation++;
		clearTimeout(this.timer);
	}

	private schedule(delay: number): void {
		const generation = this.generation;
		this.timer = setTimeout(async () => {
			try {
				await this.checkNow();
			} finally {
				if (this.started && generation === this.generation) {
					this.schedule(this.config.intervalMs);
				}
			}
		}, delay);
		this.timer.unref();
	}

	public async checkNow(): Promise<void> {
		if (!this.config.enabled || this.running || this.stopped) return;
		this.running = true;
		const generation = this.generation;
		try {
			const health = await this.dependencies.check();
			if (this.stopped || generation !== this.generation) return;
			if (health.healthy) {
				if (
					this.failures ||
					this.waitingForRecovery ||
					this.lastBlockedLog
				)
					this.dependencies.log(
						"conectividade verificada; monitor saudavel",
					);
				this.failures = 0;
				this.waitingForRecovery = false;
				this.lastBlockedLog = undefined;
				return;
			}
			if (!health.restartAllowed) {
				this.failures = 0;
				const now = this.dependencies.now();
				// Manter as verificacoes ativas, mas repetir o mesmo bloqueio no maximo uma vez por minuto.
				if (
					this.lastBlockedLog?.reason !== health.reason ||
					now - this.lastBlockedLog.at >= 60000
				) {
					this.dependencies.log(
						`reinicio bloqueado: ${health.reason}`,
					);
					this.lastBlockedLog = { reason: health.reason, at: now };
				}
				return;
			}
			this.lastBlockedLog = undefined;
			this.failures++;
			this.dependencies.log(
				`falha ${this.failures}/${this.config.failureThreshold}: ${health.reason}`,
			);
			if (this.failures < this.config.failureThreshold) return;
			const now = this.dependencies.now();
			if (
				this.lastRestartAt !== undefined &&
				now - this.lastRestartAt < this.config.cooldownMs
			) {
				this.dependencies.log(
					"aguardando intervalo minimo entre tentativas de reinicio",
				);
				return;
			}
			// Reservar o cooldown antes de executar: falhas de permissao tambem contam como tentativa.
			this.lastRestartAt = now;
			this.failures = 0;
			this.waitingForRecovery = true;
			this.dependencies.log(
				`reiniciando servico local ZeroTier: ${health.reason}`,
			);
			try {
				await this.dependencies.restart();
				this.dependencies.log(
					"comando de reinicio concluido; aguardando verificacao de conectividade",
				);
			} catch {
				this.dependencies.log(
					"reinicio falhou; verificar permissoes e logs do servico local; cooldown mantido",
				);
			}
		} catch {
			this.failures = 0;
			this.lastBlockedLog = undefined;
			this.dependencies.log(
				"erro inesperado no monitor; nenhum reinicio solicitado",
			);
		} finally {
			this.running = false;
		}
	}
}

export function startZeroTierRecovery(): ZeroTierRecoveryService | undefined {
	if (process.env["ZEROTIER_RECOVERY_ENABLED"] !== "true") return undefined;
	// No PM2 padrao, apenas o worker 0 assume o monitor do servico compartilhado.
	if (
		process.env["NODE_APP_INSTANCE"] !== undefined &&
		process.env["NODE_APP_INSTANCE"] !== "0"
	)
		return undefined;
	try {
		const service = new ZeroTierRecoveryService(
			readZeroTierRecoveryConfig(),
		);
		service.start();
		return service;
	} catch (error) {
		console.error(
			"[ZeroTierRecovery] monitor desativado por configuracao invalida:",
			error instanceof Error ? error.message : "erro desconhecido",
		);
		return undefined;
	}
}
