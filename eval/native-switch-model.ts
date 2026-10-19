import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import {
	assertNativeHostIdentity,
	parsePermissionHttpResponse,
	validateNativeEndpoint,
} from "./native-permissions";

export type SwitchApi = {
	read: (sessionID: string) => Promise<unknown>;
	switch: (sessionID: string, body: unknown) => Promise<unknown>;
};
type Observation = {
	sent: string;
	before?: unknown;
	after?: unknown;
	response?: unknown;
	error?: string;
	beforeError?: string;
	readbackError?: string;
	switchOutcome: "not-attempted" | "succeeded" | "error";
	errorStatus?: number;
};

export type SwitchWorkspaceFacts = {
	topLevel: string;
	realRoot: string;
	realEvidenceRoot: string;
	head: string;
	branch: string;
	gitDir: string;
	commonGitDir: string;
	registered: Array<{ directory: string; head: string; branch?: string }>;
	ignoredOutput: boolean;
	trackedOutput: boolean;
	outputExists: boolean;
	outputDirectoryExists: boolean;
};
type SwitchCall = {
	at: string;
	method: string;
	path: string;
	phase: "campaign" | "recovery";
	sent?: string;
	status?: number;
	response?: unknown;
	error?: string;
};
type Restoration = {
	status: "not-created" | "verified" | "uncertain";
	response?: unknown;
	error?: string;
	readback?: unknown;
	readbackError?: string;
	stateVerified?: boolean;
};
export type SwitchCampaign = {
	started: string;
	finished?: string;
	directory: string;
	output: string;
	sessionIDs: string[];
	requests: SwitchCall[];
	observations: Observation[];
	stop?: string;
	evidenceError?: string;
	finalization: "pending-close" | "closed" | "uncertain";
	restoration: Restoration;
	owner: string;
	status: string;
	cleanup: string;
	metadata: Record<string, unknown>;
	createdAttempts: number;
	switchAttempts: number;
};
export type SwitchIO = {
	workspace: (root: string, output: string) => Promise<SwitchWorkspaceFacts>;
	reserve: (output: string) => Promise<{
		write: (snapshot: SwitchCampaign) => Promise<void>;
		close: () => Promise<void>;
	}>;
	fetch: (
		url: string,
		init: RequestInit,
	) => Promise<Pick<Response, "status" | "text">>;
	now: () => number;
};

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const unwrap = (value: unknown): unknown =>
	"data" in record(value) ? record(value).data : value;
const normalize = (path: string) =>
	path.replaceAll("\\", "/").replace(/\/+$/, "");
const samePath = (a: string, b: string) =>
	/^[A-Za-z]:\//.test(normalize(a))
		? normalize(a).toLowerCase() === normalize(b).toLowerCase()
		: normalize(a) === normalize(b);
const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)) ||
	"Unspecified failure";
const exists = async (path: string) => {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (record(error).code === "ENOENT") return false;
		throw error;
	}
};

const nativeIO: SwitchIO = {
	workspace: async (root, output) => {
		const run = (args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd: root, timeout: 10_000 });
		const git = (args: string[]) => {
			const result = run(args);
			if (result.exitCode !== 0)
				throw new Error("SP-4 workspace Git inspection failed");
			return result.stdout.toString().trim();
		};
		const relative = output.slice(root.length + 1);
		const ignored = run(["check-ignore", "--quiet", "--", relative]);
		const tracked = run(["ls-files", "--error-unmatch", "--", relative]);
		if (
			![0, 1].includes(ignored.exitCode) ||
			![0, 1].includes(tracked.exitCode)
		)
			throw new Error("SP-4 workspace output inspection failed");
		const registered = git(["worktree", "list", "--porcelain"])
			.replaceAll("\r", "")
			.split("\n\n")
			.filter(Boolean)
			.map((block) => {
				const fields = block
					.split("\n")
					.reduce<Record<string, string>>((result, line) => {
						const index = line.indexOf(" ");
						if (index >= 0)
							result[line.slice(0, index)] = line.slice(index + 1);
						return result;
					}, {});
				return {
					directory: fields.worktree ?? "",
					head: fields.HEAD ?? "",
					...(fields.branch ? { branch: fields.branch } : {}),
				};
			});
		return {
			topLevel: git(["rev-parse", "--show-toplevel"]),
			head: git(["rev-parse", "HEAD"]),
			branch: git(["branch", "--show-current"]),
			gitDir: git(["rev-parse", "--path-format=absolute", "--git-dir"]),
			commonGitDir: git([
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]),
			realRoot: await realpath(root),
			realEvidenceRoot: await realpath(`${root}/.opencode`),
			registered,
			ignoredOutput: ignored.exitCode === 0,
			trackedOutput: tracked.exitCode === 0,
			outputExists: await exists(output),
			outputDirectoryExists: await exists(dirname(output)),
		};
	},
	reserve: async (output) => {
		await mkdir(dirname(output), { mode: 0o700 });
		const file = await open(output, "wx", 0o600);
		return {
			write: async (snapshot) => {
				const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
				await file.truncate(0);
				const writeFrom = async (offset: number): Promise<void> => {
					if (offset === bytes.length) return;
					const result = await file.write(
						bytes,
						offset,
						bytes.length - offset,
						offset,
					);
					if (result.bytesWritten <= 0)
						throw new Error("SP-4 evidence write made no progress");
					await writeFrom(offset + result.bytesWritten);
				};
				await writeFrom(0);
			},
			close: () => file.close(),
		};
	},
	fetch: (url, init) => fetch(url, init),
	now: Date.now,
};

