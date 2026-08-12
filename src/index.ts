import {
  createVallumClient,
  type MountOptions,
  type VallumClient,
  type VallumClientOptions,
} from "@liteeagle226/client";
import {
  computed,
  defineComponent,
  h,
  inject,
  onBeforeUnmount,
  onMounted,
  onScopeDispose,
  provide,
  shallowRef,
  watch,
  type App,
  type ComputedRef,
  type InjectionKey,
  type PropType,
} from "vue";

export type { MountOptions, VallumClient, VallumClientOptions } from "@liteeagle226/client";

/** The lifecycle of the browser-side Vallum session. */
export type VallumStatus = "idle" | "initializing" | "ready" | "error" | "disposed";

/** A protected fetch with the same call shape as `VallumClient.fetch`. */
export type VallumFetch = VallumClient["fetch"];

export interface VallumVueOptions extends VallumClientOptions {
  /** Start initialization when the plugin is installed in a browser. Defaults to `true`. */
  autoInitialize?: boolean;
}

/** Reactive state and operations shared through Vue dependency injection. */
export interface VallumContext {
  /** Readonly, reactive lifecycle state. */
  readonly status: ComputedRef<VallumStatus>;
  /** The active client. The ref remains `null` until initialization succeeds. */
  readonly client: ComputedRef<VallumClient | null>;
  /** The most recent initialization error, cleared by a new attempt or disposal. */
  readonly error: ComputedRef<Error | null>;
  /** Readonly convenience state equivalent to `status.value === "ready"`. */
  readonly isReady: ComputedRef<boolean>;

  /** Initialize once. Concurrent callers share the same attempt. */
  initialize(): Promise<VallumClient>;
  /** Retry initialization, replacing a ready client with a fresh session. */
  retry(): Promise<VallumClient>;
  /** Wait for initialization, then make a protected request. */
  fetch: VallumFetch;
  /** Permanently release this context and its client. Idempotent. */
  dispose(): void;
}

/** A context that can also be passed directly to `app.use()`. */
export interface VallumPlugin extends VallumContext {
  install(app: App): void;
}

export interface ProvideVallumOptions {
  /** Initialize after the owning component mounts. Defaults to `true`. */
  initialize?: boolean;
  /** Dispose when the owning component scope stops. Defaults to `true`. */
  disposeOnUnmount?: boolean;
}

/** The injection key used by the plugin, provider, and composables. */
export const VALLUM_INJECTION_KEY: InjectionKey<VallumContext> = Symbol.for(
  "@liteeagle226/vue/context",
);

/**
 * Create one Vallum context per Vue application (or per provider subtree).
 *
 * Constructing and importing this module is SSR-safe. Browser-only work starts
 * after plugin installation, provider mounting, or an explicit `initialize()`.
 */
