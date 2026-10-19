import { expect, test } from "bun:test";
import {
	observeSwitch,
	runNativeSwitchCampaign,
	type SwitchApi,
	type SwitchCampaign,
	type SwitchIO,
	type SwitchWorkspaceFacts,
} from "../eval/native-switch-model";

test("records explicit native variant and reads before and after", async () => {
	const calls: string[] = [];
	const api: SwitchApi = {
		read: async () => {
			calls.push("read");
			return { model: { variant: "xhigh" } };
		},
		switch: async (_id, body) => {
			calls.push(JSON.stringify(body));
			return {};
		},
	};
	const result = await observeSwitch(api, "ses_scratch", {
		model: { providerID: "openai", id: "gpt-6.1-sol", variant: "low" },
	});
	expect(calls).toEqual([
		"read",
		'{"model":{"providerID":"openai","id":"gpt-6.1-sol","variant":"low"}}',
		"read",
	]);
	expect(result.after).toEqual({ model: { variant: "xhigh" } });
});

test("omission is absent on the wire, not null or a guessed default", async () => {
	const api: SwitchApi = { read: async () => ({}), switch: async () => ({}) };
	const result = await observeSwitch(api, "ses_scratch", {
		model: { providerID: "opencode-go", id: "gpt-6-luna" },
	});
	expect(JSON.parse(result.sent)).toEqual({
		model: { providerID: "opencode-go", id: "gpt-6-luna" },
	});
	expect(result.sent).not.toContain("variant");
	expect(result.after).toEqual({});
});

test("a rejected switch still reads state and records error", async () => {
	const calls: string[] = [];
	const api: SwitchApi = {
		read: async () => {
			calls.push("read");
			return {};
		},
		switch: async () => {
			throw new Error("HTTP 400");
		},
	};
	const result = await observeSwitch(api, "ses_scratch", {
		model: { providerID: "openai", id: "gpt-6.1-sol", variant: "unknown" },
	});
	expect(calls).toEqual(["read", "read"]);
	expect(result.error).toBe("HTTP 400");
});

test("unknown variant accepted by server is not invented into a rejection", async () => {
	const api: SwitchApi = {
		read: async () => ({ model: { variant: "unknown" } }),
		switch: async () => ({ accepted: true }),
	};
	const result = await observeSwitch(api, "ses_scratch", {
		model: { providerID: "openai", id: "gpt-6.1-sol", variant: "unknown" },
	});
	expect(result.error).toBeUndefined();
	expect(result.response).toEqual({ accepted: true });
});

test("a failed post-switch read preserves the successful POST without a hidden retry", async () => {
	const state = { reads: 0, switches: 0 };
	const api: SwitchApi = {
		read: async () => {
			state.reads++;
			if (state.reads > 1) throw new Error("readback failed");
			return { model: { variant: "low" } };
		},
		switch: async () => {
			state.switches++;
			return { accepted: true };
		},
	};
	const result = await observeSwitch(api, "ses_owned", {
		model: { variant: "xhigh" },
	});
	expect(result.response).toEqual({ accepted: true });
	expect(result.error).toBeUndefined();
	expect(result.readbackError).toBe("readback failed");
	expect(state).toEqual({ reads: 2, switches: 1 });
});

test("switch and readback failures remain distinct with one post-switch GET", async () => {
	const state = { reads: 0 };
	const api: SwitchApi = {
		read: async () => {
			if (++state.reads > 1) throw new Error("GET failed");
			return {};
		},
		switch: async () => {
			throw new Error("HTTP 400");
		},
	};
	const result = await observeSwitch(api, "ses_owned", {});
	expect(result.error).toBe("HTTP 400");
	expect(result.readbackError).toBe("GET failed");
	expect(state.reads).toBe(2);
});

test("a failed before-read prevents the scenario POST", async () => {
	const state = { switches: 0 };
	const result = await observeSwitch(
		{
			read: async () => {
				throw new Error("before failed");
			},
			switch: async () => {
				state.switches++;
				return {};
			},
		},
		"ses_owned",
		{},
	);
	expect(result.beforeError).toBe("before failed");
	expect(result.switchOutcome).toBe("not-attempted");
	expect(state.switches).toBe(0);
});

