<script setup lang="ts">
import { formatDate, KINDS } from "~/composables/cms";

const cms = await useCms();
const route = useRoute();
const release = cms.releases.find((entry) => entry.slug === route.params.slug);
if (!release) throw createError({ statusCode: 404, statusMessage: "No such release" });
useHead({ title: `${release.version}: ${release.title}` });
</script>

<template>
  <article v-if="release" class="release">
    <span v-if="release.kind" :class="['kind', release.kind]">{{ KINDS[release.kind] }}</span>
    <h1>{{ release.title }}</h1>
    <p class="when">
      Version {{ release.version }} ·
      <time :datetime="release.date">{{ formatDate(release.date) }}</time>
    </p>
    <!-- A studio edit is stored as sanitized HTML; a file written by hand is trusted like any other source. -->
    <div class="prose" v-html="release.html" />
    <a class="back" href="/changelog/">All releases</a>
  </article>
</template>
