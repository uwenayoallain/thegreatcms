<script setup lang="ts">
const props = defineProps<{ error: { statusCode: number } }>();
const cms = await useCms();
useHead({
  title: `That hour is not on the dial · ${cms.identity.name}`,
});
</script>

<template>
  <NuxtLayout>
    <section class="release" aria-labelledby="error-heading">
      <p class="eyebrow">{{ props.error.statusCode }}</p>
      <h1 id="error-heading">That hour is not on the dial.</h1>
      <p class="lede">
        The page you asked for is not here. The changelog might be what you wanted.
      </p>
      <a class="back" href="/changelog/">See the changelog</a>
    </section>
  </NuxtLayout>
</template>