const root = "C:/worktree/ensemble-test-sp4-switchmodel";
const head = "a".repeat(40);
const branch = "ensemble-test-sp4-switchmodel";
const args = [
	"--live",
	"--expected-head",
	head,
	"--expected-branch",
	branch,
	"--output",
	".opencode/sp4-test/manifest.json",
	"--service-url",
	"http://127.0.0.1:41037",
	"--service-pid",
	"42",
];
const env = { ENSEMBLE_SP4_APPROVED: "1", ENSEMBLE_SP4_PASSWORD: "fake-only" };
const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

function fixture(
	options: {
		facts?: Partial<SwitchWorkspaceFacts>;
		version?: string;
		pid?: number;
		redirect?: number;
		collision?: boolean;
		creationReply?: "lost" | "missing-id" | "invalid-id";
		readDirectory?: string;
		failClose?: boolean;
		failEvidence?: (snapshot: SwitchCampaign) => boolean;
		evidenceErrorText?: string;
		failReadAfterFirst?: boolean;
		failRecoveryPost?: boolean;
		failRecoveryRead?: boolean;
		recoveryVariant?: string;
		expireOnUnknown?: boolean;
	} = {},
) {
	const state = {
		clock: Date.now(),
		reserves: 0,
		closes: 0,
		readFailureUsed: false,
		created: {} as Record<string, unknown>,
		model: undefined as Record<string, unknown> | undefined,
		calls: [] as Array<{
			path: string;
			method: string;
			at: number;
			init: RequestInit;
		}>,
		switches: [] as Array<Record<string, unknown>>,
		snapshots: [] as SwitchCampaign[],
	};
	const facts: SwitchWorkspaceFacts = {
		topLevel: root,
		realRoot: root,
		realEvidenceRoot: `${root}/.opencode`,
		head,
		branch,
		gitDir: "C:/repo/.git/worktrees/test",
		commonGitDir: "C:/repo/.git",
		registered: [{ directory: root, head, branch: `refs/heads/${branch}` }],
		ignoredOutput: true,
		trackedOutput: false,
		outputExists: false,
		outputDirectoryExists: false,
		...options.facts,
	};
	const session = (variant?: string) => ({
		data: {
			id: "ses_owned",
			title: state.created.title,
			metadata: state.created.metadata,
			location: { directory: options.readDirectory ?? root },
			...(state.model
				? { model: { ...state.model, ...(variant ? { variant } : {}) } }
				: {}),
		},
	});
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status });
	const io: SwitchIO = {
		workspace: async () => facts,
		reserve: async () => {
			state.reserves++;
			if (options.collision) throw new Error("output collision");
			return {
				write: async (snapshot) => {
					if (options.failEvidence?.(snapshot))
						throw new Error(
							options.evidenceErrorText ?? "evidence unavailable",
						);
					state.snapshots.push(structuredClone(snapshot));
				},
				close: async () => {
					state.closes++;
					if (options.failClose) throw new Error("evidence close failed");
				},
			};
		},
		now: () => state.clock,
		fetch: async (url, init) => {
			const path = new URL(url).pathname;
			const method = init.method ?? "GET";
			state.calls.push({ path, method, at: state.clock, init });
			if (options.redirect)
				return new Response("redirect", {
					status: options.redirect,
					headers: { location: "https://unapproved.invalid" },
				});
			if (path === "/api/info")
				return json({
					version: options.version ?? "2.0.32",
					pid: options.pid ?? 42,
				});
			if (path === "/openapi.json") return json({ paths: {} });
			if (path === "/api/agent") return json({ data: [] });
			if (path === "/api/model")
				return json({
					data: [
						{
							providerID: "openai",
							id: "gpt-6.1-sol",
							enabled: true,
							variants: [{ id: "low" }, { id: "xhigh" }],
						},
						{
							providerID: "opencode-go",
							id: "gpt-6-luna",
							enabled: true,
							variants: [{ id: "none" }],
						},
					],
				});
			if (path === "/api/session" && method === "POST") {
				state.created = object(JSON.parse(String(init.body)));
				if (options.creationReply === "lost")
					throw new Error("creation response lost");
				if (options.creationReply === "missing-id") return json({ data: {} });
				if (options.creationReply === "invalid-id")
					return json({ data: { id: 42 } });
				return json(session());
			}
			if (path === "/api/session/ses_owned" && method === "GET") {
				if (
					options.failReadAfterFirst &&
					state.switches.length === 1 &&
					!state.readFailureUsed
				) {
					state.readFailureUsed = true;
					throw new Error("after-read failed");
				}
				const recovering =
					state.switches.length > 1 && state.switches.at(-1)?.variant === "low";
				if (recovering && options.failRecoveryRead)
					throw new Error("recovery GET failed");
				return json(session(recovering ? options.recoveryVariant : undefined));
			}
			if (path === "/api/session/ses_owned/model" && method === "POST") {
				const model = object(object(JSON.parse(String(init.body))).model);
				const recovering = model.variant === "low" && state.switches.length > 0;
				state.switches.push(model);
				if (recovering && options.failRecoveryPost)
					return json({ error: "unavailable" }, 503);
				if (typeof model.variant === "number")
					return json({ error: "invalid variant" }, 400);
				state.model = {
					providerID: model.providerID,
					id: model.id,
					variant: model.variant ?? "default",
				};
				if (options.expireOnUnknown && model.variant === "SP4-unknown-variant")
					state.clock += 300_001;
				return new Response(null, { status: 204 });
			}
			throw new Error(`unexpected fake HTTP ${method} ${path}`);
		},
	};
	return { io, state };
}

