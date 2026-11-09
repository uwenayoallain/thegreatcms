<script>
  import { formatDate } from "#lib/cms.js";

  let { data } = $props();
</script>

<svelte:head>
  <title>{data.identity.title} · {data.identity.author}</title>
  <meta name="description" content={data.identity.tagline} />
</svelte:head>

<section class="intro">
  <p class="kicker">{data.identity.author}</p>
  <h1>{data.intro.heading}</h1>
  {#if data.intro.body}<div class="lede">{@html data.intro.body.html}</div>{/if}
</section>

{#if data.lead}
  <article class="lead">
    <div class="lead-head">
      <p class="meta">
        <span>Latest</span> · <time datetime={data.lead.date}>{formatDate(data.lead.date)}</time> ·
        {data.lead.minutes} min read
      </p>
      <h2 style:view-transition-name="essay-{data.lead.slug}">
        <a href="/essays/{data.lead.slug}/">{data.lead.title}</a>
      </h2>
      {#if data.lead.dek}<p class="dek">{data.lead.dek}</p>{/if}
    </div>
    {#if data.lead.opening}
      <blockquote class="opening" cite="/essays/{data.lead.slug}/">
        <p>{data.lead.opening}</p>
      </blockquote>
    {/if}
    <a class="more" href="/essays/{data.lead.slug}/">Read the essay <span aria-hidden="true">→</span></a>
  </article>
{/if}

<section aria-labelledby="archive">
  <h2 id="archive" class="section-label">Earlier</h2>
  <ol class="archive">
    {#each data.rest as essay (essay.slug)}
      <li>
        <time datetime={essay.date}>{formatDate(essay.date)}</time>
        <div>
          <h3 style:view-transition-name="essay-{essay.slug}">
            <a href="/essays/{essay.slug}/">{essay.title}</a>
          </h3>
          {#if essay.dek}<p>{essay.dek}</p>{/if}
          <p class="facts">
            <span>{essay.minutes} min read</span>
            {#each essay.tags as tag (tag)}<span class="tag">{tag}</span>{/each}
          </p>
        </div>
      </li>
    {/each}
  </ol>
</section>
