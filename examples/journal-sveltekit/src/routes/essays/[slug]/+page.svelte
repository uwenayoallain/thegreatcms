<script>
  import { formatDate } from "#lib/cms.js";

  let { data } = $props();
  const essay = $derived(data.essay);
</script>

<svelte:head>
  <title>{essay.title} · {data.identity.title}</title>
  <meta name="description" content={essay.dek} />
</svelte:head>

<article class="essay">
  <header>
    <p class="meta">
      <time datetime={essay.date}>{formatDate(essay.date)}</time> · {essay.minutes} min read
    </p>
    <h1>{essay.title}</h1>
    {#if essay.dek}<p class="dek">{essay.dek}</p>{/if}
    {#if essay.tags.length}
      <ul class="tags" aria-label="Topics">
        {#each essay.tags as tag (tag)}<li>{tag}</li>{/each}
      </ul>
    {/if}
  </header>
  <div class="prose">{@html essay.html}</div>
</article>

<nav class="pager" aria-label="More essays">
  {#if data.newer}
    <a href="/essays/{data.newer.slug}/"><span>Newer</span>{data.newer.title}</a>
  {/if}
  {#if data.older}
    <a class="older" href="/essays/{data.older.slug}/"><span>Older</span>{data.older.title}</a>
  {/if}
</nav>