test("the exported runner enforces explicit approval before any I/O mutation", async () => {
	const fake = fixture();
	await expect(
		runNativeSwitchCampaign(args, {}, root, fake.io),
	).rejects.toThrow("approval");
	expect(fake.state.reserves).toBe(0);
	expect(fake.state.calls).toHaveLength(0);
});

test("the runner validates actual workspace/output facts instead of an injected preflight verdict", async () => {
	const invalid: Partial<SwitchWorkspaceFacts>[] = [
		{ topLevel: "C:/canonical" },
		{ realRoot: "C:/elsewhere" },
		{ branch: "main" },
		{ head: "b".repeat(40) },
		{ gitDir: "C:/repo/.git" },
		{ registered: [] },
		{ realEvidenceRoot: "C:/outside" },
		{ ignoredOutput: false },
		{ trackedOutput: true },
		{ outputExists: true },
		{ outputDirectoryExists: true },
	];
	await Promise.all(
		invalid.map(async (facts) => {
			const fake = fixture({ facts });
			await expect(
				runNativeSwitchCampaign(args, env, root, fake.io),
			).rejects.toThrow("workspace");
			expect(fake.state.calls).toHaveLength(0);
			expect(fake.state.reserves).toBe(0);
		}),
	);
});

test("unsafe output and exclusive-creation collisions stop before HTTP", async () => {
	const fake = fixture();
	const unsafe = args.map((arg) =>
		arg === ".opencode/sp4-test/manifest.json" ? "../README.md" : arg,
	);
	await expect(
		runNativeSwitchCampaign(unsafe, env, root, fake.io),
	).rejects.toThrow("output");
	expect(fake.state.calls).toHaveLength(0);
	const collision = fixture({ collision: true });
	await expect(
		runNativeSwitchCampaign(args, env, root, collision.io),
	).rejects.toThrow("collision");
	expect(collision.state.calls).toHaveLength(0);
});

test("wrong host PID/version and redirects cannot create a session or start a fallback", async () => {
	await Promise.all(
		[
			{ version: "2.0.33" },
			{ pid: 99 },
			{ redirect: 307 },
			{ redirect: 308 },
		].map(async (options) => {
			const fake = fixture(options);
			const result = await runNativeSwitchCampaign(args, env, root, fake.io);
			expect(result.stop).toBeDefined();
			expect(result.sessionIDs).toHaveLength(0);
			expect(fake.state.calls.some((call) => call.method === "POST")).toBe(
				false,
			);
			expect(
				fake.state.calls.every((call) => call.init.redirect === "manual"),
			).toBe(true);
		}),
	);
});

