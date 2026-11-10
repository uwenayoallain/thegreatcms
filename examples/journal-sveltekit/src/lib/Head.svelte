<!-- What a search engine and a share card read: one place, so no page forgets a tag. -->
<script>
  import { page } from "$app/state";

  let { title, description, type = "website", noindex = false, schema = undefined } = $props();
  const canonical = $derived(page.url.href);
  const image = $derived(new URL("/og.png", page.url).href);
  // Structured data is data: the browser never runs it. "<" is escaped so no text can close the element.
  const data = $derived(
    schema
      ? JSON.stringify({ "@context": "https://schema.org", ...schema }).replaceAll("<", "\\u003c")
      : "",
  );
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description} />
  {#if noindex}
    <meta name="robots" content="noindex" />
  {:else}
    <link rel="canonical" href={canonical} />
  {/if}
  <meta property="og:type" content={type} />
  <meta property="og:site_name" content={page.data.identity.title} />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:url" content={canonical} />
  <meta property="og:image" content={image} />
  <meta name="twitter:card" content="summary_large_image" />
  {#if data}
    {@html `<script type="application/ld+json">${data}</` + "script>"}
  {/if}
</svelte:head>
