import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "./config.ts";
import { trackWorking } from "./gateway.ts";
import { excludedToolsFor, roleOf } from "./roles.ts";
import { ChannelSessions, type SessionFactory } from "./sessions.ts";
import { splitMessage } from "./split.ts";

describe("roleOf", () => {
	it("admin ids sao admin, resto (incl. ex-mods) e user", () => {
		const settings = {
			...DEFAULTS,
			discord: { guild_id: "g", channel_ids: [], admin_ids: ["a"] },
		};
		expect(roleOf("a", settings)).toBe("admin");
		expect(roleOf("m", settings)).toBe("user");
		expect(roleOf("x", settings)).toBe("user");
		expect(roleOf("", settings)).toBe("user");
	});
});

describe("excludedToolsFor", () => {
	it("admin ve tudo; user nao encosta em shell nem arquivo", () => {
		expect(excludedToolsFor("admin")).toEqual([]);
		const user = excludedToolsFor("user");
		for (const t of ["bash", "powershell", "edit", "write", "read", "grep", "find", "ls"]) {
			expect(user).toContain(t);
		}
	});
});

describe("splitMessage", () => {
	it("keeps short messages whole", () => {
		expect(splitMessage("oi")).toEqual(["oi"]);
	});

	it("splits on newlines within the limit", () => {
		const text = `${"a".repeat(1990)}\n${"b".repeat(50)}`;
		const chunks = splitMessage(text);
		expect(chunks).toHaveLength(2);
		expect(chunks.every((c) => c.length <= 2000)).toBe(true);
	});

	it("hard-cuts lines longer than the limit", () => {
		const chunks = splitMessage("x".repeat(4500));
		expect(chunks).toHaveLength(3);
		expect(chunks.join("")).toBe("x".repeat(4500));
	});
});

function stubMessage() {
	const reacted: string[] = [];
	const removed: string[] = [];
	return {
		reacted,
		removed,
		react: async (emoji: string) => {
			reacted.push(emoji);
		},
		reactions: {
			cache: new Map([["\u23F1\uFE0F", { users: { remove: async (id: string) => void removed.push(id) } }]]),
		},
		channel: { sendTyping: async () => undefined },
	};
}

describe("trackWorking", () => {
	it("swaps timer for done on success", async () => {
		const msg = stubMessage();
		const result = await trackWorking(msg, "bot", async () => "ok");
		expect(result).toBe("ok");
		expect(msg.reacted).toEqual(["\u23F1\uFE0F", "\u2705"]);
		expect(msg.removed).toEqual(["bot"]);
	});

	it("swaps timer for error on failure", async () => {
		const msg = stubMessage();
		await expect(trackWorking(msg, "bot", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
		expect(msg.reacted).toEqual(["\u23F1\uFE0F", "\u274C"]);
	});

	it("still resolves when reactions throw", async () => {
		const msg = stubMessage();
		msg.react = async () => Promise.reject(new Error("sem permissão"));
		const result = await trackWorking(msg, "bot", async () => "ok");
		expect(result).toBe("ok");
	});
});

function stubFactory(): SessionFactory & { created: { channel: string; role: string }[] } {
	const created: { channel: string; role: string }[] = [];
	return {
		created,
		async create(channel: string, role: "admin" | "user") {
			created.push({ channel, role });
			const prompt = vi.fn(async () => undefined);
			return {
				prompt,
				waitForIdle: async () => undefined,
				getLastAssistantText: () => `answer-for-${channel}`,
				dispose: () => undefined,
			} as unknown as import("@earendil-works/pi-coding-agent").AgentSession;
		},
		dispose: () => undefined,
	};
}

describe("ChannelSessions", () => {
	it("reuses the session per channel and asks through it", async () => {
		const factory = stubFactory();
		const sessions = new ChannelSessions(factory, 60_000);
		const first = await sessions.ask("c1", "user", "oi");
		const second = await sessions.ask("c1", "user", "de novo");
		expect(first).toBe("answer-for-c1");
		expect(second).toBe("answer-for-c1");
		expect(factory.created).toHaveLength(1);
		expect(sessions.size()).toBe(1);
		sessions.dispose();
		expect(sessions.size()).toBe(0);
	});

	it("isolates sessions by role (user never reuses admin tools)", async () => {
		const factory = stubFactory();
		const sessions = new ChannelSessions(factory, 60_000);
		const asUser = await sessions.get("c1", "user");
		const asAdmin = await sessions.get("c1", "admin");
		expect(asUser).not.toBe(asAdmin);
		expect(await sessions.get("c1", "user")).toBe(asUser);
		sessions.dispose();
	});

	it("recreates the session when the role changes", async () => {
		const factory = stubFactory();
		const sessions = new ChannelSessions(factory, 60_000);
		await sessions.ask("c1", "user", "oi");
		await sessions.ask("c1", "admin", "sudo");
		expect(factory.created).toHaveLength(2);
		expect(factory.created[1]).toEqual({ channel: "c1", role: "admin" });
		sessions.dispose();
	});

	it("sweeps idle sessions", async () => {
		const factory = stubFactory();
		const sessions = new ChannelSessions(factory, 5);
		await sessions.ask("c1", "user", "oi");
		await new Promise((r) => setTimeout(r, 10));
		await sessions.ask("c2", "user", "olá");
		expect(factory.created.map((c) => c.channel)).toEqual(["c1", "c2"]);
		sessions.dispose();
	});
});
