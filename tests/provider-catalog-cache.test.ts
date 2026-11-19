import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface FakeModel {
	id: string;
	name?: string;
	provider: string;
	api?: string;
	type?: string;
}

interface FakeStoreEntry {
	models: readonly FakeModel[];
	checkedAt?: number;
	etag?: string;
	lastModified?: number;
}

interface FakePublication {
	persist?: FakeStoreEntry | null;
	update?: () => void;
}

interface FakeRefreshContext {
	stored?: Readonly<FakeStoreEntry>;
	publish(publication: FakePublication): Promise<boolean>;
	allowNetwork: boolean;
	signal: AbortSignal;
}

interface FakeProvider {
	id: string;
	name: string;
	getModels(): readonly FakeModel[];
	getAllModels?: () => readonly FakeModel[];
	refreshModels?: (context: FakeRefreshContext) => Promise<void>;
	stream?: (modelId: string) => string;
}

class FakeModelRuntime {
	registered = new Map<string, FakeProvider>();
	store = new Map<string, FakeStoreEntry>();
	publishLog: FakePublication[] = [];
	failNextPersist: "throw" | "false" | false = false;
	private generations = new Map<string, number>();

	registerNativeProvider(provider: FakeProvider): void {
		this.registered.set(provider.id, provider);
	}

	async refresh(options: { allowNetwork?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		const allowNetwork = options.allowNetwork ?? true;
		const signal = options.signal ?? new AbortController().signal;

		for (const provider of this.registered.values()) {
			if (!provider.refreshModels) continue;
			const generation = (this.generations.get(provider.id) ?? 0) + 1;
			this.generations.set(provider.id, generation);

			const runPhase = async (phaseAllowNetwork: boolean): Promise<void> => {
				const stored = this.store.get(provider.id);
				await provider.refreshModels!({
					stored: stored ? structuredClone(stored) : undefined,
					allowNetwork: phaseAllowNetwork,
					signal,
					publish: async (publication: FakePublication): Promise<boolean> => {
						this.publishLog.push(structuredClone({ persist: publication.persist }));
						if (signal.aborted || this.generations.get(provider.id) !== generation) {
							return false;
						}
						if (publication.persist !== undefined && this.failNextPersist) {
							const mode = this.failNextPersist;
							this.failNextPersist = false;
							if (mode === "throw") throw new Error("disk full");
							return false;
						}
						if (publication.persist === null) {
							this.store.delete(provider.id);
						} else if (publication.persist !== undefined) {
							this.store.set(provider.id, structuredClone(publication.persist));
						}
						if (signal.aborted || this.generations.get(provider.id) !== generation) {
							return false;
						}
						publication.update?.();
						return true;
					},
				});
			};

			await runPhase(false);
			if (allowNetwork && !signal.aborted) {
				await runPhase(true);
			}
		}
	}
}

const VIRTUAL_HOST_URL = "virtual:pi-coding-agent-test";
let activeHostRuntimeCtor: typeof FakeModelRuntime = FakeModelRuntime;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: VIRTUAL_HOST_URL, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === VIRTUAL_HOST_URL) {
			return {
				format: "module",
				shortCircuit: true,
				source: `export const ModelRuntime = globalThis.__nzh10TestModelRuntime;`,
			};
		}
		return nextLoad(url, context);
	},
});

(globalThis as Record<string, unknown>).__nzh10TestModelRuntime = activeHostRuntimeCtor;

const {
	default: providerCatalogCacheExtension,
	installProviderCatalogCache,
	wrapCachedChatProvider,
} = await import("../extensions/provider-catalog-cache.ts");

function makeModels(provider: string, ids: string[]): FakeModel[] {
	return ids.map((id) => ({ id, name: id, provider, api: provider }));
}

