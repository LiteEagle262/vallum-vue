# `@liteeagle226/vue`

Vue 3 integration for [`@liteeagle226/client`](https://www.npmjs.com/package/@liteeagle226/client). It provides one
per-application Vallum session through an idiomatic Vue plugin, readonly
reactive state, Composition API helpers, component-scoped ownership, and a
safe host component for render-only values.

The package never replaces `window.fetch`. `useVallumFetch()` returns the
protected fetch explicitly, and every call waits for initialization.

## Install

```sh
npm install @liteeagle226/vue @liteeagle226/client vue
```

The adapter installs the core client automatically; it is listed explicitly to
show the runtime pair. Install `@liteeagle226/admission` in the trusted backend
that issues grants.

Vue 3.3 or newer is required. Vallum also requires a secure browser context,
Web Crypto, `fetch`, and an authenticated application session. Configure the
same-origin admission broker described by `@liteeagle226/client` before integrating
the framework adapter.

## Vue application plugin

Create exactly one instance per Vue app:

```ts
// src/main.ts
import { createApp } from "vue";
import { createVallum } from "@liteeagle226/vue";
import App from "./App.vue";

const app = createApp(App);
const vallum = createVallum({
  endpoint: window.location.origin,
});

app.use(vallum);
app.mount("#app");
```

Plugin installation starts initialization in the browser by default. It does
not block `app.mount()`. Protected requests await the same in-flight attempt,
so components do not need to coordinate startup themselves:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useVallum, useVallumFetch, useVallumStatus } from "@liteeagle226/vue";

const vallum = useVallum();
const status = useVallumStatus();
const protectedFetch = useVallumFetch();
const configuration = ref<unknown>();

async function loadConfiguration() {
  const response = await protectedFetch("/api/internal/config");
  configuration.value = await response.json();
}
</script>

<template>
  <p>Vallum: {{ status }}</p>
  <button v-if="status === 'error'" type="button" @click="vallum.retry()">
    Retry secure session
  </button>
  <button :disabled="status === 'initializing'" type="button" @click="loadConfiguration">
    Load configuration
  </button>
</template>
```

The available lifecycle states are `idle`, `initializing`, `ready`, `error`,
and `disposed`. `status`, `client`, `error`, and `isReady` are computed readonly
refs. Concurrent calls to `initialize()`, `retry()`, and `fetch()` share one
initialization attempt. A failed attempt moves to `error`; `retry()` starts a
new attempt and rotates an already-ready client. Once `dispose()` runs, the
context cannot be reused.

`app.unmount()` disposes the plugin-owned client. Disposal is idempotent. If an
initialization finishes after disposal, the newly created client is immediately
destroyed and is never published to Vue state.

To control startup explicitly, pass `autoInitialize: false` and call
`initialize()` after your ordinary application login succeeds. A protected
`fetch()` will also initialize on demand.

## Component-scoped provider

Use `VallumProvider` when a subtree, micro-frontend, or test should own the
session instead of the application plugin:

```vue
<script setup lang="ts">
import { VallumProvider, createVallum } from "@liteeagle226/vue";
import ProtectedArea from "./ProtectedArea.vue";

const vallum = createVallum({
  endpoint: window.location.origin,
});
</script>

<template>
  <VallumProvider :vallum="vallum">
    <ProtectedArea />
  </VallumProvider>
</template>
```

The provider initializes after mount and disposes when its component scope
stops. Set `:initialize="false"` or `:dispose-on-unmount="false"` to transfer
those responsibilities to the caller. `provideVallum()` exposes the same
behavior to render functions and custom provider components.

Do not install the same `createVallum()` result into multiple Vue apps. Create
an independent instance for each app or SSR request.

## Nuxt client-only integration

Vallum is a browser SDK. Put its Nuxt integration in a `.client.ts` plugin so
Nuxt never initializes it while rendering on the server:

```ts
// app/plugins/vallum.client.ts (Nuxt 4)
// plugins/vallum.client.ts (Nuxt 3)
import { createVallum } from "@liteeagle226/vue";

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig();
  const vallum = createVallum({
    endpoint: config.public.vallumEndpoint || window.location.origin,
  });

  nuxtApp.vueApp.use(vallum);
  return {
    provide: { vallum },
  };
});
```

Only public, non-secret configuration belongs in `runtimeConfig.public`. The
admission signing key must stay in the application backend; never place it in
Nuxt runtime config or the browser bundle.

Render components that inject Vallum only on the client:

```vue
<template>
  <ClientOnly>
    <ProtectedAccountPanel />
    <template #fallback>Loading protected session…</template>
  </ClientOnly>
</template>
```

Importing `@liteeagle226/vue` and calling `createVallum()` are SSR-safe. Explicitly
calling `initialize()` or `fetch()` on the server rejects with a clear error
and never constructs the browser client. `useOptionalVallum()` is available
for components that intentionally support both injected and non-injected
render paths.

## Render-only values

Do not interpolate a value for which `client.isRenderOnly(value)` is true.
`VallumRenderOnly` gives the client an empty host element and lets it paint the
one-shot pixel payload directly:

```vue
<script setup lang="ts">
import { VallumRenderOnly } from "@liteeagle226/vue";

defineProps<{ protectedValue: unknown }>();
</script>

<template>
  <VallumRenderOnly
    :value="protectedValue"
    :height="24"
    class="protected-value"
    @error="(error) => console.error(error)"
  />
</template>
```

The component never renders the value as text or HTML, ignores fallthrough
`textContent`/`innerHTML`, and renders nothing for an ordinary value. Each
render-only reference can be painted once; pass a fresh reference when the
prop changes. The component starts a newer paint without waiting for an
obsolete image decode and clears its canvas immediately when the Vallum client
retries, is replaced, or is disposed. Refetch the protected record after such
a lifecycle change; a canvas consumed by the previous client generation is not
reused.

`accessible-label` is an explicit accessibility tradeoff. A label can expose
information to the accessibility tree. Prefer a generic label such as
`"protected account identifier"`, or gate a plaintext label behind a user's
accessibility preference. Canvas rendering also remains observable through
screenshots and OCR; it is not a screen-capture security boundary.

## API

- `createVallum(options)` — plugin and injectable context.
- `useVallum()` / `useOptionalVallum()` — required or optional context.
- `useVallumStatus()` — readonly reactive lifecycle status.
- `useVallumClient()` — readonly reactive active-client ref.
- `useVallumFetch()` — protected fetch that awaits initialization.
- `provideVallum(context, options)` / `VallumProvider` — subtree ownership.
- `VallumRenderOnly` — render-only value host.

## Package checks

```sh
npm run typecheck --workspace @liteeagle226/vue
npm run test --workspace @liteeagle226/vue
npm run build --workspace @liteeagle226/vue
npm pack --dry-run --workspace @liteeagle226/vue
```

Licensed under Apache-2.0.