export function createVallum(options: VallumVueOptions): VallumPlugin {
  if (!options || typeof options.endpoint !== "string" || options.endpoint.trim() === "") {
    throw new TypeError("@liteeagle226/vue requires a non-empty Vallum endpoint");
  }

  const { autoInitialize = true, ...unfrozenClientOptions } = options;
  const clientOptions: VallumClientOptions = Object.freeze({
    ...unfrozenClientOptions,
    endpoint: options.endpoint.trim(),
  });
  const statusState = shallowRef<VallumStatus>("idle");
  const clientState = shallowRef<VallumClient | null>(null);
  const errorState = shallowRef<Error | null>(null);

  // Computed refs are readonly without recursively proxying the client. A deep
  // readonly proxy would break clients that use JavaScript private fields.
  const status = computed(() => statusState.value);
  const client = computed(() => clientState.value);
  const error = computed(() => errorState.value);
  const isReady = computed(() => statusState.value === "ready");

  let disposed = false;
  let attemptID = 0;
  let initialization: Promise<VallumClient> | undefined;
  let installedApp: App | undefined;

  const initialize = (): Promise<VallumClient> => {
    if (disposed) return Promise.reject(disposedError());

    const activeClient = clientState.value;
    if (activeClient !== null) return Promise.resolve(activeClient);
    if (initialization !== undefined) return initialization;

    if (!isBrowserRuntime()) {
      const failure = new Error(
        "@liteeagle226/vue can initialize only in a browser; install it from a client-only entry point",
      );
      statusState.value = "error";
      errorState.value = failure;
      return Promise.reject(failure);
    }

    const currentAttempt = ++attemptID;
    statusState.value = "initializing";
    errorState.value = null;

    // Starting in a microtask also turns a non-conforming synchronous factory
    // failure into the same observable async error path.
    const pending = Promise.resolve()
      .then(() => createVallumClient(clientOptions))
      .then((createdClient) => {
        if (disposed || currentAttempt !== attemptID) {
          releaseClient(createdClient);
          throw disposedError();
        }

        clientState.value = createdClient;
        statusState.value = "ready";
        return createdClient;
      })
      .catch((failure: unknown) => {
        if (disposed || currentAttempt !== attemptID) throw disposedError();
        const normalizedFailure = normalizeError(failure);
        clientState.value = null;
        errorState.value = normalizedFailure;
        statusState.value = "error";
        throw normalizedFailure;
      })
      .finally(() => {
        // Only one attempt can exist at a time, so the settling attempt owns
        // this slot even when disposal invalidated its attempt id.
        initialization = undefined;
      });

    initialization = pending;
    return pending;
  };

  const retry = (): Promise<VallumClient> => {
    if (disposed) return Promise.reject(disposedError());
    if (initialization !== undefined) return initialization;

    const activeClient = clientState.value;
    clientState.value = null;
    errorState.value = null;
    statusState.value = "idle";
    if (activeClient !== null) releaseClient(activeClient);
    return initialize();
  };

  const protectedFetch: VallumFetch = async (input, init) => {
    const activeClient = await initialize();
    return activeClient.fetch(input, init);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    attemptID += 1;

    const activeClient = clientState.value;
    clientState.value = null;
    errorState.value = null;
    statusState.value = "disposed";
    if (activeClient !== null) releaseClient(activeClient);
  };

  const context: VallumPlugin = {
    status,
    client,
    error,
    isReady,
    initialize,
    retry,
    fetch: protectedFetch,
    dispose,
    install(app: App): void {
      if (installedApp !== undefined && installedApp !== app) {
        throw new Error(
          "A @liteeagle226/vue plugin instance can be installed in only one Vue app; call createVallum() for each app",
        );
      }
      installedApp = app;
      app.provide(VALLUM_INJECTION_KEY, context);
      registerAppDisposal(app, dispose);

      if (autoInitialize && isBrowserRuntime()) {
        // State exposes the error. Consume the rejection so automatic startup
        // cannot create an unhandled promise rejection.
        void initialize().catch(() => undefined);
      }
    },
  };

  return Object.freeze(context);
}

/** Provide an existing context to a component subtree. Call only during setup. */
export function provideVallum(
  vallum: VallumContext,
  options: ProvideVallumOptions = {},
): VallumContext {
  provide(VALLUM_INJECTION_KEY, vallum);

  if (options.initialize !== false) {
    onMounted(() => {
      void vallum.initialize().catch(() => undefined);
    });
  }
  if (options.disposeOnUnmount !== false) {
    onScopeDispose(() => vallum.dispose());
  }

  return vallum;
}

/** Return the nearest Vallum context, or `undefined` when none was provided. */
export function useOptionalVallum(): VallumContext | undefined {
  return inject(VALLUM_INJECTION_KEY);
}

/** Return the nearest Vallum context. Call only during component setup. */
export function useVallum(): VallumContext {
  const vallum = useOptionalVallum();
  if (vallum === undefined) {
    throw new Error(
      "No Vallum context is available. Install createVallum() with app.use() or render VallumProvider.",
    );
  }
  return vallum;
}

/** Return the readonly reactive lifecycle status from the nearest context. */
export function useVallumStatus(): ComputedRef<VallumStatus> {
  return useVallum().status;
}

/** Return the readonly reactive client ref from the nearest context. */
export function useVallumClient(): ComputedRef<VallumClient | null> {
  return useVallum().client;
}

/** Return a stable protected fetch function from the nearest context. */
export function useVallumFetch(): VallumFetch {
  return useVallum().fetch;
}

/**
 * Renderless provider for applications that prefer component-scoped ownership
 * over installing a global plugin.
 */
export const VallumProvider = defineComponent({
  name: "VallumProvider",
  props: {
    vallum: {
      type: Object as PropType<VallumContext>,
      required: true,
    },
    initialize: {
      type: Boolean,
      default: true,
    },
    disposeOnUnmount: {
      type: Boolean,
      default: true,
    },
  },
  setup(props, { slots }) {
    provideVallum(props.vallum, {
      initialize: props.initialize,
      disposeOnUnmount: props.disposeOnUnmount,
    });
    return () => slots.default?.() ?? null;
  },
});

