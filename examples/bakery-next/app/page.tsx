/** The home page: hero, what is in the oven, the story, opening hours and the pre-order form. */

import { categoryLabel, content, dietary, studio } from "#lib/cms";
import { Lines, Price } from "./parts";

export default function Home() {
  const { identity, hero, story, visit, featured, sections } = content();
  const orderable = sections.filter((section) => section.value !== "coffee");
  const today = visit.hours?.[0];
  const street = identity.address?.split("\n")[0];

  return (
    <>
      <section className="hero">
        <div className="hero-text">
          {hero.eyebrow ? <p className="eyebrow">{hero.eyebrow}</p> : null}
          <h1>{hero.heading}</h1>
          {hero.lede ? <p className="lede">{hero.lede}</p> : null}
          <p className="actions">
            {hero.cta?.href ? (
              <a className="button" href={hero.cta.href}>
                {hero.cta.label || "See the menu"}
              </a>
            ) : null}
            <a className="button ghost" href="#order">
              Pre-order for pickup
            </a>
          </p>
          {today || street ? (
            <p className="open-line">
              {today ? (
                <span>
                  <strong>{today.days}</strong> {today.open}
                </span>
              ) : null}
              {street ? <span>{street}</span> : null}
            </p>
          ) : null}
        </div>
        <svg className="stamp" viewBox="0 0 200 200" aria-hidden="true">
          <defs>
            <path id="ring" d="M100 100m-76 0a76 76 0 1 1 152 0a76 76 0 1 1-152 0" />
          </defs>
          <circle cx="100" cy="100" r="98" />
          <text>
            <textPath href="#ring">
              {`BAKED DAILY · ${identity.name.toUpperCase()} · KIGALI · BAKED DAILY ·`}
            </textPath>
          </text>
          <path
            className="wheat"
            d="M100 62v78M100 80c-10-8-18-8-24-4 6 8 14 10 24 4zm0 0c10-8 18-8 24-4-6 8-14 10-24 4zm0 18c-10-8-18-8-24-4 6 8 14 10 24 4zm0 0c10-8 18-8 24-4-6 8-14 10-24 4zm0 18c-10-8-18-8-24-4 6 8 14 10 24 4zm0 0c10-8 18-8 24-4-6 8-14 10-24 4z"
          />
        </svg>
      </section>

      {featured.length > 0 ? (
        <section className="band" aria-labelledby="oven">
          <div className="section-head">
            <h2 id="oven">From the oven</h2>
            <a href="/menu/">Full menu</a>
          </div>
          <ul className="featured">
            {featured.map((item) => (
              <li className="card" key={item.slug}>
                <p className="eyebrow">{categoryLabel(item.category)}</p>
                <h3>{item.name}</h3>
                {item.description ? <p>{item.description}</p> : null}
                <p className="price">
                  <Price value={item.price} className="amount" />
                  {dietary(item.dietary).map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="story" aria-labelledby="story">
        <h2 id="story">{story.heading}</h2>
        {/* Rich text is stored sanitized by the studio, so it is printed as it is. */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: story.body?.html ?? "" }} />
      </section>

      <section className="visit" id="visit" aria-labelledby="visit-heading">
        <h2 id="visit-heading">Visit</h2>
        <div className="visit-grid">
          <dl className="hours">
            {(visit.hours ?? []).map((row) => (
              <div key={row.days}>
                <dt>{row.days}</dt>
                <dd>{row.open}</dd>
              </div>
            ))}
          </dl>
          <div>
            <address>
              <Lines text={identity.address} />
            </address>
            {visit.note ? <p className="note">{visit.note}</p> : null}
          </div>
        </div>
      </section>

      <section className="order" id="order" aria-labelledby="order-heading">
        <div className="order-intro">
          <h2 id="order-heading">Pre-order for pickup</h2>
          <p>Tell us what you would like and when. We will reply to confirm.</p>
          <ul className="order-notes">
            <li>Order by 15:00 for a loaf the next morning.</li>
            <li>Pay when you collect, in cash or MoMo.</li>
            <li>Whole loaves keep three days; we slice on request.</li>
          </ul>
        </div>
        <form className="form" method="POST" action={`${studio.url}/f/${studio.site}/order`}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" autoComplete="name" required />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="pickup">Pickup day</label>
            <input id="pickup" name="pickup" type="date" required />
          </div>
          <fieldset className="field wide">
            <legend>What would you like?</legend>
            <div className="choices">
              {orderable.flatMap((section) =>
                section.items.map((item) => (
                  <label className="choice" key={item.slug}>
                    <input type="checkbox" name="items" value={item.name} />{" "}
                    <span>{item.name}</span>
                  </label>
                )),
              )}
            </div>
          </fieldset>
          <div className="field wide">
            <label htmlFor="notes">
              Anything else? <span className="hint">Quantities, sliced or whole.</span>
            </label>
            <textarea id="notes" name="notes" rows={3} />
          </div>
          <input type="hidden" name="_redirect" value="/thanks/" />
          <div className="trap" aria-hidden="true">
            <label htmlFor="website">Website</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <button className="button" type="submit">
            Send the order
          </button>
        </form>
      </section>
    </>
  );
}
