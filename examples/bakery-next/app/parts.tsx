/** Small pieces several pages share. */

import { dietary, type MenuItem, price } from "#lib/cms";

/** A multi-line text field, one line per row, as an address is written. */
export function Lines({ text }: { text?: string }) {
  return (text ?? "").split("\n").map((line, index) => (
    <span key={index}>
      {line}
      <br />
    </span>
  ));
}

/** One line of the printed menu: name, dotted leader, price. */
export function Item({ item }: { item: MenuItem }) {
  const tags = dietary(item.dietary);
  return (
    <li className="item">
      <div className="item-line">
        <h3>{item.name}</h3>
        <span className="leader" aria-hidden="true" />
        <span className="price">{price(item.price)}</span>
      </div>
      {item.description ? <p>{item.description}</p> : null}
      {tags.length > 0 ? (
        <ul className="tags" aria-label="Dietary">
          {tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