/**
 * Paint a render-only Vallum value into a host element without interpolating
 * it into Vue markup. A render reference is one-shot and should not be reused.
 */
export const VallumRenderOnly = defineComponent({
  name: "VallumRenderOnly",
  inheritAttrs: false,
  props: {
    value: {
      type: null as unknown as PropType<unknown>,
      required: true,
    },
    tag: {
      type: String,
      default: "span",
    },
    height: Number,
    accessibleLabel: String,
  },
  emits: {
    rendered: () => true,
    error: (_failure: Error) => true,
  },
  setup(props, { attrs, emit }) {
    const vallum = useVallum();
    const host = shallowRef<Element | null>(null);
    let revision = 0;
    let hasMountedValue = false;
    let mountedValue: unknown;
    let mountedClient: VallumClient | null = null;
    let hasPendingValue = false;
    let pendingValue: unknown;
    let pendingClient: VallumClient | null = null;
    let pendingMayBeConsumed = false;
    let hasBlockedValue = false;
    let blockedValue: unknown;
    let paintController: AbortController | null = null;
    const currentPresentationOptions = (): MountOptions => {
      const options: MountOptions = {};
      if (props.height !== undefined) options.height = props.height;
      if (props.accessibleLabel !== undefined) options.accessibleLabel = props.accessibleLabel;
      return options;
    };

    const abortPaint = (reason: Error): void => {
      revision += 1;
      paintController?.abort(reason);
      paintController = null;
      hasPendingValue = false;
      pendingValue = undefined;
      pendingClient = null;
      pendingMayBeConsumed = false;
    };

    const clearMountedPixels = (): void => {
      host.value?.replaceChildren();
      hasMountedValue = false;
      mountedValue = undefined;
      mountedClient = null;
    };

    const invalidateClientGeneration = (client: VallumClient | null): void => {
      const mountedBelongsToAnotherClient = hasMountedValue && mountedClient !== client;
      const pendingBelongsToAnotherClient = hasPendingValue && pendingClient !== client;
      if (!mountedBelongsToAnotherClient && !pendingBelongsToAnotherClient) return;

      if (mountedBelongsToAnotherClient) {
        hasBlockedValue = true;
        blockedValue = mountedValue;
      } else if (pendingBelongsToAnotherClient && pendingMayBeConsumed) {
        hasBlockedValue = true;
        blockedValue = pendingValue;
      }
      abortPaint(new Error("Vallum client generation was replaced"));
      clearMountedPixels();
    };

    const schedulePaint = (client: VallumClient, value: unknown): void => {
      const target = host.value;
      if (hasBlockedValue && !Object.is(blockedValue, value)) {
        hasBlockedValue = false;
        blockedValue = undefined;
      }
      if (hasBlockedValue && Object.is(blockedValue, value)) {
        target?.replaceChildren();
        return;
      }
      if (
        target !== null
        && hasMountedValue
        && mountedClient === client
        && Object.is(mountedValue, value)
      ) {
        const renderedNode = target.firstElementChild;
        if (renderedNode) {
          applyCanvasPresentation(renderedNode, currentPresentationOptions());
        }
        return;
      }
      if (
        paintController
        && hasPendingValue
        && pendingClient === client
        && Object.is(pendingValue, value)
      ) return;

      const scheduledRevision = ++revision;
      paintController?.abort(new Error("Vallum render generation was replaced"));
      const controller = new AbortController();
      paintController = controller;
      hasPendingValue = true;
      pendingValue = value;
      pendingClient = client;
      pendingMayBeConsumed = false;
      clearMountedPixels();

      const work = async () => {
          if (scheduledRevision !== revision) return;
          const activeTarget = host.value;
          if (activeTarget === null) return;

          if (!client.isRenderOnly(value)) {
            activeTarget.replaceChildren();
            throw new TypeError("VallumRenderOnly received a value that is not render-only");
          }

          const mountOptions: MountOptions = {};
          if (props.height !== undefined) mountOptions.height = props.height;
          if (props.accessibleLabel !== undefined) {
            mountOptions.accessibleLabel = props.accessibleLabel;
          }
          mountOptions.signal = controller.signal;

          // Paint off-DOM so an obsolete async operation never replaces the
          // active host. Committing moves only the painted canvas into place.
          const staging = activeTarget.ownerDocument.createElement("span");
          pendingMayBeConsumed = true;
          const rendered = await client.mount(staging, value, mountOptions);
          if (
            scheduledRevision !== revision
            || host.value !== activeTarget
            || vallum.client.value !== client
          ) return;
          if (!rendered) {
            throw new Error("VallumRenderOnly could not paint this value; it may already be consumed");
          }
          const renderedNode = staging.firstElementChild;
          if (renderedNode) {
            applyCanvasPresentation(renderedNode, currentPresentationOptions());
          }
          activeTarget.replaceChildren(...Array.from(staging.childNodes));
          hasMountedValue = true;
          mountedValue = value;
          mountedClient = client;
          emit("rendered");
        };
      void work()
        .catch((failure: unknown) => {
          if (scheduledRevision !== revision) return;
          host.value?.replaceChildren();
          emit("error", normalizeError(failure, "Vallum could not paint a render-only value"));
        })
        .finally(() => {
          if (paintController === controller) {
            paintController = null;
            hasPendingValue = false;
            pendingValue = undefined;
            pendingClient = null;
            pendingMayBeConsumed = false;
          }
        });
    };

    const reconcile = (): void => {
      const client = vallum.client.value;
      invalidateClientGeneration(client);
      if (client !== null) {
        schedulePaint(client, props.value);
        return;
      }
      clearMountedPixels();
      if (vallum.status.value === "idle") {
        void vallum.initialize().catch((failure: unknown) => {
          emit("error", normalizeError(failure));
        });
      }
    };

    onMounted(reconcile);
    watch(
      () => [
        props.value,
        props.height,
        props.accessibleLabel,
        vallum.client.value,
        vallum.status.value,
      ] as const,
      reconcile,
      { flush: "sync" },
    );
    onBeforeUnmount(() => {
      abortPaint(new Error("Vallum render component was unmounted"));
      clearMountedPixels();
    });

    return () => {
      // A protected value must never reach DOM text or HTML through fallthrough
      // attributes. All other normal host attributes remain available.
      const safeAttrs: Record<string, unknown> = { ...attrs };
      delete safeAttrs.innerHTML;
      delete safeAttrs.textContent;

      return h(props.tag, {
        ...safeAttrs,
        ref: host,
        "data-vallum-render-only": "",
      });
    };
  },
});

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function disposedError(): Error {
  return new Error("This Vallum context has been disposed and cannot be initialized again");
}

