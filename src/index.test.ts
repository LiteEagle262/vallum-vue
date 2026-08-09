import { createVallumClient, type VallumClient } from "@vallum/client";
import {
  createRenderer,
  defineComponent,
  h,
  isReadonly,
  nextTick,
  ref,
  type Renderer,
} from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VallumProvider,
  VallumRenderOnly,
  createVallum,
  useVallum,
  useVallumFetch,
  useVallumStatus,
} from "./index";

vi.mock("@vallum/client", () => ({
  createVallumClient: vi.fn(),
}));

const createClientMock = vi.mocked(createVallumClient);

describe("@vallum/vue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is SSR-safe until initialization is explicitly requested", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);

    const vallum = createVallum({ endpoint: "https://app.example.com" });

    expect(vallum.status.value).toBe("idle");
    expect(createClientMock).not.toHaveBeenCalled();
    await expect(vallum.initialize()).rejects.toThrow("only in a browser");
    expect(vallum.status.value).toBe("error");
    expect(vallum.error.value).toBeInstanceOf(Error);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("shares initialization, exposes readonly state, and protects fetch", async () => {
    const client = makeClient();
    createClientMock.mockResolvedValue(client);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });

    expect(isReadonly(vallum.status)).toBe(true);
    expect(isReadonly(vallum.client)).toBe(true);
    expect(isReadonly(vallum.error)).toBe(true);

    const first = vallum.initialize();
    const second = vallum.initialize();
    const response = vallum.fetch("/api/private");

    expect(first).toBe(second);
    expect(vallum.status.value).toBe("initializing");
    await expect(first).resolves.toBe(client);
    await expect(response).resolves.toBeInstanceOf(Response);

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(client.fetch).toHaveBeenCalledWith("/api/private", undefined);
    expect(vallum.client.value).toBe(client);
    expect(vallum.status.value).toBe("ready");
    expect(vallum.isReady.value).toBe(true);
  });

  it("records an initialization error and retries cleanly", async () => {
    const failure = new Error("admission unavailable");
    const recoveredClient = makeClient();
    createClientMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(recoveredClient);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });

    await expect(vallum.initialize()).rejects.toBe(failure);
    expect(vallum.status.value).toBe("error");
    expect(vallum.error.value).toBe(failure);

    await expect(vallum.retry()).resolves.toBe(recoveredClient);
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(vallum.status.value).toBe("ready");
    expect(vallum.error.value).toBeNull();
  });

  it("uses retry to rotate a ready client", async () => {
    const firstClient = makeClient();
    const secondClient = makeClient();
    createClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });

    await expect(vallum.initialize()).resolves.toBe(firstClient);
    await expect(vallum.retry()).resolves.toBe(secondClient);

    expect(firstClient.destroy).toHaveBeenCalledOnce();
    expect(secondClient.destroy).not.toHaveBeenCalled();
    expect(vallum.client.value).toBe(secondClient);
    expect(vallum.status.value).toBe("ready");
  });

  it("disposes an in-flight client without publishing it", async () => {
    const lateClient = makeClient();
    let resolveClient!: (client: VallumClient) => void;
    createClientMock.mockImplementationOnce(
      () => new Promise<VallumClient>((resolve) => {
        resolveClient = resolve;
      }),
    );
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });

    const pending = vallum.initialize();
    await Promise.resolve();
    vallum.dispose();
    resolveClient(lateClient);

    await expect(pending).rejects.toThrow("disposed");
    expect(lateClient.destroy).toHaveBeenCalledOnce();
    expect(vallum.client.value).toBeNull();
    expect(vallum.error.value).toBeNull();
    expect(vallum.status.value).toBe("disposed");
    await expect(vallum.retry()).rejects.toThrow("disposed");

    vallum.dispose();
    expect(lateClient.destroy).toHaveBeenCalledOnce();
  });

  it("installs injectable composables and disposes with the Vue app", () => {
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    let injected: ReturnType<typeof useVallum> | undefined;
    let injectedFetch: ReturnType<typeof useVallumFetch> | undefined;
    let injectedStatus: ReturnType<typeof useVallumStatus> | undefined;
    const Probe = defineComponent({
      setup() {
        injected = useVallum();
        injectedFetch = useVallumFetch();
        injectedStatus = useVallumStatus();
        return () => null;
      },
    });
    const renderer = makeRenderer();
    const app = renderer.createApp(Probe);

    app.use(vallum);
    app.mount(makeNode("root"));

    expect(injected).toBe(vallum);
    expect(injectedFetch).toBe(vallum.fetch);
    expect(injectedStatus).toBe(vallum.status);

    app.unmount();
    expect(vallum.status.value).toBe("disposed");
  });

  it("disposes through the Vue 3.3/3.4 unmount fallback", () => {
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    const originalUnmount = vi.fn();
    const app = {
      provide: vi.fn(),
      unmount: originalUnmount,
    };

    vallum.install(app as never);
    app.unmount();

    expect(originalUnmount).toHaveBeenCalledOnce();
    expect(vallum.status.value).toBe("disposed");
  });

  it("supports provider-scoped injection and ownership", () => {
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    let injected: ReturnType<typeof useVallum> | undefined;
    const Probe = defineComponent({
      setup() {
        injected = useVallum();
        return () => null;
      },
    });
    const Root = defineComponent({
      setup() {
        return () => h(
          VallumProvider,
          { vallum, initialize: false },
          { default: () => h(Probe) },
        );
      },
    });
    const renderer = makeRenderer();
    const app = renderer.createApp(Root);

    app.mount(makeNode("root"));
    expect(injected).toBe(vallum);

    app.unmount();
    expect(vallum.status.value).toBe("disposed");
  });

  it("paints render-only values without forwarding text or HTML", async () => {
    const protectedValue = { kind: "render-reference" };
    const client = makeClient();
    vi.mocked(client.isRenderOnly).mockImplementation((value) => value === protectedValue);
    createClientMock.mockResolvedValue(client);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    await vallum.initialize();

    const onRendered = vi.fn();
    const Root = defineComponent({
      setup() {
        return () => h(
          VallumProvider,
          { vallum, initialize: false, disposeOnUnmount: false },
          {
            default: () => h(VallumRenderOnly, {
              value: protectedValue,
              tag: "strong",
              height: 24,
              accessibleLabel: "protected identifier",
              textContent: "must-not-render",
              innerHTML: "<b>must-not-render</b>",
              onRendered,
            }),
          },
        );
      },
    });
    const renderer = makeRenderer();
    const root = makeNode("root");
    const app = renderer.createApp(Root);
    app.mount(root);

    await vi.waitFor(() => expect(client.mount).toHaveBeenCalledOnce());
    const [target, value, options] = vi.mocked(client.mount).mock.calls[0]!;
    const host = findNode(root, "strong");
    expect(host).toBeDefined();
    expect(host?.props).not.toHaveProperty("textContent");
    expect(host?.props).not.toHaveProperty("innerHTML");
    expect((target as unknown as TestNode).type).toBe("span");
    expect(value).toBe(protectedValue);
    expect(options).toMatchObject({ height: 24, accessibleLabel: "protected identifier" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(onRendered).toHaveBeenCalledOnce();

    app.unmount();
    vallum.dispose();
  });

  it("renders nothing and reports an ordinary value instead of interpolating it", async () => {
    const client = makeClient();
    vi.mocked(client.isRenderOnly).mockReturnValue(false);
    createClientMock.mockResolvedValue(client);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    await vallum.initialize();
    const onError = vi.fn();
    const Root = defineComponent({
      setup() {
        return () => h(
          VallumProvider,
          { vallum, initialize: false, disposeOnUnmount: false },
          {
            default: () => h(VallumRenderOnly, {
              value: "plaintext-must-not-render",
              onError,
            }),
          },
        );
      },
    });
    const renderer = makeRenderer();
    const root = makeNode("root");
    const app = renderer.createApp(Root);
    app.mount(root);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(client.mount).not.toHaveBeenCalled();
    expect(serializeNode(root)).not.toContain("plaintext-must-not-render");

    app.unmount();
    vallum.dispose();
  });

  it("clears consumed pixels when the client rotates and waits for a fresh reference", async () => {
    const firstValue = { kind: "render-reference", id: 1 };
    const secondValue = { kind: "render-reference", id: 2 };
    const currentValue = ref<unknown>(firstValue);
    const firstClient = makeClient();
    const secondClient = makeClient();
    installCanvasPainter(firstClient, "first");
    installCanvasPainter(secondClient, "second");
    createClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    await vallum.initialize();

    const Root = defineComponent({
      setup() {
        return () => h(
          VallumProvider,
          { vallum, initialize: false, disposeOnUnmount: false },
          { default: () => h(VallumRenderOnly, { value: currentValue.value }) },
        );
      },
    });
    const renderer = makeRenderer();
    const root = makeNode("root");
    const app = renderer.createApp(Root);
    app.mount(root);

    const host = findNode(root, "span");
    await vi.waitFor(() => expect(host?.firstElementChild?.getAttribute("data-paint")).toBe("first"));

    const retry = vallum.retry();
    expect(host?.children).toHaveLength(0);
    await retry;
    await nextTick();
    expect(secondClient.mount).not.toHaveBeenCalled();
    expect(host?.children).toHaveLength(0);

    currentValue.value = secondValue;
    await vi.waitFor(() => expect(secondClient.mount).toHaveBeenCalledOnce());
    expect(host?.firstElementChild?.getAttribute("data-paint")).toBe("second");

    app.unmount();
    vallum.dispose();
  });

  it("lets the newest paint finish without waiting for an obsolete decode", async () => {
    const firstValue = { kind: "render-reference", id: 1 };
    const secondValue = { kind: "render-reference", id: 2 };
    const currentValue = ref<unknown>(firstValue);
    const height = ref(20);
    const firstPaint = deferred<boolean>();
    const client = makeClient();
    vi.mocked(client.mount).mockImplementation((target, value) => {
      const paint = value === firstValue ? "first" : "second";
      if (value === firstValue) {
        return firstPaint.promise.then((mounted) => {
          appendCanvas(target, paint);
          return mounted;
        });
      }
      appendCanvas(target, paint);
      return Promise.resolve(true);
    });
    createClientMock.mockResolvedValue(client);
    const vallum = createVallum({
      endpoint: "https://app.example.com",
      autoInitialize: false,
    });
    await vallum.initialize();

    const Root = defineComponent({
      setup() {
        return () => h(
          VallumProvider,
          { vallum, initialize: false, disposeOnUnmount: false },
          {
            default: () => h(VallumRenderOnly, {
              value: currentValue.value,
              height: height.value,
            }),
          },
        );
      },
    });
    const renderer = makeRenderer();
    const root = makeNode("root");
    const app = renderer.createApp(Root);
    app.mount(root);
    await vi.waitFor(() => expect(client.mount).toHaveBeenCalledOnce());

    currentValue.value = secondValue;
    await vi.waitFor(() => expect(client.mount).toHaveBeenCalledTimes(2));
    const host = findNode(root, "span");
    await vi.waitFor(() => expect(host?.firstElementChild?.getAttribute("data-paint")).toBe("second"));

    height.value = 32;
    await nextTick();
    expect(client.mount).toHaveBeenCalledTimes(2);
    expect(host?.firstElementChild?.style.height).toBe("32px");

    firstPaint.resolve(true);
    await firstPaint.promise;
    await Promise.resolve();
    expect(host?.firstElementChild?.getAttribute("data-paint")).toBe("second");

    app.unmount();
    vallum.dispose();
  });
});