function makeAcpLikeProvider(
	fallbackIds: string[],
	discoverIds: () => string[],
	onPublishResult?: (published: boolean) => void,
): FakeProvider {
	let models = makeModels("antigravity-acp", fallbackIds);
	return {
		id: "antigravity-acp",
		name: "Google Antigravity (ACP)",
		getModels: () => models,
		async refreshModels(context: FakeRefreshContext) {
			if (!context.allowNetwork) return;
			const discovered = makeModels("antigravity-acp", discoverIds());
			if (discovered.length === 0) return;
			const ok = await context.publish({
				update: () => {
					models = discovered;
				},
			});
			onPublishResult?.(ok);
		},
		stream(modelId: string) {
			return `stream:${this.id}:${modelId}`;
		},
	};
}

test("offline cold start restores valid persisted chat models and filters invalid entries", async () => {
	class TestRuntime extends FakeModelRuntime {}
	assert.equal(installProviderCatalogCache(TestRuntime), true);

	const runtime = new TestRuntime();
	const cachedIds = Array.from({ length: 11 }, (_, i) => `gemini-model-${i + 1}`);
	runtime.store.set("antigravity-acp", {
		checkedAt: 1000,
		models: [
			...makeModels("antigravity-acp", cachedIds),
			{ id: "wrong-provider", provider: "openai-codex" },
			{ id: "image-model", provider: "antigravity-acp", type: "image" },
			{ id: "   ", provider: "antigravity-acp" },
		],
	});

	const raw = makeAcpLikeProvider(["fallback-1", "fallback-2", "fallback-3", "fallback-4"], () => {
		throw new Error("network should not be called during offline refresh");
	});
	runtime.registerNativeProvider(raw);

	await runtime.refresh({ allowNetwork: false });
	const registered = runtime.registered.get("antigravity-acp")!;
	assert.deepEqual(
		registered.getModels().map((m) => m.id),
		cachedIds,
	);
	assert.equal(registered.stream?.("gemini-model-1"), "stream:antigravity-acp:gemini-model-1");
});

test("network discovery persists catalog for next cold start and isolates follow-up persist failures", async () => {
	class TestRuntime extends FakeModelRuntime {}
	assert.equal(installProviderCatalogCache(TestRuntime, { now: () => 42_000 }), true);

	const runtime1 = new TestRuntime();
	const discoveredIds = Array.from({ length: 11 }, (_, i) => `live-model-${i + 1}`);
	const observedResults: boolean[] = [];

	const raw1 = makeAcpLikeProvider(["fallback-1", "fallback-2"], () => discoveredIds, (ok) =>
		observedResults.push(ok),
	);
	runtime1.registerNativeProvider(raw1);

	await runtime1.refresh({ allowNetwork: false });
	assert.deepEqual(
		runtime1.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["fallback-1", "fallback-2"],
	);

	await runtime1.refresh({ allowNetwork: true });
	assert.deepEqual(observedResults, [true]);
	assert.deepEqual(
		runtime1.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		discoveredIds,
	);
	const saved = runtime1.store.get("antigravity-acp");
	assert.ok(saved);
	assert.equal(saved.checkedAt, 42_000);
	assert.deepEqual(
		saved.models.map((m) => m.id),
		discoveredIds,
	);

	// Fresh process / fresh provider cold start against persisted store immediately hits all 11 models.
	const runtime2 = new TestRuntime();
	runtime2.store.set("antigravity-acp", structuredClone(saved));
	runtime2.registerNativeProvider(makeAcpLikeProvider(["fallback-1"], () => []));
	await runtime2.refresh({ allowNetwork: false });
	assert.deepEqual(
		runtime2.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		discoveredIds,
	);

	// Follow-up persist write error must not alter first publish return value or throw out of refresh.
	const runtime3 = new TestRuntime();
	const failureObserved: boolean[] = [];
	runtime3.failNextPersist = "throw";
	runtime3.registerNativeProvider(
		makeAcpLikeProvider(["fallback-1"], () => ["live-a", "live-b"], (ok) => failureObserved.push(ok)),
	);
	await runtime3.refresh({ allowNetwork: true });
	assert.deepEqual(failureObserved, [true]);
	assert.deepEqual(
		runtime3.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["live-a", "live-b"],
	);
	assert.equal(runtime3.store.get("antigravity-acp"), undefined);
});