function normalizeError(cause: unknown, message = "Vallum client initialization failed"): Error {
  return cause instanceof Error
    ? cause
    : new Error(message, { cause });
}

function applyCanvasPresentation(node: Element, options: MountOptions): void {
  if (node.getAttribute("data-vallum-render") === null) return;
  const sourceWidth = Number(node.getAttribute("data-vallum-source-width"));
  const sourceHeight = Number(node.getAttribute("data-vallum-source-height"));
  if (sourceWidth > 0 && sourceHeight > 0) {
    const cssHeight = options.height ?? sourceHeight / 2;
    const style = (node as HTMLElement).style;
    style.height = `${cssHeight}px`;
    style.width = `${(sourceWidth / sourceHeight) * cssHeight}px`;
  }
  node.setAttribute("aria-label", options.accessibleLabel ?? "protected value");
}

function releaseClient(client: VallumClient): void {
  // `destroy()` is present in current @liteeagle226/client releases. The optional
  // check also lets the adapter cleanly support an older compatible client.
  const candidate = client as VallumClient & { destroy?: () => void };
  candidate.destroy?.call(client);
}

function registerAppDisposal(app: App, dispose: () => void): void {
  // app.onUnmount is used when present. Vue 3.3/3.4 do not expose it, so the
  // supported fallback wraps this app instance's public unmount operation.
  const appWithUnmountHook = app as App & {
    onUnmount?: (callback: () => void) => void;
  };
  if (typeof appWithUnmountHook.onUnmount === "function") {
    appWithUnmountHook.onUnmount(dispose);
    return;
  }

  const originalUnmount = app.unmount;
  let released = false;
  app.unmount = (): void => {
    try {
      originalUnmount.call(app);
    } finally {
      if (!released) {
        released = true;
        dispose();
      }
    }
  };
}
