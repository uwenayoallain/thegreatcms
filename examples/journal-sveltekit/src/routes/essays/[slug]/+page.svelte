<script>
  import { formatDate } from "#lib/cms.js";
  import Head from "#lib/Head.svelte";

  let { data } = $props();
  const essay = $derived(data.essay);
</script>

<Head
  title="{essay.title} · {data.identity.title}"
  description={essay.dek || data.identity.tagline}
  type="article"
  schema={{
    "@type": "Article",
    headline: essay.title,
    description: essay.dek || undefined,
    datePublished: essay.date,
    keywords: essay.tags.length ? essay.tags.join(", ") : undefined,
    author: { "@type": "Person", name: data.identity.author },
  }}
/>

<article class="essay">
  <header>
    <p class="meta">
      <time datetime={essay.date}>{formatDate(essay.date)}</time> · {essay.minutes} min read
    </p>
    <h1 style:view-transition-name="essay-{essay.slug}">{essay.title}</h1>
    {#if essay.dek}<p class="dek">{essay.dek}</p>{/if}
    {#if essay.tags.length}
      <ul class="tags" aria-label="Topics">
        {#each essay.tags as tag (tag)}<li>{tag}</li>{/each}
      </ul>
    {/if}
  </header>
  <div class="prose">{@html essay.html}</div>
</article>

{#if data.newer || data.older}
<nav class="pager" aria-label="More essays">
  {#if data.newer}
    <a href="/essays/{data.newer.slug}/"
      ><span class="label">Newer</span> <span class="name" style:view-transition-name="essay-{data.newer.slug}"
        >{data.newer.title}</span
      ></a
    >
  {/if}
  {#if data.older}
    <a class="older" href="/essays/{data.older.slug}/"
      ><span class="label">Older</span> <span class="name" style:view-transition-name="essay-{data.older.slug}"
        >{data.older.title}</span
      ></a
    >
  {/if}
</nav>
{/if}