test("a fixed no-prompt campaign reaches the scratch API and verifies finally recovery", async () => {
	const fake = fixture();
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(result.stop).toBeUndefined();
	expect(result.sessionIDs).toEqual(["ses_owned"]);
	expect(result.observations).toHaveLength(6);
	expect(fake.state.switches).toHaveLength(7);
	expect(
		fake.state.switches.some((body) => body.variant === "SP4-unknown-variant"),
	).toBe(true);
	expect(fake.state.switches.some((body) => body.variant === 42)).toBe(true);
	expect(result.restoration.status).toBe("verified");
	expect(fake.state.model?.variant).toBe("low");
	expect(JSON.stringify(fake.state.snapshots)).not.toContain("fake-only");
	expect(
		fake.state.calls.every((call) => call.init.redirect === "manual"),
	).toBe(true);
	expect(fake.state.closes).toBe(1);
});

test("proof failure after creation or unknown-state switch cannot skip bounded recovery", async () => {
	await Promise.all(
		[false, true].map(async (afterUnknown) => {
			const fake = fixture({
				failEvidence: (snapshot) =>
					afterUnknown
						? snapshot.observations.some((observation) =>
								observation.sent.includes("SP4-unknown-variant"),
							)
						: snapshot.sessionIDs.length > 0,
			});
			const result = await runNativeSwitchCampaign(args, env, root, fake.io);
			expect(result.evidenceError).toBeDefined();
			expect(result.sessionIDs).toEqual(["ses_owned"]);
			expect(fake.state.switches.at(-1)?.variant).toBe("low");
			expect(fake.state.model?.variant).toBe("low");
			expect(result.restoration.status).toBe("uncertain");
			expect(
				fake.state.calls
					.filter(
						(call) => call.method === "POST" && call.path.endsWith("/model"),
					)
					.every((call) => call.path === "/api/session/ses_owned/model"),
			).toBe(true);
		}),
	);
});

test("failed recovery POST or absent/different recovery readback remains uncertain", async () => {
	await Promise.all(
		[
			{ failRecoveryPost: true },
			{ failRecoveryRead: true },
			{ recoveryVariant: "default" },
		].map(async (options) => {
			const fake = fixture(options);
			const result = await runNativeSwitchCampaign(args, env, root, fake.io);
			expect(result.restoration.status).toBe("uncertain");
			expect(result.sessionIDs).toEqual(["ses_owned"]);
			expect(fake.state.switches).toHaveLength(7);
			expect(
				result.requests.filter((call) => call.phase === "recovery"),
			).toHaveLength(2);
		}),
	);
});

test("a final-proof failure cannot produce a verified outcome", async () => {
	const fake = fixture({
		failEvidence: (snapshot) => snapshot.finished !== undefined,
	});
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(result.evidenceError).toBeDefined();
	expect(result.restoration.status).toBe("uncertain");
	expect(fake.state.model?.variant).toBe("low");
});

test("an expired budget never sends a late recovery POST or claims restoration", async () => {
	const fake = fixture({ expireOnUnknown: true });
	const started = fake.state.clock;
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(result.restoration.status).toBe("uncertain");
	expect(
		fake.state.calls
			.filter((call) => call.method === "POST")
			.every((call) => call.at <= started + 300_000),
	).toBe(true);
	expect(fake.state.model?.variant).toBe("SP4-unknown-variant");
});

test("a failed recovery POST is uncertain even when the prior state was already low", async () => {
	const fake = fixture({ failReadAfterFirst: true, failRecoveryPost: true });
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(fake.state.model?.variant).toBe("low");
	expect(result.restoration.error).toBe("HTTP 503");
	expect(result.restoration.stateVerified).toBe(true);
	expect(result.restoration.status).toBe("uncertain");
});

