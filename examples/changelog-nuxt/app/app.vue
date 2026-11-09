<script setup lang="ts">
import display from "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2?url";

const cms = await useCms();
useHead({
  titleTemplate: (title) => (title ? `${title} · ${cms.identity.name}` : cms.identity.name),
  // Every page has a heading in it, and `optional` uses the face only if it arrives in time.
  link: [
    { rel: "preload", href: display, as: "font", type: "font/woff2", crossorigin: "anonymous" },
  ],
});
useSeoMeta({ description: cms.identity.tagline });
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
