<script setup lang="ts">
import { formatDate, KINDS } from "~/composables/cms";

const cms = await useCms();
const route = useRoute();
const release = cms.releases.find((entry) => entry.slug === route.params.slug);
if (!release) throw createError({ statusCode: 404, statusMessage: "No such release" });
// The first paragraph of the notes, as plain text, is what a search result shows.
const summary = (/<p>([\s\S]*?)<\/p>/.exec(release.html)?.[1] ?? release.title)
  .replace(/<[^>]+>/g, "")
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .slice(0, 200);
useHead({
  title: `${release.version}: ${release.title}`,
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: release.title,
        description: summary,
        datePublished: release.date,
        publisher: { "@type": "Organization", name: cms.identity.name },
      }).replaceAll("<", "\\u003c"),
    },
  ],
});
useSeoMeta({ description: summary, ogDescription: summary, ogType: "article" });
</script>

<template>
  <article v-if="release" class="release">
    <p class="meta">
      <span v-if="release.kind" :class="['kind', release.kind]">{{ KINDS[release.kind] }}</span>
      <span class="when">
        Version {{ release.version }} ·
        <time :datetime="release.date">{{ formatDate(release.date) }}</time>
      </span>
    </p>
    <h1 :style="{ 'view-transition-name': `release-${release.slug}` }">{{ release.title }}</h1>
    <!-- A studio edit is stored as sanitized HTML; a file written by hand is trusted like any other source. -->
    <div class="prose" v-html="release.html" />
    <a class="back" href="/changelog/">All releases</a>
  </article>
</template>