test("an empty-message evidence exception still blocks success and keeps recovery explicit", async () => {
	const fake = fixture({
		failEvidence: (snapshot) => snapshot.sessionIDs.length > 0,
		evidenceErrorText: "",
	});
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(result.evidenceError).toBeDefined();
	expect(fake.state.model?.variant).toBe("low");
	expect(result.restoration.status).toBe("uncertain");
});

test("a dispatched creation with lost or unusable response has an unknown outcome without retry", async () => {
	await Promise.all(
		(["lost", "missing-id", "invalid-id"] as const).map(
			async (creationReply) => {
				const fake = fixture({ creationReply });
				const result = await runNativeSwitchCampaign(args, env, root, fake.io);
				expect(fake.state.created.title).toBeString();
				expect(result.createdAttempts).toBe(1);
				expect(result.sessionIDs).toHaveLength(0);
				expect(result.restoration.status).toBe("uncertain");
				expect(result.restoration.error).toContain("creation outcome unknown");
				expect(
					fake.state.calls.filter((call) => call.method === "POST"),
				).toHaveLength(1);
				expect(fake.state.switches).toHaveLength(0);
			},
		),
	);
});

test("scratch ownership uses the admitted Windows path equality without allowing a different root", async () => {
	const valid = fixture({
		readDirectory: root.toLowerCase().replaceAll("/", "\\"),
	});
	const result = await runNativeSwitchCampaign(args, env, root, valid.io);
	expect(result.stop).toBeUndefined();
	expect(result.restoration.status).toBe("verified");
	expect(valid.state.switches).toHaveLength(7);
	const outside = fixture({ readDirectory: `${root}-outside` });
	const refused = await runNativeSwitchCampaign(args, env, root, outside.io);
	expect(refused.stop).toContain("ownership/location");
	expect(refused.restoration.status).toBe("uncertain");
	expect(outside.state.switches).toHaveLength(0);
});

test("failed evidence close cannot leave a standalone checkpoint claiming verified completion", async () => {
	const fake = fixture({ failClose: true });
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(result.evidenceError).toBe("evidence close failed");
	expect(result.finalization).toBe("uncertain");
	expect(result.restoration.status).toBe("uncertain");
	expect(result.restoration.stateVerified).toBe(true);
	expect(fake.state.snapshots.at(-1)?.restoration.status).toBe("uncertain");
	expect(fake.state.snapshots.at(-1)?.finalization).toBe("pending-close");
	expect(fake.state.closes).toBe(1);
});

test("only the post-close return attests completion; saved checkpoints stay explicitly nonterminal", async () => {
	const fake = fixture();
	const result = await runNativeSwitchCampaign(args, env, root, fake.io);
	expect(result.finalization).toBe("closed");
	expect(result.restoration.status).toBe("verified");
	expect(fake.state.snapshots.at(-1)?.restoration.status).toBe("uncertain");
	expect(fake.state.snapshots.at(-1)?.restoration.stateVerified).toBe(true);
	expect(fake.state.snapshots.at(-1)?.finalization).toBe("pending-close");
});

test("every checkpoint after a creation attempt marks its outcome uncertain, not not-created", async () => {
	await Promise.all(
		([undefined, "lost", "missing-id"] as const).map(async (creationReply) => {
			const fake = fixture({ creationReply });
			await runNativeSwitchCampaign(args, env, root, fake.io);
			const beforeDispatch = fake.state.snapshots.filter(
				(snapshot) => snapshot.createdAttempts === 0,
			);
			const afterDispatch = fake.state.snapshots.filter(
				(snapshot) => snapshot.createdAttempts > 0,
			);
			expect(beforeDispatch.length).toBeGreaterThan(0);
			expect(
				beforeDispatch.every(
					(snapshot) => snapshot.restoration.status === "not-created",
				),
			).toBe(true);
			expect(afterDispatch.length).toBeGreaterThan(0);
			expect(
				afterDispatch.every(
					(snapshot) => snapshot.restoration.status === "uncertain",
				),
			).toBe(true);
			expect(
				afterDispatch.every(
					(snapshot) => snapshot.finalization === "pending-close",
				),
			).toBe(true);
		}),
	);
});
