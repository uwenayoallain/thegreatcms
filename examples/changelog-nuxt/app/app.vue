<script setup lang="ts">
const cms = await useCms();
useHead({
  titleTemplate: (title) => (title ? `${title} · ${cms.identity.name}` : cms.identity.name),
});
useSeoMeta({ description: cms.identity.tagline });
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
