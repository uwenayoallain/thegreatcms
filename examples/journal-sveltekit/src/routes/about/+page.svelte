<script>
  let { data } = $props();
</script>

<svelte:head>
  <title>{data.about.heading} · {data.identity.title}</title>
  <meta name="description" content={data.identity.tagline} />
</svelte:head>

<article class="essay">
  <header>
    <p class="meta">{data.identity.author}</p>
    <h1>{data.about.heading}</h1>
  </header>
  <div class="prose">{@html data.about.body.html}</div>
  {#if data.about.elsewhere?.length}
    <ul class="elsewhere">
      {#each data.about.elsewhere as link (link.href)}
        <li><a href={link.href} rel={link.external ? "noopener" : undefined}>{link.label ?? link.href}</a></li>
      {/each}
    </ul>
  {/if}
</article>
