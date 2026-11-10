<script>
  import Head from "#lib/Head.svelte";

  let { data } = $props();
  // Before the page is written it still has a name, and says who it will be about.
  const heading = $derived(data.about.heading ?? "About");
</script>

<Head title="{heading} · {data.identity.title}" description={data.identity.tagline} />

<article class="essay">
  <header>
    <p class="meta">{data.identity.author}</p>
    <h1>{heading}</h1>
  </header>
  <div class="prose">
    {#if data.about.body?.html}{@html data.about.body.html}{:else}<p>{data.identity.tagline}</p>{/if}
  </div>
  {#if data.about.elsewhere?.length}
    <ul class="elsewhere">
      {#each data.about.elsewhere as link (link.href)}
        <li><a href={link.href} rel={link.external ? "noopener" : undefined}>{link.label ?? link.href}</a></li>
      {/each}
    </ul>
  {/if}
</article>