test("stands down for native persist, persist:null, offline self-publish, non-allowlisted, and getAllModels providers", async () => {
	class TestRuntime extends FakeModelRuntime {}
	assert.equal(installProviderCatalogCache(TestRuntime), true);

	// 1. Provider with its own persist + etag/lastModified after offline cache overlay.
	const rtPersist = new TestRuntime();
	rtPersist.store.set("antigravity-acp", {
		models: makeModels("antigravity-acp", ["stale-1"]),
		checkedAt: 100,
	});
	let ownModels = makeModels("antigravity-acp", ["fallback-1"]);
	rtPersist.registerNativeProvider({
		id: "antigravity-acp",
		name: "Native Persist Provider",
		getModels: () => ownModels,
		async refreshModels(context) {
			if (!context.allowNetwork) return;
			// Simulate Radius-like two-step publish: first without persist, then with explicit persist.
			await context.publish({
				update: () => {
					ownModels = makeModels("antigravity-acp", ["intermediate-1"]);
				},
			});
			const finalModels = makeModels("antigravity-acp", ["native-1", "native-2"]);
			await context.publish({
				persist: { models: finalModels, etag: '"v2"', lastModified: 999, checkedAt: 2000 },
				update: () => {
					ownModels = finalModels;
				},
			});
		},
	});
	await rtPersist.refresh({ allowNetwork: false });
	assert.deepEqual(
		rtPersist.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["stale-1"],
	);
	await rtPersist.refresh({ allowNetwork: true });
	assert.deepEqual(
		rtPersist.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["native-1", "native-2"],
	);
	assert.equal(rtPersist.store.get("antigravity-acp")?.etag, '"v2"');
	assert.equal(rtPersist.store.get("antigravity-acp")?.lastModified, 999);
	const persistWrites = rtPersist.publishLog.filter((p) => p.persist !== undefined);
	assert.equal(persistWrites.length, 1);

	// 2. Provider that deletes persisted cache with persist: null clears offline overlay too.
	const rtDelete = new TestRuntime();
	rtDelete.store.set("antigravity-acp", {
		models: makeModels("antigravity-acp", ["stale-1"]),
	});
	rtDelete.registerNativeProvider({
		id: "antigravity-acp",
		name: "Delete Cache Provider",
		getModels: () => makeModels("antigravity-acp", ["fallback-only"]),
		async refreshModels(context) {
			if (!context.allowNetwork) return;
			await context.publish({ persist: null });
		},
	});
	await rtDelete.refresh({ allowNetwork: false });
	assert.deepEqual(
		rtDelete.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["stale-1"],
	);
	await rtDelete.refresh({ allowNetwork: true });
	assert.equal(rtDelete.store.get("antigravity-acp"), undefined);
	assert.deepEqual(
		rtDelete.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["fallback-only"],
	);

	// 3. Provider that calls publish in offline phase (even if rejected) prevents middleware intervention.
	const rtOfflineSelf = new TestRuntime();
	rtOfflineSelf.store.set("antigravity-acp", {
		models: makeModels("antigravity-acp", ["disk-cached"]),
	});
	const ac = new AbortController();
	let offlinePublishes = 0;
	rtOfflineSelf.registerNativeProvider({
		id: "antigravity-acp",
		name: "Offline Self Publisher",
		getModels: () => makeModels("antigravity-acp", ["own-offline"]),
		async refreshModels(context) {
			if (!context.allowNetwork) {
				offlinePublishes++;
				ac.abort();
				await context.publish({ update: () => {} });
			}
		},
	});
	await rtOfflineSelf.refresh({ allowNetwork: false, signal: ac.signal });
	assert.equal(offlinePublishes, 1);
	assert.deepEqual(
		rtOfflineSelf.registered.get("antigravity-acp")!.getModels().map((m) => m.id),
		["own-offline"],
	);

	// 4. Non-allowlisted and multimodal (getAllModels) providers pass through untouched.
	const rtSkip = new TestRuntime();
	const otherProvider: FakeProvider = {
		id: "custom-other",
		name: "Other",
		getModels: () => makeModels("custom-other", ["m1"]),
		async refreshModels() {},
	};
	const multiModalProvider: FakeProvider = {
		id: "antigravity-acp",
		name: "Multimodal",
		getModels: () => makeModels("antigravity-acp", ["m1"]),
		getAllModels: () => makeModels("antigravity-acp", ["m1"]),
		async refreshModels() {},
	};
	rtSkip.registerNativeProvider(otherProvider);
	rtSkip.registerNativeProvider(multiModalProvider);
	assert.equal(rtSkip.registered.get("custom-other"), otherProvider);
	assert.equal(rtSkip.registered.get("antigravity-acp"), multiModalProvider);
});

