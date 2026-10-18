// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CountryPicker } from "./ConsultForm";

// Static render (no DOM library is installed in this project): the closed trigger shows either the chosen
// country with its dial code or a neutral prompt, never something that reads like a selected country.
const render = (value: string, error?: string) => renderToStaticMarkup(<CountryPicker value={value} onChange={() => undefined} error={error} />);

describe("CountryPicker trigger", () => {
  it("shows a neutral prompt and no country or dial code while nothing is selected", () => {
    const html = render("");
    expect(html).toContain("انتخاب کنید");
    expect(html).not.toMatch(/Canada|کانادا|\+\d/);
  });

  it("shows the selected country and its dial code, and no prompt", () => {
    const html = render("CA");
    expect(html).toContain("کانادا");
    expect(html).toContain("+1");
    expect(html).not.toContain("انتخاب کنید");
  });

  it("keeps the required-field error visible with the prompt (the state is empty, not selected)", () => {
    const html = render("", "لطفاً این مورد را تکمیل کنید.");
    expect(html).toContain("لطفاً این مورد را تکمیل کنید.");
    expect(html).toContain("انتخاب کنید");
    expect(html).toContain('aria-invalid="true"');
  });
});
