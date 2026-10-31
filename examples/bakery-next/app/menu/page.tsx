/** The whole menu, grouped in the order the schema lists the categories. */

import type { Metadata } from "next";
import { content } from "#lib/cms";
import { Item } from "../parts";

export const metadata: Metadata = {
  title: "Menu",
  description: "Bread, pastry and coffee at Hearth, with prices.",
};

export default function Menu() {
  const { sections } = content();
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Today at the counter</p>
        <h1>Menu</h1>
        <p className="lede">Prices in Rwandan francs. What sells out is baked again tomorrow.</p>
        <nav aria-label="Menu sections" className="jump">
          {sections.map((section) => (
            <a href={`#${section.value}`} key={section.value}>
              {section.label}
            </a>
          ))}
        </nav>
      </header>
      {sections.map((section) => (
        <section className="menu-section" aria-labelledby={section.value} key={section.value}>
          <h2 id={section.value}>{section.label}</h2>
          <ul className="items">
            {section.items.map((item) => (
              <Item item={item} key={item.slug} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
