/** The home page: hero, what is in the oven, the story, opening hours and the pre-order form. */

import type { Metadata } from "next";
import { address, categoryLabel, content, dietary, origin, studio } from "#lib/cms";
import { Lines, Price } from "./parts";
import { Shell } from "./shell";

export const metadata: Metadata = address("/");

export default function Home() {
  const { identity, hero, story, visit, featured, sections } = content();
  const orderable = sections.filter((section) => section.value !== "coffee");
  const today = visit.hours?.[0];
  const street = identity.address?.split("\n")[0];
  const hours = visit.hours ?? [];
  // What a search engine shows beside the name: where the bakery is and when it is open.
  const bakery = {
    "@context": "https://schema.org",
    "@type": "Bakery",
    name: identity.name,
    description: identity.tagline,
    url: origin,
    telephone: identity.phone,
    email: identity.email,
    address: identity.address?.replaceAll("\n", ", "),
    openingHours: hours.map((row) => `${row.days} ${row.open}`),
  };

  return (
    <Shell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(bakery).replaceAll("<", "\\u003c") }}
      />
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

      {story.heading && story.body?.html ? (
        <section className="story" aria-labelledby="story">
          <h2 id="story">{story.heading}</h2>
          {/* Rich text is stored sanitized by the studio, so it is printed as it is. */}
          <div className="prose" dangerouslySetInnerHTML={{ __html: story.body.html }} />
        </section>
      ) : null}

      <section className="visit" id="visit" aria-labelledby="visit-heading">
        <h2 id="visit-heading">Visit</h2>
        {hours.length > 0 || identity.address || visit.note ? (
          <div className="visit-grid">
            {hours.length > 0 ? (
              <dl className="hours">
                {hours.map((row) => (
                  <div key={row.days}>
                    <dt>{row.days}</dt>
                    <dd>{row.open}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div>
              {identity.address ? (
                <address>
                  <Lines text={identity.address} />
                </address>
              ) : null}
              {visit.note ? <p className="note">{visit.note}</p> : null}
            </div>
          </div>
        ) : (
          <p className="note">Our address and opening hours will be here soon.</p>
        )}
      </section>

      <section className="order" id="order" aria-labelledby="order-heading">
        <div className="order-head">
          <div>
            <p className="eyebrow">Order ahead</p>
            <h2 id="order-heading">Pre-order for pickup</h2>
          </div>
          <p className="order-lede">
            Tick what you would like, tell us when, and we will reply to confirm.
          </p>
        </div>
        <form className="form slip" method="POST" action={`${studio.url}/f/${studio.site}/order`}>
          <div className="pick-pane">
            {orderable.length > 0 ? (
              <fieldset className="pick">
                <legend>
                  <span className="step" aria-hidden="true">
                    1
                  </span>
                  What would you like? <span className="optional">Optional</span>
                </legend>
                {orderable.map((section) => (
                  <div className="pick-group" key={section.value}>
                    <p className="pick-head">{section.label}</p>
                    <ul className="picks">
                      {section.items.map((item) => (
                        <li key={item.slug}>
                          <label className="choice">
                            <input type="checkbox" name="items" value={item.name} />{" "}
                            <span className="choice-name">{item.name}</span>
                            <Price value={item.price} />
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </fieldset>
            ) : null}
            <div className="field notes">
              <label htmlFor="notes">
                Anything else? <span className="optional">Optional</span>
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={3}
                placeholder="Quantities, sliced or whole, a name for the box."
              />
            </div>
          </div>
          <div className="details">
            <p className="details-head">
              <span className="step" aria-hidden="true">
                {orderable.length > 0 ? 2 : 1}
              </span>
              Your details
            </p>
            <div className="details-fields">
              <div className="field">
                <label htmlFor="name">Name</label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Your name"
                  required
                />
                <p className="error">Tell us who to put the order under.</p>
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
                <p className="error">An email address, so we can confirm.</p>
              </div>
              <div className="field">
                <label htmlFor="pickup">Pickup day</label>
                <input
                  id="pickup"
                  name="pickup"
                  type="date"

                  required
                />
                <p className="error">Choose the day you will collect.</p>
              </div>
            </div>
            <input type="hidden" name="_redirect" value="/thanks/" />
            <div className="trap" aria-hidden="true">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <ol className="rules">
              <li>
                <strong>Order by 15:00</strong> for a loaf the next morning.
              </li>
              <li>
                <strong>Pay when you collect,</strong> in cash or MoMo.
              </li>
              <li>
                <strong>Sliced on request.</strong> Whole loaves keep three days.
              </li>
            </ol>
            <button className="button" type="submit">
              Send the order
            </button>
          </div>
        </form>
      </section>
    </Shell>
  );
}
