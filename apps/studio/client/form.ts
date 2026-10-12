/**
 * Fields a schema shows conditionally (`when:`) follow the sibling they depend on.
 * Without this script every field shows, which is also what the server validates against.
 */

const valueOf = (control: Element): string => {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    return control.checked ? "true" : "false";
  }
  if (control instanceof HTMLSelectElement && control.multiple) {
    return [...control.selectedOptions].map((option) => option.value).join(",");
  }
  return (control as HTMLInputElement).value ?? "";
};

function start(): void {
  for (const wrapper of document.querySelectorAll<HTMLElement>("[data-when-of]")) {
    const control = document.getElementById(wrapper.dataset.whenOf ?? "");
    if (!control) continue;
    let wanted: string[] = [];
    try {
      wanted = JSON.parse(wrapper.dataset.when ?? "[]");
    } catch {
      continue;
    }
    const update = () => {
      const value = valueOf(control);
      const shown =
        control instanceof HTMLSelectElement && control.multiple
          ? value.split(",").some((part) => wanted.includes(part))
          : wanted.includes(value);
      wrapper.hidden = !shown;
    };
    control.addEventListener("change", update);
    control.addEventListener("input", update);
    update();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
