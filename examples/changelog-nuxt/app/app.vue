<script setup lang="ts">
import display from "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2?url";

const cms = await useCms();
const route = useRoute();
const site = useRuntimeConfig().public.siteUrl;
const address = computed(() => new URL(route.path.replace(/\/?$/, "/"), site).href);
// A page with no address worth indexing says so on itself, with `robots: noindex`.
const indexed = computed(() => route.meta.noindex !== true && route.path !== "/404");
useHead({
  templateParams: { separator: "·" },
  titleTemplate: (title) => (title ? `${title} · ${cms.identity.name}` : cms.identity.name),
  // Every page has a heading in it, and `optional` uses the face only if it arrives in time.
  link: () => [
    { rel: "preload", href: display, as: "font", type: "font/woff2", crossorigin: "anonymous" },
    ...(indexed.value ? [{ rel: "canonical", href: address.value }] : []),
  ],
});
const description = cms.identity.tagline ?? `${cms.identity.name}: what it does and what changed.`;
useSeoMeta({
  description,
  robots: () => (indexed.value ? undefined : "noindex"),
  ogType: "website",
  ogSiteName: cms.identity.name,
  // `%s` is the page's own title; a page without one keeps the name alone.
  ogTitle: `%s %separator ${cms.identity.name}`,
  ogDescription: description,
  ogUrl: () => address.value,
  ogImage: new URL("/og.png", site).href,
  twitterCard: "summary_large_image",
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
