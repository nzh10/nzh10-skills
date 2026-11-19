import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	Model,
	ModelsPublication,
	ModelsStoreEntry,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";

const INSTALLED_SYMBOL = Symbol.for("nzh10.provider-catalog-cache.installed");

/**
 * Dynamic chat-only native providers whose upstream `refreshModels()` omits
 * `models-store.json` cache restore and/or `persist` writes.
 */
export const DEFAULT_CACHED_CHAT_PROVIDER_IDS: ReadonlySet<string> = new Set([
	"antigravity-acp",
]);

export interface ProviderCatalogCacheOptions {
	shouldCacheProvider?: (provider: Provider) => boolean;
	now?: () => number;
}

interface RegisterNativeProviderProto {
	registerNativeProvider?: (provider: Provider) => void;
	[INSTALLED_SYMBOL]?: boolean;
}

function isValidCachedChatModel(value: unknown, providerId: string): value is Model<Api> {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		item.id.trim().length > 0 &&
		item.provider === providerId &&
		(item.type === undefined || item.type === "chat")
	);
}

function extractCachedChatModels(
	stored: Readonly<ModelsStoreEntry> | undefined,
	providerId: string,
): Model<Api>[] | undefined {
	if (!stored || !Array.isArray(stored.models) || stored.models.length === 0) {
		return undefined;
	}
	const models: Model<Api>[] = [];
	for (const item of stored.models) {
		if (isValidCachedChatModel(item, providerId)) {
			models.push(item);
		}
	}
	return models.length > 0 ? models : undefined;
}

function canProxyMethod(target: object, prop: PropertyKey): boolean {
	const desc = Object.getOwnPropertyDescriptor(target, prop);
	return !desc || desc.configurable || desc.writable === true;
}

function defaultShouldCacheProvider(provider: Provider): boolean {
	return DEFAULT_CACHED_CHAT_PROVIDER_IDS.has(provider.id);
}

export function wrapCachedChatProvider(
	provider: Provider,
	options: ProviderCatalogCacheOptions = {},
): Provider {
	if (!provider || typeof provider !== "object") return provider;
	const shouldCache = options.shouldCacheProvider ?? defaultShouldCacheProvider;
	if (
		typeof provider.id !== "string" ||
		!shouldCache(provider) ||
		typeof provider.getModels !== "function" ||
		typeof provider.refreshModels !== "function" ||
		provider.getAllModels !== undefined ||
		!canProxyMethod(provider, "getModels") ||
		!canProxyMethod(provider, "refreshModels")
	) {
		return provider;
	}

	const now = options.now ?? Date.now;
	const origGetModels = provider.getModels;
	const origRefreshModels = provider.refreshModels;

	let cachedModels: readonly Model<Api>[] | undefined;
	let hasLive = false;

	const wrappedGetModels = (): readonly Model<Api>[] => cachedModels ?? origGetModels.call(provider);

	const wrappedRefreshModels = async (context: RefreshModelsContext): Promise<void> => {
		const origPublish = context.publish;

		if (!context.allowNetwork) {
			let origCalledPublish = false;
			const offlinePublish: RefreshModelsContext["publish"] = (publication: ModelsPublication) => {
				origCalledPublish = true;
				const needsClearOverlay = publication.update !== undefined || publication.persist === null;
				return origPublish(
					needsClearOverlay
						? {
								...publication,
								update: () => {
									publication.update?.();
									cachedModels = undefined;
								},
							}
						: publication,
				);
			};

			await origRefreshModels.call(provider, { ...context, publish: offlinePublish });
			if (origCalledPublish || hasLive || context.signal.aborted) return;

			const restored = extractCachedChatModels(context.stored, provider.id);
			if (!restored) return;

			await origPublish({
				update: () => {
					if (!hasLive) {
						cachedModels = restored.slice();
					}
				},
			});
			return;
		}

		let sawExplicitPersist = false;
		let pendingPersistModels: Model<Api>[] | undefined;

		const networkPublish: RefreshModelsContext["publish"] = async (publication: ModelsPublication) => {
			if (publication.persist !== undefined) {
				sawExplicitPersist = true;
				pendingPersistModels = undefined;

				if (publication.persist === null) {
					return origPublish({
						...publication,
						update: () => {
							publication.update?.();
							cachedModels = undefined;
						},
					});
				}

				if (publication.update === undefined) {
					return origPublish(publication);
				}

				return origPublish({
					...publication,
					update: () => {
						publication.update!();
						cachedModels = undefined;
						hasLive = true;
					},
				});
			}

			if (publication.update === undefined) {
				return origPublish(publication);
			}

			let capturedSnapshot: Model<Api>[] | undefined;
			const published = await origPublish({
				...publication,
				update: () => {
					publication.update!();
					capturedSnapshot = origGetModels.call(provider).slice();
					cachedModels = undefined;
					hasLive = true;
				},
			});

			if (published && !sawExplicitPersist) {
				pendingPersistModels =
					capturedSnapshot && capturedSnapshot.length > 0 ? capturedSnapshot : undefined;
			}
			return published;
		};

		await origRefreshModels.call(provider, { ...context, publish: networkPublish });

		if (
			!sawExplicitPersist &&
			pendingPersistModels &&
			pendingPersistModels.length > 0 &&
			!context.signal.aborted
		) {
			try {
				await origPublish({
					persist: {
						models: pendingPersistModels,
						checkedAt: now(),
					},
				});
			} catch {
				// Memory catalog is already live; transient store write errors must not fail refresh.
			}
		}
	};

	return new Proxy(provider, {
		get(target, prop) {
			if (prop === "getModels") return wrappedGetModels;
			if (prop === "refreshModels") return wrappedRefreshModels;
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			const desc = Object.getOwnPropertyDescriptor(target, prop);
			if (desc && !desc.configurable && !desc.writable) return value;
			return value.bind(target);
		},
	});
}

export function installProviderCatalogCache(
	runtimeTarget: { prototype?: RegisterNativeProviderProto } | RegisterNativeProviderProto | undefined,
	options: ProviderCatalogCacheOptions = {},
): boolean {
	const proto =
		runtimeTarget && "prototype" in runtimeTarget && runtimeTarget.prototype
			? runtimeTarget.prototype
			: (runtimeTarget as RegisterNativeProviderProto | undefined);

	if (!proto || typeof proto.registerNativeProvider !== "function") {
		return false;
	}
	if (proto[INSTALLED_SYMBOL]) {
		return false;
	}

	const origRegisterNativeProvider = proto.registerNativeProvider;
	const wrapperByRaw = new WeakMap<object, Provider>();
	const wrappedProviders = new WeakSet<object>();

	proto.registerNativeProvider = function registerNativeProviderWithCatalogCache(
		this: unknown,
		provider: Provider,
	): void {
		let targetProvider = provider;
		if (provider && typeof provider === "object" && !wrappedProviders.has(provider)) {
			const existing = wrapperByRaw.get(provider);
			if (existing) {
				targetProvider = existing;
			} else {
				const wrapped = wrapCachedChatProvider(provider, options);
				if (wrapped !== provider) {
					wrapperByRaw.set(provider, wrapped);
					wrappedProviders.add(wrapped);
					targetProvider = wrapped;
				}
			}
		}
		return origRegisterNativeProvider.call(this, targetProvider);
	};

	Object.defineProperty(proto, INSTALLED_SYMBOL, {
		value: true,
		configurable: true,
	});
	return true;
}

export default function providerCatalogCacheExtension(_pi: ExtensionAPI): void {
	installProviderCatalogCache(ModelRuntime as unknown as { prototype?: RegisterNativeProviderProto });
}