test("reload, subagent inheritance, and same-id provider replacement stay idempotent and state-isolated", async () => {
	// Default extension factory installs once on host ModelRuntime.prototype and ignores repeat calls.
	providerCatalogCacheExtension({} as never);
	const patchedFn = FakeModelRuntime.prototype.registerNativeProvider;
	providerCatalogCacheExtension({} as never);
	assert.equal(FakeModelRuntime.prototype.registerNativeProvider, patchedFn);

	const runtime = new FakeModelRuntime();
	runtime.store.set("antigravity-acp", {
		models: makeModels("antigravity-acp", ["disk-old-1"]),
	});

	const rawSingleton = makeAcpLikeProvider(["fallback-1"], () => ["live-fresh-1", "live-fresh-2"]);
	runtime.registerNativeProvider(rawSingleton);
	const firstWrapped = runtime.registered.get("antigravity-acp")!;
	assert.notEqual(firstWrapped, rawSingleton);

	// Network refresh establishes live catalog and persists it; then simulate stale disk entry.
	await runtime.refresh({ allowNetwork: true });
	runtime.store.set("antigravity-acp", {
		models: makeModels("antigravity-acp", ["disk-stale-after-live"]),
	});

	// /reload re-registers the same raw singleton -> reuses exact same wrapper & keeps hasLive = true.
	runtime.registerNativeProvider(rawSingleton);
	assert.equal(runtime.registered.get("antigravity-acp"), firstWrapped);
	await runtime.refresh({ allowNetwork: false });
	assert.deepEqual(
		firstWrapped.getModels().map((m) => m.id),
		["live-fresh-1", "live-fresh-2"],
	);

	// Subagent inheritance registers the already-wrapped provider -> no double wrap.
	const childRuntime = new FakeModelRuntime();
	childRuntime.registerNativeProvider(firstWrapped);
	assert.equal(childRuntime.registered.get("antigravity-acp"), firstWrapped);

	// Replacing with a brand-new raw provider of the same id creates a fresh wrapper with hasLive = false.
	const replacementRaw = makeAcpLikeProvider(["fallback-2"], () => []);
	runtime.registerNativeProvider(replacementRaw);
	const replacementWrapped = runtime.registered.get("antigravity-acp")!;
	assert.notEqual(replacementWrapped, firstWrapped);
	assert.notEqual(replacementWrapped, replacementRaw);

	await runtime.refresh({ allowNetwork: false });
	assert.deepEqual(
		replacementWrapped.getModels().map((m) => m.id),
		["disk-stale-after-live"],
	);

	// Direct wrapCachedChatProvider skips non-configurable, non-writable method properties safely.
	const frozenProvider = Object.freeze({
		id: "antigravity-acp",
		name: "Frozen",
		getModels: () => [],
		refreshModels: async () => {},
	});
	assert.equal(wrapCachedChatProvider(frozenProvider as never), frozenProvider);
});
