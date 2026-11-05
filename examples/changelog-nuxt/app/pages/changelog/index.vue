<script setup lang="ts">
const cms = await useCms();
useHead({ title: "Changelog" });
</script>

<template>
  <section class="release changelog" aria-labelledby="changelog-heading">
    <p class="eyebrow">Every release, newest first</p>
    <h1 id="changelog-heading">Changelog</h1>
    <ReleaseList :releases="cms.releases" />
  </section>
</template>
