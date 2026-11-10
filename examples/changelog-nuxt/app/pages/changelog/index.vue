<script setup lang="ts">
const cms = await useCms();
useHead({ title: "Changelog" });
useSeoMeta({
  description: `Every release of ${cms.identity.name}, newest first.`,
  ogDescription: `Every release of ${cms.identity.name}, newest first.`,
});
</script>

<template>
  <section class="release changelog" aria-labelledby="changelog-heading">
    <p class="eyebrow">Every release, newest first</p>
    <h1 id="changelog-heading">Changelog</h1>
    <ReleaseList v-if="cms.releases.length" :releases="cms.releases" />
    <p v-else class="lede">The first release notes are being written.</p>
  </section>
</template>