type TestClient = VallumClient & {
  destroy: ReturnType<typeof vi.fn>;
};

function makeClient(): TestClient {
  const destroy = vi.fn();
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    })),
    wrapFetch: vi.fn((implementation: typeof globalThis.fetch) => implementation),
    renew: vi.fn(async () => undefined),
    mount: vi.fn(async () => true),
    isRenderOnly: vi.fn(() => true),
    destroy,
    get destroyed() {
      return destroy.mock.calls.length > 0;
    },
  } as unknown as TestClient;
}

interface TestNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
  readonly childNodes: TestNode[];
  readonly firstElementChild: TestNode | null;
  readonly ownerDocument: { createElement(type: string): TestNode };
  readonly style: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  replaceChildren(...children: TestNode[]): void;
}

function makeNode(type: string, text = ""): TestNode {
  const node: TestNode = {
    type,
    text,
    props: {},
    children: [],
    parent: null,
    style: {},
    get childNodes() {
      return node.children;
    },
    get firstElementChild() {
      return node.children.find((child) => !child.type.startsWith("#")) ?? null;
    },
    ownerDocument: {
      createElement(elementType: string) {
        return makeNode(elementType);
      },
    },
    replaceChildren(...children: TestNode[]) {
      for (const child of node.children) child.parent = null;
      node.children = children;
      for (const child of children) child.parent = node;
    },
    getAttribute(name: string) {
      const value = node.props[name];
      return typeof value === "string" ? value : null;
    },
    setAttribute(name: string, value: string) {
      node.props[name] = value;
    },
  };
  return node;
}