/** Observe native state around a scratch switch without inferring provider effort. */
export async function observeSwitch(
	api: SwitchApi,
	sessionID: string,
	body: unknown,
): Promise<Observation> {
	const sent = JSON.stringify(body);
	if (typeof sent !== "string")
		throw new Error("Switch body must serialize to JSON");
	const result: Observation = { sent, switchOutcome: "not-attempted" };
	try {
		result.before = await api.read(sessionID);
	} catch (error) {
		result.beforeError = message(error);
		return result;
	}
	try {
		const payload: unknown = JSON.parse(sent);
		result.response = await api.switch(sessionID, payload);
		result.switchOutcome = "succeeded";
	} catch (error) {
		result.switchOutcome = "error";
		result.error = message(error);
		const status = record(error).status;
		if (typeof status === "number") result.errorStatus = status;
	}
	try {
		result.after = await api.read(sessionID);
	} catch (error) {
		result.readbackError = message(error);
	}
	return result;
}

/** Run an explicitly admitted fixed experiment with real guards and injectable I/O only. */
export async function runNativeSwitchCampaign(
	args: string[],
	env: Record<string, string | undefined>,
	cwd: string,
	io: SwitchIO = nativeIO,
): Promise<SwitchCampaign> {
	const started = io.now();
	const deadline = started + 300_000;
	const argument = (flag: string) =>
		args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
	if (!args.includes("--live") || env.ENSEMBLE_SP4_APPROVED !== "1")
		throw new Error("SP-4 requires explicit live approval");
	const root = normalize(cwd);
	const expectedHead = argument("--expected-head");
	const expectedBranch = argument("--expected-branch");
	if (
		!/^(?:[A-Za-z]:\/|\/)/.test(root) ||
		root.startsWith("//") ||
		root.split("/").some((part) => part === "." || part === "..") ||
		!expectedHead ||
		!/^[a-f0-9]{40}$/i.test(expectedHead) ||
		!expectedBranch?.startsWith("ensemble-") ||
		!expectedBranch.endsWith("-sp4-switchmodel")
	) {
		throw new Error(
			"SP-4 workspace approval must name an isolated branch and full HEAD",
		);
	}
	const relative = argument("--output");
	if (
		!relative ||
		!/^\.opencode\/sp4-[A-Za-z0-9_-]+\/manifest\.json$/.test(relative)
	)
		throw new Error(
			"SP-4 output must be a new ignored .opencode/sp4-*/manifest.json",
		);
	const output = `${root}/${relative}`;
	const endpoint = validateNativeEndpoint(args, {
		ENSEMBLE_SP1_PASSWORD: env.ENSEMBLE_SP4_PASSWORD,
	});
	const facts = await io.workspace(root, output);
	if (
		!samePath(facts.topLevel, root) ||
		!samePath(facts.realRoot, root) ||
		!samePath(facts.realEvidenceRoot, `${root}/.opencode`) ||
		facts.head !== expectedHead ||
		facts.branch !== expectedBranch ||
		samePath(facts.gitDir, facts.commonGitDir) ||
		!facts.registered.some(
			(entry) =>
				samePath(entry.directory, root) &&
				entry.head === expectedHead &&
				entry.branch === `refs/heads/${expectedBranch}`,
		) ||
		!facts.ignoredOutput ||
		facts.trackedOutput ||
		facts.outputExists ||
		facts.outputDirectoryExists
	) {
		throw new Error(
			"SP-4 workspace/output facts do not match the approved isolated worktree",
		);
	}
	const sink = await io.reserve(output);
	const state: SwitchCampaign = {
		started: new Date(started).toISOString(),
		directory: root,
		output,
		owner: "sp4-switchmodel",
		status: "retained-not-prompted",
		cleanup: "cleanup-not-supported",
		sessionIDs: [],
		requests: [],
		observations: [],
		metadata: { head: facts.head, branch: facts.branch },
		createdAttempts: 0,
		switchAttempts: 0,
		finalization: "pending-close",
		restoration: { status: "not-created" },
	};
	const control = { recovering: false, targetVerified: false };
	const checkpoint = async () => {
		try {
			await sink.write(state);
			return true;
		} catch (error) {
			state.evidenceError ??= message(error);
			return false;
		}
	};
	const requireEvidence = () => {
		if (state.evidenceError) throw new Error("SP-4 evidence unavailable");
	};
	const request = async (
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> => {
		const remaining = deadline - io.now() - (control.recovering ? 0 : 15_000);
		if (remaining <= 0)
			throw new Error("SP-4 campaign/recovery time budget exhausted");
		const ownedPath = state.sessionIDs.some(
			(id) => path === `/api/session/${id}`,
		);
		const ownedModel = state.sessionIDs.some(
			(id) => path === `/api/session/${id}/model`,
		);
		const read =
			method === "GET" &&
			(["/api/info", "/openapi.json", "/api/agent", "/api/model"].includes(
				path,
			) ||
				ownedPath);
		const write =
			method === "POST" &&
			(path === "/api/session" || (ownedModel && control.targetVerified));
		if (!read && !write) throw new Error("SP-4 refused an unowned endpoint");
		if (method === "POST" && path === "/api/session") {
			if (
				control.recovering ||
				state.createdAttempts >= 4 ||
				state.sessionIDs.length
			)
				throw new Error("SP-4 creation budget exhausted");
			state.createdAttempts++;
			state.restoration.status = "uncertain";
		}
		if (method === "POST" && ownedModel) {
			if (state.switchAttempts >= 24)
				throw new Error("SP-4 switch budget exhausted");
			state.switchAttempts++;
		}
		const call: SwitchCall = {
			at: new Date(io.now()).toISOString(),
			method,
			path,
			phase: control.recovering ? "recovery" : "campaign",
			...(body === undefined ? {} : { sent: JSON.stringify(body) }),
		};
		state.requests.push(call);
		const url = new URL(`${endpoint.url}${path}`);
		url.searchParams.set("location[directory]", root);
		try {
			const response = await io.fetch(url.toString(), {
				method,
				redirect: "manual",
				signal: AbortSignal.timeout(Math.min(5_000, remaining)),
				headers: {
					"content-type": "application/json",
					...(endpoint.authorization
						? { authorization: endpoint.authorization }
						: {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			call.status = response.status;
			if (response.status >= 300 && response.status < 400)
				call.response = {
					error: "redirect-refused",
					source: "local-transport",
				};
			else
				call.response =
					response.status === 204
						? null
						: parsePermissionHttpResponse(
								response.status,
								await response.text(),
							).body;
			if (response.status < 200 || response.status >= 300)
				throw Object.assign(new Error(`HTTP ${response.status}`), {
					status: response.status,
				});
			return call.response;
		} catch (error) {
			call.error = message(error);
			throw error;
		}
	};
	const runID = randomUUID();
	const title = `SP-4 retained-not-prompted ${runID}`;
	const idOf = () => state.sessionIDs[0];
	const verifySession = (value: unknown) => {
		const data = record(unwrap(value));
		const metadata = record(record(data.metadata)["ensemble.sp4"]);
		const directory = record(data.location).directory;
		if (
			data.id !== idOf() ||
			data.title !== title ||
			typeof directory !== "string" ||
			!samePath(directory, root) ||
			metadata.runID !== runID ||
			metadata.scratch !== true
		) {
			throw new Error("SP-4 scratch ownership/location mismatch");
		}
	};
	const api: SwitchApi = {
		read: async (id) => {
			if (id !== idOf()) throw new Error("SP-4 refused non-owned session");
			const value = await request("GET", `/api/session/${id}`);
			verifySession(value);
			return value;
		},
		switch: async (id, body) => {
			if (id !== idOf() || !control.targetVerified)
				throw new Error("SP-4 refused non-owned model switch");
			return request("POST", `/api/session/${id}/model`, body);
		},
	};
	const sol = { providerID: "openai", id: "gpt-6.1-sol" };
	const low = { model: { ...sol, variant: "low" } };
	const bodies = [
		low,
		{ model: { ...sol, variant: "xhigh" } },
		{ model: sol },
		{ model: { providerID: "opencode-go", id: "gpt-6-luna" } },
		{ model: { ...sol, variant: "SP4-unknown-variant" } },
		{ model: { ...sol, variant: 42 } },
	];
	try {
		if (!(await checkpoint())) throw new Error("SP-4 evidence unavailable");
		const info = await request("GET", "/api/info");
		assertNativeHostIdentity(unwrap(info), endpoint.pid);
		state.metadata.info = info;
		state.metadata.openapi = await request("GET", "/openapi.json");
		state.metadata.profiles = await request("GET", "/api/agent");
		state.metadata.models = await request("GET", "/api/model");
		if (!(await checkpoint())) throw new Error("SP-4 evidence unavailable");
		const created = record(
			unwrap(
				await request("POST", "/api/session", {
					title,
					location: { directory: root },
					metadata: { "ensemble.sp4": { runID, scratch: true } },
				}),
			),
		);
		const id = created.id;
		if (typeof id !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(id))
			throw new Error("SP-4 malformed scratch id");
		state.sessionIDs.push(id);
		await checkpoint();
		await api.read(id);
		control.targetVerified = true;
		requireEvidence();
		await bodies.reduce(async (previous, body, index) => {
			await previous;
			if (state.stop || state.evidenceError) return;
			if (!(await checkpoint())) {
				state.stop = "SP-4 evidence unavailable";
				return;
			}
			const observation = await observeSwitch(api, id, body);
			state.observations.push(observation);
			await checkpoint();
			const expectedRejection =
				index >= 4 &&
				observation.errorStatus !== undefined &&
				observation.errorStatus >= 400 &&
				observation.errorStatus < 500;
			if (
				observation.beforeError ||
				observation.readbackError ||
				(observation.error && !expectedRejection)
			)
				state.stop =
					observation.beforeError ??
					observation.readbackError ??
					observation.error;
		}, Promise.resolve());
	} catch (error) {
		state.stop ??= message(error);
	} finally {
		control.recovering = true;
		const id = idOf();
		if (id) {
			state.restoration.status = "uncertain";
			await checkpoint();
			if (control.targetVerified) {
				try {
					state.restoration.response = await api.switch(id, low);
				} catch (error) {
					state.restoration.error = message(error);
				}
				try {
					state.restoration.readback = await api.read(id);
					const model = record(
						record(unwrap(state.restoration.readback)).model,
					);
					state.restoration.stateVerified =
						model.id === sol.id &&
						model.providerID === sol.providerID &&
						model.variant === "low";
				} catch (error) {
					state.restoration.readbackError = message(error);
				}
			} else
				state.restoration.error = "Scratch ownership could not be verified";
		} else if (state.createdAttempts > 0) {
			state.restoration.status = "uncertain";
			state.restoration.error =
				"Scratch creation outcome unknown; no usable session ID";
		}
		state.finished = new Date(io.now()).toISOString();
		await checkpoint();
		try {
			await sink.close();
			state.finalization = state.evidenceError ? "uncertain" : "closed";
		} catch (error) {
			state.evidenceError ??= message(error);
			state.finalization = "uncertain";
		}
		if (
			state.finalization === "closed" &&
			state.restoration.stateVerified &&
			state.restoration.error === undefined &&
			state.restoration.readbackError === undefined
		)
			state.restoration.status = "verified";
	}
	return state;
}

if (import.meta.main) {
	runNativeSwitchCampaign(Bun.argv.slice(2), process.env, process.cwd())
		.then((result) => {
			console.log(
				JSON.stringify({
					output: result.output,
					sessions: result.sessionIDs,
					stop: result.stop,
					evidenceError: result.evidenceError,
					finalization: result.finalization,
					restoration: result.restoration.status,
					stateVerified: result.restoration.stateVerified,
				}),
			);
			if (
				result.stop ||
				result.evidenceError ||
				result.restoration.status !== "verified"
			)
				process.exitCode = 1;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : "SP-4 stopped");
			process.exitCode = 1;
		});
}