function makeRenderer(): Renderer<TestNode> {
  return createRenderer<TestNode, TestNode>({
    patchProp(element, key, _previous, next) {
      if (next === null || next === undefined) delete element.props[key];
      else element.props[key] = next;
    },
    insert(child, parent, anchor) {
      removeNode(child);
      const index = anchor === null || anchor === undefined
        ? -1
        : parent.children.indexOf(anchor);
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
      child.parent = parent;
    },
    remove: removeNode,
    createElement(type) {
      return makeNode(type);
    },
    createText(text) {
      return makeNode("#text", text);
    },
    createComment(text) {
      return makeNode("#comment", text);
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(element, text) {
      element.replaceChildren(...(text === "" ? [] : [makeNode("#text", text)]));
    },
    parentNode(node) {
      return node.parent;
    },
    nextSibling(node) {
      const parent = node.parent;
      if (parent === null) return null;
      const index = parent.children.indexOf(node);
      return parent.children[index + 1] ?? null;
    },
    setScopeId(element, id) {
      element.props[id] = "";
    },
    cloneNode(node) {
      const clone = makeNode(node.type, node.text);
      clone.props = { ...node.props };
      return clone;
    },
    insertStaticContent(content, parent, anchor) {
      const node = makeNode("#static", content);
      const index = anchor === null ? -1 : parent.children.indexOf(anchor);
      if (index < 0) parent.children.push(node);
      else parent.children.splice(index, 0, node);
      node.parent = parent;
      return [node, node];
    },
  });
}

function removeNode(node: TestNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const index = parent.children.indexOf(node);
  if (index >= 0) parent.children.splice(index, 1);
  node.parent = null;
}

function serializeNode(node: TestNode): string {
  return JSON.stringify({
    type: node.type,
    text: node.text,
    props: node.props,
    children: node.children.map(serializeNode),
  });
}

function findNode(node: TestNode, type: string): TestNode | undefined {
  if (node.type === type) return node;
  for (const child of node.children) {
    const match = findNode(child, type);
    if (match !== undefined) return match;
  }
  return undefined;
}

function installCanvasPainter(client: TestClient, paint: string): void {
  vi.mocked(client.mount).mockImplementation((target) => {
    appendCanvas(target, paint);
    return Promise.resolve(true);
  });
}

function appendCanvas(target: Element, paint: string): void {
  const canvas = makeNode("canvas");
  canvas.setAttribute("data-vallum-render", "");
  canvas.setAttribute("data-vallum-source-width", "200");
  canvas.setAttribute("data-vallum-source-height", "100");
  canvas.setAttribute("data-paint", paint);
  (target as unknown as TestNode).replaceChildren(canvas);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
